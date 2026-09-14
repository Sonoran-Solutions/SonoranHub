import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCorrelationId } from '@sonoran-hub/config';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns structured healthy status with a generated request ID', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const requestId = response.headers['x-request-id'];

    expect(response.statusCode).toBe(200);
    expect(requestId).toEqual(expect.any(String));
    expect(parseCorrelationId(requestId)).toBe(requestId);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });

  it('preserves a valid incoming request ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-request-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('test-request-123');
  });

  it('replaces an invalid incoming request ID with a safe generated ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'unsafe request id with spaces' },
    });
    const requestId = response.headers['x-request-id'];

    expect(response.statusCode).toBe(200);
    expect(requestId).not.toBe('unsafe request id with spaces');
    expect(parseCorrelationId(requestId)).toBe(requestId);
  });
});
