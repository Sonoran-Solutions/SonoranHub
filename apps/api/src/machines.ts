import type { IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_MAX_MESSAGE_BYTES,
  AGENT_PROTOCOL_VERSION,
  agentClientMessageSchema,
  agentHelloAcceptedSchema,
  agentProtocolErrorSchema,
  machineActionCatalogSchema,
  machineActionInputSchema,
  machineActionRecordSchema,
  machineConnectionStatusSchema,
  machineSummarySchema,
  machinesResponseSchema,
  type AgentClientMessage,
  type AgentActionResult,
  type AgentProtocolError,
  type MachineIdentity,
  type MachineActionCatalog,
  type MachineActionInput,
  type MachineActionRecord,
  type MachineActionStatus,
  type MachineConnectionStatus,
  type MachineSummary,
  type MachineTelemetry,
} from '@sonoran-hub/contracts';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';

import {
  InMemoryMachineActionStore,
  isValidMachineActionTransition,
  type MachineActionStore,
} from './actions.js';

export interface PersistedMachine {
  readonly identity: MachineIdentity;
  readonly protocolVersion: number;
  readonly agentVersion: string;
  readonly capabilities: MachineSummary['capabilities'];
  readonly policyRevision: string;
  readonly actionCatalog: MachineActionCatalog;
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
        (id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, action_catalog, last_seen_at, telemetry)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::timestamptz, $11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         platform = EXCLUDED.platform,
         arch = EXCLUDED.arch,
         protocol_version = EXCLUDED.protocol_version,
         agent_version = EXCLUDED.agent_version,
         capabilities = EXCLUDED.capabilities,
         policy_revision = EXCLUDED.policy_revision,
         action_catalog = EXCLUDED.action_catalog,
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
        JSON.stringify(machine.actionCatalog),
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
      action_catalog: MachineActionCatalog;
      last_seen_at: Date | string;
      telemetry: MachineTelemetry | null;
    }>(
      `SELECT id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, action_catalog, last_seen_at, telemetry
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
      action_catalog: MachineActionCatalog;
      last_seen_at: Date | string;
      telemetry: MachineTelemetry | null;
    }>(
      `SELECT id, name, platform, arch, protocol_version, agent_version, capabilities, policy_revision, action_catalog, last_seen_at, telemetry
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
  action_catalog: MachineActionCatalog;
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
    actionCatalog: machineActionCatalogSchema.parse(row.action_catalog),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    telemetry: row.telemetry,
  };
}

