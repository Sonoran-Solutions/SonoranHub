import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import type { MachineTelemetry } from '@sonoran-hub/contracts';

import { PostgresMachineStore, type PersistedMachine } from './machines.js';

const { Pool } = pg;
const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const pool = hasDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

const machine: PersistedMachine = {
  identity: {
    id: 'postgres-machine-test',
    name: 'Postgres Test Machine',
    platform: 'linux',
    arch: 'x64',
  },
  protocolVersion: 1,
  agentVersion: '0.2.0',
  capabilities: ['machine.read.telemetry'],
  policyRevision: 'sha256:test',
  lastSeenAt: '2026-09-15T12:00:00.000Z',
  telemetry: {
    capturedAt: '2026-09-15T12:00:00.000Z',
    uptimeSeconds: 12,
    cpuPercent: 11,
    memoryUsedBytes: 10,
    memoryTotalBytes: 20,
    disks: [],
  },
};

describe.skipIf(!hasDatabase)('PostgresMachineStore', () => {
  let store: PostgresMachineStore;

  beforeAll(async () => {
    await pool?.query('TRUNCATE TABLE machines');
    store = new PostgresMachineStore(pool!);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('round trips machine metadata and latest telemetry', async () => {
    await store.upsert(machine);
    const records = await store.list();
    expect(records).toEqual([machine]);

    const updatedTelemetry: MachineTelemetry = {
      ...machine.telemetry!,
      cpuPercent: 42,
    };
    await store.upsert({
      ...machine,
      lastSeenAt: '2026-09-15T12:00:01.000Z',
      telemetry: updatedTelemetry,
    });
    await expect(store.list()).resolves.toEqual([
      { ...machine, lastSeenAt: '2026-09-15T12:00:01.000Z', telemetry: updatedTelemetry },
    ]);
  });
});
