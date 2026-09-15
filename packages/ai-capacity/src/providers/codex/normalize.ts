import type { CapacityResource, CapacityStatus } from '@sonoran-hub/contracts';

import type {
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
} from './protocol.js';
import type { CodexRateLimitSnapshot as SourceRateLimitSnapshot } from './source.js';

export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_SOURCE = 'official_cli' as const;
export const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export class CodexNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexNormalizationError';
  }
}

/** Convert a reported duration into a truthful, deterministic UI label. */
export function formatCodexQuotaWindowLabel(durationMinutes: number | null | undefined): string {
  if (durationMinutes === undefined || durationMinutes === null) {
    return 'Quota window';
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new CodexNormalizationError('Codex reported an invalid quota window duration');
  }
  if (durationMinutes === CODEX_WEEKLY_WINDOW_MINUTES) {
    return 'Weekly quota';
  }
  if (durationMinutes % (24 * 60) === 0 && durationMinutes > 24 * 60) {
    return `${durationMinutes / (24 * 60)}-day quota`;
  }
  if (durationMinutes % 60 === 0) {
    return `${durationMinutes / 60}-hour quota`;
  }
  return `${durationMinutes}-minute quota`;
}

/** Sanitize an upstream limit ID while keeping the stable identity recognizable. */
export function sanitizeCodexLimitId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'codex';
}

export function codexQuotaStatus(
  remainingPercent: number,
  options: {
    readonly ordinaryUsageAllowed?: boolean | null;
    readonly rateLimitReachedType?: string | null;
    readonly spendControlReached?: boolean | null;
  } = {},
): CapacityStatus {
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    throw new CodexNormalizationError('Codex reported an invalid remaining percentage');
  }
  if (options.rateLimitReachedType || options.spendControlReached === true) {
    return 'exhausted';
  }
  // A true permission state means a rounded 0% must not overrule the backend.
  if (remainingPercent === 0 && options.ordinaryUsageAllowed === true) {
    return 'critical';
  }
  if (remainingPercent === 0) {
    return 'exhausted';
  }
  if (options.ordinaryUsageAllowed === false) {
    return 'critical';
  }
  if (remainingPercent <= 10) {
    return 'critical';
  }
  if (remainingPercent <= 20) {
    return 'warning';
  }
  return 'available';
}

export function codexUnixSecondsToIso(value: number | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new CodexNormalizationError('Codex reported an invalid reset timestamp');
  }
  const date = new Date(value * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new CodexNormalizationError('Codex reported an unusable reset timestamp');
  }
  return date.toISOString();
}

function finiteCreditBalance(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function boundedString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function metadataForBucket(
  bucket: CodexRateLimitSnapshot,
  limitId: string,
  snapshot: SourceRateLimitSnapshot,
  role?: 'primary' | 'secondary',
  durationMinutes?: number | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    limit_id: limitId,
    protocol_source: 'codex app-server',
    collector_version: 'sonoran-hub-codex-source-v1',
  };
  const limitName = boundedString(bucket.limitName);
  const normalModelSlug = boundedString(bucket.normalModelSlug);
  const planType = bucket.planType ?? snapshot.planType;
  if (limitName) metadata.limit_name = limitName;
  if (normalModelSlug) metadata.normal_model_slug = normalModelSlug;
  if (planType) metadata.plan_type = planType;
  if (snapshot.codexVersion) metadata.codex_version = snapshot.codexVersion;
  if (snapshot.response.ordinaryUsageAllowed !== undefined) {
    metadata.ordinary_usage_allowed = snapshot.response.ordinaryUsageAllowed;
  }
  if (bucket.rateLimitReachedType !== undefined) {
    metadata.rate_limit_reached_type = bucket.rateLimitReachedType;
  }
  if (bucket.spendControlReached !== undefined) {
    metadata.spend_control_reached = bucket.spendControlReached;
  }
  if (role) metadata.window_role = role;
  if (durationMinutes !== undefined && durationMinutes !== null) {
    metadata.window_duration_mins = durationMinutes;
  }
  return metadata;
}

