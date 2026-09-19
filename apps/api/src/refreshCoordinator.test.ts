import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubRefreshCoordinator } from './refreshCoordinator.js';

describe('GitHubRefreshCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 10 events inside quiet debounce into 1 refresh', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      maxDebounceMs: 1500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    // Fire 10 events inside quiet debounce window (total 200ms)
    for (let i = 0; i < 10; i++) {
      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      vi.advanceTimersByTime(20);
    }

    expect(refreshCalls).toHaveLength(0);

    // Advance past the quiet debounce window (500ms after last event at 200ms -> 700ms total)
    await vi.advanceTimersByTimeAsync(500);

    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('triggers refresh when maxDebounceMs is reached under continuous events', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      maxDebounceMs: 1500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    // Send an event every 200ms (< debounceMs of 500ms) up to T=1200
    // T=0, 200, 400, 600, 800, 1000, 1200
    for (let i = 0; i <= 6; i++) {
      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      if (i < 6) {
        vi.advanceTimersByTime(200);
      }
    }

    // Currently at T=1200. Max deadline is T=1500.
    // Advance to T=1450
    vi.advanceTimersByTime(250);
    expect(refreshCalls).toHaveLength(0);

    // Advance 50ms to reach T=1500 (maxDebounceMs reached)
    await vi.advanceTimersByTimeAsync(50);

    // Refresh must have started and completed at maxDebounceMs!
    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('does NOT extend deadline beyond maxDebounceMs when event arrives shortly before deadline', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      maxDebounceMs: 1500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    // Send events every 350ms (< 500ms quiet debounce):
    // T=0, T=350, T=700, T=1050, T=1400
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub'); // T=0
    vi.advanceTimersByTime(350);
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub'); // T=350
    vi.advanceTimersByTime(350);
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub'); // T=700
    vi.advanceTimersByTime(350);
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub'); // T=1050
    vi.advanceTimersByTime(350);

    // T=1400: event arrives 100ms before max deadline (T=1500).
    // Quiet debounce would be 1400 + 500 = 1900, but deadline is capped at 1500.
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub'); // T=1400

    // Advance 50ms to T=1450: still within deadline, no refresh yet
    vi.advanceTimersByTime(50);
    expect(refreshCalls).toHaveLength(0);

    // Advance 50ms to T=1500: fires at max deadline
    await vi.advanceTimersByTimeAsync(50);

    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('starts a fresh debounce window for new events after first refresh completes', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      maxDebounceMs: 1500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    // First event at T=0, fires at T=500
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshCalls).toHaveLength(1);

    // Advance to T=1000 with no activity
    vi.advanceTimersByTime(500);

    // Fresh event at T=1000
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // Advance 400ms (T=1400) -> not fired yet
    vi.advanceTimersByTime(400);
    expect(refreshCalls).toHaveLength(1);

    // Advance 100ms (T=1500, which is 500ms after the T=1000 event)
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshCalls).toHaveLength(2);

    await coordinator.stop();
  });

  it('schedules exactly one follow-up when single event arrives during active refresh', async () => {
    const refreshCalls: string[] = [];
    let resolveActiveRefresh: (() => void) | undefined;

    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 200,
      maxDebounceMs: 600,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
        if (refreshCalls.length === 1) {
          await new Promise<void>((resolve) => {
            resolveActiveRefresh = resolve;
          });
        }
      },
    });

    // Trigger initial refresh
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshCalls).toHaveLength(1);
    expect(coordinator.isInFlight('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // Event arrives while active
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDirty('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // Resolve active refresh
    resolveActiveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);

    // Follow-up entered debounce
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshCalls).toEqual(['Sonoran-Solutions/SonoranHub', 'Sonoran-Solutions/SonoranHub']);

    await coordinator.stop();
  });

  it('schedules still exactly one follow-up when multiple events arrive during active refresh', async () => {
    const refreshCalls: string[] = [];
    let resolveActiveRefresh: (() => void) | undefined;

    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 200,
      maxDebounceMs: 600,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
        if (refreshCalls.length === 1) {
          await new Promise<void>((resolve) => {
            resolveActiveRefresh = resolve;
          });
        }
      },
    });

    // Trigger initial refresh
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshCalls).toHaveLength(1);

    // Multiple events arrive while active
    for (let i = 0; i < 10; i++) {
      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    }

    expect(coordinator.isDirty('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    // Resolve active refresh
    resolveActiveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);

    // Follow-up runs through debounce and fires once
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshCalls).toHaveLength(2);

    // Advancing more time doesn't produce additional refreshes
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshCalls).toHaveLength(2);

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

  it('shutdown clears all pending debounce and max-delay state immediately', async () => {
    const refreshCalls: string[] = [];
    const coordinator = new GitHubRefreshCoordinator({
      debounceMs: 500,
      maxDebounceMs: 1500,
      refreshHandler: async (owner, repo) => {
        refreshCalls.push(`${owner}/${repo}`);
      },
    });

    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(true);

    await coordinator.stop();

    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(false);

    // Advancing timers should not execute anything
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshCalls).toHaveLength(0);

    // Further scheduling after stop is ignored
    coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
    expect(coordinator.isDebouncing('Sonoran-Solutions', 'SonoranHub')).toBe(false);
  });

  describe('Bounded Coordinator Shutdown', () => {
    it('resolves immediately when there is no in-flight work', async () => {
      const coordinator = new GitHubRefreshCoordinator({
        refreshHandler: async () => {},
      });

      const stopPromise = coordinator.stop();
      await expect(stopPromise).resolves.toBeUndefined();
    });

    it('waits for in-flight refresh if it completes during grace period', async () => {
      let resolveRefresh: (() => void) | undefined;
      const coordinator = new GitHubRefreshCoordinator({
        shutdownGraceMs: 2000,
        refreshHandler: async () => {
          await new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          });
        },
      });

      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      await vi.advanceTimersByTimeAsync(500); // trigger execution
      expect(coordinator.isInFlight('Sonoran-Solutions', 'SonoranHub')).toBe(true);

      let stopped = false;
      const stopPromise = coordinator.stop().then(() => {
        stopped = true;
      });

      // Still waiting because in-flight is pending
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      // In-flight completes before grace period expires
      resolveRefresh?.();
      await vi.advanceTimersByTimeAsync(0);
      await stopPromise;

      expect(stopped).toBe(true);
    });

    it('stops waiting and resolves when in-flight refresh hangs past shutdownGraceMs', async () => {
      const coordinator = new GitHubRefreshCoordinator({
        shutdownGraceMs: 1000,
        // Refresh that never resolves
        refreshHandler: () => new Promise<void>(() => {}),
      });

      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      await vi.advanceTimersByTimeAsync(500); // trigger execution
      expect(coordinator.isInFlight('Sonoran-Solutions', 'SonoranHub')).toBe(true);

      let stopped = false;
      const stopPromise = coordinator.stop().then(() => {
        stopped = true;
      });

      // Advance 500ms: still within grace period, not stopped yet
      await vi.advanceTimersByTimeAsync(500);
      expect(stopped).toBe(false);

      // Advance remaining 500ms to reach shutdownGraceMs (1000ms)
      await vi.advanceTimersByTimeAsync(500);
      await stopPromise;

      // Resolved despite hung in-flight promise!
      expect(stopped).toBe(true);
    });
  });
});
