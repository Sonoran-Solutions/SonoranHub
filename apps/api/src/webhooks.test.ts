import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { FakeGitHubProjectSource, GitHubAdapter } from '@sonoran-hub/github';
import { InMemoryProjectStore } from './projectStore.js';
import { ProjectService } from './projects.js';
import { GitHubRefreshCoordinator } from './refreshCoordinator.js';
import { InMemoryGitHubWebhookDeliveryStore } from './webhookDeliveryStore.js';
import { registerGitHubWebhookRoutes } from './webhooks.js';

describe('GitHub Webhooks HTTP Route', () => {
  const secret = 'webhook-secret-xyz-987';

  function computeSignature(body: string, sec = secret): string {
    return `sha256=${createHmac('sha256', sec).update(Buffer.from(body, 'utf8')).digest('hex')}`;
  }

  async function createTestApp(
    opts: {
      webhookSecret?: string;
      refreshHandler?: (owner: string, repo: string) => Promise<void>;
    } = {},
  ) {
    const app = Fastify();
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    const adapter = new GitHubAdapter(source);
    const projectConfig = {
      version: 1 as const,
      projects: [
        {
          id: 'sonoran-hub',
          name: 'Sonoran Hub',
          attentionLabels: ['bug'],
          repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
        },
      ],
    };

    const projectService = new ProjectService({
      store,
      adapter,
      projectConfig,
      refreshIntervalMs: 0,
    });
    await projectService.start();

    const deliveryStore = new InMemoryGitHubWebhookDeliveryStore();
    const refreshCoordinator = new GitHubRefreshCoordinator({
      debounceMs: 50,
      refreshHandler:
        opts.refreshHandler ?? (async (o, r) => projectService.refreshRepository(o, r)),
    });

    const subsystem = registerGitHubWebhookRoutes(app, {
      webhookSecret: opts.webhookSecret !== undefined ? opts.webhookSecret : secret,
      deliveryStore,
      refreshCoordinator,
      projectService,
    });

    return {
      app,
      deliveryStore,
      refreshCoordinator,
      projectService,
      subsystem,
    };
  }

  it('returns 503 when webhook secret is unconfigured', async () => {
    const { app, refreshCoordinator, projectService } = await createTestApp({ webhookSecret: '' });

    const payload = JSON.stringify({ action: 'opened' });
    const response = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(payload),
        'x-github-delivery': 'deliv-1',
        'x-github-event': 'push',
      },
      payload,
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe('github_webhook_unconfigured');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('returns 401 when signature is invalid, missing, or tampered', async () => {
    const { app, refreshCoordinator, projectService } = await createTestApp();

    const payload = JSON.stringify({ action: 'opened' });

    // 1. Missing signature
    const missingSig = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'deliv-1',
        'x-github-event': 'push',
      },
      payload,
    });
    expect(missingSig.statusCode).toBe(401);
    expect(JSON.parse(missingSig.payload).error.code).toBe('github_webhook_invalid_signature');

    // 2. Wrong signature
    const wrongSig = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': computeSignature(payload, 'wrong-secret'),
        'x-github-delivery': 'deliv-1',
        'x-github-event': 'push',
      },
      payload,
    });
    expect(wrongSig.statusCode).toBe(401);
    expect(JSON.parse(wrongSig.payload).error.code).toBe('github_webhook_invalid_signature');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('returns 400 when required GitHub headers are missing or malformed', async () => {
    const { app, refreshCoordinator, projectService } = await createTestApp();
    const payload = JSON.stringify({ action: 'opened' });
    const signature = computeSignature(payload);

    // Missing event
    const missingEvent = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'deliv-1',
      },
      payload,
    });
    expect(missingEvent.statusCode).toBe(400);
    expect(JSON.parse(missingEvent.payload).error.code).toBe('invalid_headers');

    // Oversized delivery ID (> 128 chars)
    const oversizedDelivery = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'a'.repeat(129),
        'x-github-event': 'push',
      },
      payload,
    });
    expect(oversizedDelivery.statusCode).toBe(400);

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('returns 400 when body contains invalid JSON despite valid HMAC', async () => {
    const { app, refreshCoordinator, projectService } = await createTestApp();
    const malformedBody = '{"broken-json: true';
    const signature = computeSignature(malformedBody);

    const response = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'deliv-1',
        'x-github-event': 'push',
      },
      payload: malformedBody,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error.code).toBe('invalid_json');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('accepts ping event, records delivery as ignored, and does not schedule refresh', async () => {
    let refreshCalled = false;
    const { app, deliveryStore, refreshCoordinator, projectService } = await createTestApp({
      refreshHandler: async () => {
        refreshCalled = true;
      },
    });

    const payload = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const signature = computeSignature(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'ping-delivery-123',
        'x-github-event': 'ping',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload).status).toBe('accepted');
    expect(refreshCalled).toBe(false);

    const record = await deliveryStore.getDelivery('ping-delivery-123');
    expect(record).not.toBeNull();
    expect(record?.outcome).toBe('ignored');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('accepts unknown signed event without scheduling a refresh', async () => {
    let refreshCalled = false;
    const { app, refreshCoordinator, projectService } = await createTestApp({
      refreshHandler: async () => {
        refreshCalled = true;
      },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'Sonoran-Solutions/SonoranHub' },
    });
    const signature = computeSignature(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'unknown-event-delivery',
        'x-github-event': 'sponsorship',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload).status).toBe('ignored');
    expect(refreshCalled).toBe(false);

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('accepts unconfigured repository event without calling GitHub refresh', async () => {
    let refreshCalled = false;
    const { app, deliveryStore, refreshCoordinator, projectService } = await createTestApp({
      refreshHandler: async () => {
        refreshCalled = true;
      },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'OtherOrg/UnconfiguredRepo' },
    });
    const signature = computeSignature(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'unconfigured-repo-delivery',
        'x-github-event': 'push',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload).status).toBe('ignored');
    expect(refreshCalled).toBe(false);

    const record = await deliveryStore.getDelivery('unconfigured-repo-delivery');
    expect(record).not.toBeNull();
    expect(record?.outcome).toBe('ignored');
    expect(record?.processedAt).toBeTruthy();

    // Replay of same unconfigured delivery returns duplicate status
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'unconfigured-repo-delivery',
        'x-github-event': 'push',
      },
      payload,
    });
    expect(duplicateRes.statusCode).toBe(202);
    expect(JSON.parse(duplicateRes.payload).status).toBe('duplicate');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('accepts valid relevant event and schedules targeted refresh', async () => {
    const refreshedRepos: string[] = [];
    const { app, deliveryStore, refreshCoordinator, projectService } = await createTestApp({
      refreshHandler: async (owner, repo) => {
        refreshedRepos.push(`${owner}/${repo}`);
      },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'Sonoran-Solutions/SonoranHub' },
      action: 'opened',
    });
    const signature = computeSignature(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'valid-push-delivery-1',
        'x-github-event': 'push',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload).status).toBe('accepted');

    // Wait for refresh coordinator debounce
    await refreshCoordinator.waitForIdle();
    expect(refreshedRepos).toEqual(['Sonoran-Solutions/SonoranHub']);

    const record = await deliveryStore.getDelivery('valid-push-delivery-1');
    expect(record).not.toBeNull();
    expect(record?.outcome).toBe('accepted');

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('deduplicates delivery: duplicate delivery is accepted with 202 but does not enqueue a second refresh', async () => {
    const refreshedRepos: string[] = [];
    const { app, refreshCoordinator, projectService } = await createTestApp({
      refreshHandler: async (owner, repo) => {
        refreshedRepos.push(`${owner}/${repo}`);
      },
    });

    const payload = JSON.stringify({
      repository: { full_name: 'Sonoran-Solutions/SonoranHub' },
    });
    const signature = computeSignature(payload);

    // First delivery
    const firstRes = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'same-delivery-id-999',
        'x-github-event': 'pull_request',
      },
      payload,
    });
    expect(firstRes.statusCode).toBe(202);
    expect(JSON.parse(firstRes.payload).status).toBe('accepted');

    // Duplicate delivery
    const secondRes = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'same-delivery-id-999',
        'x-github-event': 'pull_request',
      },
      payload,
    });
    expect(secondRes.statusCode).toBe(202);
    expect(JSON.parse(secondRes.payload).status).toBe('duplicate');

    await refreshCoordinator.waitForIdle();
    // Exactly 1 refresh triggered despite 2 requests
    expect(refreshedRepos).toHaveLength(1);

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });

  it('verifies all supported event types trigger refresh', async () => {
    const supportedEvents = [
      'push',
      'pull_request',
      'issues',
      'check_run',
      'check_suite',
      'workflow_run',
      'status',
      'repository',
    ];

    for (const eventName of supportedEvents) {
      const refreshed: string[] = [];
      const { app, refreshCoordinator, projectService } = await createTestApp({
        refreshHandler: async (owner, repo) => {
          refreshed.push(`${owner}/${repo}`);
        },
      });

      const payload = JSON.stringify({
        repository: { full_name: 'Sonoran-Solutions/SonoranHub' },
      });
      const signature = computeSignature(payload);

      const res = await app.inject({
        method: 'POST',
        url: '/github/webhooks',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': `delivery-${eventName}`,
          'x-github-event': eventName,
        },
        payload,
      });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.payload).status).toBe('accepted');

      await refreshCoordinator.waitForIdle();
      expect(refreshed).toHaveLength(1);

      await refreshCoordinator.stop();
      projectService.stop();
      await app.close();
    }
  });

  it('returns 413 when webhook payload exceeds 1 MiB', async () => {
    const { app, refreshCoordinator, projectService } = await createTestApp();
    // Create oversized payload (> 1 MiB)
    const largePadding = 'x'.repeat(1024 * 1024 + 100);
    const oversizedPayload = JSON.stringify({ padding: largePadding });
    const signature = computeSignature(oversizedPayload);

    const res = await app.inject({
      method: 'POST',
      url: '/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'oversized-deliv',
        'x-github-event': 'push',
      },
      payload: oversizedPayload,
    });

    expect(res.statusCode).toBe(413);

    await refreshCoordinator.stop();
    projectService.stop();
    await app.close();
  });
});
