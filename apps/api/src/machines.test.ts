import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import {
  AGENT_PROTOCOL_VERSION,
  type AgentHello,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { InMemoryMachineStore, MachineHub, type ActiveMachineSession } from './machines.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  emitClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

const telemetry: MachineTelemetry = {
  capturedAt: '2026-09-15T12:00:00.000Z',
  uptimeSeconds: 123,
  cpuPercent: 27.4,
  memoryUsedBytes: 31_400_000_000,
  memoryTotalBytes: 64_000_000_000,
  disks: [{ id: '/', usedBytes: 812_000_000_000, totalBytes: 1_800_000_000_000 }],
};

function hello(machineId = 'machine-x'): AgentHello {
  return {
    type: 'agent.hello',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: '0.2.0',
    machine: { id: machineId, name: 'Main PC', platform: 'linux', arch: 'x64' },
    capabilities: ['machine.read.telemetry'],
    policyRevision: 'sha256:test',
  };
}

async function flushMessages(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function connectAndHeartbeat(
  hub: MachineHub,
  socket: FakeSocket,
  machineId = 'machine-x',
  sequence = 1,
): Promise<void> {
  hub.handleSocket(socket as unknown as WebSocket);
  socket.message(hello(machineId));
  await flushMessages();
  socket.message({
    type: 'agent.heartbeat',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sequence,
    sentAt: telemetry.capturedAt,
    telemetry,
  });
  await flushMessages();
}

describe('MachineHub authentication', () => {
  const request = (authorization?: string) =>
    ({ headers: { ...(authorization === undefined ? {} : { authorization }) } }) as IncomingMessage;

  it.each([
    ['missing auth', undefined],
    ['wrong same-length token', 'Bearer abcdEFGH'],
    ['wrong different-length token', 'Bearer wrong'],
  ])('rejects %s', (_label, authorization) => {
    const hub = new MachineHub({ agentToken: 'abcdefgh' });
    expect(hub.authenticate(request(authorization))).toBe(false);
  });

  it('accepts the correct bearer token without exposing it in machine data', async () => {
    const store = new InMemoryMachineStore();
    const hub = new MachineHub({ agentToken: 'abcdefgh', store });
    expect(hub.authenticate(request('Bearer abcdefgh'))).toBe(true);
    const socket = new FakeSocket();
    await connectAndHeartbeat(hub, socket);
    expect(JSON.stringify(await hub.list())).not.toContain('abcdefgh');
  });

  it('rejects unauthenticated upgrades and accepts the correct token', async () => {
    const app = buildApp(undefined, { agentToken: 'abcdefgh' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const url = `ws://127.0.0.1:${address.port}/agent/ws`;
    expect(await upgrade(url, 'Bearer abcdEFGH')).toBe(false);
    expect(await upgrade(url, 'Bearer abcdefgh')).toBe(true);
    await app.close();
  });
});

async function upgrade(url: string, authorization: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { authorization } });
    socket.once('open', () => {
      socket.close();
      resolve(true);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('MachineHub live session semantics', () => {
  afterEach(() => vi.useRealTimers());

  it('times out unauthenticated protocol sessions before persisting a machine', async () => {
    vi.useFakeTimers();
    const store = new InMemoryMachineStore();
    const hub = new MachineHub({ store, helloTimeoutMs: 5_000 });
    const socket = new FakeSocket();
    hub.handleSocket(socket as unknown as WebSocket);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'hello_required' }]);
    expect(await store.list()).toHaveLength(0);
  });

  it('replaces duplicate sessions and ignores the replaced socket close race', async () => {
    let now = Date.parse('2026-09-15T12:00:00.000Z');
    const store = new InMemoryMachineStore();
    const hub = new MachineHub({ store, now: () => now, staleAfterMs: 10_000 });
    const first = new FakeSocket();
    await connectAndHeartbeat(hub, first);
    const second = new FakeSocket();
    await connectAndHeartbeat(hub, second);

    expect(first.closeCalls).toEqual([{ code: 4001, reason: 'replaced_by_new_session' }]);
    expect(hub.activeSessionCount).toBe(1);
    first.emitClose();
    expect((await hub.list()).machines[0]?.status).toBe('ONLINE');
    second.emitClose();
    expect((await hub.list()).machines[0]?.status).toBe('OFFLINE');
    expect((await hub.list()).machines[0]?.telemetry).toEqual(telemetry);
    now += 1;
  });

  it('keeps STALE for an active session and becomes OFFLINE immediately on disconnect', async () => {
    let now = Date.parse('2026-09-15T12:00:00.000Z');
    const store = new InMemoryMachineStore();
    const hub = new MachineHub({ store, now: () => now, staleAfterMs: 10_000 });
    const socket = new FakeSocket();
    await connectAndHeartbeat(hub, socket);
    now += 10_001;
    expect((await hub.list()).machines[0]?.status).toBe('STALE');
    socket.message({
      type: 'agent.heartbeat',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sequence: 2,
      sentAt: telemetry.capturedAt,
      telemetry,
    });
    await flushMessages();
    expect((await hub.list()).machines[0]?.status).toBe('ONLINE');
    socket.emitClose();
    expect((await hub.list()).machines[0]?.status).toBe('OFFLINE');
  });

  it('treats persisted machines as OFFLINE when a new API instance has no session', async () => {
    const store = new InMemoryMachineStore();
    const firstHub = new MachineHub({ store });
    await connectAndHeartbeat(firstHub, new FakeSocket());
    const restartedHub = new MachineHub({ store });
    expect((await restartedHub.list()).machines[0]?.status).toBe('OFFLINE');
  });

  it('rejects non-monotonic heartbeat sequences', async () => {
    const hub = new MachineHub({ store: new InMemoryMachineStore() });
    const socket = new FakeSocket();
    await connectAndHeartbeat(hub, socket, 'machine-x', 2);
    socket.message({
      type: 'agent.heartbeat',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sequence: 2,
      sentAt: telemetry.capturedAt,
      telemetry,
    });
    await flushMessages();
    expect(socket.closeCalls.at(-1)).toEqual({ code: 1008, reason: 'non_monotonic_sequence' });
  });

  it('keeps active session data in memory only', async () => {
    const hub = new MachineHub({ store: new InMemoryMachineStore() });
    const socket = new FakeSocket();
    await connectAndHeartbeat(hub, socket);
    const session = hub.getActiveSession('machine-x') as ActiveMachineSession;
    expect(session.socket).toBe(socket);
    expect(JSON.stringify(await hub.list())).not.toContain('socket');
  });
});
