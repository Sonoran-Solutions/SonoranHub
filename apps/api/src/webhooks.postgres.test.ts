import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { GitHubWebhookDeliveryRecord } from '@sonoran-hub/contracts';

import { PostgresGitHubWebhookDeliveryStore } from './webhookDeliveryStore.js';

const { Pool } = pg;
const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const pool = hasDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

describe.skipIf(!hasDatabase)('PostgresGitHubWebhookDeliveryStore', () => {
  let store: PostgresGitHubWebhookDeliveryStore;

  beforeAll(async () => {
    await pool?.query('TRUNCATE TABLE github_webhook_deliveries CASCADE');
    store = new PostgresGitHubWebhookDeliveryStore(pool!);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('inserts new delivery and detects duplicates atomically', async () => {
    const record: GitHubWebhookDeliveryRecord = {
      deliveryId: 'pg-deliv-1',
      eventName: 'push',
      repositoryOwner: 'Sonoran-Solutions',
      repositoryName: 'SonoranHub',
      outcome: 'accepted',
      receivedAt: new Date().toISOString(),
    };

    const first = await store.recordIfNew(record);
    expect(first).toBe(true);

    const duplicate = await store.recordIfNew(record);
    expect(duplicate).toBe(false);

    const fetched = await store.getDelivery('pg-deliv-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.deliveryId).toBe('pg-deliv-1');
    expect(fetched?.eventName).toBe('push');
    expect(fetched?.repositoryOwner).toBe('Sonoran-Solutions');
    expect(fetched?.repositoryName).toBe('SonoranHub');
  });

  it('handles concurrent inserts of the same delivery ID with exactly one winning', async () => {
    const record: GitHubWebhookDeliveryRecord = {
      deliveryId: 'concurrent-deliv-99',
      eventName: 'pull_request',
      repositoryOwner: 'Sonoran-Solutions',
      repositoryName: 'SonoranHub',
      outcome: 'accepted',
      receivedAt: new Date().toISOString(),
    };

    // Fire 10 concurrent inserts
    const results = await Promise.all(Array.from({ length: 10 }, () => store.recordIfNew(record)));

    const trueCount = results.filter((r) => r === true).length;
    const falseCount = results.filter((r) => r === false).length;

    expect(trueCount).toBe(1);
    expect(falseCount).toBe(9);
  });

  it('persists delivery across store recreation/restart', async () => {
    const record: GitHubWebhookDeliveryRecord = {
      deliveryId: 'restart-deliv-1',
      eventName: 'push',
      outcome: 'accepted',
      receivedAt: new Date().toISOString(),
    };

    await store.recordIfNew(record);

    // Create a new store instance with the same pool
    const newStoreInstance = new PostgresGitHubWebhookDeliveryStore(pool!);
    const isDuplicate = await newStoreInstance.recordIfNew(record);
    expect(isDuplicate).toBe(false);

    const fetched = await newStoreInstance.getDelivery('restart-deliv-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.deliveryId).toBe('restart-deliv-1');
  });

  it('cleans up deliveries older than retention threshold', async () => {
    const now = Date.now();
    const oldRecord: GitHubWebhookDeliveryRecord = {
      deliveryId: 'pg-old-deliv',
      eventName: 'issues',
      outcome: 'ignored',
      receivedAt: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(), // 10 days old
    };

    const freshRecord: GitHubWebhookDeliveryRecord = {
      deliveryId: 'pg-fresh-deliv',
      eventName: 'issues',
      outcome: 'accepted',
      receivedAt: new Date(now - 1000 * 60 * 60).toISOString(), // 1 hour old
    };

    await store.recordIfNew(oldRecord);
    await store.recordIfNew(freshRecord);

    const cutoff = new Date(now - 1000 * 60 * 60 * 24 * 7); // 7 days
    const deletedCount = await store.cleanupBefore(cutoff);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    expect(await store.getDelivery('pg-old-deliv')).toBeNull();
    expect(await store.getDelivery('pg-fresh-deliv')).not.toBeNull();
  });
});
