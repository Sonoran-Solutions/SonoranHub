import { z } from 'zod';

/**
 * These schemas mirror the current official `codex app-server` v2 protocol.
 * They intentionally retain unknown fields so a newer local CLI can add
 * non-breaking fields without making Hub discard an otherwise valid snapshot.
 */
export const codexPlanTypeSchema = z.enum([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'business',
  'ent26',
  'enterprise_cbp_automation',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'edu_plus',
  'edu_pro',
  'unknown',
]);

export const codexRateLimitReachedTypeSchema = z.enum([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

const unixSecondsSchema = z.number().int().nonnegative();
const percentageSchema = z.number().int().finite().min(0).max(100);

export const codexRateLimitWindowSchema = z
  .object({
    usedPercent: percentageSchema,
    windowDurationMins: unixSecondsSchema.nullable().optional(),
    resetsAt: unixSecondsSchema.nullable().optional(),
  })
  .passthrough();

export const codexCreditsSnapshotSchema = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable().optional(),
  })
  .passthrough();

export const codexSpendControlLimitSnapshotSchema = z
  .object({
    limit: z.string(),
    used: z.string(),
    remainingPercent: percentageSchema,
    resetsAt: unixSecondsSchema,
  })
  .passthrough();

export const codexRateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    normalModelSlug: z.string().nullable().optional(),
    planType: codexPlanTypeSchema.nullable().optional(),
    primary: codexRateLimitWindowSchema.nullable().optional(),
    secondary: codexRateLimitWindowSchema.nullable().optional(),
    credits: codexCreditsSnapshotSchema.nullable().optional(),
    individualLimit: codexSpendControlLimitSnapshotSchema.nullable().optional(),
    spendControlReached: z.boolean().nullable().optional(),
    rateLimitReachedType: codexRateLimitReachedTypeSchema.nullable().optional(),
  })
  .passthrough();

const codexRateLimitResetTypeSchema = z.enum(['codexRateLimits', 'unknown']);
const codexRateLimitResetCreditStatusSchema = z.enum([
  'available',
  'redeeming',
  'redeemed',
  'unknown',
]);

const codexRateLimitResetCreditSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    grantedAt: unixSecondsSchema,
    expiresAt: unixSecondsSchema.nullable().optional(),
    resetType: codexRateLimitResetTypeSchema,
    status: codexRateLimitResetCreditStatusSchema,
  })
  .passthrough();

export const codexRateLimitResetCreditsSchema = z
  .object({
    availableCount: z.number().int().nonnegative(),
    credits: z.array(codexRateLimitResetCreditSchema).nullable().optional(),
  })
  .passthrough();

export const codexRateLimitsResponseSchema = z
  .object({
    // The official v2 schema keeps this legacy field required for compatibility.
    rateLimits: codexRateLimitSnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), codexRateLimitSnapshotSchema).nullable().optional(),
    ordinaryUsageAllowed: z.boolean().nullable().optional(),
    rateLimitResetCredits: codexRateLimitResetCreditsSchema.nullable().optional(),
    accountId: z.string().nullable().optional(),
    rateLimitUpsell: z.unknown().optional(),
  })
  .passthrough();

export const codexAccountResponseSchema = z
  .object({
    requiresOpenaiAuth: z.boolean(),
    account: z
      .union([
        z.object({ type: z.literal('apiKey') }).passthrough(),
        z
          .object({
            type: z.literal('chatgpt'),
            email: z.string().nullable(),
            planType: codexPlanTypeSchema,
          })
          .passthrough(),
        z
          .object({
            type: z.literal('amazonBedrock'),
            usesCodexManagedCredentials: z.boolean().optional(),
          })
          .passthrough(),
      ])
      .nullable()
      .optional(),
  })
  .passthrough();

export const codexInitializeResponseSchema = z
  .object({
    userAgent: z.string(),
    platformFamily: z.string(),
    platformOs: z.string(),
    codexHome: z.string(),
  })
  .passthrough();

export type CodexPlanType = z.infer<typeof codexPlanTypeSchema>;
export type CodexRateLimitWindow = z.infer<typeof codexRateLimitWindowSchema>;
export type CodexRateLimitSnapshot = z.infer<typeof codexRateLimitSnapshotSchema>;
export type CodexRateLimitsResponse = z.infer<typeof codexRateLimitsResponseSchema>;
export type CodexAccountResponse = z.infer<typeof codexAccountResponseSchema>;
export type CodexAccount = NonNullable<CodexAccountResponse['account']>;
export type CodexInitializeResponse = z.infer<typeof codexInitializeResponseSchema>;
