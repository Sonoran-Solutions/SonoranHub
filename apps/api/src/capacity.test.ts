import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, createStructuredLogger } from '@sonoran-hub/config';
import { buildApp } from './app.js';
import type { CodexCapacitySource } from '@sonoran-hub/ai-capacity';

import { createCapacityRuntime, type CapacityRuntime } from './capacity.js';

describe('API Capacity runtime', () => {
  let runtime: CapacityRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it('bootstraps both providers without credentials and retains public DeepSeek pricing', async () => {
    const config = loadConfig(
      { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'sonoran-hub-api' },
      { defaultServiceName: 'sonoran-hub-api' },
    );
    runtime = createCapacityRuntime({
      environment: {
        CAPACITY_REFRESH_INTERVAL_MS: '300000',
        CODEX_BIN: '/definitely-missing-sonoran-hub-codex-test-binary',
      },
      config,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });

    await runtime.start();
    const snapshots = await runtime.service.latest();

    expect(runtime.service.listProviderIds()).toEqual(['codex', 'deepseek', 'openrouter']);
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
      environment: { CAPACITY_REFRESH_INTERVAL_MS: '300000' },
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
});
