import { describe, expect, it } from 'vitest';

import {
  AGENT_PROTOCOL_VERSION,
  agentActionRequestSchema,
  agentClientMessageSchema,
  machineTelemetrySchema,
  machineSummarySchema,
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
      actionCatalog: { repositories: [], services: [] },
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

  it('requires the persisted protocol version in public machine summaries', () => {
    const summary = {
      identity: { id: 'main-pc', name: 'Main PC', platform: 'linux', arch: 'x64' },
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: '0.2.0',
      capabilities: ['machine.read.telemetry'],
      policyRevision: 'local-readonly-v1',
      actionCatalog: { repositories: [], services: [] },
      status: 'OFFLINE',
      lastSeenAt: '2026-09-14T12:00:00.000Z',
      telemetry: null,
    };
    expect(machineSummarySchema.parse(summary)).toEqual(summary);
    expect(machineSummarySchema.safeParse({ ...summary, protocolVersion: undefined }).success).toBe(
      false,
    );
  });

  it('does not permit paths, units, commands, or argument arrays in action requests', () => {
    const request = {
      type: 'agent.action.request',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      actionId: '6c0b8f9c-7d26-4b8e-b7f6-4a91af1c2e40',
      policyRevision: `sha256:${'a'.repeat(64)}`,
      deadlineAt: '2026-09-14T12:00:10.000Z',
      action: { kind: 'repo.status', targetId: 'repo' },
    };
    expect(agentActionRequestSchema.parse(request)).toEqual(request);
    expect(agentActionRequestSchema.safeParse({ ...request, path: '/tmp/repo' }).success).toBe(
      false,
    );
    expect(
      agentActionRequestSchema.safeParse({
        ...request,
        action: { ...request.action, unit: 'unsafe.service' },
      }).success,
    ).toBe(false);
  });
});
