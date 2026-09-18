import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentClient,
  calculateCpuPercent,
  createPolicyRevision,
  loadOrCreateMachineId,
  assertSafeHubUrl,
  parseDiskPaths,
  TelemetrySampler,
} from './index.js';

class FakeWebSocket extends EventEmitter {
  static readonly instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState: number = WebSocket.OPEN;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  open(): void {
    this.emit('open');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  }

  remoteClose(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason ?? ''));
  }
}

const identity = {
  id: 'machine-test',
  name: 'Test machine',
  platform: 'linux' as const,
  arch: 'x64' as const,
};
const telemetry = {
  capturedAt: '2026-09-15T12:00:00.000Z',
  uptimeSeconds: 10,
  cpuPercent: 27,
  memoryUsedBytes: 31,
  memoryTotalBytes: 64,
  disks: [],
};

const websocketImpl = FakeWebSocket as unknown as typeof WebSocket;

function acceptedMessage(interval = 1_000) {
  return {
    type: 'agent.hello.accepted',
    protocolVersion: 1,
    serverTime: '2026-09-15T12:00:00.000Z',
    heartbeatIntervalMs: interval,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Agent identity and policy', () => {
  it('creates then reuses a stable identity in a custom state directory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'sonoran-agent-test-'));
    const first = await loadOrCreateMachineId(stateDir);
    const second = await loadOrCreateMachineId(stateDir);
    expect(first).toBe(second);
    expect(await readFile(join(stateDir, 'machine-id'), 'utf8')).toBe(`${first}\n`);
    if (process.platform !== 'win32') {
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateDir, 'machine-id'))).mode & 0o777).toBe(0o600);
    }
  });

  it('fails explicitly for malformed and unreadable identity paths', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'sonoran-agent-test-'));
    await writeFile(join(stateDir, 'machine-id'), 'not a valid id\n');
    await expect(loadOrCreateMachineId(stateDir)).rejects.toThrow('malformed');

    const unreadableDir = await mkdtemp(join(tmpdir(), 'sonoran-agent-test-'));
    await mkdir(join(unreadableDir, 'machine-id'));
    await expect(loadOrCreateMachineId(unreadableDir)).rejects.toThrow('could not be read');
  });

  it('hashes the normalized capability policy deterministically', () => {
    expect(createPolicyRevision(['b.capability', 'a.capability'])).toBe(
      createPolicyRevision(['a.capability', 'b.capability']),
    );
    expect(createPolicyRevision(['a.capability'])).not.toBe(createPolicyRevision(['b.capability']));
    expect(createPolicyRevision()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('Agent transport safety', () => {
  it.each([
    'ws://127.0.0.1:3000/agent/ws',
    'ws://localhost:3000/agent/ws',
    'ws://[::1]:3000/agent/ws',
    'wss://hub.example/agent/ws',
  ])('allows %s', (url) => expect(() => assertSafeHubUrl(url)).not.toThrow());

  it.each(['ws://192.168.1.5/agent/ws', 'ws://10.0.0.2/agent/ws', 'ws://hub.example/agent/ws'])(
    'rejects cleartext non-loopback %s before connection',
    (url) => expect(() => assertSafeHubUrl(url)).toThrow(/use wss:\/\//),
  );

  it('fails closed for missing tokens and invalid heartbeat intervals', async () => {
    const noToken = new AgentClient({
      hubUrl: 'ws://127.0.0.1:3000/agent/ws',
      WebSocketImpl: websocketImpl,
    });
    await expect(noToken.connect()).rejects.toThrow('SONORAN_AGENT_TOKEN is required');
    expect(FakeWebSocket.instances).toHaveLength(0);

    const invalidInterval = new AgentClient({
      hubUrl: 'ws://127.0.0.1:3000/agent/ws',
      token: 'secret',
      identity,
      heartbeatIntervalMs: Number.NaN,
      WebSocketImpl: websocketImpl,
    });
    await expect(invalidInterval.connect()).rejects.toThrow(/heartbeat/i);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('Agent connection lifecycle', () => {
  function client(options: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) {
    return new AgentClient({
      hubUrl: 'ws://127.0.0.1:3000/agent/ws',
      token: 'secret',
      identity,
      telemetry: async () => telemetry,
      heartbeatIntervalMs: 1_000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1_000,
      WebSocketImpl: websocketImpl,
      ...options,
    });
  }

  it('does not overlap sockets and starts heartbeats only after acceptance', async () => {
    const agent = client();
    await agent.connect();
    await agent.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(socket.sent).toHaveLength(1);
    socket.message(acceptedMessage());
    await flush();
    expect(JSON.parse(socket.sent[1]!).sequence).toBe(1);
    agent.stop();
  });

  it('resets reconnect backoff after handshake, not raw open', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const agent = client();
    await agent.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.remoteClose();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.remoteClose();
    await vi.advanceTimersByTimeAsync(199);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2]!.open();
    FakeWebSocket.instances[2]!.message(acceptedMessage());
    await flush();
    FakeWebSocket.instances[2]!.remoteClose();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWebSocket.instances).toHaveLength(4);
    agent.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('resets the connection-scoped heartbeat sequence after reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const agent = client();
    await agent.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message(acceptedMessage());
    await flush();
    expect(JSON.parse(first.sent[1]!).sequence).toBe(1);
    first.remoteClose();
    await vi.advanceTimersByTimeAsync(100);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.message(acceptedMessage());
    await flush();
    expect(JSON.parse(second.sent[1]!).sequence).toBe(1);
    agent.stop();
  });

  it('reconnects normally after the Hub requests shutdown', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const agent = client();
    await agent.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message(acceptedMessage());
    await flush();
    first.remoteClose(4002, 'hub_shutdown');
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.message(acceptedMessage());
    await flush();
    expect(JSON.parse(second.sent[1]!).sequence).toBe(1);
    agent.stop();
  });

  it('closes on malformed, invalid, and protocol-error server messages', async () => {
    const errors: string[] = [];
    const agent = client({ onError: (error) => errors.push(error.message) });
    await agent.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message('{bad json');
    expect(socket.closeCalls).toEqual([{ code: 1002, reason: 'invalid_protocol' }]);
    expect(errors).toContain('Invalid Hub message JSON');
    agent.stop();

    const invalidSchemaAgent = client();
    await invalidSchemaAgent.connect();
    const invalidSchemaSocket = FakeWebSocket.instances[1]!;
    invalidSchemaSocket.open();
    invalidSchemaSocket.message({ type: 'unexpected.server.message' });
    expect(invalidSchemaSocket.closeCalls).toEqual([{ code: 1002, reason: 'invalid_protocol' }]);
    invalidSchemaAgent.stop();

    const protocolErrorAgent = client();
    await protocolErrorAgent.connect();
    const protocolErrorSocket = FakeWebSocket.instances[2]!;
    protocolErrorSocket.open();
    protocolErrorSocket.message({
      type: 'agent.protocol.error',
      protocolVersion: 1,
      code: 'hello_required',
      message: 'hello required',
    });
    expect(protocolErrorSocket.closeCalls).toEqual([{ code: 1002, reason: 'invalid_protocol' }]);
    protocolErrorAgent.stop();
  });
});

describe('Telemetry sampling', () => {
  it.each([
    [undefined, ['/']],
    ['', ['/']],
    ['/,/mnt/data', ['/', '/mnt/data']],
    [' / , /mnt/a ', ['/', '/mnt/a']],
    ['/,/', ['/']],
    ['/ , /mnt , /mnt', ['/', '/mnt']],
  ])('normalizes configured disk paths %s', (value, expected) => {
    expect(parseDiskPaths(value)).toEqual(expected);
  });

  it('limits configured disk paths to the telemetry contract maximum', () => {
    const configured = Array.from({ length: 40 }, (_, index) => `/mnt/disk-${index}`);
    expect(parseDiskPaths(configured.join(','))).toHaveLength(32);
  });

  it('returns truthful first CPU sample and clamps deltas', () => {
    expect(calculateCpuPercent(undefined, { idle: 10, total: 10 })).toBeUndefined();
    expect(calculateCpuPercent({ idle: 10, total: 10 }, { idle: 10, total: 20 })).toBe(100);
    expect(calculateCpuPercent({ idle: 10, total: 10 }, { idle: 20, total: 20 })).toBe(0);
  });

  it('omits inaccessible disks without failing telemetry collection', async () => {
    const sampler = new TelemetrySampler({ diskPaths: ['/definitely/not/a/real/disk', '/'] });
    const first = await sampler.collect();
    expect(first.disks.map((disk) => disk.id)).toEqual(['/']);
    expect(first.cpuPercent).toBeUndefined();
  });
});
