import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
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
  type AgentActionAccepted,
  type AgentActionResult,
  type MachineCapability,
  type MachineIdentity,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import WebSocket from 'ws';

import { AgentActionExecutor, type ProcessRunner } from './actions.js';
import {
  agentPolicySchema,
  createPolicyRevision as createLocalPolicyRevision,
  loadAgentPolicy,
  policyCapabilities,
  policyCatalog,
  type AgentPolicy,
} from './policy.js';

export const AGENT_VERSION = '0.3.0';
const DEFAULT_HUB_URL = 'ws://127.0.0.1:3000/agent/ws';
const DEFAULT_STATE_DIR = join(homedir(), '.sonoran-agent', 'state');

export interface AgentStartupStatus {
  readonly status: 'started';
  readonly service: 'sonoran-agent';
  readonly version: string;
}

export interface TelemetryCollectionOptions {
  readonly diskPaths?: readonly string[];
}

export interface AgentClientOptions {
  readonly hubUrl?: string;
  readonly token?: string;
  readonly identity?: MachineIdentity;
  readonly machineName?: string;
  readonly agentVersion?: string;
  readonly capabilities?: readonly MachineCapability[];
  readonly policy?: AgentPolicy;
  readonly policyPath?: string;
  readonly processRunner?: ProcessRunner;
  readonly stateDir?: string;
  readonly heartbeatIntervalMs?: number;
  readonly diskPaths?: readonly string[];
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly telemetry?: () => Promise<MachineTelemetry>;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onState?: (state: 'connecting' | 'connected' | 'disconnected') => void;
  readonly onError?: (error: Error) => void;
}

export const DEFAULT_AGENT_CAPABILITIES: readonly MachineCapability[] = ['machine.read.telemetry'];

export function createPolicyRevision(
  policy: AgentPolicy,
  capabilities?: readonly MachineCapability[],
): string;
export function createPolicyRevision(capabilities?: readonly MachineCapability[]): string;
export function createPolicyRevision(
  policyOrCapabilities: AgentPolicy | readonly MachineCapability[] = DEFAULT_AGENT_CAPABILITIES,
  capabilities?: readonly MachineCapability[],
): string {
  if (!Array.isArray(policyOrCapabilities)) {
    return createLocalPolicyRevision(policyOrCapabilities as AgentPolicy, capabilities);
  }
  const canonical = JSON.stringify({ capabilities: [...new Set(policyOrCapabilities)].sort() });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export { loadAgentPolicy } from './policy.js';
export type { AgentPolicy, RepositoryPolicy, ServicePolicy } from './policy.js';

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
  await ensureSecureStateDirectory(stateDir);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existing)) {
      throw new Error('Machine identity file is malformed');
    }
    await tightenPermissions(path, 0o600);
    return existing;
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'ENOENT')) {
      if (error instanceof Error && error.message === 'Machine identity file is malformed') {
        throw error;
      }
      throw new Error('Machine identity file could not be read', { cause: error });
    }
  }
  const id = `machine-${randomUUID()}`;
  await writeFile(path, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  await tightenPermissions(path, 0o600);
  return id;
}

async function ensureSecureStateDirectory(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await tightenPermissions(stateDir, 0o700);
}

async function tightenPermissions(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, mode);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
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
  return new TelemetrySampler(options).collect();
}

export interface CpuTicks {
  readonly idle: number;
  readonly total: number;
}

export function cpuTicks(): CpuTicks {
  return cpus().reduce(
    (totals, cpu) => {
      const total =
        cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      return { idle: totals.idle + cpu.times.idle, total: totals.total + total };
    },
    { idle: 0, total: 0 },
  );
}

export function calculateCpuPercent(
  previous: CpuTicks | undefined,
  current: CpuTicks,
): number | undefined {
  if (!previous) return undefined;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return undefined;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export class TelemetrySampler {
  private previousCpuTicks: CpuTicks | undefined;

  constructor(private readonly options: TelemetryCollectionOptions = {}) {}

  async collect(): Promise<MachineTelemetry> {
    const currentCpuTicks = cpuTicks();
    const cpuPercent = calculateCpuPercent(this.previousCpuTicks, currentCpuTicks);
    this.previousCpuTicks = currentCpuTicks;
    const disks = await Promise.all(
      (this.options.diskPaths ?? ['/']).slice(0, 32).map(async (path) => {
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
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
      memoryUsedBytes: memoryTotalBytes - freemem(),
      memoryTotalBytes,
      disks: disks.filter((disk): disk is NonNullable<typeof disk> => disk !== undefined),
    });
  }
}

export function assertSafeHubUrl(hubUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error('SONORAN_HUB_URL must be a valid ws:// or wss:// URL');
  }
  if (parsed.protocol === 'wss:') return;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol === 'ws:' && ['127.0.0.1', 'localhost', '::1'].includes(hostname)) return;
  throw new Error(
    'Cleartext ws:// is permitted only for loopback development endpoints; use wss:// for remote Hub connections.',
  );
}

