/* global console, process */

import {
  GitHubAdapter,
  GitHubAppProjectSource,
} from '../packages/github/dist/index.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env might not exist
  }
}

const appId = process.env.GITHUB_APP_ID?.trim();
const installationId = process.env.GITHUB_INSTALLATION_ID?.trim();
const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();


if (!appId || !installationId || !privateKey) {

  console.log(
    JSON.stringify({
      smoke: 'github',
      status: 'SKIPPED',
      reason: 'GITHUB_APP_ID, GITHUB_INSTALLATION_ID, or GITHUB_PRIVATE_KEY not set in environment',
    }),
  );
  process.exit(0);
}

try {
  const source = new GitHubAppProjectSource({
    appId,
    installationId,
    privateKey,
  });

  const adapter = new GitHubAdapter(source);
  const probe = await adapter.probe();

  if (!probe.available) {
    console.log(
      JSON.stringify({
        smoke: 'github',
        status: 'FAILED',
        error: probe.lastError ?? 'GitHub probe failed',
      }),
    );
    process.exit(1);
  }

  const repoResult = await adapter.collectRepository({
    owner: 'Sonoran-Solutions',
    name: 'SonoranHub',
    primary: true,
    attentionLabels: ['bug', 'blocked', 'priority'],
  });

  console.log(
    JSON.stringify({
      smoke: 'github',
      status: 'SUCCEEDED',
      repository: `${repoResult.owner}/${repoResult.name}`,
      defaultBranch: repoResult.snapshot?.defaultBranch ?? 'unknown',
      openPrCount: repoResult.openPrCount,
      openIssueCount: repoResult.openIssueCount,
      attentionIssueCount: repoResult.attentionIssueCount,
      ciState: repoResult.ciState,
      fetchedAt: new Date().toISOString(),
      freshness: repoResult.freshness,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      smoke: 'github',
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown error during smoke test',
    }),
  );
  process.exit(1);
}
