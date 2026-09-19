/* global Buffer, console, fetch, process, setTimeout */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env if present
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
for (const envCandidate of ['.env', '../.env']) {
  const resolved = path.resolve(scriptDirectory, envCandidate);
  if (fs.existsSync(resolved)) {
    try {
      if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(resolved);
      }
    } catch {
      // ignore
    }
    break;
  }
}

import { buildApp } from '../apps/api/dist/app.js';
import { InMemoryGitHubWebhookDeliveryStore } from '../apps/api/dist/webhookDeliveryStore.js';
import { GitHubRefreshCoordinator } from '../apps/api/dist/refreshCoordinator.js';
import { createProjectsRuntime } from '../apps/api/dist/projects.js';
import { createCapacityRuntime } from '../apps/api/dist/capacity.js';
import { loadConfig, createStructuredLogger } from '../packages/config/dist/index.js';

function signPayload(secret, payloadBuffer) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex');
}

const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim() || 'smoke-webhook-secret-phase2b-test';
const config = loadConfig(process.env, { defaultServiceName: 'sonoran-hub-smoke' });
const logger = createStructuredLogger({ serviceName: 'smoke-github-webhook', level: 'silent' });
const capacity = createCapacityRuntime({ environment: process.env, config, logger });
const projects = createProjectsRuntime({
  environment: process.env,
  config,
  logger,
});

const webhookDeliveryStore = new InMemoryGitHubWebhookDeliveryStore();
let reconciledOwnerRepo = null;
const webhookCoordinator = new GitHubRefreshCoordinator({
  debounceMs: 150,
  maxDelayMs: 300,
  refreshHandler: async (owner, repo) => {
    reconciledOwnerRepo = `${owner}/${repo}`;
    await projects.service.refreshRepository(owner, repo);
  },
  logger,
});

const app = buildApp(config, {
  capacityService: capacity.service,
  projectService: projects.service,
  webhookSecret: secret,
  webhookDeliveryStore,
  refreshCoordinator: webhookCoordinator,
});

try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  await projects.start();
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Missing signature -> 401
  const res1 = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-no-sig',
      'x-github-event': 'ping',
    },
    body: JSON.stringify({ zen: 'Keep it logically awesome.' }),
  });
  if (res1.status !== 401) {
    throw new Error(`Expected 401 for missing signature, got ${res1.status}`);
  }

  // 2. Bad signature -> 401
  const res2 = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-bad-sig',
      'x-github-event': 'ping',
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    },
    body: JSON.stringify({ zen: 'Keep it logically awesome.' }),
  });
  if (res2.status !== 401) {
    throw new Error(`Expected 401 for bad signature, got ${res2.status}`);
  }

  // 3. Valid ping event -> 202 accepted
  const pingBody = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.' }));
  const pingSig = signPayload(secret, pingBody);
  const res3 = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-ping-001',
      'x-github-event': 'ping',
      'x-hub-signature-256': pingSig,
    },
    body: pingBody,
  });
  if (res3.status !== 202) {
    throw new Error(`Expected 202 for valid ping, got ${res3.status}`);
  }
  const data3 = await res3.json();
  if (data3.status !== 'accepted' || data3.event !== 'ping') {
    throw new Error(`Expected { status: 'accepted', event: 'ping' }, got ${JSON.stringify(data3)}`);
  }

  // 4. Unhandled event (e.g. fork) -> 202 ignored
  const forkBody = Buffer.from(JSON.stringify({ forkee: { id: 123 } }));
  const forkSig = signPayload(secret, forkBody);
  const resFork = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-fork-001',
      'x-github-event': 'fork',
      'x-hub-signature-256': forkSig,
    },
    body: forkBody,
  });
  if (resFork.status !== 202) {
    throw new Error(`Expected 202 for unhandled event, got ${resFork.status}`);
  }
  const dataFork = await resFork.json();
  if (dataFork.status !== 'ignored' || dataFork.reason !== 'unhandled_event') {
    throw new Error(`Expected { status: 'ignored', reason: 'unhandled_event' }, got ${JSON.stringify(dataFork)}`);
  }

  // 5. Valid push event for Sonoran-Solutions/SonoranHub -> 202 accepted
  const pushPayload = {
    ref: 'refs/heads/main',
    repository: {
      name: 'SonoranHub',
      owner: {
        login: 'Sonoran-Solutions',
      },
    },
  };
  const pushBody = Buffer.from(JSON.stringify(pushPayload));
  const pushSig = signPayload(secret, pushBody);
  const res5 = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-push-001',
      'x-github-event': 'push',
      'x-hub-signature-256': pushSig,
    },
    body: pushBody,
  });
  if (res5.status !== 202) {
    throw new Error(`Expected 202 for push event, got ${res5.status}`);
  }
  const data5 = await res5.json();
  if (data5.status !== 'accepted' || data5.deliveryId !== 'smoke-del-push-001') {
    throw new Error(`Expected { status: 'accepted', deliveryId: 'smoke-del-push-001' }, got ${JSON.stringify(data5)}`);
  }

  // 6. Duplicate delivery of push -> 202 duplicate
  const resDuplicate = await fetch(`${baseUrl}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'smoke-del-push-001',
      'x-github-event': 'push',
      'x-hub-signature-256': pushSig,
    },
    body: pushBody,
  });
  if (resDuplicate.status !== 202) {
    throw new Error(`Expected 202 for duplicate delivery, got ${resDuplicate.status}`);
  }
  const dataDuplicate = await resDuplicate.json();
  if (dataDuplicate.status !== 'duplicate') {
    throw new Error(`Expected { status: 'duplicate' }, got ${JSON.stringify(dataDuplicate)}`);
  }

  // Wait for debounce and targeted refresh execution
  await new Promise((resolve) => setTimeout(resolve, 800));

  if (reconciledOwnerRepo !== 'Sonoran-Solutions/SonoranHub') {
    throw new Error(
      `Expected refresh coordinator to reconcile Sonoran-Solutions/SonoranHub, got ${reconciledOwnerRepo}`,
    );
  }

  // Verify GET /projects
  const projRes = await fetch(`${baseUrl}/projects`);
  const projData = await projRes.json();
  const project = projData.projects?.find((p) => p.id === 'sonoran-hub');

  console.log(
    JSON.stringify({
      smoke: 'github-webhook',
      status: 'SUCCEEDED',
      scenarios: [
        'missing_signature_rejected_401',
        'invalid_signature_rejected_401',
        'valid_ping_accepted_202',
        'unhandled_event_ignored_202',
        'push_event_accepted_202',
        'duplicate_delivery_deduplicated_202',
        'reconciliation_triggered',
      ],
      reconciledRepository: reconciledOwnerRepo,
      projectFreshness: project?.freshness ?? 'unknown',
      projectLastFetchedAt: project?.lastFetchedAt ?? null,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      smoke: 'github-webhook',
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown error during smoke test',
    }),
  );
  process.exit(1);
} finally {
  await webhookCoordinator.stop();
  projects.stop();
  await capacity.stop();
  await app.close();
}
