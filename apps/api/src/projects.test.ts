import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubAdapter,
  FakeGitHubProjectSource,
  GitHubIntegrationError,
  UnconfiguredGitHubProjectSource,
} from '@sonoran-hub/github';

import { buildApp } from './app.js';
import { loadProjectConfig, ProjectConfigurationError } from './projectConfig.js';
import { ProjectService } from './projects.js';
import { InMemoryProjectStore } from './projectStore.js';

describe('Project Configuration Loader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonoran-hub-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty configuration if default config file does not exist', () => {
    const config = loadProjectConfig({ cwd: tempDir, environment: {} });
    expect(config).toEqual({ version: 1, projects: [] });
  });

  it('fails with ProjectConfigurationError if explicit SONORAN_PROJECTS_PATH does not exist', () => {
    expect(() =>
      loadProjectConfig({
        cwd: tempDir,
        environment: { SONORAN_PROJECTS_PATH: 'non-existent.json' },
      }),
    ).toThrowError(ProjectConfigurationError);
  });

  it('parses valid configuration file', () => {
    const filePath = join(tempDir, 'custom-projects.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'sonoran-hub',
            name: 'Sonoran Hub',
            description: 'Control plane',
            repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
          },
        ],
      }),
    );

    const config = loadProjectConfig({
      cwd: tempDir,
      environment: { SONORAN_PROJECTS_PATH: 'custom-projects.json' },
    });
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]!.id).toBe('sonoran-hub');
    expect(config.projects[0]!.repositories[0]!.name).toBe('SonoranHub');
  });

  it('rejects invalid JSON in configuration file', () => {
    const filePath = join(tempDir, 'invalid.json');
    writeFileSync(filePath, 'not json');

    expect(() =>
      loadProjectConfig({
        cwd: tempDir,
        environment: { SONORAN_PROJECTS_PATH: 'invalid.json' },
      }),
    ).toThrowError(ProjectConfigurationError);
  });
});

