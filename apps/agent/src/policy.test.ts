import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentPolicySchema,
  createPolicyRevision,
  loadAgentPolicy,
  policyCatalog,
  policyCapabilities,
  type AgentPolicy,
} from './policy.js';

const validPolicy: AgentPolicy = {
  repositories: [{ id: 'sonoran-hub', label: 'Sonoran Hub', path: '/tmp/SonoranHub' }],
  services: [
    { id: 'hub-api', label: 'Hub API', manager: 'systemd-user', unit: 'sonoran-hub-api.service' },
  ],
};
const repository = validPolicy.repositories[0]!;
const service = validPolicy.services[0]!;

describe('Agent local action policy', () => {
  it('accepts a valid policy and exposes only safe catalog fields', () => {
    const parsed = agentPolicySchema.parse(validPolicy);
    expect(policyCapabilities(parsed)).toEqual([
      'machine.read.telemetry',
      'repo.read',
      'service.restart.allowed',
    ]);
    expect(policyCatalog(parsed)).toEqual({
      repositories: [{ id: 'sonoran-hub', label: 'Sonoran Hub' }],
      services: [{ id: 'hub-api', label: 'Hub API' }],
    });
    expect(JSON.stringify(policyCatalog(parsed))).not.toContain('/tmp');
    expect(JSON.stringify(policyCatalog(parsed))).not.toContain('systemd-hub');
  });

  it('rejects duplicate IDs, relative paths, and unsafe units', () => {
    expect(
      agentPolicySchema.safeParse({
        ...validPolicy,
        repositories: [...validPolicy.repositories, repository],
      }).success,
    ).toBe(false);
    expect(
      agentPolicySchema.safeParse({
        ...validPolicy,
        repositories: [{ ...repository, path: '../repo' }],
      }).success,
    ).toBe(false);
    expect(
      agentPolicySchema.safeParse({
        ...validPolicy,
        services: [{ ...service, unit: 'bad unit.service' }],
      }).success,
    ).toBe(false);
  });

  it('allows a missing default policy but fails explicit missing and malformed files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sonoran-policy-test-'));
    await expect(
      loadAgentPolicy({ path: join(directory, 'missing.json'), explicit: false }),
    ).resolves.toEqual({
      repositories: [],
      services: [],
    });
    await expect(
      loadAgentPolicy({ path: join(directory, 'missing.json'), explicit: true }),
    ).rejects.toThrow('could not be read');
    const malformed = join(directory, 'malformed.json');
    await writeFile(malformed, '{not-json\n', { mode: 0o600 });
    await expect(loadAgentPolicy({ path: malformed, explicit: true })).rejects.toThrow(
      'invalid JSON',
    );
  });

  it('rejects group or other writable policy files on Unix', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'sonoran-policy-test-'));
    const path = join(directory, 'policy.json');
    await writeFile(path, JSON.stringify(validPolicy), { mode: 0o666 });
    await chmod(path, 0o666);
    await expect(loadAgentPolicy({ path, explicit: true })).rejects.toThrow(
      'writable by group or others',
    );
  });

  it('changes the revision when any authorization-relevant mapping changes', () => {
    expect(createPolicyRevision(validPolicy)).not.toBe(
      createPolicyRevision({
        ...validPolicy,
        repositories: [{ ...repository, path: '/tmp/OtherRepo' }],
      }),
    );
    expect(createPolicyRevision(validPolicy)).not.toBe(
      createPolicyRevision({
        ...validPolicy,
        services: [{ ...service, unit: 'other.service' }],
      }),
    );
    expect(createPolicyRevision(validPolicy)).not.toBe(
      createPolicyRevision({ ...validPolicy, capabilities: ['repo.read'] }),
    );
  });
});
