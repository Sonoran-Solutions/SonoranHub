import { describe, expect, it, vi } from 'vitest';

import type { CapacityCollectionResult } from '@sonoran-hub/contracts';

import { CapacityCoordinator } from './coordinator.js';
import { CapacityAdapterRegistry } from './registry.js';
import { CapacityService } from './service.js';
import {
  CapacitySnapshotStoreError,
  InMemoryCapacitySnapshotStore,
  type CapacitySnapshotStore,
} from './snapshot-store.js';
import type { CapacityProviderAdapter } from './types.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

const collection: CapacityCollectionResult = {
  collectedAt,
  resources: [
    {
      id: 'deepseek-wallet-usd',
      provider: 'deepseek',
      kind: 'wallet',
      name: 'DeepSeek balance',
      unit: 'usd',
      status: 'unknown',
      source: 'official_api',
      collectedAt,
      freshness: 'unknown',
      error: { code: 'unavailable', message: 'API key is not configured' },
    },
    {
      id: 'deepseek-pricing-window',
      provider: 'deepseek',
      kind: 'pricing_window',
      name: 'DeepSeek pricing window',
      unit: 'state',
      status: 'available',
      source: 'derived',
      collectedAt,
      freshness: 'fresh',
      changesAt: '2026-09-14T15:00:00.000Z',
      metadata: { state: 'OFF_PEAK', price_multiplier: 0.5 },
    },
  ],
};

function serviceFor(store: CapacitySnapshotStore) {
  const registry = new CapacityAdapterRegistry();
  const adapter: CapacityProviderAdapter = {
    id: 'deepseek',
    probe: async () => ({
      providerId: 'deepseek',
      available: false,
      checkedAt: collectedAt,
      reason: 'DeepSeek API key is not configured',
    }),
    collect: async () => collection,
  };
  registry.register(adapter);
  return new CapacityService(new CapacityCoordinator(registry, { now: () => collectedAt }), store, {
    now: () => collectedAt,
    staleAfterMs: 300_000,
  });
}

describe('CapacityService', () => {
  it('persists a partial collection as an immutable canonical snapshot', async () => {
    const store = new InMemoryCapacitySnapshotStore();
    const service = serviceFor(store);

    const result = await service.refresh('deepseek');
    const [saved] = await store.latest('deepseek');

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(saved).toMatchObject({
      provider: 'deepseek',
      resources: [
        { id: 'deepseek-wallet-usd', status: 'unknown' },
        { id: 'deepseek-pricing-window', status: 'available', staleAfter: expect.any(String) },
      ],
    });
  });

  it('keeps coordinator success intact when snapshot persistence fails', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      log: vi.fn(),
    };
    const store: CapacitySnapshotStore = {
      async save() {
        throw new CapacitySnapshotStoreError();
      },
      async latest() {
        return [];
      },
      async history() {
        return [];
      },
    };
    const service = new CapacityService(serviceFor(store).coordinator, store, {
      now: () => collectedAt,
      logger,
    });

    await expect(service.refresh('deepseek')).resolves.toMatchObject({ status: 'succeeded' });
    expect(logger.error).toHaveBeenCalledWith(
      'capacity.snapshot.persistence_failed',
      expect.objectContaining({
        metadata: { providerId: 'deepseek', snapshotId: expect.any(String) },
      }),
    );
  });
});