describe('ProjectService & Store', () => {
  const sampleConfig = {
    version: 1 as const,
    projects: [
      {
        id: 'sonoran-hub',
        name: 'Sonoran Hub',
        description: 'Control plane',
        attentionLabels: ['bug', 'blocked'],
        repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
      },
    ],
  };

  it('reconciles projects and gathers normalized GitHub snapshots', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
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
    });
    source.setPullRequests('Sonoran-Solutions', 'SonoranHub', [
      {
        number: 1,
        title: 'Initial PR',
        author: 'octocat',
        draft: false,
        updatedAt: '2026-09-18T19:00:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/pull/1',
        ciState: 'success',
      },
    ]);
    source.setIssues('Sonoran-Solutions', 'SonoranHub', [
      {
        number: 5,
        title: 'Fix edge case',
        author: 'tester',
        labels: ['bug'],
        updatedAt: '2026-09-18T18:00:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/SonoranHub/issues/5',
        isAttention: true,
      },
    ]);
    source.setCiState('Sonoran-Solutions', 'SonoranHub', {
      status: 'success',
      conclusion: 'success',
    });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0, // Manual refresh for test
    });

    await service.start();

    const listResult = await service.list();
    expect(listResult.projects).toHaveLength(1);
    const projectSummary = listResult.projects[0]!;
    expect(projectSummary.id).toBe('sonoran-hub');
    expect(projectSummary.name).toBe('Sonoran Hub');
    expect(projectSummary.attention.openPullRequests).toBe(1);
    expect(projectSummary.attention.attentionIssues).toBe(1);
    expect(projectSummary.attention.failingCi).toBe(0);
    expect(projectSummary.freshness).toBe('fresh');

    const detailResult = await service.get('sonoran-hub');
    expect(detailResult).not.toBeNull();
    expect(detailResult!.project.openPullRequests).toHaveLength(1);
    expect(detailResult!.project.attentionIssues).toHaveLength(1);
    expect(detailResult!.project.latestCi?.status).toBe('success');

    service.stop();
  });

  it('preserves null counts and nullable attention aggregates when GitHub data is unavailable', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    // Simulate repository not found / metadata failure
    source.setError(new GitHubIntegrationError('not_found', 'Repository not found', 404));

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const listResult = await service.list();
    expect(listResult.projects).toHaveLength(1);
    const projectSummary = listResult.projects[0]!;
    expect(projectSummary.repositories[0]!.openPrCount).toBeNull();
    expect(projectSummary.repositories[0]!.openIssueCount).toBeNull();
    expect(projectSummary.repositories[0]!.attentionIssueCount).toBeNull();
    expect(projectSummary.repositories[0]!.snapshot).toBeNull();
    expect(projectSummary.repositories[0]!.ciState).toBe('unknown');

    // Project-level attention aggregates must NOT be fake zeroes
    expect(projectSummary.attention.openPullRequests).toBeNull();
    expect(projectSummary.attention.attentionIssues).toBeNull();
    expect(projectSummary.attention.failingCi).toBeNull();
    expect(projectSummary.freshness).toBe('unavailable');

    service.stop();
  });

  it('preserves real CI summary metadata end-to-end', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Control plane',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T20:00:00.000Z',
      pushedAt: '2026-09-18T20:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/SonoranHub',
    });
    source.setCiState('Sonoran-Solutions', 'SonoranHub', {
      status: 'failure',
      conclusion: 'timed_out',
      workflowName: 'Test & Lint Suite',
      runUrl: 'https://github.com/Sonoran-Solutions/SonoranHub/actions/runs/998877',
      updatedAt: '2026-09-18T20:05:00.000Z',
    });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const detailResult = await service.get('sonoran-hub');
    expect(detailResult).not.toBeNull();
    expect(detailResult!.project.latestCi).toEqual({
      status: 'failure',
      conclusion: 'timed_out',
      workflowName: 'Test & Lint Suite',
      runUrl: 'https://github.com/Sonoran-Solutions/SonoranHub/actions/runs/998877',
      updatedAt: '2026-09-18T20:05:00.000Z',
    });
    expect(detailResult!.project.attention.failingCi).toBe(1);

    service.stop();
  });

  it('handles unconfigured GitHub source gracefully without failing', async () => {
    const store = new InMemoryProjectStore();
    const source = new UnconfiguredGitHubProjectSource();
    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const listResult = await service.list();
    expect(listResult.projects).toHaveLength(1);
    expect(listResult.sourceHealth.configured).toBe(false);
    expect(listResult.projects[0]!.freshness).toBe('unavailable');
    expect(listResult.projects[0]!.attention.openPullRequests).toBeNull();
    expect(listResult.projects[0]!.attention.attentionIssues).toBeNull();
    expect(listResult.projects[0]!.attention.failingCi).toBeNull();

    service.stop();
  });

  it('performs targeted repository refresh, preserving unrelated repository snapshots and not calling their APIs', async () => {
    const multiRepoConfig = {
      version: 1 as const,
      projects: [
        {
          id: 'multi-repo-project',
          name: 'Multi Repo Project',
          description: 'Two repositories',
          attentionLabels: ['bug'],
          repositories: [
            { owner: 'Sonoran-Solutions', name: 'RepoA', primary: true },
            { owner: 'Sonoran-Solutions', name: 'RepoB', primary: false },
          ],
        },
      ],
    };

    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();

    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'RepoA',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Repo A',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/RepoA',
    });
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'RepoB',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Repo B',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/RepoB',
    });
    source.setCiState('Sonoran-Solutions', 'RepoA', { status: 'success', conclusion: 'success' });
    source.setCiState('Sonoran-Solutions', 'RepoB', { status: 'success', conclusion: 'success' });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: multiRepoConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const initialSnapshot = await store.getLatestGitHubSnapshot('multi-repo-project');
    expect(initialSnapshot?.data.repositories).toHaveLength(2);
    const repoBInitial = initialSnapshot?.data.repositories.find((r) => r.name === 'RepoB');
    expect(repoBInitial).toBeDefined();

    // Now update Repo A in source (e.g. CI fails, open PR added)
    source.setCiState('Sonoran-Solutions', 'RepoA', { status: 'failure', conclusion: 'failure' });
    source.setPullRequests('Sonoran-Solutions', 'RepoA', [
      {
        number: 42,
        title: 'Failing PR',
        draft: false,
        updatedAt: '2026-09-18T21:00:00.000Z',
        url: 'https://github.com/Sonoran-Solutions/RepoA/pull/42',
        ciState: 'failure',
      },
    ]);

    // Spy on adapter.collectRepository to prove RepoB is NOT collected
    const collectSpy = vi.spyOn(adapter, 'collectRepository');

    // Trigger targeted refresh for Repo A only
    await service.refreshRepository('Sonoran-Solutions', 'RepoA');

    // Assert collectRepository was called ONLY for Repo A, NOT Repo B
    const calledRepos = collectSpy.mock.calls.map(([target]) => target.name);
    expect(calledRepos).toContain('RepoA');
    expect(calledRepos).not.toContain('RepoB');

    // Check new snapshot
    const updatedSnapshot = await store.getLatestGitHubSnapshot('multi-repo-project');
    expect(updatedSnapshot?.id).not.toBe(initialSnapshot?.id);

    const repoAUpdated = updatedSnapshot?.data.repositories.find((r) => r.name === 'RepoA');
    const repoBPreserved = updatedSnapshot?.data.repositories.find((r) => r.name === 'RepoB');

    expect(repoAUpdated?.ciState).toBe('failure');
    expect(repoAUpdated?.openPrCount).toBe(1);

    // Repo B must be preserved exactly as before
    expect(repoBPreserved?.snapshot?.url).toBe(repoBInitial?.snapshot?.url);
    expect(repoBPreserved?.ciState).toBe('success');

    // Project attention recomputed: failingCi is now 1, open PR is 1
    expect(updatedSnapshot?.data.attention.failingCi).toBe(1);
    expect(updatedSnapshot?.data.attention.openPullRequests).toBe(1);

    service.stop();
  });

  it('reconciles all projects referencing a repository when multi-project mapping exists', async () => {
    const multiProjectConfig = {
      version: 1 as const,
      projects: [
        {
          id: 'proj-1',
          name: 'Project One',
          attentionLabels: ['bug'],
          repositories: [{ owner: 'Sonoran-Solutions', name: 'SharedRepo', primary: true }],
        },
        {
          id: 'proj-2',
          name: 'Project Two',
          attentionLabels: ['bug'],
          repositories: [{ owner: 'Sonoran-Solutions', name: 'SharedRepo', primary: true }],
        },
      ],
    };

    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'SharedRepo',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Shared Repo',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/SharedRepo',
    });
    source.setCiState('Sonoran-Solutions', 'SharedRepo', {
      status: 'success',
      conclusion: 'success',
    });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: multiProjectConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    // Now update SharedRepo in source
    source.setCiState('Sonoran-Solutions', 'SharedRepo', {
      status: 'failure',
      conclusion: 'failure',
    });

    // Target refresh for SharedRepo
    await service.refreshRepository('Sonoran-Solutions', 'SharedRepo');

    const snap1 = await store.getLatestGitHubSnapshot('proj-1');
    const snap2 = await store.getLatestGitHubSnapshot('proj-2');

    expect(snap1?.data.repositories[0]?.ciState).toBe('failure');
    expect(snap2?.data.repositories[0]?.ciState).toBe('failure');

    service.stop();
  });

  it('persists previous normalized data with stale freshness when targeted refresh hits rate limit', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Control plane',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/SonoranHub',
    });
    source.setCiState('Sonoran-Solutions', 'SonoranHub', {
      status: 'success',
      conclusion: 'success',
    });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const initialSnapshot = await store.getLatestGitHubSnapshot('sonoran-hub');
    expect(initialSnapshot?.freshness).toBe('fresh');
    expect(initialSnapshot?.data.repositories[0]?.freshness).toBe('fresh');
    expect(initialSnapshot?.data.repositories[0]?.ciState).toBe('success');

    // Simulate rate limit
    source.setRateLimit({
      remaining: 0,
      limit: 5000,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Spy on collectRepository to verify no GitHub collection API is invoked while rate-limited
    const collectSpy = vi.spyOn(adapter, 'collectRepository');

    await service.refreshRepository('Sonoran-Solutions', 'SonoranHub');

    expect(collectSpy).not.toHaveBeenCalled();

    // New persisted snapshot exists reflecting stale state
    const afterRateLimitSnapshot = await store.getLatestGitHubSnapshot('sonoran-hub');
    expect(afterRateLimitSnapshot).not.toBeNull();
    expect(afterRateLimitSnapshot?.id).not.toBe(initialSnapshot?.id);

    // Repository freshness is marked stale, but normalized data is preserved
    const repoSnapshot = afterRateLimitSnapshot?.data.repositories[0];
    expect(repoSnapshot?.freshness).toBe('stale');
    expect(repoSnapshot?.ciState).toBe('success');
    expect(repoSnapshot?.snapshot?.defaultBranch).toBe('main');
    expect(repoSnapshot?.snapshot?.url).toBe('https://github.com/Sonoran-Solutions/SonoranHub');

    // Overall project freshness is stale
    expect(afterRateLimitSnapshot?.freshness).toBe('stale');

    service.stop();
  });

  it('marks only the affected repository stale in multi-repository project when rate-limited', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'RepoA',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Repo A',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/RepoA',
    });
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'RepoB',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Repo B',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T10:00:00.000Z',
      pushedAt: '2026-09-18T10:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/RepoB',
    });
    source.setCiState('Sonoran-Solutions', 'RepoA', { status: 'success', conclusion: 'success' });
    const multiRepoConfig = {
      version: 1 as const,
      projects: [
        {
          id: 'multi-repo-project',
          name: 'Multi Repo Project',
          attentionLabels: ['bug'],
          repositories: [
            { owner: 'Sonoran-Solutions', name: 'RepoA', primary: true },
            { owner: 'Sonoran-Solutions', name: 'RepoB', primary: false },
          ],
        },
      ],
    };

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: multiRepoConfig,
      refreshIntervalMs: 0,
    });

    await service.start();

    const initialSnapshot = await store.getLatestGitHubSnapshot('multi-repo-project');
    expect(initialSnapshot?.freshness).toBe('fresh');

    // Simulate rate limit
    source.setRateLimit({
      remaining: 0,
      limit: 5000,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const collectSpy = vi.spyOn(adapter, 'collectRepository');

    await service.refreshRepository('Sonoran-Solutions', 'RepoA');

    expect(collectSpy).not.toHaveBeenCalled();

    const afterSnapshot = await store.getLatestGitHubSnapshot('multi-repo-project');
    const repoA = afterSnapshot?.data.repositories.find((r) => r.name === 'RepoA');
    const repoB = afterSnapshot?.data.repositories.find((r) => r.name === 'RepoB');

    // Repo A is marked stale; Repo B remains fresh
    expect(repoA?.freshness).toBe('stale');
    expect(repoB?.freshness).toBe('fresh');

    // Overall project freshness follows multi-repo semantics (one stale + one fresh = stale)
    expect(afterSnapshot?.freshness).toBe('stale');

    service.stop();
  });
});

