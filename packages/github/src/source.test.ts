import { describe, expect, it } from 'vitest';

import { aggregateCiState } from './ci.js';
import { classifyGitHubError, GitHubIntegrationError, sanitizeErrorMessage } from './errors.js';
import { UnconfiguredGitHubProjectSource } from './source.js';
import { isSafeGitHubUrl } from './url.js';

describe('GitHub Sources & Utilities', () => {
  describe('CI state aggregation', () => {
    it('prioritizes failure over pending and success', () => {
      const checkRuns = [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ];
      expect(aggregateCiState(checkRuns)).toBe('failure');
    });

    it('prioritizes pending over success when no failures exist', () => {
      const checkRuns = [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'in_progress', conclusion: null },
      ];
      expect(aggregateCiState(checkRuns)).toBe('pending');
    });

    it('returns success when all checks succeed', () => {
      const checkRuns = [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'success' },
      ];
      expect(aggregateCiState(checkRuns)).toBe('success');
    });

    it('returns neutral when all checks are neutral or skipped', () => {
      const checkRuns = [
        { name: 'optional-check', status: 'completed', conclusion: 'neutral' },
        { name: 'skipped-check', status: 'completed', conclusion: 'skipped' },
      ];
      expect(aggregateCiState(checkRuns)).toBe('neutral');
    });

    it('returns unknown when no checks exist', () => {
      expect(aggregateCiState([])).toBe('unknown');
    });

    it('aggregates commit statuses with check runs', () => {
      const checkRuns = [{ name: 'build', status: 'completed', conclusion: 'success' }];
      const statuses = [{ context: 'security/snyk', state: 'error' }];
      expect(aggregateCiState(checkRuns, statuses)).toBe('failure');
    });
  });

  describe('URL safety validation', () => {
    it('accepts valid https://github.com URLs', () => {
      expect(isSafeGitHubUrl('https://github.com/Sonoran-Solutions/SonoranHub')).toBe(true);
      expect(isSafeGitHubUrl('https://github.com/Sonoran-Solutions/SonoranHub/pull/123')).toBe(
        true,
      );
      expect(
        isSafeGitHubUrl('https://github.com/Sonoran-Solutions/SonoranHub/actions/runs/456'),
      ).toBe(true);
    });

    it('rejects unsafe or foreign URLs', () => {
      expect(isSafeGitHubUrl('http://github.com/insecure')).toBe(false);
      expect(isSafeGitHubUrl('https://evil.com/fake')).toBe(false);
      expect(isSafeGitHubUrl('javascript:alert(1)')).toBe(false);
    });
  });

  describe('Error sanitization and classification', () => {
    it('redacts tokens and keys from error messages', () => {
      const sensitive =
        'Error with Authorization: Bearer ghs_1234567890abcdef and token=secret_value_xyz';
      const sanitized = sanitizeErrorMessage(sensitive);
      expect(sanitized).not.toContain('ghs_1234567890abcdef');
      expect(sanitized).not.toContain('secret_value_xyz');
    });

    it('classifies HTTP 401 as authentication error', () => {
      const error = { status: 401, message: 'Bad credentials' };
      const classified = classifyGitHubError(error);
      expect(classified.code).toBe('authentication');
    });

    it('classifies HTTP 403 rate limit as rate_limited', () => {
      const error = { status: 403, message: 'API rate limit exceeded for installation' };
      const classified = classifyGitHubError(error);
      expect(classified.code).toBe('rate_limited');
    });

    it('classifies HTTP 404 as not_found', () => {
      const error = { status: 404, message: 'Not Found' };
      const classified = classifyGitHubError(error);
      expect(classified.code).toBe('not_found');
    });
  });

  describe('UnconfiguredGitHubProjectSource', () => {
    it('reports unconfigured health and throws unconfigured errors', async () => {
      const source = new UnconfiguredGitHubProjectSource();
      const health = await source.probe();
      expect(health.configured).toBe(false);
      expect(health.available).toBe(false);

      await expect(source.getRepository()).rejects.toThrowError(GitHubIntegrationError);
      await expect(source.listOpenPullRequests()).rejects.toThrowError(GitHubIntegrationError);
      await expect(source.listAttentionIssues()).rejects.toThrowError(GitHubIntegrationError);
      await expect(source.getLatestCiState()).rejects.toThrowError(GitHubIntegrationError);
    });
  });
});
