import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderFailureCode } from '../../errors.js';

export type CodexClientErrorCode = Extract<
  ProviderFailureCode,
  'unavailable' | 'timeout' | 'invalid_response' | 'provider_error'
>;

export class CodexAppServerClientError extends Error {
  constructor(
    readonly code: CodexClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexAppServerClientError';
  }
}

/** The small child-process surface used by the real client and protocol tests. */
export interface CodexChildProcess {
  readonly stdin: {
    write(data: string): boolean;
    end(): void;
  };
  readonly stdout: {
    on(event: 'data' | 'error', listener: (...args: unknown[]) => void): unknown;
  };
  readonly stderr: {
    on(event: 'data' | 'error', listener: (...args: unknown[]) => void): unknown;
  };
  once(event: 'spawn' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexSpawn = (executable: string, args: readonly string[]) => CodexChildProcess;

export const spawnCodexProcess: CodexSpawn = (executable, args) =>
  spawn(executable, [...args], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

export interface CodexAppServerClientOptions {
  readonly executable: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly spawnProcess?: CodexSpawn;
  readonly onStderr?: (message: string) => void;
  readonly onNotification?: (method: string, params: unknown) => void;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type JsonRpcId = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return value;
}

export class CodexAppServerClient {
  private readonly executable: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly spawnProcess: CodexSpawn;
  private readonly onStderr: (message: string) => void;
  private readonly onNotification: (method: string, params: unknown) => void;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextRequestId = 1;
  private child: CodexChildProcess | undefined;
  private lineBuffer = '';
  private spawned = false;
  private processExited = true;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private exitPromise: Promise<void> | undefined;
  private resolveExit: (() => void) | undefined;
  private spawnReadyPromise: Promise<void> | undefined;
  private resolveSpawnReady: (() => void) | undefined;
  private rejectSpawnReady: ((error: unknown) => void) | undefined;

  constructor(options: CodexAppServerClientOptions) {
    this.executable = options.executable;
    this.startupTimeoutMs = positiveTimeout('startupTimeoutMs', options.startupTimeoutMs);
    this.requestTimeoutMs = positiveTimeout('requestTimeoutMs', options.requestTimeoutMs);
    this.shutdownTimeoutMs = positiveTimeout('shutdownTimeoutMs', options.shutdownTimeoutMs);
    this.spawnProcess = options.spawnProcess ?? spawnCodexProcess;
    this.onStderr = options.onStderr ?? (() => undefined);
    this.onNotification = options.onNotification ?? (() => undefined);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    if (this.child) {
      if (this.closed) {
        throw new CodexAppServerClientError('unavailable', 'Codex app-server is closed');
      }
      if (!this.spawned) {
        await this.waitForSpawn();
      }
      return;
    }

    let child: CodexChildProcess;
    try {
      child = this.spawnProcess(this.executable, ['app-server']);
    } catch {
      throw new CodexAppServerClientError('unavailable', 'Codex executable could not be started');
    }

    this.child = child;
    this.processExited = false;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.spawnReadyPromise = new Promise<void>((resolve, reject) => {
      this.resolveSpawnReady = resolve;
      this.rejectSpawnReady = reject;
    });
    child.stdout.on('data', (data: unknown) => this.handleStdout(data));
    child.stdout.on('error', () => {
      this.fail(new CodexAppServerClientError('provider_error', 'Codex app-server stdout failed'));
    });
    child.stderr.on('data', (data: unknown) => this.handleStderr(data));
    child.stderr.on('error', () => undefined);
    child.once('spawn', () => {
      this.spawned = true;
      this.resolveSpawnReady?.();
      this.resolveSpawnReady = undefined;
      this.rejectSpawnReady = undefined;
    });
    child.once('error', () => {
      const failure = new CodexAppServerClientError(
        this.spawned ? 'provider_error' : 'unavailable',
        this.spawned ? 'Codex app-server process failed' : 'Codex executable could not be started',
      );
      if (!this.spawned) {
        // Node reports ENOENT and similar spawn failures through `error`; no
        // running child exists to wait for or signal in that case.
        this.processExited = true;
        this.resolveExit?.();
        this.resolveExit = undefined;
      }
      this.rejectSpawnReady?.(failure);
      this.resolveSpawnReady = undefined;
      this.rejectSpawnReady = undefined;
      this.fail(failure);
    });
    child.once('exit', () => {
      if (!this.spawned) {
        this.rejectSpawnReady?.(
          new CodexAppServerClientError('unavailable', 'Codex app-server exited on startup'),
        );
        this.resolveSpawnReady = undefined;
        this.rejectSpawnReady = undefined;
      }
      this.spawned = false;
      this.processExited = true;
      this.closed = true;
      this.rejectPending(
        new CodexAppServerClientError(
          'provider_error',
          'Codex app-server exited before completing the request',
        ),
      );
      this.resolveExit?.();
      this.resolveExit = undefined;
    });

    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((_, reject) => {
      startupTimer = setTimeout(() => {
        reject(new CodexAppServerClientError('timeout', 'Codex app-server startup timed out'));
      }, this.startupTimeoutMs);
      startupTimer.unref?.();
    });
    void deadline.catch(() => undefined);
    try {
      await Promise.race([this.waitForSpawn(), deadline]);
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
      }
    }
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.start();
    if (this.closed || !this.child) {
      throw new CodexAppServerClientError('unavailable', 'Codex app-server is unavailable');
    }
    positiveTimeout('requestTimeoutMs', timeoutMs);

    const id = `sonoran-hub-${this.nextRequestId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        const error = new CodexAppServerClientError(
          'timeout',
          `Codex app-server request timed out: ${method}`,
        );
        reject(error);
        this.fail(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      try {
        this.child?.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        const error = new CodexAppServerClientError(
          'provider_error',
          `Codex app-server request could not be sent: ${method}`,
        );
        reject(error);
        this.fail(error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    if (this.closed || !this.child) {
      throw new CodexAppServerClientError('unavailable', 'Codex app-server is unavailable');
    }
    const message = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    };
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      const error = new CodexAppServerClientError(
        'provider_error',
        `Codex app-server notification could not be sent: ${method}`,
      );
      this.fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    if (!this.spawned) {
      this.rejectSpawnReady?.(
        new CodexAppServerClientError('unavailable', 'Codex app-server stopped during startup'),
      );
      this.resolveSpawnReady = undefined;
      this.rejectSpawnReady = undefined;
    }
    this.rejectPending(new CodexAppServerClientError('unavailable', 'Codex app-server stopped'));
    const child = this.child;
    if (!child) {
      this.resolveExit?.();
      return;
    }

    try {
      child.stdin.end();
    } catch {
      // The process may already have closed its input pipe.
    }
    await this.waitForExit(this.shutdownTimeoutMs);
    if (!this.processExited) {
      child.kill('SIGTERM');
      await this.waitForExit(this.shutdownTimeoutMs);
    }
    if (!this.processExited) {
      child.kill('SIGKILL');
      await this.waitForExit(this.shutdownTimeoutMs);
    }
  }

  private waitForSpawn(): Promise<void> {
    if (this.spawned) {
      return Promise.resolve();
    }
    if (this.closed) {
      return Promise.reject(
        new CodexAppServerClientError('unavailable', 'Codex app-server exited on startup'),
      );
    }
    return (
      this.spawnReadyPromise ??
      Promise.reject(
        new CodexAppServerClientError('unavailable', 'Codex app-server is unavailable'),
      )
    );
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.processExited) {
      return;
    }
    const exit = this.exitPromise ?? Promise.resolve();
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private handleStdout(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.lineBuffer += typeof data === 'string' ? data : String(data);
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.handleLine(trimmed);
      }
    }
  }

  private handleStderr(data: unknown): void {
    const message = (typeof data === 'string' ? data : String(data))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (message) {
      this.onStderr(message);
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new CodexAppServerClientError('invalid_response', 'Codex app-server sent malformed JSON'),
      );
      return;
    }

    if (!isRecord(message)) {
      this.fail(
        new CodexAppServerClientError(
          'invalid_response',
          'Codex app-server sent an invalid message',
        ),
      );
      return;
    }

    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (hasId && (hasResult || hasError)) {
      this.handleResponse(message.id as JsonRpcId, message, hasResult, hasError);
      return;
    }

    if (typeof message.method === 'string' && !hasId) {
      this.onNotification(message.method, message.params);
      return;
    }

    this.fail(
      new CodexAppServerClientError(
        'invalid_response',
        'Codex app-server sent an invalid response',
      ),
    );
  }

  private handleResponse(
    id: JsonRpcId,
    message: Record<string, unknown>,
    hasResult: boolean,
    hasError: boolean,
  ): void {
    const pending = this.pending.get(id);
    if (!pending || (hasResult && hasError)) {
      this.fail(
        new CodexAppServerClientError(
          'invalid_response',
          'Codex app-server returned an unexpected response',
        ),
      );
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (hasError) {
      pending.reject(
        new CodexAppServerClientError('provider_error', 'Codex app-server returned an RPC error'),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: CodexAppServerClientError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(error);
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // There is no useful recovery action if the child is already gone.
    }
  }

  private rejectPending(error: CodexAppServerClientError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
