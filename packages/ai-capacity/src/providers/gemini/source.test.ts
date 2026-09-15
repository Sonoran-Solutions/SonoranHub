import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AntigravityChildProcess, AntigravitySpawn } from './client.js';
import { AntigravityCliSource, GEMINI_MINIMUM_AGY_VERSION } from './source.js';

class Stream extends EventEmitter {}

class FakeChild extends EventEmitter implements AntigravityChildProcess {
  readonly stdout = new Stream();
  readonly stderr = new Stream();
  readonly killedWith: NodeJS.Signals[] = [];
  constructor(
    private readonly output: string,
    private readonly exitCode = 0,
    private readonly ignoreTermination = false,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    if (!this.ignoreTermination || signal === 'SIGKILL') {
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }

  start(): void {
    queueMicrotask(() => {
      this.emit('spawn');
      if (this.ignoreTermination) return;
      this.stdout.emit('data', this.output);
      this.emit('exit', this.exitCode, null);
    });
  }
}

const quotaEnvelope = (
  numTurns = 0,
  data: unknown = {
    groups: [
      {
        name: 'Gemini Models',
        buckets: [
          {
            id: 'gemini-weekly',
            name: 'Weekly Limit Remaining',
            window: 'weekly',
            remaining_fraction: 0.5,
            reset_time: '2026-09-19T03:37:31Z',
          },
        ],
      },
    ],
  },
) =>
  JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: 'ignored',
    duration_seconds: 0,
    num_turns: numTurns,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    command: { name: 'usage', data },
  });

const creditsEnvelope = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response: 'ignored',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: 'credits', data: { remaining_credits: 2 } },
});

function sourceFor(handler: (args: readonly string[]) => FakeChild): {
  source: AntigravityCliSource;
  spawnProcess: AntigravitySpawn;
} {
  const spawnProcess: AntigravitySpawn = vi.fn((_executable, args) => {
    const child = handler(args);
    child.start();
    return child;
  });
  return {
    source: new AntigravityCliSource({
      executable: 'agy-test',
      spawnProcess,
      commandTimeoutMs: 20,
      shutdownTimeoutMs: 5,
    }),
    spawnProcess,
  };
}

afterEach(() => vi.useRealTimers());

describe('AntigravityCliSource', () => {
  it('uses version plus zero-turn structured quota and credits commands', async () => {
    const { source, spawnProcess } = sourceFor((args) => {
      if (args[0] === '--version') return new FakeChild('agy ' + '1.1.22');
      if (args.includes('/quota')) return new FakeChild(quotaEnvelope());
      return new FakeChild(creditsEnvelope);
    });
    await expect(source.probe()).resolves.toMatchObject({
      available: true,
      antigravityVersion: '1.1.22',
    });
    await expect(source.readCapacity()).resolves.toMatchObject({
      antigravityVersion: '1.1.22',
      quota: { groups: [{ name: 'Gemini Models' }] },
      credits: { remaining_credits: 2 },
    });
    expect(source.lastReadOnlyCommands).toEqual(['/quota', '/credits']);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    await source.close();
  });

  it('rejects an old CLI before sending a slash command', async () => {
    const { source, spawnProcess } = sourceFor(
      (args) => new FakeChild(args[0] === '--version' ? '1.1.10' : quotaEnvelope()),
    );
    await expect(source.probe()).resolves.toMatchObject({
      available: false,
      failure: { code: 'unavailable' },
      reason: expect.stringContaining(GEMINI_MINIMUM_AGY_VERSION),
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await source.close();
  });

  it('rejects a normal model-turn envelope instead of parsing prose quota', async () => {
    const { source } = sourceFor((args) => {
      if (args[0] === '--version') return new FakeChild('1.1.22');
      return new FakeChild(quotaEnvelope(1));
    });
    const result = await source.probe();
    expect(result).toMatchObject({
      available: false,
      failure: { code: 'invalid_response' },
      reason: 'Installed Antigravity version did not execute /quota as a read-only command',
    });
    await source.close();
  });

  it('classifies authentication and malformed/empty output safely', async () => {
    const auth = sourceFor(
      (args) =>
        new FakeChild(
          args[0] === '--version'
            ? '1.1.22'
            : JSON.stringify({
                conversation_id: '',
                status: 'ERROR',
                response: 'Please sign in to continue',
                num_turns: 0,
              }),
        ),
    );
    await expect(auth.source.probe()).resolves.toMatchObject({
      available: false,
      failure: { code: 'authentication' },
    });
    await auth.source.close();

    const malformed = sourceFor((args) => new FakeChild(args[0] === '--version' ? '1.1.22' : ''));
    await expect(malformed.source.probe()).resolves.toMatchObject({
      available: false,
      failure: { code: 'invalid_response' },
    });
    await malformed.source.close();
  });

  it('bounds output and escalates a hung command', async () => {
    vi.useFakeTimers();
    const hungChildren: FakeChild[] = [];
    const { source } = sourceFor((args) => {
      const child = new FakeChild(
        args[0] === '--version' ? '1.1.22' : '',
        0,
        args[0] !== '--version',
      );
      hungChildren.push(child);
      if (args[0] === '--version') child.start();
      return child;
    });
    const probe = source.probe();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(10);
    await expect(probe).resolves.toMatchObject({ available: false, failure: { code: 'timeout' } });
    expect(hungChildren[1]?.killedWith).toEqual(['SIGTERM', 'SIGKILL']);
    await source.close();
  });
});
