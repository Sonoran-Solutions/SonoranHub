import { z } from 'zod';

export const capacityKindSchema = z.enum([
  'rolling_quota',
  'weekly_quota',
  'wallet',
  'key_budget',
  'pricing_window',
  'credits',
  'concurrency',
]);

export const capacityStatusSchema = z.enum([
  'available',
  'warning',
  'critical',
  'exhausted',
  'unknown',
]);

export const capacityFreshnessSchema = z.enum(['fresh', 'stale', 'unknown']);

export const capacityUnitSchema = z.enum([
  'percent',
  'usd',
  'credits',
  'requests',
  'tokens',
  'connections',
  'state',
]);

export const capacitySourceSchema = z.enum([
  'official_api',
  'official_cli',
  'local_state',
  'derived',
]);

export const capacityTimestampSchema = z.string().datetime({ offset: true });
const nonNegativeNumber = z.number().finite().nonnegative();
const percentageSchema = z.number().finite().min(0).max(100);

export const capacityErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const capacityResourceShape = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    accountRef: z.string().min(1).optional(),
    kind: capacityKindSchema,
    name: z.string().min(1),
    limit: nonNegativeNumber.optional(),
    used: nonNegativeNumber.optional(),
    remaining: nonNegativeNumber.optional(),
    remainingPercent: percentageSchema.optional(),
    unit: capacityUnitSchema,
    resetAt: capacityTimestampSchema.optional(),
    changesAt: capacityTimestampSchema.optional(),
    status: capacityStatusSchema,
    source: capacitySourceSchema,
    collectedAt: capacityTimestampSchema,
    staleAfter: capacityTimestampSchema.optional(),
    freshness: capacityFreshnessSchema,
    error: capacityErrorSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const capacityResourceSchema = capacityResourceShape.superRefine((resource, context) => {
  if (
    resource.limit !== undefined &&
    resource.used !== undefined &&
    resource.used > resource.limit
  ) {
    context.addIssue({
      code: 'custom',
      path: ['used'],
      message: 'used cannot exceed limit',
    });
  }

  if (
    resource.limit !== undefined &&
    resource.remaining !== undefined &&
    resource.remaining > resource.limit
  ) {
    context.addIssue({
      code: 'custom',
      path: ['remaining'],
      message: 'remaining cannot exceed limit',
    });
  }

  if (
    resource.limit !== undefined &&
    resource.used !== undefined &&
    resource.remaining !== undefined
  ) {
    const difference = Math.abs(resource.used + resource.remaining - resource.limit);
    const tolerance = Math.max(1, Math.abs(resource.limit)) * 1e-9;

    if (difference > tolerance) {
      context.addIssue({
        code: 'custom',
        path: ['remaining'],
        message: 'used plus remaining must equal limit when all three are provided',
      });
    }
  }

  if (resource.unit === 'state') {
    for (const field of ['limit', 'used', 'remaining', 'remainingPercent'] as const) {
      if (resource[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'state resources must not include numeric capacity values',
        });
      }
    }
  }

  const expectedUnitByKind: Partial<
    Record<z.infer<typeof capacityKindSchema>, z.infer<typeof capacityUnitSchema>>
  > = {
    wallet: 'usd',
    key_budget: 'usd',
    pricing_window: 'state',
    credits: 'credits',
    concurrency: 'connections',
  };
  const expectedUnit = expectedUnitByKind[resource.kind];

  if (expectedUnit !== undefined && resource.unit !== expectedUnit) {
    context.addIssue({
      code: 'custom',
      path: ['unit'],
      message: `${resource.kind} resources must use the ${expectedUnit} unit`,
    });
  }
});

export type CapacityKind = z.infer<typeof capacityKindSchema>;
export type CapacityStatus = z.infer<typeof capacityStatusSchema>;
export type CapacityFreshness = z.infer<typeof capacityFreshnessSchema>;
export type CapacityUnit = z.infer<typeof capacityUnitSchema>;
export type CapacitySource = z.infer<typeof capacitySourceSchema>;
export type CapacityError = z.infer<typeof capacityErrorSchema>;
export type CapacityResource = z.infer<typeof capacityResourceSchema>;

export const capacitySnapshotSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    resources: z.array(capacityResourceSchema),
    collectedAt: capacityTimestampSchema,
    freshness: capacityFreshnessSchema,
    error: capacityErrorSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    snapshot.resources.forEach((resource, index) => {
      if (resource.provider !== snapshot.provider) {
        context.addIssue({
          code: 'custom',
          path: ['resources', index, 'provider'],
          message: 'resource provider must match snapshot provider',
        });
      }
    });
  });

export type CapacitySnapshot = z.infer<typeof capacitySnapshotSchema>;

export const capacityCollectionResultSchema = z
  .object({
    resources: z.array(capacityResourceSchema),
    collectedAt: capacityTimestampSchema,
    error: capacityErrorSchema.optional(),
  })
  .strict();

export type CapacityCollectionResult = z.infer<typeof capacityCollectionResultSchema>;
