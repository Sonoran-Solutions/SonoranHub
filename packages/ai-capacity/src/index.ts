import type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

export type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

/** Boundary for future provider capacity adapters. No provider implementation belongs here yet. */
export interface CapacityProviderAdapter {
  readonly id: string;
  probe(): Promise<AdapterAvailability>;
  collect(): Promise<CapacityCollectionResult>;
}

export interface AdapterAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export type CapacityResourceInput = CapacityResource;
