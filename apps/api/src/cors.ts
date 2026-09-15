export const DEFAULT_WEB_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'] as const;

export function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_WEB_ORIGINS;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    return DEFAULT_WEB_ORIGINS;
  }

  return [...new Set(origins.map((origin) => parseOrigin(origin)))];
}

function parseOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`WEB_ORIGIN contains an invalid origin: ${origin}`);
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`WEB_ORIGIN must contain HTTP(S) origins only: ${origin}`);
  }

  return parsed.origin;
}
