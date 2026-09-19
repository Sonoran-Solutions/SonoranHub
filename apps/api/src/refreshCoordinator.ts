import type { StructuredLogger } from '@sonoran-hub/config';

export interface GitHubRefreshCoordinatorOptions {
  readonly refreshHandler: (owner: string, repo: string) => Promise<void>;
  readonly debounceMs?: number;
  readonly concurrency?: number;
  readonly logger?: StructuredLogger;
}

export const DEFAULT_WEBHOOK_DEBOUNCE_MS = 1_000;
export const DEFAULT_MAX_CONCURRENT_REFRESHES = 3;

export class GitHubRefreshCoordinator {
  private readonly refreshHandler: (owner: string, repo: string) => Promise<void>;
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly logger?: StructuredLogger;

  // Active debounce timers: key -> NodeJS.Timeout
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Currently executing refreshes: key -> Promise<void>
  private readonly inFlight = new Map<string, Promise<void>>();

  // Repositories flagged as needing follow-up because an event arrived while in-flight
  private readonly dirty = new Set<string>();

  // Queue of repo keys waiting for a concurrency slot
  private readonly waitQueue: Array<{ owner: string; repo: string; key: string }> = [];

  private stopped = false;

  constructor(options: GitHubRefreshCoordinatorOptions) {
    this.refreshHandler = options.refreshHandler;
    this.debounceMs = options.debounceMs ?? DEFAULT_WEBHOOK_DEBOUNCE_MS;
    this.concurrency = options.concurrency ?? DEFAULT_MAX_CONCURRENT_REFRESHES;
    this.logger = options.logger;
  }

  scheduleRefresh(owner: string, repo: string): void {
    if (this.stopped) {
      return;
    }

    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;

    // If already in-flight, mark dirty for follow-up
    if (this.inFlight.has(key)) {
      this.dirty.add(key);
      this.logger?.debug('github.webhook.refresh_coalesced', {
        metadata: { repository: `${owner}/${repo}`, reason: 'in_flight' },
      });
      return;
    }

    // If already waiting in debounce timer, coalesce (maintain/reset debounce)
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.logger?.debug('github.webhook.refresh_coalesced', {
        metadata: { repository: `${owner}/${repo}`, reason: 'debouncing' },
      });
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      if (this.stopped) {
        return;
      }
      this.dispatch(owner, repo, key);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
    this.logger?.debug('github.webhook.refresh_queued', {
      metadata: { repository: `${owner}/${repo}`, debounceMs: this.debounceMs },
    });
  }

  private dispatch(owner: string, repo: string, key: string): void {
    if (this.inFlight.size >= this.concurrency) {
      // Concurrency limit reached, queue it if not already queued
      if (!this.waitQueue.some((item) => item.key === key)) {
        this.waitQueue.push({ owner, repo, key });
      }
      return;
    }

    void this.executeRefresh(owner, repo, key);
  }

  private async executeRefresh(owner: string, repo: string, key: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    const promise = (async () => {
      const repoFullName = `${owner}/${repo}`;
      try {
        this.logger?.info('github.webhook.refresh_started', {
          metadata: { repository: repoFullName },
        });
        const startTime = Date.now();
        await this.refreshHandler(owner, repo);
        const durationMs = Date.now() - startTime;
        this.logger?.info('github.webhook.refresh_completed', {
          metadata: { repository: repoFullName, durationMs },
        });
      } catch (error) {
        this.logger?.error('github.webhook.refresh_failed', {
          metadata: {
            repository: repoFullName,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      } finally {
        this.inFlight.delete(key);

        // If dirty, schedule at most one follow-up refresh
        if (!this.stopped && this.dirty.has(key)) {
          this.dirty.delete(key);
          this.scheduleRefresh(owner, repo);
        }

        this.processQueue();
      }
    })();

    this.inFlight.set(key, promise);
  }

  private processQueue(): void {
    if (this.stopped || this.waitQueue.length === 0) {
      return;
    }

    while (this.inFlight.size < this.concurrency && this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next && !this.inFlight.has(next.key)) {
        void this.executeRefresh(next.owner, next.repo, next.key);
      }
    }
  }

  isDebouncing(owner: string, repo: string): boolean {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return this.debounceTimers.has(key);
  }

  isInFlight(owner: string, repo: string): boolean {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return this.inFlight.has(key);
  }

  isDirty(owner: string, repo: string): boolean {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return this.dirty.has(key);
  }

  async waitForIdle(): Promise<void> {
    while (this.debounceTimers.size > 0 || this.inFlight.size > 0 || this.waitQueue.length > 0) {
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight.values()));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.dirty.clear();
    this.waitQueue.length = 0;

    if (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight.values()));
    }
  }
}
