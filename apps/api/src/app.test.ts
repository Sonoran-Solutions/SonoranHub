import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  const app = buildApp();

  afterEach(async () => {
    await app.close();
  });

  it('returns structured healthy status', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });
});
