import { describe, expect, it } from 'vitest';

import { GitHubAdapter } from './adapter.js';
import { GitHubIntegrationError } from './errors.js';
import { FakeGitHubProjectSource } from './source.js';

describe('GitHubAdapter', () => {
  const sampleRepo = {
    owner: 'Sonoran-Solutions',
    name: 'SonoranHub',
    defaultBranch: 'main',
    isPrivate: false,
    isArchived: false,
    description: 'Control plane for Sonoran Solutions',
    primaryLanguage: 'TypeScript',
    updatedAt: '2026-09-18T20:00:00.000Z',
    pushedAt: '2026-09-18T20:00:00.000Z',
    url: 'https://github.com/Sonoran-Solutions/SonoranHub',
  };

  it('normalizes repository data, PRs, issues, and CI', async () => {
    const source = new FakeGitHubProjectSource();
    source.setRepository(sampleRepo);
    source.setPullRequests('Sonoran-Solutions', 'SonoranHub', [
      {
        number: 1,
        title: 'Add projects cockpit',
        author: 'octocat',
        draft: false,
        updatedAt: '2026-09-18T19:00:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/pull/1',
        ciState: 'success',
      },
      {
        number: 2,
        title: 'WIP task',
        author: 'octocat',
        draft: true,
        updatedAt: '2026-09-18T19:30:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/pull/2',
        ciState: 'pending',
      },
    ]);
    source.setIssues('Sonoran-Solutions', 'SonoranHub', [
      {
        number: 10,
        title: 'High priority issue',
        author: 'developer',
        labels: ['priority', 'frontend'],
        updatedAt: '2026-09-18T18:00:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/issues/10',
        isAttention: true,
      },
      {
        number: 11,
        title: 'Routine docs task',
        author: 'developer',
        labels: ['documentation'],
        updatedAt: '2026-09-18T18:30:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/issues/11',
        isAttention: false,
      },
    ]);
    source.setCiState('Sonoran-Solutions', 'SonoranHub', {
      status: 'success',
      conclusion: 'success',
      workflowName: 'CI',
      runUrl: 'https://github.com/Sonoran-Solutions/SonoranHub/actions/runs/12345',
      updatedAt: '2026-09-18T20:00:00.000Z',
    });

    const adapter = new GitHubAdapter(source);
    const result = await adapter.collectRepository({
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      primary: true,
      attentionLabels: ['priority', 'bug', 'blocked'],
    });

    expect(result.owner).toBe('Sonoran-Solutions');
    expect(result.name).toBe('SonoranHub');
    expect(result.primary).toBe(true);
    expect(result.snapshot).toEqual(sampleRepo);
    expect(result.ciState).toBe('success');
    expect(result.openPrCount).toBe(2);
    expect(result.openIssueCount).toBe(2);
    expect(result.attentionIssueCount).toBe(1);
    expect(result.freshness).toBe('fresh');
    expect(result.error).toBeUndefined();
  });

  it('handles partial failures without destroying repository snapshot', async () => {
    const source = new FakeGitHubProjectSource();
    source.setRepository(sampleRepo);
    // listOpenPullRequests or getLatestCiState throws an error
    source.setError(new GitHubIntegrationError('rate_limited', 'Rate limited on PRs'));

    const adapter = new GitHubAdapter(source);
    // Provide previous snapshot
    const previousResult = {
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      primary: true,
      snapshot: sampleRepo,
      ciState: 'success' as const,
      openPullRequests: [],
      attentionIssues: [],
      openPrCount: 0,
      openIssueCount: 0,
      attentionIssueCount: 0,
      freshness: 'fresh' as const,
    };

    const result = await adapter.collectRepository(
      {
        owner: 'Sonoran-Solutions',
        name: 'SonoranHub',
        primary: true,
      },
      previousResult,
    );

    expect(result.snapshot).toEqual(sampleRepo);
    expect(result.freshness).toBe('stale');
    expect(result.error?.code).toBe('rate_limited');
  });

  it('enforces read-only invariant and rejects mutating methods', () => {
    const source = new FakeGitHubProjectSource();
    const adapter = new GitHubAdapter(source);

    // Verify adapter does not have mutating methods
    expect((adapter as unknown as Record<string, unknown>).createIssue).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).updateIssue).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).createPullRequest).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).mergePullRequest).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).createComment).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).push).toBeUndefined();

    // Verify assertReadOnly throws if a mutating method is injected
    const badSource = {
      ...source,
      createPullRequest: () => {
        /* noop */
      },
    };
    expect(() => new GitHubAdapter(badSource as unknown as FakeGitHubProjectSource)).toThrow(
      /Violation: mutating method 'createPullRequest' detected/,
    );
  });
});
