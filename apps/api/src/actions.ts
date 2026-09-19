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
    if (this.actions.has(action.actionId)) throw new Error('action already exists');
    this.actions.set(action.actionId, action);
  }

  async get(actionId: string): Promise<MachineActionRecord | undefined> {
    return this.actions.get(actionId);
  }

  async update(action: MachineActionRecord): Promise<void> {
    const current = this.actions.get(action.actionId);
    if (!current) throw new Error('action does not exist');
    if (isTerminal(current.status)) throw new Error('terminal action is immutable');
    this.actions.set(action.actionId, action);
  }

  async listForMachine(machineId: string): Promise<readonly MachineActionRecord[]> {
    return [...this.actions.values()]
      .filter((action) => action.machineId === machineId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }
}

export class PostgresMachineActionStore implements MachineActionStore {
  constructor(private readonly pool: Pool) {}

  async create(action: MachineActionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO machine_actions
        (action_id, machine_id, kind, target_id, status, policy_revision, requested_at, started_at, completed_at, result, error)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb)`,
      [
        action.actionId,
        action.machineId,
        action.kind,
        action.targetId,
        action.status,
        action.policyRevision,
        action.requestedAt,
        action.startedAt ?? null,
        action.completedAt ?? null,
        action.result ? JSON.stringify(action.result) : null,
        action.error ? JSON.stringify(action.error) : null,
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
    const result = await this.pool.query(
      `UPDATE machine_actions SET
        status = $2,
        policy_revision = $3,
        requested_at = $4::timestamptz,
        started_at = $5::timestamptz,
        completed_at = $6::timestamptz,
        result = $7::jsonb,
        error = $8::jsonb
       WHERE action_id = $1::uuid
         AND status IN ('PENDING', 'RUNNING')`,
      [
        action.actionId,
        action.status,
        action.policyRevision,
        action.requestedAt,
        action.startedAt ?? null,
        action.completedAt ?? null,
        action.result ? JSON.stringify(action.result) : null,
        action.error ? JSON.stringify(action.error) : null,
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
