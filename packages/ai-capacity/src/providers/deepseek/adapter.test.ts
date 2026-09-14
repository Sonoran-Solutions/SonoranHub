import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapacityCoordinator } from '../../coordinator.js';
import { CapacityAdapterRegistry } from '../../registry.js';
import {
  DEEPSEEK_PROVIDER_ID,
  DeepSeekCapacityAdapter,
  type DeepSeekFetch,
  type DeepSeekResponse,
} from './adapter.js';
import { deepSeekPricingConfig, type DeepSeekPricingConfig } from './pricing-config.js';

const checkedAt = '2026-09-14T12:00:00.000Z';
const apiKey = 'deepseek-api-key-test-only';

function response(status: number, payload: unknown): DeepSeekResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function balancePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'USD',
        total_balance: '14.82',
        granted_balance: '4.82',
        topped_up_balance: '10.00',
      },
    ],
    ...overrides,
  };
}

function routeFetch(result: DeepSeekResponse): DeepSeekFetch {
  return async () => result;
}

describe('DeepSeekCapacityAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports missing and whitespace-only credentials without making a request', async () => {
    const fetcher = vi.fn<DeepSeekFetch>();

    await expect(
      new DeepSeekCapacityAdapter({ apiKey: '   ', fetch: fetcher, now: () => checkedAt }).probe(),
    ).resolves.toMatchObject({ available: false, reason: 'DeepSeek API key is not configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid request timeout: %s',
    (requestTimeoutMs) => {
      expect(() => new DeepSeekCapacityAdapter({ requestTimeoutMs })).toThrow(
        'requestTimeoutMs must be a finite positive number',
      );
    },
  );

  it('probes the official balance endpoint and collects independent balance/pricing resources', async () => {
    const calls: Array<{ url: string; authorization: string | null; signal: AbortSignal | null }> =
      [];
    const fetcher: DeepSeekFetch = async (input, init) => {
      calls.push({
        url: input,
        authorization: new Headers(init?.headers).get('authorization'),
        signal: init?.signal ?? null,
      });
      return response(200, balancePayload());
    };
    const adapter = new DeepSeekCapacityAdapter({ apiKey, fetch: fetcher, now: () => checkedAt });
    const registry = new CapacityAdapterRegistry();
    registry.register(adapter);
    const coordinator = new CapacityCoordinator(registry, { now: () => checkedAt });

    const probe = await coordinator.probe(DEEPSEEK_PROVIDER_ID);
    const collection = await coordinator.refresh(DEEPSEEK_PROVIDER_ID);

    expect(probe).toMatchObject({ providerId: DEEPSEEK_PROVIDER_ID, available: true });
    expect(collection).toMatchObject({
      status: 'succeeded',
      providerId: DEEPSEEK_PROVIDER_ID,
      resources: [
        { id: 'deepseek-wallet-usd', kind: 'wallet', remaining: 14.82 },
        {
          id: 'deepseek-pricing-window',
          kind: 'pricing_window',
          metadata: { state: 'OFF_PEAK', timezone: 'UTC' },
        },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      url: 'https://api.deepseek.com/user/balance',
      authorization: `Bearer ${apiKey}`,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(collection)).not.toContain(apiKey);
  });

  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ] as const)('maps HTTP %s to a typed probe failure', async (status, code) => {
    const adapter = new DeepSeekCapacityAdapter({
      apiKey,
      fetch: routeFetch(response(status, { secret: apiKey })),
      now: () => checkedAt,
    });

    const probe = await adapter.probe();

    expect(probe).toMatchObject({
      available: false,
      failure: { code, providerId: DEEPSEEK_PROVIDER_ID, phase: 'probe' },
    });
    expect(JSON.stringify(probe)).not.toContain(apiKey);
  });

  it('maps transport failure and malformed 200 responses without leaking secrets', async () => {
    const transport = new DeepSeekCapacityAdapter({
      apiKey,
      fetch: async () => {
        throw new Error(`Authorization: Bearer ${apiKey}`);
      },
      now: () => checkedAt,
    });
    const malformed = new DeepSeekCapacityAdapter({
      apiKey,
      fetch: routeFetch(response(200, { is_available: true, balance_infos: [{ secret: apiKey }] })),
      now: () => checkedAt,
    });

    await expect(transport.probe()).resolves.toMatchObject({
      failure: { code: 'provider_error' },
    });
    await expect(malformed.probe()).resolves.toMatchObject({
      failure: { code: 'invalid_response' },
    });
    expect(JSON.stringify(await transport.probe())).not.toContain(apiKey);
    expect(JSON.stringify(await malformed.probe())).not.toContain(apiKey);
  });

  it('aborts a timed-out balance request and maps probe failure to timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const adapter = new DeepSeekCapacityAdapter({
      apiKey,
      requestTimeoutMs: 25,
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<DeepSeekResponse>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('abort exception does not include credentials');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
      now: () => checkedAt,
    });

    const probePromise = adapter.probe();
    await vi.advanceTimersByTimeAsync(25);
    const probe = await probePromise;

    expect(probe).toMatchObject({
      available: false,
      failure: { code: 'timeout', phase: 'probe' },
    });
    expect(JSON.stringify(probe)).not.toContain(apiKey);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves pricing when balance collection fails', async () => {
    const adapter = new DeepSeekCapacityAdapter({
      apiKey,
      fetch: routeFetch(response(500, { secret: apiKey })),
      now: () => checkedAt,
    });

    const collection = await adapter.collect();

    expect(collection.error).toBeUndefined();
    expect(
      collection.resources.find((resource) => resource.id === 'deepseek-wallet-usd'),
    ).toMatchObject({
      status: 'unknown',
      error: { code: 'provider_error' },
    });
    expect(
      collection.resources.find((resource) => resource.id === 'deepseek-pricing-window'),
    ).toMatchObject({ status: 'available', freshness: 'fresh' });
    expect(JSON.stringify(collection)).not.toContain(apiKey);
  });

  it('preserves balance when pricing configuration is invalid', async () => {
    const invalidConfig = {
      ...deepSeekPricingConfig,
      peakWindows: [],
    } as unknown as DeepSeekPricingConfig;
    const adapter = new DeepSeekCapacityAdapter({
      apiKey,
      pricingConfig: invalidConfig,
      fetch: routeFetch(response(200, balancePayload())),
      now: () => checkedAt,
    });

    const collection = await adapter.collect();

    expect(collection.error).toBeUndefined();
    expect(
      collection.resources.find((resource) => resource.id === 'deepseek-wallet-usd'),
    ).toMatchObject({
      remaining: 14.82,
      status: 'available',
    });
    expect(
      collection.resources.find((resource) => resource.id === 'deepseek-pricing-window'),
    ).toMatchObject({ status: 'unknown', error: { code: 'invalid_normalized_data' } });
  });

  it('keeps CNY separate and still provides pricing when USD is absent', async () => {
    const adapter = new DeepSeekCapacityAdapter({
      apiKey,
      fetch: routeFetch(
        response(200, {
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: '100.50',
              granted_balance: '20.50',
              topped_up_balance: '80.00',
            },
          ],
        }),
      ),
      now: () => checkedAt,
    });

    const collection = await adapter.collect();
    const wallet = collection.resources.find((resource) => resource.id === 'deepseek-wallet-usd');

    expect(wallet).toMatchObject({ status: 'unknown', error: { code: 'unavailable' } });
    expect(wallet).not.toHaveProperty('remaining');
    expect(wallet?.metadata).toMatchObject({
      additional_balances: [{ currency: 'CNY', total_balance: 100.5 }],
    });
    expect(
      collection.resources.find((resource) => resource.id === 'deepseek-pricing-window'),
    ).toMatchObject({ status: 'available' });
  });
});
