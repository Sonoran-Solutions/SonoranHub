import { describe, expect, it } from 'vitest';

import { InMemoryMachineActionStore } from './actions.js';

const pending = {
  actionId: 'f8b8f11c-87e4-4d31-8d43-7e2990eea123',
  machineId: 'machine-actions',
  kind: 'repo.status' as const,
  targetId: 'repo',
  status: 'PENDING' as const,
  policyRevision: `sha256:${'a'.repeat(64)}`,
  requestedAt: '2026-09-15T12:00:00.000Z',
};

describe('Machine action store lifecycle', () => {
  it('rejects invalid transitions and keeps terminal records immutable', async () => {
    const store = new InMemoryMachineActionStore();
    await store.create(pending);

    await expect(
      store.update({
        ...pending,
        status: 'SUCCEEDED',
        completedAt: '2026-09-15T12:00:01.000Z',
        result: {
          kind: 'repo.status',
          targetId: 'repo',
          detached: false,
          dirty: false,
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
        },
      }),
    ).rejects.toThrow('invalid action transition');

    await store.update({ ...pending, status: 'RUNNING', startedAt: pending.requestedAt });
    await store.update({
      ...pending,
      status: 'SUCCEEDED',
      startedAt: pending.requestedAt,
      completedAt: '2026-09-15T12:00:01.000Z',
      result: {
        kind: 'repo.status',
        targetId: 'repo',
        detached: false,
        dirty: false,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
    });
    await expect(
      store.update({
        ...pending,
        status: 'FAILED',
        startedAt: pending.requestedAt,
        completedAt: '2026-09-15T12:00:02.000Z',
        error: { code: 'git_failed', message: 'late update' },
      }),
    ).rejects.toThrow('terminal action is immutable');
  });

  it('does not allow action identity fields to change during a transition', async () => {
    const store = new InMemoryMachineActionStore();
    await store.create(pending);
    await expect(
      store.update({
        ...pending,
        machineId: 'other-machine',
        status: 'RUNNING',
        startedAt: pending.requestedAt,
      }),
    ).rejects.toThrow('action identity is immutable');
  });
});
