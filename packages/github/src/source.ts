import { App, type Octokit } from 'octokit';

import type {
  CiState,
  GitHubCiSummary,
  GitHubIssueSummary,
  GitHubPullRequestSummary,
  GitHubRepositorySnapshot,
  GitHubSourceHealth,
} from '@sonoran-hub/contracts';

import { aggregateCiState, type CheckRunItem, type CommitStatusItem } from './ci.js';
import { classifyGitHubError, GitHubIntegrationError } from './errors.js';
import type { GitHubPaginatedList, GitHubProjectSource, GitHubRateLimit } from './types.js';
import {
  buildGitHubIssueUrl,
  buildGitHubPullUrl,
  buildGitHubRepoUrl,
  buildGitHubRunUrl,
  isSafeGitHubUrl,
} from './url.js';

function hasNextPage(linkHeader: unknown): boolean {
  if (typeof linkHeader !== 'string') return false;
  return /<[^>]+>;\s*rel="next"/.test(linkHeader) || linkHeader.includes('rel="next"');
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface GitHubAppCredentials {
  readonly appId: number | string;
  readonly installationId: number | string;
  readonly privateKey: string;
}

export class GitHubAppProjectSource implements GitHubProjectSource {
  private readonly app: App;
  private readonly installationId: number;
  private cachedRateLimit: GitHubRateLimit | null = null;

  constructor(credentials: GitHubAppCredentials) {
    const appId = Number(credentials.appId);
    if (!Number.isInteger(appId) || appId <= 0) {
      throw new GitHubIntegrationError('authentication', 'Invalid GITHUB_APP_ID');
    }
    const installationId = Number(credentials.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new GitHubIntegrationError('authentication', 'Invalid GITHUB_INSTALLATION_ID');
    }
    if (!credentials.privateKey || !credentials.privateKey.trim()) {
      throw new GitHubIntegrationError('authentication', 'GITHUB_PRIVATE_KEY is empty');
    }

    const privateKey = credentials.privateKey.includes('\\n')
      ? credentials.privateKey.replace(/\\n/g, '\n')
      : credentials.privateKey;

    this.app = new App({
      appId,
      privateKey,
    });
    this.installationId = installationId;
  }

  private async getClient(): Promise<Octokit> {
    try {
      return await this.app.getInstallationOctokit(this.installationId);
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  private updateRateLimitFromHeaders(headers: Record<string, unknown>): void {
    const remaining = Number(headers['x-ratelimit-remaining']);
    const limit = Number(headers['x-ratelimit-limit']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(remaining) && Number.isFinite(limit) && Number.isFinite(reset)) {
      this.cachedRateLimit = {
        remaining,
        limit,
        resetAt: new Date(reset * 1000).toISOString(),
      };
    }
  }

  async probe(): Promise<GitHubSourceHealth> {
    try {
      const client = await this.getClient();
      const rateLimitResponse = await client.rest.rateLimit.get();
      this.updateRateLimitFromHeaders(rateLimitResponse.headers as Record<string, unknown>);
      const core = rateLimitResponse.data.rate;
      this.cachedRateLimit = {
        remaining: core.remaining,
        limit: core.limit,
        resetAt: new Date(core.reset * 1000).toISOString(),
      };
      return {
        configured: true,
        available: true,
        rateLimit: this.cachedRateLimit,
      };
    } catch (error) {
      const classified = classifyGitHubError(error);
      return {
        configured: true,
        available: false,
        lastError: {
          code: classified.code,
          message: classified.message,
        },
        rateLimit: this.cachedRateLimit,
      };
    }
  }

  async getRateLimit(): Promise<GitHubRateLimit | null> {
    return this.cachedRateLimit;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepositorySnapshot> {
    const client = await this.getClient();
    try {
      const response = await client.rest.repos.get({ owner, repo });
      this.updateRateLimitFromHeaders(response.headers as Record<string, unknown>);
      const data = response.data;
      const htmlUrl =
        data.html_url && isSafeGitHubUrl(data.html_url)
          ? data.html_url
          : buildGitHubRepoUrl(owner, repo);

      return {
        owner: data.owner.login,
        name: data.name,
        id: data.id,
        defaultBranch: data.default_branch,
        isPrivate: data.private,
        isArchived: data.archived,
        description: data.description ?? null,
        primaryLanguage: data.language ?? null,
        updatedAt: data.updated_at,
        pushedAt: data.pushed_at ?? null,
        url: htmlUrl,
      };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<GitHubPaginatedList<GitHubPullRequestSummary>> {
    const client = await this.getClient();
    try {
      const response = await client.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 20,
      });
      const headers = response.headers as Record<string, unknown>;
      this.updateRateLimitFromHeaders(headers);
      const hasMore = hasNextPage(headers['link']);

      const prsToEnrich = response.data.slice(0, 10);
      const remainingPrs = response.data.slice(10);

      const enrichedSummaries = await mapConcurrent(prsToEnrich, 3, async (pr) => {
        let ciState: CiState = 'unknown';
        if (pr.head.sha) {
          try {
            ciState = await this.getCommitCiState(client, owner, repo, pr.head.sha);
          } catch (error) {
            const classified = classifyGitHubError(error);
            if (
              classified.code === 'authentication' ||
              classified.code === 'rate_limited' ||
              classified.code === 'permission'
            ) {
              throw classified;
            }
            ciState = 'unknown';
          }
        }

        const htmlUrl =
          pr.html_url && isSafeGitHubUrl(pr.html_url)
            ? pr.html_url
            : buildGitHubPullUrl(owner, repo, pr.number);

        return {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? null,
          draft: Boolean(pr.draft),
          updatedAt: pr.updated_at,
          url: htmlUrl,
          ciState,
        };
      });

      const remainingSummaries: GitHubPullRequestSummary[] = remainingPrs.map((pr) => {
        const htmlUrl =
          pr.html_url && isSafeGitHubUrl(pr.html_url)
            ? pr.html_url
            : buildGitHubPullUrl(owner, repo, pr.number);

        return {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? null,
          draft: Boolean(pr.draft),
          updatedAt: pr.updated_at,
          url: htmlUrl,
          ciState: 'unknown' as const,
        };
      });

      return {
        items: [...enrichedSummaries, ...remainingSummaries],
        count: response.data.length,
        hasMore,
      };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  async listAttentionIssues(
    owner: string,
    repo: string,
    attentionLabels: readonly string[] = [],
  ): Promise<GitHubPaginatedList<GitHubIssueSummary>> {
    const client = await this.getClient();
    try {
      const response = await client.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 50,
      });
      const headers = response.headers as Record<string, unknown>;
      this.updateRateLimitFromHeaders(headers);
      const linkHasMore = hasNextPage(headers['link']);

      // GitHub Issues API returns PRs as well; filter them out
      const rawIssues = response.data.filter((item) => !item.pull_request);
      const labelFilterSet = new Set(attentionLabels.map((label) => label.trim().toLowerCase()));

      const allIssues: GitHubIssueSummary[] = rawIssues.map((issue) => {
        const labels = issue.labels
          .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
          .filter(Boolean);

        const isAttention =
          labelFilterSet.size > 0 &&
          labels.some((label) => labelFilterSet.has(label.toLowerCase()));

        const htmlUrl =
          issue.html_url && isSafeGitHubUrl(issue.html_url)
            ? issue.html_url
            : buildGitHubIssueUrl(owner, repo, issue.number);

        return {
          number: issue.number,
          title: issue.title,
          author: issue.user?.login ?? null,
          labels,
          updatedAt: issue.updated_at,
          url: htmlUrl,
          isAttention,
        };
      });

      const attentionIssues = allIssues.filter((i) => i.isAttention);
      const attentionCount = attentionIssues.length;
      const attentionHasMore = linkHasMore;

      const items: GitHubIssueSummary[] = allIssues.slice(0, 30);
      const hasMore = linkHasMore || rawIssues.length > 30;

      return {
        items,
        count: rawIssues.length,
        hasMore,
        attentionCount,
        attentionHasMore,
      };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  async getLatestCiState(
    owner: string,
    repo: string,
    defaultBranch = 'main',
  ): Promise<GitHubCiSummary> {
    const client = await this.getClient();
    try {
      const state = await this.getCommitCiState(client, owner, repo, defaultBranch);

      let runUrl: string | null = null;
      let workflowName: string | null = null;
      let updatedAt: string | null = null;
      let conclusion: string | null = null;

      try {
        const workflowResponse = await client.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          branch: defaultBranch,
          per_page: 1,
        });
        const latestRun = workflowResponse.data.workflow_runs[0];
        if (latestRun) {
          conclusion = latestRun.conclusion ?? null;
          workflowName = latestRun.name ?? null;
          updatedAt = latestRun.updated_at;
          runUrl =
            latestRun.html_url && isSafeGitHubUrl(latestRun.html_url)
              ? latestRun.html_url
              : buildGitHubRunUrl(owner, repo, latestRun.id);
        }
      } catch (error) {
        const classified = classifyGitHubError(error);
        if (
          classified.code === 'authentication' ||
          classified.code === 'rate_limited' ||
          classified.code === 'permission'
        ) {
          throw classified;
        }
        // Workflow runs API might be disabled or unavailable; commit checks remain source of truth
      }

      return {
        status: state,
        conclusion,
        runUrl,
        workflowName,
        updatedAt,
      };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  private async getCommitCiState(
    client: Octokit,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<CiState> {
    const checkRuns: CheckRunItem[] = [];
    const statuses: CommitStatusItem[] = [];

    try {
      const checkResponse = await client.rest.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 50,
      });
      for (const run of checkResponse.data.check_runs) {
        checkRuns.push({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
        });
      }
    } catch (error) {
      const classified = classifyGitHubError(error);
      if (classified.code === 'not_found' || classified.status === 422) {
        // Checks API might not have checks configured
      } else {
        throw classified;
      }
    }

    try {
      const statusResponse = await client.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
      });
      for (const status of statusResponse.data.statuses) {
        statuses.push({
          context: status.context,
          state: status.state,
        });
      }
    } catch (error) {
      const classified = classifyGitHubError(error);
      if (classified.code === 'not_found' || classified.status === 422) {
        // Commit status might be empty
      } else {
        throw classified;
      }
    }

    return aggregateCiState(checkRuns, statuses);
  }
}

export class UnconfiguredGitHubProjectSource implements GitHubProjectSource {
  async probe(): Promise<GitHubSourceHealth> {
    return {
      configured: false,
      available: false,
    };
  }

  async getRepository(): Promise<GitHubRepositorySnapshot> {
    throw new GitHubIntegrationError('unconfigured', 'GitHub integration is not configured');
  }

  async listOpenPullRequests(): Promise<GitHubPaginatedList<GitHubPullRequestSummary>> {
    throw new GitHubIntegrationError('unconfigured', 'GitHub integration is not configured');
  }

  async listAttentionIssues(): Promise<GitHubPaginatedList<GitHubIssueSummary>> {
    throw new GitHubIntegrationError('unconfigured', 'GitHub integration is not configured');
  }

  async getLatestCiState(): Promise<GitHubCiSummary> {
    throw new GitHubIntegrationError('unconfigured', 'GitHub integration is not configured');
  }

  async getRateLimit(): Promise<GitHubRateLimit | null> {
    return null;
  }
}

export class FakeGitHubProjectSource implements GitHubProjectSource {
  private health: GitHubSourceHealth = { configured: true, available: true };
  private repositories = new Map<string, GitHubRepositorySnapshot>();
  private pullRequests = new Map<
    string,
    { items: GitHubPullRequestSummary[]; hasMore: boolean; count?: number }
  >();
  private issues = new Map<
    string,
    { items: GitHubIssueSummary[]; hasMore: boolean; count?: number }
  >();
  private ciStates = new Map<string, GitHubCiSummary>();
  private rateLimit: GitHubRateLimit | null = {
    remaining: 5000,
    limit: 5000,
    resetAt: new Date().toISOString(),
  };
  private errorOverride?: GitHubIntegrationError;

  setHealth(health: GitHubSourceHealth): void {
    this.health = health;
  }

  setRateLimit(rateLimit: GitHubRateLimit | null): void {
    this.rateLimit = rateLimit;
  }

  setError(error?: GitHubIntegrationError): void {
    this.errorOverride = error;
  }

  setRepository(snapshot: GitHubRepositorySnapshot): void {
    this.repositories.set(
      `${snapshot.owner.toLowerCase()}/${snapshot.name.toLowerCase()}`,
      snapshot,
    );
  }

  setPullRequests(
    owner: string,
    repo: string,
    prs: GitHubPullRequestSummary[],
    hasMore = false,
    count?: number,
  ): void {
    this.pullRequests.set(`${owner.toLowerCase()}/${repo.toLowerCase()}`, {
      items: prs,
      hasMore,
      count: count ?? prs.length,
    });
  }

  setIssues(
    owner: string,
    repo: string,
    issues: GitHubIssueSummary[],
    hasMore = false,
    count?: number,
  ): void {
    this.issues.set(`${owner.toLowerCase()}/${repo.toLowerCase()}`, {
      items: issues,
      hasMore,
      count: count ?? issues.length,
    });
  }

  setCiState(owner: string, repo: string, ci: GitHubCiSummary): void {
    this.ciStates.set(`${owner.toLowerCase()}/${repo.toLowerCase()}`, ci);
  }

  async probe(): Promise<GitHubSourceHealth> {
    if (this.errorOverride) throw this.errorOverride;
    return this.health;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepositorySnapshot> {
    if (this.errorOverride) throw this.errorOverride;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const found = this.repositories.get(key);
    if (!found) {
      throw new GitHubIntegrationError('not_found', `Repository ${owner}/${repo} not found`, 404);
    }
    return found;
  }

  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<GitHubPaginatedList<GitHubPullRequestSummary>> {
    if (this.errorOverride) throw this.errorOverride;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const found = this.pullRequests.get(key);
    if (!found) {
      return { items: [], count: 0, hasMore: false };
    }
    return {
      items: found.items,
      count: found.count ?? found.items.length,
      hasMore: found.hasMore,
    };
  }

  async listAttentionIssues(
    owner: string,
    repo: string,
    attentionLabels: readonly string[] = [],
  ): Promise<GitHubPaginatedList<GitHubIssueSummary>> {
    if (this.errorOverride) throw this.errorOverride;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const found = this.issues.get(key);
    if (!found) {
      return { items: [], count: 0, hasMore: false };
    }
    const filter = new Set(attentionLabels.map((label) => label.toLowerCase()));
    const items = found.items.map((issue) => ({
      ...issue,
      isAttention: filter.size > 0 && issue.labels.some((l) => filter.has(l.toLowerCase())),
    }));
    const attentionCount = items.filter((i) => i.isAttention).length;
    return {
      items,
      count: found.count ?? found.items.length,
      hasMore: found.hasMore,
      attentionCount,
      attentionHasMore: found.hasMore,
    };
  }

  async getLatestCiState(owner: string, repo: string): Promise<GitHubCiSummary> {
    if (this.errorOverride) throw this.errorOverride;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return (
      this.ciStates.get(key) ?? {
        status: 'unknown',
        conclusion: null,
      }
    );
  }

  async getRateLimit(): Promise<GitHubRateLimit | null> {
    return this.rateLimit;
  }
}
