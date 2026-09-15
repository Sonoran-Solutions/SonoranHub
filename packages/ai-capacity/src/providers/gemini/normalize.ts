import type { CapacityResource, CapacityStatus } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';
import type { GeminiCapacitySnapshot, GeminiSourceFailure } from './source.js';
import type {
  AntigravityQuotaBucket,
  AntigravityQuotaData,
  AntigravityQuotaGroup,
} from './protocol.js';

export const GEMINI_PROVIDER_ID = 'gemini';
export const GEMINI_SOURCE = 'official_cli' as const;

export class GeminiNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiNormalizationError';
  }
}

function bounded(value: string | undefined, max = 200): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function sanitizeGeminiResourceId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return sanitized || 'bucket';
}

export function geminiQuotaStatus(remainingPercent: number): CapacityStatus {
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    throw new GeminiNormalizationError('Antigravity reported an invalid remaining percentage');
  }
  if (remainingPercent === 0) return 'exhausted';
  if (remainingPercent <= 10) return 'critical';
  if (remainingPercent <= 20) return 'warning';
  return 'available';
}

function remainingPercent(bucket: AntigravityQuotaBucket): number | undefined {
  if (bucket.remaining_percent !== undefined) return bucket.remaining_percent;
  if (bucket.remaining_fraction !== undefined) {
    const value = bucket.remaining_fraction * 100;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new GeminiNormalizationError('Antigravity reported an invalid remaining fraction');
    }
    return value;
  }
  return undefined;
}

function resetFor(
  bucket: AntigravityQuotaBucket,
  collectedAt: string,
): {
  readonly resetAt?: string;
  readonly source?: 'relative_duration';
} {
  if (bucket.reset_time) return { resetAt: bucket.reset_time };
  if (bucket.reset_after_seconds !== undefined) {
    const collected = Date.parse(collectedAt);
    if (Number.isNaN(collected)) {
      throw new GeminiNormalizationError(
        'Collection timestamp is invalid for relative reset conversion',
      );
    }
    return {
      resetAt: new Date(collected + bucket.reset_after_seconds * 1_000).toISOString(),
      source: 'relative_duration',
    };
  }
  return {};
}

function metadataFor(
  group: AntigravityQuotaGroup,
  bucket: AntigravityQuotaBucket,
  snapshot: GeminiCapacitySnapshot,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    collector: 'Antigravity CLI',
    group_name: group.name.slice(0, 300),
    bucket_id: bucket.id.slice(0, 200),
  };
  const description = bounded(bucket.description ?? group.description, 500);
  const window = bounded(bucket.window, 100);
  const model = bounded(bucket.model, 200);
  const quotaType = bounded(bucket.quota_type, 100);
  const planTier = bounded(snapshot.planTier, 100);
  if (description) metadata.description = description;
  if (window) metadata.window = window;
  if (model) metadata.model = model;
  if (quotaType) metadata.quota_type = quotaType;
  if (planTier) metadata.plan_tier = planTier;
  if (snapshot.antigravityVersion) metadata.antigravity_version = snapshot.antigravityVersion;
  if (bucket.disabled === true || bucket.enabled === false) metadata.disabled = true;
  return metadata;
}

function quotaResource(
  group: AntigravityQuotaGroup,
  bucket: AntigravityQuotaBucket,
  snapshot: GeminiCapacitySnapshot,
  collectedAt: string,
): CapacityResource {
  const id = `gemini-${sanitizeGeminiResourceId(group.name)}-${sanitizeGeminiResourceId(bucket.id)}`;
  const reset = resetFor(bucket, collectedAt);
  const disabled = bucket.disabled === true || bucket.enabled === false;
  const percent = remainingPercent(bucket);
  const metadata = metadataFor(group, bucket, snapshot);
  if (reset.source) metadata.reset_source = reset.source;
  return {
    id,
    provider: GEMINI_PROVIDER_ID,
    kind: bucket.window?.toLowerCase() === 'weekly' ? 'weekly_quota' : 'rolling_quota',
    name: `${group.name} · ${bucket.name}`,
    ...(percent === undefined
      ? {}
      : { limit: 100, used: 100 - percent, remaining: percent, remainingPercent: percent }),
    unit: 'percent',
    ...(reset.resetAt ? { resetAt: reset.resetAt } : {}),
    status: disabled ? 'unknown' : percent === undefined ? 'unknown' : geminiQuotaStatus(percent),
    source: GEMINI_SOURCE,
    collectedAt,
    freshness: disabled || percent === undefined ? 'unknown' : 'fresh',
    metadata,
  };
}

