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

  return { asbHome, agentsHome, cacheHome, stateHome };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

/** Custom-target rows keep an open grammar here; apps.ts validates them into table rows. */
const targetSpec = z.object({}).passthrough();

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

function nearestKey(candidate: string, known: readonly string[]): string | null {
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
    default:
      return TOP_LEVEL_KEYS;
  }
}

function describeZodError(filePath: string, error: z.ZodError): ConfigError {
  const [issue] = error.issues;
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
  targets: Record<string, Record<string, unknown>>;
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

  const projectRoot = opts.project ? path.resolve(opts.project) : null;
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
      ? (merged.targets as Record<string, Record<string, unknown>>)
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
  const pattern = new RegExp(`^[ \\t]*\\[${name.replace('.', '\\.')}\\][ \\t]*(#.*)?$`, 'm');
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
function findEnabledArray(
  content: string,
  section: { start: number; end: number }
): ArraySpan | null {
  const body = content.slice(section.start, section.end);
  const assignment = /^[ \t]*enabled[ \t]*=[ \t]*\[/m.exec(body);
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
  const lineIsOnlyElement =
    /^[ \t]*$/.test(before) && (/^[ \t]*(#.*)?$/.test(after) || after.trim() === '');
  if (lineIsOnlyElement && lineStart > span.open && lineEnd - 1 <= span.close + 1) {
    return content.slice(0, lineStart) + content.slice(lineEnd);
  }

  return content.slice(0, removeStart) + content.slice(removeEnd);
}

export interface EditSelectionOptions {
  type: ComponentType | 'plugins';
  enable?: readonly string[];
  disable?: readonly string[];
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
  const filePath = userConfigPath(homes, env);

  const additionsInput = normalizeIds(options.enable ?? []);
  const removals = new Set(normalizeIds(options.disable ?? []));

  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  let content = original;

  const sectionName = options.type;
  let section = findSection(content, sectionName);

  const currentValues = (): string[] => {
    const span = section && findEnabledArray(content, section);
    if (!span) return [];
    return arrayElements(content, span).map((element) => element.value);
  };

  const existing = new Set(currentValues());
  const additions = additionsInput.filter((id) => !existing.has(id));

  if (additions.length > 0) {
    if (!section) {
      const separator =
        content.length === 0 || content.endsWith('\n\n')
          ? ''
          : content.endsWith('\n')
            ? '\n'
            : '\n\n';
      content += `${separator}[${sectionName}]\nenabled = ${renderArray(additions)}\n`;
      section = findSection(content, sectionName);
    } else {
      const span = findEnabledArray(content, section);
      if (!span) {
        const insertAt = section.start;
        content = `${content.slice(0, insertAt)}\nenabled = ${renderArray(additions)}${content.slice(insertAt)}`;
      } else {
        content = spliceInto(content, span, additions);
      }
      section = findSection(content, sectionName);
    }
  }

  if (removals.size > 0 && section) {
    let span = findEnabledArray(content, section);
    while (span) {
      const target = arrayElements(content, span).find((element) => removals.has(element.value));
      if (!target) break;
      content = spliceOut(content, span, target);
      section = findSection(content, sectionName);
      span = section ? findEnabledArray(content, section) : null;
    }
  }

  if (content === original) return;

  try {
    parseToml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Selection edit produced invalid TOML for ${filePath} (left untouched): ${message}`
    );
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.asb-tmp-${process.pid}`
  );
  fs.writeFileSync(temp, content, 'utf-8');
  fs.renameSync(temp, filePath);
}
