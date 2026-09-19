export { GitHubAdapter, type RepositoryCollectionTarget } from './adapter.js';

export {
  GitHubAppProjectSource,
  UnconfiguredGitHubProjectSource,
  FakeGitHubProjectSource,
  type GitHubAppCredentials,
} from './source.js';

export { aggregateCiState, type CheckRunItem, type CommitStatusItem } from './ci.js';

export {
  GitHubIntegrationError,
  classifyGitHubError,
  sanitizeErrorMessage,
  type GitHubIntegrationErrorCode,
} from './errors.js';

export {
  buildGitHubIssueUrl,
  buildGitHubPullUrl,
  buildGitHubRepoUrl,
  buildGitHubRunUrl,
  isSafeGitHubUrl,
  sanitizeGitHubUrl,
} from './url.js';

export type { GitHubProjectSource, GitHubRateLimit, NormalizedRepositoryResult } from './types.js';
