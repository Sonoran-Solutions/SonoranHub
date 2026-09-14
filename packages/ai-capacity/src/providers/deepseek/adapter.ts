import { z } from 'zod';

import type { CapacityCollectionResult, CapacityResource } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';
import type { AdapterAvailability, CapacityProviderAdapter } from '../../types.js';
import {
  DeepSeekBalanceDataError,
  deepSeekBalanceResponseSchema,
  normalizeDeepSeekBalance,
} from './balance.js';
import {
  compileDeepSeekPricingConfig,
  deepSeekPricingConfig,
  type DeepSeekPricingConfig,
} from './pricing-config.js';
import { evaluateDeepSeekPricingWindow } from './pricing.js';

export const DEEPSEEK_PROVIDER_ID = 'deepseek';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface DeepSeekCredentials {
  readonly apiKey?: string;
}

export interface DeepSeekResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/** A narrow fetch-compatible seam keeps DeepSeek tests entirely off the network. */
export type DeepSeekFetch = (input: string, init?: RequestInit) => Promise<DeepSeekResponse>;

export interface DeepSeekCapacityAdapterOptions extends DeepSeekCredentials {
  readonly fetch?: DeepSeekFetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly pricingConfig?: DeepSeekPricingConfig;
}

interface DeepSeekFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

class DeepSeekAdapterError extends Error implements DeepSeekFailure {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekAdapterError';
  }
}

function configuredCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function unknownBalanceResource(collectedAt: string, failure: DeepSeekFailure): CapacityResource {
  return {
    id: 'deepseek-wallet-usd',
    provider: DEEPSEEK_PROVIDER_ID,
    kind: 'wallet',
    name: 'DeepSeek balance',
    unit: 'usd',
    status: 'unknown',
    source: 'official_api',
    collectedAt,
    freshness: 'unknown',
    error: { code: failure.code, message: failure.message },
    metadata: { endpoint: '/user/balance' },
  };
}

function unknownPricingResource(collectedAt: string, failure: DeepSeekFailure): CapacityResource {
  return {
    id: 'deepseek-pricing-window',
    provider: DEEPSEEK_PROVIDER_ID,
    kind: 'pricing_window',
    name: 'DeepSeek pricing window',
    unit: 'state',
    status: 'unknown',
    source: 'derived',
    collectedAt,
    freshness: 'unknown',
    error: { code: failure.code, message: failure.message },
  };
}

function pricingResource(
  state: ReturnType<typeof evaluateDeepSeekPricingWindow>,
  collectedAt: string,
): CapacityResource {
  return {
    id: 'deepseek-pricing-window',
    provider: DEEPSEEK_PROVIDER_ID,
    kind: 'pricing_window',
    name: 'DeepSeek pricing window',
    unit: 'state',
    changesAt: state.changesAt,
    status: 'available',
    source: 'derived',
    collectedAt,
    freshness: 'fresh',
    metadata: {
      state: state.state,
      next_state: state.nextState,
      price_multiplier: state.priceMultiplier,
      timezone: state.timezone,
      verifiedAt: state.verifiedAt,
      source: state.source,
    },
  };
}

export class DeepSeekCapacityAdapter implements CapacityProviderAdapter {
  readonly id = DEEPSEEK_PROVIDER_ID;

  private readonly apiKey: string | undefined;
  private readonly fetcher: DeepSeekFetch;
  private readonly now: () => string;
  private readonly requestTimeoutMs: number;
  private readonly pricingConfig: DeepSeekPricingConfig;

  constructor(options: DeepSeekCapacityAdapterOptions = {}) {
    this.apiKey = configuredCredential(options.apiKey);
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pricingConfig = options.pricingConfig ?? deepSeekPricingConfig;
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
        reason: 'DeepSeek API key is not configured',
      };
    }

    try {
      await this.getBalance();
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
        error: { code: 'unavailable', message: 'DeepSeek API key is not configured' },
      };
    }

    let balanceResource: CapacityResource | undefined;
    let balanceFailure: DeepSeekFailure | undefined;
    try {
      const response = await this.getBalance();
      balanceResource = normalizeDeepSeekBalance(response, collectedAt).usdResource;
    } catch (error) {
      balanceFailure = this.failureFrom(error);
    }

    let pricing: CapacityResource | undefined;
    let pricingFailure: DeepSeekFailure | undefined;
    try {
      compileDeepSeekPricingConfig(this.pricingConfig);
      const state = evaluateDeepSeekPricingWindow(collectedAt, this.pricingConfig);
      pricing = pricingResource(state, collectedAt);
    } catch (error) {
      pricingFailure = {
        code: 'invalid_normalized_data',
        message:
          error instanceof Error
            ? 'DeepSeek pricing configuration is invalid'
            : 'DeepSeek pricing state could not be derived',
      };
    }

    const resources = [
      balanceResource ??
        unknownBalanceResource(
          collectedAt,
          balanceFailure ?? {
            code: 'provider_error',
            message: 'DeepSeek balance could not be collected',
          },
        ),
      pricing ??
        unknownPricingResource(
          collectedAt,
          pricingFailure ?? {
            code: 'invalid_normalized_data',
            message: 'DeepSeek pricing state could not be derived',
          },
        ),
    ];

    if (balanceResource || pricing) {
      return { collectedAt, resources };
    }

    return {
      collectedAt,
      resources: [],
      error: balanceFailure ??
        pricingFailure ?? {
          code: 'provider_error',
          message: 'DeepSeek capacity could not be collected',
        },
    };
  }

  private async getBalance(): Promise<z.infer<typeof deepSeekBalanceResponseSchema>> {
    const payload = await this.request();
    const parsed = deepSeekBalanceResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DeepSeekAdapterError(
        'invalid_response',
        'DeepSeek returned an invalid balance response',
      );
    }
    return parsed.data;
  }

  private async request(): Promise<unknown> {
    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      let response: DeepSeekResponse;
      try {
        response = await this.fetcher(DEEPSEEK_BALANCE_URL, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey as string}`,
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (didTimeout || isAbortError(error)) {
          throw new DeepSeekAdapterError('timeout', 'DeepSeek request timed out for /user/balance');
        }
        throw new DeepSeekAdapterError('provider_error', 'DeepSeek balance request failed');
      }

      if (!response.ok || response.status < 200 || response.status >= 300) {
        throw new DeepSeekAdapterError(
          this.failureCodeForStatus(response.status),
          this.failureMessageForStatus(response.status),
        );
      }

      try {
        return await response.json();
      } catch (error) {
        if (didTimeout || isAbortError(error)) {
          throw new DeepSeekAdapterError('timeout', 'DeepSeek request timed out for /user/balance');
        }
        throw new DeepSeekAdapterError(
          'invalid_response',
          'DeepSeek returned invalid JSON for /user/balance',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private failureFrom(error: unknown): DeepSeekFailure {
    if (error instanceof DeepSeekBalanceDataError) {
      return { code: 'invalid_response', message: error.message };
    }
    if (error instanceof DeepSeekAdapterError) {
      return { code: error.code, message: error.message };
    }
    return { code: 'provider_error', message: 'DeepSeek capacity request failed unexpectedly' };
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

  private failureMessageForStatus(status: number): string {
    if (status === 401 || status === 403) {
      return 'DeepSeek authentication was rejected';
    }
    if (status === 429) {
      return 'DeepSeek rate limit reached';
    }
    if (status >= 500) {
      return 'DeepSeek provider error';
    }
    return 'DeepSeek balance request failed';
  }
}
