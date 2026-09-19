import { redactMetadata } from '@sonoran-hub/config';

export type GitHubIntegrationErrorCode =
  | 'authentication'
  | 'permission'
  | 'rate_limited'
  | 'not_found'
  | 'network'
  | 'invalid_response'
  | 'unavailable'
  | 'unconfigured';

export class GitHubIntegrationError extends Error {
  readonly code: GitHubIntegrationErrorCode;
  readonly status?: number;

  constructor(code: GitHubIntegrationErrorCode, message: string, status?: number) {
    const sanitized = sanitizeErrorMessage(message);
    super(sanitized);
    this.name = 'GitHubIntegrationError';
    this.code = code;
    this.status = status;
  }
}

export function sanitizeErrorMessage(message: string): string {
  const redacted = redactMetadata(message);
  const text = typeof redacted === 'string' ? redacted : 'GitHub integration operation failed';
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

export function classifyGitHubError(error: unknown): GitHubIntegrationError {
  if (error instanceof GitHubIntegrationError) {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    const message =
      'message' in error && typeof error.message === 'string' ? error.message : 'Unknown error';

    if (status === 401) {
      return new GitHubIntegrationError(
        'authentication',
        'GitHub authentication failed. Verify GitHub App credentials.',
        401,
      );
    }
    if (status === 403) {
      const isRateLimit = /rate limit/i.test(message);
      return new GitHubIntegrationError(
        isRateLimit ? 'rate_limited' : 'permission',
        isRateLimit
          ? 'GitHub API rate limit exceeded.'
          : 'GitHub permission denied. Check GitHub App permissions.',
        403,
      );
    }
    if (status === 404) {
      return new GitHubIntegrationError(
        'not_found',
        'Configured GitHub repository or resource was not found.',
        404,
      );
    }
    if (status === 429) {
      return new GitHubIntegrationError('rate_limited', 'GitHub API rate limit exceeded.', 429);
    }
    if (status !== undefined && status >= 500) {
      return new GitHubIntegrationError(
        'unavailable',
        `GitHub API returned service error ${status}.`,
        status,
      );
    }
  }

  if (error instanceof Error && (error.name === 'FetchError' || 'code' in error)) {
    return new GitHubIntegrationError('network', 'Network failure communicating with GitHub API.');
  }

  return new GitHubIntegrationError('unavailable', 'GitHub API is currently unavailable.');
}
