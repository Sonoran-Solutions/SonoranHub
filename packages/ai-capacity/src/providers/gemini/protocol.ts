import { z } from 'zod';

const boundedString = (max: number) => z.string().min(1).max(max);
const finiteNonNegative = z.number().finite().nonnegative();
const percentage = z.number().finite().min(0).max(100);
const fraction = z.number().finite().min(0).max(1);
const timestamp = z.string().datetime({ offset: true });

export const antigravityProcessEnvelopeSchema = z
  .object({
    conversation_id: z.string().max(200),
    status: boundedString(32),
    response: z.string().max(200_000).optional(),
    duration_seconds: finiteNonNegative.optional(),
    num_turns: z.number().int().nonnegative(),
    usage: z
      .object({
        input_tokens: finiteNonNegative.optional(),
        output_tokens: finiteNonNegative.optional(),
        thinking_tokens: finiteNonNegative.optional(),
        cache_read_tokens: finiteNonNegative.optional(),
        total_tokens: finiteNonNegative.optional(),
      })
      .passthrough()
      .optional(),
    command: z
      .object({
        name: boundedString(100),
        data: z.unknown(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const antigravityQuotaBucketSchema = z
  .object({
    id: boundedString(200),
    name: boundedString(300),
    description: z.string().max(1_000).optional(),
    window: boundedString(100).optional(),
    remaining_fraction: fraction.optional(),
    remaining_percent: percentage.optional(),
    reset_time: timestamp.optional(),
    reset_after_seconds: finiteNonNegative.optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
    model: z.string().max(200).optional(),
    quota_type: z.string().max(100).optional(),
  })
  .passthrough()
  .superRefine((bucket, context) => {
    if (
      bucket.disabled !== true &&
      bucket.enabled !== false &&
      bucket.remaining_fraction === undefined &&
      bucket.remaining_percent === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['remaining_fraction'],
        message: 'enabled quota buckets must report a remaining percentage or fraction',
      });
    }
    if (bucket.reset_time !== undefined && bucket.reset_after_seconds !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reset_time'],
        message: 'quota buckets must not report both absolute and relative reset values',
      });
    }
  });

export const antigravityQuotaGroupSchema = z
  .object({
    name: boundedString(300),
    description: z.string().max(1_000).optional(),
    buckets: z.array(antigravityQuotaBucketSchema).min(1),
  })
  .passthrough();

export const antigravityQuotaDataSchema = z
  .object({
    description: z.string().max(2_000).optional(),
    groups: z.array(antigravityQuotaGroupSchema).min(1),
    plan: z.string().max(200).optional(),
    plan_name: z.string().max(200).optional(),
    tier: z.string().max(200).optional(),
  })
  .passthrough();

export const antigravityCreditsDataSchema = z
  .object({
    remaining_credits: finiteNonNegative.optional(),
    unlimited: z.boolean().optional(),
    enabled: z.boolean().optional(),
    available: z.boolean().optional(),
    upgrade_uri: z.string().url().max(500).optional(),
  })
  .passthrough();

export type AntigravityProcessEnvelope = z.infer<typeof antigravityProcessEnvelopeSchema>;
export type AntigravityQuotaBucket = z.infer<typeof antigravityQuotaBucketSchema>;
export type AntigravityQuotaGroup = z.infer<typeof antigravityQuotaGroupSchema>;
export type AntigravityQuotaData = z.infer<typeof antigravityQuotaDataSchema>;
export type AntigravityCreditsData = z.infer<typeof antigravityCreditsDataSchema>;
