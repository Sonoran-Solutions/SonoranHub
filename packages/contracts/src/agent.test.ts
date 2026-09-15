import { describe, expect, it } from 'vitest';

import {
  AGENT_PROTOCOL_VERSION,
  agentClientMessageSchema,
  machineTelemetrySchema,
} from './agent.js';

describe('Agent protocol contracts', () => {
  it('accepts the versioned hello shape and rejects unknown fields', () => {
    const hello = {
      type: 'agent.hello',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: '0.2.0',
      machine: { id: 'main-pc', name: 'Main PC', platform: 'linux', arch: 'x64' },
      capabilities: ['machine.read.telemetry'],
      policyRevision: 'local-readonly-v1',
    };

    expect(agentClientMessageSchema.parse(hello)).toEqual(hello);
    expect(agentClientMessageSchema.safeParse({ ...hello, unexpected: true }).success).toBe(false);
  });

  it('rejects impossible resource values before they reach runtime state', () => {
    expect(
      machineTelemetrySchema.safeParse({
        capturedAt: '2026-09-14T12:00:00.000Z',
        uptimeSeconds: 10,
        memoryUsedBytes: 11,
        memoryTotalBytes: 10,
        disks: [],
      }).success,
    ).toBe(false);
  });
});
