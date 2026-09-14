import { redactMetadata } from '@sonoran-hub/config';
import { capacityCollectionResultSchema, capacityTimestampSchema } from '@sonoran-hub/contracts';

import { isProviderFailureCode, type ProviderFailure, type ProviderFailureCode } from './errors.js';
import { CapacityAdapterRegistry } from './registry.js';
import type {
  AdapterAvailability,
  CapacityEvent,
  CapacityEventListener,
  CollectionFailure,
  CollectionOutcome,
  CollectionSuccess,
  ProbeResult,
  ProviderHealth,
} from './types.js';

const DEFAULT_COLLECTION_TIMEOUT_MS = 10_000;

export interface CapacityCoordinatorOptions {
  readonly collectionTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly now?: () => string;
}

class OperationTimeoutError extends Error {}

export class CapacityCoordinator {
  private readonly activeCollections = new Map<string, Promise<CollectionOutcome>>();
  private readonly health = new Map<string, ProviderHealth>();
  private readonly listeners = new Set<CapacityEventListener>();
  private readonly collectionTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => string;

  constructor(
    readonly registry: CapacityAdapterRegistry,
    options: CapacityCoordinatorOptions = {},
  ) {
    this.collectionTimeoutMs = options.collectionTimeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
    this.validateTimeout('collectionTimeoutMs', this.collectionTimeoutMs);
    this.probeTimeoutMs = options.probeTimeoutMs ?? this.collectionTimeoutMs;
    this.validateTimeout('probeTimeoutMs', this.probeTimeoutMs);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: CapacityEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listProviderIds(): readonly string[] {
    return this.registry.list().map((adapter) => adapter.id);
  }

  getHealth(providerId: string): ProviderHealth | undefined {
    const provider = this.registry.get(providerId);
    const current = this.health.get(providerId);
    if (!provider && !current) {
      return undefined;
    }

    return current ? { ...current } : { providerId };
  }

  listHealth(): readonly ProviderHealth[] {
    return this.listProviderIds().map((providerId) => this.getHealth(providerId) ?? { providerId });
  }

  async probe(providerId: string): Promise<ProbeResult> {
    const adapter = this.registry.get(providerId);
    if (!adapter) {
      return this.recordProbeFailure(providerId, 'unknown', 'Provider adapter is not registered');
    }

    try {
      const result = await this.withTimeout(adapter.probe(), this.probeTimeoutMs);
      const validated = this.validateProbeResult(adapter.id, result);
      if (!validated) {
        return this.recordProbeFailure(
          adapter.id,
          'invalid_response',
          'Probe returned invalid data',
        );
      }

      const probe: ProbeResult = validated;
      this.updateHealth(adapter.id, {
        available: probe.available,
        lastProbe: probe,
        ...(probe.available ? { lastError: undefined } : {}),
      });
      this.emit({ type: 'probe_completed', result: probe });
      return probe;
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        return this.recordProbeFailure(
          adapter.id,
          'timeout',
          `Provider probe exceeded ${this.probeTimeoutMs}ms timeout`,
        );
      }
      return this.recordProbeFailure(
        adapter.id,
        'provider_error',
        'Provider probe failed unexpectedly',
      );
    }
  }

  async probeAll(): Promise<readonly ProbeResult[]> {
    return Promise.all(this.listProviderIds().map((providerId) => this.probe(providerId)));
  }

  async collect(providerId: string): Promise<CollectionOutcome> {
    const active = this.activeCollections.get(providerId);
    if (active) {
      return active;
    }

    const operation = this.collectInternal(providerId);
    this.activeCollections.set(providerId, operation);
    void operation.then(
      () => this.activeCollections.delete(providerId),
      () => this.activeCollections.delete(providerId),
    );
    return operation;
  }

  async collectAll(): Promise<readonly CollectionOutcome[]> {
    return Promise.all(this.listProviderIds().map((providerId) => this.collect(providerId)));
  }

  async refresh(providerId: string): Promise<CollectionOutcome> {
    const probe = await this.probe(providerId);
    if (probe.available) {
      return this.collect(providerId);
    }

    const attemptedAt = this.now();
    const error =
      probe.failure ??
      this.createFailure(
        'unavailable',
        providerId,
        'collect',
        probe.reason ?? 'Provider is unavailable',
        attemptedAt,
      );
    const result: CollectionFailure = { status: 'failed', providerId, attemptedAt, error };
    this.updateHealth(providerId, { lastCollectionAttempt: attemptedAt, lastError: error });
    this.emit({ type: 'collection_started', providerId, startedAt: attemptedAt });
    this.emit({ type: 'collection_failed', result });
    return result;
  }

