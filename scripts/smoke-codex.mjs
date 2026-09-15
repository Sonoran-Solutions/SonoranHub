/* global console, process */

import { execFileSync } from 'node:child_process';

import {
  CapacityCoordinator,
  CapacityAdapterRegistry,
  CodexCapacityAdapter,
} from '../packages/ai-capacity/dist/index.js';

const executable = process.env.CODEX_BIN?.trim() || 'codex';
const adapter = new CodexCapacityAdapter({ sourceOptions: { executable } });
const registry = new CapacityAdapterRegistry();
registry.register(adapter);
const coordinator = new CapacityCoordinator(registry);

function localCodexVersion() {
  try {
    const output = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return output.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/)?.[0];
  } catch {
    return undefined;
  }
}

function sanitizedMetadata(metadata) {
  if (!metadata) {
    return undefined;
  }
  const allowedKeys = [
    'limit_id',
    'limit_name',
    'normal_model_slug',
    'plan_type',
    'codex_version',
    'window_role',
    'window_duration_mins',
    'ordinary_usage_allowed',
    'rate_limit_reached_type',
    'spend_control_reached',
    'spend_control',
    'provider_limit',
    'provider_used',
    'credits_has_credits',
    'credits_unlimited',
    'credits_state',
    'available_count',
    'detail_rows_available',
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(metadata, key))
      .map((key) => [key, metadata[key]]),
  );
}

let exitCode = 0;
try {
  const probe = await coordinator.probe(adapter.id);
  const version = localCodexVersion();
  if (!probe.available) {
    console.log(
      JSON.stringify({
        provider: adapter.id,
        codexVersion: version,
        probe: { available: false, reason: probe.reason },
      }),
    );
    exitCode = 1;
  } else {
    const result = await coordinator.collect(adapter.id);
    console.log(
      JSON.stringify({
        provider: adapter.id,
        codexVersion: version,
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
                  resetAt: resource.resetAt,
                  metadata: sanitizedMetadata(resource.metadata),
                  error: resource.error,
                })),
              }
            : { status: result.status, error: result.error },
      }),
    );
    if (result.status === 'failed') {
      exitCode = 1;
    }
  }
} catch {
  console.log(
    JSON.stringify({
      provider: adapter.id,
      codexVersion: localCodexVersion(),
      probe: { available: false, reason: 'Codex smoke test failed' },
    }),
  );
  exitCode = 1;
} finally {
  await adapter.close();
}
process.exitCode = exitCode;
