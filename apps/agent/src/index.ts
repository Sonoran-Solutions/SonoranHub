export const AGENT_VERSION = '0.1.0';

export interface AgentStartupStatus {
  readonly status: 'started';
  readonly service: 'sonoran-agent';
  readonly version: string;
}

export function createStartupStatus(): AgentStartupStatus {
  return {
    status: 'started',
    service: 'sonoran-agent',
    version: AGENT_VERSION,
  };
}

export function startAgent(log: (message: string) => void = console.log): AgentStartupStatus {
  const startupStatus = createStartupStatus();
  log(JSON.stringify(startupStatus));
  return startupStatus;
}

if (process.argv[1]?.endsWith('/index.ts') || process.argv[1]?.endsWith('/index.js')) {
  startAgent();
}