export interface MachineHubOptions {
  readonly store?: MachineStore;
  readonly actionStore?: MachineActionStore;
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
  | 'agent.online'
  | 'agent.action_requested'
  | 'agent.action_accepted'
  | 'agent.action_denied'
  | 'agent.action_succeeded'
  | 'agent.action_failed'
  | 'agent.action_timed_out'
  | 'agent.action_interrupted';

export interface MachineAuditEvent {
  readonly type: MachineAuditEventType;
  readonly timestamp: string;
  readonly machineId?: string;
  readonly machineName?: string;
  readonly agentVersion?: string;
  readonly protocolVersion?: number;
  readonly policyRevision?: string;
  readonly capabilities?: readonly string[];
  readonly actionId?: string;
  readonly actionKind?: string;
  readonly targetId?: string;
  readonly actionStatus?: MachineActionStatus;
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
  actionCatalog: MachineActionCatalog | undefined;
  session: ActiveMachineSession | undefined;
  helloTimer: NodeJS.Timeout | undefined;
  terminal: boolean;
  closeReason: string | undefined;
  disconnectedEventEmitted: boolean;
}

export class MachineHub {
  readonly store: MachineStore;
  readonly actionStore: MachineActionStore;
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
  private readonly pendingActions = new Map<
    string,
    { readonly machineId: string; readonly socket: WebSocket; readonly timer: NodeJS.Timeout }
  >();
  private readonly actionReservations = new Set<string>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: MachineHubOptions = {}) {
    this.store = options.store ?? new InMemoryMachineStore();
    this.actionStore = options.actionStore ?? new InMemoryMachineActionStore();
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

  async getAction(actionId: string): Promise<MachineActionRecord | undefined> {
    return this.actionStore.get(actionId);
  }

  async listActions(machineId: string): Promise<readonly MachineActionRecord[]> {
    const machine = await this.store.get(machineId);
    if (!machine)
      throw new MachineActionDispatchError('machine_not_found', 'Machine was not found');
    return this.actionStore.listForMachine(machineId);
  }

  async requestAction(machineId: string, input: MachineActionInput): Promise<MachineActionRecord> {
    const action = machineActionInputSchema.parse(input);
    const machine = await this.store.get(machineId);
    if (!machine)
      throw new MachineActionDispatchError('machine_not_found', 'Machine was not found');
    const session = this.sessions.get(machineId);
    const state = session ? this.connectionStates.get(session.socket) : undefined;
    if (!session || !state) {
      throw new MachineActionDispatchError('machine_offline', 'Machine is not online');
    }
    const currentStatus = this.statusForSession(session);
    this.transitionStatus(session, currentStatus);
    if (currentStatus !== 'ONLINE') {
      throw new MachineActionDispatchError('machine_offline', 'Machine is not online');
    }
    if (!state.policyRevision) {
      throw new MachineActionDispatchError('machine_offline', 'Machine policy is unavailable');
    }
    const capability = action.kind === 'repo.status' ? 'repo.read' : 'service.restart.allowed';
    const catalog = state.actionCatalog;
    const targets = action.kind === 'repo.status' ? catalog?.repositories : catalog?.services;
    if (
      !state.capabilities?.includes(capability) ||
      !targets?.some((target) => target.id === action.targetId)
    ) {
      throw new MachineActionDispatchError('target_not_found', 'Action target is not advertised');
    }
    if (
      this.actionReservations.has(machineId) ||
      [...this.pendingActions.values()].some((pending) => pending.machineId === machineId)
    ) {
      throw new MachineActionDispatchError('action_busy', 'Machine already has an active action');
    }

    this.actionReservations.add(machineId);
    try {
      const requestedAt = new Date(this.now()).toISOString();
      const actionId = randomUUID();
      const deadlineAt = new Date(this.now() + actionTimeoutMs(action.kind)).toISOString();
      const record: MachineActionRecord = {
        actionId,
        machineId,
        kind: action.kind,
        targetId: action.targetId,
        status: 'PENDING',
        policyRevision: state.policyRevision,
        requestedAt,
      };
      await this.actionStore.create(record);
      const timer = setTimeout(
        () => void this.timeoutAction(actionId),
        actionTimeoutMs(action.kind) + 100,
      );
      this.pendingActions.set(actionId, { machineId, socket: session.socket, timer });
      this.emitEvent({
        type: 'agent.action_requested',
        actionId,
        actionKind: action.kind,
        targetId: action.targetId,
        actionStatus: 'PENDING',
        policyRevision: state.policyRevision,
        machineId,
      });
      this.send(session.socket, {
        type: 'agent.action.request',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        actionId,
        policyRevision: state.policyRevision,
        deadlineAt,
        action,
      });
      return record;
    } catch (error) {
      this.actionReservations.delete(machineId);
      throw error;
    }
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
      actionCatalog: undefined,
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
        actionCatalog: message.actionCatalog,
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
      if (replaced && replacedState) {
        replacedState.terminal = true;
        replacedState.closeReason = SESSION_REPLACED_CLOSE_REASON;
        await this.interruptActionsForSocket(replaced.socket);
      }
      this.sessions.set(session.machineId, session);
      state.helloReceived = true;
      state.machineId = session.machineId;
      state.machineName = message.machine.name;
      state.agentVersion = message.agentVersion;
      state.protocolVersion = message.protocolVersion;
      state.policyRevision = message.policyRevision;
      state.capabilities = message.capabilities;
      state.actionCatalog = message.actionCatalog;
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
    if (message.type === 'agent.action.accepted') {
      await this.handleActionAccepted(socket, state, message);
      return;
    }
    if (message.type === 'agent.action.result') {
      await this.handleActionResult(socket, state, message);
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

  private async handleActionAccepted(
    socket: WebSocket,
    state: ConnectionState,
    message: Extract<AgentClientMessage, { type: 'agent.action.accepted' }>,
  ): Promise<void> {
    const pending = this.pendingActions.get(message.actionId);
    if (!pending || pending.socket !== socket || pending.machineId !== state.machineId) {
      this.reject(socket, 'unknown_action', 'Action correlation is not known');
      return;
    }
    const action = await this.actionStore.get(message.actionId);
    if (!action || action.status !== 'PENDING') {
      this.reject(socket, 'invalid_action_transition', 'Action acceptance is not valid');
      return;
    }
    try {
      await this.transitionAction(action, 'RUNNING', { startedAt: message.acceptedAt });
    } catch {
      this.reject(socket, 'invalid_action_transition', 'Action acceptance is not valid');
    }
  }

  private async handleActionResult(
    socket: WebSocket,
    state: ConnectionState,
    message: AgentActionResult,
  ): Promise<void> {
    const pending = this.pendingActions.get(message.actionId);
    if (!pending || pending.socket !== socket || pending.machineId !== state.machineId) {
      this.reject(socket, 'unknown_action', 'Action correlation is not known');
      return;
    }
    const action = await this.actionStore.get(message.actionId);
    if (
      !action ||
      action.kind !== message.kind ||
      action.targetId !== message.targetId ||
      action.policyRevision !== message.policyRevision ||
      state.policyRevision !== message.policyRevision ||
      (message.result !== undefined &&
        (message.result.kind !== message.kind || message.result.targetId !== message.targetId)) ||
      action.status === 'SUCCEEDED' ||
      action.status === 'DENIED' ||
      action.status === 'FAILED' ||
      action.status === 'TIMED_OUT' ||
      action.status === 'INTERRUPTED'
    ) {
      this.reject(socket, 'invalid_action_transition', 'Action result is not valid');
      return;
    }
    if (
      (action.status === 'PENDING' && message.status !== 'denied') ||
      (action.status === 'RUNNING' && message.status === 'denied')
    ) {
      this.reject(socket, 'invalid_action_transition', 'Action result is not valid');
      return;
    }
    const status = resultStatusToMachineStatus(message.status);
    try {
      await this.transitionAction(action, status, {
        completedAt: message.completedAt,
        ...(message.result ? { result: message.result } : {}),
        ...(message.error ? { error: message.error } : {}),
      });
    } catch {
      this.reject(socket, 'invalid_action_transition', 'Action result is not valid');
    }
  }

  private async transitionAction(
    action: MachineActionRecord,
    status: MachineActionStatus,
    fields: Partial<
      Pick<MachineActionRecord, 'startedAt' | 'completedAt' | 'result' | 'error'>
    > = {},
  ): Promise<void> {
    if (!isValidMachineActionTransition(action.status, status)) {
      throw new Error('invalid action transition');
    }
    const next = machineActionRecordSchema.parse({ ...action, ...fields, status });
    await this.actionStore.update(next);
    if (isTerminalActionStatus(status)) {
      this.clearPendingAction(action.actionId);
    }
    const eventType = actionEventType(status);
    if (eventType) {
      this.emitEvent({
        type: eventType,
        actionId: next.actionId,
        actionKind: next.kind,
        targetId: next.targetId,
        actionStatus: next.status,
        policyRevision: next.policyRevision,
        machineId: next.machineId,
        ...(next.error ? { reason: next.error.code } : {}),
      });
    }
  }

  private async timeoutAction(actionId: string): Promise<void> {
    const action = await this.actionStore.get(actionId);
    if (!action || !isActiveActionStatus(action.status)) return;
    try {
      await this.transitionAction(action, 'TIMED_OUT', {
        completedAt: new Date(this.now()).toISOString(),
        error: { code: 'process_timeout', message: 'Action deadline expired at the Hub' },
      });
    } catch {
      // A terminal Agent result may have won the race with the timeout timer.
    }
  }

  private clearPendingAction(actionId: string): void {
    const pending = this.pendingActions.get(actionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingActions.delete(actionId);
    this.actionReservations.delete(pending.machineId);
  }

  private async interruptActionsForSocket(socket: WebSocket): Promise<void> {
    const candidates = [...this.pendingActions.entries()].filter(
      ([, pending]) => pending.socket === socket,
    );
    for (const [actionId] of candidates) {
      const action = await this.actionStore.get(actionId);
      if (!action || !isActiveActionStatus(action.status)) continue;
      try {
        await this.transitionAction(action, 'INTERRUPTED', {
          completedAt: new Date(this.now()).toISOString(),
          error: {
            code: 'interrupted',
            message: 'Action interrupted because the Agent disconnected',
          },
        });
      } catch {
        // A terminal result may have won the disconnect race.
      }
    }
  }

  private async interruptAllActions(): Promise<void> {
    const candidates = [...this.pendingActions.keys()];
    for (const actionId of candidates) {
      const action = await this.actionStore.get(actionId);
      if (!action || !isActiveActionStatus(action.status)) continue;
      try {
        await this.transitionAction(action, 'INTERRUPTED', {
          completedAt: new Date(this.now()).toISOString(),
          error: { code: 'interrupted', message: 'Action interrupted by Hub shutdown' },
        });
      } catch {
        // A terminal result may have won the shutdown race.
      }
    }
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
    const interrupted = this.interruptAllActions();
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
    let closeGraceTimer: NodeJS.Timeout | undefined;
    let interruptGraceTimer: NodeJS.Timeout | undefined;
    const closeGracePeriod = new Promise<void>((resolve) => {
      closeGraceTimer = setTimeout(resolve, this.shutdownGraceMs);
    });
    const interruptGracePeriod = new Promise<void>((resolve) => {
      interruptGraceTimer = setTimeout(resolve, this.shutdownGraceMs);
    });
    await Promise.all([
      Promise.race([closeWait, closeGracePeriod]),
      Promise.race([interrupted, interruptGracePeriod]),
    ]);
    if (closeGraceTimer) clearTimeout(closeGraceTimer);
    if (interruptGraceTimer) clearTimeout(interruptGraceTimer);
    for (const socket of [...this.connections]) {
      socket.terminate();
    }
    for (const [socket, state] of this.connectionStates) {
      this.detachSession(socket, state, HUB_SHUTDOWN_CLOSE_REASON);
    }
    this.connections.clear();
    this.connectionStates.clear();
    this.sessions.clear();
    this.pendingActions.clear();
    this.actionReservations.clear();
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
      void this.interruptActionsForSocket(socket);
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

export type MachineActionDispatchErrorCode =
  'machine_not_found' | 'machine_offline' | 'target_not_found' | 'action_busy';

export class MachineActionDispatchError extends Error {
  constructor(
    readonly code: MachineActionDispatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MachineActionDispatchError';
  }
}

function actionTimeoutMs(kind: MachineActionInput['kind']): number {
  return kind === 'repo.status' ? 10_000 : 20_000;
}

function resultStatusToMachineStatus(status: AgentActionResult['status']): MachineActionStatus {
  const statuses: Record<AgentActionResult['status'], MachineActionStatus> = {
    succeeded: 'SUCCEEDED',
    denied: 'DENIED',
    failed: 'FAILED',
    timed_out: 'TIMED_OUT',
  };
  return statuses[status];
}

function isTerminalActionStatus(status: MachineActionStatus): boolean {
  return ['SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'].includes(status);
}

function isActiveActionStatus(status: MachineActionStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

function actionEventType(
  status: MachineActionStatus,
): Extract<MachineAuditEventType, `agent.action_${string}`> | undefined {
  const eventTypes: Record<
    MachineActionStatus,
    Extract<MachineAuditEventType, `agent.action_${string}`> | undefined
  > = {
    RUNNING: 'agent.action_accepted',
    SUCCEEDED: 'agent.action_succeeded',
    DENIED: 'agent.action_denied',
    FAILED: 'agent.action_failed',
    TIMED_OUT: 'agent.action_timed_out',
    INTERRUPTED: 'agent.action_interrupted',
    PENDING: 'agent.action_requested',
  };
  return eventTypes[status];
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
