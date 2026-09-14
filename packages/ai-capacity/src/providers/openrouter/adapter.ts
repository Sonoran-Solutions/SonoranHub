import { z } from 'zod';

import type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';
import type { AdapterAvailability, CapacityProviderAdapter } from '../../types.js';

export const OPENROUTER_PROVIDER_ID = 'openrouter';
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

const nonNegativeMetric = z.number().finite().nonnegative();
const nullableMetric = nonNegativeMetric.nullable().optional();
const resetPolicySchema = z.enum(['daily', 'weekly', 'monthly']).nullable();

const openRouterKeyDataSchema = z
  .object({
    limit: nonNegativeMetric.nullable(),
    limit_remaining: nonNegativeMetric.nullable(),
    limit_reset: resetPolicySchema,
    usage: nonNegativeMetric,
    usage_daily: nullableMetric,
    usage_weekly: nullableMetric,
    usage_monthly: nullableMetric,
    byok_usage: nullableMetric,
    byok_usage_daily: nullableMetric,
    byok_usage_weekly: nullableMetric,
    byok_usage_monthly: nullableMetric,
    include_byok_in_limit: z.boolean().optional(),
    is_free_tier: z.boolean().optional(),
    is_management_key: z.boolean().optional(),
    label: z.string().nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .passthrough();

const openRouterKeyResponseSchema = z.object({ data: openRouterKeyDataSchema }).passthrough();

const openRouterCreditsDataSchema = z.object({
  total_credits: nonNegativeMetric,
  total_usage: nonNegativeMetric,
});

const openRouterCreditsResponseSchema = z
  .object({ data: openRouterCreditsDataSchema })
  .passthrough();

export type OpenRouterKeyResponse = z.infer<typeof openRouterKeyResponseSchema>;
export type OpenRouterCreditsResponse = z.infer<typeof openRouterCreditsResponseSchema>;

export interface OpenRouterCredentials {
  readonly apiKey?: string;
  readonly managementKey?: string;
}

export interface OpenRouterResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/** A narrow fetch-compatible seam keeps normal tests entirely off the network. */
export type OpenRouterFetch = (input: string, init?: RequestInit) => Promise<OpenRouterResponse>;

export interface OpenRouterCapacityAdapterOptions extends OpenRouterCredentials {
  readonly fetch?: OpenRouterFetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
}

interface OpenRouterFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

class OpenRouterAdapterError extends Error implements OpenRouterFailure {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenRouterAdapterError';
  }
}

function configuredCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function roundMetric(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000_000) / 1_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeRemaining(value: number, limit: number): number {
  const tolerance = Math.max(1, Math.abs(limit)) * 1e-9;
  if (value < 0 && Math.abs(value) <= tolerance) {
    return 0;
  }
  if (value < 0) {
    throw new OpenRouterAdapterError(
      'invalid_normalized_data',
      'OpenRouter reported an impossible negative remaining balance',
    );
  }
  return roundMetric(value);
}

function addMetadata(metadata: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

function keyMetadata(data: z.infer<typeof openRouterKeyDataSchema>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  addMetadata(metadata, 'label', data.label);
  addMetadata(metadata, 'limit_reset', data.limit_reset);
  addMetadata(metadata, 'is_free_tier', data.is_free_tier);
  addMetadata(metadata, 'is_management_key', data.is_management_key);
  addMetadata(metadata, 'include_byok_in_limit', data.include_byok_in_limit);
  addMetadata(metadata, 'usage_daily', data.usage_daily);
  addMetadata(metadata, 'usage_weekly', data.usage_weekly);
  addMetadata(metadata, 'usage_monthly', data.usage_monthly);
  addMetadata(metadata, 'byok_usage', data.byok_usage);
  addMetadata(metadata, 'byok_usage_daily', data.byok_usage_daily);
  addMetadata(metadata, 'byok_usage_weekly', data.byok_usage_weekly);
  addMetadata(metadata, 'byok_usage_monthly', data.byok_usage_monthly);
  addMetadata(metadata, 'expires_at', data.expires_at);
  return metadata;
}

function unknownResource(
  collectedAt: string,
  kind: 'key_budget' | 'wallet',
  name: string,
  failure: OpenRouterFailure,
  metadata: Record<string, unknown> = {},
): CapacityResource {
  return {
    id: kind === 'key_budget' ? 'openrouter-key-budget' : 'openrouter-account-credits',
    provider: OPENROUTER_PROVIDER_ID,
    kind,
    name,
    unit: 'usd',
    status: 'unknown',
    source: 'official_api',
    collectedAt,
    freshness: 'unknown',
    error: { code: failure.code, message: failure.message },
    metadata,
  };
}

function keyBudgetResource(
  data: z.infer<typeof openRouterKeyDataSchema>,
  collectedAt: string,
): CapacityResource {
  const metadata = keyMetadata(data);

  if (data.limit === null) {
    return {
      id: 'openrouter-key-budget',
      provider: OPENROUTER_PROVIDER_ID,
      kind: 'key_budget',
      name: 'OpenRouter API key budget',
      unit: 'usd',
      status: 'unknown',
      source: 'official_api',
      collectedAt,
      freshness: 'fresh',
      metadata: {
        ...metadata,
        limit_configured: false,
        budget_state: 'unbounded',
      },
    };
  }

  const limit = roundMetric(data.limit);
  const remaining =
    data.limit_remaining === null
      ? normalizeRemaining(limit - data.usage, limit)
      : normalizeRemaining(data.limit_remaining, limit);
  if (remaining > limit) {
    throw new OpenRouterAdapterError(
      'invalid_normalized_data',
      'OpenRouter reported remaining key budget above its configured limit',
    );
  }

  // The provider-reported remaining value is authoritative. Deriving used from it
  // also keeps the generic contract invariant true when provider decimals differ by
  // a tiny floating-point amount. The raw usage is retained in metadata.
  const used = roundMetric(limit - remaining);
  const remainingPercent = limit > 0 ? roundMetric((remaining / limit) * 100) : undefined;

  return {
    id: 'openrouter-key-budget',
    provider: OPENROUTER_PROVIDER_ID,
    kind: 'key_budget',
    name: 'OpenRouter API key budget',
    limit,
    used,
    remaining,
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    unit: 'usd',
    status: remaining === 0 ? 'exhausted' : 'available',
    source: 'official_api',
    collectedAt,
    freshness: 'fresh',
    metadata: {
      ...metadata,
      limit_configured: true,
      usage: data.usage,
    },
  };
}

function accountCreditsResource(
  data: z.infer<typeof openRouterCreditsDataSchema>,
  collectedAt: string,
): CapacityResource {
  const totalCredits = roundMetric(data.total_credits);
  const totalUsage = roundMetric(data.total_usage);
  const remaining = normalizeRemaining(totalCredits - totalUsage, totalCredits);

  return {
    id: 'openrouter-account-credits',
    provider: OPENROUTER_PROVIDER_ID,
    kind: 'wallet',
    name: 'OpenRouter account credits',
    limit: totalCredits,
    used: totalUsage,
    remaining,
    ...(totalCredits > 0
      ? { remainingPercent: roundMetric((remaining / totalCredits) * 100) }
      : {}),
    unit: 'usd',
    status: remaining === 0 ? 'exhausted' : 'available',
    source: 'official_api',
    collectedAt,
    freshness: 'fresh',
    metadata: {
      total_credits: data.total_credits,
      total_usage: data.total_usage,
    },
  };
}

export class OpenRouterCapacityAdapter implements CapacityProviderAdapter {
  readonly id = OPENROUTER_PROVIDER_ID;

  private readonly apiKey: string | undefined;
  private readonly managementKey: string | undefined;
  private readonly fetcher: OpenRouterFetch;
  private readonly now: () => string;
  private readonly requestTimeoutMs: number;

  constructor(options: OpenRouterCapacityAdapterOptions = {}) {
    this.apiKey = configuredCredential(options.apiKey);
    this.managementKey = configuredCredential(options.managementKey);
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be a finite positive number');
    }
  }

  async probe(): Promise<AdapterAvailability> {
    const checkedAt = this.now();
    if (!this.apiKey) {
      return {
        providerId: this.id,
        available: false,
        checkedAt,
        reason: 'OpenRouter API key is not configured',
      };
    }

    try {
      await this.getCurrentKey();
      return { providerId: this.id, available: true, checkedAt };
    } catch (error) {
      const failure = this.failureFrom(error);
      return {
        providerId: this.id,
        available: false,
        checkedAt,
        reason: failure.message,
        failure: {
          providerId: this.id,
          phase: 'probe',
          ...failure,
          occurredAt: checkedAt,
        },
      };
    }
  }

  async collect(): Promise<CapacityCollectionResult> {
    const collectedAt = this.now();
    if (!this.apiKey) {
      return {
        collectedAt,
        resources: [],
        error: {
          code: 'unavailable',
          message: 'OpenRouter API key is not configured',
        },
      };
    }

    const keyResult = await Promise.allSettled([
      this.getCurrentKey(),
      ...(this.managementKey ? [this.getCredits()] : []),
    ]);
    const resources: CapacityResource[] = [];
    let successfulEndpoints = 0;
    let keyFailure: OpenRouterFailure | undefined;
    let creditsFailure: OpenRouterFailure | undefined;

    const keyOutcome = keyResult[0];
    if (keyOutcome?.status === 'fulfilled') {
      try {
        resources.push(keyBudgetResource(keyOutcome.value.data, collectedAt));
        successfulEndpoints += 1;
      } catch (error) {
        keyFailure = this.failureFrom(error);
      }
    } else {
      keyFailure = this.failureFrom(keyOutcome?.reason);
    }

    if (this.managementKey) {
      const creditsOutcome = keyResult[1];
      if (creditsOutcome?.status === 'fulfilled') {
        try {
          resources.push(accountCreditsResource(creditsOutcome.value.data, collectedAt));
          successfulEndpoints += 1;
        } catch (error) {
          creditsFailure = this.failureFrom(error);
        }
      } else {
        creditsFailure = this.failureFrom(creditsOutcome?.reason);
      }
    }

    if (keyFailure) {
      resources.unshift(
        unknownResource(collectedAt, 'key_budget', 'OpenRouter API key budget', keyFailure, {
          endpoint: '/api/v1/key',
        }),
      );
    }
    if (creditsFailure) {
      resources.push(
        unknownResource(collectedAt, 'wallet', 'OpenRouter account credits', creditsFailure, {
          endpoint: '/api/v1/credits',
          management_key_configured: true,
        }),
      );
    }

    if (successfulEndpoints === 0) {
      const failure = keyFailure ??
        creditsFailure ?? {
          code: 'provider_error' as const,
          message: 'OpenRouter capacity endpoints returned no usable data',
        };
      return { collectedAt, resources: [], error: failure };
    }

    return { collectedAt, resources };
  }

  private async getCurrentKey(): Promise<OpenRouterKeyResponse> {
    const payload = await this.request('/key', this.apiKey as string);
    const parsed = openRouterKeyResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OpenRouterAdapterError(
        'invalid_response',
        'OpenRouter returned an invalid current-key response',
      );
    }
    return parsed.data;
  }

  private async getCredits(): Promise<OpenRouterCreditsResponse> {
    const payload = await this.request('/credits', this.managementKey as string);
    const parsed = openRouterCreditsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OpenRouterAdapterError(
        'invalid_response',
        'OpenRouter returned an invalid credits response',
      );
    }
    return parsed.data;
  }

  private async request(path: string, credential: string): Promise<unknown> {
    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      let response: OpenRouterResponse;
      try {
        response = await this.fetcher(`${OPENROUTER_API_BASE_URL}${path}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${credential}`,
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (didTimeout || isAbortError(error)) {
          throw new OpenRouterAdapterError('timeout', `OpenRouter request timed out for ${path}`);
        }
        throw new OpenRouterAdapterError('provider_error', `OpenRouter request failed for ${path}`);
      }

      if (!response.ok || response.status < 200 || response.status >= 300) {
        throw new OpenRouterAdapterError(
          this.failureCodeForStatus(response.status),
          this.failureMessageForStatus(path, response.status),
        );
      }

      try {
        return await response.json();
      } catch (error) {
        if (didTimeout || isAbortError(error)) {
          throw new OpenRouterAdapterError('timeout', `OpenRouter request timed out for ${path}`);
        }
        throw new OpenRouterAdapterError(
          'invalid_response',
          `OpenRouter returned invalid JSON for ${path}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private failureFrom(error: unknown): OpenRouterFailure {
    if (error instanceof OpenRouterAdapterError) {
      return { code: error.code, message: error.message };
    }
    return { code: 'provider_error', message: 'OpenRouter request failed unexpectedly' };
  }

  private failureCodeForStatus(status: number): ProviderFailureCode {
    if (status === 401 || status === 403) {
      return 'authentication';
    }
    if (status === 429) {
      return 'rate_limited';
    }
    if (status >= 500) {
      return 'provider_error';
    }
    return 'provider_error';
  }

  private failureMessageForStatus(path: string, status: number): string {
    if (status === 401 || status === 403) {
      return `OpenRouter authentication was rejected for ${path}`;
    }
    if (status === 429) {
      return `OpenRouter rate limit reached for ${path}`;
    }
    if (status >= 500) {
      return `OpenRouter provider error for ${path}`;
    }
    return `OpenRouter request failed for ${path}`;
  }
}
