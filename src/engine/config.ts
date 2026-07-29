import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { z } from 'zod';

/**
 * Configuration: environment roots, the three config layers (user < profile <
 * project), strict validation with a legacy-input whitelist, and the
 * comment-preserving selection editor.
 *
 * Frozen 0.4.35 contracts: file locations and env overrides (ASB_HOME,
 * ASB_CONFIG, ASB_AGENTS_HOME, ASB_CACHE_HOME, legacy ~/.agent-switchboard),
 * every documented config key, layer merge semantics (objects deep-merge,
 * arrays replace wholesale), and the legacy spellings 0.4 migrated
 * (`active` → `enabled`, `[agents]`+`[subagents]` → `[applications]`+`[agents]`,
 * legacy plugins formats). New in 0.5: ASB_STATE_HOME for machine-local state
 * and run-fatal unknown-key validation with a nearest-key suggestion.
 */

export type ComponentType = 'rules' | 'commands' | 'agents' | 'skills' | 'hooks' | 'mcp';

export const SELECTION_TYPES: readonly ComponentType[] = [
  'rules',
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcp',
];

export interface Homes {
  asbHome: string;
  agentsHome: string;
  cacheHome: string;
  stateHome: string;
  configHome?: string;
}

export class ConfigError extends Error {
  readonly exitCode = 2;
}

export function resolveHomes(env: NodeJS.ProcessEnv = process.env): Homes {
  const home = os.homedir();

  const asbOverride = env.ASB_HOME?.trim();
  let asbHome: string;
  if (asbOverride) {
    asbHome = asbOverride;
  } else {
    const shortDir = path.join(home, '.asb');
    const legacyDir = path.join(home, '.agent-switchboard');
    asbHome = fs.existsSync(shortDir) ? shortDir : fs.existsSync(legacyDir) ? legacyDir : shortDir;
  }

  const agentsHome = env.ASB_AGENTS_HOME?.trim() || home;
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  const configHome =
    xdgConfig && !env.ASB_AGENTS_HOME?.trim()
      ? path.resolve(xdgConfig)
      : path.join(path.resolve(agentsHome), '.config');

  const cacheOverride = env.ASB_CACHE_HOME?.trim();
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const cacheHome = cacheOverride
    ? cacheOverride
    : xdgCache
      ? path.join(xdgCache, 'asb')
      : path.join(home, '.cache', 'asb');

  const stateOverride = env.ASB_STATE_HOME?.trim();
  const xdgState = env.XDG_STATE_HOME?.trim();
  const stateHome = stateOverride
    ? stateOverride
    : xdgState
      ? path.join(xdgState, 'asb')
      : path.join(home, '.local', 'state', 'asb');

  // Resolved once against the invocation cwd: a relative override (e.g.
  // ASB_AGENTS_HOME=agents) must not let the same ledger key point at a
  // different physical file per working directory.
  return {
    asbHome: path.resolve(asbHome),
    agentsHome: path.resolve(agentsHome),
    cacheHome: path.resolve(cacheHome),
    stateHome: path.resolve(stateHome),
    configHome,
  };
}

export function userConfigPath(homes: Homes, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ASB_CONFIG?.trim();
  if (override) return override;
  return path.join(homes.asbHome, 'config.toml');
}

export function profileConfigPath(homes: Homes, profileName: string): string {
  const trimmed = profileName.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new ConfigError('Profile name must be one safe path segment.');
  }
  if (trimmed.toLowerCase() === 'config') {
    throw new ConfigError('Profile name must not alias the user configuration file.');
  }
  return path.join(homes.asbHome, `${trimmed}.toml`);
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.asb.toml');
}

// ---------------------------------------------------------------------------
// Schema (strict, with the 0.4 legacy whitelist applied before validation)
// ---------------------------------------------------------------------------

const idArray = z.array(z.string().trim().min(1));

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Legacy `active` spelling for a selection table becomes `enabled`. */
function migrateActive(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if (!('active' in value)) return value;
  const migrated = { ...value };
  if (!('enabled' in migrated)) migrated.enabled = migrated.active;
  delete migrated.active;
  return migrated;
}

/** Legacy plugins formats (flat boolean map, record-shaped enabled) → current shape. */
function migratePluginsSection(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const obj = input;

  if (Array.isArray(obj.enabled)) return input;

  const enabledRecord = obj.enabled;
  if (isPlainObject(enabledRecord)) {
    return {
      ...obj,
      enabled: Object.entries(enabledRecord)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    };
  }

  const sources = obj.sources;
  if (isPlainObject(sources) && !('source' in sources)) {
    if (obj.enabled === undefined) return { ...obj, enabled: [] };
    return input;
  }

  const migratedSources: Record<string, unknown> = {};
  const enabled: string[] = [];
  const preserved: Record<string, unknown> = {};
  let exclude: unknown;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'auto_update' && typeof value === 'boolean') {
      preserved[key] = value;
      continue;
    }
    if (key === 'exclude' && isPlainObject(value) && !('source' in value)) {
      exclude = value;
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) enabled.push(key);
      continue;
    }
    if (isPlainObject(value) && 'source' in value) {
      migratedSources[key] = value.source;
      if (value.enabled === true) enabled.push(key);
      continue;
    }
    preserved[key] = value;
  }

  const result: Record<string, unknown> = { sources: migratedSources, enabled, ...preserved };
  if (exclude !== undefined) result.exclude = exclude;
  return result;
}

