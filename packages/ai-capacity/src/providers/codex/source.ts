import { redactMetadata } from '@sonoran-hub/config';

import type { ProviderFailureCode } from '../../errors.js';
import {
  codexAccountResponseSchema,
  codexInitializeResponseSchema,
  codexRateLimitsResponseSchema,
  type CodexAccountResponse,
  type CodexInitializeResponse,
  type CodexPlanType,
  type CodexRateLimitsResponse,
} from './protocol.js';
import {
  CodexAppServerClient,
  CodexAppServerClientError,
  type CodexAppServerClientOptions,
  type CodexSpawn,
} from './client.js';

export const CODEX_PROTOCOL_SOURCE = 'official app-server';

export interface CodexSourceAvailability {
  readonly available: boolean;
  readonly planType?: CodexPlanType;
  readonly codexVersion?: string;
  readonly reason?: string;
  readonly failure?: {
    readonly code: ProviderFailureCode;
    readonly message: string;
  };
}

/**
 * This boundary deliberately returns official structured data, not a TUI
 * rendering. A future Agent-side source can implement the same interface.
 */
export interface CodexRateLimitSnapshot {
  readonly response: CodexRateLimitsResponse;
  readonly planType?: CodexPlanType;
  readonly codexVersion?: string;
}

export interface CodexCapacitySource {
  probe(): Promise<CodexSourceAvailability>;
  readCapacity(): Promise<CodexRateLimitSnapshot>;
  close(): Promise<void>;
}

export interface CodexAppServerSourceOptions {
  readonly executable?: string;
  readonly hubVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawnProcess?: CodexSpawn;
  /** Called with a redacted, bounded stderr line for diagnostic logging. */
  readonly onDiagnostic?: (message: string) => void;
}

class CodexSourceError extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexSourceError';
  }
}

const DEFAULT_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_HUB_VERSION = '0.1.0';

function configuredExecutable(value: string | undefined): string {
  return value?.trim() || process.env.CODEX_BIN?.trim() || 'codex';
}

function positiveTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return value;
}

function extractVersion(userAgent: string): string | undefined {
  const match = userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/);
  return match?.[0];
}

function sourceFailure(error: unknown, fallback: string): CodexSourceError {
  if (error instanceof CodexSourceError) {
    return error;
  }
  if (error instanceof CodexAppServerClientError) {
    return new CodexSourceError(error.code, error.message);
  }
  return new CodexSourceError('provider_error', fallback);
}

function accountUnavailable(response: CodexAccountResponse): CodexSourceError {
  if (response.account === null || response.account === undefined) {
    return new CodexSourceError(
      response.requiresOpenaiAuth ? 'authentication' : 'unavailable',
      response.requiresOpenaiAuth
        ? 'Codex ChatGPT authentication is not available'
        : 'Codex does not have an authenticated ChatGPT account',
    );
  }
  if (response.account.type === 'apiKey') {
    return new CodexSourceError(
      'unavailable',
      'Codex is using API-key authentication; ChatGPT subscription quota is unavailable',
    );
  }
  if (response.account.type === 'amazonBedrock') {
    return new CodexSourceError(
      'unavailable',
      'Codex is using an unsupported non-ChatGPT provider mode',
    );
  }
  return new CodexSourceError('unavailable', 'Codex ChatGPT account is unavailable');
}

export class CodexAppServerSource implements CodexCapacitySource {
  private readonly executable: string;
  private readonly hubVersion: string;
  private readonly startupTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly spawnProcess: CodexSpawn | undefined;
  private readonly onDiagnostic: (message: string) => void;
  private client: CodexAppServerClient | undefined;
  private initialization:
    | Promise<{
        client: CodexAppServerClient;
        response: CodexInitializeResponse;
      }>
    | undefined;
  private cleanup: Promise<void> | undefined;
  private lifecycle = 0;
  private account: CodexAccountResponse | undefined;

  constructor(options: CodexAppServerSourceOptions = {}) {
    this.executable = configuredExecutable(options.executable);
    this.hubVersion = options.hubVersion?.trim() || DEFAULT_HUB_VERSION;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.initializeTimeoutMs =
      options.initializeTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    positiveTimeout('startupTimeoutMs', this.startupTimeoutMs);
    positiveTimeout('initializeTimeoutMs', this.initializeTimeoutMs);
    positiveTimeout('requestTimeoutMs', this.requestTimeoutMs);
    positiveTimeout('shutdownTimeoutMs', this.shutdownTimeoutMs);
    this.spawnProcess = options.spawnProcess;
    this.onDiagnostic = (message) => {
      const redacted = redactMetadata(message);
      if (typeof redacted === 'string') {
        options.onDiagnostic?.(redacted.slice(0, 500));
      }
    };
  }

  async probe(): Promise<CodexSourceAvailability> {
    try {
      const ready = await this.ready();
      const account = await this.readAccount(ready.client);
      if (account.account?.type === 'chatgpt') {
        return {
          available: true,
          planType: account.account.planType,
          codexVersion: extractVersion(ready.response.userAgent),
        };
      }
      throw accountUnavailable(account);
    } catch (error) {
      const failure = sourceFailure(error, 'Codex account probe failed');
      return {
        available: false,
        reason: failure.message,
        failure: { code: failure.code, message: failure.message },
      };
    }
  }

