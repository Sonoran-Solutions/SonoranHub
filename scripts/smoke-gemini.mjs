/* global console, process */

import {
  AntigravityCliSource,
  GeminiCapacityAdapter,
} from '../packages/ai-capacity/dist/index.js';

const executable = process.env.AGY_BIN?.trim() || 'agy';
const source = new AntigravityCliSource({ executable });
const adapter = new GeminiCapacityAdapter({ source });

function safeResource(resource) {
  return {
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    remaining: resource.remaining,
    remainingPercent: resource.remainingPercent,
    resetAt: resource.resetAt,
    status: resource.status,
    freshness: resource.freshness,
    metadata: resource.metadata,
  };
}

function assertPrivateDataAbsent(value) {
  const text = JSON.stringify(value);
  if (
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text) ||
    /(access.?token|refresh.?token|oauth|credential|account.?id|billing.?project|organization.?id)/i.test(
      text,
    )
  ) {
    throw new Error('Smoke output contained data outside the safe capacity allowlist');
  }
}

try {
  const versionProbe = await source.probe();
  const collection = await adapter.collect();
  const output = {
    executable: 'agy',
    antigravityVersion: versionProbe.antigravityVersion ?? 'not detected',
    provider: 'gemini',
    availability: versionProbe.available ? 'available' : 'unavailable',
    reason: versionProbe.reason,
    planTier: versionProbe.planTier,
    resources: collection.resources.map(safeResource),
    collectionError: collection.error,
    readOnlyCommandsValidated: source.lastReadOnlyCommands,
    zeroTurnReadOnly: source.lastReadOnlyCommands.includes('/quota'),
  };
  assertPrivateDataAbsent(output);
  console.log(JSON.stringify(output, null, 2));
  await source.close();
  process.exitCode = versionProbe.available && collection.resources.length > 0 ? 0 : 1;
} catch (error) {
  await source.close();
  console.error(
    JSON.stringify({
      provider: 'gemini',
      availability: 'unavailable',
      reason: error instanceof Error ? error.message : 'Gemini smoke test failed',
    }),
  );
  process.exitCode = 1;
}