function windowResource(
  bucket: CodexRateLimitSnapshot,
  limitId: string,
  window: CodexRateLimitWindow,
  role: 'primary' | 'secondary',
  isMain: boolean,
  snapshot: SourceRateLimitSnapshot,
  collectedAt: string,
): CapacityResource {
  const remainingPercent = 100 - window.usedPercent;
  const durationMinutes = window.windowDurationMins;
  const quotaLabel = formatCodexQuotaWindowLabel(durationMinutes);
  const bucketLabel = boundedString(bucket.limitName) ?? boundedString(bucket.limitId) ?? limitId;
  const name = isMain ? quotaLabel : `${bucketLabel} · ${quotaLabel}`;
  const metadata = metadataForBucket(bucket, limitId, snapshot, role, durationMinutes);
  return {
    id: `codex-${sanitizeCodexLimitId(limitId)}-${role}`,
    provider: CODEX_PROVIDER_ID,
    kind:
      role === 'secondary' && durationMinutes === CODEX_WEEKLY_WINDOW_MINUTES
        ? 'weekly_quota'
        : 'rolling_quota',
    name,
    limit: 100,
    used: window.usedPercent,
    remaining: remainingPercent,
    remainingPercent,
    unit: 'percent',
    ...(codexUnixSecondsToIso(window.resetsAt)
      ? { resetAt: codexUnixSecondsToIso(window.resetsAt) }
      : {}),
    status: codexQuotaStatus(remainingPercent, {
      ordinaryUsageAllowed: snapshot.response.ordinaryUsageAllowed,
      rateLimitReachedType: bucket.rateLimitReachedType,
      spendControlReached: bucket.spendControlReached,
    }),
    source: CODEX_SOURCE,
    collectedAt,
    freshness: 'fresh',
    metadata,
  };
}

function creditsResource(
  bucket: CodexRateLimitSnapshot,
  limitId: string,
  snapshot: SourceRateLimitSnapshot,
  collectedAt: string,
): CapacityResource {
  const credits = bucket.credits;
  const metadata = metadataForBucket(bucket, limitId, snapshot);
  metadata.credits_has_credits = credits?.hasCredits;
  metadata.credits_unlimited = credits?.unlimited;
  const balance = finiteCreditBalance(credits?.balance);
  if (credits?.balance !== undefined && credits.balance !== null) {
    metadata.credits_balance = credits.balance.slice(0, 100);
  }
  if (credits?.unlimited) {
    return {
      id: `codex-${sanitizeCodexLimitId(limitId)}-credits`,
      provider: CODEX_PROVIDER_ID,
      kind: 'credits',
      name: 'Provider credits',
      unit: 'credits',
      status: 'available',
      source: CODEX_SOURCE,
      collectedAt,
      freshness: 'fresh',
      metadata: { ...metadata, credits_state: 'unlimited' },
    };
  }
  if (balance === undefined) {
    return {
      id: `codex-${sanitizeCodexLimitId(limitId)}-credits`,
      provider: CODEX_PROVIDER_ID,
      kind: 'credits',
      name: 'Provider credits',
      unit: 'credits',
      status: 'unknown',
      source: CODEX_SOURCE,
      collectedAt,
      freshness: 'unknown',
      metadata,
    };
  }
  return {
    id: `codex-${sanitizeCodexLimitId(limitId)}-credits`,
    provider: CODEX_PROVIDER_ID,
    kind: 'credits',
    name: 'Provider credits',
    remaining: balance,
    unit: 'credits',
    status: balance === 0 ? 'exhausted' : 'available',
    source: CODEX_SOURCE,
    collectedAt,
    freshness: 'fresh',
    metadata,
  };
}

