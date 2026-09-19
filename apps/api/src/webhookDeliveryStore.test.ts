import { describe, expect, it } from 'vitest';
import type { GitHubWebhookDeliveryRecord } from '@sonoran-hub/contracts';

import {
  InMemoryGitHubWebhookDeliveryStore,
  createWebhookRetentionManager,
} from './webhookDeliveryStore.js';

describe('InMemoryGitHubWebhookDeliveryStore', () => {
  it('atomically records new deliveries and rejects duplicates', async () => {
    const store = new InMemoryGitHubWebhookDeliveryStore();
    const record: GitHubWebhookDeliveryRecord = {
      deliveryId: 'deliv-1111',
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

    const different: GitHubWebhookDeliveryRecord = {
      ...record,
      deliveryId: 'deliv-2222',
    };
    const secondNew = await store.recordIfNew(different);
    expect(secondNew).toBe(true);

    const fetched = await store.getDelivery('deliv-1111');
    expect(fetched).not.toBeNull();
    expect(fetched?.deliveryId).toBe('deliv-1111');
    expect(fetched?.eventName).toBe('push');
  });

  it('cleans up deliveries older than threshold timestamp', async () => {
    const store = new InMemoryGitHubWebhookDeliveryStore();
    const now = Date.now();

    const oldRecord: GitHubWebhookDeliveryRecord = {
      deliveryId: 'old-delivery',
      eventName: 'push',
      outcome: 'accepted',
      receivedAt: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(), // 10 days old
    };

    const freshRecord: GitHubWebhookDeliveryRecord = {
      deliveryId: 'fresh-delivery',
      eventName: 'pull_request',
      outcome: 'accepted',
      receivedAt: new Date(now - 1000 * 60 * 60).toISOString(), // 1 hour old
    };

    await store.recordIfNew(oldRecord);
    await store.recordIfNew(freshRecord);

    const cutoff = new Date(now - 1000 * 60 * 60 * 24 * 7); // 7 days cutoff
    const cleaned = await store.cleanupBefore(cutoff);
    expect(cleaned).toBe(1);

    expect(await store.getDelivery('old-delivery')).toBeNull();
    expect(await store.getDelivery('fresh-delivery')).not.toBeNull();
  });

  it('runs periodic retention cleanup using injectable time', async () => {
    const store = new InMemoryGitHubWebhookDeliveryStore();
    const mockNow = new Date('2026-09-18T20:00:00.000Z');

    const oldRecord: GitHubWebhookDeliveryRecord = {
      deliveryId: 'retention-old',
      eventName: 'push',
      outcome: 'accepted',
      receivedAt: new Date(mockNow.getTime() - 1000 * 60 * 60 * 24 * 8).toISOString(), // 8 days old
    };
    await store.recordIfNew(oldRecord);

    const manager = createWebhookRetentionManager({
      store,
      retentionHours: 168, // 7 days
      intervalMs: 0,
      now: () => mockNow,
    });

    const deleted = await manager.runCleanup();
    expect(deleted).toBe(1);
    expect(await store.getDelivery('retention-old')).toBeNull();

    manager.stop();
  });
});
