import type { Pool } from 'pg';
import type { StructuredLogger } from '@sonoran-hub/config';
import type { GitHubWebhookDeliveryRecord } from '@sonoran-hub/contracts';

export interface GitHubWebhookDeliveryStore {
  /**
   * Atomically records a delivery if it does not already exist.
   * Returns true if newly recorded, false if duplicate.
   */
  recordIfNew(delivery: GitHubWebhookDeliveryRecord): Promise<boolean>;

  /**
   * Cleans up delivery records received before the given threshold timestamp.
   * Returns the count of deleted records.
   */
  cleanupBefore(threshold: Date): Promise<number>;

  /**
   * Optional inspection helper for tests.
   */
  getDelivery(deliveryId: string): Promise<GitHubWebhookDeliveryRecord | null>;
}

export class InMemoryGitHubWebhookDeliveryStore implements GitHubWebhookDeliveryStore {
  private readonly deliveries = new Map<string, GitHubWebhookDeliveryRecord>();

  async recordIfNew(delivery: GitHubWebhookDeliveryRecord): Promise<boolean> {
    if (this.deliveries.has(delivery.deliveryId)) {
      return false;
    }
    this.deliveries.set(delivery.deliveryId, delivery);
    return true;
  }

  async cleanupBefore(threshold: Date): Promise<number> {
    const thresholdMs = threshold.getTime();
    let deletedCount = 0;
    for (const [id, record] of this.deliveries.entries()) {
      if (new Date(record.receivedAt).getTime() < thresholdMs) {
        this.deliveries.delete(id);
        deletedCount += 1;
      }
    }
    return deletedCount;
  }

  async getDelivery(deliveryId: string): Promise<GitHubWebhookDeliveryRecord | null> {
    return this.deliveries.get(deliveryId) ?? null;
  }
}

export class PostgresGitHubWebhookDeliveryStore implements GitHubWebhookDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async recordIfNew(delivery: GitHubWebhookDeliveryRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO github_webhook_deliveries (
         delivery_id,
         event_name,
         repository_owner,
         repository_name,
         outcome,
         received_at,
         processed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [
        delivery.deliveryId,
        delivery.eventName,
        delivery.repositoryOwner ?? null,
        delivery.repositoryName ?? null,
        delivery.outcome,
        delivery.receivedAt,
        delivery.processedAt ?? null,
      ],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async cleanupBefore(threshold: Date): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM github_webhook_deliveries WHERE received_at < $1`,
      [threshold.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  async getDelivery(deliveryId: string): Promise<GitHubWebhookDeliveryRecord | null> {
    const result = await this.pool.query(
      `SELECT delivery_id, event_name, repository_owner, repository_name, outcome, received_at, processed_at
       FROM github_webhook_deliveries
       WHERE delivery_id = $1`,
      [deliveryId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      deliveryId: row.delivery_id,
      eventName: row.event_name,
      repositoryOwner: row.repository_owner,
      repositoryName: row.repository_name,
      outcome: row.outcome,
      receivedAt: row.received_at.toISOString(),
      processedAt: row.processed_at ? row.processed_at.toISOString() : null,
    };
  }
}

export interface WebhookRetentionManagerOptions {
  readonly store: GitHubWebhookDeliveryStore;
  readonly retentionHours?: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly logger?: StructuredLogger;
}

export interface WebhookRetentionManager {
  start(): Promise<void>;
  stop(): void;
  runCleanup(): Promise<number>;
}

export const DEFAULT_WEBHOOK_RETENTION_HOURS = 168; // 7 days
export const MIN_WEBHOOK_RETENTION_HOURS = 1;
export const MAX_WEBHOOK_RETENTION_HOURS = 2_160; // 90 days
export const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000; // 1 hour

export function parseWebhookRetentionHours(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_WEBHOOK_RETENTION_HOURS;
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS must be a positive integer between ${MIN_WEBHOOK_RETENTION_HOURS} and ${MAX_WEBHOOK_RETENTION_HOURS}`,
    );
  }
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_WEBHOOK_RETENTION_HOURS ||
    parsed > MAX_WEBHOOK_RETENTION_HOURS
  ) {
    throw new Error(
      `GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS must be a positive integer between ${MIN_WEBHOOK_RETENTION_HOURS} and ${MAX_WEBHOOK_RETENTION_HOURS}`,
    );
  }
  return parsed;
}

export function createWebhookRetentionManager(
  options: WebhookRetentionManagerOptions,
): WebhookRetentionManager {
  const retentionHours = options.retentionHours ?? DEFAULT_WEBHOOK_RETENTION_HOURS;
  const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
  const getNow = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;

  const runCleanup = async (): Promise<number> => {
    const cutoff = new Date(getNow().getTime() - retentionHours * 60 * 60 * 1000);
    try {
      const count = await options.store.cleanupBefore(cutoff);
      if (count > 0) {
        options.logger?.info('github.webhook.retention_cleanup', {
          metadata: { deletedCount: count, retentionHours },
        });
      }
      return count;
    } catch (error) {
      options.logger?.error('github.webhook.retention_cleanup_failed', {
        metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
      });
      return 0;
    }
  };

  return {
    async start() {
      await runCleanup();
      if (intervalMs > 0) {
        timer = setInterval(() => {
          void runCleanup();
        }, intervalMs);
      }
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    runCleanup,
  };
}
