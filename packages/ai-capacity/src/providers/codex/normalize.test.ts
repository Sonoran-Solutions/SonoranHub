import { describe, expect, it } from 'vitest';

import type { CodexRateLimitsResponse, CodexRateLimitSnapshot } from './protocol.js';
import {
  codexQuotaStatus,
  codexUnixSecondsToIso,
  formatCodexQuotaWindowLabel,
  normalizeCodexRateLimits,
} from './normalize.js';
import type { CodexRateLimitSnapshot as SourceRateLimitSnapshot } from './source.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function mainBucket(overrides: Partial<CodexRateLimitSnapshot> = {}): CodexRateLimitSnapshot {
  return {
    limitId: 'codex',
    limitName: 'Codex',
    planType: 'plus',
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 19, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
    ...overrides,
  };
}

function sourceSnapshot(
  responseOverrides: Partial<CodexRateLimitsResponse> = {},
): SourceRateLimitSnapshot {
  return {
    response: {
      rateLimits: mainBucket(),
      ordinaryUsageAllowed: true,
      ...responseOverrides,
    },
    planType: 'plus',
    codexVersion: '0.154.0-alpha.6.2',
  };
}

describe('Codex normalization', () => {
  it('normalizes primary and weekly secondary percentages from usedPercent', () => {
    const resources = normalizeCodexRateLimits(sourceSnapshot(), collectedAt);
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'codex-codex-primary',
          name: '5-hour quota',
          kind: 'rolling_quota',
          used: 37,
          remaining: 63,
          remainingPercent: 63,
          resetAt: '2027-01-15T08:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'codex-codex-secondary',
          name: 'Weekly quota',
          kind: 'weekly_quota',
          used: 19,
          remaining: 81,
          remainingPercent: 81,
          resetAt: '2027-01-22T08:00:00.000Z',
        }),
      ]),
    );
  });

  it('does not invent a secondary resource when only primary is reported', () => {
    const resources = normalizeCodexRateLimits(
      sourceSnapshot({ rateLimits: mainBucket({ secondary: null }) }),
      collectedAt,
    );
    expect(resources.map((resource) => resource.id)).toEqual(['codex-codex-primary']);
  });

  it('preserves additional buckets without duplicating the legacy main bucket', () => {
    const reserve = mainBucket({
      limitId: 'reserve/luna',
      limitName: 'Reserve / Luna',
      primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null },
      secondary: null,
    });
    const resources = normalizeCodexRateLimits(
      sourceSnapshot({ rateLimitsByLimitId: { codex: mainBucket(), 'reserve/luna': reserve } }),
      collectedAt,
    );
    expect(resources.map((resource) => resource.id)).toEqual([
      'codex-codex-primary',
      'codex-codex-secondary',
      'codex-reserve-luna-primary',
    ]);
    expect(resources[2]).toMatchObject({
      name: 'Reserve / Luna · 1-hour quota',
      metadata: { limit_id: 'reserve/luna' },
    });
  });

  it('preserves a missing reset timestamp as absent', () => {
    const [resource] = normalizeCodexRateLimits(
      sourceSnapshot({
        rateLimits: mainBucket({
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        }),
      }),
      collectedAt,
    );
    expect(resource).not.toHaveProperty('resetAt');
  });

  it('normalizes credits, spend-control semantics, plan, and reset count', () => {
    const resources = normalizeCodexRateLimits(
      sourceSnapshot({
        rateLimits: mainBucket({
          credits: { hasCredits: true, unlimited: false, balance: '12.50' },
          individualLimit: {
            limit: '25.00',
            used: '10.00',
            remainingPercent: 60,
            resetsAt: 1_800_000_000,
          },
        }),
        rateLimitResetCredits: { availableCount: 4, credits: [] },
      }),
      collectedAt,
    );
    expect(resources.find((resource) => resource.id === 'codex-codex-credits')).toMatchObject({
      kind: 'credits',
      unit: 'credits',
      remaining: 12.5,
      metadata: expect.objectContaining({ credits_balance: '12.50' }),
    });
    expect(resources.find((resource) => resource.id === 'codex-codex-spend-control')).toMatchObject(
      {
        remainingPercent: 60,
        metadata: expect.objectContaining({
          spend_control: true,
          provider_limit: '25.00',
          provider_used: '10.00',
        }),
      },
    );
    expect(resources.find((resource) => resource.id === 'codex-quota-reset-credits')).toMatchObject(
      {
        remaining: 4,
        metadata: expect.objectContaining({ available_count: 4, detail_rows_available: true }),
      },
    );
    expect(resources.find((resource) => resource.id === 'codex-codex-primary')).toMatchObject({
      metadata: { plan_type: 'plus', ordinary_usage_allowed: true },
    });
  });

  it('keeps unlimited credits truthful without inventing a finite balance', () => {
    const resources = normalizeCodexRateLimits(
      sourceSnapshot({
        rateLimits: mainBucket({ credits: { hasCredits: true, unlimited: true } }),
      }),
      collectedAt,
    );
    expect(resources.find((resource) => resource.id === 'codex-codex-credits')).toMatchObject({
      status: 'available',
      unit: 'credits',
      metadata: { credits_state: 'unlimited' },
    });
    expect(resources.find((resource) => resource.id === 'codex-codex-credits')).not.toHaveProperty(
      'remaining',
    );
  });

  it('uses deterministic status boundaries and honors backend permission state', () => {
    expect(codexQuotaStatus(80)).toBe('available');
    expect(codexQuotaStatus(20)).toBe('warning');
    expect(codexQuotaStatus(10)).toBe('critical');
    expect(codexQuotaStatus(1)).toBe('critical');
    expect(codexQuotaStatus(0)).toBe('exhausted');
    expect(codexQuotaStatus(0, { ordinaryUsageAllowed: true })).toBe('critical');
    expect(codexQuotaStatus(63, { ordinaryUsageAllowed: false })).toBe('critical');
    expect(codexQuotaStatus(63, { rateLimitReachedType: 'rate_limit_reached' })).toBe('exhausted');
  });

  it('formats actual durations without guessing weekly for arbitrary windows', () => {
    expect(formatCodexQuotaWindowLabel(15)).toBe('15-minute quota');
    expect(formatCodexQuotaWindowLabel(30)).toBe('30-minute quota');
    expect(formatCodexQuotaWindowLabel(60)).toBe('1-hour quota');
    expect(formatCodexQuotaWindowLabel(300)).toBe('5-hour quota');
    expect(formatCodexQuotaWindowLabel(1_440)).toBe('24-hour quota');
    expect(formatCodexQuotaWindowLabel(10_080)).toBe('Weekly quota');
    expect(formatCodexQuotaWindowLabel(8 * 24 * 60)).toBe('8-day quota');
  });

  it('converts Unix seconds exactly and rejects unusable values', () => {
    expect(codexUnixSecondsToIso(1_800_000_000)).toBe('2027-01-15T08:00:00.000Z');
    expect(codexUnixSecondsToIso(null)).toBeUndefined();
    expect(() => codexUnixSecondsToIso(-1)).toThrow('invalid reset timestamp');
  });
});
