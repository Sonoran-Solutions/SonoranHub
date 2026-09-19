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

export interface GitHubProjectSource {
  probe(): Promise<GitHubSourceHealth>;
  getRepository(owner: string, repo: string): Promise<GitHubRepositorySnapshot>;
  listOpenPullRequests(owner: string, repo: string): Promise<readonly GitHubPullRequestSummary[]>;
  listAttentionIssues(
    owner: string,
    repo: string,
    attentionLabels?: readonly string[],
  ): Promise<readonly GitHubIssueSummary[]>;
  getLatestCiState(owner: string, repo: string, defaultBranch?: string): Promise<GitHubCiSummary>;
  getRateLimit(): Promise<GitHubRateLimit | null>;
}

export interface NormalizedRepositoryResult {
  readonly owner: string;
  readonly name: string;
  readonly primary: boolean;
  readonly snapshot: GitHubRepositorySnapshot | null;
  readonly ciState: CiState;
  readonly openPullRequests: readonly GitHubPullRequestSummary[];
  readonly attentionIssues: readonly GitHubIssueSummary[];
  readonly openPrCount: number;
  readonly openIssueCount: number;
  readonly attentionIssueCount: number;
  readonly freshness: GitHubFreshness;
  readonly error?: { readonly code: string; readonly message: string };
}
