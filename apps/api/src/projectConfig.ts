import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  projectsConfigFileSchema,
  type ProjectConfig,
  type ProjectsConfigFile,
} from '@sonoran-hub/contracts';

export class ProjectConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConfigurationError';
  }
}

export interface LoadProjectConfigOptions {
  readonly environment?: { readonly [key: string]: string | undefined };
  readonly cwd?: string;
}

export const DEFAULT_PROJECTS_CONFIG_RELATIVE_PATH = 'config/projects.json';

/**
 * Loads and validates the Hub projects configuration.
 *
 * Rules:
 * 1. If SONORAN_PROJECTS_PATH is explicitly set:
 *    - Must point to an existing, valid file. If missing or invalid, throws ProjectConfigurationError.
 * 2. If default path is used (config/projects.json):
 *    - If missing, gracefully returns zero configured projects.
 *    - If present, must be valid JSON matching projectsConfigFileSchema.
 */
export function loadProjectConfig(options: LoadProjectConfigOptions = {}): ProjectsConfigFile {
  const env = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = env.SONORAN_PROJECTS_PATH?.trim();

  if (explicitPath) {
    const fullPath = resolve(cwd, explicitPath);
    if (!existsSync(fullPath)) {
      throw new ProjectConfigurationError(
        `Explicit project configuration file not found at ${fullPath}`,
      );
    }
    return parseConfigFile(fullPath);
  }

  const defaultPath = resolve(cwd, DEFAULT_PROJECTS_CONFIG_RELATIVE_PATH);
  if (!existsSync(defaultPath)) {
    return { version: 1, projects: [] };
  }

  return parseConfigFile(defaultPath);
}

function parseConfigFile(filePath: string): ProjectsConfigFile {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ProjectConfigurationError(
      `Failed to read project configuration from ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    throw new ProjectConfigurationError(
      `Invalid JSON in project configuration at ${filePath}: ${error instanceof Error ? error.message : 'Syntax error'}`,
    );
  }

  const validation = projectsConfigFileSchema.safeParse(parsedJson);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new ProjectConfigurationError(`Invalid project configuration in ${filePath}: ${issues}`);
  }

  return validation.data;
}

export function findProjectInConfig(
  config: ProjectsConfigFile,
  projectId: string,
): ProjectConfig | undefined {
  return config.projects.find((project) => project.id === projectId);
}
