import { describe, expect, it } from 'vitest';

import type { GeminiCapacitySource } from './source.js';
import { GeminiCapacityAdapter } from './adapter.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function source(overrides: Partial<GeminiCapacitySource> = {}): GeminiCapacitySource {
  return {
    probe: async () => ({ available: true, antigravityVersion: '1.1.22' }),
    readCapacity: async () => ({
      antigravityVersion: '1.1.22',
      quota: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remaining_fraction: 0.72,
              },
            ],
          },
        ],
      },
      credits: { remaining_credits: 3 },
    }),
    close: async () => undefined,
    ...overrides,
  };
}

describe('GeminiCapacityAdapter', () => {
  it('keeps Antigravity transport behind the normalized adapter contract', async () => {
    const adapter = new GeminiCapacityAdapter({ source: source(), now: () => collectedAt });
    await expect(adapter.probe()).resolves.toMatchObject({
      providerId: 'gemini',
      available: true,
    });
    const result = await adapter.collect();
    expect(result.collectedAt).toBe(collectedAt);
    expect(result.resources.map((resource) => resource.id)).toEqual([
      'gemini-gemini-models-gemini-weekly',
      'gemini-g1-credits',
    ]);
    expect(result.resources[0]).toMatchObject({ source: 'official_cli', remainingPercent: 72 });
    expect(result.resources[1]).toMatchObject({ unit: 'credits', remaining: 3 });
  });

  it('keeps valid quota when credits fail', async () => {
    const adapter = new GeminiCapacityAdapter({
      source: source({
        readCapacity: async () => ({
          antigravityVersion: '1.1.22',
          quota: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [{ id: 'weekly', name: 'Weekly', remaining_fraction: 0.5 }],
              },
            ],
          },
          creditsError: { code: 'provider_error', message: 'Credits unavailable' },
        }),
      }),
      now: () => collectedAt,
    });
    const result = await adapter.collect();
    expect(result.error).toMatchObject({ code: 'provider_error' });
    expect(result.resources.find((resource) => resource.id === 'gemini-g1-credits')).toMatchObject({
      status: 'unknown',
    });
  });

  it('returns credits when quota fails', async () => {
    const adapter = new GeminiCapacityAdapter({
      source: source({
        readCapacity: async () => ({
          antigravityVersion: '1.1.22',
          credits: { remaining_credits: 5 },
          quotaError: { code: 'authentication', message: 'Not authenticated' },
        }),
      }),
      now: () => collectedAt,
    });
    await expect(adapter.collect()).resolves.toMatchObject({
      resources: [{ id: 'gemini-g1-credits', remaining: 5 }],
      error: { code: 'authentication' },
    });
  });
});
