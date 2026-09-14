import type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

import type { ProviderFailure } from './errors.js';

export interface AdapterAvailability {
  readonly providerId: string;
  readonly available: boolean;
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface CapacityProviderAdapter {
  readonly id: string;
  probe(): Promise<AdapterAvailability>;
  collect(): Promise<CapacityCollectionResult>;
}

export interface ProbeResult extends AdapterAvailability {
  readonly failure?: ProviderFailure;
}

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
  readonly lastError?: ProviderFailure;
}

export type CapacityEventListener = (event: CapacityEvent) => void;