/** Legacy top-level `[agents]`(apps)+`[subagents]`(library) spelling. */
function migrateLegacyTopLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };
  const hasOldSubagents = 'subagents' in migrated;

  if (hasOldSubagents && 'agents' in migrated && !('applications' in migrated)) {
    migrated.applications = migrated.agents;
    delete migrated.agents;

    const apps = migrated.applications;
    if (isPlainObject(apps)) {
      for (const [key, value] of Object.entries(apps)) {
        if (key === 'active' || key === 'enabled' || key === 'assume_installed') continue;
        if (isPlainObject(value)) {
          const override = { ...value };
          if ('subagents' in override && !('agents' in override)) {
            override.agents = override.subagents;
            delete override.subagents;
          }
          apps[key] = override;
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

const selectionSection = z.preprocess(
  migrateActive,
  z.object({ enabled: idArray.optional() }).strict()
);

const rulesSection = z.preprocess(
  migrateActive,
  z.object({ enabled: idArray.optional(), includeDelimiters: z.boolean().optional() }).strict()
);

const incrementalSelection = z
  .object({ enabled: idArray.optional(), add: idArray.optional(), remove: idArray.optional() })
  .strict();

const incrementalRules = z
  .object({
    enabled: idArray.optional(),
    add: idArray.optional(),
    remove: idArray.optional(),
    includeDelimiters: z.boolean().optional(),
  })
  .strict();

const nativePluginSelection = z
  .object({ enabled: idArray.optional(), scope: z.literal('user').optional() })
  .strict();

const applicationOverride = z
  .object({
    plugins: incrementalSelection.optional(),
    native_plugins: nativePluginSelection.optional(),
    mcp: incrementalSelection.optional(),
    commands: incrementalSelection.optional(),
    agents: incrementalSelection.optional(),
    skills: incrementalSelection.optional(),
    hooks: incrementalSelection.optional(),
    rules: incrementalRules.optional(),
  })
  .strict();

const applicationsSection = z.preprocess(
  migrateActive,
  z
    .object({ enabled: idArray.optional(), assume_installed: idArray.optional() })
    .catchall(applicationOverride)
);

const remoteSource = z
  .object({
    url: z.string().min(1),
    ref: z.string().optional(),
    subdir: z.string().optional(),
    type: z.enum(['subtree', 'clone']).optional(),
  })
  .strict();

const sourceValue = z.union([z.string().trim().min(1), remoteSource]);

const pluginExclude = z
  .object({
    commands: idArray.optional(),
    agents: idArray.optional(),
    skills: idArray.optional(),
    hooks: idArray.optional(),
    rules: idArray.optional(),
    mcp: idArray.optional(),
  })
  .strict();

const pluginsSection = z.preprocess(
  migratePluginsSection,
  z
    .object({
      sources: z.record(z.string().trim().min(1), sourceValue).optional(),
      enabled: idArray.optional(),
      exclude: pluginExclude.optional(),
      auto_update: z.boolean().optional(),
    })
    .strict()
);

const projectRulesDistribution = z
  .object({ placement: z.enum(['prepend', 'append']).optional() })
  .strict();

const projectDistribution = z
  .object({
    mode: z.enum(['managed', 'exclusive', 'none']).optional(),
    collision: z.enum(['warn-skip', 'error', 'takeover']).optional(),
    rules: projectRulesDistribution.optional(),
  })
  .strict();

const distributionSection = z
  .object({ use_agents_dir: z.boolean().optional(), project: projectDistribution.optional() })
  .strict();

const uiSection = z.object({ page_size: z.number().int().min(5).max(50).optional() }).strict();

const extensionsSection = z.record(z.string(), z.boolean());

const targetPath = z.string().trim().min(1);
const stringRecord = z.record(z.string(), z.string());
const unknownRecord = z.record(z.string(), z.unknown());
const frontmatterTransform = z
  .object({
    rename: stringRecord.optional(),
    omit: idArray.optional(),
    include: idArray.optional(),
    join: stringRecord.optional(),
    defaults: unknownRecord.optional(),
  })
  .strict();
const filenamePattern = z
  .string()
  .trim()
  .min(1)
  .superRefine((pattern, context) => {
    const placeholders = pattern.match(/\{id\}/g)?.length ?? 0;
    if (placeholders !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filename_pattern must contain exactly one "{id}" placeholder',
      });
    }
    if (pattern.includes('/') || pattern.includes('\\')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filename_pattern must not contain path separators',
      });
    }
    const suffix = pattern.slice(pattern.lastIndexOf('{id}') + 4);
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filename_pattern must end in an extension after "{id}"',
      });
    }
  });
const customMcpTarget = z
  .object({
    format: z.enum(['json', 'yaml']),
    config_path: targetPath,
    project_config_path: targetPath.optional(),
    root_key: targetPath.optional(),
    structure: z.enum(['record', 'keyed-array']).optional(),
    key_field: targetPath.optional(),
    defaults: unknownRecord.optional(),
    env_transform: z
      .object({ key_name: targetPath.optional(), value_name: targetPath.optional() })
      .strict()
      .optional(),
  })
  .strict();
