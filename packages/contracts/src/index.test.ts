import { describe, expect, it } from 'vitest';

import { serviceHealthSchema } from './index.js';

describe('serviceHealthSchema', () => {
  it('accepts the shared health response shape', () => {
    expect(serviceHealthSchema.parse({ status: 'ok', service: 'sonoran-hub-api' })).toEqual({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });
});
