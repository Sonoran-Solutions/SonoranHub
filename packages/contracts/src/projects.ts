import { z } from 'zod';

export const projectIdSchema = z
  .string()
  .min(2, 'project ID must be at least 2 characters')
  .max(64, 'project ID must be 64 characters or fewer')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'project ID must use lowercase alphanumeric characters separated by single hyphens',
  );

export const projectOwnerSchema = z
  .string()
  .min(1, 'owner must not be empty')
  .max(39, 'owner must be 39 characters or fewer')
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/, 'owner must be a valid GitHub account name');

export const projectRepoNameSchema = z
  .string()
  .min(1, 'repository name must not be empty')
  .max(100, 'repository name must be 100 characters or fewer')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'repository name contains unsupported characters');

export const projectDisplayNameSchema = z
  .string()
  .min(1, 'project name must not be empty')
  .max(100, 'project name must be 100 characters or fewer');

export const projectDescriptionSchema = z
  .string()
  .max(500, 'project description must be 500 characters or fewer');

export const attentionLabelSchema = z
  .string()
  .min(1, 'attention label must not be empty')
  .max(50, 'attention label must be 50 characters or fewer');

export const projectRepositoryConfigSchema = z
  .object({
    owner: projectOwnerSchema,
    name: projectRepoNameSchema,
    primary: z.boolean().default(false),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    id: projectIdSchema,
    name: projectDisplayNameSchema,
    description: projectDescriptionSchema.optional(),
    attentionLabels: z.array(attentionLabelSchema).max(20).optional().default([]),
    repositories: z
      .array(projectRepositoryConfigSchema)
      .min(1, 'at least one repository is required')
      .max(10, 'maximum 10 repositories allowed per project'),
  })
  .strict()
  .superRefine((data, ctx) => {
    const primaryCount = data.repositories.filter((repo) => repo.primary).length;
    if (primaryCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'project must specify exactly one primary repository',
        path: ['repositories'],
      });
    }

    const seen = new Set<string>();
    for (let index = 0; index < data.repositories.length; index += 1) {
      const repo = data.repositories[index]!;
      const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository ${repo.owner}/${repo.name}`,
          path: ['repositories', index],
        });
      }
      seen.add(key);
    }
  });

export const projectsConfigFileSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(projectConfigSchema).max(50, 'maximum 50 projects allowed'),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < data.projects.length; index += 1) {
      const project = data.projects[index]!;
      if (seen.has(project.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate project ID ${project.id}`,
          path: ['projects', index, 'id'],
        });
      }
      seen.add(project.id);
    }
  });

export const ciStateSchema = z.enum(['success', 'failure', 'pending', 'neutral', 'unknown']);
export const githubFreshnessSchema = z.enum(['fresh', 'stale', 'unavailable', 'partial']);

export const githubRepositorySnapshotSchema = z
  .object({
    owner: z.string(),
    name: z.string(),
    id: z.number().int().optional(),
    defaultBranch: z.string(),
    isPrivate: z.boolean(),
    isArchived: z.boolean(),
    description: z.string().nullable(),
    primaryLanguage: z.string().nullable(),
    updatedAt: z.string(),
    pushedAt: z.string().nullable(),
    url: z.string().url(),
  })
  .strict();

export const githubPullRequestSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(300),
    author: z.string().nullable().optional(),
    draft: z.boolean(),
    updatedAt: z.string(),
    url: z.string().url(),
    ciState: ciStateSchema,
  })
  .strict();

export const githubIssueSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(300),
    author: z.string().nullable().optional(),
    labels: z.array(z.string()),
    updatedAt: z.string(),
    url: z.string().url(),
    isAttention: z.boolean(),
  })
  .strict();

