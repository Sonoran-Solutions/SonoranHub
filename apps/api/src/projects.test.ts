import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitHubAdapter,
  FakeGitHubProjectSource,
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
