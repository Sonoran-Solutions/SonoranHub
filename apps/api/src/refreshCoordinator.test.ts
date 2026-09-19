import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubRefreshCoordinator } from './refreshCoordinator.js';

describe('GitHubRefreshCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 10 events for same repository in debounce window into 1 refresh', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    // Fire 10 events rapidly
    for (let i = 0; i < 10; i++) {
      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      vi.advanceTimersByTime(20);
    }

    expect(refreshCalls).toHaveLength(0);

    // Advance past the remaining debounce window
    await vi.advanceTimersByTimeAsync(500);

    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('schedules at most one follow-up refresh when events arrive during active refresh', async () => {
    const refreshCalls: string[] = [];
    let resolveActiveRefresh: (() => void) | undefined;

    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 200,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
        if (refreshCalls.length === 1) {
          // Pause the first execution
          await new Promise<void>((resolve) => {
            resolveActiveRefresh = resolve;
          });
        }
      },
    });

    // 1. Initial event triggers first execution after debounce
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshCalls).toHaveLength(1);
    expect(coordinator.isInFlight('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // 2. Fire 5 events while the first refresh is still active
    for (let i = 0; i < 5; i++) {
      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    }

    expect(coordinator.isDirty('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // 3. Resolve first refresh
    resolveActiveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);

    // Follow-up should now be scheduled with debounce
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // 4. Advance past follow-up debounce window
    await vi.advanceTimersByTimeAsync(200);

    // Exactly 2 total refreshes: the initial + exactly 1 follow-up
    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub', 'Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('independently schedules refreshes for different repositories', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 300,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    coordinator.scheduleRefresh('Sonoran-Solutions', 'RepoA');
    coordinator.scheduleRefresh('Sonoran-Solutions', 'RepoB');

    await vi.advanceTimersByTimeAsync(300);

    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls).toContain('Sonoran-Solutions/RepoA');
    expect(refreshCalls).toContain('Sonoran-Solutions/RepoB');

    await coordinator.stop();
  });

  it('cancels pending timers cleanly on stop and does not run refreshes after stop', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    await coordinator.stop();

    // Advancing timers should not execute anything
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshCalls).toHaveLength(0);

    // Further scheduling after stop is ignored
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(false);
  });
});
