import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from '@iarna/toml';
import { withFileLock } from './file-lock.js';
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

/**
 * Migrate legacy config keys to the current schema.
 *
 * - `[agents]` (old target-app list) → `[applications]`
 * - `[applications].active` → `[applications].enabled`
 * - `[subagents]` (old agent library) → `[agents]`
 * - Per-application override `subagents` key → `agents`
 *
 * Detection: the presence of `[subagents]` is an unambiguous signal of old format.
 * Without it, `[agents]` could be either old (target list) or new (library), so we
 * only migrate `[agents]` → `[applications]` when `[subagents]` co-exists.
 */
function migrateLegacyConfigKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };
  const hasOldSubagents = 'subagents' in migrated;

  if (hasOldSubagents && 'agents' in migrated && !('applications' in migrated)) {
    migrated.applications = migrated.agents;
    delete migrated.agents;

    const apps = migrated.applications;
    if (apps && typeof apps === 'object') {
      for (const [key, value] of Object.entries(apps as Record<string, unknown>)) {
        if (key === 'active' || key === 'enabled' || key === 'assume_installed') continue;
        if (value && typeof value === 'object') {
          const override = { ...(value as Record<string, unknown>) };
          if ('subagents' in override && !('agents' in override)) {
            override.agents = override.subagents;
            delete override.subagents;
          }
          (apps as Record<string, unknown>)[key] = override;
        }
      }
    }
  }

  if ('subagents' in migrated && !('agents' in migrated)) {
    migrated.agents = migrated.subagents;
    delete migrated.subagents;
  }

  return migrated;
}

function readLayerFile(filePath: string): ConfigLayerLoadResult {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, config: {} };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw = content.trim().length === 0 ? {} : parse(content);
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const migrated = migrateLegacyConfigKeys(obj);
    const validated = switchboardConfigLayerSchema.parse(migrated);
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

function canonicalizeMissingPath(value: string): string {
  let current = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

export function resolveConfigWritePath(filePath: string): string {
  let current = path.resolve(filePath);
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current))
      throw new Error(`Config path contains a symbolic-link cycle: ${filePath}`);
    visited.add(current);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isSymbolicLink()) return fs.realpathSync.native(current);
      const target = fs.readlinkSync(current);
      current = path.resolve(path.dirname(current), target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return canonicalizeMissingPath(current);
    }
  }
}

function configTempPath(filePath: string): string {
  const targetPath = resolveConfigWritePath(filePath);
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.asb-write.tmp`);
}

export function getConfigLayerLockPath(filePath: string): string {
  const targetPath = resolveConfigWritePath(filePath);
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.asb-lock`);
}

export function cleanupConfigLayerTemp(filePath: string): void {
  fs.rmSync(configTempPath(filePath), { force: true });
}

export function withConfigFileTransaction<T>(filePath: string, action: () => T): T {
  const normalized = path.resolve(filePath);
  return withFileLock(getConfigLayerLockPath(normalized), () => {
    cleanupConfigLayerTemp(normalized);
    return action();
  });
}

function writeLayerFile(filePath: string, config: SwitchboardConfigLayer): void {
  const targetPath = resolveConfigWritePath(filePath);
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const portable = JSON.parse(JSON.stringify(config));
  // biome-ignore lint/suspicious/noExplicitAny: TOML stringify requires JsonMap typing
  const content = stringify(portable as any);
  const tempPath = configTempPath(filePath);
  const mode = fs.existsSync(targetPath) ? fs.statSync(targetPath).mode & 0o777 : undefined;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode, flag: 'wx' });
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export interface UpdateConfigLayerOptions extends LoadConfigLayersOptions {
  target?: ConfigLayerKind;
}

export function loadWritableConfigLayer(options?: UpdateConfigLayerOptions): ConfigLayerLoadResult {
  const targetKind = options?.target ?? defaultWritableLayer(options);
  const filePath = resolveLayerPath(targetKind, options);
  return readLayerFile(filePath);
}

export function getWritableConfigLayerPath(options?: UpdateConfigLayerOptions): string {
  const targetKind = options?.target ?? defaultWritableLayer(options);
  return path.resolve(resolveLayerPath(targetKind, options));
}

export function loadConfigLayerFile(filePath: string): ConfigLayerLoadResult {
  return readLayerFile(path.resolve(filePath));
}

export function withConfigLayerTransaction<T>(
  action: (filePath: string) => T,
  options?: UpdateConfigLayerOptions
): T {
  const filePath = getWritableConfigLayerPath(options);
  return withConfigFileTransaction(filePath, () => action(filePath));
}

export function updateConfigLayer(
  mutator: (layer: SwitchboardConfigLayer) => SwitchboardConfigLayer,
  options?: UpdateConfigLayerOptions
): ConfigLayerLoadResult {
  return withConfigLayerTransaction((filePath) => {
    const current = readLayerFile(filePath);
    const draft = JSON.parse(JSON.stringify(current.config)) as SwitchboardConfigLayer;
    const next = switchboardConfigLayerSchema.parse(mutator(draft));
    writeLayerFile(filePath, next);
    return { path: filePath, exists: true, config: next };
  }, options);
}
