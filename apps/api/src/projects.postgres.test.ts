import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { PostgresProjectStore } from './projectStore.js';

const { Pool } = pg;
const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const pool = hasDatabase ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;

describe.skipIf(!hasDatabase)('PostgresProjectStore', () => {
  let store: PostgresProjectStore;

  beforeAll(async () => {
    await pool?.query(
      'TRUNCATE TABLE project_github_snapshots, project_repositories, projects CASCADE',
    );
    store = new PostgresProjectStore(pool!);
  });

  it('reconciles, reads, and updates project records', async () => {
    const configured = [
      {
        id: 'sonoran-hub',
        name: 'Sonoran Hub',
        description: 'Control plane',
        attentionLabels: ['bug', 'priority'],
        repositories: [{ owner: 'Sonoran-Solutions', name: 'SonoranHub', primary: true }],
      },
      {
        id: 'dualdex',
        name: 'Dualdex',
        description: 'Multi-model explorer',
        attentionLabels: ['investigation'],
        repositories: [{ owner: 'Sonoran-Solutions', name: 'Dualdex', primary: true }],
      },
    ];

    await store.reconcileProjects(configured);

    const list = await store.listProjects();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['dualdex', 'sonoran-hub']);

    const hub = await store.getProject('sonoran-hub');
    expect(hub).not.toBeNull();
    expect(hub!.name).toBe('Sonoran Hub');
    expect(hub!.repositories).toHaveLength(1);
    expect(hub!.repositories[0]!.owner).toBe('Sonoran-Solutions');

    // Reconcile removing dualdex: dualdex should be marked configured = false
    await store.reconcileProjects([configured[0]!]);

    const activeList = await store.listProjects({ configuredOnly: true });
    expect(activeList).toHaveLength(1);
    expect(activeList[0]!.id).toBe('sonoran-hub');

    const fullList = await store.listProjects({ configuredOnly: false });
    expect(fullList).toHaveLength(2);
    const dualdex = fullList.find((p) => p.id === 'dualdex');
    expect(dualdex?.configured).toBe(false);
  });

  it('persists and retrieves normalized GitHub snapshots', async () => {
    const snapshot = {
      id: '11111111-2222-3333-4444-555555555555',
      projectId: 'sonoran-hub',
      collectedAt: new Date().toISOString(),
      freshness: 'fresh' as const,
      data: {
        repositories: [
          {
            owner: 'Sonoran-Solutions',
            name: 'SonoranHub',
            primary: true,
            snapshot: {
              owner: 'Sonoran-Solutions',
              name: 'SonoranHub',
              defaultBranch: 'main',
              isPrivate: false,
              isArchived: false,
              description: 'Control plane',
              primaryLanguage: 'TypeScript',
              updatedAt: new Date().toISOString(),
              pushedAt: new Date().toISOString(),
              url: 'https://github.com/Sonoran-Solutions/SonoranHub',
            },
            ciState: 'success' as const,
            openPullRequests: [],
            attentionIssues: [],
            openPrCount: 0,
            openIssueCount: 0,
            attentionIssueCount: 0,
            freshness: 'fresh' as const,
          },
        ],
        attention: {
          failingCi: 0,
          openPullRequests: 0,
          attentionIssues: 0,
        },
      },
      createdAt: new Date().toISOString(),
    };

    await store.saveGitHubSnapshot(snapshot);
    const loaded = await store.getLatestGitHubSnapshot('sonoran-hub');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(snapshot.id);
    expect(loaded!.freshness).toBe('fresh');
    expect(loaded!.data.repositories[0]!.name).toBe('SonoranHub');
  });

  afterAll(async () => {
    await pool?.end();
  });
});
