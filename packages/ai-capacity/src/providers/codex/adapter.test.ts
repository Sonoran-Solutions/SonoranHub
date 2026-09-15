import { describe, expect, it } from 'vitest';

import type { CodexCapacitySource } from './source.js';
import { CodexCapacityAdapter } from './adapter.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function source(overrides: Partial<CodexCapacitySource> = {}): CodexCapacitySource {
  return {
    probe: async () => ({ available: true, planType: 'pro' }),
    readCapacity: async () => ({
      response: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: null },
        },
        ordinaryUsageAllowed: true,
      },
      planType: 'pro',
      codexVersion: '0.154.0-alpha.6.2',
    }),
    close: async () => undefined,
    ...overrides,
  };
}

describe('CodexCapacityAdapter', () => {
  it('keeps the source transport behind the normalized adapter contract', async () => {
    const adapter = new CodexCapacityAdapter({ source: source(), now: () => collectedAt });

    await expect(adapter.probe()).resolves.toMatchObject({
      providerId: 'codex',
      available: true,
    });
    await expect(adapter.collect()).resolves.toMatchObject({
      collectedAt,
      resources: [
        {
          id: 'codex-codex-primary',
          source: 'official_cli',
          remainingPercent: 63,
          metadata: { codex_version: '0.154.0-alpha.6.2' },
        },
      ],
    });
  });

  it('returns a typed unavailable result for a missing or unsupported source', async () => {
    const adapter = new CodexCapacityAdapter({
      source: source({
        probe: async () => ({
          available: false,
          reason: 'Codex ChatGPT authentication is not available',
          failure: {
            code: 'authentication',
            message: 'Codex ChatGPT authentication is not available',
          },
        }),
        readCapacity: async () => {
          throw Object.assign(new Error('not authenticated'), { code: 'authentication' });
        },
      }),
      now: () => collectedAt,
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      available: false,
      failure: { code: 'authentication', providerId: 'codex', phase: 'probe' },
    });
    await expect(adapter.collect()).resolves.toMatchObject({
      resources: [],
      error: { code: 'authentication' },
    });
  });

  it('maps malformed normalized data to invalid_normalized_data', async () => {
    const adapter = new CodexCapacityAdapter({
      source: source({
        readCapacity: async () => ({
          response: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: null },
            },
          },
        }),
      }),
      now: () => collectedAt,
    });

    await expect(adapter.collect()).resolves.toMatchObject({
      resources: [],
      error: { code: 'invalid_normalized_data' },
    });
  });
});
