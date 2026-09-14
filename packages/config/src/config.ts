import { z } from 'zod';

export const runtimeEnvironmentSchema = z.enum(['development', 'test', 'production']);
export const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);
export const serviceNameSchema = z
  .string()
  .min(1, 'service name must not be empty')
  .max(100, 'service name must be 100 characters or fewer')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'service name must use letters, numbers, dots, underscores, or hyphens',
  );

export const appConfigSchema = z
  .object({
    runtimeEnvironment: runtimeEnvironmentSchema,
    logLevel: logLevelSchema,
    serviceName: serviceNameSchema,
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export class ConfigurationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    const details = issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; ');
    super(`Invalid configuration: ${details}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function parseConfig(input: unknown): AppConfig {
  const result = appConfigSchema.safeParse(input);

  if (!result.success) {
    throw new ConfigurationError(result.error.issues);
  }

  return result.data;
}

export interface EnvironmentInput {
  readonly NODE_ENV?: string;
  readonly LOG_LEVEL?: string;
  readonly SERVICE_NAME?: string;
}

export interface LoadConfigOptions {
  readonly defaultServiceName: string;
}

/**
 * Read only the shared, non-secret environment settings. Values are validated as-is;
 * malformed values are rejected instead of being coerced into a nearby value.
 */
export function loadConfig(environment: EnvironmentInput, options: LoadConfigOptions): AppConfig {
  return parseConfig({
    runtimeEnvironment: environment.NODE_ENV ?? 'development',
    logLevel: environment.LOG_LEVEL ?? 'info',
    serviceName: environment.SERVICE_NAME ?? options.defaultServiceName,
  });
}
