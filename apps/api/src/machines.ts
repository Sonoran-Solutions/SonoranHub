import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_MAX_MESSAGE_BYTES,
  AGENT_PROTOCOL_VERSION,
  agentClientMessageSchema,
  agentHelloAcceptedSchema,
  agentProtocolErrorSchema,
  machineConnectionStatusSchema,
  machineSummarySchema,
  machinesResponseSchema,
  type AgentClientMessage,
  type AgentProtocolError,
  type MachineIdentity,
  type MachineConnectionStatus,
  type MachineSummary,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';

export interface PersistedMachine {
  readonly identity: MachineIdentity;
  readonly protocolVersion: number;
  readonly agentVersion: string;
  readonly capabilities: MachineSummary['capabilities'];
  readonly policyRevision: string;
  readonly lastSeenAt: string;
  readonly telemetry: MachineTelemetry | null;
}

export interface MachineStore {
  upsert(machine: PersistedMachine): Promise<void>;
  get(machineId: string): Promise<PersistedMachine | undefined>;
  list(): Promise<readonly PersistedMachine[]>;
}

export class InMemoryMachineStore implements MachineStore {
  private readonly machines = new Map<string, PersistedMachine>();

  async upsert(machine: PersistedMachine): Promise<void> {
    this.machines.set(machine.identity.id, machine);
  }

  async get(machineId: string): Promise<PersistedMachine | undefined> {
    return this.machines.get(machineId);
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
        (id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, last_seen_at, telemetry)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, $10::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         platform = EXCLUDED.platform,
         arch = EXCLUDED.arch,
         protocol_version = EXCLUDED.protocol_version,
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
        machine.protocolVersion,
        machine.agentVersion,
        JSON.stringify(machine.capabilities),
        machine.policyRevision,
        machine.lastSeenAt,
        JSON.stringify(machine.telemetry),
      ],
    );
  }

  async get(machineId: string): Promise<PersistedMachine | undefined> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      platform: MachineIdentity['platform'];
      arch: MachineIdentity['arch'];
      protocol_version: number;
      agent_version: string;
      capabilities: PersistedMachine['capabilities'];
      policy_revision: string;
      last_seen_at: Date | string;
      telemetry: MachineTelemetry | null;
    }>(
      `SELECT id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, last_seen_at, telemetry
       FROM machines WHERE id = $1`,
      [machineId],
    );
    const row = result.rows[0];
    return row ? mapPersistedMachine(row) : undefined;
  }

  async list(): Promise<readonly PersistedMachine[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      platform: MachineIdentity['platform'];
      arch: MachineIdentity['arch'];
      protocol_version: number;
      agent_version: string;
      capabilities: PersistedMachine['capabilities'];
      policy_revision: string;
      last_seen_at: Date | string;
      telemetry: MachineTelemetry | null;
    }>(
      `SELECT id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, last_seen_at, telemetry
       FROM machines ORDER BY name ASC, id ASC`,
    );
    return result.rows.map(mapPersistedMachine);
  }
}

interface PersistedMachineRow {
  id: string;
  name: string;
  platform: MachineIdentity['platform'];
  arch: MachineIdentity['arch'];
  protocol_version: number;
  agent_version: string;
  capabilities: PersistedMachine['capabilities'];
  policy_revision: string;
  last_seen_at: Date | string;
  telemetry: MachineTelemetry | null;
}

function mapPersistedMachine(row: PersistedMachineRow): PersistedMachine {
  return {
    identity: { id: row.id, name: row.name, platform: row.platform, arch: row.arch },
    protocolVersion: row.protocol_version,
    agentVersion: row.agent_version,
    capabilities: row.capabilities,
    policyRevision: row.policy_revision,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    telemetry: row.telemetry,
  };
}

export interface MachineHubOptions {
  readonly store?: MachineStore;
  readonly agentToken?: string;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly helloTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly eventSink?: MachineEventSink;
  readonly now?: () => number;
}

export type MachineAuditEventType =
  | 'agent.authentication_failed'
  | 'agent.connected'
  | 'agent.hello_accepted'
  | 'agent.protocol_rejected'
  | 'agent.session_replaced'
  | 'agent.disconnected'
  | 'agent.stale'
  | 'agent.online';

