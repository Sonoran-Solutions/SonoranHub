import type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

import type { ProviderFailure } from './errors.js';

export interface AdapterAvailability {
  readonly providerId: string;
  readonly available: boolean;
  readonly checkedAt: string;
  readonly reason?: string;
  /** A provider-specific typed failure when the probe reached the provider. */
  readonly failure?: ProviderFailure;
}

export interface CapacityProviderAdapter {
  readonly id: string;
  probe(): Promise<AdapterAvailability>;
  collect(): Promise<CapacityCollectionResult>;
}

export type ProbeResult = AdapterAvailability;

export interface CollectionStartedEvent {
  readonly type: 'collection_started';
  readonly providerId: string;
  readonly startedAt: string;
}

export interface CollectionSucceededEvent {
  readonly type: 'collection_succeeded';
  readonly result: CollectionSuccess;
}

export interface CollectionFailedEvent {
  readonly type: 'collection_failed';
  readonly result: CollectionFailure;
}

export interface ProbeCompletedEvent {
  readonly type: 'probe_completed';
  readonly result: ProbeResult;
}

export type CapacityEvent =
  CollectionStartedEvent | CollectionSucceededEvent | CollectionFailedEvent | ProbeCompletedEvent;

export interface CollectionSuccess {
  readonly status: 'succeeded';
  readonly providerId: string;
  readonly attemptedAt: string;
  readonly collectedAt: string;
  readonly resources: readonly CapacityResource[];
  /** A non-fatal collector error accompanying usable partial resources. */
  readonly error?: ProviderFailure;
}

export interface CollectionFailure {
  readonly status: 'failed';
  readonly providerId: string;
  readonly attemptedAt: string;
  readonly error: ProviderFailure;
}

export type CollectionOutcome = CollectionSuccess | CollectionFailure;

export interface ProviderHealth {
  readonly providerId: string;
  readonly available?: boolean;
  readonly lastProbe?: ProbeResult;
  readonly lastCollectionAttempt?: string;
  readonly lastSuccessfulCollection?: string;
  /** Probe health is retained even when collection returns useful partial data. */
  readonly lastProbeFailure?: ProviderFailure;
  readonly lastCollectionFailure?: ProviderFailure;
  readonly lastError?: ProviderFailure;
}

export interface CapacityRefreshTarget {
  listProviderIds(): readonly string[];
  refresh(providerId: string): Promise<CollectionOutcome>;
}

export type CapacityEventListener = (event: CapacityEvent) => void;
