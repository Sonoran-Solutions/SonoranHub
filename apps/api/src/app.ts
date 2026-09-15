import Fastify, { type FastifyInstance } from 'fastify';

import {
  createCorrelationId,
  loadConfig,
  parseCorrelationId,
  redactMetadata,
  type AppConfig,
} from '@sonoran-hub/config';
import {
  capacityCurrentResponseSchema,
  capacityHistoryResponseSchema,
  capacityTimestampSchema,
  serviceHealthSchema,
  type CapacitySnapshot,
} from '@sonoran-hub/contracts';

import {
  MAX_HISTORY_LIMIT,
  CapacitySnapshotStoreError,
  CapacityService,
} from '@sonoran-hub/ai-capacity';

import { DEFAULT_WEB_ORIGINS } from './cors.js';

export interface BuildAppOptions {
  readonly capacityService?: CapacityService;
  readonly allowedOrigins?: readonly string[];
}

export function buildApp(
  config: AppConfig = loadConfig(process.env, { defaultServiceName: 'sonoran-hub-api' }),
  options: BuildAppOptions = {},
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
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_WEB_ORIGINS);

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    const origin = request.headers.origin;
    if (origin !== undefined) {
      reply.header('vary', 'Origin');
      if (allowedOrigins.has(origin)) {
        reply.header('access-control-allow-origin', origin);
      }
    }
    done();
  });

  app.get('/health', async () => {
    return serviceHealthSchema.parse({
      status: 'ok',
      service: 'sonoran-hub-api',
    });
  });

  app.get('/capacity', async (_request, reply) => {
    const service = options.capacityService;
    if (!service) {
      return capacityCurrentResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        providers: [],
      });
    }

    try {
      const snapshots = await service.latest();
      const snapshotByProvider = new Map(
        snapshots.map((snapshot) => [snapshot.provider, markSnapshotFreshness(snapshot)]),
      );
      return capacityCurrentResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        providers: service.listProviderIds().map((providerId) => ({
          providerId,
          snapshot: snapshotByProvider.get(providerId) ?? null,
          health: publicHealth(service.getHealth(providerId)),
        })),
      });
    } catch {
      reply.code(503);
      return { error: { code: 'capacity_unavailable', message: 'Capacity data is unavailable' } };
    }
  });

  app.get<{ Querystring: { provider?: string; since?: string; limit?: string } }>(
    '/capacity/history',
    async (request, reply) => {
      const provider = request.query.provider;
      const since = request.query.since;
      const parsedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (
        (provider !== undefined && !provider.trim()) ||
        (since !== undefined && !capacityTimestampSchema.safeParse(since).success) ||
        !Number.isInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > MAX_HISTORY_LIMIT
      ) {
        reply.code(400);
        return {
          error: {
            code: 'invalid_query',
            message: `provider, since, and limit (${MAX_HISTORY_LIMIT} maximum) are invalid`,
          },
        };
      }

      const service = options.capacityService;
      if (!service) {
        return capacityHistoryResponseSchema.parse({ snapshots: [] });
      }
      try {
        return capacityHistoryResponseSchema.parse({
          snapshots: await service.history({ providerId: provider, since, limit: parsedLimit }),
        });
      } catch (error) {
        if (error instanceof CapacitySnapshotStoreError) {
          reply.code(503);
          return {
            error: { code: 'capacity_unavailable', message: 'Capacity history is unavailable' },
          };
        }
        reply.code(400);
        return { error: { code: 'invalid_query', message: 'Capacity history query is invalid' } };
      }
    },
  );

  return app;
}

function publicHealth(health: ReturnType<CapacityService['getHealth']>) {
  if (!health) {
    return { providerId: 'unknown' };
  }
  return {
    providerId: health.providerId,
    ...(health.available === undefined ? {} : { available: health.available }),
    ...(health.lastProbe
      ? {
          lastProbe: {
            providerId: health.lastProbe.providerId,
            available: health.lastProbe.available,
            checkedAt: health.lastProbe.checkedAt,
            ...(health.lastProbe.reason ? { reason: safeMessage(health.lastProbe.reason) } : {}),
            ...(health.lastProbe.failure
              ? {
                  error: safeHealthError(
                    health.lastProbe.failure.message,
                    health.lastProbe.failure.code,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(health.lastCollectionAttempt
      ? { lastCollectionAttempt: health.lastCollectionAttempt }
      : {}),
    ...(health.lastSuccessfulCollection
      ? { lastSuccessfulCollection: health.lastSuccessfulCollection }
      : {}),
    ...(health.lastProbeFailure
      ? {
          lastProbeFailure: safeHealthError(
            health.lastProbeFailure.message,
            health.lastProbeFailure.code,
          ),
        }
      : {}),
    ...(health.lastCollectionFailure
      ? {
          lastCollectionFailure: safeHealthError(
            health.lastCollectionFailure.message,
            health.lastCollectionFailure.code,
          ),
        }
      : {}),
    ...(health.lastError
      ? { lastError: safeHealthError(health.lastError.message, health.lastError.code) }
      : {}),
  };
}

function safeHealthError(message: string, code: string) {
  return { code, message: safeMessage(message) };
}

function safeMessage(message: string): string {
  const redacted = redactMetadata(message);
  return (typeof redacted === 'string' ? redacted : 'Capacity operation failed')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function markSnapshotFreshness(snapshot: CapacitySnapshot): CapacitySnapshot {
  const now = Date.now();
  const resources = snapshot.resources.map((resource) => {
    if (
      resource.freshness === 'fresh' &&
      resource.staleAfter !== undefined &&
      Date.parse(resource.staleAfter) <= now
    ) {
      return { ...resource, freshness: 'stale' as const };
    }
    return resource;
  });
  const freshness = resources.some((resource) => resource.freshness === 'stale')
    ? ('stale' as const)
    : snapshot.freshness;
  return { ...snapshot, resources, freshness };
}
