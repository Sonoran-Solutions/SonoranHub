import type { FastifyInstance } from 'fastify';
import type { StructuredLogger } from '@sonoran-hub/config';
import type { GitHubWebhookHealth } from '@sonoran-hub/contracts';

import type { ProjectService } from './projects.js';
import type { GitHubRefreshCoordinator } from './refreshCoordinator.js';
import type { GitHubWebhookDeliveryStore } from './webhookDeliveryStore.js';
import { verifyGitHubWebhookSignature } from './webhookSignature.js';

export const RELEVANT_GITHUB_EVENTS = new Set([
  'push',
  'pull_request',
  'issues',
  'check_run',
  'check_suite',
  'workflow_run',
  'status',
  'repository',
]);

const DELIVERY_ID_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;
const EVENT_NAME_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface GitHubWebhookHandlerOptions {
  readonly webhookSecret?: string;
  readonly deliveryStore: GitHubWebhookDeliveryStore;
  readonly refreshCoordinator: GitHubRefreshCoordinator;
  readonly projectService: ProjectService;
  readonly logger?: StructuredLogger;
}

export interface GitHubWebhookSubsystem {
  getHealth(): GitHubWebhookHealth;
}

export function registerGitHubWebhookRoutes(
  app: FastifyInstance,
  options: GitHubWebhookHandlerOptions,
): GitHubWebhookSubsystem {
  const isConfigured = Boolean(options.webhookSecret?.trim());
  const health: GitHubWebhookHealth = {
    configured: isConfigured,
  };

  app.register(async (scope) => {
    // Encapsulate raw body parsing for the webhook route
    scope.addContentTypeParser(
      ['application/json', '*'],
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    scope.post(
      '/github/webhooks',
      {
        bodyLimit: 1_048_576, // 1 MiB
      },
      async (request, reply) => {
        // 1. Subsystem unconfigured check
        if (!options.webhookSecret?.trim()) {
          health.lastErrorCode = 'github_webhook_unconfigured';
          reply.code(503);
          return {
            error: {
              code: 'github_webhook_unconfigured',
              message: 'GitHub webhook subsystem is unconfigured',
            },
          };
        }

        // 2. Raw body check
        const rawBody = request.body;
        if (!Buffer.isBuffer(rawBody)) {
          reply.code(400);
          return {
            error: {
              code: 'invalid_body',
              message: 'Request body must be provided as raw bytes',
            },
          };
        }

        // 3. Verify signature BEFORE parsing JSON or inspecting headers/payload
        const signatureHeader = request.headers['x-hub-signature-256'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        const validSignature = verifyGitHubWebhookSignature(
          options.webhookSecret,
          rawBody,
          signature,
        );

        if (!validSignature) {
          options.logger?.warn('github.webhook.invalid_signature', {
            metadata: { code: 'github_webhook_invalid_signature' },
          });
          health.lastErrorCode = 'github_webhook_invalid_signature';
          reply.code(401);
          return {
            error: {
              code: 'github_webhook_invalid_signature',
              message: 'Invalid GitHub webhook signature',
            },
          };
        }

        // 4. Validate required GitHub headers
        const deliveryHeader = request.headers['x-github-delivery'];
        const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
        const eventHeader = request.headers['x-github-event'];
        const eventName = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;

        if (
          !deliveryId ||
          typeof deliveryId !== 'string' ||
          !DELIVERY_ID_REGEX.test(deliveryId) ||
          !eventName ||
          typeof eventName !== 'string' ||
          !EVENT_NAME_REGEX.test(eventName)
        ) {
          options.logger?.warn('github.webhook.invalid_headers', {
            metadata: { code: 'invalid_headers' },
          });
          health.lastErrorCode = 'invalid_headers';
          reply.code(400);
          return {
            error: {
              code: 'invalid_headers',
              message: 'Missing or malformed X-GitHub-Delivery or X-GitHub-Event header',
            },
          };
        }

        // 5. Parse JSON from verified raw bytes
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          options.logger?.warn('github.webhook.invalid_json', {
            metadata: { deliveryId, eventName },
          });
          health.lastErrorCode = 'invalid_json';
          reply.code(400);
          return {
            error: {
              code: 'invalid_json',
              message: 'Invalid JSON payload in webhook body',
            },
          };
        }

        const nowIso = new Date().toISOString();
        health.lastReceivedAt = nowIso;
        health.lastEventName = eventName;
        options.logger?.info('github.webhook.received', {
          metadata: { deliveryId, eventName },
        });

        // 6. Envelope extraction
        const { owner, repo } = extractRepositoryIdentity(payload);
        if (owner && repo) {
          health.lastRepository = `${owner}/${repo}`;
        }

        // 7. Ping event: record delivery, return 202, no refresh
        if (eventName === 'ping') {
          const isNew = await options.deliveryStore.recordIfNew({
            deliveryId,
            eventName,
            repositoryOwner: owner,
            repositoryName: repo,
            outcome: 'ignored',
            receivedAt: nowIso,
            processedAt: nowIso,
          });
          if (!isNew) {
            options.logger?.info('github.webhook.duplicate', {
              metadata: {
                deliveryId,
                eventName,
                repository: owner && repo ? `${owner}/${repo}` : undefined,
              },
            });
            reply.code(202);
            return { status: 'duplicate', deliveryId };
          }
          health.lastAcceptedAt = nowIso;
          reply.code(202);
          return { status: 'accepted', event: 'ping' };
        }

        // 8. Unknown / unhandled event: record delivery, return 202, no refresh
        if (!RELEVANT_GITHUB_EVENTS.has(eventName)) {
          const isNew = await options.deliveryStore.recordIfNew({
            deliveryId,
            eventName,
            repositoryOwner: owner,
            repositoryName: repo,
            outcome: 'ignored',
            receivedAt: nowIso,
            processedAt: nowIso,
          });
          if (!isNew) {
            options.logger?.info('github.webhook.duplicate', {
              metadata: {
                deliveryId,
                eventName,
                repository: owner && repo ? `${owner}/${repo}` : undefined,
              },
            });
            reply.code(202);
            return { status: 'duplicate', deliveryId };
          }
          options.logger?.info('github.webhook.ignored', {
            metadata: { deliveryId, eventName, reason: 'unhandled_event' },
          });
          reply.code(202);
          return { status: 'ignored', reason: 'unhandled_event' };
        }

        // 9. Missing repository envelope for relevant event: record ignored, no refresh
        if (!owner || !repo) {
          const isNew = await options.deliveryStore.recordIfNew({
            deliveryId,
            eventName,
            outcome: 'ignored',
            receivedAt: nowIso,
            processedAt: nowIso,
          });
          if (!isNew) {
            options.logger?.info('github.webhook.duplicate', {
              metadata: { deliveryId, eventName },
            });
            reply.code(202);
            return { status: 'duplicate', deliveryId };
          }
          options.logger?.info('github.webhook.ignored', {
            metadata: { deliveryId, eventName, reason: 'missing_repository' },
          });
          reply.code(202);
          return { status: 'ignored', reason: 'missing_repository' };
        }

        // 10. Configured repository check
        const isConfiguredRepo = await options.projectService.isRepositoryConfigured(owner, repo);
        if (!isConfiguredRepo) {
          const isNew = await options.deliveryStore.recordIfNew({
            deliveryId,
            eventName,
            repositoryOwner: owner,
            repositoryName: repo,
            outcome: 'ignored',
            receivedAt: nowIso,
            processedAt: nowIso,
          });
          if (!isNew) {
            options.logger?.info('github.webhook.duplicate', {
              metadata: {
                deliveryId,
                eventName,
                repository: `${owner}/${repo}`,
              },
            });
            reply.code(202);
            return { status: 'duplicate', deliveryId };
          }
          options.logger?.info('github.webhook.ignored', {
            metadata: {
              deliveryId,
              eventName,
              repository: `${owner}/${repo}`,
              reason: 'unconfigured_repository',
            },
          });
          reply.code(202);
          return { status: 'ignored', reason: 'unconfigured_repository' };
        }

        // 11. Deduplicate configured delivery ID
        const isNew = await options.deliveryStore.recordIfNew({
          deliveryId,
          eventName,
          repositoryOwner: owner,
          repositoryName: repo,
          outcome: 'accepted',
          receivedAt: nowIso,
          processedAt: nowIso,
        });

        if (!isNew) {
          options.logger?.info('github.webhook.duplicate', {
            metadata: { deliveryId, eventName, repository: `${owner}/${repo}` },
          });
          reply.code(202);
          return { status: 'duplicate', deliveryId };
        }

        // 12. Enqueue targeted refresh
        options.refreshCoordinator.scheduleRefresh(owner, repo);
        health.lastAcceptedAt = nowIso;
        options.logger?.info('github.webhook.refresh_queued', {
          metadata: { deliveryId, eventName, repository: `${owner}/${repo}` },
        });

        reply.code(202);
        return { status: 'accepted', deliveryId };
      },
    );
  });

  return {
    getHealth() {
      return { ...health };
    },
  };
}

function extractRepositoryIdentity(data: unknown): { owner?: string; repo?: string } {
  if (!data || typeof data !== 'object') {
    return {};
  }
  const envelope = data as Record<string, unknown>;
  const repository = envelope['repository'];
  if (!repository || typeof repository !== 'object') {
    return {};
  }
  const repoObj = repository as Record<string, unknown>;

  if (typeof repoObj['full_name'] === 'string' && repoObj['full_name'].includes('/')) {
    const [ownerPart, repoPart] = repoObj['full_name'].split('/');
    if (ownerPart?.trim() && repoPart?.trim()) {
      return { owner: ownerPart.trim(), repo: repoPart.trim() };
    }
  }

  const name = typeof repoObj['name'] === 'string' ? repoObj['name'].trim() : undefined;
  let owner: string | undefined;
  if (repoObj['owner'] && typeof repoObj['owner'] === 'object') {
    const ownerObj = repoObj['owner'] as Record<string, unknown>;
    if (typeof ownerObj['login'] === 'string') {
      owner = ownerObj['login'].trim();
    }
  }

  return { owner, repo: name };
}
