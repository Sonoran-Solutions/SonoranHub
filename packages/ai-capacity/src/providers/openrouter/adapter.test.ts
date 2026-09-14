import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapacityCoordinator } from '../../coordinator.js';
import { CapacityAdapterRegistry } from '../../registry.js';
import {
  OPENROUTER_PROVIDER_ID,
  OpenRouterCapacityAdapter,
  type OpenRouterFetch,
  type OpenRouterResponse,
} from './adapter.js';

const checkedAt = '2026-09-14T12:00:00.000Z';
const apiKey = 'api-key-test-only';
const managementKey = 'management-key-test-only';

function response(status: number, payload: unknown): OpenRouterResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function keyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      limit: 25,
      limit_remaining: 18.42,
      limit_reset: 'monthly',
      usage: 6.58,
      usage_daily: 1.25,
      usage_weekly: 3.5,
      usage_monthly: 6.58,
      byok_usage: 0.4,
      byok_usage_daily: 0.1,
      byok_usage_weekly: 0.2,
      byok_usage_monthly: 0.4,
      include_byok_in_limit: true,
      is_free_tier: false,
      is_management_key: false,
      label: 'production-capacity',
      expires_at: '2027-12-31T23:59:59Z',
      ...overrides,
    },
  };
}

function creditsPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      total_credits: 100.5,
      total_usage: 25.75,
      ...overrides,
    },
  };
}

function routeFetch(
  routes: { key?: OpenRouterResponse; credits?: OpenRouterResponse },
  calls: Array<{ url: string; authorization: string | undefined }> = [],
): OpenRouterFetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: input, authorization: headers.get('authorization') ?? undefined });
    if (input.endsWith('/key')) {
      return routes.key ?? response(500, { message: 'provider body must not leak' });
    }
    return routes.credits ?? response(500, { message: 'provider body must not leak' });
  };
}

