import { createStructuredLogger, type StructuredLogger } from '@sonoran-hub/config';
import {
  capacitySnapshotSchema,
  type CapacitySnapshot,
  type CapacityResource,
} from '@sonoran-hub/contracts';

import type { CapacityCoordinator } from './coordinator.js';
import type { CollectionOutcome, CollectionSuccess, ProviderHealth } from './types.js';
import {
  canonicalizeCapacitySnapshot,
  type CapacitySnapshotHistoryOptions,
  type CapacitySnapshotStore,
} from './snapshot-store.js';

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export interface CapacityServiceOptions {
  readonly staleAfterMs?: number;
  readonly now?: () => string;
  readonly logger?: StructuredLogger;
}

export class CapacityService {
  private readonly staleAfterMs: number;
  private readonly now: () => string;
  private readonly logger: StructuredLogger;

  constructor(
    readonly coordinator: CapacityCoordinator,
    readonly store: CapacitySnapshotStore,
    options: CapacityServiceOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new Error('staleAfterMs must be a finite positive number');
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger =
      options.logger ??
      createStructuredLogger({ serviceName: 'sonoran-hub-capacity', level: 'silent' });
  }

  listProviderIds(): readonly string[] {
    return this.coordinator.listProviderIds();
  }

  getHealth(providerId: string): ProviderHealth | undefined {
    return this.coordinator.getHealth(providerId);
  }

  listHealth(): readonly ProviderHealth[] {
    return this.coordinator.listHealth();
  }

  async latest(providerId?: string): Promise<readonly CapacitySnapshot[]> {
    return this.store.latest(providerId);
  }

  async history(options?: CapacitySnapshotHistoryOptions): Promise<readonly CapacitySnapshot[]> {
    return this.store.history(options);
  }

  async refresh(providerId: string): Promise<CollectionOutcome> {
    const outcome = await this.coordinator.refresh(providerId);
    if (outcome.status === 'succeeded') {
      if (outcome.error || outcome.resources.some((resource) => resource.status === 'unknown')) {
        this.logger.warn('capacity.refresh.partial', {
          metadata: {
            providerId,
            unknownResources: outcome.resources.filter((resource) => resource.status === 'unknown')
              .length,
          },
        });
      }
      await this.persistCollection(outcome);
    }
    return outcome;
  }

  async refreshAll(): Promise<readonly CollectionOutcome[]> {
    return Promise.all(this.listProviderIds().map((providerId) => this.refresh(providerId)));
  }

  private async persistCollection(collection: CollectionSuccess): Promise<void> {
    let snapshot: CapacitySnapshot | undefined;
    try {
      snapshot = snapshotFromCollection(collection, this.now, this.staleAfterMs);
      await this.store.save(snapshot);
      this.logger.info('capacity.snapshot.persisted', {
        metadata: { providerId: snapshot.provider, snapshotId: snapshot.id },
      });
    } catch {
      this.logger.error('capacity.snapshot.persistence_failed', {
        metadata: { providerId: collection.providerId, snapshotId: snapshot?.id },
      });
    }
  }
}

function snapshotFromCollection(
  collection: CollectionSuccess,
  now: () => string,
  staleAfterMs: number,
): CapacitySnapshot {
  const resources = collection.resources.map((resource) => withStaleAfter(resource, staleAfterMs));
  const candidate = {
    id: `${collection.providerId}-${collection.collectedAt}-${globalThis.crypto.randomUUID()}`,
    provider: collection.providerId,
    resources,
    collectedAt: collection.collectedAt,
    createdAt: now(),
    freshness: 'fresh' as const,
    ...(collection.error
      ? { error: { code: collection.error.code, message: collection.error.message } }
      : {}),
  };
  return canonicalizeCapacitySnapshot(capacitySnapshotSchema.parse(candidate));
}

function withStaleAfter(resource: CapacityResource, staleAfterMs: number): CapacityResource {
  if (resource.freshness !== 'fresh' || resource.staleAfter !== undefined) {
    return resource;
  }
  const staleAfter = new Date(Date.parse(resource.collectedAt) + staleAfterMs).toISOString();
  return { ...resource, staleAfter };
}
