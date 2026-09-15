import type {
  CapacityCurrentResponse,
  CapacityFreshness,
  CapacityResource,
  CapacityStatus,
} from '@sonoran-hub/contracts';

export const DEFAULT_UI_POLL_INTERVAL_MS = 15_000;

export interface CapacityState {
  readonly status: 'loading' | 'success' | 'error';
  readonly data?: CapacityCurrentResponse;
  readonly message?: string;
  readonly refreshing: boolean;
  readonly refreshError?: string;
}

export function initialCapacityState(): CapacityState {
  return { status: 'loading', refreshing: false };
}

export interface CapacityPollerOptions {
  readonly fetchCapacity: (signal: AbortSignal) => Promise<CapacityCurrentResponse>;
  readonly onState: (state: CapacityState) => void;
  readonly intervalMs?: number;
}

export interface CapacityPoller {
  start(): void;
  stop(): void;
}

export function createCapacityPoller(options: CapacityPollerOptions): CapacityPoller {
  const intervalMs = options.intervalMs ?? DEFAULT_UI_POLL_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error('Capacity UI poll interval must be at least 1000ms');
  }

  let current = initialCapacityState();
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  const publish = (state: CapacityState): void => {
    current = state;
    options.onState(state);
  };

  const refresh = (initial: boolean): void => {
    if (stopped || inFlight) {
      return;
    }

    if (initial) {
      publish({ status: 'loading', refreshing: false });
    } else {
      publish({ ...current, refreshing: true, refreshError: undefined });
    }

    controller = new AbortController();
    let request: Promise<CapacityCurrentResponse>;
    try {
      request = options.fetchCapacity(controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }

    const operation = request
      .then((data) => {
        if (!stopped) {
          publish({ status: 'success', data, refreshing: false });
        }
      })
      .catch((error: unknown) => {
        if (stopped || isAbortError(error)) {
          return;
        }
        const message = errorMessage(error);
        if (current.data) {
          publish({
            status: 'success',
            data: current.data,
            refreshing: false,
            refreshError: message,
          });
        } else {
          publish({ status: 'error', refreshing: false, message });
        }
      })
      .finally(() => {
        if (inFlight === operation) {
          inFlight = undefined;
        }
        controller = undefined;
      });

    inFlight = operation;
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      stopped = false;
      intervalId = setInterval(() => refresh(false), intervalMs);
      refresh(true);
    },
    stop() {
      if (!started || stopped) {
        return;
      }
      stopped = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      controller?.abort();
      controller = undefined;
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The capacity request failed.';
}

export function providerLabel(providerId: string): string {
  return providerId === 'openrouter'
    ? 'OpenRouter'
    : providerId === 'deepseek'
      ? 'DeepSeek'
      : providerId === 'codex'
        ? 'Codex'
        : providerId;
}

export function formatMoney(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `${value.toFixed(1)}%`;
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Not available';
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function formatRelativeReset(value: string | undefined, now = Date.now()): string {
  if (!value) {
    return 'at an unknown time';
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 'at an unknown time';
  }
  const seconds = Math.max(0, Math.floor((timestamp - now) / 1_000));
  if (seconds < 60) {
    return seconds === 0 ? 'now' : 'in under 1m';
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0 && parts.length < 2) parts.push(`${minutes % 60}m`);
  if (parts.length === 0) parts.push('under 1m');
  return `in ${parts.join(' ')}`;
}

export function formatRelativeAge(value: string | undefined, now = Date.now()): string {
  if (!value) {
    return 'Not available';
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 'Not available';
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export interface PricingPresentation {
  readonly badge: 'PEAK' | 'NORMAL' | 'PRICING UNKNOWN';
  readonly tone: 'peak' | 'normal' | 'unknown';
  readonly summary: string;
}

export function deepSeekPricingPresentation(
  resource: CapacityResource | undefined,
): PricingPresentation {
  const state = typeof resource?.metadata?.state === 'string' ? resource.metadata.state : undefined;
  if (state !== 'PEAK' && state !== 'OFF_PEAK') {
    return { badge: 'PRICING UNKNOWN', tone: 'unknown', summary: 'Pricing unknown' };
  }

  const multiplier =
    typeof resource?.metadata?.price_multiplier === 'number'
      ? ` · ${resource.metadata.price_multiplier}×`
      : '';
  return state === 'PEAK'
    ? { badge: 'PEAK', tone: 'peak', summary: `Peak pricing${multiplier}` }
    : { badge: 'NORMAL', tone: 'normal', summary: `Off-peak pricing${multiplier}` };
}

export function pricingTransitionLabel(resource: CapacityResource): string | undefined {
  const time = formatLocalTime(resource.changesAt);
  if (!time) {
    return undefined;
  }
  const state = resource.metadata?.state;
  const nextState = resource.metadata?.next_state;
  if (state === 'PEAK' && nextState === 'OFF_PEAK') {
    return `Peak ends at ${time}`;
  }
  if (state === 'OFF_PEAK' && nextState === 'PEAK') {
    return `Peak begins at ${time}`;
  }
  return `Changes at ${time}`;
}

function formatLocalTime(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}

export function isUnboundedResource(resource: CapacityResource): boolean {
  return resource.metadata?.budget_state === 'unbounded';
}

export function isSemanticallyKnownResource(resource: CapacityResource): boolean {
  return isUnboundedResource(resource) || (resource.status !== 'unknown' && !resource.error);
}

export function providerSummaryStatus(
  resources: readonly CapacityResource[],
  unavailable: boolean,
): 'unavailable' | 'partial' | 'available' {
  if (unavailable) {
    return 'unavailable';
  }
  return resources.some(
    (resource) =>
      !isSemanticallyKnownResource(resource) ||
      resource.status === 'critical' ||
      resource.status === 'exhausted',
  )
    ? 'partial'
    : 'available';
}

export function resourceStatusLabel(resource: CapacityResource): string {
  return isUnboundedResource(resource) ? 'UNBOUNDED' : statusLabel(resource.status);
}

export function primaryResource(
  resources: readonly CapacityResource[],
): CapacityResource | undefined {
  return resources.find((resource) => resource.kind === 'wallet') ?? resources[0];
}

export function codexMainQuotaResources(
  resources: readonly CapacityResource[],
): readonly CapacityResource[] {
  return resources
    .filter(
      (resource) =>
        resource.provider === 'codex' &&
        (resource.kind === 'rolling_quota' || resource.kind === 'weekly_quota') &&
        resource.metadata?.limit_id === 'codex' &&
        (resource.metadata.window_role === 'primary' ||
          resource.metadata.window_role === 'secondary'),
    )
    .sort((left, right) =>
      left.metadata?.window_role === right.metadata?.window_role
        ? left.id.localeCompare(right.id)
        : left.metadata?.window_role === 'primary'
          ? -1
          : 1,
    );
}

export function codexPlanLabel(resources: readonly CapacityResource[]): string | undefined {
  const plan = resources.find(
    (resource) => resource.provider === 'codex' && typeof resource.metadata?.plan_type === 'string',
  )?.metadata?.plan_type;
  if (typeof plan !== 'string' || plan === 'unknown') {
    return undefined;
  }
  return plan.replaceAll('_', ' ').toUpperCase();
}

export function resourceValue(resource: CapacityResource): string {
  if (isUnboundedResource(resource)) {
    return 'No spending cap configured';
  }
  if (resource.kind === 'pricing_window') {
    return deepSeekPricingPresentation(resource).summary;
  }
  if (resource.unit === 'usd') {
    return formatMoney(resource.remaining);
  }
  if (resource.unit === 'percent') {
    return formatPercent(resource.remainingPercent);
  }
  if (resource.remaining !== undefined) {
    return `${resource.remaining} ${resource.unit}`;
  }
  return 'Not reported';
}

export function resourceDetail(resource: CapacityResource, now = Date.now()): string | undefined {
  if (resource.kind === 'pricing_window') {
    return pricingTransitionLabel(resource);
  }
  if (resource.unit === 'usd' && resource.remaining !== undefined) {
    const parts = [
      resource.remainingPercent === undefined
        ? undefined
        : `${formatPercent(resource.remainingPercent)} remaining`,
      resource.limit === undefined ? undefined : `of ${formatMoney(resource.limit)}`,
      resource.used === undefined ? undefined : `${formatMoney(resource.used)} used`,
    ].filter((part): part is string => part !== undefined);
    return parts.join(' · ') || undefined;
  }
  if (resource.resetAt) {
    return `Resets ${formatRelativeReset(resource.resetAt, now)} · ${formatTimestamp(resource.resetAt)}`;
  }
  if (resource.changesAt) {
    return `Changes ${formatTimestamp(resource.changesAt)}`;
  }
  return undefined;
}

export function statusLabel(status: CapacityStatus): string {
  return status.replace('_', ' ');
}

export function freshnessLabel(freshness: CapacityFreshness): string {
  return freshness.replace('_', ' ');
}
