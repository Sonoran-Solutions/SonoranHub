/* global console, process */

import {
  CapacityCoordinator,
  CapacityAdapterRegistry,
  OpenRouterCapacityAdapter,
} from '../packages/ai-capacity/dist/index.js';

const adapter = new OpenRouterCapacityAdapter({
  apiKey: process.env.OPENROUTER_API_KEY,
  managementKey: process.env.OPENROUTER_MANAGEMENT_KEY,
});
const registry = new CapacityAdapterRegistry();
registry.register(adapter);
const coordinator = new CapacityCoordinator(registry);
const probe = await coordinator.probe(adapter.id);

function sanitizedMetadata(metadata) {
  if (!metadata) {
    return undefined;
  }
  const allowedKeys = [
    'limit_reset',
    'is_free_tier',
    'include_byok_in_limit',
    'usage_daily',
    'usage_weekly',
    'usage_monthly',
    'byok_usage_daily',
    'byok_usage_weekly',
    'byok_usage_monthly',
    'limit_configured',
    'budget_state',
    'total_credits',
    'total_usage',
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(metadata, key))
      .map((key) => [key, metadata[key]]),
  );
}

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
                limit: resource.limit,
                used: resource.used,
                remaining: resource.remaining,
                remainingPercent: resource.remainingPercent,
                metadata: sanitizedMetadata(resource.metadata),
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
