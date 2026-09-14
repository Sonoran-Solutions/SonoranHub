import { CapacityCoordinator } from './coordinator.js';

export interface RefreshSchedulerOptions {
  readonly defaultIntervalMs?: number;
  readonly intervalsMs?: Readonly<Record<string, number>>;
}

export class CapacityRefreshScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly activeRefreshes = new Set<string>();
  private readonly defaultIntervalMs: number;
  private readonly intervalsMs: Readonly<Record<string, number>>;
  private running = false;

  constructor(
    private readonly coordinator: CapacityCoordinator,
    options: RefreshSchedulerOptions = {},
  ) {
    this.defaultIntervalMs = options.defaultIntervalMs ?? 60_000;
    this.intervalsMs = options.intervalsMs ?? {};
    if (!Number.isFinite(this.defaultIntervalMs) || this.defaultIntervalMs <= 0) {
      throw new Error('defaultIntervalMs must be a finite positive number');
    }
    for (const [providerId, intervalMs] of Object.entries(this.intervalsMs)) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error(`Refresh interval must be positive: ${providerId}`);
      }
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    for (const providerId of this.coordinator.listProviderIds()) {
      const intervalMs = this.intervalsMs[providerId] ?? this.defaultIntervalMs;
      this.timers.set(
        providerId,
        setInterval(() => {
          this.trigger(providerId);
        }, intervalMs),
      );
      this.trigger(providerId);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
  }

  private trigger(providerId: string): void {
    if (this.activeRefreshes.has(providerId)) {
      return;
    }

    this.activeRefreshes.add(providerId);
    const refresh = this.coordinator.refresh(providerId);
    void refresh.then(
      () => this.activeRefreshes.delete(providerId),
      () => this.activeRefreshes.delete(providerId),
    );
  }
}
