import { buildApp } from './app.js';
import { createCapacityRuntime } from './capacity.js';
import { createStructuredLogger, loadConfig } from '@sonoran-hub/config';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const config = loadConfig(process.env, { defaultServiceName: 'sonoran-hub-api' });
const logger = createStructuredLogger({ serviceName: config.serviceName, level: config.logLevel });
const capacity = createCapacityRuntime({ environment: process.env, config, logger });
const app = buildApp(config, { capacityService: capacity.service });

app.addHook('onClose', async () => {
  await capacity.stop();
});

try {
  await app.listen({ host, port });
  await capacity.start();
} catch {
  logger.error('api.start_failed', { metadata: { error: 'API startup failed' } });
  await capacity.stop();
  process.exitCode = 1;
}
