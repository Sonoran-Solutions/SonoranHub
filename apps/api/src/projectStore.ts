import type { Pool } from 'pg';

import type {
  GitHubFreshness,
  ProjectAttentionSummary,
  ProjectConfig,
  ProjectRepositoryConfig,
} from '@sonoran-hub/contracts';
import type { NormalizedRepositoryResult } from '@sonoran-hub/github';

export interface PersistedProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly attentionLabels: readonly string[];
  readonly configured: boolean;
  readonly repositories: readonly ProjectRepositoryConfig[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedGitHubSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly collectedAt: string;
  readonly freshness: GitHubFreshness;
  readonly data: {
    readonly repositories: readonly NormalizedRepositoryResult[];
    readonly attention: ProjectAttentionSummary;
  };
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
}

export interface ProjectStore {
  reconcileProjects(configuredProjects: readonly ProjectConfig[]): Promise<void>;
  getProject(projectId: string): Promise<PersistedProject | null>;
  listProjects(options?: { configuredOnly?: boolean }): Promise<readonly PersistedProject[]>;
  saveGitHubSnapshot(snapshot: PersistedGitHubSnapshot): Promise<void>;
  getLatestGitHubSnapshot(projectId: string): Promise<PersistedGitHubSnapshot | null>;
}

export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, PersistedProject>();
  private readonly snapshots = new Map<string, PersistedGitHubSnapshot[]>();

  async reconcileProjects(configuredProjects: readonly ProjectConfig[]): Promise<void> {
    const configuredIdSet = new Set(configuredProjects.map((p) => p.id));
    const now = new Date().toISOString();

    // Mark missing projects as configured = false
    for (const [id, project] of this.projects.entries()) {
      if (!configuredIdSet.has(id) && project.configured) {
        this.projects.set(id, {
          ...project,
          configured: false,
          updatedAt: now,
        });
      }
    }

    // Upsert configured projects
    for (const config of configuredProjects) {
      const existing = this.projects.get(config.id);
      this.projects.set(config.id, {
        id: config.id,
        name: config.name,
        description: config.description ?? null,
        attentionLabels: config.attentionLabels ?? [],
        configured: true,
        repositories: config.repositories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }

  async getProject(projectId: string): Promise<PersistedProject | null> {
    return this.projects.get(projectId) ?? null;
  }

  async listProjects(
    options: { configuredOnly?: boolean } = {},
  ): Promise<readonly PersistedProject[]> {
    const all = Array.from(this.projects.values());
    const filtered = options.configuredOnly !== false ? all.filter((p) => p.configured) : all;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveGitHubSnapshot(snapshot: PersistedGitHubSnapshot): Promise<void> {
    const list = this.snapshots.get(snapshot.projectId) ?? [];
    list.unshift(snapshot);
    // Keep bounded history in memory
    if (list.length > 50) {
      list.length = 50;
    }
    this.snapshots.set(snapshot.projectId, list);
  }

  async getLatestGitHubSnapshot(projectId: string): Promise<PersistedGitHubSnapshot | null> {
    const list = this.snapshots.get(projectId);
    return list?.[0] ?? null;
  }
}

export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly pool: Pool) {}

  async reconcileProjects(configuredProjects: readonly ProjectConfig[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const configuredIds = configuredProjects.map((p) => p.id);

      // 1. Mark missing projects as unconfigured
      if (configuredIds.length > 0) {
        await client.query(
          `UPDATE projects
           SET configured = false, updated_at = now()
           WHERE configured = true AND NOT (id = ANY($1::text[]))`,
          [configuredIds],
        );
      } else {
        await client.query(
          `UPDATE projects SET configured = false, updated_at = now() WHERE configured = true`,
        );
      }

      // 2. Upsert configured projects & their repositories
      for (const config of configuredProjects) {
        await client.query(
          `INSERT INTO projects (id, name, description, attention_labels, configured, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, true, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             attention_labels = EXCLUDED.attention_labels,
             configured = true,
             updated_at = now()`,
          [
            config.id,
            config.name,
            config.description ?? null,
            JSON.stringify(config.attentionLabels ?? []),
          ],
        );

        // Delete removed repos for this project
        await client.query('DELETE FROM project_repositories WHERE project_id = $1', [config.id]);

        // Insert current repositories
        for (const repo of config.repositories) {
          await client.query(
            `INSERT INTO project_repositories (project_id, owner, name, is_primary)
             VALUES ($1, $2, $3, $4)`,
            [config.id, repo.owner, repo.name, repo.primary],
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProject(projectId: string): Promise<PersistedProject | null> {
    const projectResult = await this.pool.query(
      `SELECT id, name, description, attention_labels, configured, created_at, updated_at
       FROM projects
       WHERE id = $1`,
      [projectId],
    );

    if (projectResult.rowCount === 0) {
      return null;
    }

    const row = projectResult.rows[0];
    const repoResult = await this.pool.query(
      `SELECT owner, name, is_primary
       FROM project_repositories
       WHERE project_id = $1
       ORDER BY is_primary DESC, name ASC`,
      [projectId],
    );

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      attentionLabels: row.attention_labels ?? [],
      configured: row.configured,
      repositories: repoResult.rows.map((r) => ({
        owner: r.owner,
        name: r.name,
        primary: r.is_primary,
      })),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listProjects(
    options: { configuredOnly?: boolean } = {},
  ): Promise<readonly PersistedProject[]> {
    const filterSql = options.configuredOnly !== false ? 'WHERE configured = true' : '';
    const projectsResult = await this.pool.query(
      `SELECT id, name, description, attention_labels, configured, created_at, updated_at
       FROM projects
       ${filterSql}
       ORDER BY name ASC, id ASC`,
    );

    if (projectsResult.rowCount === 0) {
      return [];
    }

    const reposResult = await this.pool.query(
      `SELECT project_id, owner, name, is_primary
       FROM project_repositories
       ORDER BY is_primary DESC, name ASC`,
    );

    const reposByProjectId = new Map<string, ProjectRepositoryConfig[]>();
    for (const r of reposResult.rows) {
      const list = reposByProjectId.get(r.project_id) ?? [];
      list.push({
        owner: r.owner,
        name: r.name,
        primary: r.is_primary,
      });
      reposByProjectId.set(r.project_id, list);
    }

    return projectsResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      attentionLabels: row.attention_labels ?? [],
      configured: row.configured,
      repositories: reposByProjectId.get(row.id) ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async saveGitHubSnapshot(snapshot: PersistedGitHubSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_github_snapshots (id, project_id, collected_at, freshness, data, error)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        snapshot.id,
        snapshot.projectId,
        snapshot.collectedAt,
        snapshot.freshness,
        JSON.stringify(snapshot.data),
        snapshot.error ? JSON.stringify(snapshot.error) : null,
      ],
    );
  }

  async getLatestGitHubSnapshot(projectId: string): Promise<PersistedGitHubSnapshot | null> {
    const result = await this.pool.query(
      `SELECT id, project_id, collected_at, freshness, data, error, created_at
       FROM project_github_snapshots
       WHERE project_id = $1
       ORDER BY collected_at DESC, created_at DESC
       LIMIT 1`,
      [projectId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      projectId: row.project_id,
      collectedAt: row.collected_at.toISOString(),
      freshness: row.freshness,
      data: row.data,
      error: row.error ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
