import type {
  CiState,
  GitHubCiSummary,
  GitHubFreshness,
  GitHubIssueSummary,
  GitHubPullRequestSummary,
  GitHubRepositorySnapshot,
  GitHubSourceHealth,
} from '@sonoran-hub/contracts';

export interface GitHubRateLimit {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: string;
}

export interface GitHubPaginatedList<T> {
  readonly items: readonly T[];
  readonly count: number;
  readonly hasMore: boolean;
  readonly attentionCount?: number;
  readonly attentionHasMore?: boolean;
}

export interface GitHubProjectSource {
  probe(): Promise<GitHubSourceHealth>;
  getRepository(owner: string, repo: string): Promise<GitHubRepositorySnapshot>;
  listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<GitHubPaginatedList<GitHubPullRequestSummary>>;
  listAttentionIssues(
    owner: string,
    repo: string,
    attentionLabels?: readonly string[],
  ): Promise<GitHubPaginatedList<GitHubIssueSummary>>;
  getLatestCiState(owner: string, repo: string, defaultBranch?: string): Promise<GitHubCiSummary>;
  getRateLimit(): Promise<GitHubRateLimit | null>;
}

export interface NormalizedRepositoryResult {
  readonly owner: string;
  readonly name: string;
  readonly primary: boolean;
  readonly snapshot: GitHubRepositorySnapshot | null;
  readonly ciState: CiState;
  readonly latestCi: GitHubCiSummary | null;
  readonly openPullRequests: readonly GitHubPullRequestSummary[];
  readonly attentionIssues: readonly GitHubIssueSummary[];
  readonly openPrCount: number | null;
  readonly openPrHasMore: boolean;
  readonly openIssueCount: number | null;
  readonly openIssueHasMore: boolean;
  readonly attentionIssueCount: number | null;
  readonly attentionIssueHasMore: boolean;
  readonly freshness: GitHubFreshness;
  readonly error?: { readonly code: string; readonly message: string };
}
