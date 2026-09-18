import { z } from 'zod';

/** Increment only when the wire message contract changes incompatibly. */
export const AGENT_PROTOCOL_VERSION = 1 as const;

const boundedString = (max: number) => z.string().min(1).max(max);
const machineIdSchema = boundedString(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'machine ID contains unsupported characters',
);
const capabilityIdSchema = boundedString(100).regex(
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
  'capability contains unsupported characters',
);
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
    ]),
    message: boundedString(300),
  })
  .strict();

export type AgentProtocolError = z.infer<typeof agentProtocolErrorSchema>;

export const agentClientMessageSchema = z.discriminatedUnion('type', [
  agentHelloSchema,
  agentHeartbeatSchema,
]);

export const agentServerMessageSchema = z.discriminatedUnion('type', [
  agentHelloAcceptedSchema,
  agentProtocolErrorSchema,
]);

export type AgentClientMessage = z.infer<typeof agentClientMessageSchema>;
export type AgentServerMessage = z.infer<typeof agentServerMessageSchema>;

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
