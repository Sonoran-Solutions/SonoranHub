import { describe, expect, it } from 'vitest';

import type { CapacityResource } from '@sonoran-hub/contracts';

import { freshnessLabel, resourceValue, statusLabel } from './capacityViewModel.js';

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

describe('capacity presentation helpers', () => {
  it('explains an unbounded OpenRouter key without presenting unknown as broken', () => {
    expect(
      resourceValue({
        ...base,
        kind: 'key_budget',
        metadata: { budget_state: 'unbounded' },
      }),
    ).toBe('No spending cap configured');
  });

  it('formats finite wallets and preserves unknown balances', () => {
    expect(resourceValue({ ...base, remaining: 18.42, status: 'available' })).toBe('$18.42');
    expect(resourceValue(base)).toBe('Not reported');
  });

  it.each([
    ['OFF_PEAK', 'OFF_PEAK · 0.5× price'],
    ['PEAK', 'PEAK · 1× price'],
  ])('formats DeepSeek %s pricing', (state, expected) => {
    expect(
      resourceValue({
        ...base,
        provider: 'deepseek',
        kind: 'pricing_window',
        unit: 'state',
        status: 'available',
        source: 'derived',
        metadata: { state, price_multiplier: state === 'PEAK' ? 1 : 0.5 },
      }),
    ).toBe(expected);
  });

  it('uses text labels for status and freshness', () => {
    expect(statusLabel('critical')).toBe('critical');
    expect(freshnessLabel('stale')).toBe('stale');
  });
});