function spendControlResource(
  bucket: CodexRateLimitSnapshot,
  limitId: string,
  snapshot: SourceRateLimitSnapshot,
  collectedAt: string,
): CapacityResource {
  const individualLimit = bucket.individualLimit;
  if (!individualLimit) {
    throw new CodexNormalizationError('Codex spend-control resource is missing');
  }
  const remainingPercent = individualLimit.remainingPercent;
  const metadata = metadataForBucket(bucket, limitId, snapshot);
  metadata.spend_control = true;
  metadata.provider_limit = individualLimit.limit.slice(0, 100);
  metadata.provider_used = individualLimit.used.slice(0, 100);
  return {
    id: `codex-${sanitizeCodexLimitId(limitId)}-spend-control`,
    provider: CODEX_PROVIDER_ID,
    kind: 'rolling_quota',
    name: 'Spend control',
    limit: 100,
    used: 100 - remainingPercent,
    remaining: remainingPercent,
    remainingPercent,
    unit: 'percent',
    resetAt: codexUnixSecondsToIso(individualLimit.resetsAt),
    status: codexQuotaStatus(remainingPercent, {
      ordinaryUsageAllowed: snapshot.response.ordinaryUsageAllowed,
      rateLimitReachedType: bucket.rateLimitReachedType,
      spendControlReached: bucket.spendControlReached,
    }),
    source: CODEX_SOURCE,
    collectedAt,
    freshness: 'fresh',
    metadata,
  };
}

interface BucketEntry {
  readonly key: string;
  readonly bucket: CodexRateLimitSnapshot;
  readonly isMain: boolean;
}

function bucketEntries(response: CodexRateLimitsResponse): BucketEntry[] {
  const entries: BucketEntry[] = [];
  const seen = new Set<string>();
  const multi = response.rateLimitsByLimitId;
  if (multi && Object.keys(multi).length > 0) {
    for (const [key, bucket] of Object.entries(multi)) {
      const limitId = boundedString(bucket.limitId) ?? boundedString(key) ?? 'codex';
      if (seen.has(limitId)) continue;
      seen.add(limitId);
      entries.push({ key: limitId, bucket, isMain: limitId === 'codex' });
    }
  }
  const legacy = response.rateLimits;
  const legacyId = boundedString(legacy.limitId) ?? 'codex';
  if (!seen.has(legacyId)) {
    entries.push({ key: legacyId, bucket: legacy, isMain: legacyId === 'codex' });
  }
  if (entries.length > 0 && !entries.some((entry) => entry.isMain)) {
    entries[0] = { ...entries[0]!, isMain: true };
  }
  return entries;
}

export function normalizeCodexRateLimits(
  snapshot: SourceRateLimitSnapshot,
  collectedAt: string,
): readonly CapacityResource[] {
  const resources: CapacityResource[] = [];
  for (const entry of bucketEntries(snapshot.response)) {
    const { bucket, key, isMain } = entry;
    if (bucket.primary) {
      resources.push(
        windowResource(bucket, key, bucket.primary, 'primary', isMain, snapshot, collectedAt),
      );
    }
    if (bucket.secondary) {
      resources.push(
        windowResource(bucket, key, bucket.secondary, 'secondary', isMain, snapshot, collectedAt),
      );
    }
    if (bucket.credits) {
      resources.push(creditsResource(bucket, key, snapshot, collectedAt));
    }
    if (bucket.individualLimit) {
      resources.push(spendControlResource(bucket, key, snapshot, collectedAt));
    }
  }
  const resetCredits = snapshot.response.rateLimitResetCredits;
  if (resetCredits) {
    resources.push({
      id: 'codex-quota-reset-credits',
      provider: CODEX_PROVIDER_ID,
      kind: 'credits',
      name: 'Available quota resets',
      remaining: resetCredits.availableCount,
      unit: 'credits',
      status: resetCredits.availableCount > 0 ? 'available' : 'exhausted',
      source: CODEX_SOURCE,
      collectedAt,
      freshness: 'fresh',
      metadata: {
        available_count: resetCredits.availableCount,
        detail_rows_available: resetCredits.credits !== null && resetCredits.credits !== undefined,
        protocol_source: 'codex app-server',
        collector_version: 'sonoran-hub-codex-source-v1',
        ...(snapshot.codexVersion ? { codex_version: snapshot.codexVersion } : {}),
      },
    });
  }
  if (resources.length === 0) {
    throw new CodexNormalizationError('Codex returned no usable rate-limit resources');
  }
  return resources;
}