export interface MachineAuditEvent {
  readonly type: MachineAuditEventType;
  readonly timestamp: string;
  readonly machineId?: string;
  readonly machineName?: string;
  readonly agentVersion?: string;
  readonly protocolVersion?: number;
  readonly policyRevision?: string;
  readonly capabilities?: readonly string[];
  readonly reason?: string;
}

export interface MachineEventSink {
  emit(event: MachineAuditEvent): void;
}

export interface ActiveMachineSession {
  readonly machineId: string;
  readonly socket: WebSocket;
  readonly connectedAt: number;
  lastHeartbeatReceivedAt: number | undefined;
  lastSequence: number;
  status: MachineConnectionStatus;
}

const SESSION_REPLACED_CLOSE_CODE = 4001;
const SESSION_REPLACED_CLOSE_REASON = 'replaced_by_new_session';
const HUB_SHUTDOWN_CLOSE_CODE = 4002;
const HUB_SHUTDOWN_CLOSE_REASON = 'hub_shutdown';
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const NOOP_EVENT_SINK: MachineEventSink = { emit: () => undefined };

interface ConnectionState {
  helloReceived: boolean;
  machineId: string | undefined;
  machineName: string | undefined;
  agentVersion: string | undefined;
  protocolVersion: number | undefined;
  policyRevision: string | undefined;
  capabilities: readonly string[] | undefined;
  session: ActiveMachineSession | undefined;
  helloTimer: NodeJS.Timeout | undefined;
  terminal: boolean;
  closeReason: string | undefined;
  disconnectedEventEmitted: boolean;
}

