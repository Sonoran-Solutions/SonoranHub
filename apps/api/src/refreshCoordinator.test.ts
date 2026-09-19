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

  describe('Queue-ownership and concurrency regression', () => {
    it('prevents multiple simultaneous executions of queued repository and respects global concurrency', async () => {
      const releases = new Map<string, Array<() => void>>();
      let activeHandlers = 0;
      let maxActiveHandlers = 0;
      const perRepoActive = new Map<string, number>();
      const maxPerRepoActive = new Map<string, number>();

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 500,
        maxDebounceMs: 1500,
        concurrency: 3,
        refreshHandler: async (owner, repo) => {
          const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
          activeHandlers++;
          maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
          perRepoActive.set(key, (perRepoActive.get(key) ?? 0) + 1);
          maxPerRepoActive.set(
            key,
            Math.max(maxPerRepoActive.get(key) ?? 0, perRepoActive.get(key)!),
          );

          await new Promise<void>((resolve) => {
            const list = releases.get(key) ?? [];
            list.push(resolve);
            releases.set(key, list);
          });

          activeHandlers--;
          perRepoActive.set(key, perRepoActive.get(key)! - 1);
        },
      });

      const finish = async (repo: string) => {
        const key = `test-owner/${repo.toLowerCase()}`;
        const release = releases.get(key)?.shift();
        release?.();
        await vi.advanceTimersByTimeAsync(0);
      };

      // 1. Fill concurrency slots with 3 repositories: A, C, D
      coordinator.scheduleRefresh('test-owner', 'a');
      coordinator.scheduleRefresh('test-owner', 'c');
      coordinator.scheduleRefresh('test-owner', 'd');
      await vi.advanceTimersByTimeAsync(500);

      expect(activeHandlers).toBe(3);
      expect(perRepoActive.get('test-owner/a')).toBe(1);
      expect(perRepoActive.get('test-owner/c')).toBe(1);
      expect(perRepoActive.get('test-owner/d')).toBe(1);

      // 2. Schedule B. B finishes debounce at T=1000, but all slots are occupied, so B enters queue.
      coordinator.scheduleRefresh('test-owner', 'b');
      await vi.advanceTimersByTimeAsync(500);

      expect(coordinator.isInFlight('test-owner', 'b')).toBe(false);
      expect(coordinator.isDebouncing('test-owner', 'b')).toBe(false);

      // 3. Send another event for B while it is waiting in queue.
      coordinator.scheduleRefresh('test-owner', 'b');

      // 4. Free slot: A completes -> queued B starts. Free another slot: C completes.
      await finish('a');
      await finish('c');

      expect(activeHandlers).toBe(2); // B and D
      expect(perRepoActive.get('test-owner/b')).toBe(1);
      expect(coordinator.isInFlight('test-owner', 'b')).toBe(true);

      // 5. Advance through the extra debounce timer deadline (500ms).
      // On the unfixed code, a second B handler starts here!
      await vi.advanceTimersByTimeAsync(500);

      // Assert B did not start twice
      expect(perRepoActive.get('test-owner/b')).toBe(1);
      expect(maxPerRepoActive.get('test-owner/b')).toBe(1);

      // 6. Finishing first B must keep B tracked until its handler settles
      // On unfixed code, finishing first B deletes tracking for second still-running B!
      await finish('b');
      expect(perRepoActive.get('test-owner/b')).toBe(0);

      // Schedule E and F to verify global concurrency limit of 3 is never exceeded
      coordinator.scheduleRefresh('test-owner', 'e');
      coordinator.scheduleRefresh('test-owner', 'f');
      await vi.advanceTimersByTimeAsync(500);

      expect(maxPerRepoActive.get('test-owner/b')).toBe(1);
      expect(maxActiveHandlers).toBeLessThanOrEqual(3);

      // Clean up any remaining handlers
      await finish('d');
      await finish('e');
      await finish('f');
      await coordinator.stop();
    });

    it('coalesces repeated events while queued into existing request without duplicate execution or losing FIFO position', async () => {
      const orderStarted: string[] = [];
      const releases = new Map<string, Array<() => void>>();

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 500,
        maxDebounceMs: 1500,
        concurrency: 3,
        refreshHandler: async (owner, repo) => {
          orderStarted.push(repo);
          await new Promise<void>((resolve) => {
            const list = releases.get(repo) ?? [];
            list.push(resolve);
            releases.set(repo, list);
          });
        },
      });

      const finish = async (repo: string) => {
        const release = releases.get(repo)?.shift();
        release?.();
        await vi.advanceTimersByTimeAsync(0);
      };

      // Fill 3 slots: a, c, d
      coordinator.scheduleRefresh('test-owner', 'a');
      coordinator.scheduleRefresh('test-owner', 'c');
      coordinator.scheduleRefresh('test-owner', 'd');
      await vi.advanceTimersByTimeAsync(500);

      expect(orderStarted).toEqual(['a', 'c', 'd']);

      // Schedule b -> enters queue at T=1000
      coordinator.scheduleRefresh('test-owner', 'b');
      await vi.advanceTimersByTimeAsync(500);
      expect(coordinator.isQueued('test-owner', 'b')).toBe(true);

      // Schedule z -> enters queue at T=1500 behind b
      coordinator.scheduleRefresh('test-owner', 'z');
      await vi.advanceTimersByTimeAsync(500);
      expect(coordinator.isQueued('test-owner', 'z')).toBe(true);

      // Fire 10 events for queued b
      for (let i = 0; i < 10; i++) {
        coordinator.scheduleRefresh('test-owner', 'b');
      }

      // b remains queued, not debouncing, not duplicated
      expect(coordinator.isQueued('test-owner', 'b')).toBe(true);
      expect(coordinator.isDebouncing('test-owner', 'b')).toBe(false);

      // Free a slot by finishing a -> b must start first (FIFO preserved)
      await finish('a');
      expect(orderStarted).toEqual(['a', 'c', 'd', 'b']);
      expect(coordinator.isInFlight('test-owner', 'b')).toBe(true);
      expect(coordinator.isQueued('test-owner', 'z')).toBe(true);

      // Free another slot by finishing c -> z starts
      await finish('c');
      expect(orderStarted).toEqual(['a', 'c', 'd', 'b', 'z']);

      // Advance through any hypothetical timers
      await vi.advanceTimersByTimeAsync(2000);
      // b must not have started again!
      expect(orderStarted.filter((r) => r === 'b')).toHaveLength(1);

      await finish('d');
      await finish('b');
      await finish('z');
      await coordinator.stop();
    });

    it('handles multiple events after execution starts with exactly one follow-up refresh', async () => {
      const executions: string[] = [];
      let resolveFirstExecution: (() => void) | undefined;

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 200,
        refreshHandler: async (owner, repo) => {
          executions.push(`${owner}/${repo}`);
          if (executions.length === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstExecution = resolve;
            });
          }
        },
      });

      coordinator.scheduleRefresh('test-owner', 'b');
      await vi.advanceTimersByTimeAsync(200);

      expect(executions).toHaveLength(1);
      expect(coordinator.isInFlight('test-owner', 'b')).toBe(true);

      // Multiple events while actively running
      for (let i = 0; i < 5; i++) {
        coordinator.scheduleRefresh('test-owner', 'b');
      }

      expect(coordinator.isDirty('test-owner', 'b')).toBe(true);
      expect(coordinator.isDebouncing('test-owner', 'b')).toBe(false);

      // Resolve first execution
      resolveFirstExecution?.();
      await vi.advanceTimersByTimeAsync(0);

      // Follow-up enters debounce window
      expect(coordinator.isDebouncing('test-owner', 'b')).toBe(true);
      expect(coordinator.isDirty('test-owner', 'b')).toBe(false);

      // Advance debounce
      await vi.advanceTimersByTimeAsync(200);
      expect(executions).toHaveLength(2);

      // Advance further -> no 3rd execution
      await vi.advanceTimersByTimeAsync(1000);
      expect(executions).toHaveLength(2);

      await coordinator.stop();
    });

    it('normalizes repository keys across different casing', async () => {
      const started: string[] = [];
      let resolveRun: (() => void) | undefined;

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 200,
        refreshHandler: async (owner, repo) => {
          started.push(`${owner}/${repo}`);
          await new Promise<void>((resolve) => {
            resolveRun = resolve;
          });
        },
      });

      coordinator.scheduleRefresh('Sonoran-Solutions', 'SonoranHub');
      expect(coordinator.isDebouncing('sonoran-solutions', 'sonoranhub')).toBe(true);
      expect(coordinator.isDebouncing('SONORAN-SOLUTIONS', 'SONORANHUB')).toBe(true);

      // Schedule same repo with different casing
      coordinator.scheduleRefresh('sonoran-solutions', 'sonoranhub');
      coordinator.scheduleRefresh('SONORAN-SOLUTIONS', 'SONORANHUB');

      await vi.advanceTimersByTimeAsync(200);

      // Started exactly once
      expect(started).toHaveLength(1);
      expect(coordinator.isInFlight('sonoran-solutions', 'sonoranhub')).toBe(true);
      expect(coordinator.isInFlight('SONORAN-SOLUTIONS', 'SONORANHUB')).toBe(true);

      resolveRun?.();
      await vi.advanceTimersByTimeAsync(0);
      await coordinator.stop();
    });

    it('handles synchronous throw in refreshHandler safely without leaving ghost entry or blocking queue', async () => {
      const executed: string[] = [];
      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 100,
        concurrency: 1,
        refreshHandler: async (owner, repo) => {
          executed.push(repo);
          if (repo === 'failing') {
            throw new Error('Synchronous handler crash');
          }
        },
      });

      coordinator.scheduleRefresh('test-owner', 'failing');
      coordinator.scheduleRefresh('test-owner', 'subsequent');

      // T=100: both finish debounce, failing starts and crashes synchronously
      await vi.advanceTimersByTimeAsync(100);

      expect(executed).toContain('failing');
      expect(coordinator.isInFlight('test-owner', 'failing')).toBe(false);

      // Slot is available and subsequent runs
      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toContain('subsequent');
      expect(coordinator.isInFlight('test-owner', 'subsequent')).toBe(false);

      await coordinator.stop();
    });

    it('handles asynchronous rejection in refreshHandler safely without leaving ghost entry or blocking queue', async () => {
      const executed: string[] = [];
      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 100,
        concurrency: 1,
        refreshHandler: async (owner, repo) => {
          executed.push(repo);
          if (repo === 'failing') {
            await Promise.reject(new Error('Async handler rejection'));
          }
        },
      });

      coordinator.scheduleRefresh('test-owner', 'failing');
      coordinator.scheduleRefresh('test-owner', 'subsequent');

      await vi.advanceTimersByTimeAsync(100);

      expect(executed).toContain('failing');
      expect(coordinator.isInFlight('test-owner', 'failing')).toBe(false);

      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toContain('subsequent');

      await coordinator.stop();
    });

    it('waitForIdle does not resolve early while handler or legitimate follow-up is active', async () => {
      let resolveFirst: (() => void) | undefined;
      let resolveSecond: (() => void) | undefined;
      let count = 0;

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 100,
        refreshHandler: async () => {
          count++;
          if (count === 1) {
            await new Promise<void>((resolve) => {
              resolveFirst = resolve;
            });
          } else {
            await new Promise<void>((resolve) => {
              resolveSecond = resolve;
            });
          }
        },
      });

      coordinator.scheduleRefresh('test-owner', 'repo');
      await vi.advanceTimersByTimeAsync(100); // starts first execution

      let isIdle = false;
      const idlePromise = coordinator.waitForIdle().then(() => {
        isIdle = true;
      });

      // While running, idle must not resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(isIdle).toBe(false);

      // Event arrives -> dirty
      coordinator.scheduleRefresh('test-owner', 'repo');

      // Resolve first execution -> follow-up enters debounce
      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(isIdle).toBe(false);

      // Advance debounce -> follow-up runs
      await vi.advanceTimersByTimeAsync(100);
      expect(isIdle).toBe(false);

      // Resolve follow-up -> now idle resolves
      resolveSecond?.();
      await vi.advanceTimersByTimeAsync(0);
      await idlePromise;
      expect(isIdle).toBe(true);

      await coordinator.stop();
    });

    it('stops cleanly during queued and active work without starting queued work or scheduling follow-ups', async () => {
      let resolveActive: (() => void) | undefined;
      const executed: string[] = [];

      const coordinator = new GitHubRefreshCoordinator({
        debounceMs: 200,
        concurrency: 1,
        shutdownGraceMs: 50,
        refreshHandler: async (owner, repo) => {
          executed.push(repo);
          if (repo === 'active') {
            await new Promise<void>((resolve) => {
              resolveActive = resolve;
            });
          }
        },
      });

      // Start active repo
      coordinator.scheduleRefresh('test-owner', 'active');
      await vi.advanceTimersByTimeAsync(200);
      expect(executed).toEqual(['active']);

      // Queue second repo
      coordinator.scheduleRefresh('test-owner', 'queued');
      await vi.advanceTimersByTimeAsync(200);
      expect(coordinator.isQueued('test-owner', 'queued')).toBe(true);

      // Event for active repo to mark dirty
      coordinator.scheduleRefresh('test-owner', 'active');
      expect(coordinator.isDirty('test-owner', 'active')).toBe(true);

      // Call stop while active is hung
      const stopPromise = coordinator.stop();

      // Grace period expires
      await vi.advanceTimersByTimeAsync(50);
      await stopPromise;

      // Queued and dirty state cleared
      expect(coordinator.isQueued('test-owner', 'queued')).toBe(false);
      expect(coordinator.isDirty('test-owner', 'active')).toBe(false);

      // Advance time -> queued repo never starts, follow-up never starts
      await vi.advanceTimersByTimeAsync(5000);
      expect(executed).toEqual(['active']);

      // Late resolution of active does not trigger queued work or follow-ups
      resolveActive?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(['active']);
    });
  });
});
