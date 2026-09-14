import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, parseCorrelationId } from '@sonoran-hub/config';
import {
  CapacityAdapterRegistry,
  CapacityCoordinator,
  CapacityService,
  CapacitySnapshotStoreError,
  InMemoryCapacitySnapshotStore,
  type CapacityProviderAdapter,
} from '@sonoran-hub/ai-capacity';
import type { CapacityCollectionResult } from '@sonoran-hub/contracts';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns structured healthy status with a generated request ID', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const requestId = response.headers['x-request-id'];

    expect(response.statusCode).toBe(200);
    expect(requestId).toEqual(expect.any(String));
    expect(parseCorrelationId(requestId)).toBe(requestId);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });

  it('preserves a valid incoming request ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-request-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('test-request-123');
  });

  it('replaces an invalid incoming request ID with a safe generated ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'unsafe request id with spaces' },
    });
    const requestId = response.headers['x-request-id'];

    expect(response.statusCode).toBe(200);
    expect(requestId).not.toBe('unsafe request id with spaces');
    expect(parseCorrelationId(requestId)).toBe(requestId);
  });
});

const testConfig = loadConfig(
  { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
  { defaultServiceName: 'sonoran-hub-api' },
);
const collectedAt = '2026-09-14T12:00:00.000Z';

class TestCapacityAdapter implements CapacityProviderAdapter {
  constructor(
    readonly id: string,
    private readonly collection: CapacityCollectionResult,
    private readonly available = true,
  ) {}

  async probe() {
    return {
      providerId: this.id,
      available: this.available,
      checkedAt: collectedAt,
      ...(this.available ? {} : { reason: 'Provider probe unavailable' }),
    };
  }

  async collect() {
    return this.collection;
  }
}

function testCollection(provider: string): CapacityCollectionResult {
  return {
    collectedAt,
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
  };
}

function serviceWith(...adapters: readonly CapacityProviderAdapter[]) {
  const registry = new CapacityAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  const coordinator = new CapacityCoordinator(registry, { now: () => collectedAt });
  return new CapacityService(coordinator, new InMemoryCapacitySnapshotStore(), {
    now: () => collectedAt,
    staleAfterMs: 300_000,
  });
}

describe('Capacity API', () => {
  it('returns known providers with null snapshots for an empty database', async () => {
    const service = serviceWith(
      new TestCapacityAdapter('deepseek', testCollection('deepseek')),
      new TestCapacityAdapter('openrouter', testCollection('openrouter')),
    );
    const app = buildApp(testConfig, { capacityService: service });

    const response = await app.inject({ method: 'GET', url: '/capacity' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providers: [
        { providerId: 'deepseek', snapshot: null, health: { providerId: 'deepseek' } },
        { providerId: 'openrouter', snapshot: null, health: { providerId: 'openrouter' } },
      ],
    });
  });

  it('returns current partial provider state and persisted history', async () => {
    const service = serviceWith(
      new TestCapacityAdapter('deepseek', testCollection('deepseek'), false),
    );
    await service.refresh('deepseek');
    const app = buildApp(testConfig, { capacityService: service });

    const current = await app.inject({ method: 'GET', url: '/capacity' });
    const history = await app.inject({
      method: 'GET',
      url: '/capacity/history?provider=deepseek&limit=1',
    });
    await app.close();

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      providers: [
        {
          providerId: 'deepseek',
          snapshot: { provider: 'deepseek', resources: [{ remaining: 12.5 }] },
          health: {
            available: false,
            lastProbeFailure: { code: 'unavailable' },
          },
        },
      ],
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().snapshots).toHaveLength(1);
  });

  it('validates history filters, enforces the maximum, and maps storage failures safely', async () => {
    const service = serviceWith(
      new TestCapacityAdapter('openrouter', testCollection('openrouter')),
    );
    const app = buildApp(testConfig, { capacityService: service });

    const invalid = await app.inject({ method: 'GET', url: '/capacity/history?limit=101' });
    const badSince = await app.inject({ method: 'GET', url: '/capacity/history?since=tomorrow' });
    await app.close();

    expect(invalid.statusCode).toBe(400);
    expect(badSince.statusCode).toBe(400);

    const failingStore = {
      async save() {
        return undefined;
      },
      async latest() {
        throw new CapacitySnapshotStoreError();
      },
      async history() {
        throw new CapacitySnapshotStoreError();
      },
    };
    const failingCoordinator = new CapacityCoordinator(new CapacityAdapterRegistry());
    const failingService = new CapacityService(failingCoordinator, failingStore);
    const failingApp = buildApp(testConfig, { capacityService: failingService });
    const failingCurrent = await failingApp.inject({ method: 'GET', url: '/capacity' });
    const failingHistory = await failingApp.inject({ method: 'GET', url: '/capacity/history' });
    await failingApp.close();

    expect(failingCurrent.statusCode).toBe(503);
    expect(failingHistory.statusCode).toBe(503);
    expect(failingCurrent.body).not.toContain('password');
  });
});
