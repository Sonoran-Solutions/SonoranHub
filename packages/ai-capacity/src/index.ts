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
  canonicalizeCapacitySnapshot,
  CapacitySnapshotStoreError,
  CapacitySnapshotValidationError,
  DEFAULT_HISTORY_LIMIT,
  InMemoryCapacitySnapshotStore,
  MAX_HISTORY_LIMIT,
  PostgresCapacitySnapshotStore,
  type CapacitySnapshotHistoryOptions,
  type CapacitySnapshotStore,
} from './snapshot-store.js';
export { CapacityService, type CapacityServiceOptions } from './service.js';
export {
  DEEPSEEK_PROVIDER_ID,
  DeepSeekCapacityAdapter,
  type DeepSeekCapacityAdapterOptions,
  type DeepSeekCredentials,
  type DeepSeekFetch,
  type DeepSeekResponse,
} from './providers/deepseek/index.js';
export {
  DeepSeekBalanceDataError,
  deepSeekBalanceResponseSchema,
  normalizeDeepSeekBalance,
  parseDeepSeekDecimal,
  type DeepSeekBalanceFailure,
  type DeepSeekBalanceNormalization,
  type DeepSeekBalanceResponse,
  type NormalizedDeepSeekBalanceInfo,
} from './providers/deepseek/index.js';
export {
  DEEPSEEK_PRICING_SOURCE,
  compileDeepSeekPricingConfig,
  deepSeekPricingConfig,
  evaluateDeepSeekPricingWindow,
  type CompiledDeepSeekPeakWindow,
  type CompiledDeepSeekPricingConfig,
  type DeepSeekPeakWindow,
  type DeepSeekPriceState,
  type DeepSeekPricingConfig,
  type DeepSeekPricingWindowState,
} from './providers/deepseek/index.js';
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
  CapacityRefreshTarget,
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
