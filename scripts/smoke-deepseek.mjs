/* global console, process */

import {
  CapacityAdapterRegistry,
  CapacityCoordinator,
  DeepSeekCapacityAdapter,
} from '../packages/ai-capacity/dist/index.js';

const adapter = new DeepSeekCapacityAdapter({ apiKey: process.env.DEEPSEEK_API_KEY });
const registry = new CapacityAdapterRegistry();
registry.register(adapter);
const coordinator = new CapacityCoordinator(registry);
const probe = await coordinator.probe(adapter.id);

if (!probe.available) {
  console.log(
    JSON.stringify({ provider: adapter.id, probe: { available: false, reason: probe.reason } }),
  );
  process.exitCode = 1;
} else {
  const result = await coordinator.collect(adapter.id);
  console.log(
    JSON.stringify({
      provider: adapter.id,
      probe: { available: true },
      collection:
        result.status === 'succeeded'
          ? {
              status: result.status,
              collectedAt: result.collectedAt,
              resources: result.resources.map((resource) => ({
                id: resource.id,
                kind: resource.kind,
                name: resource.name,
                unit: resource.unit,
                status: resource.status,
                freshness: resource.freshness,
                remaining: resource.remaining,
                changesAt: resource.changesAt,
                metadata: resource.metadata,
                error: resource.error,
              })),
            }
          : { status: result.status, error: result.error },
    }),
  );
  if (result.status === 'failed') {
    process.exitCode = 1;
  }
}
