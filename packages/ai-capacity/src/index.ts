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
export {
  CODEX_PROVIDER_ID,
  CodexCapacityAdapter,
  type CodexCapacityAdapterOptions,
} from './providers/codex/index.js';
export {
  CODEX_PROTOCOL_SOURCE,
  CodexAppServerSource,
  type CodexAppServerSourceOptions,
  type CodexCapacitySource,
  type CodexRateLimitSnapshot,
  type CodexSourceAvailability,
} from './providers/codex/index.js';
export {
  CODEX_SOURCE,
  CODEX_WEEKLY_WINDOW_MINUTES,
  CodexNormalizationError,
  codexQuotaStatus,
  codexUnixSecondsToIso,
  formatCodexQuotaWindowLabel,
  normalizeCodexRateLimits,
  sanitizeCodexLimitId,
} from './providers/codex/index.js';
export {
  CodexAppServerClient,
  CodexAppServerClientError,
  spawnCodexProcess,
  type CodexAppServerClientOptions,
  type CodexChildProcess,
  type CodexClientErrorCode,
  type CodexSpawn,
} from './providers/codex/index.js';
export {
  codexAccountResponseSchema,
  codexCreditsSnapshotSchema,
  codexInitializeResponseSchema,
  codexPlanTypeSchema,
  codexRateLimitReachedTypeSchema,
  codexRateLimitResetCreditsSchema,
  codexRateLimitSnapshotSchema,
  codexRateLimitWindowSchema,
  codexRateLimitsResponseSchema,
  codexSpendControlLimitSnapshotSchema,
  type CodexAccount,
  type CodexAccountResponse,
  type CodexInitializeResponse,
  type CodexPlanType,
  type CodexRateLimitSnapshot as CodexProtocolRateLimitSnapshot,
  type CodexRateLimitWindow,
  type CodexRateLimitsResponse,
} from './providers/codex/index.js';
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
