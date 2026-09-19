import { spawn } from 'node:child_process';

import {
  AGENT_PROTOCOL_VERSION,
  agentActionResultSchema,
  type AgentActionRequest,
  type AgentActionResult,
  type ActionDenialReason,
  type MachineActionInput,
  type MachineCapability,
  type RepoStatusResult,
  type ServiceRestartResult,
} from '@sonoran-hub/contracts';

import { type AgentPolicy, createPolicyRevision, policyCapabilities } from './policy.js';

export const ACTION_TIMEOUTS_MS = {
  'repo.status': 10_000,
  'service.restart': 20_000,
} as const;

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const PROCESS_KILL_GRACE_MS = 250;

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly startError?: Error;
}

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  ): Promise<ProcessResult>;
}

export const defaultProcessRunner: ProcessRunner = {
  run: (executable, args, options) => runProcess(executable, args, options),
};

export interface AgentActionExecutorOptions {
  readonly policy: AgentPolicy;
  readonly gitBin?: string;
  readonly processRunner?: ProcessRunner;
  readonly now?: () => number;
}

export type ActionExecution =
  | { readonly accepted: true; readonly result: Promise<AgentActionResult> }
  | { readonly accepted: false; readonly result: AgentActionResult };

export class AgentActionExecutor {
  private readonly policy: AgentPolicy;
  private readonly capabilities: readonly MachineCapability[];
  private readonly policyRevision: string;
  private readonly gitBin: string;
  private readonly processRunner: ProcessRunner;
  private readonly now: () => number;
  private readonly seenActionIds = new Set<string>();
  private active = false;

  constructor(options: AgentActionExecutorOptions) {
    this.policy = options.policy;
    this.capabilities = policyCapabilities(options.policy);
    this.policyRevision = createPolicyRevision(options.policy, this.capabilities);
    this.gitBin = options.gitBin?.trim() || process.env.SONORAN_AGENT_GIT_BIN?.trim() || 'git';
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.now = options.now ?? Date.now;
  }

  get currentPolicyRevision(): string {
    return this.policyRevision;
  }

  get currentCapabilities(): readonly MachineCapability[] {
    return this.capabilities;
  }

  execute(request: AgentActionRequest): ActionExecution {
    if (this.seenActionIds.has(request.actionId)) {
      return { accepted: false, result: this.denied(request, 'duplicate_action') };
    }
    this.seenActionIds.add(request.actionId);

    if (Date.parse(request.deadlineAt) <= this.now()) {
      return { accepted: false, result: this.denied(request, 'expired') };
    }
    if (request.policyRevision !== this.policyRevision) {
      return { accepted: false, result: this.denied(request, 'policy_changed') };
    }
    const capability =
      request.action.kind === 'repo.status' ? 'repo.read' : 'service.restart.allowed';
    if (!this.capabilities.includes(capability)) {
      return { accepted: false, result: this.denied(request, 'capability_not_granted') };
    }
    const target = this.resolveTarget(request.action);
    if (!target) return { accepted: false, result: this.denied(request, 'target_not_allowed') };
    if (this.active) return { accepted: false, result: this.denied(request, 'busy') };

    this.active = true;
    return {
      accepted: true,
      result: this.runAction(request, target)
        .catch(() => this.failed(request, 'process_start_failed', 'Action process failed'))
        .finally(() => {
          this.active = false;
        }),
    };
  }

  private resolveTarget(
    action: MachineActionInput,
  ): { readonly path: string } | { readonly unit: string } | undefined {
    if (action.kind === 'repo.status') {
      const repository = this.policy.repositories.find(
        (candidate) => candidate.id === action.targetId,
      );
      return repository ? { path: repository.path } : undefined;
    }
    const service = this.policy.services.find((candidate) => candidate.id === action.targetId);
    return service ? { unit: service.unit } : undefined;
  }

  private async runAction(
    request: AgentActionRequest,
    target: { readonly path: string } | { readonly unit: string },
  ): Promise<AgentActionResult> {
    const remainingMs = this.remainingTimeoutMs(request);
    if (remainingMs <= 0) return this.timedOut(request);
    const timeoutMs = Math.min(ACTION_TIMEOUTS_MS[request.action.kind], remainingMs);
    if (request.action.kind === 'repo.status' && 'path' in target) {
      return this.handleRepositoryStatus(request, target.path, timeoutMs);
    }
    if (request.action.kind === 'service.restart' && 'unit' in target) {
      return this.handleServiceRestart(request, target.unit, timeoutMs);
    }
    return this.failed(request, 'process_start_failed', 'Action target could not be resolved');
  }

  private async handleRepositoryStatus(
    request: AgentActionRequest,
    path: string,
    timeoutMs: number,
  ): Promise<AgentActionResult> {
    const process = await this.processRunner.run(
      this.gitBin,
      ['-C', path, 'status', '--porcelain=v2', '--branch'],
      {
        timeoutMs,
        maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      },
    );
    if (process.timedOut) return this.timedOut(request);
    if (process.startError || process.exitCode !== 0) {
      return this.failed(request, 'git_failed', 'Git status could not be completed');
    }
    try {
      const result = parseRepositoryStatus(process.stdout, request.action.targetId);
      return this.succeeded(request, result);
    } catch {
      return this.failed(request, 'git_failed', 'Git status returned an unsupported result');
    }
  }

