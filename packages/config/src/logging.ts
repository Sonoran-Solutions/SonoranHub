import { z } from 'zod';

import { type LogLevel } from './config.js';

export const correlationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'correlation ID contains unsupported characters');

export type CorrelationId = z.infer<typeof correlationIdSchema>;

export interface LogContext {
  readonly correlationId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly correlationId?: CorrelationId;
  readonly metadata?: Record<string, unknown>;
}

export type LogSink = (record: StructuredLogRecord) => void;

export interface StructuredLogger {
  log(level: LogLevel, message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  trace(message: string, context?: LogContext): void;
}

const REDACTED = '[REDACTED]';
const sensitiveKeyPattern =
  /authorization|cookie|token|api[-_ ]?key|password|secret|credential|private[-_ ]?key/i;
const sensitiveAssignmentPattern =
  /\b(authorization|cookie|token|api[-_ ]?key|password|secret|credential)\s*[:=]\s*((?:Bearer\s+)?[^\s,;]+)/gi;
const bearerPattern = /\bBearer\s+[^\s,;]+/gi;
const levelPriority: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
  silent: Number.POSITIVE_INFINITY,
};

function redactString(value: string): string {
  return value
    .replace(bearerPattern, `Bearer ${REDACTED}`)
    .replace(sensitiveAssignmentPattern, '$1=' + REDACTED);
}

/** Redact known secret-shaped fields while preserving safe structured metadata. */
export function redactMetadata(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactMetadata(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactMetadata(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export function createCorrelationId(): CorrelationId {
  return globalThis.crypto.randomUUID();
}

export function parseCorrelationId(value: unknown): CorrelationId | undefined {
  const result = correlationIdSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export interface StructuredLoggerOptions {
  readonly serviceName: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
}

export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const level = options.level ?? 'info';
  const sink =
    options.sink ?? ((record: StructuredLogRecord) => console.log(JSON.stringify(record)));

  const log = (recordLevel: LogLevel, message: string, context?: LogContext): void => {
    if (levelPriority[recordLevel] > levelPriority[level]) {
      return;
    }

    const correlationId = context?.correlationId
      ? parseCorrelationId(context.correlationId)
      : undefined;
    const metadata = context?.metadata
      ? (redactMetadata(context.metadata) as Record<string, unknown>)
      : undefined;
    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level: recordLevel,
      service: options.serviceName,
      message,
      ...(correlationId ? { correlationId } : {}),
      ...(metadata ? { metadata } : {}),
    };

    sink(record);
  };

  return {
    log,
    fatal: (message, context) => log('fatal', message, context),
    error: (message, context) => log('error', message, context),
    warn: (message, context) => log('warn', message, context),
    info: (message, context) => log('info', message, context),
    debug: (message, context) => log('debug', message, context),
    trace: (message, context) => log('trace', message, context),
  };
}
