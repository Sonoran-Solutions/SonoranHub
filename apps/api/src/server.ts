import fs from 'node:fs';
import path from 'node:path';

import { buildApp } from './app.js';
import { createCapacityRuntime } from './capacity.js';
import { parseAllowedOrigins } from './cors.js';
import { PostgresMachineStore } from './machines.js';
import { PostgresMachineActionStore } from './actions.js';
import { createProjectsRuntime } from './projects.js';
import { createStructuredLogger, loadConfig } from '@sonoran-hub/config';
import pg from 'pg';

// Automatically load .env from current directory or workspace root
for (const envCandidate of ['.env', '../../.env', '../.env']) {
  const resolved = path.resolve(process.cwd(), envCandidate);
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

import {
  InMemoryGitHubWebhookDeliveryStore,
  PostgresGitHubWebhookDeliveryStore,
  createWebhookRetentionManager,
  parseWebhookRetentionHours,
} from './webhookDeliveryStore.js';
import { GitHubRefreshCoordinator } from './refreshCoordinator.js';

const { Pool } = pg;

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const config = loadConfig(process.env, { defaultServiceName: 'sonoran-hub-api' });
const logger = createStructuredLogger({ serviceName: config.serviceName, level: config.logLevel });
const capacity = createCapacityRuntime({ environment: process.env, config, logger });
const machinePool = process.env.DATABASE_URL?.trim()
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;
const projects = createProjectsRuntime({
  environment: process.env,
  config,
  logger,
  pool: machinePool,
});

const webhookDeliveryStore = machinePool
  ? new PostgresGitHubWebhookDeliveryStore(machinePool)
  : new InMemoryGitHubWebhookDeliveryStore();

const retentionHours = parseWebhookRetentionHours(
  process.env.GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS,
);

const webhookRetention = createWebhookRetentionManager({
  store: webhookDeliveryStore,
  retentionHours,
  logger,
});

const webhookCoordinator = new GitHubRefreshCoordinator({
  refreshHandler: async (owner, repo) => projects.service.refreshRepository(owner, repo),
  logger,
});

const app = buildApp(config, {
  capacityService: capacity.service,
  projectService: projects.service,
  allowedOrigins: parseAllowedOrigins(process.env.WEB_ORIGIN),
  machineStore: machinePool ? new PostgresMachineStore(machinePool) : undefined,
  machineActionStore: machinePool ? new PostgresMachineActionStore(machinePool) : undefined,
  agentToken: process.env.SONORAN_AGENT_TOKEN,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  webhookDeliveryStore,
  refreshCoordinator: webhookCoordinator,
});

app.addHook('onClose', async () => {
  webhookRetention.stop();
  await webhookCoordinator.stop();
  projects.stop();
  await capacity.stop();
  await machinePool?.end();
});

try {
  await app.listen({ host, port });
  await projects.start();
  await capacity.start();
  await webhookRetention.start();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      logger.error('api.shutdown_failed', { metadata: { error: 'API shutdown failed' } });
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch {
  logger.error('api.start_failed', { metadata: { error: 'API startup failed' } });
  webhookRetention.stop();
  await webhookCoordinator.stop();
  projects.stop();
  await capacity.stop();
  await machinePool?.end();
  process.exitCode = 1;
}