const customRulesTarget = z
  .object({
    format: z.enum(['markdown', 'mdc']).optional(),
    file_path: targetPath,
    project_file_path: targetPath.optional(),
  })
  .strict();
const customEntryTarget = z
  .object({
    target_dir: targetPath,
    project_target_dir: targetPath.optional(),
    filename_pattern: filenamePattern.optional(),
    platform_key: targetPath.optional(),
    frontmatter: frontmatterTransform.optional(),
  })
  .strict();
const customSkillsTarget = z
  .object({ parent_dir: targetPath, project_parent_dir: targetPath.optional() })
  .strict();
const targetSpec = z
  .object({
    detect: targetPath.optional(),
    mcp: customMcpTarget.optional(),
    rules: customRulesTarget.optional(),
    commands: customEntryTarget.optional(),
    agents: customEntryTarget.optional(),
    skills: customSkillsTarget.optional(),
  })
  .strict();

export type CustomTargetSpec = z.infer<typeof targetSpec>;

const layerSchema = z
  .object({
    applications: applicationsSection.optional(),
    plugins: pluginsSection.optional(),
    extensions: extensionsSection.optional(),
    targets: z.record(z.string().trim().min(1), targetSpec).optional(),
    mcp: selectionSection.optional(),
    commands: selectionSection.optional(),
    agents: selectionSection.optional(),
    skills: selectionSection.optional(),
    hooks: selectionSection.optional(),
    rules: rulesSection.optional(),
    distribution: distributionSection.optional(),
    ui: uiSection.optional(),
  })
  .strict();

export type ConfigLayerValues = z.infer<typeof layerSchema>;

// ---------------------------------------------------------------------------
// Unknown-key reporting with nearest-key suggestions
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    let previous = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = dist[j];
      dist[j] = Math.min(dist[j] + 1, dist[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = temp;
    }
  }
  return dist[cols - 1];
}

export function nearestKey(candidate: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of known) {
    const distance = editDistance(candidate.toLowerCase(), key.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(candidate.length / 3))
    ? best
    : null;
}

const TOP_LEVEL_KEYS = [
  'applications',
  'plugins',
  'extensions',
  'targets',
  'mcp',
  'commands',
  'agents',
  'skills',
  'hooks',
  'rules',
  'distribution',
  'ui',
] as const;

function knownKeysFor(pathParts: readonly (string | number)[]): readonly string[] {
  const [head, second, third] = pathParts;
  if (pathParts.length === 0) return TOP_LEVEL_KEYS;
  switch (head) {
    case 'rules':
      return ['enabled', 'includeDelimiters'];
    case 'mcp':
    case 'commands':
    case 'agents':
    case 'skills':
    case 'hooks':
      return ['enabled'];
    case 'applications':
      if (pathParts.length === 1) return ['enabled', 'assume_installed'];
      if (pathParts.length === 2 && typeof second === 'string') {
        return [
          'plugins',
          'native_plugins',
          'mcp',
          'commands',
          'agents',
          'skills',
          'hooks',
          'rules',
        ];
      }
      if (pathParts.length === 3 && third === 'rules') {
        return ['enabled', 'add', 'remove', 'includeDelimiters'];
      }
      return ['enabled', 'add', 'remove'];
    case 'plugins':
      if (pathParts.length === 1) return ['sources', 'enabled', 'exclude', 'auto_update'];
      if (second === 'exclude') return ['commands', 'agents', 'skills', 'hooks', 'rules', 'mcp'];
      return [];
    case 'distribution':
      if (pathParts.length === 1) return ['use_agents_dir', 'project'];
      if (second === 'project' && pathParts.length === 2) return ['mode', 'collision', 'rules'];
      if (second === 'project' && third === 'rules') return ['placement'];
      return [];
    case 'ui':
      return ['page_size'];
    case 'targets':
      if (pathParts.length === 2) {
        return ['detect', 'mcp', 'rules', 'commands', 'agents', 'skills'];
      }
      if (pathParts.length === 3) {
        switch (third) {
          case 'mcp':
            return [
              'format',
              'config_path',
              'project_config_path',
              'root_key',
              'structure',
              'key_field',
              'defaults',
              'env_transform',
            ];
          case 'rules':
            return ['format', 'file_path', 'project_file_path'];
          case 'commands':
          case 'agents':
            return [
              'target_dir',
              'project_target_dir',
              'filename_pattern',
              'platform_key',
              'frontmatter',
            ];
          case 'skills':
            return ['parent_dir', 'project_parent_dir'];
        }
      }
      if (pathParts.length === 4 && pathParts[3] === 'frontmatter') {
        return ['rename', 'omit', 'include', 'join', 'defaults'];
      }
      if (pathParts.length === 4 && pathParts[3] === 'env_transform') {
        return ['key_name', 'value_name'];
      }
      return [];
    default:
      return TOP_LEVEL_KEYS;
  }
}

function describeZodError(filePath: string, error: z.ZodError): ConfigError {
  const issue =
    error.issues.find((candidate) => candidate.code === z.ZodIssueCode.unrecognized_keys) ??
    error.issues[0];
  if (issue && issue.code === z.ZodIssueCode.unrecognized_keys) {
    const key = issue.keys[0];
    const where = issue.path.length > 0 ? `${issue.path.join('.')}.${key}` : key;
    const suggestion = nearestKey(key, knownKeysFor(issue.path));
    const hint = suggestion ? ` — did you mean "${suggestion}"?` : '';
    return new ConfigError(`Invalid configuration in ${filePath}: unknown key "${where}"${hint}`);
  }
  const location = issue && issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
  const message = issue ? issue.message : error.message;
  return new ConfigError(`Invalid configuration in ${filePath}${location}: ${message}`);
}

