import { randomUUID } from 'node:crypto';
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, homedir, platform, totalmem, uptime } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_PROTOCOL_VERSION,
  agentServerMessageSchema,
  machineArchitectureSchema,
  machinePlatformSchema,
  machineTelemetrySchema,
  type AgentHeartbeat,
  type AgentHello,
  type MachineCapability,
  type MachineIdentity,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import WebSocket from 'ws';

export const AGENT_VERSION = '0.2.0';
const DEFAULT_HUB_URL = 'ws://127.0.0.1:3000/agent/ws';
const DEFAULT_STATE_DIR = join(homedir(), '.sonoran-agent', 'state');
const DEFAULT_CAPABILITIES: readonly MachineCapability[] = ['machine.read.telemetry'];

export interface AgentStartupStatus {
  readonly status: 'started';
  readonly service: 'sonoran-agent';
  readonly version: string;
}

export interface TelemetryCollectionOptions {
  readonly diskPaths?: readonly string[];
  readonly cpuSampleMs?: number;
}

export interface AgentClientOptions {
  readonly hubUrl?: string;
  readonly token?: string;
  readonly identity?: MachineIdentity;
  readonly machineName?: string;
  readonly agentVersion?: string;
  readonly policyRevision?: string;
  readonly capabilities?: readonly MachineCapability[];
  readonly stateDir?: string;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly telemetry?: () => Promise<MachineTelemetry>;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onState?: (state: 'connecting' | 'connected' | 'disconnected') => void;
  readonly onError?: (error: Error) => void;
}

export function createStartupStatus(): AgentStartupStatus {
  return { status: 'started', service: 'sonoran-agent', version: AGENT_VERSION };
}

export function startAgent(log: (message: string) => void = console.log): AgentStartupStatus {
  const startupStatus = createStartupStatus();
  log(JSON.stringify(startupStatus));
  return startupStatus;
}

export async function loadOrCreateMachineId(stateDir = DEFAULT_STATE_DIR): Promise<string> {
  const path = join(stateDir, 'machine-id');
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existing)) return existing;
  } catch {
    // First run creates the state directory and machine identity below.
  }
  const id = `machine-${randomUUID()}`;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  return id;
}

export async function createMachineIdentity(
  options: Pick<AgentClientOptions, 'identity' | 'machineName' | 'stateDir'> = {},
): Promise<MachineIdentity> {
  if (options.identity) return options.identity;
  const parsedPlatform = machinePlatformSchema.safeParse(platform());
  const parsedArch = machineArchitectureSchema.safeParse(arch());
  return {
    id: await loadOrCreateMachineId(options.stateDir),
    name: options.machineName?.trim() || hostname(),
    platform: parsedPlatform.success ? parsedPlatform.data : 'unknown',
    arch: parsedArch.success ? parsedArch.data : 'unknown',
  };
}

export async function collectTelemetry(
  options: TelemetryCollectionOptions = {},
): Promise<MachineTelemetry> {
  const cpuPercent = await sampleCpuPercent(options.cpuSampleMs ?? 100);
  const disks = await Promise.all(
    (options.diskPaths ?? ['/']).slice(0, 32).map(async (path) => {
      try {
        const stats = await statfs(path, { bigint: true });
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        return {
          id: path,
          usedBytes: Number(totalBytes - freeBytes),
          totalBytes: Number(totalBytes),
        };
      } catch {
        return undefined;
      }
    }),
  );
  const memoryTotalBytes = totalmem();
  return machineTelemetrySchema.parse({
    capturedAt: new Date().toISOString(),
    uptimeSeconds: uptime(),
    cpuPercent,
    memoryUsedBytes: memoryTotalBytes - freemem(),
    memoryTotalBytes,
    disks: disks.filter((disk): disk is NonNullable<typeof disk> => disk !== undefined),
  });
}

async function sampleCpuPercent(sampleMs: number): Promise<number> {
  const before = cpuTotals();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(sampleMs, 1_000))));
  const after = cpuTotals();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  return totalDelta > 0
    ? Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100))
    : 0;
}

