import { describe, expect, it } from 'vitest';

import { createStructuredLogger, redactMetadata, type StructuredLogRecord } from './logging.js';

describe('structured logging', () => {
  it('emits structured records with service and correlation context', () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      serviceName: 'sonoran-hub-api',
      sink: (record) => records.push(record),
    });

    logger.info('request completed', {
      correlationId: 'request-123',
      metadata: { route: '/health', statusCode: 200 },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      service: 'sonoran-hub-api',
      message: 'request completed',
      correlationId: 'request-123',
      metadata: { route: '/health', statusCode: 200 },
    });
    expect(records[0]?.timestamp).toEqual(expect.any(String));
  });

  it('redacts sensitive keys and common bearer/assignment values', () => {
    expect(
      redactMetadata({
        authorization: 'Bearer secret-token',
        nested: {
          apiKey: 'abc123',
          note: 'Authorization: Bearer another-token',
        },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        note: 'Authorization=[REDACTED]',
      },
    });
  });

  it('does not emit records below the configured level', () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      serviceName: 'sonoran-hub-api',
      level: 'warn',
      sink: (record) => records.push(record),
    });

    logger.fatal('emitted');
    logger.error('emitted');
    logger.warn('emitted');
    logger.info('not emitted');
    logger.debug('not emitted');
    logger.trace('not emitted');

    expect(records.map((record) => record.message)).toEqual(['emitted', 'emitted', 'emitted']);
  });

  it('emits no records at all when configured as silent', () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      serviceName: 'sonoran-hub-api',
      level: 'silent',
      sink: (record) => records.push(record),
    });

    logger.fatal('not emitted');
    logger.error('not emitted');
    logger.warn('not emitted');
    logger.info('not emitted');
    logger.debug('not emitted');
    logger.trace('not emitted');

    expect(records).toEqual([]);
  });
});
