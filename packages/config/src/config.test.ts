import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig, parseConfig } from './config.js';

describe('shared configuration', () => {
  it('loads validated non-secret environment settings', () => {
    expect(
      loadConfig(
        {
          NODE_ENV: 'test',
          LOG_LEVEL: 'debug',
          SERVICE_NAME: 'sonoran-hub-api',
        },
        { defaultServiceName: 'fallback-service' },
      ),
    ).toEqual({
      runtimeEnvironment: 'test',
      logLevel: 'debug',
      serviceName: 'sonoran-hub-api',
    });
  });

  it('rejects invalid values without coercion', () => {
    expect(() =>
      parseConfig({
        runtimeEnvironment: 'prod',
        logLevel: 'verbose',
        serviceName: 'not a valid service',
      }),
    ).toThrow(ConfigurationError);
  });

  it('uses an application default service name when none is supplied', () => {
    expect(loadConfig({}, { defaultServiceName: 'sonoran-hub-agent' }).serviceName).toBe(
      'sonoran-hub-agent',
    );
  });
});
