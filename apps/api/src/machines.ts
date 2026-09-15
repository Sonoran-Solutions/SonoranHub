import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_MAX_MESSAGE_BYTES,
  AGENT_PROTOCOL_VERSION,
  agentClientMessageSchema,
  agentHelloAcceptedSchema,
  agentProtocolErrorSchema,
  machineSummarySchema,
  machinesResponseSchema,
  type AgentClientMessage,
  type AgentProtocolError,
  type MachineIdentity,
  type MachineSummary,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';

export interface PersistedMachine {
  readonly identity: MachineIdentity;
  readonly agentVersion: string;
  readonly capabilities: MachineSummary['capabilities'];
  readonly policyRevision: string;
  readonly lastSeenAt: string;
  readonly telemetry: MachineTelemetry | null;
}

export interface MachineStore {
  upsert(machine: PersistedMachine): Promise<void>;
  list(): Promise<readonly PersistedMachine[]>;
}

export class InMemoryMachineStore implements MachineStore {
  private readonly machines = new Map<string, PersistedMachine>();

  async upsert(machine: PersistedMachine): Promise<void> {
    this.machines.set(machine.identity.id, machine);
  }

  async list(): Promise<readonly PersistedMachine[]> {
    return [...this.machines.values()];
  }
}

export class PostgresMachineStore implements MachineStore {
  constructor(private readonly pool: Pool) {}

  async upsert(machine: PersistedMachine): Promise<void> {
    await this.pool.query(
      `INSERT INTO machines
        (id, name, platform, arch, agent_version, capabilities, policy_revision, last_seen_at, telemetry)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         platform = EXCLUDED.platform,
         arch = EXCLUDED.arch,
         agent_version = EXCLUDED.agent_version,
         capabilities = EXCLUDED.capabilities,
         policy_revision = EXCLUDED.policy_revision,
         last_seen_at = EXCLUDED.last_seen_at,
         telemetry = EXCLUDED.telemetry,
         updated_at = now()`,
      [
        machine.identity.id,
        machine.identity.name,
        machine.identity.platform,
        machine.identity.arch,
        machine.agentVersion,
        JSON.stringify(machine.capabilities),
        machine.policyRevision,
        machine.lastSeenAt,
        JSON.stringify(machine.telemetry),
      ],
    );
  }

  async list(): Promise<readonly PersistedMachine[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      platform: MachineIdentity['platform'];
      arch: MachineIdentity['arch'];
      agent_version: string;
      capabilities: PersistedMachine['capabilities'];
      policy_revision: string;
      last_seen_at: Date | string;
      telemetry: MachineTelemetry | null;
    }>(
      `SELECT id, name, platform, arch, agent_version, capabilities, policy_revision, last_seen_at, telemetry
       FROM machines ORDER BY name ASC, id ASC`,
    );
    return result.rows.map((row) => ({
      identity: { id: row.id, name: row.name, platform: row.platform, arch: row.arch },
      agentVersion: row.agent_version,
      capabilities: row.capabilities,
      policyRevision: row.policy_revision,
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      telemetry: row.telemetry,
    }));
  }
}

export interface MachineHubOptions {
  readonly store?: MachineStore;
  readonly agentToken?: string;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly helloTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ActiveMachineSession {
  readonly machineId: string;
  readonly socket: WebSocket;
  readonly connectedAt: number;
  lastHeartbeatReceivedAt: number | undefined;
  lastSequence: number;
}

const SESSION_REPLACED_CLOSE_CODE = 4001;
const SESSION_REPLACED_CLOSE_REASON = 'replaced_by_new_session';

export class MachineHub {
  readonly store: MachineStore;
  readonly heartbeatIntervalMs: number;
  private readonly agentToken?: string;
  private readonly staleAfterMs: number;
  private readonly helloTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ActiveMachineSession>();

  constructor(options: MachineHubOptions = {}) {
    this.store = options.store ?? new InMemoryMachineStore();
    this.agentToken = options.agentToken;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? AGENT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.heartbeatIntervalMs * 2;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  authenticate(request: IncomingMessage): boolean {
    if (!this.agentToken) return false;
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined || !value.startsWith('Bearer ')) return false;
    return timingSafeStringEqual(value.slice('Bearer '.length), this.agentToken);
  }

