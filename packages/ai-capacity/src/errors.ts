export const providerFailureCodes = [
  'unavailable',
  'authentication',
  'rate_limited',
  'timeout',
  'invalid_response',
  'invalid_normalized_data',
  'provider_error',
  'unknown',
] as const;

export type ProviderFailureCode = (typeof providerFailureCodes)[number];
export type ProviderFailurePhase = 'probe' | 'collect';

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly providerId: string;
  readonly phase: ProviderFailurePhase;
  readonly message: string;
  readonly occurredAt: string;
}

export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

export function isProviderFailureCode(value: string): value is ProviderFailureCode {
  return (providerFailureCodes as readonly string[]).includes(value);
}
