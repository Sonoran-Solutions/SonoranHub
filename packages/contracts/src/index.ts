import { z } from 'zod';

export const serviceHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
