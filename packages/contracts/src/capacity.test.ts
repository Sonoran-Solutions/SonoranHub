import { describe, expect, it } from 'vitest';

import { capacityResourceSchema, capacitySnapshotSchema } from './capacity.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

describe('capacityResourceSchema', () => {
  it('accepts a wallet resource', () => {
    const result = capacityResourceSchema.safeParse({
      id: 'deepseek-wallet',
      provider: 'deepseek',
      kind: 'wallet',
      name: 'DeepSeek balance',
      remaining: 14.72,
      unit: 'usd',
      status: 'available',
      source: 'official_api',
      collectedAt,
      freshness: 'fresh',
    });

    expect(result.success).toBe(true);
  });

  it('accepts rolling and weekly quota resources with independent reset windows', () => {
    const rolling = capacityResourceSchema.safeParse({
      id: 'chatgpt-primary-rolling',
      provider: 'chatgpt',
      accountRef: 'primary-account',
      kind: 'rolling_quota',
      name: 'Primary rolling quota',
      limit: 100,
      used: 39,
      remaining: 61,
      remainingPercent: 61,
      unit: 'percent',
      resetAt: '2026-09-14T14:00:00.000Z',
      status: 'available',
      source: 'local_state',
      collectedAt,
      freshness: 'fresh',
    });
    const weekly = capacityResourceSchema.safeParse({
      id: 'chatgpt-weekly',
      provider: 'chatgpt',
      kind: 'weekly_quota',
      name: 'Weekly quota',
      remainingPercent: 79,
      unit: 'percent',
      resetAt: '2026-09-21T00:00:00.000Z',
      status: 'warning',
      source: 'local_state',
      collectedAt,
      freshness: 'fresh',
    });

    expect(rolling.success).toBe(true);
    expect(weekly.success).toBe(true);
  });

  it('accepts pricing windows without pretending they are quota percentages', () => {
    const result = capacityResourceSchema.safeParse({
      id: 'deepseek-pricing-window',
      provider: 'deepseek',
      kind: 'pricing_window',
      name: 'DeepSeek pricing window',
      unit: 'state',
      changesAt: '2026-09-14T15:11:00.000Z',
      status: 'available',
      source: 'derived',
      collectedAt,
      freshness: 'fresh',
      metadata: { state: 'OFF_PEAK' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a key budget and an unknown or stale resource', () => {
    const budget = capacityResourceSchema.safeParse({
      id: 'openrouter-key-budget',
      provider: 'openrouter',
      kind: 'key_budget',
      name: 'API key budget',
      limit: 25,
      used: 6.58,
      remaining: 18.42,
      remainingPercent: 73.68,
      unit: 'usd',
      status: 'available',
      source: 'official_api',
      collectedAt,
      freshness: 'fresh',
    });
    const unknown = capacityResourceSchema.safeParse({
      id: 'gemini-pro-quota',
      provider: 'gemini',
      kind: 'rolling_quota',
      name: 'Gemini Pro quota',
      unit: 'percent',
      status: 'unknown',
      source: 'official_api',
      collectedAt,
      freshness: 'unknown',
      error: { code: 'collector_unavailable', message: 'No trustworthy value collected yet' },
    });
    const stale = capacityResourceSchema.safeParse({
      id: 'openrouter-credits',
      provider: 'openrouter',
      kind: 'credits',
      name: 'Account credits',
      remaining: 18.42,
      unit: 'credits',
      status: 'warning',
      source: 'official_api',
      collectedAt,
      staleAfter: '2026-09-14T12:30:00.000Z',
      freshness: 'stale',
      error: { code: 'refresh_failed', message: 'Provider request failed' },
    });

    expect(budget.success).toBe(true);
    expect(unknown.success).toBe(true);
    expect(stale.success).toBe(true);
  });

  it('rejects invalid ranges, timestamps, units, and arithmetic', () => {
    const invalidResources = [
      {
        id: 'bad-percent',
        provider: 'chatgpt',
        kind: 'rolling_quota',
        name: 'Bad percentage',
        remainingPercent: 101,
        unit: 'percent',
        status: 'available',
        source: 'local_state',
        collectedAt,
        freshness: 'fresh',
      },
      {
        id: 'negative-wallet',
        provider: 'deepseek',
        kind: 'wallet',
        name: 'Negative wallet',
        remaining: -1,
        unit: 'usd',
        status: 'available',
        source: 'official_api',
        collectedAt,
        freshness: 'fresh',
      },
      {
        id: 'bad-time',
        provider: 'chatgpt',
        kind: 'weekly_quota',
        name: 'Bad timestamp',
        unit: 'percent',
        resetAt: 'tomorrow',
        status: 'available',
        source: 'local_state',
        collectedAt,
        freshness: 'fresh',
      },
      {
        id: 'bad-pricing-unit',
        provider: 'deepseek',
        kind: 'pricing_window',
        name: 'Bad pricing unit',
        unit: 'percent',
        status: 'available',
        source: 'derived',
        collectedAt,
        freshness: 'fresh',
      },
      {
        id: 'inconsistent-budget',
        provider: 'openrouter',
        kind: 'key_budget',
        name: 'Inconsistent budget',
        limit: 25,
        used: 10,
        remaining: 10,
        unit: 'usd',
        status: 'available',
        source: 'official_api',
        collectedAt,
        freshness: 'fresh',
      },
    ];

    for (const resource of invalidResources) {
      expect(capacityResourceSchema.safeParse(resource).success).toBe(false);
    }
  });
});

describe('capacitySnapshotSchema', () => {
  it('groups normalized resources without changing their semantics', () => {
    const result = capacitySnapshotSchema.safeParse({
      id: 'deepseek-2026-09-14T12:00:00.000Z',
      provider: 'deepseek',
      resources: [
        {
          id: 'deepseek-wallet',
          provider: 'deepseek',
          kind: 'wallet',
          name: 'DeepSeek balance',
          remaining: 14.72,
          unit: 'usd',
          status: 'available',
          source: 'official_api',
          collectedAt,
          freshness: 'fresh',
        },
      ],
      collectedAt,
      freshness: 'fresh',
    });

    expect(result.success).toBe(true);
  });

  it('rejects resources from a different provider than the snapshot', () => {
    const result = capacitySnapshotSchema.safeParse({
      id: 'deepseek-2026-09-14T12:00:00.000Z',
      provider: 'deepseek',
      resources: [
        {
          id: 'openrouter-credits',
          provider: 'openrouter',
          kind: 'credits',
          name: 'Account credits',
          remaining: 18.42,
          unit: 'credits',
          status: 'available',
          source: 'official_api',
          collectedAt,
          freshness: 'fresh',
        },
      ],
      collectedAt,
      freshness: 'fresh',
    });

    expect(result.success).toBe(false);
  });
});
