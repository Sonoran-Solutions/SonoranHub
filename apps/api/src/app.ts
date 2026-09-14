import Fastify, { type FastifyInstance } from 'fastify';

import {
  createCorrelationId,
  loadConfig,
  parseCorrelationId,
  type AppConfig,
} from '@sonoran-hub/config';
import { serviceHealthSchema } from '@sonoran-hub/contracts';

export function buildApp(
  config: AppConfig = loadConfig(process.env, { defaultServiceName: 'sonoran-hub-api' }),
): FastifyInstance {
  const app = Fastify({
    logger: {
      base: { service: config.serviceName },
      level: config.logLevel,
    },
    genReqId: (request) => {
      const requestHeader = request.headers['x-request-id'];
      const requestId = Array.isArray(requestHeader) ? requestHeader[0] : requestHeader;
      return parseCorrelationId(requestId) ?? createCorrelationId();
    },
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  app.get('/health', async () => {
    return serviceHealthSchema.parse({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });

  return app;
}
