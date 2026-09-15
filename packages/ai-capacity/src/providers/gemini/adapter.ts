import type { CapacityCollectionResult } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';
import type { AdapterAvailability, CapacityProviderAdapter } from '../../types.js';
import {
  GeminiNormalizationError,
  geminiCollectionError,
  normalizeGeminiCapacity,
} from './normalize.js';
import {
  AntigravityCliSource,
  type AntigravityCliSourceOptions,
  type GeminiCapacitySource,
} from './source.js';

export const GEMINI_PROVIDER_ID = 'gemini';

export interface GeminiCapacityAdapterOptions {
  readonly source?: GeminiCapacitySource;
  readonly sourceOptions?: AntigravityCliSourceOptions;
  readonly now?: () => string;
}

interface GeminiFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

function failureFrom(error: unknown): GeminiFailure {
  if (error instanceof GeminiNormalizationError) {
    return { code: 'invalid_normalized_data', message: error.message };
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    const allowed: readonly ProviderFailureCode[] = [
      'unavailable',
      'authentication',
      'rate_limited',
      'timeout',
      'invalid_response',
      'invalid_normalized_data',
      'provider_error',
      'unknown',
    ];
    if (allowed.includes(error.code as ProviderFailureCode)) {
      return { code: error.code as ProviderFailureCode, message: error.message };
    }
  }
  return { code: 'provider_error', message: 'Gemini capacity request failed unexpectedly' };
}

export class GeminiCapacityAdapter implements CapacityProviderAdapter {
  readonly id = GEMINI_PROVIDER_ID;

  private readonly source: GeminiCapacitySource;
  private readonly now: () => string;

  constructor(options: GeminiCapacityAdapterOptions = {}) {
    this.source = options.source ?? new AntigravityCliSource(options.sourceOptions);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async probe(): Promise<AdapterAvailability> {
    const checkedAt = this.now();
    try {
      const result = await this.source.probe();
      return {
        providerId: this.id,
        available: result.available,
        checkedAt,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.failure
          ? {
              failure: {
                providerId: this.id,
                phase: 'probe' as const,
                code: result.failure.code,
                message: result.failure.message,
                occurredAt: checkedAt,
              },
            }
          : {}),
      };
    } catch (error) {
      const failure = failureFrom(error);
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
    try {
      const snapshot = await this.source.readCapacity();
      const resources = normalizeGeminiCapacity(snapshot, collectedAt);
      return {
        collectedAt,
        resources,
        ...(geminiCollectionError(snapshot) ? { error: geminiCollectionError(snapshot) } : {}),
      };
    } catch (error) {
      const failure = failureFrom(error);
      return { collectedAt, resources: [], error: failure };
    }
  }

  async close(): Promise<void> {
    await this.source.close();
  }
}
