import { z } from 'zod';

/** Increment only when the wire message contract changes incompatibly. */
export const AGENT_PROTOCOL_VERSION = 2 as const;

const boundedString = (max: number) => z.string().min(1).max(max);
const machineIdSchema = boundedString(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'machine ID contains unsupported characters',
);
const capabilityIdSchema = boundedString(100).regex(
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
  'capability contains unsupported characters',
);
const actionTargetIdSchema = boundedString(64).regex(
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
  'action target ID contains unsupported characters',
);
const actionLabelSchema = boundedString(100);
const timestampSchema = z.string().datetime({ offset: true });
const nonNegativeInteger = z.number().int().finite().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

export const machinePlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'unknown',
]);
export type MachinePlatform = z.infer<typeof machinePlatformSchema>;

export const machineArchitectureSchema = z.enum([
  'arm',
  'arm64',
  'ia32',
  'mips',
  'mipsel',
  'ppc',
  'ppc64',
  'riscv64',
  's390',
  's390x',
  'x32',
  'x64',
  'unknown',
]);
export type MachineArchitecture = z.infer<typeof machineArchitectureSchema>;

export const machineCapabilitySchema = capabilityIdSchema;

export type MachineCapability = z.infer<typeof machineCapabilitySchema>;

export const repositoryActionTargetSchema = z
  .object({ id: actionTargetIdSchema, label: actionLabelSchema })
  .strict();
export type RepositoryActionTarget = z.infer<typeof repositoryActionTargetSchema>;

export const serviceActionTargetSchema = z
  .object({ id: actionTargetIdSchema, label: actionLabelSchema })
  .strict();
export type ServiceActionTarget = z.infer<typeof serviceActionTargetSchema>;

export const machineActionCatalogSchema = z
  .object({
    repositories: z.array(repositoryActionTargetSchema).max(64),
    services: z.array(serviceActionTargetSchema).max(64),
  })
  .strict();
export type MachineActionCatalog = z.infer<typeof machineActionCatalogSchema>;

export const machineIdentitySchema = z
  .object({
    id: machineIdSchema,
    name: boundedString(100),
    platform: machinePlatformSchema,
    arch: machineArchitectureSchema,
  })
  .strict();

export type MachineIdentity = z.infer<typeof machineIdentitySchema>;

const machineDiskSchema = z
  .object({
    id: boundedString(128),
    usedBytes: nonNegativeInteger,
    totalBytes: nonNegativeInteger,
  })
  .strict()
  .superRefine((disk, context) => {
    if (disk.usedBytes > disk.totalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['usedBytes'],
        message: 'usedBytes exceeds totalBytes',
      });
    }
  });

const machineGpuSchema = z
  .object({
    id: boundedString(128),
    utilizationPercent: z.number().finite().min(0).max(100).optional(),
    memoryUsedBytes: nonNegativeInteger.optional(),
    memoryTotalBytes: nonNegativeInteger.optional(),
    temperatureC: z.number().finite().min(-100).max(250).optional(),
  })
  .strict()
  .superRefine((gpu, context) => {
    if (
      gpu.memoryUsedBytes !== undefined &&
      gpu.memoryTotalBytes !== undefined &&
      gpu.memoryUsedBytes > gpu.memoryTotalBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['memoryUsedBytes'],
        message: 'memoryUsedBytes exceeds memoryTotalBytes',
      });
    }
  });

export const machineTelemetrySchema = z
  .object({
    capturedAt: timestampSchema,
    uptimeSeconds: nonNegativeNumber,
    cpuPercent: z.number().finite().min(0).max(100).optional(),
    memoryUsedBytes: nonNegativeInteger.optional(),
    memoryTotalBytes: nonNegativeInteger.optional(),
    disks: z.array(machineDiskSchema).max(32),
    gpu: z.array(machineGpuSchema).max(16).optional(),
  })
  .strict()
  .superRefine((telemetry, context) => {
    if (
      telemetry.memoryUsedBytes !== undefined &&
      telemetry.memoryTotalBytes !== undefined &&
      telemetry.memoryUsedBytes > telemetry.memoryTotalBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['memoryUsedBytes'],
        message: 'memoryUsedBytes exceeds memoryTotalBytes',
      });
    }
  });

export type MachineTelemetry = z.infer<typeof machineTelemetrySchema>;

