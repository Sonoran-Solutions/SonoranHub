import type {
  CiState,
  GitHubFreshness,
  GitHubRepositorySnapshot,
  GitHubSourceHealth,
} from '@sonoran-hub/contracts';


import { GitHubIntegrationError } from './errors.js';
import type { GitHubProjectSource, GitHubRateLimit, NormalizedRepositoryResult } from './types.js';

export interface RepositoryCollectionTarget {
  readonly owner: string;
  readonly name: string;
  readonly primary: boolean;
  readonly attentionLabels?: readonly string[];
}

export class GitHubAdapter {
  private readonly source: GitHubProjectSource;
  private lastHealth: GitHubSourceHealth = { configured: true, available: true };
  private lastSuccessfulRefresh?: string;

  constructor(source: GitHubProjectSource) {
    this.source = source;
    this.assertReadOnly();
  }

  /**
   * Asserts at runtime that no mutating GitHub methods are defined on this adapter or its source.
   * This is an active, defensive runtime invariant checking against developer regression
   * (e.g., verifying that no mutation methods have been added to the adapter or source).
   * Note: Octokit-level read-only enforcement is governed by GitHub App installation permissions.
   */
  assertReadOnly(): void {
    const forbiddenMethods = [
      'createIssue',
      'updateIssue',
      'closeIssue',
      'createPullRequest',
      'updatePullRequest',
      'mergePullRequest',
      'closePullRequest',
      'createComment',
      'push',
      'deleteBranch',
      'createBranch',
    ];

    const targetObjects = [
      this as unknown as Record<string, unknown>,
      this.source as unknown as Record<string, unknown>,
    ];
    for (const obj of targetObjects) {
      for (const method of forbiddenMethods) {
        if (typeof obj[method] === 'function') {
          throw new Error(
            `Violation: mutating method '${method}' detected on read-only GitHub integration`,
          );
        }
      }
    }
  }

  async probe(): Promise<GitHubSourceHealth> {
    try {
      const health = await this.source.probe();
      this.lastHealth = {
        ...health,
        lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      };
      return this.lastHealth;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub probe failed';
      this.lastHealth = {
        configured: true,
        available: false,
        lastError: { code: 'unavailable', message },
        lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      };
      return this.lastHealth;
    }
  }

  async getRateLimit(): Promise<GitHubRateLimit | null> {
    return this.source.getRateLimit();
  }

  getHealth(): GitHubSourceHealth {
    return {
      ...this.lastHealth,
      lastSuccessfulRefresh: this.lastSuccessfulRefresh,
    };
  }

  async collectRepository(
    target: RepositoryCollectionTarget,
    previousResult?: NormalizedRepositoryResult,
  ): Promise<NormalizedRepositoryResult> {
    const { owner, name, primary, attentionLabels = [] } = target;

    // 1. Get repository metadata
    let snapshot: GitHubRepositorySnapshot;
    let repoError: { code: string; message: string } | undefined;

    try {
      snapshot = await this.source.getRepository(owner, name);
    } catch (error) {
      const err =
        error instanceof GitHubIntegrationError
          ? error
          : new GitHubIntegrationError('unavailable', 'Failed to fetch repository metadata');

      repoError = { code: err.code, message: err.message };

      if (
        err.code === 'rate_limited' ||
        err.code === 'authentication' ||
        err.code === 'permission'
      ) {
        const rateLimit = await this.source.getRateLimit().catch(() => null);
        this.lastHealth = {
          configured: true,
          available: false,
          lastError: repoError,
          rateLimit,
          lastSuccessfulRefresh: this.lastSuccessfulRefresh,
        };
      }

      // If we have previous snapshot, return it as stale
      if (previousResult?.snapshot) {
        return {
          ...previousResult,
          freshness: 'stale',
          error: repoError,
        };
      }

      return {
        owner,
        name,
        primary,
        snapshot: null,
        ciState: 'unknown',
        latestCi: null,
        openPullRequests: [],
        attentionIssues: [],
        openPrCount: null,
        openPrHasMore: false,
        openIssueCount: null,
        openIssueHasMore: false,
        attentionIssueCount: null,
        freshness: 'unavailable',
        error: repoError,
      };
    }

    // 2. Fetch PRs, Issues, and CI in parallel; partial failure does not destroy snapshot
    let partialError: { code: string; message: string } | undefined;

    const prPromise = this.source.listOpenPullRequests(owner, name).catch((error) => {
      const classified =
        error instanceof GitHubIntegrationError
          ? error
          : new GitHubIntegrationError('unavailable', 'Failed to fetch pull requests');
      partialError = { code: classified.code, message: classified.message };
      return {
        items: previousResult?.openPullRequests ?? [],
        count: previousResult?.openPrCount ?? null,
        hasMore: previousResult?.openPrHasMore ?? false,
      };
    });

    const issuesPromise = this.source
      .listAttentionIssues(owner, name, attentionLabels)
      .catch((error) => {
        const classified =
          error instanceof GitHubIntegrationError
            ? error
            : new GitHubIntegrationError('unavailable', 'Failed to fetch issues');
        partialError = { code: classified.code, message: classified.message };
        return {
          items: previousResult?.attentionIssues ?? [],
          count: previousResult?.openIssueCount ?? null,
          hasMore: previousResult?.openIssueHasMore ?? false,
        };
      });

    const ciPromise = this.source
      .getLatestCiState(owner, name, snapshot.defaultBranch)
      .catch((error) => {
        const classified =
          error instanceof GitHubIntegrationError
            ? error
            : new GitHubIntegrationError('unavailable', 'Failed to fetch CI state');
        partialError = { code: classified.code, message: classified.message };
        return (
          previousResult?.latestCi ?? {
            status: previousResult?.ciState ?? ('unknown' as CiState),
            conclusion: null,
          }
        );
      });

    const [pullRequestsResult, issuesResult, ciSummary] = await Promise.all([
      prPromise,
      issuesPromise,
      ciPromise,
    ]);

    // attentionIssues must only contain issues flagged as attention!
    const attentionIssues = issuesResult.items.filter((i) => i.isAttention);
    const attentionIssueCount =
      issuesResult.count !== null
        ? attentionIssues.length
        : (previousResult?.attentionIssueCount ?? null);

    const freshness: GitHubFreshness = partialError ? 'partial' : 'fresh';
    const rateLimit = await this.source.getRateLimit().catch(() => null);

    if (
      partialError &&
      (partialError.code === 'rate_limited' ||
        partialError.code === 'authentication' ||
        partialError.code === 'permission')
    ) {
      this.lastHealth = {
        configured: true,
        available: false,
        lastError: partialError,
        rateLimit,
        lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      };
    } else {
      this.lastSuccessfulRefresh = new Date().toISOString();
      this.lastHealth = {
        configured: true,
        available: true,
        rateLimit,
        lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      };
    }

    return {
      owner,
      name,
      primary,
      snapshot,
      ciState: ciSummary.status,
      latestCi: ciSummary,
      openPullRequests: pullRequestsResult.items,
      attentionIssues,
      openPrCount: pullRequestsResult.count,
      openPrHasMore: pullRequestsResult.hasMore,
      openIssueCount: issuesResult.count,
      openIssueHasMore: issuesResult.hasMore,
      attentionIssueCount,
      freshness,
      error: partialError,
    };
  }
}
