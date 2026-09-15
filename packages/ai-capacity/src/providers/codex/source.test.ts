import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { type CodexSpawn } from './client.js';
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
});
