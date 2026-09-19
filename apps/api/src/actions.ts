import {
  machineActionRecordSchema,
  type MachineActionRecord,
  type MachineActionStatus,
} from '@sonoran-hub/contracts';
import type { Pool } from 'pg';

export interface MachineActionStore {
  create(action: MachineActionRecord): Promise<void>;
  get(actionId: string): Promise<MachineActionRecord | undefined>;
  update(action: MachineActionRecord): Promise<void>;
  listForMachine(machineId: string): Promise<readonly MachineActionRecord[]>;
}

export class InMemoryMachineActionStore implements MachineActionStore {
  private readonly actions = new Map<string, MachineActionRecord>();

  async create(action: MachineActionRecord): Promise<void> {
    const parsed = machineActionRecordSchema.parse(action);
    if (parsed.status !== 'PENDING') throw new Error('new actions must start in PENDING state');
    if (this.actions.has(action.actionId)) throw new Error('action already exists');
    this.actions.set(action.actionId, parsed);
  }

  async get(actionId: string): Promise<MachineActionRecord | undefined> {
    const action = this.actions.get(actionId);
    return action ? machineActionRecordSchema.parse(action) : undefined;
  }

  async update(action: MachineActionRecord): Promise<void> {
    const current = this.actions.get(action.actionId);
    if (!current) throw new Error('action does not exist');
    assertActionUpdate(current, action);
    this.actions.set(action.actionId, machineActionRecordSchema.parse(action));
  }

  async listForMachine(machineId: string): Promise<readonly MachineActionRecord[]> {
    return [...this.actions.values()]
      .filter((action) => action.machineId === machineId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .map((action) => machineActionRecordSchema.parse(action));
  }
}

export class PostgresMachineActionStore implements MachineActionStore {
  constructor(private readonly pool: Pool) {}

  async create(action: MachineActionRecord): Promise<void> {
    const parsed = machineActionRecordSchema.parse(action);
    if (parsed.status !== 'PENDING') throw new Error('new actions must start in PENDING state');
    await this.pool.query(
      `INSERT INTO machine_actions
        (action_id, machine_id, kind, target_id, status, policy_revision, requested_at, started_at, completed_at, result, error)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb)`,
      [
        parsed.actionId,
        parsed.machineId,
        parsed.kind,
        parsed.targetId,
        parsed.status,
        parsed.policyRevision,
        parsed.requestedAt,
        parsed.startedAt ?? null,
        parsed.completedAt ?? null,
        parsed.result ? JSON.stringify(parsed.result) : null,
        parsed.error ? JSON.stringify(parsed.error) : null,
      ],
    );
  }

  async get(actionId: string): Promise<MachineActionRecord | undefined> {
    const result = await this.pool.query<ActionRow>(`${ACTION_SELECT} WHERE action_id = $1::uuid`, [
      actionId,
    ]);
    return result.rows[0] ? mapAction(result.rows[0]) : undefined;
  }

  async update(action: MachineActionRecord): Promise<void> {
    const current = await this.get(action.actionId);
    if (!current) throw new Error('action does not exist');
    assertActionUpdate(current, action);
    const parsed = machineActionRecordSchema.parse(action);
    const result = await this.pool.query(
      `UPDATE machine_actions SET
        status = $2,
        started_at = $3::timestamptz,
        completed_at = $4::timestamptz,
        result = $5::jsonb,
        error = $6::jsonb
       WHERE action_id = $1::uuid
         AND status = $7`,
      [
        parsed.actionId,
        parsed.status,
        parsed.startedAt ?? null,
        parsed.completedAt ?? null,
        parsed.result ? JSON.stringify(parsed.result) : null,
        parsed.error ? JSON.stringify(parsed.error) : null,
        current.status,
      ],
    );
    if (result.rowCount !== 1) throw new Error('action does not exist');
  }

  async listForMachine(machineId: string): Promise<readonly MachineActionRecord[]> {
    const result = await this.pool.query<ActionRow>(
      `${ACTION_SELECT} WHERE machine_id = $1 ORDER BY requested_at DESC, action_id DESC LIMIT 256`,
      [machineId],
    );
    return result.rows.map(mapAction);
  }
}

function isTerminal(status: MachineActionRecord['status']): boolean {
  return ['SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'].includes(status);
}

export function isValidMachineActionTransition(
  from: MachineActionRecord['status'],
  to: MachineActionRecord['status'],
): boolean {
  if (from === 'PENDING')
    return to === 'RUNNING' || ['DENIED', 'TIMED_OUT', 'INTERRUPTED'].includes(to);
  if (from === 'RUNNING') return ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'].includes(to);
  return false;
}

function assertActionUpdate(current: MachineActionRecord, next: MachineActionRecord): void {
  if (current.actionId !== next.actionId) throw new Error('action ID is immutable');
  if (
    current.machineId !== next.machineId ||
    current.kind !== next.kind ||
    current.targetId !== next.targetId ||
    current.policyRevision !== next.policyRevision ||
    current.requestedAt !== next.requestedAt
  ) {
    throw new Error('action identity is immutable');
  }
  if (isTerminal(current.status)) throw new Error('terminal action is immutable');
  if (!isValidMachineActionTransition(current.status, next.status)) {
    throw new Error('invalid action transition');
  }
}

interface ActionRow {
  action_id: string;
  machine_id: string;
  kind: MachineActionRecord['kind'];
  target_id: string;
  status: MachineActionStatus;
  policy_revision: string;
  requested_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  result: MachineActionRecord['result'] | null;
  error: MachineActionRecord['error'] | null;
}

const ACTION_SELECT = `SELECT action_id, machine_id, kind, target_id, status, policy_revision,
  requested_at, started_at, completed_at, result, error FROM machine_actions`;

function mapAction(row: ActionRow): MachineActionRecord {
  return machineActionRecordSchema.parse({
    actionId: row.action_id,
    machineId: row.machine_id,
    kind: row.kind,
    targetId: row.target_id,
    status: row.status,
    policyRevision: row.policy_revision,
    requestedAt: new Date(row.requested_at).toISOString(),
    ...(row.started_at ? { startedAt: new Date(row.started_at).toISOString() } : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
  });
}