export const agentHelloSchema = z
  .object({
    type: z.literal('agent.hello'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    agentVersion: boundedString(64),
    machine: machineIdentitySchema,
    capabilities: z.array(machineCapabilitySchema).max(64),
    policyRevision: boundedString(128),
    actionCatalog: machineActionCatalogSchema,
  })
  .strict();

export type AgentHello = z.infer<typeof agentHelloSchema>;

export const agentHelloAcceptedSchema = z
  .object({
    type: z.literal('agent.hello.accepted'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    serverTime: timestampSchema,
    heartbeatIntervalMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

export type AgentHelloAccepted = z.infer<typeof agentHelloAcceptedSchema>;

export const agentHeartbeatSchema = z
  .object({
    type: z.literal('agent.heartbeat'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    sequence: z.number().int().finite().min(1).max(Number.MAX_SAFE_INTEGER),
    sentAt: timestampSchema,
    telemetry: machineTelemetrySchema,
  })
  .strict();

export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;

export const agentProtocolErrorSchema = z
  .object({
    type: z.literal('agent.protocol.error'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    code: z.enum([
      'invalid_message',
      'message_too_large',
      'unsupported_protocol',
      'authentication_failed',
      'hello_required',
      'duplicate_hello',
      'invalid_identity',
      'invalid_telemetry',
      'non_monotonic_sequence',
      'unknown_action',
      'invalid_action_transition',
    ]),
    message: boundedString(300),
  })
  .strict();

export type AgentProtocolError = z.infer<typeof agentProtocolErrorSchema>;

export const agentActionKindSchema = z.enum(['repo.status', 'service.restart']);
export type AgentActionKind = z.infer<typeof agentActionKindSchema>;

export const repositoryStatusActionSchema = z
  .object({ kind: z.literal('repo.status'), targetId: actionTargetIdSchema })
  .strict();
export type RepositoryStatusAction = z.infer<typeof repositoryStatusActionSchema>;

export const serviceRestartActionSchema = z
  .object({ kind: z.literal('service.restart'), targetId: actionTargetIdSchema })
  .strict();
export type ServiceRestartAction = z.infer<typeof serviceRestartActionSchema>;

export const machineActionInputSchema = z.discriminatedUnion('kind', [
  repositoryStatusActionSchema,
  serviceRestartActionSchema,
]);
export type MachineActionInput = z.infer<typeof machineActionInputSchema>;

const actionIdSchema = z.string().uuid();
const policyRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const agentActionRequestSchema = z
  .object({
    type: z.literal('agent.action.request'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    actionId: actionIdSchema,
    policyRevision: policyRevisionSchema,
    deadlineAt: timestampSchema,
    action: machineActionInputSchema,
  })
  .strict();
export type AgentActionRequest = z.infer<typeof agentActionRequestSchema>;

export const agentActionAcceptedSchema = z
  .object({
    type: z.literal('agent.action.accepted'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    actionId: actionIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();
export type AgentActionAccepted = z.infer<typeof agentActionAcceptedSchema>;

export const repoStatusResultSchema = z
  .object({
    kind: z.literal('repo.status'),
    targetId: actionTargetIdSchema,
    branch: boundedString(256).optional(),
    detached: z.boolean(),
    dirty: z.boolean(),
    ahead: nonNegativeInteger,
    behind: nonNegativeInteger,
    staged: nonNegativeInteger,
    unstaged: nonNegativeInteger,
    untracked: nonNegativeInteger,
    headSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict();
export type RepoStatusResult = z.infer<typeof repoStatusResultSchema>;

export const serviceRestartResultSchema = z
  .object({
    kind: z.literal('service.restart'),
    targetId: actionTargetIdSchema,
    active: z.boolean(),
  })
  .strict();
export type ServiceRestartResult = z.infer<typeof serviceRestartResultSchema>;

export const agentActionResultStatusSchema = z.enum(['succeeded', 'denied', 'failed', 'timed_out']);
export type AgentActionResultStatus = z.infer<typeof agentActionResultStatusSchema>;

export const actionDenialReasonSchema = z.enum([
  'target_not_allowed',
  'capability_not_granted',
  'policy_changed',
  'expired',
  'busy',
  'duplicate_action',
  'unsupported_action',
]);
export type ActionDenialReason = z.infer<typeof actionDenialReasonSchema>;

export const actionErrorCodeSchema = z.enum([
  'git_failed',
  'service_restart_failed',
  'service_not_active',
  'process_timeout',
  'process_start_failed',
]);
export type ActionErrorCode = z.infer<typeof actionErrorCodeSchema>;

export const actionErrorSchema = z
  .object({
    code: z.union([actionDenialReasonSchema, actionErrorCodeSchema]),
    message: boundedString(300),
  })
  .strict();
export type ActionError = z.infer<typeof actionErrorSchema>;

export const agentActionResultSchema = z
  .object({
    type: z.literal('agent.action.result'),
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    actionId: actionIdSchema,
    kind: agentActionKindSchema,
    targetId: actionTargetIdSchema,
    policyRevision: policyRevisionSchema,
    status: agentActionResultStatusSchema,
    completedAt: timestampSchema,
    result: z.union([repoStatusResultSchema, serviceRestartResultSchema]).optional(),
    error: actionErrorSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'succeeded' && result.result === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'successful actions require a result',
      });
    }
    if (result.status !== 'succeeded' && result.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'non-successful actions require an error',
      });
    }
    if (
      result.result &&
      (result.result.kind !== result.kind || result.result.targetId !== result.targetId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'result does not match the action',
      });
    }
  });
export type AgentActionResult = z.infer<typeof agentActionResultSchema>;

export const agentClientMessageSchema = z.discriminatedUnion('type', [
  agentHelloSchema,
  agentHeartbeatSchema,
  agentActionAcceptedSchema,
  agentActionResultSchema,
]);

export const agentServerMessageSchema = z.discriminatedUnion('type', [
  agentHelloAcceptedSchema,
  agentProtocolErrorSchema,
  agentActionRequestSchema,
]);

export type AgentClientMessage = z.infer<typeof agentClientMessageSchema>;
export type AgentServerMessage = z.infer<typeof agentServerMessageSchema>;

export const machineActionStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'DENIED',
  'FAILED',
  'TIMED_OUT',
  'INTERRUPTED',
]);
export type MachineActionStatus = z.infer<typeof machineActionStatusSchema>;

export const machineActionRecordSchema = z
  .object({
    actionId: actionIdSchema,
    machineId: machineIdSchema,
    kind: agentActionKindSchema,
    targetId: actionTargetIdSchema,
    status: machineActionStatusSchema,
    policyRevision: policyRevisionSchema,
    requestedAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    result: z.union([repoStatusResultSchema, serviceRestartResultSchema]).optional(),
    error: actionErrorSchema.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.status === 'SUCCEEDED' && action.result === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'successful actions require a result',
      });
    }
    if (['DENIED', 'FAILED', 'TIMED_OUT'].includes(action.status) && action.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'failed actions require an error',
      });
    }
    if (
      action.result &&
      (action.result.kind !== action.kind || action.result.targetId !== action.targetId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'result does not match the action',
      });
    }
  });
