import Fastify, { type FastifyInstance } from 'fastify';

import { serviceHealthSchema } from '@sonoran-hub/contracts';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => {
    return serviceHealthSchema.parse({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });

  return app;
}
