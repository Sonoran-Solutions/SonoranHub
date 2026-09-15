import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';

import { redactMetadata } from '@sonoran-hub/config';

import type { ProviderFailureCode } from '../../errors.js';

export interface AntigravityChildProcess {
  readonly stdout: { on(event: 'data' | 'error', listener: (...args: unknown[]) => void): unknown };
  readonly stderr: { on(event: 'data' | 'error', listener: (...args: unknown[]) => void): unknown };
  once(event: 'spawn' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AntigravitySpawn = (
  executable: string,
  args: readonly string[],
) => AntigravityChildProcess;

export const spawnAntigravityProcess: AntigravitySpawn = (executable, args) =>
  spawn(executable, [...args], {
    shell: false,
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

export interface AntigravityCliExecutorOptions {
  readonly executable: string;
  readonly commandTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawnProcess?: AntigravitySpawn;
  readonly onDiagnostic?: (message: string) => void;
}

export interface AntigravityProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
}

export class AntigravityCliError extends Error {
  constructor(
    readonly code: Extract<ProviderFailureCode, 'unavailable' | 'timeout' | 'provider_error'>,
    message: string,
  ) {
    super(message);
    this.name = 'AntigravityCliError';
  }
}

interface ActiveRun {
  readonly child: AntigravityChildProcess;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  finish: (result: AntigravityProcessResult) => void;
  finished: boolean;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  escalationTimer?: ReturnType<typeof setTimeout>;
  forceTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  return value;
}

function boundedBytes(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export class AntigravityCliExecutor {
  private readonly executable: string;
  private readonly commandTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly spawnProcess: AntigravitySpawn;
  private readonly onDiagnostic: (message: string) => void;
  private readonly active = new Set<ActiveRun>();
  private closed = false;

  constructor(options: AntigravityCliExecutorOptions) {
    this.executable = options.executable.trim() || 'agy';
    this.commandTimeoutMs = positive(
      'commandTimeoutMs',
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
    this.shutdownTimeoutMs = positive(
      'shutdownTimeoutMs',
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.maxStdoutBytes = boundedBytes(
      options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      'maxStdoutBytes',
    );
    this.maxStderrBytes = boundedBytes(
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      'maxStderrBytes',
    );
    this.spawnProcess = options.spawnProcess ?? spawnAntigravityProcess;
    this.onDiagnostic = (message) => {
      const redacted = redactMetadata(message);
      if (typeof redacted === 'string') options.onDiagnostic?.(redacted.slice(0, 500));
    };
  }

  async run(args: readonly string[]): Promise<AntigravityProcessResult> {
    if (this.closed) {
      throw new AntigravityCliError('unavailable', 'Antigravity CLI source is closed');
    }

    let child: AntigravityChildProcess;
    try {
      child = this.spawnProcess(this.executable, args);
    } catch {
      throw new AntigravityCliError(
        'unavailable',
        'Antigravity CLI executable could not be started',
      );
    }

    return new Promise<AntigravityProcessResult>((resolve, reject) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolveCompletion) => {
        resolveDone = resolveCompletion;
      });
      const run: ActiveRun = {
        child,
        done,
        resolveDone,
        finish: resolve,
        finished: false,
        timedOut: false,
        stdoutTruncated: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
      };
      this.active.add(run);

      const finish = (result: AntigravityProcessResult): void => {
        if (run.finished) return;
        run.finished = true;
        if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
        if (run.escalationTimer) clearTimeout(run.escalationTimer);
        if (run.forceTimer) clearTimeout(run.forceTimer);
        this.active.delete(run);
        run.resolveDone();
        if (run.stderr) {
          for (const line of run.stderr.split(/\r?\n/).filter(Boolean)) {
            this.onDiagnostic(line);
          }
        }
        resolve(result);
      };
      run.finish = finish;

      const append = (key: 'stdout' | 'stderr', data: unknown, max: number): void => {
        const text = typeof data === 'string' ? data : String(data);
        const current = run[key];
        const next = current + text;
        if (Buffer.byteLength(next, 'utf8') > max) {
          run[key] = next.slice(0, max);
          if (key === 'stdout' && !run.stdoutTruncated) {
            run.stdoutTruncated = true;
            this.terminate(run);
          }
          return;
        }
        run[key] = next;
      };

      child.stdout.on('data', (data: unknown) => append('stdout', data, this.maxStdoutBytes));
      child.stdout.on('error', () => this.onDiagnostic('Antigravity CLI stdout failed'));
      child.stderr.on('data', (data: unknown) => append('stderr', data, this.maxStderrBytes));
      child.stderr.on('error', () => undefined);
      child.once('spawn', () => undefined);
      child.once('error', () => {
        if (!run.finished) {
          reject(new AntigravityCliError('unavailable', 'Antigravity CLI process failed to start'));
          finish({
            exitCode: null,
            signal: null,
            stdout: run.stdout,
            stderr: run.stderr,
            timedOut: run.timedOut,
            stdoutTruncated: run.stdoutTruncated,
          });
        }
      });
      child.once('exit', (code: unknown, signal: unknown) => {
        run.exitCode = typeof code === 'number' ? code : null;
        run.signal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null;
        finish({
          exitCode: run.exitCode,
          signal: run.signal,
          stdout: run.stdout,
          stderr: run.stderr,
          timedOut: run.timedOut,
          stdoutTruncated: run.stdoutTruncated,
        });
      });
      run.timeoutTimer = setTimeout(() => {
        run.timedOut = true;
        this.terminate(run);
      }, this.commandTimeoutMs);
      run.timeoutTimer.unref?.();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runs = [...this.active];
    for (const run of runs) {
      this.terminate(run);
    }
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.shutdownTimeoutMs * 2);
        timer.unref?.();
      }),
    ]);
  }

  private terminate(run: ActiveRun): void {
    if (run.finished) return;
    try {
      run.child.kill('SIGTERM');
    } catch {
      // The process may already have exited.
    }
    if (!run.escalationTimer) {
      run.escalationTimer = setTimeout(() => {
        if (run.finished) return;
        try {
          run.child.kill('SIGKILL');
        } catch {
          // Continue to bounded completion below.
        }
        run.forceTimer = setTimeout(() => {
          run.finish({
            exitCode: run.exitCode,
            signal: run.signal ?? 'SIGKILL',
            stdout: run.stdout,
            stderr: run.stderr,
            timedOut: run.timedOut,
            stdoutTruncated: run.stdoutTruncated,
          });
        }, this.shutdownTimeoutMs);
        run.forceTimer.unref?.();
      }, this.shutdownTimeoutMs);
      run.escalationTimer.unref?.();
    }
  }
}
