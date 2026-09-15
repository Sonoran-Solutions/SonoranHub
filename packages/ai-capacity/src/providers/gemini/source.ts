import { redactMetadata } from '@sonoran-hub/config';

import type { ProviderFailureCode } from '../../errors.js';
import {
  antigravityCreditsDataSchema,
  antigravityProcessEnvelopeSchema,
  antigravityQuotaDataSchema,
  type AntigravityCreditsData,
  type AntigravityQuotaData,
} from './protocol.js';
import {
  AntigravityCliError,
  AntigravityCliExecutor,
  type AntigravityCliExecutorOptions,
  type AntigravityProcessResult,
  type AntigravitySpawn,
} from './client.js';

export const GEMINI_PROTOCOL_SOURCE = 'official Antigravity CLI';
export const GEMINI_MINIMUM_AGY_VERSION = '1.1.11';

export interface GeminiSourceFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

export interface GeminiSourceAvailability {
  readonly available: boolean;
  readonly antigravityVersion?: string;
  readonly planTier?: string;
  readonly reason?: string;
  readonly failure?: GeminiSourceFailure;
}

export interface GeminiCapacitySnapshot {
  readonly antigravityVersion: string;
  readonly planTier?: string;
  readonly quota?: AntigravityQuotaData;
  readonly credits?: AntigravityCreditsData;
  readonly quotaError?: GeminiSourceFailure;
  readonly creditsError?: GeminiSourceFailure;
}

export interface GeminiCapacitySource {
  probe(): Promise<GeminiSourceAvailability>;
  readCapacity(): Promise<GeminiCapacitySnapshot>;
  close(): Promise<void>;
}

export interface AntigravityCliSourceOptions {
  readonly executable?: string;
  readonly commandTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawnProcess?: AntigravitySpawn;
  readonly onDiagnostic?: (message: string) => void;
}

class GeminiSourceError extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiSourceError';
  }
}

interface ParsedCommand<T> {
  readonly data: T;
  readonly planTier?: string;
}

interface VersionInfo {
  readonly version: string;
}

function configuredExecutable(value: string | undefined): string {
  return value?.trim() || process.env.AGY_BIN?.trim() || 'agy';
}

function failureFrom(error: unknown, fallback: string): GeminiSourceError {
  if (error instanceof GeminiSourceError) return error;
  if (error instanceof AntigravityCliError) {
    return new GeminiSourceError(error.code, error.message);
  }
  return new GeminiSourceError('provider_error', fallback);
}

function extractVersion(output: string): string | undefined {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/)?.[0];
}

function versionParts(version: string): number[] {
  const base = version.split('-')[0]?.split('+')[0] ?? '0';
  return base.split('.').map((part) => Number(part));
}

