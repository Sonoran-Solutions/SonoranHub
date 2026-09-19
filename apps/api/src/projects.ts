import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { AppConfig, StructuredLogger } from '@sonoran-hub/config';
import { createStructuredLogger } from '@sonoran-hub/config';
import type {
  CiState,
  GitHubFreshness,
  GitHubSourceHealth,
  ProjectAttentionSummary,
  ProjectDetail,
  ProjectDetailResponse,
  ProjectRepositorySummary,
  ProjectsConfigFile,
  ProjectsResponse,
  ProjectSummary,
} from '@sonoran-hub/contracts';
import {
  GitHubAdapter,
  GitHubAppProjectSource,
  UnconfiguredGitHubProjectSource,
  type GitHubProjectSource,
  type NormalizedRepositoryResult,
} from '@sonoran-hub/github';

import { loadProjectConfig } from './projectConfig.js';
import {
  InMemoryProjectStore,
  PostgresProjectStore,
  type PersistedGitHubSnapshot,
  type PersistedProject,
  type ProjectStore,
} from './projectStore.js';

export const DEFAULT_GITHUB_REFRESH_INTERVAL_MS = 60_000;

export interface ProjectServiceOptions {
  readonly store: ProjectStore;
  readonly adapter: GitHubAdapter;
  readonly projectConfig: ProjectsConfigFile;
  readonly refreshIntervalMs?: number;
  readonly logger?: StructuredLogger;
}

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly adapter: GitHubAdapter;
  private readonly projectConfig: ProjectsConfigFile;
  private readonly refreshIntervalMs: number;
  private readonly logger?: StructuredLogger;

  private readonly projectLocks = new Map<string, Promise<void>>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private stopped = false;
  private lastRefreshedAt?: string;

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.projectConfig = options.projectConfig;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_GITHUB_REFRESH_INTERVAL_MS;
    this.logger = options.logger;
  }

  private async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.projectLocks.set(projectId, nextLock);

    try {
      await currentLock;
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(projectId) === nextLock) {
        this.projectLocks.delete(projectId);
      }
    }
  }

  private computeAttention(
    normalizedRepositories: readonly NormalizedRepositoryResult[],
  ): ProjectAttentionSummary {
    const hasKnownCi = normalizedRepositories.some((r) => r.ciState !== 'unknown');
    const failingCiCount = normalizedRepositories.filter((r) => r.ciState === 'failure').length;
    const failingCi = failingCiCount > 0 ? failingCiCount : hasKnownCi ? 0 : null;

    const hasUnknownPr = normalizedRepositories.some((r) => r.openPrCount === null);
    const openPullRequests = hasUnknownPr
      ? null
      : normalizedRepositories.reduce((sum, r) => sum + (r.openPrCount ?? 0), 0);

    const hasUnknownIssues = normalizedRepositories.some((r) => r.attentionIssueCount === null);
    const attentionIssues = hasUnknownIssues
      ? null
      : normalizedRepositories.reduce((sum, r) => sum + (r.attentionIssueCount ?? 0), 0);

    const attentionIssuesHasMore = normalizedRepositories.some((r) => r.attentionIssueHasMore);

    return {
      failingCi,
      openPullRequests,
      attentionIssues,
      attentionIssuesHasMore,
    };
  }

  private computeFreshness(
    normalizedRepositories: readonly NormalizedRepositoryResult[],
  ): GitHubFreshness {
    if (normalizedRepositories.some((r) => r.freshness === 'unavailable')) {
      return normalizedRepositories.every((r) => r.freshness === 'unavailable')
        ? 'unavailable'
        : 'partial';
    } else if (normalizedRepositories.some((r) => r.freshness === 'stale')) {
      return 'stale';
    } else if (normalizedRepositories.some((r) => r.freshness === 'partial')) {
      return 'partial';
    }
    return 'fresh';
  }

  async isRepositoryConfigured(owner: string, repo: string): Promise<boolean> {
    const targetKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const projects = await this.store.listProjects({ configuredOnly: true });
    return projects.some((p) =>
      p.repositories.some((r) => `${r.owner.toLowerCase()}/${r.name.toLowerCase()}` === targetKey),
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.logger?.info('projects.service.starting', {
      metadata: {
        projectsCount: this.projectConfig.projects.length,
        refreshIntervalMs: this.refreshIntervalMs,
      },
    });

    // 1. Reconcile configured projects into store
    await this.store.reconcileProjects(this.projectConfig.projects);

    // 2. Initial probe & refresh
    await this.adapter.probe();
    await this.refresh();

    // 3. Start background refresh schedule
    if (!this.stopped && this.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh();
      }, this.refreshIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.logger?.info('projects.service.stopped');
  }

  async refreshRepository(owner: string, repo: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    const targetKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const projects = await this.store.listProjects({ configuredOnly: true });
    const matchingProjects = projects.filter((p) =>
      p.repositories.some((r) => `${r.owner.toLowerCase()}/${r.name.toLowerCase()}` === targetKey),
    );

    if (matchingProjects.length === 0) {
      return;
    }

    // Check rate limit
    const rateLimit = await this.adapter.getRateLimit();
    if (rateLimit && rateLimit.remaining === 0) {
      const resetTime = Date.parse(rateLimit.resetAt);
      if (resetTime > Date.now()) {
        this.logger?.warn('projects.targeted_refresh.rate_limited', {
          metadata: { repository: `${owner}/${repo}`, resetAt: rateLimit.resetAt },
        });
        return;
      }
    }

    // Cache collection promise across projects with the same attention labels to avoid duplicate GitHub API calls
    const collectionCache = new Map<string, Promise<NormalizedRepositoryResult>>();

    for (const project of matchingProjects) {
      if (this.stopped) break;

      await this.withProjectLock(project.id, async () => {
        const previousSnapshot = await this.store.getLatestGitHubSnapshot(project.id);
        const previousRepoMap = new Map<string, NormalizedRepositoryResult>();
        if (previousSnapshot) {
          for (const r of previousSnapshot.data.repositories) {
            previousRepoMap.set(`${r.owner.toLowerCase()}/${r.name.toLowerCase()}`, r);
          }
        }

        const targetRepoConfig = project.repositories.find(
          (r) => `${r.owner.toLowerCase()}/${r.name.toLowerCase()}` === targetKey,
        )!;

        const labelsKey = [...project.attentionLabels].sort().join(',');
        let collectionPromise = collectionCache.get(labelsKey);
        if (!collectionPromise) {
          collectionPromise = this.adapter.collectRepository(
            {
              owner: targetRepoConfig.owner,
              name: targetRepoConfig.name,
              primary: targetRepoConfig.primary,
              attentionLabels: project.attentionLabels,
            },
            previousRepoMap.get(targetKey),
          );
          collectionCache.set(labelsKey, collectionPromise);
        }

        let updatedResult: NormalizedRepositoryResult;
        try {
          updatedResult = await collectionPromise;
        } catch (error) {
          this.logger?.warn('projects.repository.collection_failed', {
            metadata: {
              projectId: project.id,
              owner: targetRepoConfig.owner,
              name: targetRepoConfig.name,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          });
          const previousResult = previousRepoMap.get(targetKey);
          updatedResult = previousResult
            ? { ...previousResult, freshness: 'stale' }
            : {
                owner: targetRepoConfig.owner,
                name: targetRepoConfig.name,
                primary: targetRepoConfig.primary,
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
                attentionIssueHasMore: false,
                freshness: 'unavailable',
              };
        }

        const finalRepoResult: NormalizedRepositoryResult = {
          ...updatedResult,
          primary: targetRepoConfig.primary,
        };

        const normalizedRepositories: NormalizedRepositoryResult[] = project.repositories.map(
          (repoConfig) => {
            const key = `${repoConfig.owner.toLowerCase()}/${repoConfig.name.toLowerCase()}`;
            if (key === targetKey) {
              return finalRepoResult;
            }
            return (
              previousRepoMap.get(key) ?? {
                owner: repoConfig.owner,
                name: repoConfig.name,
                primary: repoConfig.primary,
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
                attentionIssueHasMore: false,
                freshness: 'unavailable',
              }
            );
          },
        );

        const attention = this.computeAttention(normalizedRepositories);
        const overallFreshness = this.computeFreshness(normalizedRepositories);

        const snapshotRecord: PersistedGitHubSnapshot = {
          id: randomUUID(),
          projectId: project.id,
          collectedAt: new Date().toISOString(),
          freshness: overallFreshness,
          data: {
            repositories: normalizedRepositories,
            attention,
          },
          createdAt: new Date().toISOString(),
        };

        await this.store.saveGitHubSnapshot(snapshotRecord);
      });
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) {
      return;
    }
    this.refreshing = true;

    try {
      const probeHealth = await this.adapter.probe();
      if (!probeHealth.configured) {
        this.logger?.debug('projects.refresh.skipped', {
          metadata: { reason: 'GitHub integration not configured' },
        });
        return;
      }

      // Check if rate limited
      const rateLimit = await this.adapter.getRateLimit();
      if (rateLimit && rateLimit.remaining === 0) {
        const resetTime = Date.parse(rateLimit.resetAt);
        if (resetTime > Date.now()) {
          this.logger?.warn('projects.refresh.rate_limited', {
            metadata: { resetAt: rateLimit.resetAt },
          });
          return;
        }
      }

      const projects = await this.store.listProjects({ configuredOnly: true });

      for (const project of projects) {
        if (this.stopped) break;

        await this.withProjectLock(project.id, async () => {
          const previousSnapshot = await this.store.getLatestGitHubSnapshot(project.id);
          const previousRepoMap = new Map<string, NormalizedRepositoryResult>();
          if (previousSnapshot) {
            for (const repo of previousSnapshot.data.repositories) {
              previousRepoMap.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
            }
          }

          const normalizedRepositories: NormalizedRepositoryResult[] = [];

          for (const repo of project.repositories) {
            const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
            const previousResult = previousRepoMap.get(key);

            try {
              const result = await this.adapter.collectRepository(
                {
                  owner: repo.owner,
                  name: repo.name,
                  primary: repo.primary,
                  attentionLabels: project.attentionLabels,
                },
                previousResult,
              );
              normalizedRepositories.push(result);
            } catch (error) {
              this.logger?.warn('projects.repository.collection_failed', {
                metadata: {
                  projectId: project.id,
                  owner: repo.owner,
                  name: repo.name,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
              });
              if (previousResult) {
                normalizedRepositories.push({
                  ...previousResult,
                  freshness: 'stale',
                });
              } else {
                normalizedRepositories.push({
                  owner: repo.owner,
                  name: repo.name,
                  primary: repo.primary,
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
                  attentionIssueHasMore: false,
                  freshness: 'unavailable',
                });
              }
            }
          }

          const attention = this.computeAttention(normalizedRepositories);
          const overallFreshness = this.computeFreshness(normalizedRepositories);

          const snapshotRecord: PersistedGitHubSnapshot = {
            id: randomUUID(),
            projectId: project.id,
            collectedAt: new Date().toISOString(),
            freshness: overallFreshness,
            data: {
              repositories: normalizedRepositories,
              attention,
            },
            createdAt: new Date().toISOString(),
          };

          await this.store.saveGitHubSnapshot(snapshotRecord);
        });
      }

      this.lastRefreshedAt = new Date().toISOString();
    } finally {
      this.refreshing = false;
    }
  }

  async list(): Promise<ProjectsResponse> {
    const projects = await this.store.listProjects({ configuredOnly: true });
    const sourceHealth = this.adapter.getHealth();

    const summaries: ProjectSummary[] = [];

    for (const project of projects) {
      const snapshot = await this.store.getLatestGitHubSnapshot(project.id);
      summaries.push(this.buildProjectSummary(project, snapshot, sourceHealth));
    }

    return {
      projects: summaries,
      sourceHealth,
      generatedAt: new Date().toISOString(),
    };
  }

  async get(projectId: string): Promise<ProjectDetailResponse | null> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      return null;
    }

    const sourceHealth = this.adapter.getHealth();
    const snapshot = await this.store.getLatestGitHubSnapshot(project.id);
    const summary = this.buildProjectSummary(project, snapshot, sourceHealth);

    const primaryRepoData =
      snapshot?.data.repositories.find((r) => r.primary) ?? snapshot?.data.repositories[0];

    const openPullRequests = primaryRepoData ? [...primaryRepoData.openPullRequests] : [];
    const attentionIssues = primaryRepoData ? [...primaryRepoData.attentionIssues] : [];

    const latestCi =
      primaryRepoData?.latestCi ??
      (primaryRepoData
        ? {
            status: primaryRepoData.ciState,
            conclusion: null,
          }
        : null);

    const detail: ProjectDetail = {
      ...summary,
      attentionLabels: [...project.attentionLabels],
      openPullRequests,
      attentionIssues,
      latestCi,
    };

    return {
      project: detail,
      sourceHealth,
      generatedAt: new Date().toISOString(),
    };
  }

  private buildProjectSummary(
    project: PersistedProject,
    snapshot: PersistedGitHubSnapshot | null,
    sourceHealth: GitHubSourceHealth,
  ): ProjectSummary {
    const repoSummaries: ProjectRepositorySummary[] = project.repositories.map((repoConfig) => {
      const repoData = snapshot?.data.repositories.find(
        (r) =>
          r.owner.toLowerCase() === repoConfig.owner.toLowerCase() &&
          r.name.toLowerCase() === repoConfig.name.toLowerCase(),
      );

      const freshness: GitHubFreshness = !sourceHealth.configured
        ? 'unavailable'
        : (repoData?.freshness ?? 'unavailable');

      return {
        owner: repoConfig.owner,
        name: repoConfig.name,
        primary: repoConfig.primary,
        snapshot: repoData?.snapshot ?? null,
        ciState: repoData?.ciState ?? ('unknown' as CiState),
        latestCi: repoData?.latestCi ?? null,
        openPrCount: repoData ? repoData.openPrCount : null,
        openPrHasMore: repoData?.openPrHasMore ?? false,
        openIssueCount: repoData ? repoData.openIssueCount : null,
        openIssueHasMore: repoData?.openIssueHasMore ?? false,
        attentionIssueCount: repoData ? repoData.attentionIssueCount : null,
        attentionIssueHasMore: repoData?.attentionIssueHasMore ?? false,
        freshness,
        error: repoData?.error ?? null,
      };
    });

    const primaryRepository = repoSummaries.find((r) => r.primary) ?? repoSummaries[0] ?? null;

    const attention: ProjectAttentionSummary = snapshot?.data.attention ?? {
      failingCi: null,
      openPullRequests: null,
      attentionIssues: null,
      attentionIssuesHasMore: false,
    };

    const freshness: GitHubFreshness = !sourceHealth.configured
      ? 'unavailable'
      : (snapshot?.freshness ?? 'unavailable');

    return {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      configured: project.configured,
      repositories: repoSummaries,
      primaryRepository,
      attention,
      freshness,
      lastFetchedAt: snapshot?.collectedAt ?? null,
    };
  }
}