function cpuTotals(): { idle: number; total: number } {
  return cpus().reduce(
    (totals, cpu) => {
      const total =
        cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return { idle: totals.idle + cpu.times.idle, total: totals.total + total };
    },
    { idle: 0, total: 0 },
  );
}

export class AgentClient {
  private readonly options: AgentClientOptions;
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private reconnectAttempt = 0;
  private running = false;
  private hello: AgentHello | undefined;
  private collecting = false;

  constructor(options: AgentClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.running = true;
    this.clearReconnectTimer();
    this.options.onState?.('connecting');
    const identity = await createMachineIdentity(this.options);
    this.hello = {
      type: 'agent.hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: this.options.agentVersion ?? AGENT_VERSION,
      machine: identity,
      capabilities: [...(this.options.capabilities ?? DEFAULT_CAPABILITIES)],
      policyRevision: this.options.policyRevision ?? 'local-readonly-v1',
    };
    const WebSocketImpl = this.options.WebSocketImpl ?? WebSocket;
    const headers = this.options.token
      ? { Authorization: `Bearer ${this.options.token}` }
      : undefined;
    const socket = new WebSocketImpl(
      this.options.hubUrl ?? DEFAULT_HUB_URL,
      headers ? { headers } : undefined,
    );
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.send(this.hello!);
    });
    socket.on('message', (data) => this.handleServerMessage(data));
    socket.on('error', (error) =>
      this.options.onError?.(error instanceof Error ? error : new Error(String(error))),
    );
    socket.on('close', () => {
      this.clearHeartbeatTimer();
      if (this.socket === socket) this.socket = undefined;
      this.options.onState?.('disconnected');
      if (this.running) this.scheduleReconnect();
    });
  }

  stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.socket?.close();
    this.socket = undefined;
  }

  private handleServerMessage(data: WebSocket.RawData): void {
    try {
      const parsed = agentServerMessageSchema.parse(JSON.parse(data.toString()));
      if (parsed.type === 'agent.protocol.error') {
        this.options.onError?.(new Error(`${parsed.code}: ${parsed.message}`));
        this.socket?.close();
        return;
      }
      this.options.onState?.('connected');
      this.clearHeartbeatTimer();
      const interval = this.options.heartbeatIntervalMs ?? parsed.heartbeatIntervalMs;
      void this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), interval);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error('Invalid Hub message'));
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.collecting) return;
    this.collecting = true;
    try {
      const telemetry = await (this.options.telemetry ?? (() => collectTelemetry()))();
      this.sequence += 1;
      this.send({
        type: 'agent.heartbeat',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sequence: this.sequence,
        sentAt: new Date().toISOString(),
        telemetry,
      });
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error : new Error('Telemetry collection failed'),
      );
    } finally {
      this.collecting = false;
    }
  }

  private send(message: AgentHello | AgentHeartbeat): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        void this.connect().catch((error: unknown) =>
          this.options.onError?.(
            error instanceof Error ? error : new Error('Agent connection failed'),
          ),
        );
      },
      Math.round(delay * (0.8 + Math.random() * 0.4)),
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

if (process.argv[1]?.endsWith('/index.ts') || process.argv[1]?.endsWith('/index.js')) {
  const status = startAgent();
  if (process.env.SONORAN_HUB_URL) {
    const client = new AgentClient({
      hubUrl: process.env.SONORAN_HUB_URL,
      token: process.env.SONORAN_AGENT_TOKEN,
      machineName: process.env.SONORAN_MACHINE_NAME,
      stateDir: process.env.SONORAN_AGENT_STATE_DIR,
      heartbeatIntervalMs: process.env.SONORAN_AGENT_HEARTBEAT_MS
        ? Number(process.env.SONORAN_AGENT_HEARTBEAT_MS)
        : AGENT_HEARTBEAT_INTERVAL_MS,
      onError: (error) => console.error(JSON.stringify({ ...status, error: error.message })),
    });
    void client.connect();
    const stop = () => client.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}
