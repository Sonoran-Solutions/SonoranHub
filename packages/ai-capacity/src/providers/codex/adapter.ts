import type { CapacityCollectionResult } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';
import type { AdapterAvailability, CapacityProviderAdapter } from '../../types.js';
import { CodexNormalizationError, normalizeCodexRateLimits } from './normalize.js';
import {
  CodexAppServerSource,
  type CodexAppServerSourceOptions,
  type CodexCapacitySource,
} from './source.js';

export const CODEX_PROVIDER_ID = 'codex';

export interface CodexCapacityAdapterOptions {
  readonly source?: CodexCapacitySource;
  readonly sourceOptions?: CodexAppServerSourceOptions;
  readonly now?: () => string;
}

interface CodexFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

function failureFrom(error: unknown): CodexFailure {
  if (error instanceof CodexNormalizationError) {
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
    const code = error.code as ProviderFailureCode;
    if (
      [
        'unavailable',
        'authentication',
        'rate_limited',
        'timeout',
        'invalid_response',
        'invalid_normalized_data',
        'provider_error',
        'unknown',
      ].includes(code)
    ) {
      return { code, message: error.message };
    }
  }
  return { code: 'provider_error', message: 'Codex capacity request failed unexpectedly' };
}

export class CodexCapacityAdapter implements CapacityProviderAdapter {
  readonly id = CODEX_PROVIDER_ID;

  private readonly source: CodexCapacitySource;
  private readonly now: () => string;

  constructor(options: CodexCapacityAdapterOptions = {}) {
    this.source = options.source ?? new CodexAppServerSource(options.sourceOptions);
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
      const resources = normalizeCodexRateLimits(snapshot, collectedAt);
      return { collectedAt, resources: [...resources] };
    } catch (error) {
      const failure = failureFrom(error);
      return { collectedAt, resources: [], error: failure };
    }
  }

  async close(): Promise<void> {
    await this.source.close();
  }
}