  getActiveSession(machineId: string): ActiveMachineSession | undefined {
    return this.sessions.get(machineId);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async list(): Promise<ReturnType<typeof machinesResponseSchema.parse>> {
    const records = await this.store.list();
    const response = {
      machines: records.map((record) =>
        machineSummarySchema.parse({
          ...record,
          status: this.statusFor(record.identity.id),
        }),
      ),
    };
    return machinesResponseSchema.parse(response);
  }

  handleSocket(socket: WebSocket): void {
    const state = {
      helloReceived: false,
      machineId: undefined as string | undefined,
      session: undefined as ActiveMachineSession | undefined,
      helloTimer: undefined as NodeJS.Timeout | undefined,
    };
    let messageQueue = Promise.resolve();
    state.helloTimer = setTimeout(() => {
      if (!state.helloReceived) {
        this.reject(socket, 'hello_required', 'Agent hello was not received before timeout');
      }
    }, this.helloTimeoutMs);

    socket.on('message', (data, isBinary) => {
      messageQueue = messageQueue.then(() => this.processMessage(socket, data, isBinary, state));
      void messageQueue.catch(() =>
        this.reject(socket, 'invalid_message', 'Agent message could not be processed'),
      );
    });
    socket.on('close', () => {
      if (state.helloTimer) clearTimeout(state.helloTimer);
      const session = state.session;
      if (session && this.sessions.get(session.machineId)?.socket === socket) {
        this.sessions.delete(session.machineId);
      }
    });
  }

  private async processMessage(
    socket: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
    state: {
      helloReceived: boolean;
      machineId: string | undefined;
      session: ActiveMachineSession | undefined;
      helloTimer: NodeJS.Timeout | undefined;
    },
  ): Promise<void> {
    const raw = isBinary ? Buffer.from(data as Buffer) : Buffer.from(data.toString());
    if (raw.byteLength > AGENT_MAX_MESSAGE_BYTES) {
      this.reject(socket, 'message_too_large', 'Agent message exceeds the size limit');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      this.reject(socket, 'invalid_message', 'Agent message must be valid JSON');
      return;
    }
    const protocolVersion =
      value && typeof value === 'object' && 'protocolVersion' in value
        ? (value as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (protocolVersion !== AGENT_PROTOCOL_VERSION) {
      this.reject(socket, 'unsupported_protocol', 'Unsupported Agent protocol version');
      return;
    }
    const parsed = agentClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.reject(socket, 'invalid_message', 'Agent message failed protocol validation');
      return;
    }
    const message = parsed.data;
    if (message.type === 'agent.hello') {
      if (state.helloReceived) {
        this.reject(socket, 'duplicate_hello', 'Agent hello may only be sent once per connection');
        return;
      }
      const records = await this.store.list();
      const existing = records.find((record) => record.identity.id === message.machine.id);
      const persisted: PersistedMachine = {
        identity: message.machine,
        agentVersion: message.agentVersion,
        capabilities: message.capabilities,
        policyRevision: message.policyRevision,
        lastSeenAt: existing?.lastSeenAt ?? new Date(this.now()).toISOString(),
        telemetry: existing?.telemetry ?? null,
      };
      try {
        await this.store.upsert(persisted);
      } catch {
        this.reject(socket, 'invalid_identity', 'Machine could not be persisted');
        return;
      }
      const session: ActiveMachineSession = {
        machineId: message.machine.id,
        socket,
        connectedAt: this.now(),
        lastHeartbeatReceivedAt: undefined,
        lastSequence: 0,
      };
      if (state.helloTimer) clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
      const replaced = this.sessions.get(session.machineId);
      this.sessions.set(session.machineId, session);
      state.helloReceived = true;
      state.machineId = session.machineId;
      state.session = session;
      if (replaced && replaced.socket !== socket && replaced.socket.readyState === WebSocket.OPEN) {
        replaced.socket.close(SESSION_REPLACED_CLOSE_CODE, SESSION_REPLACED_CLOSE_REASON);
      }
      this.send(
        socket,
        agentHelloAcceptedSchema.parse({
          type: 'agent.hello.accepted',
          protocolVersion: AGENT_PROTOCOL_VERSION,
          serverTime: new Date(this.now()).toISOString(),
          heartbeatIntervalMs: this.heartbeatIntervalMs,
        }),
      );
      return;
    }
    if (!state.helloReceived || !state.machineId || !state.session) {
      this.reject(socket, 'hello_required', 'Agent hello is required before heartbeat');
      return;
    }
    if (message.sequence <= state.session.lastSequence) {
      this.reject(socket, 'non_monotonic_sequence', 'Heartbeat sequence must increase');
      return;
    }
    state.session.lastSequence = message.sequence;
    state.session.lastHeartbeatReceivedAt = this.now();
    try {
      await this.updateHeartbeat(state.machineId, message);
    } catch {
      this.reject(socket, 'invalid_telemetry', 'Telemetry could not be persisted');
    }
  }

  private async updateHeartbeat(
    machineId: string,
    message: Extract<AgentClientMessage, { type: 'agent.heartbeat' }>,
  ): Promise<void> {
    const records = await this.store.list();
    const current = records.find((record) => record.identity.id === machineId);
    if (!current) throw new Error('machine identity was not registered');
    await this.store.upsert({
      ...current,
      lastSeenAt: new Date(this.now()).toISOString(),
      telemetry: message.telemetry,
    });
  }

  private statusFor(machineId: string): MachineSummary['status'] {
    const session = this.sessions.get(machineId);
    if (!session) return 'OFFLINE';
    if (session.lastHeartbeatReceivedAt === undefined) return 'STALE';
    const age = Math.max(0, this.now() - session.lastHeartbeatReceivedAt);
    return age <= this.staleAfterMs ? 'ONLINE' : 'STALE';
  }

  private reject(
    socket: WebSocket,
    code: Parameters<typeof this.protocolError>[0],
    message: string,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    this.send(socket, this.protocolError(code, message));
    socket.close(1008, code);
  }

  private protocolError(code: AgentProtocolError['code'], message: string) {
    return agentProtocolErrorSchema.parse({
      type: 'agent.protocol.error',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      code,
      message,
    });
  }

  private send(socket: WebSocket, message: object): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

export function createAgentWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: AGENT_MAX_MESSAGE_BYTES });
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