export interface ProjectsRuntimeEnvironment {
  readonly [key: string]: string | undefined;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_INSTALLATION_ID?: string;
  readonly GITHUB_PRIVATE_KEY?: string;
  readonly GITHUB_REFRESH_INTERVAL_MS?: string;
  readonly SONORAN_PROJECTS_PATH?: string;
  readonly DATABASE_URL?: string;
}

export interface ProjectsRuntimeOptions {
  readonly environment: ProjectsRuntimeEnvironment;
  readonly config: AppConfig;
  readonly logger?: StructuredLogger;
  readonly store?: ProjectStore;
  readonly source?: GitHubProjectSource;
  readonly pool?: Pool;
}

export interface ProjectsRuntime {
  readonly service: ProjectService;
  readonly store: ProjectStore;
  readonly adapter: GitHubAdapter;
  start(): Promise<void>;
  stop(): void;
}

export function createProjectsRuntime(options: ProjectsRuntimeOptions): ProjectsRuntime {
  const logger =
    options.logger ??
    createStructuredLogger({
      serviceName: options.config.serviceName,
      level: options.config.logLevel,
    });

  const projectConfig = loadProjectConfig({
    environment: options.environment,
  });

  let source = options.source;
  if (!source) {
    const appId = options.environment.GITHUB_APP_ID?.trim();
    const installationId = options.environment.GITHUB_INSTALLATION_ID?.trim();
    const privateKey = options.environment.GITHUB_PRIVATE_KEY?.trim();

    if (appId && installationId && privateKey) {
      try {
        source = new GitHubAppProjectSource({
          appId,
          installationId,
          privateKey,
        });
      } catch (error) {
        logger.error('projects.github_source.init_failed', {
          metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
        source = new UnconfiguredGitHubProjectSource();
      }
    } else {
      source = new UnconfiguredGitHubProjectSource();
    }
  }

  const adapter = new GitHubAdapter(source);

  let store = options.store;
  if (!store && options.pool) {
    store = new PostgresProjectStore(options.pool);
  }
  if (!store) {
    store = new InMemoryProjectStore();
  }

  const intervalMs = parseRefreshInterval(options.environment.GITHUB_REFRESH_INTERVAL_MS);

  const service = new ProjectService({
    store,
    adapter,
    projectConfig,
    refreshIntervalMs: intervalMs,
    logger,
  });

  return {
    service,
    store,
    adapter,
    async start() {
      await service.start();
    },
    stop() {
      service.stop();
    },
  };
}

function parseRefreshInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_GITHUB_REFRESH_INTERVAL_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('GITHUB_REFRESH_INTERVAL_MS must be a positive integer');
  }
  return parsed;
}
