const GITHUB_URL_PATTERN =
  /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?:[?#].*)?$/;

export function isSafeGitHubUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) {
    return false;
  }
  return GITHUB_URL_PATTERN.test(url);
}

export function sanitizeGitHubUrl(url: string | null | undefined, fallback: string): string {
  if (url && isSafeGitHubUrl(url)) {
    return url;
  }
  return fallback;
}

export function buildGitHubRepoUrl(owner: string, name: string): string {
  const cleanOwner = encodeURIComponent(owner);
  const cleanName = encodeURIComponent(name);
  return `https://github.com/${cleanOwner}/${cleanName}`;
}

export function buildGitHubPullUrl(owner: string, name: string, number: number): string {
  const cleanOwner = encodeURIComponent(owner);
  const cleanName = encodeURIComponent(name);
  return `https://github.com/${cleanOwner}/${cleanName}/pull/${number}`;
}

export function buildGitHubIssueUrl(owner: string, name: string, number: number): string {
  const cleanOwner = encodeURIComponent(owner);
  const cleanName = encodeURIComponent(name);
  return `https://github.com/${cleanOwner}/${cleanName}/issues/${number}`;
}

export function buildGitHubRunUrl(owner: string, name: string, runId: number | string): string {
  const cleanOwner = encodeURIComponent(owner);
  const cleanName = encodeURIComponent(name);
  return `https://github.com/${cleanOwner}/${cleanName}/actions/runs/${runId}`;
}