function abortingCreditsFetch(signals: AbortSignal[]): OpenRouterFetch {
  return async (input, init) => {
    if (input.endsWith('/key')) {
      return response(200, keyPayload());
    }

    const signal = init?.signal;
    if (!signal) {
      throw new Error('test fetch did not receive an abort signal');
    }
    signals.push(signal);
    return new Promise<OpenRouterResponse>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted request contained no provider details');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  };
}

function abortingKeyFetch(signals: AbortSignal[]): OpenRouterFetch {
  return async (_input, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error('test fetch did not receive an abort signal');
    }
    signals.push(signal);
    return new Promise<OpenRouterResponse>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted request contained no provider details');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  };
}

describe('OpenRouterCapacityAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid request timeout configuration: %s',
    (requestTimeoutMs) => {
      expect(() => new OpenRouterCapacityAdapter({ requestTimeoutMs })).toThrow(
        'requestTimeoutMs must be a finite positive number',
      );
    },
  );

  it('reports missing API-key configuration as unavailable without making a request', async () => {
    const fetcher = vi.fn<OpenRouterFetch>();
    const adapter = new OpenRouterCapacityAdapter({ fetch: fetcher, now: () => checkedAt });

    await expect(adapter.probe()).resolves.toMatchObject({
      providerId: OPENROUTER_PROVIDER_ID,
      available: false,
      reason: 'OpenRouter API key is not configured',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('probes a valid API key using the official current-key endpoint', async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({ key: response(200, keyPayload()) }, calls),
      now: () => checkedAt,
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      providerId: OPENROUTER_PROVIDER_ID,
      available: true,
      checkedAt,
    });
    expect(calls).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/key',
        authorization: `Bearer ${apiKey}`,
      },
    ]);
  });

  it('aborts a hanging optional credits request and preserves the fresh key resource', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      requestTimeoutMs: 25,
      fetch: abortingCreditsFetch(signals),
      now: () => checkedAt,
    });
    const registry = new CapacityAdapterRegistry();
    registry.register(adapter);
    const coordinator = new CapacityCoordinator(registry, {
      collectionTimeoutMs: 1_000,
      now: () => checkedAt,
    });

    const collectionPromise = coordinator.collect(OPENROUTER_PROVIDER_ID);
    await vi.advanceTimersByTimeAsync(25);
    const collection = await collectionPromise;

    expect(collection).toMatchObject({ status: 'succeeded' });
    if (collection.status === 'succeeded') {
      expect(collection.resources).toHaveLength(2);
      expect(
        collection.resources.find((resource) => resource.id === 'openrouter-key-budget'),
      ).toMatchObject({
        status: 'available',
        freshness: 'fresh',
      });
      expect(
        collection.resources.find((resource) => resource.id === 'openrouter-account-credits'),
      ).toMatchObject({ status: 'unknown', error: { code: 'timeout' } });
    }
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps a hanging key request to a typed probe timeout and aborts the fetch', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      requestTimeoutMs: 25,
      fetch: abortingKeyFetch(signals),
      now: () => checkedAt,
    });

    const probePromise = adapter.probe();
    await vi.advanceTimersByTimeAsync(25);
    const probe = await probePromise;

    expect(probe).toMatchObject({
      available: false,
      failure: {
        code: 'timeout',
        phase: 'probe',
        message: 'OpenRouter request timed out for /key',
      },
    });
    expect(JSON.stringify(probe)).not.toContain(apiKey);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves valid credits when the key request times out', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      requestTimeoutMs: 25,
      fetch: async (input, init) => {
        if (input.endsWith('/credits')) {
          return response(200, creditsPayload());
        }
        return abortingKeyFetch(signals)(input, init);
      },
      now: () => checkedAt,
    });

    const collectionPromise = adapter.collect();
    await vi.advanceTimersByTimeAsync(25);
    const collection = await collectionPromise;

    expect(collection.error).toBeUndefined();
    expect(
      collection.resources.find((resource) => resource.id === 'openrouter-key-budget'),
    ).toMatchObject({
      status: 'unknown',
      error: { code: 'timeout' },
    });
    expect(
      collection.resources.find((resource) => resource.id === 'openrouter-account-credits'),
    ).toMatchObject({ kind: 'wallet', remaining: 74.75, freshness: 'fresh' });
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [401, 'authentication'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ] as const)('maps HTTP %s to a typed probe failure', async (status, code) => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({ key: response(status, { error: apiKey }) }),
      now: () => checkedAt,
    });

    const result = await adapter.probe();

    expect(result).toMatchObject({
      available: false,
      failure: { code, providerId: OPENROUTER_PROVIDER_ID, phase: 'probe' },
    });
    expect(result.reason).not.toContain(apiKey);
  });

  it('maps malformed successful probe data to invalid_response without exposing the body', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({
        key: response(200, { data: { usage: 'not-a-number', secret: apiKey } }),
      }),
      now: () => checkedAt,
    });

    const result = await adapter.probe();

    expect(result).toMatchObject({
      available: false,
      failure: { code: 'invalid_response' },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('keeps immediate transport failures as provider_error and clears the request timer', async () => {
    vi.useFakeTimers();
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      requestTimeoutMs: 25,
      fetch: async () => {
        throw new Error(`Authorization: Bearer ${apiKey}`);
      },
      now: () => checkedAt,
    });

    const result = await adapter.collect();

    expect(result).toMatchObject({ error: { code: 'provider_error' } });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain('Authorization');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps malformed JSON responses as invalid_response and clears the request timer', async () => {
    vi.useFakeTimers();
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      requestTimeoutMs: 25,
      fetch: async () => response(200, { data: { usage: 'malformed', secret: apiKey } }),
      now: () => checkedAt,
    });

    const result = await adapter.collect();

    expect(result).toMatchObject({ error: { code: 'invalid_response' } });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('normalizes a capped key, derives a contract-safe percentage, and preserves reset/BYOK metadata', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({ key: response(200, { ...keyPayload(), rate_limit: { requests: 1 } }) }),
      now: () => checkedAt,
    });

    const result = await adapter.collect();
    const resource = result.resources[0];

    expect(result.error).toBeUndefined();
    expect(resource).toMatchObject({
      id: 'openrouter-key-budget',
      provider: OPENROUTER_PROVIDER_ID,
      kind: 'key_budget',
      limit: 25,
      used: 6.58,
      remaining: 18.42,
      remainingPercent: 73.68,
      unit: 'usd',
      status: 'available',
      source: 'official_api',
      collectedAt: checkedAt,
      freshness: 'fresh',
      metadata: {
        label: 'production-capacity',
        limit_reset: 'monthly',
        include_byok_in_limit: true,
        byok_usage_monthly: 0.4,
      },
    });
    expect(resource?.resetAt).toBeUndefined();
    expect(resource?.metadata).not.toHaveProperty('rate_limit');
  });

  it('represents an uncapped key as freshly observed but unbounded, without fake numeric capacity', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({
        key: response(200, keyPayload({ limit: null, limit_remaining: null, limit_reset: null })),
      }),
      now: () => checkedAt,
    });

    const resource = (await adapter.collect()).resources[0];

    expect(resource).toMatchObject({
      kind: 'key_budget',
      status: 'unknown',
      freshness: 'fresh',
      metadata: { limit_configured: false, budget_state: 'unbounded' },
    });
    expect(resource).not.toHaveProperty('limit');
    expect(resource).not.toHaveProperty('used');
    expect(resource).not.toHaveProperty('remaining');
    expect(resource).not.toHaveProperty('remainingPercent');
  });

  it('normalizes management-key credits as a monetary wallet with precise remaining arithmetic', async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      fetch: routeFetch(
        {
          key: response(200, keyPayload()),
          credits: response(200, creditsPayload()),
        },
        calls,
      ),
      now: () => checkedAt,
    });

    const result = await adapter.collect();
    const credits = result.resources.find(
      (resource) => resource.id === 'openrouter-account-credits',
    );

    expect(credits).toMatchObject({
      kind: 'wallet',
      name: 'OpenRouter account credits',
      limit: 100.5,
      used: 25.75,
      remaining: 74.75,
      unit: 'usd',
      status: 'available',
      metadata: { total_credits: 100.5, total_usage: 25.75 },
    });
    expect(credits?.remainingPercent).toBeCloseTo(74.3781094527, 8);
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ['https://openrouter.ai/api/v1/key', `Bearer ${apiKey}`],
      ['https://openrouter.ai/api/v1/credits', `Bearer ${managementKey}`],
    ]);
  });

  it('omits optional account credits when no management key is configured', async () => {
    const calls: string[] = [];
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: async (input, init) => {
        calls.push(`${input}:${new Headers(init?.headers).get('authorization')}`);
        return response(200, keyPayload());
      },
      now: () => checkedAt,
    });

    const result = await adapter.collect();

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.kind).toBe('key_budget');
    expect(calls).toEqual([`https://openrouter.ai/api/v1/key:Bearer ${apiKey}`]);
  });

  it('keeps key-budget data when the optional credits endpoint fails', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      fetch: routeFetch({
        key: response(200, keyPayload()),
        credits: response(401, { message: managementKey }),
      }),
      now: () => checkedAt,
    });

    const result = await adapter.collect();
    const keyBudget = result.resources.find((resource) => resource.kind === 'key_budget');
    const credits = result.resources.find(
      (resource) => resource.id === 'openrouter-account-credits',
    );

    expect(result.error).toBeUndefined();
    expect(keyBudget).toMatchObject({ remaining: 18.42, status: 'available' });
    expect(credits).toMatchObject({
      status: 'unknown',
      freshness: 'unknown',
      error: { code: 'authentication' },
    });
    expect(JSON.stringify(result)).not.toContain(managementKey);
  });

  it('marks malformed credits as unknown while retaining a valid key resource', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      fetch: routeFetch({
        key: response(200, keyPayload()),
        credits: response(200, { data: { total_credits: 100.5, total_usage: 'bad' } }),
      }),
      now: () => checkedAt,
    });

    const result = await adapter.collect();

    expect(result.resources.find((resource) => resource.kind === 'key_budget')).toMatchObject({
      remaining: 18.42,
    });
    expect(
      result.resources.find((resource) => resource.id === 'openrouter-account-credits'),
    ).toMatchObject({
      status: 'unknown',
      error: { code: 'invalid_response' },
    });
  });

  it('does not silently clamp a meaningfully negative account-credit balance', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      managementKey,
      fetch: routeFetch({
        key: response(200, keyPayload()),
        credits: response(200, creditsPayload({ total_credits: 10, total_usage: 12 })),
      }),
      now: () => checkedAt,
    });

    const result = await adapter.collect();

    expect(
      result.resources.find((resource) => resource.id === 'openrouter-account-credits'),
    ).toMatchObject({
      status: 'unknown',
      error: { code: 'invalid_normalized_data' },
    });
  });

  it('preserves typed failures through the D1 registry and coordinator', async () => {
    const adapter = new OpenRouterCapacityAdapter({
      apiKey,
      fetch: routeFetch({ key: response(200, keyPayload()) }),
      now: () => checkedAt,
    });
    const registry = new CapacityAdapterRegistry();
    registry.register(adapter);
    const coordinator = new CapacityCoordinator(registry, { now: () => checkedAt });

    const probe = await coordinator.probe(OPENROUTER_PROVIDER_ID);
    const collection = await coordinator.refresh(OPENROUTER_PROVIDER_ID);

    expect(probe).toMatchObject({ available: true });
    expect(collection).toMatchObject({
      status: 'succeeded',
      providerId: OPENROUTER_PROVIDER_ID,
      resources: [{ id: 'openrouter-key-budget' }],
    });
  });
});