  private async handleServiceRestart(
    request: AgentActionRequest,
    unit: string,
    timeoutMs: number,
  ): Promise<AgentActionResult> {
    const restart = await this.processRunner.run('systemctl', ['--user', 'restart', unit], {
      timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (restart.timedOut) return this.timedOut(request);
    if (restart.startError || restart.exitCode !== 0) {
      return this.failed(request, 'service_restart_failed', 'User service restart failed');
    }
    const activeTimeoutMs = this.remainingTimeoutMs(request);
    if (activeTimeoutMs <= 0) return this.timedOut(request);
    const active = await this.processRunner.run('systemctl', ['--user', 'is-active', unit], {
      timeoutMs: Math.min(ACTION_TIMEOUTS_MS['service.restart'], activeTimeoutMs),
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (active.timedOut) return this.timedOut(request);
    const isActive = active.exitCode === 0 && active.stdout.trim() === 'active';
    const result: ServiceRestartResult = {
      kind: 'service.restart',
      targetId: request.action.targetId,
      active: isActive,
    };
    if (active.startError || active.exitCode !== 0 || !isActive) {
      return this.failed(request, 'service_not_active', 'User service is not active', result);
    }
    return this.succeeded(request, result);
  }

  private succeeded(
    request: AgentActionRequest,
    result: RepoStatusResult | ServiceRestartResult,
  ): AgentActionResult {
    return agentActionResultSchema.parse({
      ...this.resultBase(request),
      status: 'succeeded',
      result,
    });
  }

  private failed(
    request: AgentActionRequest,
    code: 'git_failed' | 'service_restart_failed' | 'service_not_active' | 'process_start_failed',
    message: string,
    result?: RepoStatusResult | ServiceRestartResult,
  ): AgentActionResult {
    return agentActionResultSchema.parse({
      ...this.resultBase(request),
      status: 'failed',
      ...(result ? { result } : {}),
      error: { code, message },
    });
  }

  private timedOut(request: AgentActionRequest): AgentActionResult {
    return agentActionResultSchema.parse({
      ...this.resultBase(request),
      status: 'timed_out',
      error: { code: 'process_timeout', message: 'Action process timed out' },
    });
  }

  private denied(request: AgentActionRequest, reason: ActionDenialReason): AgentActionResult {
    return agentActionResultSchema.parse({
      ...this.resultBase(request),
      status: 'denied',
      error: { code: reason, message: denialMessage(reason) },
    });
  }

  private resultBase(request: AgentActionRequest) {
    return {
      type: 'agent.action.result' as const,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      actionId: request.actionId,
      kind: request.action.kind,
      targetId: request.action.targetId,
      policyRevision: this.policyRevision,
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  private remainingTimeoutMs(request: AgentActionRequest): number {
    return Date.parse(request.deadlineAt) - this.now();
  }
}

function parseRepositoryStatus(stdout: string, targetId: string): RepoStatusResult {
  let branch: string | undefined;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  let headSha: string | undefined;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      if (/^[a-f0-9]{40,64}$/.test(value)) headSha = value;
    } else if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      detached = value === '(detached)';
      if (!detached && value !== '(unknown)') branch = value;
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith('? ')) {
      untracked += 1;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const status = line.split(' ')[1] ?? '';
      if (status[0] && status[0] !== '.') staged += 1;
      if (status[1] && status[1] !== '.') unstaged += 1;
    } else if (line.startsWith('u ')) {
      staged += 1;
      unstaged += 1;
    }
  }
  return {
    kind: 'repo.status',
    targetId,
    ...(branch ? { branch } : {}),
    detached,
    dirty: staged + unstaged + untracked > 0,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    ...(headSha ? { headSha } : {}),
  };
}

function denialMessage(reason: ActionDenialReason): string {
  return {
    target_not_allowed: 'Target is not allowed by local policy',
    capability_not_granted: 'Action capability is not granted by local policy',
    policy_changed: 'Local policy changed; reconnect the Agent',
    expired: 'Action deadline has expired',
    busy: 'Another action is already running',
    duplicate_action: 'Action ID has already been observed',
    unsupported_action: 'Action is not supported',
  }[reason];
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        startError: error instanceof Error ? error : new Error('process start failed'),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), PROCESS_KILL_GRACE_MS);
      },
      Math.max(1, options.timeoutMs),
    );
    const append = (current: string, chunk: Buffer): string => {
      const remaining = options.maxOutputBytes - Buffer.byteLength(current, 'utf8');
      return remaining > 0 ? current + chunk.subarray(0, remaining).toString('utf8') : current;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, startError: error });
    });
    child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}