  async readCapacity(): Promise<CodexRateLimitSnapshot> {
    const ready = await this.ready();
    const account = this.account ?? (await this.readAccount(ready.client));
    if (account.account?.type !== 'chatgpt') {
      throw accountUnavailable(account);
    }

    let payload: unknown;
    try {
      payload = await ready.client.request('account/rateLimits/read', {
        // The count remains authoritative while opaque reset-credit details
        // stay local and are not needed by this read-only dashboard.
        excludeResetCreditDetails: true,
      });
    } catch (error) {
      throw sourceFailure(error, 'Codex rate-limit request failed');
    }
    const parsed = codexRateLimitsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CodexSourceError(
        'invalid_response',
        'Codex returned an invalid rate-limit response',
      );
    }
    return {
      response: parsed.data,
      planType: account.account.planType,
      codexVersion: extractVersion(ready.response.userAgent),
    };
  }

  async close(): Promise<void> {
    this.lifecycle += 1;
    const client = this.client;
    const cleanup = this.cleanup;
    this.client = undefined;
    this.account = undefined;
    this.readyRecord = undefined;
    this.initialization = undefined;
    await Promise.all([client?.close(), cleanup]);
  }

  private async readAccount(client: CodexAppServerClient): Promise<CodexAccountResponse> {
    let payload: unknown;
    try {
      payload = await client.request('account/read', { refreshToken: false });
    } catch (error) {
      throw sourceFailure(error, 'Codex account request failed');
    }
    const parsed = codexAccountResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CodexSourceError('invalid_response', 'Codex returned an invalid account response');
    }
    this.account = parsed.data;
    return parsed.data;
  }

  private async ready(): Promise<{
    client: CodexAppServerClient;
    response: CodexInitializeResponse;
  }> {
    if (
      this.client &&
      !this.client.isClosed &&
      this.initialization === undefined &&
      this.readyRecord?.client === this.client
    ) {
      // The client has already completed the handshake. The initialization
      // result is kept by the promise below only while the handshake runs, so
      // a small immutable record is sufficient for later calls.
      return this.readyRecord;
    }

    if (this.initialization) {
      return this.initialization;
    }

    const cleanup = this.retireClosedClient();
    const initialization = this.initializeAfterCleanup(cleanup, this.lifecycle);
    this.initialization = initialization;
    try {
      return await initialization;
    } catch (error) {
      throw sourceFailure(error, 'Codex app-server initialization failed');
    } finally {
      this.initialization = undefined;
    }
  }

  private retireClosedClient(): Promise<void> | undefined {
    if (!this.client?.isClosed) {
      return this.cleanup;
    }
    const client = this.client;
    this.client = undefined;
    this.account = undefined;
    this.readyRecord = undefined;
    this.cleanup = client.close();
    return this.cleanup;
  }

  private async initializeAfterCleanup(
    cleanup: Promise<void> | undefined,
    lifecycle: number,
  ): Promise<{
    client: CodexAppServerClient;
    response: CodexInitializeResponse;
  }> {
    await cleanup;
    if (this.cleanup === cleanup) {
      this.cleanup = undefined;
    }
    if (lifecycle !== this.lifecycle) {
      throw new CodexSourceError('unavailable', 'Codex app-server source was closed');
    }

    const client = new CodexAppServerClient({
      executable: this.executable,
      startupTimeoutMs: this.startupTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      spawnProcess: this.spawnProcess,
      onStderr: this.onDiagnostic,
      onNotification: (method) => {
        // `account/rateLimits/updated` is a sparse update. The source keeps
        // polling as the single refresh path for now and deliberately does not
        // treat this notification as a response to any request.
        if (method === 'account/rateLimits/updated') {
          return;
        }
      },
    } satisfies CodexAppServerClientOptions);
    this.client = client;
    try {
      return await this.initializeClient(client);
    } catch (error) {
      await client.close();
      if (this.client === client) {
        this.client = undefined;
        this.account = undefined;
        this.readyRecord = undefined;
      }
      throw sourceFailure(error, 'Codex app-server initialization failed');
    }
  }

  private readyRecord:
    | {
        client: CodexAppServerClient;
        response: CodexInitializeResponse;
      }
    | undefined;

  private async initializeClient(client: CodexAppServerClient): Promise<{
    client: CodexAppServerClient;
    response: CodexInitializeResponse;
  }> {
    let payload: unknown;
    try {
      payload = await client.request(
        'initialize',
        {
          clientInfo: {
            name: 'sonoran-hub',
            title: 'Sonoran Hub',
            version: this.hubVersion,
          },
        },
        this.initializeTimeoutMs,
      );
    } catch (error) {
      throw sourceFailure(error, 'Codex app-server initialize request failed');
    }
    const parsed = codexInitializeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CodexSourceError(
        'invalid_response',
        'Codex returned an invalid initialize response',
      );
    }
    try {
      await client.notify('initialized');
    } catch (error) {
      throw sourceFailure(error, 'Codex app-server initialized notification failed');
    }
    const result = { client, response: parsed.data };
    this.readyRecord = result;
    return result;
  }
}

export { CodexSourceError };
