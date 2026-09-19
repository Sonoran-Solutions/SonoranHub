import { describe, expect, it } from 'vitest';

import {
  ciStateBadge,
  formatRelativeTime,
  freshnessBadge,
  isSafeGitHubUrl,
} from './projectsViewModel.js';

describe('Projects View Model Helpers', () => {
  it('maps CI states to appropriate labels and css classes', () => {
    expect(ciStateBadge('success')).toEqual({
      label: 'Passing',
      className: 'ci-badge ci-badge-success',
    });
    expect(ciStateBadge('failure')).toEqual({
      label: 'Failing',
      className: 'ci-badge ci-badge-failure',
    });
    expect(ciStateBadge('pending')).toEqual({
      label: 'Pending',
      className: 'ci-badge ci-badge-pending',
    });
    expect(ciStateBadge('neutral')).toEqual({
      label: 'Neutral',
      className: 'ci-badge ci-badge-neutral',
    });
    expect(ciStateBadge('unknown')).toEqual({
      label: 'Unknown',
      className: 'ci-badge ci-badge-unknown',
    });
  });

  it('maps freshness values to appropriate labels and css classes', () => {
    expect(freshnessBadge('fresh')).toEqual({
      label: 'Fresh',
      className: 'freshness-pill freshness-fresh',
    });
    expect(freshnessBadge('stale')).toEqual({
      label: 'Stale',
      className: 'freshness-pill freshness-stale',
    });
    expect(freshnessBadge('partial')).toEqual({
      label: 'Partial',
      className: 'freshness-pill freshness-partial',
    });
    expect(freshnessBadge('unavailable')).toEqual({
      label: 'Unavailable',
      className: 'freshness-pill freshness-unavailable',
    });
  });

  it('formats relative timestamps', () => {
    expect(formatRelativeTime(null)).toBe('Never');
    expect(formatRelativeTime(undefined)).toBe('Never');
    expect(formatRelativeTime('not-a-date')).toBe('Invalid date');

    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 10_000).toISOString())).toBe('10s ago');
    expect(formatRelativeTime(new Date(now - 120_000).toISOString())).toBe('2m ago');
    expect(formatRelativeTime(new Date(now - 7_200_000).toISOString())).toBe('2h ago');
    expect(formatRelativeTime(new Date(now - 172_800_000).toISOString())).toBe('2d ago');
  });

  it('validates safe GitHub URLs', () => {
    expect(isSafeGitHubUrl('https://github.com/Sonoran-Solutions/SonoranHub')).toBe(true);
    expect(isSafeGitHubUrl('https://github.com/Sonoran-Solutions/SonoranHub/pull/1')).toBe(true);
    expect(isSafeGitHubUrl('http://github.com/Sonoran-Solutions/SonoranHub')).toBe(false);
    expect(isSafeGitHubUrl('https://evil.com/fake')).toBe(false);
    expect(isSafeGitHubUrl(null)).toBe(false);
    expect(isSafeGitHubUrl(undefined)).toBe(false);
  });
});