  async refreshAll(): Promise<readonly CollectionOutcome[]> {
    return Promise.all(this.listProviderIds().map((providerId) => this.refresh(providerId)));
  }

  private async collectInternal(providerId: string): Promise<CollectionOutcome> {
    const attemptedAt = this.now();
    const adapter = this.registry.get(providerId);
    this.updateHealth(providerId, { lastCollectionAttempt: attemptedAt });
    this.emit({ type: 'collection_started', providerId, startedAt: attemptedAt });

    if (!adapter) {
      return this.finishFailure(
        providerId,
        attemptedAt,
        this.createFailure(
          'unknown',
          providerId,
          'collect',
          'Provider adapter is not registered',
          attemptedAt,
        ),
      );
    }

    try {
      const rawResult = await this.withTimeout(adapter.collect(), this.collectionTimeoutMs);
      const parsed = capacityCollectionResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        return this.finishFailure(
          providerId,
          attemptedAt,
          this.createFailure(
            'invalid_normalized_data',
            providerId,
            'collect',
            'Provider returned invalid normalized capacity data',
            attemptedAt,
          ),
        );
      }

      if (parsed.data.error) {
        const code: ProviderFailureCode = isProviderFailureCode(parsed.data.error.code)
          ? parsed.data.error.code
          : 'provider_error';
        return this.finishFailure(
          providerId,
          attemptedAt,
          this.createFailure(code, providerId, 'collect', parsed.data.error.message, attemptedAt),
        );
      }

      const mismatchedResource = parsed.data.resources.find(
        (resource) => resource.provider !== providerId,
      );
      if (mismatchedResource) {
        return this.finishFailure(
          providerId,
          attemptedAt,
          this.createFailure(
            'invalid_normalized_data',
            providerId,
            'collect',
            'Provider returned a resource belonging to another provider',
            attemptedAt,
          ),
        );
      }

      const result: CollectionSuccess = {
        status: 'succeeded',
        providerId,
        attemptedAt,
        collectedAt: parsed.data.collectedAt,
        resources: parsed.data.resources,
      };
      this.updateHealth(providerId, {
        lastSuccessfulCollection: parsed.data.collectedAt,
        lastError: undefined,
      });
      this.emit({ type: 'collection_succeeded', result });
      return result;
    } catch (error) {
      const code = error instanceof OperationTimeoutError ? 'timeout' : 'provider_error';
      const message =
        code === 'timeout'
          ? `Provider collection exceeded ${this.collectionTimeoutMs}ms timeout`
          : 'Provider collection failed unexpectedly';
      return this.finishFailure(
        providerId,
        attemptedAt,
        this.createFailure(code, providerId, 'collect', message, attemptedAt),
      );
    }
  }

  private finishFailure(
    providerId: string,
    attemptedAt: string,
    error: ProviderFailure,
  ): CollectionFailure {
    const result: CollectionFailure = { status: 'failed', providerId, attemptedAt, error };
    this.updateHealth(providerId, { lastError: error });
    this.emit({ type: 'collection_failed', result });
    return result;
  }

  private recordProbeFailure(
    providerId: string,
    code: ProviderFailureCode,
    message: string,
  ): ProbeResult {
    const checkedAt = this.now();
    const failure = this.createFailure(code, providerId, 'probe', message, checkedAt);
    const result: ProbeResult = {
      providerId,
      available: false,
      checkedAt,
      reason: message,
      failure,
    };
    this.updateHealth(providerId, { available: false, lastProbe: result, lastError: failure });
    this.emit({ type: 'probe_completed', result });
    return result;
  }

  private validateProbeResult(
    adapterId: string,
    result: AdapterAvailability,
  ): AdapterAvailability | undefined {
    if (
      !result ||
      result.providerId !== adapterId ||
      typeof result.available !== 'boolean' ||
      !capacityTimestampSchema.safeParse(result.checkedAt).success ||
      (!result.available && !result.reason)
    ) {
      return undefined;
    }

    return result;
  }

  private createFailure(
    code: ProviderFailureCode,
    providerId: string,
    phase: 'probe' | 'collect',
    message: string,
    occurredAt: string,
  ): ProviderFailure {
    const redacted = redactMetadata(message);
    return {
      code,
      providerId,
      phase,
      message: typeof redacted === 'string' ? redacted : 'Provider operation failed',
      occurredAt,
    };
  }

  private updateHealth(providerId: string, patch: Partial<ProviderHealth>): void {
    const current = this.health.get(providerId) ?? { providerId };
    const next = { ...current, ...patch };
    this.health.set(providerId, next);
  }

  private emit(event: CapacityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Lifecycle observers are isolated from provider operations and each other.
      }
    }
  }

  private validateTimeout(name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive number`);
    }
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OperationTimeoutError()), timeoutMs);
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
