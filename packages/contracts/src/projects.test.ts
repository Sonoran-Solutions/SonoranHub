import { describe, expect, it } from 'vitest';

import {
  projectAttentionSummarySchema,
  projectConfigSchema,
  projectIdSchema,
  projectRepositorySummarySchema,
  projectsConfigFileSchema,
  projectsResponseSchema,
  projectDetailResponseSchema,
} from './projects.js';

describe('Project Contracts', () => {
  it('validates project IDs with strict grammar', () => {
    expect(projectIdSchema.safeParse('sonoran-hub').success).toBe(true);
    expect(projectIdSchema.safeParse('dualdex').success).toBe(true);
    expect(projectIdSchema.safeParse('project-holocron').success).toBe(true);

    expect(projectIdSchema.safeParse('a').success).toBe(false); // too short
    expect(projectIdSchema.safeParse('-bad').success).toBe(false);
    expect(projectIdSchema.safeParse('bad-').success).toBe(false);
    expect(projectIdSchema.safeParse('Bad-Name').success).toBe(false); // uppercase rejected
    expect(projectIdSchema.safeParse('bad_name').success).toBe(false); // underscore rejected
    expect(projectIdSchema.safeParse('bad--name').success).toBe(false); // double hyphen rejected
  });

  it('enforces exactly one primary repository per project', () => {
    const valid = {
      id: 'sonoran-hub',
      name: 'Sonoran Hub',
      description: 'Control plane',
      repositories: [
        { owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true },
        { owner: 'Sonoran-Solutions', name: 'SonoranAgent', primary: false },
      ],
    };
    expect(projectConfigSchema.safeParse(valid).success).toBe(true);

    const noPrimary = {
      ...valid,
      repositories: [
        { owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: false },
        { owner: 'Sonoran-Solutions', name: 'SonoranAgent', primary: false },
      ],
    };
    expect(projectConfigSchema.safeParse(noPrimary).success).toBe(false);

    const multiplePrimary = {
      ...valid,
      repositories: [
        { owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true },
        { owner: 'Sonoran-Solutions', name: 'SonoranAgent', primary: true },
      ],
    };
    expect(projectConfigSchema.safeParse(multiplePrimary).success).toBe(false);
  });

  it('rejects duplicate repositories within a project (case-insensitive)', () => {
    const duplicate = {
      id: 'sonoran-hub',
      name: 'Sonoran Hub',
      repositories: [
        { owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true },
        { owner: 'sonoran-solutions', name: 'sonoranhub', primary: false },
      ],
    };
    expect(projectConfigSchema.safeParse(duplicate).success).toBe(false);
  });

  it('rejects duplicate project IDs in configuration file', () => {
    const config = {
      version: 1,
      projects: [
        {
          id: 'sonoran-hub',
          name: 'Sonoran Hub',
          repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
        },
        {
          id: 'sonoran-hub',
          name: 'Another Hub',
          repositories: [{ owner: 'Sonoran-Solutions', name: 'Other', primary: true }],
        },
      ],
    };
    expect(projectsConfigFileSchema.safeParse(config).success).toBe(false);
  });

  it('validates projects response schema', () => {
    const response = {
      projects: [
        {
          id: 'sonoran-hub',
          name: 'Sonoran Hub',
          description: 'Control plane',
          configured: true,
          repositories: [
            {
              owner: 'Sonoran-Solutions',
              name: 'SonoranHub',
              primary: true,
              ciState: 'success',
              openPrCount: 2,
              openIssueCount: 4,
              attentionIssueCount: 1,
              freshness: 'fresh',
            },
          ],
          primaryRepository: {
            owner: 'Sonoran-Solutions',
            name: 'SonoranHub',
            primary: true,
            ciState: 'success',
            openPrCount: 2,
            openIssueCount: 4,
            attentionIssueCount: 1,
            freshness: 'fresh',
          },
          attention: {
            failingCi: 0,
            openPullRequests: 2,
            attentionIssues: 1,
          },
          freshness: 'fresh',
          lastFetchedAt: '2026-09-18T20:00:00.000Z',
        },
      ],
      sourceHealth: {
        configured: true,
        available: true,
        lastSuccessfulRefresh: '2026-09-18T20:00:00.000Z',
      },
      generatedAt: '2026-09-18T20:01:00.000Z',
    };
    expect(projectsResponseSchema.safeParse(response).success).toBe(true);
  });

  it('validates project detail response schema', () => {
    const response = {
      project: {
        id: 'sonoran-hub',
        name: 'Sonoran Hub',
        description: 'Control plane',
        configured: true,
        attentionLabels: ['bug', 'blocked'],
        repositories: [
          {
            owner: 'Sonoran-Solutions',
            name: 'SonoranHub',
            primary: true,
            ciState: 'success',
            openPrCount: 1,
            openIssueCount: 1,
            attentionIssueCount: 1,
            freshness: 'fresh',
            snapshot: {
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
            },
          },
        ],
        primaryRepository: {
          owner: 'Sonoran-Solutions',
          name: 'SonoranHub',
          primary: true,
          ciState: 'success',
          openPrCount: 1,
          openIssueCount: 1,
          attentionIssueCount: 1,
          freshness: 'fresh',
        },
        attention: {
          failingCi: 0,
          openPullRequests: 1,
          attentionIssues: 1,
        },
        openPullRequests: [
          {
            number: 42,
            title: 'Add read-only GitHub control plane',
            author: 'octocat',
            draft: false,
            updatedAt: '2026-09-18T20:00:00.000Z',
            url: 'https://github.com/Sonoran-Solutions/SonoranHub/pull/42',
            ciState: 'success',
          },
        ],
        attentionIssues: [
          {
            number: 10,
            title: 'Critical bug in polling',
            author: 'octocat',
            labels: ['bug'],
            updatedAt: '2026-09-18T19:00:00.000Z',
            url: 'https://github.com/Sonoran-Solutions/SonoranHub/issues/10',
            isAttention: true,
          },
        ],
        latestCi: {
          status: 'success',
          conclusion: 'success',
          workflowName: 'CI',
          runUrl: 'https://github.com/Sonoran-Solutions/SonoranHub/actions/runs/12345',
          updatedAt: '2026-09-18T20:00:00.000Z',
        },
        freshness: 'fresh',
        lastFetchedAt: '2026-09-18T20:00:00.000Z',
      },
      sourceHealth: {
        configured: true,
        available: true,
      },
      generatedAt: '2026-09-18T20:01:00.000Z',
    };
    expect(projectDetailResponseSchema.safeParse(response).success).toBe(true);
  });

  it('validates nullable counts and hasMore flags when data is unavailable or paginated', () => {
    const unavailableRepo = {
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      primary: true,
      ciState: 'unknown' as const,
      latestCi: null,
      openPrCount: null,
      openPrHasMore: false,
      openIssueCount: null,
      openIssueHasMore: false,
      attentionIssueCount: null,
      freshness: 'unavailable' as const,
    };
    expect(projectRepositorySummarySchema.safeParse(unavailableRepo).success).toBe(true);

    const paginatedRepo = {
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      primary: true,
      ciState: 'pending' as const,
      latestCi: {
        status: 'pending' as const,
      },
      openPrCount: 20,
      openPrHasMore: true,
      openIssueCount: 30,
      openIssueHasMore: true,
      attentionIssueCount: 5,
      freshness: 'fresh' as const,
    };
    const parsed = projectRepositorySummarySchema.safeParse(paginatedRepo);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.openPrHasMore).toBe(true);
      expect(parsed.data.openIssueHasMore).toBe(true);
    }
  });

  it('validates nullable project attention aggregates when underlying data is unknown', () => {
    const unknownAttention = {
      failingCi: null,
      openPullRequests: null,
      attentionIssues: null,
    };
    expect(projectAttentionSummarySchema.safeParse(unknownAttention).success).toBe(true);
  });
});
