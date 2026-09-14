import { z } from 'zod';

export const baseConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
