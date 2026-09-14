import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapacityCollectionResult } from '@sonoran-hub/contracts';

import { CapacityCoordinator } from './coordinator.js';
import { CapacityAdapterRegistry } from './registry.js';
import { CapacityRefreshScheduler } from './scheduler.js';
import type { AdapterAvailability, CapacityProviderAdapter } from './types.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function successfulCollection(providerId: string): CapacityCollectionResult {
  return {
    collectedAt,
    resources: [
      {
        id: `${providerId}-wallet`,
        provider: providerId,
        kind: 'wallet',
        name: `${providerId} wallet`,
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

function availableProbe(providerId: string): AdapterAvailability {
  return { providerId, available: true, checkedAt: collectedAt };
}

class FakeAdapter implements CapacityProviderAdapter {
  probeCalls = 0;
  collectCalls = 0;

  constructor(
    readonly id: string,
    private readonly probeImpl: () => Promise<AdapterAvailability>,
    private readonly collectImpl: () => Promise<CapacityCollectionResult>,
  ) {}

  async probe(): Promise<AdapterAvailability> {
    this.probeCalls += 1;
    return this.probeImpl();
  }

  async collect(): Promise<CapacityCollectionResult> {
    this.collectCalls += 1;
    return this.collectImpl();
  }
}

function registryWith(...adapters: readonly CapacityProviderAdapter[]): CapacityAdapterRegistry {
  const registry = new CapacityAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}

describe('CapacityAdapterRegistry', () => {
  it('registers, retrieves, rejects duplicates, and lists IDs deterministically', () => {
    const first = new FakeAdapter(
      'zeta',
      async () => availableProbe('zeta'),
      async () => successfulCollection('zeta'),
    );
    const second = new FakeAdapter(
      'alpha',
      async () => availableProbe('alpha'),
      async () => successfulCollection('alpha'),
    );
    const registry = registryWith(first, second);

    expect(registry.get('alpha')).toBe(second);
    expect(registry.list().map((adapter) => adapter.id)).toEqual(['alpha', 'zeta']);
    expect(() => registry.register(first)).toThrow('Adapter already registered: zeta');
    expect(first.probeCalls).toBe(0);
    expect(first.collectCalls).toBe(0);
  });
});

describe('CapacityCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes providers independently and preserves unavailable state', async () => {
    const available = new FakeAdapter(
      'available',
      async () => availableProbe('available'),
      async () => successfulCollection('available'),
    );
    const unavailable = new FakeAdapter(
      'unavailable',
      async () => ({
        providerId: 'unavailable',
        available: false,
        checkedAt: collectedAt,
        reason: 'Credentials are not configured',
      }),
      async () => successfulCollection('unavailable'),
    );
    const coordinator = new CapacityCoordinator(registryWith(unavailable, available));

    const results = await coordinator.probeAll();

    expect(results.map((result) => result.providerId)).toEqual(['available', 'unavailable']);
    expect(results[0]?.available).toBe(true);
    expect(results[1]).toMatchObject({
      available: false,
      reason: 'Credentials are not configured',
    });
    expect(coordinator.getHealth('unavailable')).toMatchObject({ available: false });

    const refresh = await coordinator.refresh('unavailable');
    expect(refresh).toMatchObject({
      status: 'failed',
      error: { code: 'unavailable', message: 'Credentials are not configured' },
    });
    expect(unavailable.collectCalls).toBe(0);
  });

  it('collects providers independently and converts failures into typed outcomes', async () => {
    vi.useFakeTimers();
    const throwing = new FakeAdapter(
      'throwing',
      async () => availableProbe('throwing'),
      async () => {
        throw new Error('apiKey=do-not-leak-this');
      },
    );
    const invalid = new FakeAdapter(
      'invalid',
      async () => availableProbe('invalid'),
      async () => ({
        collectedAt,
        resources: [
          {
            id: 'invalid-wallet',
            provider: 'invalid',
            kind: 'wallet',
            name: 'Invalid wallet',
            remaining: -1,
            unit: 'usd',
            status: 'available',
            source: 'official_api',
            collectedAt,
            freshness: 'fresh',
          },
        ],
      }),
    );
    const hanging = new FakeAdapter(
      'hanging',
      async () => availableProbe('hanging'),
      () => new Promise<CapacityCollectionResult>(() => undefined),
    );
    const success = new FakeAdapter(
      'success',
      async () => availableProbe('success'),
      async () => successfulCollection('success'),
    );
    const coordinator = new CapacityCoordinator(registryWith(throwing, invalid, hanging, success), {
      collectionTimeoutMs: 25,
    });

    const resultsPromise = coordinator.collectAll();
    await vi.advanceTimersByTimeAsync(25);
    const results = await resultsPromise;
    const byProvider = new Map(results.map((result) => [result.providerId, result]));

    expect(byProvider.get('success')).toMatchObject({ status: 'succeeded' });
    expect(byProvider.get('throwing')).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error', message: 'Provider collection failed unexpectedly' },
    });
    expect(byProvider.get('invalid')).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_normalized_data' },
    });
    expect(byProvider.get('hanging')).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
    expect(coordinator.getHealth('success')).toMatchObject({
      lastSuccessfulCollection: collectedAt,
    });
    expect(coordinator.getHealth('hanging')?.lastSuccessfulCollection).toBeUndefined();
  });

  it('rejects resources that do not belong to the collecting provider', async () => {
    const mismatched = new FakeAdapter(
      'deepseek',
      async () => availableProbe('deepseek'),
      async () => ({
        collectedAt,
        resources: [{ ...successfulCollection('openrouter').resources[0]! }],
      }),
    );
    const coordinator = new CapacityCoordinator(registryWith(mismatched));

    const result = await coordinator.collect('deepseek');

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'invalid_normalized_data',
        message: 'Provider returned a resource belonging to another provider',
      },
    });
  });

  it('keeps the last successful timestamp when a flaky provider later fails', async () => {
    let attempts = 0;
    const flaky = new FakeAdapter(
      'flaky',
      async () => availableProbe('flaky'),
      async () => {
        attempts += 1;
        return attempts === 1
          ? successfulCollection('flaky')
          : {
              collectedAt: '2026-09-14T12:01:00.000Z',
              resources: [],
              error: { code: 'rate_limited', message: 'Provider rate limit reached' },
            };
      },
    );
    const coordinator = new CapacityCoordinator(registryWith(flaky));

    expect((await coordinator.collect('flaky')).status).toBe('succeeded');
    const second = await coordinator.collect('flaky');

    expect(second).toMatchObject({ status: 'failed', error: { code: 'rate_limited' } });
    expect(coordinator.getHealth('flaky')).toMatchObject({
      lastSuccessfulCollection: collectedAt,
      lastError: { code: 'rate_limited' },
    });
  });

  it('prevents overlapping collection of the same provider and emits lifecycle events', async () => {
    let resolveCollection: ((result: CapacityCollectionResult) => void) | undefined;
    const slow = new FakeAdapter(
      'slow',
      async () => availableProbe('slow'),
      () =>
        new Promise<CapacityCollectionResult>((resolve) => {
          resolveCollection = resolve;
        }),
    );
    const coordinator = new CapacityCoordinator(registryWith(slow));
    const events: string[] = [];
    coordinator.subscribe((event) => events.push(event.type));

    const first = coordinator.collect('slow');
    const second = coordinator.collect('slow');
    expect(slow.collectCalls).toBe(1);

    resolveCollection?.(successfulCollection('slow'));
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    await expect(second).resolves.toMatchObject({ status: 'succeeded' });
    expect(events).toEqual(['collection_started', 'collection_succeeded']);
  });
});

describe('CapacityRefreshScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes providers independently and stops cleanly', async () => {
    vi.useFakeTimers();
    const first = new FakeAdapter(
      'first',
      async () => availableProbe('first'),
      async () => successfulCollection('first'),
    );
    const second = new FakeAdapter(
      'second',
      async () => availableProbe('second'),
      async () => successfulCollection('second'),
    );
    const coordinator = new CapacityCoordinator(registryWith(first, second));
    const scheduler = new CapacityRefreshScheduler(coordinator, {
      intervalsMs: { first: 10 },
      defaultIntervalMs: 20,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.isRunning).toBe(true);
    expect(first.collectCalls).toBe(1);
    expect(second.collectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(first.collectCalls).toBe(2);
    expect(second.collectCalls).toBe(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.isRunning).toBe(false);
    expect(first.collectCalls).toBe(2);
    expect(second.collectCalls).toBe(1);
  });
});
