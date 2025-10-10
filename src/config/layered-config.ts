import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@iarna/toml';

import { getProfileConfigPath, getProjectConfigPath, getSwitchboardConfigPath } from './paths.js';
import {
  type SwitchboardConfig,
  type SwitchboardConfigLayer,
  switchboardConfigLayerSchema,
  switchboardConfigSchema,
} from './schemas.js';

export interface ConfigLayerLoadResult {
  path: string;
  exists: boolean;
  config: SwitchboardConfigLayer;
}

export interface LoadConfigLayersOptions {
  profile?: string | null;
  projectPath?: string | null;
}

export interface ConfigLayers {
  user: ConfigLayerLoadResult;
  profile?: ConfigLayerLoadResult;
  project?: ConfigLayerLoadResult;
}

export type ConfigLayerKind = 'user' | 'profile' | 'project';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readLayerFile(filePath: string): ConfigLayerLoadResult {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, config: {} };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = content.trim().length === 0 ? {} : parse(content);
    const validated = switchboardConfigLayerSchema.parse(
      parsed && typeof parsed === 'object' ? parsed : {}
    );
    return { path: filePath, exists: true, config: validated };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load configuration from ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function loadConfigLayers(options?: LoadConfigLayersOptions): ConfigLayers {
  const userPath = getSwitchboardConfigPath();
  const user = readLayerFile(userPath);

  let profile: ConfigLayerLoadResult | undefined;
  const profileName = options?.profile?.trim();
  if (profileName) {
    const profilePath = getProfileConfigPath(profileName);
    profile = readLayerFile(profilePath);
  }

  let project: ConfigLayerLoadResult | undefined;
  const projectRoot = options?.projectPath?.trim();
  if (projectRoot) {
    const projectPath = getProjectConfigPath(projectRoot);
    project = readLayerFile(projectPath);
  }

  return { user, profile, project };
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'undefined') continue;

    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      const current = target[key];
      const base = isPlainObject(current) ? current : {};
      const clone = { ...base } as Record<string, unknown>;
      mergeDeep(clone, value);
      target[key] = clone;
      continue;
    }

    target[key] = value;
  }
}

export function mergeConfigLayers(layers: ConfigLayers): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  mergeDeep(merged, layers.user.config as Record<string, unknown>);

  if (layers.profile) {
    mergeDeep(merged, layers.profile.config as Record<string, unknown>);
  }

  if (layers.project) {
    mergeDeep(merged, layers.project.config as Record<string, unknown>);
  }

  return merged;
}

export function buildMergedSwitchboardConfig(layers: ConfigLayers): SwitchboardConfig {
  const merged = mergeConfigLayers(layers);
  return switchboardConfigSchema.parse(merged);
}

export function loadMergedSwitchboardConfig(options?: LoadConfigLayersOptions): {
  layers: ConfigLayers;
  config: SwitchboardConfig;
} {
  const layers = loadConfigLayers(options);
  const config = buildMergedSwitchboardConfig(layers);
  return { layers, config };
}

function defaultWritableLayer(options?: LoadConfigLayersOptions): ConfigLayerKind {
  const project = options?.projectPath?.trim();
  if (project && project.length > 0) return 'project';
  const profile = options?.profile?.trim();
  if (profile && profile.length > 0) return 'profile';
  return 'user';
}

function resolveLayerPath(kind: ConfigLayerKind, options?: LoadConfigLayersOptions): string {
  switch (kind) {
    case 'user':
      return getSwitchboardConfigPath();
    case 'profile': {
      const profile = options?.profile?.trim();
      if (!profile) {
        throw new Error('Profile name is required to write profile configuration.');
      }
      return getProfileConfigPath(profile);
    }
    case 'project': {
      const project = options?.projectPath?.trim();
      if (!project) {
        throw new Error('Project path is required to write project configuration.');
      }
      return getProjectConfigPath(project);
    }
    default:
      return getSwitchboardConfigPath();
  }
}

function writeLayerFile(filePath: string, config: SwitchboardConfigLayer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const portable = JSON.parse(JSON.stringify(config));
  // biome-ignore lint/suspicious/noExplicitAny: TOML stringify requires JsonMap typing
  const content = stringify(portable as any);
  fs.writeFileSync(filePath, content, 'utf-8');
}

export interface UpdateConfigLayerOptions extends LoadConfigLayersOptions {
  target?: ConfigLayerKind;
}

export function updateConfigLayer(
  mutator: (layer: SwitchboardConfigLayer) => SwitchboardConfigLayer,
  options?: UpdateConfigLayerOptions
): ConfigLayerLoadResult {
  const targetKind = options?.target ?? defaultWritableLayer(options);
  const filePath = resolveLayerPath(targetKind, options);
  const current = readLayerFile(filePath);
  const draft = JSON.parse(JSON.stringify(current.config)) as SwitchboardConfigLayer;
  const next = switchboardConfigLayerSchema.parse(mutator(draft));
  writeLayerFile(filePath, next);
  return readLayerFile(filePath);
}
