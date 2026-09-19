import type { CiState } from '@sonoran-hub/contracts';

export interface CheckRunItem {
  readonly name: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly html_url?: string | null;
}

export interface CommitStatusItem {
  readonly context: string;
  readonly state: string;
}

const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
  'startup_failure',
]);
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested']);
const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Aggregates GitHub check runs and legacy commit statuses into a single unified CiState.
 *
 * Rules:
 * 1. Any check failure/timeout/cancellation or status error/failure -> 'failure'
 * 2. Else any in-progress/queued check or pending status -> 'pending'
 * 3. Else if there are checks/statuses and all completed successfully -> 'success'
 * 4. Else if all are neutral/skipped -> 'neutral'
 * 5. If no checks or statuses exist -> 'unknown'
 */
export function aggregateCiState(
  checkRuns: readonly CheckRunItem[],
  statuses: readonly CommitStatusItem[] = [],
): CiState {
  const totalItems = checkRuns.length + statuses.length;
  if (totalItems === 0) {
    return 'unknown';
  }

  // 1. Any failure?
  const hasFailureCheck = checkRuns.some(
    (check) => check.conclusion !== null && FAILURE_CONCLUSIONS.has(check.conclusion.toLowerCase()),
  );
  const hasFailureStatus = statuses.some(
    (status) => status.state.toLowerCase() === 'failure' || status.state.toLowerCase() === 'error',
  );
  if (hasFailureCheck || hasFailureStatus) {
    return 'failure';
  }

  // 2. Any pending?
  const hasPendingCheck = checkRuns.some(
    (check) =>
      check.status !== null &&
      PENDING_STATUSES.has(check.status.toLowerCase()) &&
      check.conclusion === null,
  );
  const hasPendingStatus = statuses.some((status) => status.state.toLowerCase() === 'pending');
  if (hasPendingCheck || hasPendingStatus) {
    return 'pending';
  }

  // 3. Are there actual success checks?
  const hasStrictSuccess =
    checkRuns.some((check) => check.conclusion?.toLowerCase() === 'success') ||
    statuses.some((status) => status.state.toLowerCase() === 'success');

  const allChecksSatisfied = checkRuns.every(
    (check) => check.conclusion !== null && SUCCESS_CONCLUSIONS.has(check.conclusion.toLowerCase()),
  );
  const allStatusesSatisfied = statuses.every((status) => status.state.toLowerCase() === 'success');

  if (allChecksSatisfied && allStatusesSatisfied) {
    if (hasStrictSuccess) {
      return 'success';
    }
    return 'neutral';
  }

  return 'unknown';
}