// ---------------------------------------------------------------------------
// Layer loading and merge
// ---------------------------------------------------------------------------

export interface ConfigLayer {
  kind: 'user' | 'profile' | 'project';
  path: string;
  exists: boolean;
  values: ConfigLayerValues;
}

function readLayer(kind: ConfigLayer['kind'], filePath: string): ConfigLayer {
  if (!fs.existsSync(filePath)) {
    return { kind, path: filePath, exists: false, values: {} };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  let raw: unknown;
  try {
    raw = content.trim().length === 0 ? {} : parseToml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse ${filePath}: ${message}`);
  }
  const migrated = migrateLegacyTopLevel(isPlainObject(raw) ? raw : {});
  const result = layerSchema.safeParse(migrated);
  if (!result.success) throw describeZodError(filePath, result.error);
  return { kind, path: filePath, exists: true, values: result.data };
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }
    if (isPlainObject(value)) {
      const current = target[key];
      const clone = isPlainObject(current) ? { ...current } : {};
      mergeDeep(clone, value);
      target[key] = clone;
      continue;
    }
    target[key] = value;
  }
}

export interface AppOverride {
  plugins?: z.infer<typeof incrementalSelection>;
  native_plugins?: z.infer<typeof nativePluginSelection>;
  mcp?: z.infer<typeof incrementalSelection>;
  commands?: z.infer<typeof incrementalSelection>;
  agents?: z.infer<typeof incrementalSelection>;
  skills?: z.infer<typeof incrementalSelection>;
  hooks?: z.infer<typeof incrementalSelection>;
  rules?: z.infer<typeof incrementalRules>;
}

export interface IncrementalOverride {
  enabled?: string[];
  add?: string[];
  remove?: string[];
}

/**
 * Frozen 0.4 semantics: `enabled` replaces the base outright — even when it
 * is an empty array — and short-circuits add/remove; otherwise the base
 * minus `remove` plus `add`, first occurrence wins.
 */
export function mergeIncrementalSelection(
  base: readonly string[],
  override?: IncrementalOverride
): string[] {
  if (!override) return [...base];
  if (override.enabled) return [...override.enabled];
  const removed = new Set(override.remove ?? []);
  const result = base.filter((id) => !removed.has(id));
  const seen = new Set(result);
  for (const id of override.add ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * What each enabled plugin contributes, and which spellings of a plugin or
 * component ref name the same thing. Attached to a resolved config after the
 * library scan; without it a selection is the global list alone.
 */
export interface PluginExpansion {
  /** Component ids each plugin id contributes, by type. */
  byPlugin: Record<string, Partial<Record<ComponentType, readonly string[]>>>;
  /** Canonical plugin id per accepted plugin ref, bare names included. */
  pluginAliases: Record<string, string>;
  /** Canonical component id per accepted component ref. */
  componentAliases: Record<string, string>;
}

/** The scan's expansion, attached without mutating the loaded configuration. */
export function withPluginExpansion(
  config: ResolvedConfig,
  expansion: PluginExpansion
): ResolvedConfig {
  return { ...config, plugins: { ...config.plugins, expansion } };
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Plugin ids this app enables, in order, with every ref resolved to its
 * canonical id. Both sides canonicalize before the merge, because the merge
 * matches `remove` against the base by string equality: a base written
 * `pack@shop` and an override written `pack` name the same plugin.
 */
export function effectivePlugins(config: ResolvedConfig, appId: string): string[] {
  const aliases = config.plugins.expansion?.pluginAliases ?? {};
  const canonical = (ref: string): string => aliases[ref] ?? ref;
  const override = config.apps.overrides[appId]?.plugins;
  const normalized = override && {
    enabled: override.enabled?.map(canonical),
    add: override.add?.map(canonical),
    remove: override.remove?.map(canonical),
  };
  return dedupe(
    mergeIncrementalSelection(config.selection.plugins.map(canonical), normalized).map(canonical)
  );
}

/**
 * Per-app effective selection. Two channels feed it: the global `enabled`
 * list, and the components the app's enabled plugins expand to minus
 * `[plugins.exclude]` — which filters plugin-expanded ids only, so an id the
 * user enabled explicitly survives its own plugin's exclusion. The app's
 * override applies to the merge of both, and every ref is canonicalized on the
 * way in and on the way out.
 */
export function effectiveSelection(
  config: ResolvedConfig,
  appId: string,
  type: ComponentType
): string[] {
  const override = config.apps.overrides[appId]?.[type];
  const expansion = config.plugins.expansion;
  if (!expansion) {
    return dedupe(mergeIncrementalSelection(config.selection[type], override));
  }

  const canonical = (id: string): string => expansion.componentAliases[id] ?? id;
  const excluded = new Set((config.plugins.exclude[type] ?? []).map(canonical));
  const expanded = effectivePlugins(config, appId)
    .flatMap((id) => expansion.byPlugin[id]?.[type] ?? [])
    .filter((id) => !excluded.has(id));

  const merged = dedupe([...config.selection[type].map(canonical), ...expanded]);
  const normalized = override && {
    enabled: override.enabled?.map(canonical),
    add: override.add?.map(canonical),
    remove: override.remove?.map(canonical),
  };
  return dedupe(mergeIncrementalSelection(merged, normalized).map(canonical));
}

/**
 * Every plugin the enabled apps point at, whether by naming the plugin or by
 * enabling one of its components. A component ref carries its plugin as a
 * prefix, so the second channel is a lookup through the same aliases rather
 * than a second notion of what "selected" means.
 */
export function selectedPluginIds(config: ResolvedConfig): Set<string> {
  const aliases = config.plugins.expansion?.pluginAliases ?? {};
  const selected = new Set<string>();
  for (const appId of config.apps.enabled) {
    for (const id of effectivePlugins(config, appId)) selected.add(id);
    for (const type of SELECTION_TYPES) {
      for (const ref of effectiveSelection(config, appId, type)) {
        const cut = ref.lastIndexOf(':');
        if (cut < 0) continue;
        const plugin = ref.slice(0, cut);
        selected.add(aliases[plugin] ?? plugin);
      }
    }
  }
  return selected;
}

export function effectiveIncludeDelimiters(config: ResolvedConfig, appId: string): boolean {
  return config.apps.overrides[appId]?.rules?.includeDelimiters ?? config.rules.includeDelimiters;
}

export interface ResolvedConfig {
  homes: Homes;
  layers: ConfigLayer[];
  selection: Record<ComponentType, string[]> & { plugins: string[] };
  apps: {
    enabled: string[];
    assumeInstalled: string[];
    overrides: Record<string, AppOverride>;
  };
  plugins: {
    sources: Record<string, z.infer<typeof sourceValue>>;
    exclude: z.infer<typeof pluginExclude>;
    autoUpdate: boolean;
    /** Present once the library scan has said what the sources contribute. */
    expansion?: PluginExpansion;
  };
  rules: { includeDelimiters: boolean };
  distribution: {
    useAgentsDir: boolean;
    project: {
      mode: 'managed' | 'exclusive' | 'none';
      collision: 'warn-skip' | 'error' | 'takeover';
      rulesPlacement: 'prepend' | 'append';
    };
  };
  extensions: Record<string, boolean>;
  targets: Record<string, CustomTargetSpec>;
  ui: { pageSize: number };
  project: string | null;
  profile: string | null;
}

export interface LoadConfigOptions {
  profile?: string;
  project?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOptions = {}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const homes = resolveHomes(env);

  const layers: ConfigLayer[] = [readLayer('user', userConfigPath(homes, env))];

  const profileName = opts.profile?.trim() || env.ASB_PROFILE?.trim() || null;
  if (profileName) layers.push(readLayer('profile', profileConfigPath(homes, profileName)));

  let projectRoot: string | null = null;
  if (opts.project) {
    const requested = path.resolve(opts.project);
    try {
      projectRoot = fs.realpathSync(requested);
    } catch {
      throw new ConfigError(`Project root does not exist or cannot be resolved: ${requested}`);
    }
  }
  if (projectRoot) layers.push(readLayer('project', projectConfigPath(projectRoot)));

  const merged: Record<string, unknown> = {};
  for (const layer of layers) mergeDeep(merged, layer.values as Record<string, unknown>);

  const section = (name: string): Record<string, unknown> =>
    isPlainObject(merged[name]) ? (merged[name] as Record<string, unknown>) : {};

  const idList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry)) : [];

  const applications = section('applications');
  const overrides: Record<string, AppOverride> = {};
  for (const [key, value] of Object.entries(applications)) {
    if (key === 'enabled' || key === 'assume_installed') continue;
    if (isPlainObject(value)) overrides[key] = value as AppOverride;
  }

  const pluginsSectionValues = section('plugins');
  const distributionValues = section('distribution');
  const projectValues = isPlainObject(distributionValues.project)
    ? (distributionValues.project as Record<string, unknown>)
    : {};
  const projectRules = isPlainObject(projectValues.rules)
    ? (projectValues.rules as Record<string, unknown>)
    : {};
  const rulesValues = section('rules');
  const uiValues = section('ui');

  return {
    homes,
    layers,
    selection: {
      rules: idList(rulesValues.enabled),
      commands: idList(section('commands').enabled),
      agents: idList(section('agents').enabled),
      skills: idList(section('skills').enabled),
      hooks: idList(section('hooks').enabled),
      mcp: idList(section('mcp').enabled),
      plugins: idList(pluginsSectionValues.enabled),
    },
    apps: {
      enabled: idList(applications.enabled),
      assumeInstalled: idList(applications.assume_installed),
      overrides,
    },
    plugins: {
      sources: isPlainObject(pluginsSectionValues.sources)
        ? (pluginsSectionValues.sources as Record<string, z.infer<typeof sourceValue>>)
        : {},
      exclude: isPlainObject(pluginsSectionValues.exclude)
        ? (pluginsSectionValues.exclude as z.infer<typeof pluginExclude>)
        : {},
      autoUpdate: pluginsSectionValues.auto_update === true,
    },
    rules: { includeDelimiters: rulesValues.includeDelimiters === true },
    distribution: {
      useAgentsDir: distributionValues.use_agents_dir === true,
      project: {
        mode: (projectValues.mode as 'managed' | 'exclusive' | 'none' | undefined) ?? 'managed',
        collision:
          (projectValues.collision as 'warn-skip' | 'error' | 'takeover' | undefined) ??
          'warn-skip',
        rulesPlacement: (projectRules.placement as 'prepend' | 'append' | undefined) ?? 'prepend',
      },
    },
    extensions: isPlainObject(merged.extensions)
      ? (merged.extensions as Record<string, boolean>)
      : {},
    targets: isPlainObject(merged.targets)
      ? (merged.targets as Record<string, CustomTargetSpec>)
      : {},
    ui: { pageSize: typeof uiValues.page_size === 'number' ? uiValues.page_size : 20 },
    project: projectRoot,
    profile: profileName,
  };
}

// ---------------------------------------------------------------------------
// Comment-preserving selection editor (byte splice, never re-serialization)
// ---------------------------------------------------------------------------

interface ArraySpan {
  /** Offset of the opening bracket. */
  open: number;
  /** Offset of the closing bracket. */
  close: number;
}

/** Find the end offset (exclusive) of the TOML section that starts at `headerEnd`. */
function sectionEnd(content: string, headerEnd: number): number {
  const headerPattern = /^[ \t]*\[/gm;
  headerPattern.lastIndex = headerEnd;
  const match = headerPattern.exec(content);
  return match ? match.index : content.length;
}

function findSection(content: string, name: string): { start: number; end: number } | null {
  const pattern = new RegExp(`^[ \\t]*\\[${name.replace(/\\./g, '\\.')}\\][ \\t]*(#.*)?$`, 'm');
  const match = pattern.exec(content);
  if (!match) return null;
  const headerEnd = match.index + match[0].length;
  return { start: headerEnd, end: sectionEnd(content, headerEnd + 1) };
}

/**
 * Locate the `enabled = [...]` array inside a section body. Commented-out
 * assignments never match; strings and comments are honored while scanning
 * for the closing bracket.
 */
function findArray(
  content: string,
  section: { start: number; end: number },
  key: string
): ArraySpan | null {
  const body = content.slice(section.start, section.end);
  const assignment = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`, 'm').exec(body);
  if (!assignment) return null;
  const open = section.start + assignment.index + assignment[0].length - 1;

  let inString: '"' | "'" | null = null;
  let depth = 0;
  for (let i = open; i < section.end; i++) {
    const char = content[i];
    if (inString) {
      if (inString === '"' && char === '\\') {
        i += 1;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
    } else if (char === '#') {
      const lineEnd = content.indexOf('\n', i);
      i = lineEnd === -1 ? section.end : lineEnd;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/** String element tokens (offsets and decoded values) at depth 1 of the array. */
function arrayElements(
  content: string,
  span: ArraySpan
): Array<{ start: number; end: number; value: string }> {
  const elements: Array<{ start: number; end: number; value: string }> = [];
  let inString: '"' | "'" | null = null;
  let stringStart = 0;
  let raw = '';
  for (let i = span.open + 1; i < span.close; i++) {
    const char = content[i];
    if (inString) {
      if (inString === '"' && char === '\\') {
        raw += content[i + 1] ?? '';
        i += 1;
      } else if (char === inString) {
        elements.push({ start: stringStart, end: i + 1, value: raw });
        inString = null;
      } else {
        raw += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      stringStart = i;
      raw = '';
    } else if (char === '#') {
      const lineEnd = content.indexOf('\n', i);
      i = lineEnd === -1 ? span.close : Math.min(lineEnd, span.close);
    }
  }
  return elements;
}

function normalizeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function renderArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/** Insert new ids into an existing array without disturbing its bytes. */
function spliceInto(content: string, span: ArraySpan, additions: readonly string[]): string {
  const inner = content.slice(span.open + 1, span.close);
  const multiline = inner.includes('\n');

  if (!multiline) {
    const trimmedInner = inner.trim();
    const rendered = additions.map((value) => JSON.stringify(value)).join(', ');
    const insertion = trimmedInner.length === 0 ? rendered : `, ${rendered}`;
    const insertAt =
      span.open +
      1 +
      (trimmedInner.length === 0 ? inner.length : inner.replace(/[ \t]+$/, '').length);
    return content.slice(0, insertAt) + insertion + content.slice(insertAt);
  }

  const closingLineStart = content.lastIndexOf('\n', span.close) + 1;
  const elements = arrayElements(content, span);
  const lastElement = elements[elements.length - 1];

  // Closing bracket on the last element's own line: append inline after the
  // element so additions land after existing ids, never before them.
  if (lastElement && lastElement.end >= closingLineStart) {
    const rendered = additions.map((value) => JSON.stringify(value)).join(', ');
    return `${content.slice(0, lastElement.end)}, ${rendered}${content.slice(lastElement.end)}`;
  }

  let indent = '  ';
  if (lastElement) {
    const lineStart = content.lastIndexOf('\n', lastElement.start) + 1;
    const lineIndent = /^[ \t]*/.exec(content.slice(lineStart, lastElement.start))?.[0];
    if (lineIndent) indent = lineIndent;
  }

  let prefix = '';
  if (lastElement) {
    const between = content.slice(lastElement.end, closingLineStart);
    const hasComma = /^[^#\n]*,/.test(between.split('\n')[0] ?? '');
    if (!hasComma) {
      const insertComma = lastElement.end;
      content = `${content.slice(0, insertComma)},${content.slice(insertComma)}`;
      span = { open: span.open, close: span.close + 1 };
    }
    prefix = '';
  }

  const newLines = additions.map((value) => `${indent}${JSON.stringify(value)},`).join('\n');
  const insertAt = content.lastIndexOf('\n', span.close) + 1;
  return `${content.slice(0, insertAt)}${prefix}${newLines}\n${content.slice(insertAt)}`;
}

/** Remove one string element (and one adjacent comma; its whole line when alone). */
function spliceOut(
  content: string,
  span: ArraySpan,
  element: { start: number; end: number }
): string {
  let removeStart = element.start;
  let removeEnd = element.end;

  // Consume one following comma (with surrounding inline whitespace).
  let i = removeEnd;
  while (i < span.close && (content[i] === ' ' || content[i] === '\t')) i++;
  if (content[i] === ',') {
    removeEnd = i + 1;
    while (removeEnd < span.close && (content[removeEnd] === ' ' || content[removeEnd] === '\t')) {
      removeEnd += 1;
    }
  } else {
    // No following comma: consume a preceding one instead.
    let j = removeStart - 1;
    while (j > span.open && (content[j] === ' ' || content[j] === '\t')) j--;
    if (content[j] === ',') removeStart = j;
  }

  // If the element's line holds nothing else, drop the whole line (incl. its comment).
  const lineStart = content.lastIndexOf('\n', removeStart) + 1;
  const lineEndIdx = content.indexOf('\n', removeEnd);
  const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx + 1;
  const before = content.slice(lineStart, removeStart);
  const after = content.slice(removeEnd, lineEnd === content.length ? lineEnd : lineEnd - 1);
  // Preserve comments even when the selected element beside them is removed.
  const lineIsOnlyElement = /^[ \t]*$/.test(before) && after.trim() === '';
  if (lineIsOnlyElement && lineStart > span.open && lineEnd - 1 <= span.close + 1) {
    return content.slice(0, lineStart) + content.slice(lineEnd);
  }

  return content.slice(0, removeStart) + content.slice(removeEnd);
}

/** TOML bare key where the namespace allows it, quoted where it does not. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function renderSourceValue(value: string | Record<string, string>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const fields = Object.entries(value).map(([key, item]) => `${key} = ${JSON.stringify(item)}`);
  return `{ ${fields.join(', ')} }`;
}

/** Drop a namespace's declaration in either spelling: an assignment inside
 * `[plugins.sources]`, or its own `[plugins.sources.<ns>]` table. */
function removeSourceDeclaration(content: string, namespace: string): string {
  const keyPattern = `(?:${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|"${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`;

  const table = new RegExp(`^[ \\t]*\\[plugins\\.sources\\.${keyPattern}\\][ \\t]*(#.*)?$`, 'm');
  const tableMatch = table.exec(content);
  if (tableMatch) {
    const start = tableMatch.index;
    const end = sectionEnd(content, tableMatch.index + tableMatch[0].length + 1);
    const body = content.slice(start, end);
    // A trailing run of comment lines documents whatever follows this table,
    // not the table itself; the removal stops before it.
    const trailing = /(?:[ \t]*(?:#[^\n]*)?\n)*$/.exec(body);
    let cut = body.length;
    if (trailing && trailing[0].includes('#')) {
      const firstComment = trailing[0].indexOf('#');
      cut = trailing.index + trailing[0].lastIndexOf('\n', firstComment) + 1;
    }
    return content.slice(0, start) + content.slice(start + cut);
  }

  const section = findSection(content, 'plugins.sources');
  if (!section) return content;
  const body = content.slice(section.start, section.end);
  const assignment = new RegExp(`^[ \\t]*${keyPattern}[ \\t]*=.*$\\n?`, 'm').exec(body);
  if (!assignment) return content;
  const start = section.start + assignment.index;
  return content.slice(0, start) + content.slice(start + assignment[0].length);
}

export interface EditSourceOptions {
  namespace: string;
  /** Declaration to write; omitted removes the namespace. */
  value?: string | Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Write or remove one `[plugins.sources]` declaration by splicing the user
 * config, so every unrelated comment and commented-out line survives. The
 * result is re-parsed before it replaces the original.
 */
export function editSourceDeclaration(options: EditSourceOptions): void {
  const env = options.env ?? process.env;
  const homes = resolveHomes(env);
  const filePath = userConfigPath(homes, env);
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';

  let content = removeSourceDeclaration(original, options.namespace);
  if (options.value !== undefined) {
    const line = `${tomlKey(options.namespace)} = ${renderSourceValue(options.value)}\n`;
    const section = findSection(content, 'plugins.sources');
    if (section) {
      // Append at the end of the existing table body, after any trailing blank line.
      const body = content.slice(section.start, section.end);
      const insertAt = section.start + body.replace(/\s*$/, '').length;
      const prefix = content[insertAt - 1] === '\n' ? '' : '\n';
      content = content.slice(0, insertAt) + prefix + line + content.slice(insertAt);
    } else {
      const separator =
        content.length === 0 || content.endsWith('\n\n')
          ? ''
          : content.endsWith('\n')
            ? '\n'
            : '\n\n';
      content += `${separator}[plugins.sources]\n${line}`;
    }
  }

  if (content === original) return;
  writeConfigFile(filePath, content, 'Source edit');
}

export interface EditSelectionOptions {
  type: ComponentType | 'plugins' | 'native_plugins';
  enable?: readonly string[];
  disable?: readonly string[];
  replace?: readonly string[];
  app?: string;
  profile?: string;
  project?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Comment-preserving enable/disable edit of the user config's per-type
 * `enabled` array. The file is spliced, never re-serialized; the result is
 * re-parsed as a safety check before it replaces the original.
 */
export function editSelection(options: EditSelectionOptions): void {
  const env = options.env ?? process.env;
  const homes = resolveHomes(env);
  if (options.profile && options.project) {
    throw new ConfigError('Selection edit accepts either profile or project scope, not both.');
  }
  const filePath = options.project
    ? projectConfigPath(options.project)
    : options.profile
      ? profileConfigPath(homes, options.profile)
      : userConfigPath(homes, env);

  const additionsInput = normalizeIds(options.enable ?? []);
  const removals = new Set(normalizeIds(options.disable ?? []));

  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  let content = original;

  const sectionName = options.app ? `applications.${options.app}.${options.type}` : options.type;
  let section = findSection(content, sectionName);

  const currentValues = (key: string): string[] => {
    const span = section && findArray(content, section, key);
    if (!span) return [];
    return arrayElements(content, span).map((element) => element.value);
  };

  const mutate = (key: string, additionsValue: readonly string[], removalsValue: Set<string>) => {
    const existing = new Set(currentValues(key));
    const additions = additionsValue.filter((id) => !existing.has(id));
    if (additions.length > 0) {
      if (!section) {
        const separator =
          content.length === 0 || content.endsWith('\n\n')
            ? ''
            : content.endsWith('\n')
              ? '\n'
              : '\n\n';
        content += `${separator}[${sectionName}]\n${key} = ${renderArray(additions)}\n`;
        section = findSection(content, sectionName);
      } else {
        const span = findArray(content, section, key);
        if (!span) {
          const insertAt = section.start;
          content = `${content.slice(0, insertAt)}\n${key} = ${renderArray(additions)}${content.slice(insertAt)}`;
        } else {
          content = spliceInto(content, span, additions);
        }
        section = findSection(content, sectionName);
      }
    }

    if (removalsValue.size > 0 && section) {
      let span = findArray(content, section, key);
      while (span) {
        const target = arrayElements(content, span).find((element) =>
          removalsValue.has(element.value)
        );
        if (!target) break;
        content = spliceOut(content, span, target);
        section = findSection(content, sectionName);
        span = section ? findArray(content, section, key) : null;
      }
    }
  };

  if (options.replace !== undefined) {
    const desired = normalizeIds(options.replace);
    if (!section) {
      const separator =
        content.length === 0 || content.endsWith('\n\n')
          ? ''
          : content.endsWith('\n')
            ? '\n'
            : '\n\n';
      content += `${separator}[${sectionName}]\nenabled = ${renderArray(desired)}\n`;
      section = findSection(content, sectionName);
    } else if (!findArray(content, section, 'enabled')) {
      const insertAt = section.start;
      content = `${content.slice(0, insertAt)}\nenabled = ${renderArray(desired)}${content.slice(insertAt)}`;
      section = findSection(content, sectionName);
    }
    mutate(
      'enabled',
      desired,
      new Set(currentValues('enabled').filter((id) => !desired.includes(id)))
    );
    const span = section && findArray(content, section, 'enabled');
    if (span) {
      const elements = arrayElements(content, span);
      for (let index = elements.length - 1; index >= 0; index--) {
        const element = elements[index];
        const value = desired[index];
        if (!element || value === undefined || element.value === value) continue;
        content = `${content.slice(0, element.start)}${JSON.stringify(value)}${content.slice(element.end)}`;
      }
    }
  } else if (options.app && options.type !== 'native_plugins') {
    mutate('remove', [], new Set(additionsInput));
    mutate('add', additionsInput, removals);
    mutate('add', [], removals);
    mutate('remove', [...removals], new Set());
  } else {
    // Native plugin overrides carry a plain `enabled` array in every scope.
    mutate('enabled', additionsInput, removals);
  }

  if (content === original) return;
  writeConfigFile(filePath, content, 'Selection edit');
}

/**
 * Replace a config file with spliced content: validated as TOML first, then
 * written through a symlink to its backing file, keeping the original
 * permission bits (a 0600 config must not relax under the umask).
 */
function writeConfigFile(filePath: string, content: string, label: string): void {
  try {
    parseToml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `${label} produced invalid TOML for ${filePath} (left untouched): ${message}`
    );
  }

  let resolved = filePath;
  let mode: number | null = null;
  try {
    resolved = fs.realpathSync(filePath);
    mode = fs.statSync(resolved).mode & 0o777;
  } catch {
    // new file: no link to follow, default creation mode
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.asb-tmp-${process.pid}`
  );
  fs.writeFileSync(temp, content, 'utf-8');
  if (mode !== null) fs.chmodSync(temp, mode);
  fs.renameSync(temp, resolved);
}