export type MachineActionRecord = z.infer<typeof machineActionRecordSchema>;

export const machineActionResponseSchema = machineActionRecordSchema;
export const machineActionsResponseSchema = z
  .object({ actions: z.array(machineActionRecordSchema).max(256) })
  .strict();
export type MachineActionsResponse = z.infer<typeof machineActionsResponseSchema>;

export const machineConnectionStatusSchema = z.enum(['ONLINE', 'STALE', 'OFFLINE']);
export type MachineConnectionStatus = z.infer<typeof machineConnectionStatusSchema>;

export const machineProtocolVersionSchema = z.number().int().positive().max(1000);

export const machineSummarySchema = z
  .object({
    identity: machineIdentitySchema,
    protocolVersion: machineProtocolVersionSchema,
    agentVersion: boundedString(64),
    capabilities: z.array(machineCapabilitySchema).max(64),
    policyRevision: boundedString(128),
    actionCatalog: machineActionCatalogSchema,
    status: machineConnectionStatusSchema,
    lastSeenAt: timestampSchema,
    telemetry: machineTelemetrySchema.nullable(),
  })
  .strict();

export type MachineSummary = z.infer<typeof machineSummarySchema>;

export const machinesResponseSchema = z
  .object({ machines: z.array(machineSummarySchema) })
  .strict();
export type MachinesResponse = z.infer<typeof machinesResponseSchema>;

export const AGENT_MAX_MESSAGE_BYTES = 64 * 1024;
export const AGENT_HEARTBEAT_INTERVAL_MS = 15_000;
