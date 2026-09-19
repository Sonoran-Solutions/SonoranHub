import type {
  CiState,
  GitHubFreshness,
  ProjectDetailResponse,
  ProjectsResponse,
} from '@sonoran-hub/contracts';

export const DEFAULT_PROJECTS_POLL_INTERVAL_MS = 15_000;

export interface ProjectsState {
  readonly status: 'loading' | 'success' | 'error';
  readonly data?: ProjectsResponse;
  readonly message?: string;
  readonly refreshing: boolean;
  readonly refreshError?: string;
}

export interface ProjectDetailState {
  readonly status: 'loading' | 'success' | 'error';
  readonly data?: ProjectDetailResponse;
  readonly message?: string;
  readonly refreshing: boolean;
  readonly refreshError?: string;
}

export function initialProjectsState(): ProjectsState {
  return { status: 'loading', refreshing: false };
}

export function initialProjectDetailState(): ProjectDetailState {
  return { status: 'loading', refreshing: false };
}

export interface PollerOptions<T> {
  readonly fetchData: (signal: AbortSignal) => Promise<T>;
  readonly onState: (state: {
    status: 'loading' | 'success' | 'error';
    data?: T;
    message?: string;
    refreshing: boolean;
    refreshError?: string;
  }) => void;
  readonly intervalMs?: number;
}

export interface Poller {
  start(): void;
  stop(): void;
}

export function createResourcePoller<T>(options: PollerOptions<T>): Poller {
  const intervalMs = options.intervalMs ?? DEFAULT_PROJECTS_POLL_INTERVAL_MS;
  let current: {
    status: 'loading' | 'success' | 'error';
    data?: T;
    message?: string;
    refreshing: boolean;
    refreshError?: string;
  } = { status: 'loading', refreshing: false };

  let intervalId: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  const publish = (state: typeof current): void => {
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
    let request: Promise<T>;
    try {
      request = options.fetchData(controller.signal);
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
        if (stopped || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Request failed';
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
      if (started) return;
      started = true;
      stopped = false;
      intervalId = setInterval(() => refresh(false), intervalMs);
      refresh(true);
    },
    stop() {
      if (!started || stopped) return;
      stopped = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      controller?.abort();
      controller = undefined;
      inFlight = undefined;
    },
  };
}

export function ciStateBadge(ciState: CiState): { label: string; className: string } {
  switch (ciState) {
    case 'success':
      return { label: 'Passing', className: 'ci-badge ci-badge-success' };
    case 'failure':
      return { label: 'Failing', className: 'ci-badge ci-badge-failure' };
    case 'pending':
      return { label: 'Pending', className: 'ci-badge ci-badge-pending' };
    case 'neutral':
      return { label: 'Neutral', className: 'ci-badge ci-badge-neutral' };
    case 'unknown':
    default:
      return { label: 'Unknown', className: 'ci-badge ci-badge-unknown' };
  }
}

export function freshnessBadge(freshness: GitHubFreshness): { label: string; className: string } {
  switch (freshness) {
    case 'fresh':
      return { label: 'Fresh', className: 'freshness-pill freshness-fresh' };
    case 'stale':
      return { label: 'Stale', className: 'freshness-pill freshness-stale' };
    case 'partial':
      return { label: 'Partial', className: 'freshness-pill freshness-partial' };
    case 'unavailable':
    default:
      return { label: 'Unavailable', className: 'freshness-pill freshness-unavailable' };
  }
}

export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Never';
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return 'Invalid date';

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function isSafeGitHubUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('https://github.com/');
}

export function formatCount(count: number | null | undefined, hasMore = false): string {
  if (count === null || count === undefined) {
    return '—';
  }
  return hasMore ? `${count}+` : `${count}`;
}

export function formatBranch(branch: string | null | undefined): string {
  if (!branch || !branch.trim()) {
    return 'Unknown';
  }
  return branch;
}

export function formatVisibility(isPrivate: boolean | null | undefined): string {
  if (isPrivate === null || isPrivate === undefined) {
    return 'Unknown';
  }
  return isPrivate ? 'Private' : 'Public';
}
