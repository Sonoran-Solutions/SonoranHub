import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  machineActionCatalogSchema,
  type MachineActionCatalog,
  type MachineCapability,
} from '@sonoran-hub/contracts';
import { z } from 'zod';

const policyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/, 'target ID contains unsupported characters');
const policyLabelSchema = z.string().min(1).max(100);

export const repositoryPolicySchema = z
  .object({
    id: policyIdSchema,
    label: policyLabelSchema,
    path: z.string().min(1).max(1024).refine(isAbsolute, 'repository path must be absolute'),
  })
  .strict();

const systemdUserUnitSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,247}\.service$/, 'unit must be a safe .service name');

export const servicePolicySchema = z
  .object({
    id: policyIdSchema,
    label: policyLabelSchema,
    manager: z.literal('systemd-user'),
    unit: systemdUserUnitSchema,
  })
  .strict();

const policyCapabilitySchema = z.enum(['repo.read', 'service.restart.allowed']);

export const agentPolicySchema = z
  .object({
    repositories: z.array(repositoryPolicySchema).max(64),
    services: z.array(servicePolicySchema).max(64),
    capabilities: z.array(policyCapabilitySchema).max(8).optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [key, targets] of [
      ['repositories', policy.repositories],
      ['services', policy.services],
    ] as const) {
      const ids = new Set<string>();
      for (const [index, target] of targets.entries()) {
        if (ids.has(target.id)) {
          context.addIssue({
            code: 'custom',
            path: [key, index, 'id'],
            message: 'target IDs must be unique within each target type',
          });
        }
        ids.add(target.id);
      }
    }
    if (policy.capabilities && new Set(policy.capabilities).size !== policy.capabilities.length) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'capabilities must be unique',
      });
    }
  });

export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>;
export type ServicePolicy = z.infer<typeof servicePolicySchema>;

export const DEFAULT_POLICY_PATH = join(homedir(), '.sonoran-agent', 'policy.json');

const EMPTY_POLICY: AgentPolicy = { repositories: [], services: [] };

export interface LoadPolicyOptions {
  readonly path?: string;
  readonly explicit?: boolean;
}

export async function loadAgentPolicy(options: LoadPolicyOptions = {}): Promise<AgentPolicy> {
  const path = options.path ?? DEFAULT_POLICY_PATH;
  const explicit = options.explicit ?? options.path !== undefined;
  let contents: string;
  try {
    const metadata = await stat(path);
    if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
      throw new Error('Agent policy file must not be writable by group or others');
    }
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT') && !explicit) return EMPTY_POLICY;
    if (
      error instanceof Error &&
      error.message === 'Agent policy file must not be writable by group or others'
    ) {
      throw error;
    }
    throw new Error('Agent policy file could not be read', { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Agent policy file contains invalid JSON', { cause: error });
  }
  const parsed = agentPolicySchema.safeParse(value);
  if (!parsed.success) throw new Error('Agent policy file failed validation');
  return parsed.data;
}

export function policyCapabilities(policy: AgentPolicy): MachineCapability[] {
  const derived: MachineCapability[] = ['machine.read.telemetry'];
  const configured = new Set(policy.capabilities ?? []);
  if (
    policy.repositories.length > 0 &&
    (policy.capabilities === undefined || configured.has('repo.read'))
  ) {
    derived.push('repo.read');
  }
  if (
    policy.services.length > 0 &&
    (policy.capabilities === undefined || configured.has('service.restart.allowed'))
  ) {
    derived.push('service.restart.allowed');
  }
  return [...new Set(derived)].sort();
}

export function policyCatalog(
  policy: AgentPolicy,
  capabilities = policyCapabilities(policy),
): MachineActionCatalog {
  return machineActionCatalogSchema.parse({
    repositories: capabilities.includes('repo.read')
      ? policy.repositories.map(({ id, label }) => ({ id, label })).sort(byId)
      : [],
    services: capabilities.includes('service.restart.allowed')
      ? policy.services.map(({ id, label }) => ({ id, label })).sort(byId)
      : [],
  });
}

export function createPolicyRevision(
  policy: AgentPolicy,
  capabilities: readonly MachineCapability[] = policyCapabilities(policy),
): string {
  const normalized = {
    capabilities: [...new Set(capabilities)].sort(),
    repositories: [...policy.repositories]
      .map(({ id, label, path }) => ({ id, label, path }))
      .sort(byId),
    services: [...policy.services]
      .map(({ id, label, manager, unit }) => ({ id, label, manager, unit }))
      .sort(byId),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')}`;
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
