import { redactMetadata } from '@sonoran-hub/config';
import {
  capacitySnapshotSchema,
  capacityTimestampSchema,
  type CapacitySnapshot,
} from '@sonoran-hub/contracts';
import type { Pool, QueryResult, QueryResultRow } from 'pg';

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

export interface CapacitySnapshotHistoryOptions {
  readonly providerId?: string;
  readonly since?: string;
  readonly limit?: number;
}

export interface CapacitySnapshotStore {
  save(snapshot: CapacitySnapshot): Promise<void>;
  /** Returns one newest snapshot per provider, ordered by provider ID. */
  latest(providerId?: string): Promise<readonly CapacitySnapshot[]>;
  /** Returns immutable observations newest first. */
  history(options?: CapacitySnapshotHistoryOptions): Promise<readonly CapacitySnapshot[]>;
}

export class CapacitySnapshotValidationError extends Error {
  constructor(message = 'Capacity snapshot failed canonical validation') {
    super(message);
    this.name = 'CapacitySnapshotValidationError';
  }
}

export class CapacitySnapshotStoreError extends Error {
  constructor(message = 'Capacity snapshot storage operation failed') {
    super(message);
    this.name = 'CapacitySnapshotStoreError';
  }
}

function validateLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new CapacitySnapshotValidationError(
      `Capacity history limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`,
    );
  }
  return value;
}

function validateProviderId(providerId: string | undefined): string | undefined {
  if (providerId === undefined) {
    return undefined;
  }
  if (!providerId.trim()) {
    throw new CapacitySnapshotValidationError('Capacity provider ID must not be empty');
  }
  return providerId;
}

function validateSince(since: string | undefined): string | undefined {
  if (since === undefined) {
    return undefined;
  }
  if (!capacityTimestampSchema.safeParse(since).success) {
    throw new CapacitySnapshotValidationError('Capacity history since must be an ISO timestamp');
  }
  return since;
}

/** Validate and redact normalized metadata before it crosses the storage boundary. */
export function canonicalizeCapacitySnapshot(input: unknown): CapacitySnapshot {
  const parsed = capacitySnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new CapacitySnapshotValidationError();
  }

  const redacted = redactMetadata(parsed.data);
  const safe = capacitySnapshotSchema.safeParse(redacted);
  if (!safe.success) {
    throw new CapacitySnapshotValidationError();
  }
  return safe.data;
}

function compareSnapshots(left: CapacitySnapshot, right: CapacitySnapshot): number {
  const collected = right.collectedAt.localeCompare(left.collectedAt);
  if (collected !== 0) {
    return collected;
  }
  const created = (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
  if (created !== 0) {
    return created;
  }
  return right.id.localeCompare(left.id);
}

export class InMemoryCapacitySnapshotStore implements CapacitySnapshotStore {
  private readonly snapshots: CapacitySnapshot[] = [];

  async save(snapshot: CapacitySnapshot): Promise<void> {
    const safe = canonicalizeCapacitySnapshot(snapshot);
    if (this.snapshots.some((existing) => existing.id === safe.id)) {
      throw new CapacitySnapshotStoreError('Capacity snapshot ID already exists');
    }
    this.snapshots.push(safe);
  }

  async latest(providerId?: string): Promise<readonly CapacitySnapshot[]> {
    const requestedProvider = validateProviderId(providerId);
    const candidates = requestedProvider
      ? this.snapshots.filter((snapshot) => snapshot.provider === requestedProvider)
      : this.snapshots;
    const latestByProvider = new Map<string, CapacitySnapshot>();
    for (const snapshot of [...candidates].sort(compareSnapshots)) {
      if (!latestByProvider.has(snapshot.provider)) {
        latestByProvider.set(snapshot.provider, snapshot);
      }
    }
    return [...latestByProvider.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider),
    );
  }

  async history(
    options: CapacitySnapshotHistoryOptions = {},
  ): Promise<readonly CapacitySnapshot[]> {
    const providerId = validateProviderId(options.providerId);
    const since = validateSince(options.since);
    const limit = validateLimit(options.limit);
    const sinceTime = since === undefined ? undefined : Date.parse(since);
    return this.snapshots
      .filter(
        (snapshot) =>
          (providerId === undefined || snapshot.provider === providerId) &&
          (sinceTime === undefined || Date.parse(snapshot.collectedAt) >= sinceTime),
      )
      .sort(compareSnapshots)
      .slice(0, limit);
  }
}