function supportsReadOnlyCommands(version: string): boolean {
  const actual = versionParts(version);
  const minimum = versionParts(GEMINI_MINIMUM_AGY_VERSION);
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function safeStatus(result: AntigravityProcessResult): string {
  return result.exitCode === null ? 'unknown' : String(result.exitCode);
}

function parseJsonEnvelope(result: AntigravityProcessResult, command: string) {
  if (result.timedOut) {
    throw new GeminiSourceError('timeout', `Antigravity CLI command timed out: ${command}`);
  }
  if (result.stdoutTruncated) {
    throw new GeminiSourceError(
      'invalid_response',
      'Antigravity CLI output exceeded the safety limit',
    );
  }
  const text = result.stdout.trim();
  if (!text) {
    throw new GeminiSourceError(
      'invalid_response',
      `Antigravity CLI returned empty output for ${command}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is unknown => candidate !== undefined);
    if (candidates.length !== 1) {
      throw new GeminiSourceError(
        'invalid_response',
        `Antigravity CLI returned invalid JSON for ${command}`,
      );
    }
    value = candidates[0];
  }

  const envelope = antigravityProcessEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new GeminiSourceError(
      'invalid_response',
      'Antigravity CLI returned an invalid response envelope',
    );
  }
  if (envelope.data.status !== 'SUCCESS') {
    const response = envelope.data.response?.toLowerCase() ?? '';
    const code: ProviderFailureCode = /(auth|sign in|login|session)/.test(response)
      ? 'authentication'
      : 'provider_error';
    throw new GeminiSourceError(
      code,
      code === 'authentication'
        ? 'Antigravity CLI is not authenticated'
        : `Antigravity CLI rejected ${command} (exit ${safeStatus(result)})`,
    );
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new GeminiSourceError('provider_error', `Antigravity CLI command failed for ${command}`);
  }
  // This is the critical quota-burn guard. A normal model response is never
  // interpreted as capacity, even if it happens to contain quota-like prose.
  if (envelope.data.num_turns !== 0 || envelope.data.command === undefined) {
    throw new GeminiSourceError(
      'invalid_response',
      `Installed Antigravity version did not execute ${command} as a read-only command`,
    );
  }
  const usage = envelope.data.usage;
  const consumedModelTokens = [
    usage?.input_tokens,
    usage?.output_tokens,
    usage?.thinking_tokens,
    usage?.total_tokens,
  ].some((value) => value !== undefined && value > 0);
  if (consumedModelTokens) {
    throw new GeminiSourceError(
      'invalid_response',
      `Installed Antigravity version consumed model usage while executing ${command} as a read-only command`,
    );
  }
  return envelope.data;
}

function commandData<T>(
  result: AntigravityProcessResult,
  command: string,
  expectedNames: readonly string[],
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): ParsedCommand<T> {
  const envelope = parseJsonEnvelope(result, command);
  const commandName = envelope.command?.name.toLowerCase();
  if (!commandName || !expectedNames.includes(commandName)) {
    throw new GeminiSourceError(
      'invalid_response',
      `Antigravity CLI returned unexpected data for ${command}`,
    );
  }
  const parsed = schema.safeParse(envelope.command?.data);
  if (!parsed.success || parsed.data === undefined) {
    throw new GeminiSourceError(
      'invalid_response',
      `Antigravity CLI returned invalid data for ${command}`,
    );
  }
  const data = parsed.data as T;
  const record = data as T & Record<string, unknown>;
  const planTier = [record.plan, record.plan_name, record.tier].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return { data, ...(planTier ? { planTier: planTier.slice(0, 100) } : {}) };
}

function versionError(error: unknown): GeminiSourceError {
  return failureFrom(error, 'Antigravity CLI version could not be detected');
}

export class AntigravityCliSource implements GeminiCapacitySource {
  private readonly executable: string;
  private readonly executor: AntigravityCliExecutor;
  private cachedVersion: string | undefined;
  private cachedPlanTier: string | undefined;
  private probedQuota: ParsedCommand<AntigravityQuotaData> | undefined;
  private readonly readOnlyCommands = new Set<string>();

  constructor(options: AntigravityCliSourceOptions = {}) {
    this.executable = configuredExecutable(options.executable);
    this.executor = new AntigravityCliExecutor({
      ...options,
      executable: this.executable,
    } satisfies AntigravityCliExecutorOptions);
  }

  async probe(): Promise<GeminiSourceAvailability> {
    try {
      const versionInfo = await this.readVersion();
      if (!supportsReadOnlyCommands(versionInfo.version)) {
        throw new GeminiSourceError(
          'unavailable',
          `Gemini collector unavailable: Antigravity CLI must be upgraded to a version supporting structured read-only quota output (minimum ${GEMINI_MINIMUM_AGY_VERSION})`,
        );
      }
      const quota = await this.readQuota();
      this.probedQuota = quota;
      this.cachedPlanTier = quota.planTier ?? this.cachedPlanTier;
      return {
        available: true,
        antigravityVersion: versionInfo.version,
        ...(this.cachedPlanTier ? { planTier: this.cachedPlanTier } : {}),
      };
    } catch (error) {
      const failure = versionError(error);
      return {
        available: false,
        ...(this.cachedVersion ? { antigravityVersion: this.cachedVersion } : {}),
        ...(this.cachedPlanTier ? { planTier: this.cachedPlanTier } : {}),
        reason: failure.message,
        failure: { code: failure.code, message: failure.message },
      };
    }
  }

  async readCapacity(): Promise<GeminiCapacitySnapshot> {
    const version = this.cachedVersion ?? (await this.readVersion()).version;
    if (!supportsReadOnlyCommands(version)) {
      throw new GeminiSourceError(
        'unavailable',
        `Antigravity CLI must be upgraded to a version supporting structured read-only quota output (minimum ${GEMINI_MINIMUM_AGY_VERSION})`,
      );
    }

    this.readOnlyCommands.clear();
    let quota: AntigravityQuotaData | undefined;
    let quotaError: GeminiSourceFailure | undefined;
    const probedQuota = this.probedQuota;
    this.probedQuota = undefined;
    try {
      quota = (probedQuota ?? (await this.readQuota())).data;
      if (probedQuota) this.readOnlyCommands.add('/quota');
      this.cachedPlanTier = probedQuota?.planTier ?? this.cachedPlanTier;
    } catch (error) {
      const failure = failureFrom(error, 'Antigravity quota could not be read');
      quotaError = { code: failure.code, message: failure.message };
    }

    let credits: AntigravityCreditsData | undefined;
    let creditsError: GeminiSourceFailure | undefined;
    try {
      credits = (await this.readCredits()).data;
    } catch (error) {
      const failure = failureFrom(error, 'Antigravity credits could not be read');
      creditsError = { code: failure.code, message: failure.message };
    }

    return {
      antigravityVersion: version,
      ...(this.cachedPlanTier ? { planTier: this.cachedPlanTier } : {}),
      ...(quota ? { quota } : {}),
      ...(credits ? { credits } : {}),
      ...(quotaError ? { quotaError } : {}),
      ...(creditsError ? { creditsError } : {}),
    };
  }

  async close(): Promise<void> {
    this.probedQuota = undefined;
    this.readOnlyCommands.clear();
    await this.executor.close();
  }

  /** True only for commands whose structured envelope passed the zero-turn guard. */
  get lastReadOnlyCommands(): readonly string[] {
    return [...this.readOnlyCommands];
  }

  private async readVersion(): Promise<VersionInfo> {
    const result = await this.executor.run(['--version']);
    if (result.timedOut) {
      throw new GeminiSourceError('timeout', 'Antigravity CLI version command timed out');
    }
    const version = extractVersion(result.stdout);
    if (result.exitCode !== 0 || !version) {
      throw new GeminiSourceError(
        'unavailable',
        'Antigravity CLI is not installed or its version is unavailable',
      );
    }
    this.cachedVersion = version;
    return { version };
  }

  private async readQuota(): Promise<ParsedCommand<AntigravityQuotaData>> {
    const result = await this.executor.run(['-p', '/quota', '--output-format', 'json']);
    const parsed = commandData(result, '/quota', ['quota', 'usage'], antigravityQuotaDataSchema);
    this.readOnlyCommands.add('/quota');
    return parsed;
  }

  private async readCredits(): Promise<ParsedCommand<AntigravityCreditsData>> {
    const result = await this.executor.run(['-p', '/credits', '--output-format', 'json']);
    const parsed = commandData(result, '/credits', ['credits'], antigravityCreditsDataSchema);
    this.readOnlyCommands.add('/credits');
    return parsed;
  }
}

export function sanitizeGeminiDiagnostic(message: string): string {
  const redacted = redactMetadata(message);
  return typeof redacted === 'string' ? redacted.replace(/\s+/g, ' ').slice(0, 500) : '';
}
