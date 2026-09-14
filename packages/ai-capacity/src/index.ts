import type { CapacityResource } from '@sonoran-hub/contracts';

export type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

export { CapacityCoordinator, type CapacityCoordinatorOptions } from './coordinator.js';
export {
  AdapterRegistryError,
  providerFailureCodes,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderFailurePhase,
} from './errors.js';
export { CapacityAdapterRegistry } from './registry.js';
export { CapacityRefreshScheduler, type RefreshSchedulerOptions } from './scheduler.js';
export {
  OPENROUTER_PROVIDER_ID,
  OpenRouterCapacityAdapter,
  type OpenRouterCapacityAdapterOptions,
  type OpenRouterCredentials,
  type OpenRouterCreditsResponse,
  type OpenRouterFetch,
  type OpenRouterKeyResponse,
  type OpenRouterResponse,
} from './providers/openrouter/index.js';
export type {
  AdapterAvailability,
  CapacityEvent,
  CapacityEventListener,
  CapacityProviderAdapter,
  CollectionFailure,
  CollectionOutcome,
  CollectionStartedEvent,
  CollectionSuccess,
  CollectionSucceededEvent,
  CollectionFailedEvent,
  ProbeCompletedEvent,
  ProbeResult,
  ProviderHealth,
} from './types.js';

export type CapacityResourceInput = CapacityResource;