describe('Projects API Endpoints', () => {
  const sampleConfig = {
    version: 1 as const,
    projects: [
      {
        id: 'sonoran-hub',
        name: 'Sonoran Hub',
        description: 'Control plane',
        attentionLabels: [],
        repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
      },
    ],
  };

  it('serves GET /projects and GET /projects/:projectId', async () => {
    const store = new InMemoryProjectStore();
    const source = new FakeGitHubProjectSource();
    source.setRepository({
      owner: 'Sonoran-Solutions',
      name: 'SonoranHub',
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      description: 'Control plane',
      primaryLanguage: 'TypeScript',
      updatedAt: '2026-09-18T20:00:00.000Z',
      pushedAt: '2026-09-18T20:00:00.000Z',
      url: 'https://github.com/Sonoran-Solutions/SonoranHub',
    });

    const adapter = new GitHubAdapter(source);
    const service = new ProjectService({
      store,
      adapter,
      projectConfig: sampleConfig,
      refreshIntervalMs: 0,
    });
    await service.start();

    const app = buildApp(undefined, { projectService: service });

    const listRes = await app.inject({ method: 'GET', url: '/projects' });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.payload);
    expect(listBody.projects).toHaveLength(1);
    expect(listBody.projects[0].id).toBe('sonoran-hub');

    const detailRes = await app.inject({ method: 'GET', url: '/projects/sonoran-hub' });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = JSON.parse(detailRes.payload);
    expect(detailBody.project.id).toBe('sonoran-hub');
    expect(detailBody.project.repositories[0].name).toBe('SonoranHub');

    const notFoundRes = await app.inject({ method: 'GET', url: '/projects/unknown-project' });
    expect(notFoundRes.statusCode).toBe(404);
    expect(JSON.parse(notFoundRes.payload).error.code).toBe('project_not_found');

    service.stop();
    await app.close();
  });
});
