import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CodexChildProcess, type CodexSpawn } from './client.js';
import { CodexAppServerSource } from './source.js';

class Stream extends EventEmitter {}

class ProtocolChild extends EventEmitter {
  readonly stdout = new Stream();
  readonly stderr = new Stream();
  readonly writes: Array<Record<string, unknown>> = [];
  readonly stdin = {
    write: (data: string) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      this.writes.push(message);
      queueMicrotask(() => this.respond(message));
      return true;
    },
    end: () => queueMicrotask(() => this.emit('exit', 0, null)),
  };
  killed = false;
  constructor(private readonly account: unknown) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }

  private respond(message: Record<string, unknown>): void {
    if (typeof message.id !== 'string') return;
    const result =
      message.method === 'initialize'
        ? {
            userAgent: 'codex_cli_rs/0.154.0-alpha.6.2',
            platformFamily: 'unix',
            platformOs: 'linux',
            codexHome: '/redacted/codex-home',
          }
        : message.method === 'account/read'
          ? this.account
          : {
              rateLimits: {
                limitId: 'codex',
                limitName: 'Codex',
                planType: 'plus',
                primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                secondary: { usedPercent: 19, windowDurationMins: 10_080, resetsAt: null },
              },
              rateLimitsByLimitId: null,
              ordinaryUsageAllowed: true,
              rateLimitResetCredits: { availableCount: 2, credits: null },
              accountId: 'must-not-leave-source',
            };
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
}

class RecoveryChild extends EventEmitter implements CodexChildProcess {
  readonly stdout = new Stream();
  readonly stderr = new Stream();
  readonly writes: Array<Record<string, unknown>> = [];
  readonly killedWith: NodeJS.Signals[] = [];
  isAlive = true;
  private ended = false;

  readonly stdin = {
    write: (data: string) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      this.writes.push(message);
      queueMicrotask(() => this.respond(message));
      return true;
    },
    end: () => {
      this.ended = true;
      if (this.mode === 'healthy') {
        queueMicrotask(() => this.exit(0, null));
      }
    },
  };

  constructor(private readonly mode: 'hung' | 'healthy') {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    if (signal === 'SIGKILL') {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  private respond(message: Record<string, unknown>): void {
    if (!this.isAlive || typeof message.id !== 'string') return;
    let result: unknown;
    if (message.method === 'initialize') {
      result = {
        userAgent: 'codex_cli_rs/0.154.0-alpha.6.2',
        platformFamily: 'unix',
        platformOs: 'linux',
        codexHome: '/redacted/codex-home',
      };
    } else if (message.method === 'account/read') {
      result = chatgptAccount;
    } else if (message.method === 'account/rateLimits/read' && this.mode === 'healthy') {
      result = {
        rateLimits: {
          limitId: 'codex',
          planType: 'plus',
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        ordinaryUsageAllowed: true,
      };
    } else {
      return;
    }
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    this.emit('exit', code, signal);
  }
}

function sourceFor(account: unknown, children: ProtocolChild[] = []) {
  const spawnProcess: CodexSpawn = vi.fn(() => {
    const child = new ProtocolChild(account);
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return {
    source: new CodexAppServerSource({
      executable: 'codex-test',
      startupTimeoutMs: 100,
      initializeTimeoutMs: 100,
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 20,
      spawnProcess,
    }),
    spawnProcess,
  };
}

const chatgptAccount = {
  requiresOpenaiAuth: true,
  account: { type: 'chatgpt', email: 'private@example.test', planType: 'plus' },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexAppServerSource', () => {
  it('performs initialize, waits for the response, sends initialized, then reads account and quota', async () => {
    const children: ProtocolChild[] = [];
    const { source } = sourceFor(chatgptAccount, children);

    await expect(source.probe()).resolves.toMatchObject({
      available: true,
      planType: 'plus',
      codexVersion: '0.154.0-alpha.6.2',
    });
    const snapshot = await source.readCapacity();
    await source.close();

    const writes = children[0]?.writes ?? [];
    expect(writes[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 'sonoran-hub-1',
      method: 'initialize',
      params: {
        clientInfo: { name: 'sonoran-hub', title: 'Sonoran Hub', version: '0.1.0' },
      },
    });
    expect(writes[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' });
    expect(writes[2]).toEqual({
      jsonrpc: '2.0',
      id: 'sonoran-hub-2',
      method: 'account/read',
      params: { refreshToken: false },
    });
    expect(writes[3]).toMatchObject({
      method: 'account/rateLimits/read',
      params: { excludeResetCreditDetails: true },
    });
    expect(snapshot.response.accountId).toBe('must-not-leave-source');
    expect(snapshot.planType).toBe('plus');
    expect(snapshot.codexVersion).toBe('0.154.0-alpha.6.2');
  });

  it.each([
    [
      'missing ChatGPT account',
      { requiresOpenaiAuth: true, account: null },
      'authentication',
      'Codex ChatGPT authentication is not available',
    ],
    [
      'API-key account',
      { requiresOpenaiAuth: false, account: { type: 'apiKey' } },
      'unavailable',
      'ChatGPT subscription quota is unavailable',
    ],
    [
      'unsupported provider mode',
      { requiresOpenaiAuth: false, account: { type: 'amazonBedrock' } },
      'unavailable',
      'unsupported non-ChatGPT provider mode',
    ],
  ] as const)(
    'classifies %s without exposing account details',
    async (_label, account, code, message) => {
      const { source } = sourceFor(account);
      const result = await source.probe();
      await source.close();
      expect(result).toMatchObject({
        available: false,
        failure: { code },
        reason: expect.stringContaining(message),
      });
      expect(result.reason).not.toContain('@');
      expect(result.reason).not.toContain('private');
    },
  );

  it('classifies a malformed account response as invalid_response', async () => {
    const { source } = sourceFor({ requiresOpenaiAuth: true, account: { type: 'chatgpt' } });
    const result = await source.probe();
    await source.close();
    expect(result).toMatchObject({ available: false, failure: { code: 'invalid_response' } });
  });

  it('restarts the reusable source after a child exit', async () => {
    const children: ProtocolChild[] = [];
    const { source, spawnProcess } = sourceFor(chatgptAccount, children);
    await expect(source.probe()).resolves.toMatchObject({ available: true });
    children[0]?.emit('exit', 1, null);
    await expect(source.probe()).resolves.toMatchObject({ available: true });
    await source.close();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('waits for failed-client cleanup before starting exactly one replacement', async () => {
    vi.useFakeTimers();
    const children: RecoveryChild[] = [];
    let spawnIndex = 0;
    const spawnProcess: CodexSpawn = vi.fn(() => {
      const child = new RecoveryChild(spawnIndex++ === 0 ? 'hung' : 'healthy');
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const source = new CodexAppServerSource({
      executable: 'codex-test',
      startupTimeoutMs: 100,
      initializeTimeoutMs: 100,
      requestTimeoutMs: 10,
      shutdownTimeoutMs: 5,
      spawnProcess,
    });

    const firstProbe = source.probe();
    await vi.advanceTimersByTimeAsync(0);
    await expect(firstProbe).resolves.toMatchObject({ available: true });

    const failedRead = source.readCapacity();
    const failure = expect(failedRead).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    const nextProbe = source.probe();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(children[0]?.killedWith).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(0);
    await expect(nextProbe).resolves.toMatchObject({ available: true });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(children[0]?.isAlive).toBe(false);
    expect(children[1]?.isAlive).toBe(true);
    const close = source.close();
    await vi.advanceTimersByTimeAsync(0);
    await close;
  });
});