function creditsResource(
  data: NonNullable<GeminiCapacitySnapshot['credits']>,
  snapshot: GeminiCapacitySnapshot,
  collectedAt: string,
): CapacityResource {
  const metadata: Record<string, unknown> = {
    collector: 'Antigravity CLI',
    credits_state: data.unlimited ? 'unlimited' : 'reported',
    antigravity_version: snapshot.antigravityVersion,
  };
  if (snapshot.planTier) metadata.plan_tier = snapshot.planTier;
  if (data.upgrade_uri) metadata.upgrade_available = true;
  if (data.enabled === false) {
    return {
      id: 'gemini-g1-credits',
      provider: GEMINI_PROVIDER_ID,
      kind: 'credits',
      name: 'G1 / AI credits',
      unit: 'credits',
      status: 'unknown',
      source: GEMINI_SOURCE,
      collectedAt,
      freshness: 'unknown',
      metadata: { ...metadata, credits_state: 'disabled' },
    };
  }
  if (data.unlimited === true) {
    return {
      id: 'gemini-g1-credits',
      provider: GEMINI_PROVIDER_ID,
      kind: 'credits',
      name: 'G1 / AI credits',
      unit: 'credits',
      status: 'available',
      source: GEMINI_SOURCE,
      collectedAt,
      freshness: 'fresh',
      metadata,
    };
  }
  if (data.remaining_credits === undefined || data.available === false) {
    return {
      id: 'gemini-g1-credits',
      provider: GEMINI_PROVIDER_ID,
      kind: 'credits',
      name: 'G1 / AI credits',
      unit: 'credits',
      status: 'unknown',
      source: GEMINI_SOURCE,
      collectedAt,
      freshness: 'unknown',
      metadata: {
        ...metadata,
        credits_state: data.available === false ? 'unavailable' : 'unknown',
      },
    };
  }
  return {
    id: 'gemini-g1-credits',
    provider: GEMINI_PROVIDER_ID,
    kind: 'credits',
    name: 'G1 / AI credits',
    remaining: data.remaining_credits,
    unit: 'credits',
    status: data.remaining_credits === 0 ? 'exhausted' : 'available',
    source: GEMINI_SOURCE,
    collectedAt,
    freshness: 'fresh',
    metadata,
  };
}

function unknownCreditsResource(
  failure: GeminiSourceFailure,
  snapshot: GeminiCapacitySnapshot,
  collectedAt: string,
): CapacityResource {
  return {
    id: 'gemini-g1-credits',
    provider: GEMINI_PROVIDER_ID,
    kind: 'credits',
    name: 'G1 / AI credits',
    unit: 'credits',
    status: 'unknown',
    source: GEMINI_SOURCE,
    collectedAt,
    freshness: 'unknown',
    error: { code: failure.code, message: failure.message },
    metadata: { collector: 'Antigravity CLI', antigravity_version: snapshot.antigravityVersion },
  };
}

function unknownFailure(failure: GeminiSourceFailure): {
  code: ProviderFailureCode;
  message: string;
} {
  return { code: failure.code, message: failure.message };
}

export function normalizeGeminiCapacity(
  snapshot: GeminiCapacitySnapshot,
  collectedAt: string,
): CapacityResource[] {
  const resources: CapacityResource[] = [];
  if (snapshot.quota) {
    const seen = new Set<string>();
    for (const group of snapshot.quota.groups) {
      for (const bucket of group.buckets) {
        const id = `gemini-${sanitizeGeminiResourceId(group.name)}-${sanitizeGeminiResourceId(bucket.id)}`;
        if (seen.has(id))
          throw new GeminiNormalizationError(
            'Antigravity returned duplicate quota bucket identities',
          );
        seen.add(id);
        resources.push(quotaResource(group, bucket, snapshot, collectedAt));
      }
    }
  }
  if (snapshot.credits) resources.push(creditsResource(snapshot.credits, snapshot, collectedAt));
  else if (snapshot.creditsError)
    resources.push(unknownCreditsResource(snapshot.creditsError, snapshot, collectedAt));
  return resources;
}

export function geminiCollectionError(
  snapshot: GeminiCapacitySnapshot,
): { code: ProviderFailureCode; message: string } | undefined {
  if (snapshot.quotaError) return unknownFailure(snapshot.quotaError);
  if (snapshot.creditsError) return unknownFailure(snapshot.creditsError);
  return undefined;
}

export function quotaDataHasPlanTier(data: AntigravityQuotaData): string | undefined {
  return [data.plan, data.plan_name, data.tier].find((value) => Boolean(value?.trim()));
}
