import { Pool } from 'pg';

import {
  CapacityAdapterRegistry,
  CapacityCoordinator,
  CapacityRefreshScheduler,
  CapacityService,
  CodexCapacityAdapter,
  DeepSeekCapacityAdapter,
  GeminiCapacityAdapter,
  InMemoryCapacitySnapshotStore,
  OpenRouterCapacityAdapter,
  PostgresCapacitySnapshotStore,
  type CodexCapacitySource,
  type GeminiCapacitySource,
  type CapacitySnapshotStore,
} from '@sonoran-hub/ai-capacity';
import { createStructuredLogger, type AppConfig, type StructuredLogger } from '@sonoran-hub/config';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export interface CapacityRuntimeEnvironment {
  readonly DATABASE_URL?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENROUTER_MANAGEMENT_KEY?: string;
  readonly DEEPSEEK_API_KEY?: string;
  readonly CODEX_BIN?: string;
  readonly AGY_BIN?: string;
  readonly CAPACITY_REFRESH_INTERVAL_MS?: string;
}

export interface CapacityRuntimeOptions {
  readonly environment: CapacityRuntimeEnvironment;
  readonly config: AppConfig;
  readonly logger?: StructuredLogger;
  readonly store?: CapacitySnapshotStore;
  readonly codexSource?: CodexCapacitySource;
  readonly geminiSource?: GeminiCapacitySource;
}

export interface CapacityRuntime {
  readonly coordinator: CapacityCoordinator;
  readonly service: CapacityService;
  readonly scheduler: CapacityRefreshScheduler;
  readonly pool?: Pool;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCapacityRuntime(options: CapacityRuntimeOptions): CapacityRuntime {
  const logger =
    options.logger ??
    createStructuredLogger({
      serviceName: options.config.serviceName,
      level: options.config.logLevel,
    });
  const registry = new CapacityAdapterRegistry();
  registry.register(
    new OpenRouterCapacityAdapter({
      apiKey: options.environment.OPENROUTER_API_KEY,
      managementKey: options.environment.OPENROUTER_MANAGEMENT_KEY,
    }),
  );
  registry.register(new DeepSeekCapacityAdapter({ apiKey: options.environment.DEEPSEEK_API_KEY }));
  const codex = new CodexCapacityAdapter({
    source: options.codexSource,
    sourceOptions: {
      executable: options.environment.CODEX_BIN || 'codex',
      onDiagnostic: (message) => logger.debug('capacity.codex.stderr', { metadata: { message } }),
    },
  });
  registry.register(codex);
  const gemini = new GeminiCapacityAdapter({
    source: options.geminiSource,
    sourceOptions: {
      executable: options.environment.AGY_BIN || 'agy',
      onDiagnostic: (message) => logger.debug('capacity.gemini.stderr', { metadata: { message } }),
    },
  });
  registry.register(gemini);

  let pool: Pool | undefined;
  let store = options.store;
  if (!store && options.environment.DATABASE_URL?.trim()) {
    pool = new Pool({ connectionString: options.environment.DATABASE_URL });
    store = new PostgresCapacitySnapshotStore(pool);
  }
  if (!store) {
    store = new InMemoryCapacitySnapshotStore();
    logger.warn('capacity.persistence.unconfigured', {
      metadata: { reason: 'DATABASE_URL is not configured; using in-memory snapshots' },
    });
  }

  const intervalMs = parseRefreshInterval(options.environment.CAPACITY_REFRESH_INTERVAL_MS);
  const coordinator = new CapacityCoordinator(registry);
  const service = new CapacityService(coordinator, store, {
    staleAfterMs: intervalMs,
    logger,
  });
  const scheduler = new CapacityRefreshScheduler(service, {
    defaultIntervalMs: intervalMs,
    runImmediately: false,
  });

  return {
    coordinator,
    service,
    scheduler,
    pool,
    async start() {
      logger.info('capacity.refresh.started', { metadata: { initial: true } });
      const outcomes = await service.refreshAll();
      const succeeded = outcomes.filter((outcome) => outcome.status === 'succeeded').length;
      logger.info('capacity.refresh.completed', {
        metadata: { initial: true, providers: outcomes.length, succeeded },
      });
      scheduler.start();
    },
    async stop() {
      scheduler.stop();
      await codex.close();
      await gemini.close();
      await pool?.end();
    },
  };
}

function parseRefreshInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('CAPACITY_REFRESH_INTERVAL_MS must be a positive integer');
  }
  return parsed;
}
