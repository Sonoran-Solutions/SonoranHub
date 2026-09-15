import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapacityCurrentResponse, CapacityResource } from '@sonoran-hub/contracts';

import {
  createCapacityPoller,
  deepSeekPricingPresentation,
  DEFAULT_UI_POLL_INTERVAL_MS,
  formatRelativeAge,
  freshnessLabel,
  isSemanticallyKnownResource,
  pricingTransitionLabel,
  primaryResource,
  providerSummaryStatus,
  resourceStatusLabel,
  resourceValue,
  type CapacityState,
  statusLabel,
} from './capacityViewModel.js';

const base: CapacityResource = {
  id: 'test',
  provider: 'openrouter',
  kind: 'wallet',
  name: 'Test resource',
  unit: 'usd',
  status: 'unknown',
  source: 'official_api',
  collectedAt: '2026-09-14T12:00:00.000Z',
  freshness: 'unknown',
};

const response: CapacityCurrentResponse = {
  generatedAt: '2026-09-14T12:00:00.000Z',
  providers: [],
};

function pricingResource(
  state: 'PEAK' | 'OFF_PEAK',
  nextState: 'PEAK' | 'OFF_PEAK',
): CapacityResource {
  return {
    ...base,
    id: 'deepseek-pricing-window',
    provider: 'deepseek',
    kind: 'pricing_window',
    name: 'DeepSeek pricing window',
    unit: 'state',
    status: 'available',
    source: 'derived',
    changesAt: '2026-09-14T21:00:00.000Z',
    metadata: { state, next_state: nextState, price_multiplier: state === 'PEAK' ? 1 : 0.5 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('capacity presentation helpers', () => {
  it('uses the 15-second default UI polling cadence', () => {
    expect(DEFAULT_UI_POLL_INTERVAL_MS).toBe(15_000);
  });

  it('explains an unbounded OpenRouter key without presenting unknown as broken', () => {
    const resource = {
      ...base,
      kind: 'key_budget' as const,
      metadata: { budget_state: 'unbounded' },
    };
    expect(resourceValue(resource)).toBe('No spending cap configured');
    expect(resourceStatusLabel(resource)).toBe('UNBOUNDED');
    expect(isSemanticallyKnownResource(resource)).toBe(true);
    expect(
      providerSummaryStatus([resource, { ...base, remaining: 18.42, status: 'available' }], false),
    ).toBe('available');
  });

  it('prefers an available wallet as the compact provider resource', () => {
    const wallet = { ...base, remaining: 18.42, status: 'available' as const };
    const keyBudget = {
      ...base,
      kind: 'key_budget' as const,
      metadata: { budget_state: 'unbounded' },
    };
    expect(primaryResource([keyBudget, wallet])).toBe(wallet);
  });

  it('formats finite wallets and preserves unknown balances', () => {
    expect(resourceValue({ ...base, remaining: 18.42, status: 'available' })).toBe('$18.42');
    expect(resourceValue(base)).toBe('Not reported');
  });

  it.each([
    ['OFF_PEAK', 'NORMAL', 'Off-peak pricing · 0.5×'],
    ['PEAK', 'PEAK', 'Peak pricing · 1×'],
  ] as const)('formats DeepSeek %s as %s', (state, badge, summary) => {
    const presentation = deepSeekPricingPresentation(
      pricingResource(state, state === 'PEAK' ? 'OFF_PEAK' : 'PEAK'),
    );
    expect(presentation.badge).toBe(badge);
    expect(presentation.summary).toBe(summary);
  });

  it('uses contextual DeepSeek transition wording', () => {
    expect(pricingTransitionLabel(pricingResource('PEAK', 'OFF_PEAK'))).toMatch(/^Peak ends at /);
    expect(pricingTransitionLabel(pricingResource('OFF_PEAK', 'PEAK'))).toMatch(/^Peak begins at /);
  });

  it('shows a neutral state when DeepSeek pricing is unavailable', () => {
    const unknown = deepSeekPricingPresentation({ ...base, provider: 'deepseek' });
    expect(unknown).toEqual({
      badge: 'PRICING UNKNOWN',
      tone: 'unknown',
      summary: 'Pricing unknown',
    });
  });

  it('formats snapshot age independently from network refreshes', () => {
    expect(
      formatRelativeAge('2026-09-14T12:00:00.000Z', Date.parse('2026-09-14T12:00:18.000Z')),
    ).toBe('18s ago');
  });

  it('uses text labels for status and freshness', () => {
    expect(statusLabel('critical')).toBe('critical');
    expect(freshnessLabel('stale')).toBe('stale');
  });
});

describe('capacity UI poller', () => {
  it('fetches immediately and does not overlap background requests', async () => {
    vi.useFakeTimers();
    const first = deferred<CapacityCurrentResponse>();
    const fetchCapacity = vi.fn(() => first.promise);
    const poller = createCapacityPoller({
      fetchCapacity,
      onState: () => undefined,
      intervalMs: 15_000,
    });

    poller.start();
    expect(fetchCapacity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchCapacity).toHaveBeenCalledTimes(1);

    first.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchCapacity).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('preserves successful data and reports a background refresh failure', async () => {
    vi.useFakeTimers();
    const second = deferred<CapacityCurrentResponse>();
    const fetchCapacity = vi
      .fn<(_: AbortSignal) => Promise<CapacityCurrentResponse>>()
      .mockResolvedValueOnce(response)
      .mockReturnValueOnce(second.promise);
    const states: CapacityState[] = [];
    const poller = createCapacityPoller({
      fetchCapacity,
      onState: (state) => states.push(state),
      intervalMs: 15_000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(states.at(-1)).toMatchObject({ status: 'success', refreshing: true, data: response });

    second.reject(new Error('Hub API unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({
      status: 'success',
      refreshing: false,
      data: response,
      refreshError: 'Hub API unavailable',
    });
    poller.stop();
  });

  it('reports an initial request failure as an error', async () => {
    vi.useFakeTimers();
    const fetchCapacity = vi.fn(async () => {
      throw new Error('Initial request failed');
    });
    const states: Array<{ status: string; message?: string }> = [];
    const poller = createCapacityPoller({
      fetchCapacity,
      onState: (state) => states.push(state),
      intervalMs: 15_000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({
      status: 'error',
      refreshing: false,
      message: 'Initial request failed',
    });
    poller.stop();
  });

  it('aborts the active request when stopped', () => {
    const fetchCapacity = vi.fn(
      (signal: AbortSignal) =>
        new Promise<CapacityCurrentResponse>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const poller = createCapacityPoller({ fetchCapacity, onState: () => undefined });

    poller.start();
    const signal = fetchCapacity.mock.calls[0]?.[0];
    poller.stop();

    expect(signal?.aborted).toBe(true);
  });
});
