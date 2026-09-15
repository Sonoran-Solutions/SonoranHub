import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, createStructuredLogger } from '@sonoran-hub/config';
import { buildApp } from './app.js';
import type { CodexCapacitySource, GeminiCapacitySource } from '@sonoran-hub/ai-capacity';

import { createCapacityRuntime, type CapacityRuntime } from './capacity.js';

describe('API Capacity runtime', () => {
  let runtime: CapacityRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it('bootstraps every provider without credentials and retains public DeepSeek pricing', async () => {
    const config = loadConfig(
      { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
      { defaultServiceName: 'sonoran-hub-api' },
    );
    runtime = createCapacityRuntime({
      environment: {
        CAPACITY_REFRESH_INTERVAL_MS: '300000',
        CODEX_BIN: '/definitely-missing-sonoran-hub-codex-test-binary',
        AGY_BIN: '/definitely-missing-sonoran-hub-agy-test-binary',
      },
      config,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });

    await runtime.start();
    const snapshots = await runtime.service.latest();

    expect(runtime.service.listProviderIds()).toEqual([
      'codex',
      'deepseek',
      'gemini',
      'openrouter',
    ]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      provider: 'deepseek',
      resources: [
        { id: 'deepseek-wallet-usd', status: 'unknown' },
        { id: 'deepseek-pricing-window', status: 'available' },
      ],
    });
    expect(runtime.service.getHealth('deepseek')).toMatchObject({
      available: false,
      lastProbeFailure: { code: 'unavailable' },
    });
    expect(runtime.service.getHealth('codex')).toMatchObject({
      available: false,
      lastProbeFailure: { code: 'unavailable' },
    });
    expect(runtime.service.getHealth('gemini')).toMatchObject({
      available: false,
      lastProbeFailure: { code: 'unavailable' },
    });
  });

  it('persists a normalized Codex snapshot for both current and history APIs', async () => {
    const config = loadConfig(
      { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
      { defaultServiceName: 'sonoran-hub-api' },
    );
    const codexSource: CodexCapacitySource = {
      probe: async () => ({ available: true, planType: 'plus' }),
      readCapacity: async () => ({
        response: {
          rateLimits: {
            limitId: 'codex',
            planType: 'plus',
            primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 19, windowDurationMins: 10_080, resetsAt: null },
          },
          ordinaryUsageAllowed: true,
        },
        planType: 'plus',
        codexVersion: '0.154.0-alpha.6.2',
      }),
      close: async () => undefined,
    };
    runtime = createCapacityRuntime({
      environment: {
        CAPACITY_REFRESH_INTERVAL_MS: '300000',
        AGY_BIN: '/definitely-missing-sonoran-hub-agy-test-binary',
      },
      config,
      codexSource,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });

    await runtime.start();
    const app = buildApp(config, { capacityService: runtime.service });
    const current = await app.inject({ method: 'GET', url: '/capacity' });
    const history = await app.inject({
      method: 'GET',
      url: '/capacity/history?provider=codex&limit=1',
    });
    await app.close();

    expect(current.statusCode).toBe(200);
    const currentBody = current.json() as {
      providers: Array<{
        providerId: string;
        snapshot: {
          provider: string;
          resources: Array<{ id: string; remainingPercent?: number }>;
        } | null;
      }>;
    };
    const codexCurrent = currentBody.providers.find((provider) => provider.providerId === 'codex');
    expect(codexCurrent).toMatchObject({ providerId: 'codex', snapshot: { provider: 'codex' } });
    expect(codexCurrent?.snapshot?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'codex-codex-primary', remainingPercent: 63 }),
        expect.objectContaining({ id: 'codex-codex-secondary', remainingPercent: 81 }),
      ]),
    );
    expect(history.statusCode).toBe(200);
    expect(history.json().snapshots).toHaveLength(1);
    expect(history.json().snapshots[0].provider).toBe('codex');
  });

  it('persists partial Gemini capacity and serves it from current and history APIs', async () => {
    const config = loadConfig(
      { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
      { defaultServiceName: 'sonoran-hub-api' },
    );
    const geminiSource: GeminiCapacitySource = {
      probe: async () => ({
        available: true,
        antigravityVersion: '1.1.22',
        planTier: 'Google AI Pro',
      }),
      readCapacity: async () => ({
        antigravityVersion: '1.1.22',
        planTier: 'Google AI Pro',
        quota: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.41,
                  reset_time: '2026-09-19T03:37:31Z',
                },
              ],
            },
          ],
        },
        creditsError: { code: 'provider_error', message: 'Credits unavailable' },
      }),
      close: async () => undefined,
    };
    runtime = createCapacityRuntime({
      environment: { CAPACITY_REFRESH_INTERVAL_MS: '300000' },
      config,
      geminiSource,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });
    await runtime.start();
    const app = buildApp(config, { capacityService: runtime.service });
    const current = await app.inject({ method: 'GET', url: '/capacity' });
    const history = await app.inject({ method: 'GET', url: '/capacity/history?provider=gemini' });
    await app.close();
    expect(current.statusCode).toBe(200);
    expect(
      current
        .json()
        .providers.find((provider: { providerId: string }) => provider.providerId === 'gemini'),
    ).toMatchObject({
      snapshot: {
        provider: 'gemini',
        error: { code: 'provider_error' },
        resources: [
          { id: 'gemini-gemini-models-gemini-weekly', remainingPercent: 41 },
          { id: 'gemini-g1-credits', status: 'unknown' },
        ],
      },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().snapshots[0].provider).toBe('gemini');
  });

  it('persists only semantic upgrade metadata, never the Antigravity upgrade URI', async () => {
    const config = loadConfig(
      { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
      { defaultServiceName: 'sonoran-hub-api' },
    );
    const geminiSource: GeminiCapacitySource = {
      probe: async () => ({ available: true, antigravityVersion: '1.1.22' }),
      readCapacity: async () => ({
        antigravityVersion: '1.1.22',
        credits: {
          remaining_credits: 10,
          upgrade_uri: 'https://example.invalid/upgrade?account_id=secret',
        },
      }),
      close: async () => undefined,
    };
    runtime = createCapacityRuntime({
      environment: { CAPACITY_REFRESH_INTERVAL_MS: '300000' },
      config,
      geminiSource,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });
    await runtime.start();
    const app = buildApp(config, { capacityService: runtime.service });
    const current = await app.inject({ method: 'GET', url: '/capacity' });
    const history = await app.inject({ method: 'GET', url: '/capacity/history?provider=gemini' });
    await app.close();
    const serialized = `${current.body}${history.body}`;
    expect(serialized).not.toContain('upgrade_uri');
    expect(serialized).not.toContain('account_id');
    expect(serialized).not.toContain('example.invalid');
    expect(
      current
        .json()
        .providers.find((provider: { providerId: string }) => provider.providerId === 'gemini'),
    ).toMatchObject({
      snapshot: {
        resources: [
          {
            id: 'gemini-g1-credits',
            remaining: 10,
            metadata: { upgrade_available: true },
          },
        ],
      },
    });
  });
});