export class MachineHub {
  readonly store: MachineStore;
  readonly heartbeatIntervalMs: number;
  private readonly agentToken?: string;
  private readonly staleAfterMs: number;
  private readonly helloTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly eventSink: MachineEventSink;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ActiveMachineSession>();
  private readonly connections = new Set<WebSocket>();
  private readonly connectionStates = new Map<WebSocket, ConnectionState>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: MachineHubOptions = {}) {
    this.store = options.store ?? new InMemoryMachineStore();
    this.agentToken = options.agentToken;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? AGENT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.heartbeatIntervalMs * 2;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.eventSink = options.eventSink ?? NOOP_EVENT_SINK;
    this.now = options.now ?? Date.now;
  }

  authenticate(request: IncomingMessage): boolean {
    if (!this.agentToken) {
      this.emitEvent({ type: 'agent.authentication_failed', reason: 'hub_token_not_configured' });
      return false;
    }
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined || !value.startsWith('Bearer ')) {
      this.emitEvent({ type: 'agent.authentication_failed', reason: 'invalid_authorization' });
      return false;
    }
    const authenticated = timingSafeStringEqual(value.slice('Bearer '.length), this.agentToken);
    if (!authenticated) {
      this.emitEvent({ type: 'agent.authentication_failed', reason: 'invalid_token' });
    }
    return authenticated;
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

  async close(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.closeConnections();
    return this.shutdownPromise;
  }

  handleSocket(socket: WebSocket): void {
    const state: ConnectionState = {
      helloReceived: false,
      machineId: undefined as string | undefined,
      machineName: undefined,
      agentVersion: undefined,
      protocolVersion: undefined,
      policyRevision: undefined,
      capabilities: undefined,
      session: undefined as ActiveMachineSession | undefined,
      helloTimer: undefined as NodeJS.Timeout | undefined,
      terminal: this.shuttingDown,
      closeReason: this.shuttingDown ? HUB_SHUTDOWN_CLOSE_REASON : undefined,
      disconnectedEventEmitted: false,
    };
    if (this.shuttingDown) {
      this.closeSocket(socket, HUB_SHUTDOWN_CLOSE_CODE, HUB_SHUTDOWN_CLOSE_REASON);
      return;
    }
    this.connections.add(socket);
    this.connectionStates.set(socket, state);
    this.emitEvent({ type: 'agent.connected' });
    let messageQueue = Promise.resolve();
    state.helloTimer = setTimeout(() => {
      if (!state.helloReceived && !state.terminal) {
        this.reject(socket, 'hello_required', 'Agent hello was not received before timeout');
      }
    }, this.helloTimeoutMs);

    socket.on('message', (data, isBinary) => {
      if (state.terminal || this.shuttingDown) return;
      messageQueue = messageQueue.then(() => this.processMessage(socket, data, isBinary, state));
      void messageQueue.catch(() =>
        this.reject(socket, 'invalid_message', 'Agent message could not be processed'),
      );
    });
    socket.on('close', () => {
      this.cleanupConnection(socket, state);
    });
  }

  private async processMessage(
    socket: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
    state: ConnectionState,
  ): Promise<void> {
    if (state.terminal || this.shuttingDown) return;
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
      const existing = await this.store.get(message.machine.id);
      if (state.terminal || this.shuttingDown) return;
      const persisted: PersistedMachine = {
        identity: message.machine,
        protocolVersion: message.protocolVersion,
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
        status: machineConnectionStatusSchema.parse('STALE'),
      };
      if (state.helloTimer) clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
      const replaced = this.sessions.get(session.machineId);
      const replacedState = replaced ? this.connectionStates.get(replaced.socket) : undefined;
      if (replacedState) {
        replacedState.terminal = true;
        replacedState.closeReason = SESSION_REPLACED_CLOSE_REASON;
      }
      this.sessions.set(session.machineId, session);
      state.helloReceived = true;
      state.machineId = session.machineId;
      state.machineName = message.machine.name;
      state.agentVersion = message.agentVersion;
      state.protocolVersion = message.protocolVersion;
      state.policyRevision = message.policyRevision;
      state.capabilities = message.capabilities;
      state.session = session;
      if (replaced && replaced.socket !== socket) {
        if (replaced.socket.readyState === WebSocket.OPEN) {
          replaced.socket.close(SESSION_REPLACED_CLOSE_CODE, SESSION_REPLACED_CLOSE_REASON);
        }
        this.emitEvent({
          type: 'agent.session_replaced',
          ...this.sessionMetadata(session),
          reason: SESSION_REPLACED_CLOSE_REASON,
        });
      }
      this.emitEvent({ type: 'agent.hello_accepted', ...this.sessionMetadata(session) });
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
    if (state.terminal || this.shuttingDown) return;
    if (!state.helloReceived || !state.machineId || !state.session) {
      this.reject(socket, 'hello_required', 'Agent hello is required before heartbeat');
      return;
    }
    if (message.sequence <= state.session.lastSequence) {
      this.reject(socket, 'non_monotonic_sequence', 'Heartbeat sequence must increase');
      return;
    }
    try {
      await this.updateHeartbeat(state.machineId, message);
    } catch {
      this.reject(socket, 'invalid_telemetry', 'Telemetry could not be persisted');
      return;
    }
    if (state.terminal || this.shuttingDown) return;
    state.session.lastSequence = message.sequence;
    state.session.lastHeartbeatReceivedAt = this.now();
    this.transitionStatus(state.session, this.statusForSession(state.session));
  }

  private async updateHeartbeat(
    machineId: string,
    message: Extract<AgentClientMessage, { type: 'agent.heartbeat' }>,
  ): Promise<void> {
    const current = await this.store.get(machineId);
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
    const status = this.statusForSession(session);
    this.transitionStatus(session, status);
    return status;
  }

  private statusForSession(session: ActiveMachineSession): MachineConnectionStatus {
    if (session.lastHeartbeatReceivedAt === undefined) return 'STALE';
    const age = Math.max(0, this.now() - session.lastHeartbeatReceivedAt);
    return age <= this.staleAfterMs ? 'ONLINE' : 'STALE';
  }

  private transitionStatus(session: ActiveMachineSession, next: MachineConnectionStatus): void {
    if (session.status === next) return;
    session.status = next;
    if (next === 'ONLINE') {
      this.emitEvent({ type: 'agent.online', ...this.sessionMetadata(session) });
    } else if (next === 'STALE') {
      this.emitEvent({
        type: 'agent.stale',
        ...this.sessionMetadata(session),
        reason: 'heartbeat_timeout',
      });
    }
  }

  private sessionMetadata(session: ActiveMachineSession) {
    const state = this.connectionStates.get(session.socket);
    return {
      machineId: session.machineId,
      ...(state?.machineName === undefined ? {} : { machineName: state.machineName }),
      ...(state?.agentVersion === undefined ? {} : { agentVersion: state.agentVersion }),
      ...(state?.protocolVersion === undefined ? {} : { protocolVersion: state.protocolVersion }),
      ...(state?.policyRevision === undefined ? {} : { policyRevision: state.policyRevision }),
      ...(state?.capabilities === undefined ? {} : { capabilities: state.capabilities }),
    };
  }

  private emitEvent(event: Omit<MachineAuditEvent, 'timestamp'> & { timestamp?: string }): void {
    try {
      this.eventSink.emit({
        ...event,
        timestamp: event.timestamp ?? new Date(this.now()).toISOString(),
      });
    } catch {
      // Event sinks are observational and must never interrupt protocol handling.
    }
  }

  private async closeConnections(): Promise<void> {
    const sockets = [...this.connections];
    for (const socket of sockets) {
      const state = this.connectionStates.get(socket);
      if (state) {
        state.terminal = true;
        state.closeReason = HUB_SHUTDOWN_CLOSE_REASON;
        if (state.helloTimer) clearTimeout(state.helloTimer);
        state.helloTimer = undefined;
      }
      this.closeSocket(socket, HUB_SHUTDOWN_CLOSE_CODE, HUB_SHUTDOWN_CLOSE_REASON);
    }

    const closeWait = this.waitForConnections(sockets);
    let graceTimer: NodeJS.Timeout | undefined;
    const gracePeriod = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, this.shutdownGraceMs);
    });
    await Promise.race([closeWait, gracePeriod]);
    if (graceTimer) clearTimeout(graceTimer);
    for (const socket of [...this.connections]) {
      socket.terminate();
    }
    for (const [socket, state] of this.connectionStates) {
      this.detachSession(socket, state, HUB_SHUTDOWN_CLOSE_REASON);
    }
    this.connections.clear();
    this.connectionStates.clear();
    this.sessions.clear();
  }

  private async waitForConnections(sockets: readonly WebSocket[]): Promise<void> {
    while (sockets.some((socket) => this.connections.has(socket))) {
      await delay(10);
    }
  }

  private cleanupConnection(socket: WebSocket, state: ConnectionState): void {
    if (state.helloTimer) clearTimeout(state.helloTimer);
    state.helloTimer = undefined;
    this.detachSession(socket, state, state.closeReason ?? 'socket_closed');
    this.connections.delete(socket);
    this.connectionStates.delete(socket);
  }

  private detachSession(socket: WebSocket, state: ConnectionState, reason: string): void {
    const session = state.session;
    if (!session || state.disconnectedEventEmitted) return;
    if (this.sessions.get(session.machineId)?.socket === socket) {
      this.sessions.delete(session.machineId);
      state.disconnectedEventEmitted = true;
      this.emitEvent({
        type: 'agent.disconnected',
        ...this.sessionMetadata(session),
        reason,
      });
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  private reject(
    socket: WebSocket,
    code: Parameters<typeof this.protocolError>[0],
    message: string,
  ): void {
    const state = this.connectionStates.get(socket);
    if (!state || state.terminal) return;
    state.terminal = true;
    state.closeReason = code;
    this.emitEvent({
      type: 'agent.protocol_rejected',
      ...(state.machineId === undefined ? {} : { machineId: state.machineId }),
      ...(state.machineName === undefined ? {} : { machineName: state.machineName }),
      ...(state.agentVersion === undefined ? {} : { agentVersion: state.agentVersion }),
      ...(state.protocolVersion === undefined ? {} : { protocolVersion: state.protocolVersion }),
      ...(state.policyRevision === undefined ? {} : { policyRevision: state.policyRevision }),
      ...(state.capabilities === undefined ? {} : { capabilities: state.capabilities }),
      reason: code,
    });
    this.detachSession(socket, state, code);
    if (socket.readyState === WebSocket.OPEN) {
      this.send(socket, this.protocolError(code, message));
      socket.close(1008, code);
    }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