export const githubCiSummarySchema = z
  .object({
    status: ciStateSchema,
    conclusion: z.string().nullable().optional(),
    runUrl: z.string().url().nullable().optional(),
    workflowName: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .strict();

export const gitHubSourceHealthSchema = z
  .object({
    configured: z.boolean(),
    available: z.boolean(),
    lastSuccessfulRefresh: z.string().optional(),
    lastError: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
    rateLimit: z
      .object({
        remaining: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        resetAt: z.string(),
      })
      .nullable()
      .optional(),
  })
  .strict();

export const projectAttentionSummarySchema = z
  .object({
    failingCi: z.number().int().nonnegative().nullable(),
    openPullRequests: z.number().int().nonnegative().nullable(),
    attentionIssues: z.number().int().nonnegative().nullable(),
    attentionIssuesHasMore: z.boolean().default(false),
  })
  .strict();

export const projectRepositorySummarySchema = z
  .object({
    owner: z.string(),
    name: z.string(),
    primary: z.boolean(),
    snapshot: githubRepositorySnapshotSchema.nullable().optional(),
    ciState: ciStateSchema,
    latestCi: githubCiSummarySchema.nullable().optional(),
    openPrCount: z.number().int().nonnegative().nullable(),
    openPrHasMore: z.boolean().default(false),
    openIssueCount: z.number().int().nonnegative().nullable(),
    openIssueHasMore: z.boolean().default(false),
    attentionIssueCount: z.number().int().nonnegative().nullable(),
    attentionIssueHasMore: z.boolean().default(false),
    freshness: githubFreshnessSchema,
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .nullable()
      .optional(),
  })
  .strict();

export const projectSummarySchema = z
  .object({
    id: projectIdSchema,
    name: projectDisplayNameSchema,
    description: z.string().nullable().optional(),
    configured: z.boolean(),
    repositories: z.array(projectRepositorySummarySchema),
    primaryRepository: projectRepositorySummarySchema.nullable().optional(),
    attention: projectAttentionSummarySchema,
    freshness: githubFreshnessSchema,
    lastFetchedAt: z.string().nullable().optional(),
  })
  .strict();

export const projectDetailSchema = projectSummarySchema
  .extend({
    attentionLabels: z.array(z.string()),
    openPullRequests: z.array(githubPullRequestSummarySchema),
    attentionIssues: z.array(githubIssueSummarySchema),
    latestCi: githubCiSummarySchema.nullable().optional(),
  })
  .strict();

export const projectsResponseSchema = z
  .object({
    projects: z.array(projectSummarySchema),
    sourceHealth: gitHubSourceHealthSchema,
    generatedAt: z.string(),
  })
  .strict();

export const projectDetailResponseSchema = z
  .object({
    project: projectDetailSchema,
    sourceHealth: gitHubSourceHealthSchema,
    generatedAt: z.string(),
  })
  .strict();

export const gitHubWebhookEnvelopeSchema = z
  .object({
    repository: z
      .object({
        id: z.number().int().optional(),
        name: z.string().optional(),
        full_name: z.string().optional(),
        owner: z
          .object({
            login: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    action: z.string().optional(),
  })
  .passthrough();

export const gitHubWebhookDeliveryOutcomeSchema = z.enum(['accepted', 'ignored']);

export const gitHubWebhookDeliveryRecordSchema = z
  .object({
    deliveryId: z.string().min(1).max(128),
    eventName: z.string().min(1).max(64),
    repositoryOwner: z.string().nullable().optional(),
    repositoryName: z.string().nullable().optional(),
    outcome: gitHubWebhookDeliveryOutcomeSchema,
    receivedAt: z.string(),
    processedAt: z.string().nullable().optional(),
  })
  .strict();

export const gitHubWebhookHealthSchema = z
  .object({
    configured: z.boolean(),
    lastReceivedAt: z.string().optional(),
    lastAcceptedAt: z.string().optional(),
    lastEventName: z.string().optional(),
    lastRepository: z.string().optional(),
    lastErrorCode: z.string().optional(),
  })
  .strict();

export type AttentionLabel = z.infer<typeof attentionLabelSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type ProjectRepositoryConfig = z.infer<typeof projectRepositoryConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ProjectsConfigFile = z.infer<typeof projectsConfigFileSchema>;
export type CiState = z.infer<typeof ciStateSchema>;
export type GitHubFreshness = z.infer<typeof githubFreshnessSchema>;
export type GitHubRepositorySnapshot = z.infer<typeof githubRepositorySnapshotSchema>;
export type GitHubPullRequestSummary = z.infer<typeof githubPullRequestSummarySchema>;
export type GitHubIssueSummary = z.infer<typeof githubIssueSummarySchema>;
export type GitHubCiSummary = z.infer<typeof githubCiSummarySchema>;
export type GitHubSourceHealth = z.infer<typeof gitHubSourceHealthSchema>;
export type ProjectAttentionSummary = z.infer<typeof projectAttentionSummarySchema>;
export type ProjectRepositorySummary = z.infer<typeof projectRepositorySummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
export type GitHubWebhookEnvelope = z.infer<typeof gitHubWebhookEnvelopeSchema>;
export type GitHubWebhookDeliveryOutcome = z.infer<typeof gitHubWebhookDeliveryOutcomeSchema>;
export type GitHubWebhookDeliveryRecord = z.infer<typeof gitHubWebhookDeliveryRecordSchema>;
export type GitHubWebhookHealth = z.infer<typeof gitHubWebhookHealthSchema>;
