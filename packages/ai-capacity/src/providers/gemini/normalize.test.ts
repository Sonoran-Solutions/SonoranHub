import { describe, expect, it } from 'vitest';

import { normalizeGeminiCapacity } from './normalize.js';
import type { GeminiCapacitySnapshot } from './source.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function snapshot(overrides: Partial<GeminiCapacitySnapshot> = {}): GeminiCapacitySnapshot {
  return {
    antigravityVersion: '1.1.22',
    planTier: 'Google AI Pro',
    quota: {
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.405,
              reset_time: '2026-09-19T03:37:31Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.04,
            },
          ],
        },
      ],
    },
    credits: { remaining_credits: 12.5, upgrade_uri: 'https://antigravity.google/g1-upgrade' },
    ...overrides,
  };
}

describe('Gemini normalization', () => {
  it('preserves multiple official quota buckets and exact reset timestamps', () => {
    const resources = normalizeGeminiCapacity(snapshot(), collectedAt);
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gemini-gemini-models-gemini-weekly',
          kind: 'weekly_quota',
          remainingPercent: 40.5,
          used: 59.5,
          resetAt: '2026-09-19T03:37:31Z',
          status: 'available',
          metadata: expect.objectContaining({
            group_name: 'Gemini Models',
            bucket_id: 'gemini-weekly',
            plan_tier: 'Google AI Pro',
          }),
        }),
        expect.objectContaining({
          id: 'gemini-gemini-models-gemini-5h',
          kind: 'rolling_quota',
          remainingPercent: 4,
          status: 'critical',
        }),
      ]),
    );
  });

  it('uses reported percent, relative reset derivation, and deterministic thresholds', () => {
    const resources = normalizeGeminiCapacity(
      snapshot({
        quota: {
          groups: [
            {
              name: 'Other models',
              buckets: [
                {
                  id: 'relative',
                  name: 'Relative',
                  remaining_percent: 20,
                  reset_after_seconds: 90,
                },
                { id: 'empty', name: 'Empty', remaining_fraction: 0 },
              ],
            },
          ],
        },
      }),
      collectedAt,
    );
    expect(resources[0]).toMatchObject({
      remainingPercent: 20,
      status: 'warning',
      resetAt: '2026-09-14T12:01:30.000Z',
      metadata: { reset_source: 'relative_duration' },
    });
    expect(resources[1]).toMatchObject({ remainingPercent: 0, status: 'exhausted' });
  });

  it('does not turn disabled buckets into exhausted quota', () => {
    const [resource] = normalizeGeminiCapacity(
      snapshot({
        quota: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [{ id: 'disabled', name: 'Disabled model', disabled: true }],
            },
          ],
        },
      }),
      collectedAt,
    );
    expect(resource).toMatchObject({
      status: 'unknown',
      freshness: 'unknown',
      metadata: { disabled: true },
    });
    expect(resource).not.toHaveProperty('remainingPercent');
  });

  it('normalizes credits without labeling them as dollars', () => {
    const [resource] = normalizeGeminiCapacity(
      snapshot({
        quota: undefined,
        credits: {
          remaining_credits: 0,
          upgrade_uri: 'https://example.invalid/upgrade?account_id=secret',
        },
      }),
      collectedAt,
    );
    expect(resource).toMatchObject({
      kind: 'credits',
      unit: 'credits',
      remaining: 0,
      status: 'exhausted',
      metadata: { credits_state: 'reported', upgrade_available: true },
    });
    expect(resource?.metadata).not.toHaveProperty('upgrade_uri');
    expect(JSON.stringify(resource)).not.toContain('example.invalid');
    expect(JSON.stringify(resource)).not.toContain('account_id');
  });

  it('preserves credits when quota collection failed', () => {
    const resources = normalizeGeminiCapacity(
      snapshot({
        quota: undefined,
        quotaError: { code: 'authentication', message: 'Antigravity CLI is not authenticated' },
      }),
      collectedAt,
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ kind: 'credits', remaining: 12.5 });
  });
});
