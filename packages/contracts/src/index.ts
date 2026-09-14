import { z } from 'zod';

export const serviceHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export {
  capacityCollectionResultSchema,
  capacityErrorSchema,
  capacityFreshnessSchema,
  capacityKindSchema,
  capacityCurrentProviderSchema,
  capacityCurrentResponseSchema,
  capacityHistoryResponseSchema,
  capacityProviderHealthSchema,
  capacityResourceSchema,
  capacitySnapshotSchema,
  capacitySourceSchema,
  capacityStatusSchema,
  capacityTimestampSchema,
  capacityUnitSchema,
  type CapacityCollectionResult,
  type CapacityCurrentProvider,
  type CapacityCurrentResponse,
  type CapacityError,
  type CapacityFreshness,
  type CapacityHistoryResponse,
  type CapacityKind,
  type CapacityProviderHealth,
  type CapacityResource,
  type CapacitySnapshot,
  type CapacitySource,
  type CapacityStatus,
  type CapacityUnit,
} from './capacity.js';
