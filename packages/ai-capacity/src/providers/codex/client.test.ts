import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient, type CodexChildProcess, type CodexSpawn } from './client.js';

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter implements CodexChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly writes: string[] = [];
  readonly killedWith: NodeJS.Signals[] = [];
  ended = false;
  constructor(
    private readonly exitOnEnd = true,
    private readonly exitOnSigkill = false,
  ) {
    super();
  }
  readonly stdin = {
    write: (data: string) => {
      this.writes.push(data);
      return true;
    },
    end: () => {
      this.ended = true;
      if (this.exitOnEnd) {
        queueMicrotask(() => this.emit('exit', 0, null));
      }
    },
  };

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    if (this.exitOnEnd || (signal === 'SIGKILL' && this.exitOnSigkill)) {
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }

  send(message: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`);
  }
}

function spawnedChild(child: FakeChild): CodexSpawn {
  return vi.fn(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
}

function messages(child: FakeChild): Array<Record<string, unknown>> {
  return child.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const clientOptions = (spawnProcess: CodexSpawn) => ({
  executable: 'codex-test',
  startupTimeoutMs: 100,
  requestTimeoutMs: 100,
  shutdownTimeoutMs: 20,
  spawnProcess,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexAppServerClient', () => {
  it('spawns directly with app-server and correlates multiple in-flight responses', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(clientOptions(spawnedChild(child)));

    const first = client.request('first', { value: 1 });
    const second = client.request('second');
    await nextTick();
    const requests = messages(child);
    expect(requests).toHaveLength(2);
    const firstRequest = requests.find((request) => request.method === 'first');
    const secondRequest = requests.find((request) => request.method === 'second');
    expect(firstRequest).toMatchObject({ jsonrpc: '2.0', method: 'first', params: { value: 1 } });
    expect(secondRequest).toMatchObject({ jsonrpc: '2.0', method: 'second' });

    child.send({ jsonrpc: '2.0', id: secondRequest?.id, result: { order: 2 } });
    child.send({ jsonrpc: '2.0', id: firstRequest?.id, result: { order: 1 } });
    await expect(first).resolves.toEqual({ order: 1 });
    await expect(second).resolves.toEqual({ order: 2 });
    await client.close();
    expect(child.ended).toBe(true);
  });

  it('keeps notifications separate from responses and leaves stderr out of protocol parsing', async () => {
    const child = new FakeChild();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const stderr: string[] = [];
    const client = new CodexAppServerClient({
      ...clientOptions(spawnedChild(child)),
      onNotification: (method, params) => notifications.push({ method, params }),
      onStderr: (message) => stderr.push(message),
    });

    const pending = client.request('account/read');
    await nextTick();
    child.stderr.emit('data', 'diagnostic output, not JSON');
    child.send({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { sparse: true } });
    const [request] = messages(child);
    child.send({ jsonrpc: '2.0', id: request?.id, result: { ok: true } });

    await expect(pending).resolves.toEqual({ ok: true });
    expect(notifications).toEqual([
      { method: 'account/rateLimits/updated', params: { sparse: true } },
    ]);
    expect(stderr).toEqual(['diagnostic output, not JSON']);
    await client.close();
  });

  it('fails safely on malformed JSON and unexpected response IDs', async () => {
    const malformedChild = new FakeChild();
    const malformedClient = new CodexAppServerClient(clientOptions(spawnedChild(malformedChild)));
    const malformed = malformedClient.request('rate-limits');
    await nextTick();
    malformedChild.stdout.emit('data', '{not-json}\n');
    await expect(malformed).rejects.toMatchObject({ code: 'invalid_response' });
    expect(malformedChild.killedWith).toEqual([]);
    await malformedClient.close();

    const unexpectedChild = new FakeChild();
    const unexpectedClient = new CodexAppServerClient(clientOptions(spawnedChild(unexpectedChild)));
    const unexpected = unexpectedClient.request('rate-limits');
    await nextTick();
    unexpectedChild.send({ jsonrpc: '2.0', id: 'not-pending', result: {} });
    await expect(unexpected).rejects.toMatchObject({ code: 'invalid_response' });
    await unexpectedClient.close();
  });

  it('bounds startup and request waits and force-cleans a hung process', async () => {
    vi.useFakeTimers();
    const startupChild = new FakeChild();
    const startupClient = new CodexAppServerClient({
      ...clientOptions(vi.fn(() => startupChild)),
      startupTimeoutMs: 25,
    });
    const startup = startupClient.start();
    const startupExpectation = expect(startup).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await startupExpectation;
    expect(startupChild.ended).toBe(true);

    const requestChild = new FakeChild();
    const requestClient = new CodexAppServerClient({
      ...clientOptions(spawnedChild(requestChild)),
      requestTimeoutMs: 25,
    });
    const request = requestClient.request('hung');
    const requestExpectation = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);
    await requestExpectation;
    await requestClient.close();
    expect(requestChild.killedWith).toEqual([]);

    const hangingChild = new FakeChild(false, true);
    const hangingClient = new CodexAppServerClient({
      ...clientOptions(spawnedChild(hangingChild)),
      shutdownTimeoutMs: 10,
    });
    await hangingClient.start();
    const close = hangingClient.close();
    await vi.advanceTimersByTimeAsync(30);
    await close;
    expect(hangingChild.killedWith).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('automatically escalates request-timeout cleanup when SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false, true);
    const client = new CodexAppServerClient({
      ...clientOptions(spawnedChild(child)),
      requestTimeoutMs: 10,
      shutdownTimeoutMs: 5,
    });
    const request = client.request('hung');
    const rejection = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(child.ended).toBe(true);
    expect(child.killedWith).toEqual([]);

    await vi.advanceTimersByTimeAsync(5);
    expect(child.killedWith).toEqual(['SIGTERM']);
    const closeDuringCleanup = client.close();
    await vi.advanceTimersByTimeAsync(5);
    await closeDuringCleanup;
    await client.close();
    expect(child.killedWith).toEqual(['SIGTERM', 'SIGKILL']);
    expect(client.isClosed).toBe(true);
  });

  it('automatically escalates malformed-protocol cleanup when SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false, true);
    const client = new CodexAppServerClient({
      ...clientOptions(spawnedChild(child)),
      shutdownTimeoutMs: 5,
    });
    const request = client.request('rate-limits');
    const rejection = expect(request).rejects.toMatchObject({ code: 'invalid_response' });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit('data', '{not-json}\n');
    await rejection;
    await vi.advanceTimersByTimeAsync(5);
    expect(child.killedWith).toEqual(['SIGTERM']);
    const closeDuringCleanup = client.close();
    await vi.advanceTimersByTimeAsync(5);
    await closeDuringCleanup;
    expect(child.killedWith).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
