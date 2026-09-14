import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import type { CapacitySnapshot } from '@sonoran-hub/contracts';

import {
  CapacitySnapshotValidationError,
  InMemoryCapacitySnapshotStore,
  PostgresCapacitySnapshotStore,
} from './snapshot-store.js';

const availableAt = '2026-09-14T12:00:00.000Z';

function snapshot(
  provider: string,
  collectedAt: string,
  overrides: Partial<CapacitySnapshot> = {},
): CapacitySnapshot {
  return {
    id: `${provider}-${collectedAt}`,
    provider,
    collectedAt,
    createdAt: collectedAt,
    freshness: 'fresh',
    resources: [
      {
        id: `${provider}-wallet`,
        provider,
        kind: 'wallet',
        name: `${provider} wallet`,
        remaining: 12.5,
        unit: 'usd',
        status: 'available',
        source: 'official_api',
        collectedAt,
        freshness: 'fresh',
      },
    ],
    ...overrides,
  };
}

async function populate(store: InMemoryCapacitySnapshotStore | PostgresCapacitySnapshotStore) {
  await store.save(snapshot('deepseek', availableAt));
  await store.save(snapshot('deepseek', '2026-09-14T13:00:00.000Z'));
  await store.save(snapshot('openrouter', '2026-09-14T12:30:00.000Z'));
}

describe('InMemoryCapacitySnapshotStore', () => {
  it('supports immutable save, latest, provider/since filtering, bounded history, and round trips', async () => {
    const store = new InMemoryCapacitySnapshotStore();
    await populate(store);

    await expect(store.latest('deepseek')).resolves.toHaveLength(1);
    await expect(store.latest()).resolves.toHaveLength(2);
    await expect(store.history({ providerId: 'deepseek' })).resolves.toMatchObject([
      { id: 'deepseek-2026-09-14T13:00:00.000Z' },
      { id: 'deepseek-2026-09-14T12:00:00.000Z' },
    ]);
    await expect(
      store.history({ since: '2026-09-14T12:45:00.000Z', limit: 1 }),
    ).resolves.toMatchObject([{ id: 'deepseek-2026-09-14T13:00:00.000Z' }]);
    await expect(store.history({ limit: 2 })).resolves.toHaveLength(2);
    await expect(store.latest('deepseek')).resolves.toEqual([
      expect.objectContaining({ resources: [expect.objectContaining({ remaining: 12.5 })] }),
    ]);
  });

  it('persists partial, unknown, and error resource semantics without turning them into zero', async () => {
    const store = new InMemoryCapacitySnapshotStore();
    const partial = snapshot('deepseek', availableAt, {
      resources: [
        {
          id: 'deepseek-wallet-usd',
          provider: 'deepseek',
          kind: 'wallet',
          name: 'DeepSeek balance',
          unit: 'usd',
          status: 'unknown',
          source: 'official_api',
          collectedAt: availableAt,
          freshness: 'unknown',
          error: { code: 'unavailable', message: 'API key is not configured' },
        },
      ],
    });
    await store.save(partial);
    const [stored] = await store.latest('deepseek');
    expect(stored?.resources[0]).toMatchObject({
      status: 'unknown',
      error: { code: 'unavailable' },
    });
    expect(stored?.resources[0]).not.toHaveProperty('remaining');
  });

  it('redacts secret-shaped metadata before returning snapshots', async () => {
    const store = new InMemoryCapacitySnapshotStore();
    await store.save(
      snapshot('openrouter', availableAt, {
        metadata: { apiKey: 'test-secret', safe_label: 'local' },
      }),
    );
    const [stored] = await store.latest('openrouter');

    expect(stored?.metadata).toEqual({ apiKey: '[REDACTED]', safe_label: 'local' });
    expect(JSON.stringify(stored)).not.toContain('test-secret');
  });

  it('rejects invalid snapshots before storage', async () => {
    const store = new InMemoryCapacitySnapshotStore();
    await expect(
      store.save({
        ...snapshot('deepseek', availableAt),
        resources: [{ ...snapshot('openrouter', availableAt).resources[0]! }],
      }),
    ).rejects.toBeInstanceOf(CapacitySnapshotValidationError);
    await expect(
      store.save({ ...snapshot('deepseek', '2026-09-14T14:00:00.000Z'), provider: '' }),
    ).rejects.toBeInstanceOf(CapacitySnapshotValidationError);
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const postgres = hasDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

describe.skipIf(!hasDatabase)('PostgresCapacitySnapshotStore', () => {
  let store: PostgresCapacitySnapshotStore;

  beforeAll(async () => {
    await postgres?.query('TRUNCATE TABLE capacity_snapshots');
    store = new PostgresCapacitySnapshotStore(postgres!);
  });

  afterAll(async () => {
    await postgres?.end();
  });

  it('round trips normalized snapshots and returns deterministic history', async () => {
    await populate(store);
    const latest = await store.latest();
    const history = await store.history({ providerId: 'deepseek', limit: 10 });
    expect(latest.map((item) => item.provider)).toEqual(['deepseek', 'openrouter']);
    expect(history.map((item) => item.id)).toEqual([
      'deepseek-2026-09-14T13:00:00.000Z',
      'deepseek-2026-09-14T12:00:00.000Z',
    ]);
  });
});