export function validateHeartbeatIntervalMs(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error('SONORAN_AGENT_HEARTBEAT_MS must be an integer from 1000 to 300000');
  }
  return value;
}

export function parseDiskPaths(value: string | undefined): string[] {
  const paths = (value ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  const uniquePaths = [...new Set(paths)].slice(0, 32);
  return uniquePaths.length > 0 ? uniquePaths : ['/'];
}

export class AgentClient {
  private readonly options: AgentClientOptions;
  private readonly telemetrySampler: TelemetrySampler;
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private reconnectAttempt = 0;
  private generation = 0;
  private connecting = false;
  private running = false;
  private localHeartbeatIntervalMs: number | undefined;
  private handshakeAcceptedGeneration: number | undefined;
  private hello: AgentHello | undefined;
  private collecting = false;
  private actionExecutor: AgentActionExecutor | undefined;
  private localPolicy: AgentPolicy | undefined;

  constructor(options: AgentClientOptions = {}) {
    this.options = options;
    this.telemetrySampler = new TelemetrySampler({ diskPaths: options.diskPaths });
  }

  async connect(): Promise<void> {
    const hubUrl = this.options.hubUrl ?? DEFAULT_HUB_URL;
    assertSafeHubUrl(hubUrl);
    if (!this.options.token) throw new Error('SONORAN_AGENT_TOKEN is required');
    if (this.running && (this.connecting || this.socket !== undefined)) return;

    const localInterval =
      this.options.heartbeatIntervalMs === undefined
        ? undefined
        : validateHeartbeatIntervalMs(this.options.heartbeatIntervalMs);
    this.running = true;
    this.connecting = true;
    this.clearReconnectTimer();
    const generation = ++this.generation;
    this.localHeartbeatIntervalMs = localInterval;
    this.options.onState?.('connecting');

    let identity: MachineIdentity;
    let policy: AgentPolicy;
    try {
      identity = await createMachineIdentity(this.options);
      policy =
        this.localPolicy ??
        (this.options.policy ? agentPolicySchema.parse(this.options.policy) : undefined) ??
        (await loadAgentPolicy({
          path: this.options.policyPath,
          explicit: this.options.policyPath !== undefined,
        }));
      this.localPolicy = policy;
    } catch (error) {
      this.connecting = false;
      this.running = false;
      throw error;
    }
    if (!this.isCurrentGeneration(generation)) return;
    const capabilities = policyCapabilities(policy);
    const actionCatalog = policyCatalog(policy, capabilities);
    this.actionExecutor ??= new AgentActionExecutor({
      policy,
      processRunner: this.options.processRunner,
    });
    this.hello = {
      type: 'agent.hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: this.options.agentVersion ?? AGENT_VERSION,
      machine: identity,
      capabilities,
      policyRevision: createLocalPolicyRevision(policy, capabilities),
      actionCatalog,
    };
    const WebSocketImpl = this.options.WebSocketImpl ?? WebSocket;
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(hubUrl, {
        headers: { Authorization: `Bearer ${this.options.token}` },
      });
    } catch (error) {
      this.connecting = false;
      this.running = false;
      throw error;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.send(generation, this.hello!);
    });
    socket.on('message', (data) => this.handleServerMessage(generation, data));
    socket.on('error', (error) => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on('close', () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.clearHeartbeatTimer();
      this.socket = undefined;
      this.connecting = false;
      this.handshakeAcceptedGeneration = undefined;
      this.options.onState?.('disconnected');
      if (this.running) this.scheduleReconnect();
    });
  }

  stop(): void {
    this.running = false;
    this.connecting = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private handleServerMessage(generation: number, data: WebSocket.RawData): void {
    if (!this.isCurrentGeneration(generation)) return;
    let parsed: ReturnType<typeof agentServerMessageSchema.safeParse>;
    try {
      parsed = agentServerMessageSchema.safeParse(JSON.parse(data.toString()));
    } catch {
      this.failCurrentConnection(generation, new Error('Invalid Hub message JSON'));
      return;
    }
    if (!parsed.success) {
      this.failCurrentConnection(generation, new Error('Invalid Hub message'));
      return;
    }
    if (parsed.data.type === 'agent.protocol.error') {
      this.options.onError?.(new Error(`${parsed.data.code}: ${parsed.data.message}`));
      this.failCurrentConnection(generation);
      return;
    }
    if (parsed.data.type === 'agent.action.request') {
      if (this.handshakeAcceptedGeneration !== generation || !this.actionExecutor) {
        this.failCurrentConnection(
          generation,
          new Error('Action request received before handshake'),
        );
        return;
      }
      const execution = this.actionExecutor.execute(parsed.data);
      if (!execution.accepted) {
        this.send(generation, execution.result);
        return;
      }
      this.send(generation, {
        type: 'agent.action.accepted',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        actionId: parsed.data.actionId,
        acceptedAt: new Date().toISOString(),
      });
      void execution.result.then((result) => this.send(generation, result));
      return;
    }
    if (this.handshakeAcceptedGeneration === generation) {
      this.failCurrentConnection(generation, new Error('Unexpected duplicate Agent acceptance'));
      return;
    }
    this.handshakeAcceptedGeneration = generation;
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.sequence = 0;
    this.options.onState?.('connected');
    this.clearHeartbeatTimer();
    const interval = validateHeartbeatIntervalMs(
      this.localHeartbeatIntervalMs ?? parsed.data.heartbeatIntervalMs,
    );
    void this.sendHeartbeat(generation);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(generation), interval);
  }

  private async sendHeartbeat(generation: number): Promise<void> {
    if (
      !this.isCurrentGeneration(generation) ||
      this.handshakeAcceptedGeneration !== generation ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.collecting
    ) {
      return;
    }
    this.collecting = true;
    try {
      const telemetry = await (this.options.telemetry ?? (() => this.telemetrySampler.collect()))();
      if (!this.isCurrentGeneration(generation)) return;
      this.sequence += 1;
      this.send(generation, {
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

  private send(
    generation: number,
    message: AgentHello | AgentHeartbeat | AgentActionAccepted | AgentActionResult,
  ): void {
    if (this.isCurrentGeneration(generation) && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private failCurrentConnection(generation: number, error?: Error): void {
    if (!this.isCurrentGeneration(generation)) return;
    if (error) this.options.onError?.(error);
    this.socket?.close(1002, 'invalid_protocol');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.socket || this.connecting || !this.running) return;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        void this.connect().catch((error: unknown) => {
          this.running = false;
          this.options.onError?.(
            error instanceof Error ? error : new Error('Agent connection failed'),
          );
        });
      },
      Math.round(delay * (0.8 + Math.random() * 0.4)),
    );
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private isCurrentSocket(generation: number, socket: WebSocket): boolean {
    return this.isCurrentGeneration(generation) && this.socket === socket;
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
  const explicitPolicyPath = process.env.SONORAN_AGENT_POLICY_PATH?.trim();
  if (process.env.SONORAN_HUB_URL) {
    if (!process.env.SONORAN_AGENT_TOKEN) {
      console.error(JSON.stringify({ ...status, error: 'SONORAN_AGENT_TOKEN is required' }));
      process.exitCode = 1;
    } else {
      const client = new AgentClient({
        hubUrl: process.env.SONORAN_HUB_URL,
        token: process.env.SONORAN_AGENT_TOKEN,
        machineName: process.env.SONORAN_MACHINE_NAME,
        stateDir: process.env.SONORAN_AGENT_STATE_DIR,
        heartbeatIntervalMs: process.env.SONORAN_AGENT_HEARTBEAT_MS
          ? Number(process.env.SONORAN_AGENT_HEARTBEAT_MS)
          : AGENT_HEARTBEAT_INTERVAL_MS,
        diskPaths: parseDiskPaths(process.env.SONORAN_AGENT_DISK_PATHS),
        policyPath: process.env.SONORAN_AGENT_POLICY_PATH?.trim() || undefined,
        onError: (error) => console.error(JSON.stringify({ ...status, error: error.message })),
      });
      void client.connect().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            ...status,
            error: error instanceof Error ? error.message : 'Agent connection failed',
          }),
        );
        process.exitCode = 1;
      });
      const stop = () => client.stop();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } else if (explicitPolicyPath) {
    void loadAgentPolicy({ path: explicitPolicyPath, explicit: true }).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          ...status,
          error: error instanceof Error ? error.message : 'Agent policy validation failed',
        }),
      );
      process.exitCode = 1;
    });
  }
}