interface CapacitySnapshotRow extends QueryResultRow {
  id: string;
  provider_id: string;
  collected_at: Date | string;
  created_at: Date | string;
  resources: unknown;
  freshness: CapacitySnapshot['freshness'];
  error: unknown;
  metadata: unknown;
}

export class PostgresCapacitySnapshotStore implements CapacitySnapshotStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async save(snapshot: CapacitySnapshot): Promise<void> {
    const safe = canonicalizeCapacitySnapshot(snapshot);
    try {
      await this.pool.query(
        `INSERT INTO capacity_snapshots
          (id, provider_id, collected_at, resources, freshness, error, metadata, created_at)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, $6::jsonb, $7::jsonb,
                 COALESCE($8::timestamptz, now()))`,
        [
          safe.id,
          safe.provider,
          safe.collectedAt,
          JSON.stringify(safe.resources),
          safe.freshness,
          safe.error ? JSON.stringify(safe.error) : null,
          safe.metadata ? JSON.stringify(safe.metadata) : null,
          safe.createdAt ?? null,
        ],
      );
    } catch {
      throw new CapacitySnapshotStoreError();
    }
  }

  async latest(providerId?: string): Promise<readonly CapacitySnapshot[]> {
    const requestedProvider = validateProviderId(providerId);
    try {
      const result: QueryResult<CapacitySnapshotRow> = requestedProvider
        ? await this.pool.query<CapacitySnapshotRow>(
            `${SNAPSHOT_COLUMNS}
             FROM capacity_snapshots
             WHERE provider_id = $1
             ORDER BY collected_at DESC, created_at DESC, id DESC
             LIMIT 1`,
            [requestedProvider],
          )
        : await this.pool.query<CapacitySnapshotRow>(
            `SELECT DISTINCT ON (provider_id) ${SNAPSHOT_COLUMN_NAMES}
             FROM capacity_snapshots
             ORDER BY provider_id, collected_at DESC, created_at DESC, id DESC`,
          );
      return result.rows
        .map(snapshotFromRow)
        .sort((left, right) => left.provider.localeCompare(right.provider));
    } catch (error) {
      if (error instanceof CapacitySnapshotStoreError) {
        throw error;
      }
      throw new CapacitySnapshotStoreError();
    }
  }

  async history(
    options: CapacitySnapshotHistoryOptions = {},
  ): Promise<readonly CapacitySnapshot[]> {
    const providerId = validateProviderId(options.providerId);
    const since = validateSince(options.since);
    const limit = validateLimit(options.limit);
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (providerId !== undefined) {
      values.push(providerId);
      predicates.push(`provider_id = $${values.length}`);
    }
    if (since !== undefined) {
      values.push(since);
      predicates.push(`collected_at >= $${values.length}::timestamptz`);
    }
    values.push(limit);
    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
    try {
      const result = await this.pool.query<CapacitySnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMN_NAMES}
         FROM capacity_snapshots
         ${where}
         ORDER BY collected_at DESC, created_at DESC, id DESC
         LIMIT $${values.length}`,
        values,
      );
      return result.rows.map(snapshotFromRow);
    } catch (error) {
      if (error instanceof CapacitySnapshotStoreError) {
        throw error;
      }
      throw new CapacitySnapshotStoreError();
    }
  }
}

const SNAPSHOT_COLUMN_NAMES =
  'id, provider_id, collected_at, created_at, resources, freshness, error, metadata';
const SNAPSHOT_COLUMNS = `SELECT ${SNAPSHOT_COLUMN_NAMES}`;

function databaseTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CapacitySnapshotStoreError();
  }
  return date.toISOString();
}

function snapshotFromRow(row: CapacitySnapshotRow): CapacitySnapshot {
  try {
    return canonicalizeCapacitySnapshot({
      id: row.id,
      provider: row.provider_id,
      collectedAt: databaseTimestamp(row.collected_at),
      createdAt: databaseTimestamp(row.created_at),
      resources: row.resources,
      freshness: row.freshness,
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.metadata === null ? {} : { metadata: row.metadata }),
    });
  } catch {
    throw new CapacitySnapshotStoreError('Stored capacity snapshot is invalid');
  }
}
