import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, createStructuredLogger } from '@sonoran-hub/config';

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
      environment: { CAPACITY_REFRESH_INTERVAL_MS: '300000' },
      config,
      logger: createStructuredLogger({ serviceName: config.serviceName, level: 'silent' }),
    });

    await runtime.start();
    const snapshots = await runtime.service.latest();

    expect(runtime.service.listProviderIds()).toEqual(['deepseek', 'openrouter']);
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
  });
});
