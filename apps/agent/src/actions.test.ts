import { randomUUID } from 'node:crypto';

import { agentActionRequestSchema, type AgentActionRequest } from '@sonoran-hub/contracts';
import { describe, expect, it } from 'vitest';

import { AgentActionExecutor, type ProcessResult, type ProcessRunner } from './actions.js';
import { createPolicyRevision, type AgentPolicy, policyCapabilities } from './policy.js';

const policy: AgentPolicy = {
  repositories: [{ id: 'repo', label: 'Repo', path: '/tmp/repo' }],
  services: [{ id: 'api', label: 'API', manager: 'systemd-user', unit: 'sonoran-api.service' }],
};

function request(
  action: AgentActionRequest['action'],
  overrides: Partial<AgentActionRequest> = {},
): AgentActionRequest {
  return agentActionRequestSchema.parse({
    type: 'agent.action.request',
    protocolVersion: 2,
    actionId: randomUUID(),
    policyRevision: createPolicyRevision(policy),
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    action,
    ...overrides,
  });
}

function runner(
  results: ProcessResult[],
): ProcessRunner & { calls: Array<{ executable: string; args: readonly string[] }> } {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  return {
    calls,
    async run(executable, args) {
      calls.push({ executable, args });
      return (
        results.shift() ?? { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
      );
    },
  };
}

describe('typed Agent actions', () => {
  it('returns structured repo status and never exposes the local path', async () => {
    const processes = runner([
      {
        exitCode: 0,
        signal: null,
        stdout:
          '# branch.oid 0123456789012345678901234567890123456789\n# branch.head main\n# branch.ab +1 -2\n1 M. N... 100644 100644 100644 aaa bbb file.txt\n? new.txt\n',
        stderr: '',
        timedOut: false,
      },
    ]);
    const executor = new AgentActionExecutor({ policy, processRunner: processes });
    const execution = executor.execute(request({ kind: 'repo.status', targetId: 'repo' }));
    expect(execution.accepted).toBe(true);
    if (!execution.accepted) return;
    await expect(execution.result).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        kind: 'repo.status',
        branch: 'main',
        dirty: true,
        ahead: 1,
        behind: 2,
        staged: 1,
        untracked: 1,
      },
    });
    expect(processes.calls).toEqual([
      { executable: 'git', args: ['-C', '/tmp/repo', 'status', '--porcelain=v2', '--branch'] },
    ]);
  });

  it('denies unknown, stale, expired, missing-capability, and duplicate requests without spawning', () => {
    const processes = runner([]);
    const executor = new AgentActionExecutor({ policy, processRunner: processes });
    expect(executor.execute(request({ kind: 'repo.status', targetId: 'unknown' }))).toMatchObject({
      accepted: false,
      result: { status: 'denied', error: { code: 'target_not_allowed' } },
    });
    const stale = request(
      { kind: 'repo.status', targetId: 'repo' },
      { policyRevision: 'sha256:' + 'a'.repeat(64) },
    );
    expect(executor.execute(stale)).toMatchObject({
      accepted: false,
      result: { error: { code: 'policy_changed' } },
    });
    const expired = request(
      { kind: 'repo.status', targetId: 'repo' },
      { deadlineAt: new Date(0).toISOString() },
    );
    expect(executor.execute(expired)).toMatchObject({
      accepted: false,
      result: { error: { code: 'expired' } },
    });
    const first = request({ kind: 'repo.status', targetId: 'repo' });
    const duplicate = { ...first };
    expect(executor.execute(first).accepted).toBe(true);
    expect(executor.execute(duplicate)).toMatchObject({
      accepted: false,
      result: { error: { code: 'duplicate_action' } },
    });
    expect(processes.calls).toHaveLength(1);
    expect(policyCapabilities({ repositories: [], services: [] })).toEqual([
      'machine.read.telemetry',
    ]);
  });

  it('uses fixed user-systemd spawn forms and verifies active state', async () => {
    const processes = runner([
      { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false },
      { exitCode: 0, signal: null, stdout: 'active\n', stderr: '', timedOut: false },
    ]);
    const executor = new AgentActionExecutor({ policy, processRunner: processes });
    const execution = executor.execute(request({ kind: 'service.restart', targetId: 'api' }));
    expect(execution.accepted).toBe(true);
    if (!execution.accepted) return;
    await expect(execution.result).resolves.toMatchObject({
      status: 'succeeded',
      result: { kind: 'service.restart', targetId: 'api', active: true },
    });
    expect(processes.calls).toEqual([
      { executable: 'systemctl', args: ['--user', 'restart', 'sonoran-api.service'] },
      { executable: 'systemctl', args: ['--user', 'is-active', 'sonoran-api.service'] },
    ]);
  });

  it('denies a second action while the first process is still active', async () => {
    let resolveProcess: ((result: ProcessResult) => void) | undefined;
    const processes: ProcessRunner & { calls: number } = {
      calls: 0,
      run: async () => {
        processes.calls += 1;
        return new Promise<ProcessResult>((resolve) => {
          resolveProcess = resolve;
        });
      },
    };
    const executor = new AgentActionExecutor({ policy, processRunner: processes });
    const first = executor.execute(request({ kind: 'repo.status', targetId: 'repo' }));
    expect(first.accepted).toBe(true);
    expect(executor.execute(request({ kind: 'repo.status', targetId: 'repo' }))).toMatchObject({
      accepted: false,
      result: { status: 'denied', error: { code: 'busy' } },
    });
    expect(processes.calls).toBe(1);
    resolveProcess?.({
      exitCode: 0,
      signal: null,
      stdout: '# branch.head main\n',
      stderr: '',
      timedOut: false,
    });
    if (first.accepted) await expect(first.result).resolves.toMatchObject({ status: 'succeeded' });
  });
});
