import fs from 'node:fs';
import path from 'node:path';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type ComponentType, type PluginExpansion, resolveHomes } from './config.js';
import { inferServerType, type McpServerValue } from './dialects.js';
import { type BundleFile, listBundleFiles } from './shapes.js';
import type { PluginDescriptor } from './sources.js';

/**
 * Library scan: content directories under the asb home and under every plugin
 * a configured source contributes become Components. Scanning creates nothing
 * on disk and never reaches the network: an external plugin nobody has fetched
 * yet contributes nothing here. A malformed entry becomes a failed component
 * carrying its parser message and path, never a thrown run.
 */

export interface RuleMetadata {
  title?: string;
  /** Skills: required frontmatter display name (the directory name is the id). */
  name?: string;
  description?: string;
  tags: string[];
  requires: string[];
  [key: string]: unknown;
}

export interface Component {
  type: ComponentType;
  /** `name` | `plugin:name` | `plugin@marketplace:name` */
  id: string;
  /** Owning source: `library` for ~/.asb content dirs, else the plugin name. */
  source: string;
  path: string;
  content: string;
  metadata: RuleMetadata;
  /**
   * Own-dir components: the source bundle's distributable files. Always set
   * for skills; for hooks it is set exactly for bundle entries and absent for
   * single-file definitions, which have nothing to distribute.
   */
  files?: BundleFile[];
  /** Hooks: the app-native event map this entry contributes. */
  hooks?: HookEventMap;
  /** MCP: the server definition, with its transport type inferred. */
  server?: McpServerValue;
}

export interface FailedComponent {
  type: ComponentType;
  id: string;
  source: string;
  path: string;
  error: string;
}

/** A component id a later source repeated: the first reading stays. */
export interface DuplicateComponent {
  type: ComponentType;
  id: string;
  /** The source that lost the id. */
  source: string;
  /** The source whose reading is in the inventory. */
  keptSource: string;
  path: string;
}

export interface LibraryInventory {
  components: Component[];
  failed: FailedComponent[];
  duplicates: DuplicateComponent[];
}

const ruleMetadataSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    requires: z.array(z.string().trim().min(1)).default([]),
  })
  .passthrough();

const skillMetadataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .passthrough();

/** Frozen 0.4.35 hook grammar: an app-native event map with per-type required fields. */
const REQUIRED_HANDLER_FIELD = {
  command: 'command',
  http: 'url',
  prompt: 'prompt',
  agent: 'prompt',
} as const;

const hookHandlerSchema = z
  .object({
    type: z.enum(['command', 'http', 'prompt', 'agent']),
    command: z.string().optional(),
    commandWindows: z.string().optional(),
    command_windows: z.string().optional(),
  })
  .passthrough()
  .refine(
    (handler) => typeof handler[REQUIRED_HANDLER_FIELD[handler.type]] === 'string',
    (handler) => ({
      message: `${handler.type} hook requires ${REQUIRED_HANDLER_FIELD[handler.type]}`,
    })
  );

const hookGroupSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(hookHandlerSchema).min(1),
  })
  .passthrough();

const hookFileSchema = z
  .object({ hooks: z.record(z.string(), z.array(hookGroupSchema)) })
  .passthrough();

export type HookHandler = z.infer<typeof hookHandlerSchema>;
export type HookGroup = z.infer<typeof hookGroupSchema>;
export type HookEventMap = Record<string, HookGroup[]>;

// Frozen 0.4.35 frontmatter grammar: ---\n...\n---\n(optional newline)
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/** Shared frontmatter parse with per-kind schema and frozen error strings. */
function parseFrontmatterMarkdown(
  source: string,
  schema: z.ZodTypeAny,
  label: 'Rule' | 'Skill'
): { metadata: RuleMetadata; content: string } {
  const sanitized = source.replace(/^\uFEFF/, '');
  const match = sanitized.match(FRONTMATTER_PATTERN);

  if (sanitized.trimStart().startsWith('---') && !match) {
    throw new Error(`${label} frontmatter is missing a closing delimiter (---)`);
  }

  let metadataInput: Record<string, unknown> = {};
  let bodyStart = 0;

  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? '') ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse ${label.toLowerCase()} frontmatter: ${message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 0.4 funnels this through the same parse-error prefix as YAML failures.
      throw new Error(
        `Failed to parse ${label.toLowerCase()} frontmatter: ${label} frontmatter must evaluate to an object`
      );
    }
    metadataInput = parsed as Record<string, unknown>;
    bodyStart = match[0].length;
  }

  const metadata = { tags: [], requires: [], ...schema.parse(metadataInput) } as RuleMetadata;
  let body = sanitized.slice(bodyStart);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return { metadata, content: body };
}

function parseRuleMarkdown(source: string): { metadata: RuleMetadata; content: string } {
  return parseFrontmatterMarkdown(source, ruleMetadataSchema, 'Rule');
}

function isMarkdownFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function componentIdFromFile(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

/**
 * Who a scanned directory belongs to. Content under the asb home keeps bare
 * ids; a plugin's content is prefixed with the plugin id, so two sources
 * shipping the same file name stay distinct components.
 */
interface Owner {
  source: string;
  prefix: string;
}

const LIBRARY: Owner = { source: 'library', prefix: '' };

function ownerFor(plugin: PluginDescriptor): Owner {
  return { source: plugin.id, prefix: `${plugin.id}:` };
}

interface ScanTarget {
  type: ComponentType;
  directory: string;
  owner: Owner;
}

function scanRulesDirectory(target: ScanTarget, inventory: LibraryInventory): void {
  if (!fs.existsSync(target.directory)) return;

  const entries = fs.readdirSync(target.directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(target.directory, entry.name);
    const id = target.owner.prefix + componentIdFromFile(entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: target.type,
        id,
        source: target.owner.source,
        path: absolutePath,
        error: message,
      });
      continue;
    }

    try {
      const parsed = parseRuleMarkdown(raw);
      inventory.components.push({
        type: target.type,
        id,
        source: target.owner.source,
        path: absolutePath,
        content: parsed.content,
        metadata: parsed.metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: target.type,
        id,
        source: target.owner.source,
        path: absolutePath,
        error: message,
      });
    }
  }
}

const SKILL_FILE = 'SKILL.md';

/**
 * Skills scan: each non-dot child directory of a skills root holding a
 * SKILL.md is one component whose id is the directory name; the component
 * path is the bundle directory. Directories without a SKILL.md are not
 * skills and are skipped silently. A malformed SKILL.md fails that entry
 * with the frozen 0.4.35 error string (0.4 aborted the whole run instead).
 *
 * A plugin's custom skills path may name the bundle itself rather than a
 * parent of bundles, so such a root is read as one skill when it holds a
 * SKILL.md of its own.
 */
function scanSkillsDirectory(
  directory: string,
  owner: Owner,
  inventory: LibraryInventory,
  allowDirectSkill = false
): void {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return;

  if (allowDirectSkill && fs.existsSync(path.join(directory, SKILL_FILE))) {
    scanSkillBundle(directory, owner, inventory);
    return;
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const dirPath = path.join(directory, entry.name);
    if (!fs.existsSync(path.join(dirPath, SKILL_FILE))) continue;
    scanSkillBundle(dirPath, owner, inventory);
  }
}

function scanSkillBundle(dirPath: string, owner: Owner, inventory: LibraryInventory): void {
  const name = path.basename(dirPath);
  const skillPath = path.join(dirPath, SKILL_FILE);
  try {
    const parsed = parseFrontmatterMarkdown(
      fs.readFileSync(skillPath, 'utf-8'),
      skillMetadataSchema,
      'Skill'
    );
    inventory.components.push({
      type: 'skills',
      id: owner.prefix + name,
      source: owner.source,
      path: dirPath,
      content: parsed.content,
      metadata: parsed.metadata,
      files: listBundleFiles(dirPath),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    inventory.failed.push({
      type: 'skills',
      id: owner.prefix + name,
      source: owner.source,
      path: skillPath,
      error: `Failed to parse skill "${name}": ${message}`,
    });
  }
}

const HOOK_FILE = 'hook.json';

/**
 * A GitHub Copilot v1 hook file shares the hooks/ directory with asb's own
 * grammar, so a plugin shipping one is not shipping a broken asb hook. What
 * separates the two: Copilot declares `version: 1` and maps each event to
 * handlers directly, where an asb event maps to groups that nest their own
 * `hooks` array.
 *
 * ponytail: a shape probe, not 0.4's full Copilot validator (event allow-list,
 * https-only handlers, prompt-only-on-sessionStart). Ceiling: an asb-invalid
 * file carrying `version: 1` and handler-shaped events is skipped silently
 * instead of reported. Upgrade path is validating the events against Copilot's
 * own list, which only ever narrows what this skips.
 */
function isForeignHookFile(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const file = value as { version?: unknown; hooks?: unknown };
  if (file.version !== 1) return false;
  const events = file.hooks;
  if (events === null || typeof events !== 'object' || Array.isArray(events)) return false;
  const handlerLists = Object.values(events as Record<string, unknown>);
  return (
    handlerLists.length > 0 &&
    handlerLists.every(
      (handlers) =>
        Array.isArray(handlers) &&
        handlers.length > 0 &&
        handlers.every(
          (handler) =>
            handler !== null &&
            typeof handler === 'object' &&
            !Array.isArray((handler as { hooks?: unknown }).hooks) &&
            (handler as { hooks?: unknown }).hooks === undefined
        )
    )
  );
}

/**
 * Hooks scan: `<root>/hooks/<id>.json` is a definition entry, and a child
 * directory holding `hook.json` is a bundle entry whose files are distributed
 * beside the app config. A malformed entry fails alone (0.4 threw and aborted
 * the whole load, and for a plugin's single-file hooks only warned).
 */
function scanHooksDirectory(directory: string, owner: Owner, inventory: LibraryInventory): void {
  if (!fs.existsSync(directory)) return;

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    const isBundle = entry.isDirectory();
    if (isBundle) {
      if (!fs.existsSync(path.join(entryPath, HOOK_FILE))) continue;
    } else if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
      continue;
    }

    const id = owner.prefix + (isBundle ? entry.name : componentIdFromFile(entry.name));
    const filePath = isBundle ? path.join(entryPath, HOOK_FILE) : entryPath;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (owner.source !== LIBRARY.source && isForeignHookFile(raw)) continue;
      const parsed = hookFileSchema.parse(raw);
      inventory.components.push({
        type: 'hooks',
        id,
        source: owner.source,
        path: entryPath,
        content: '',
        metadata: { tags: [], requires: [] },
        hooks: parsed.hooks,
        ...(isBundle ? { files: listBundleFiles(entryPath) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: 'hooks',
        id,
        source: owner.source,
        path: filePath,
        error: `Failed to parse hook "${id}": ${message}`,
      });
    }
  }
}

/** Frozen 0.4.35 MCP server grammar: unknown fields reach the target verbatim. */
const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    type: z.enum(['stdio', 'sse', 'http']).optional(),
  })
  .passthrough();

/**
 * MCP is the one type whose components come from a map inside one document
 * rather than a directory of files: `<ASB_HOME>/mcp.json` (JSONC, so comments
 * are legal) and each plugin's server map. Each server becomes a component
 * whose path is the document that defines it. A malformed server fails alone;
 * an unreadable document fails once, under its own name.
 */
function scanMcpServers(
  servers: Record<string, unknown>,
  documentPath: string,
  owner: Owner,
  inventory: LibraryInventory
): void {
  for (const [name, definition] of Object.entries(servers)) {
    const id = owner.prefix + name;
    try {
      inventory.components.push({
        type: 'mcp',
        id,
        source: owner.source,
        path: documentPath,
        content: '',
        metadata: { tags: [], requires: [] },
        server: inferServerType(mcpServerSchema.parse(definition) as McpServerValue),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: 'mcp',
        id,
        source: owner.source,
        path: documentPath,
        error: `Failed to parse MCP server "${name}": ${message}`,
      });
    }
  }
}

function scanMcpDocument(filePath: string, owner: Owner, inventory: LibraryInventory): void {
  if (!fs.existsSync(filePath)) return;
  const name = path.basename(filePath);
  const fail = (reason: string): void => {
    inventory.failed.push({
      type: 'mcp',
      id: name,
      source: owner.source,
      path: filePath,
      error: `Failed to parse ${name}: ${reason}`,
    });
  };

  const errors: ParseError[] = [];
  let parsed: unknown;
  try {
    parsed = parseJsonc(fs.readFileSync(filePath, 'utf-8'), errors, { allowTrailingComma: true });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (errors.length > 0) {
    fail(`invalid JSON at offset ${errors[0].offset}`);
    return;
  }
  const servers =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { mcpServers?: unknown }).mcpServers
      : undefined;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    fail('no "mcpServers" object');
    return;
  }
  scanMcpServers(servers as Record<string, unknown>, filePath, owner, inventory);
}

/**
 * A plugin's own paths stay inside the plugin: a path that leaves it
 * lexically, or leaves it once symlinks are followed, is refused rather than
 * read. Throwing here fails the one plugin, never the scan.
 */
function pluginComponentPath(root: string, relative: string): string {
  if (relative.includes('\0') || path.isAbsolute(relative)) {
    throw new Error(`plugin component path must be relative: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  const escapes = (from: string, to: string): boolean => {
    const rel = path.relative(from, to);
    return rel.startsWith('..') || path.isAbsolute(rel);
  };
  if (escapes(root, resolved)) {
    throw new Error(`plugin component path escapes the plugin root: ${relative}`);
  }
  if (fs.existsSync(resolved) && escapes(fs.realpathSync(root), fs.realpathSync(resolved))) {
    throw new Error(`plugin component path escapes the plugin root: ${relative}`);
  }
  return resolved;
}

/**
 * One plugin's contribution. Custom paths declared by a marketplace entry or
 * plugin manifest replace the default directory for that kind; every other
 * kind keeps its default directory.
 */
function scanPlugin(
  plugin: PluginDescriptor,
  root: string,
  wanted: Set<ComponentType>,
  inventory: LibraryInventory
): void {
  const owner = ownerFor(plugin);

  if (wanted.has('rules')) {
    scanRulesDirectory({ type: 'rules', directory: path.join(root, 'rules'), owner }, inventory);
  }

  if (wanted.has('skills')) {
    const custom = plugin.customPaths?.skills;
    if (custom) {
      for (const relative of custom) {
        try {
          const resolved = pluginComponentPath(root, relative);
          // A custom path may name the SKILL.md itself, the bundle holding
          // one, or a parent of bundles.
          if (path.basename(resolved) === SKILL_FILE && fs.existsSync(resolved)) {
            scanSkillBundle(path.dirname(resolved), owner, inventory);
          } else {
            scanSkillsDirectory(resolved, owner, inventory, true);
          }
        } catch (error) {
          inventory.failed.push({
            type: 'skills',
            id: plugin.id,
            source: owner.source,
            path: root,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      scanSkillsDirectory(path.join(root, 'skills'), owner, inventory);
    }
  }

  if (wanted.has('hooks')) {
    scanHooksDirectory(path.join(root, 'hooks'), owner, inventory);
  }

  if (wanted.has('mcp') && plugin.mcpServers) {
    // The reader in sources.ts merges the plugin's `.mcp.json` over its
    // manifest field, so that file is the defining document whenever it is
    // there and the manifest is the document otherwise.
    const file = path.join(root, '.mcp.json');
    const documentPath = fs.existsSync(file) ? file : (plugin.native?.manifestPath ?? root);
    scanMcpServers(plugin.mcpServers, documentPath, owner, inventory);
  }
}

/**
 * First reading of an id wins, in scan order: the asb home, then plugins in
 * source order. The loser is recorded so the run can report which source lost
 * the id rather than silently dropping it.
 */
function dropDuplicates(inventory: LibraryInventory): void {
  const kept = new Map<string, Component>();
  const survivors: Component[] = [];
  for (const component of inventory.components) {
    const key = `${component.type}\u0000${component.id}`;
    const winner = kept.get(key);
    if (winner) {
      inventory.duplicates.push({
        type: component.type,
        id: component.id,
        source: component.source,
        keptSource: winner.source,
        path: component.path,
      });
      continue;
    }
    kept.set(key, component);
    survivors.push(component);
  }
  inventory.components = survivors;
}

/**
 * What the scanned plugins contribute and how their refs spell out. A plugin
 * is nameable by its bare name only while exactly one plugin carries it; an
 * ambiguous bare name resolves to nothing rather than to an arbitrary source,
 * and the ref then reports as missing instead of silently selecting the wrong
 * plugin. Component refs follow their plugin: `<bare-plugin>:<id>` names the
 * canonical `<plugin-id>:<id>` on the same condition.
 */
export function buildPluginExpansion(
  plugins: readonly PluginDescriptor[],
  inventory: LibraryInventory
): PluginExpansion {
  const byPlugin: Record<string, Partial<Record<ComponentType, string[]>>> = {};
  for (const component of inventory.components) {
    if (component.source === LIBRARY.source) continue;
    const types = byPlugin[component.source] ?? {};
    byPlugin[component.source] = types;
    const ids = types[component.type] ?? [];
    types[component.type] = ids;
    ids.push(component.id);
  }

  const claimants = new Map<string, string[]>();
  for (const plugin of plugins) {
    const bucket = claimants.get(plugin.name);
    if (bucket) bucket.push(plugin.id);
    else claimants.set(plugin.name, [plugin.id]);
  }

  // Every consumer resolves a ref by reading this record, so the records carry
  // no prototype: a ref spelled `__proto__` or `constructor` has to answer
  // with nothing rather than with an inherited member.
  const pluginAliases: Record<string, string> = Object.create(null);
  const componentAliases: Record<string, string> = Object.create(null);
  for (const plugin of plugins) {
    pluginAliases[plugin.id] = plugin.id;
    const unambiguous = claimants.get(plugin.name)?.length === 1;
    if (unambiguous && plugin.name !== plugin.id) pluginAliases[plugin.name] = plugin.id;
    for (const ids of Object.values(byPlugin[plugin.id] ?? {})) {
      for (const id of ids) {
        componentAliases[id] = id;
        if (!unambiguous) continue;
        const bare = id.slice(plugin.id.length + 1);
        const alias = `${plugin.name}:${bare}`;
        if (alias !== id) componentAliases[alias] = id;
      }
    }
  }

  return { byPlugin, pluginAliases, componentAliases };
}

export interface ScanOptions {
  types?: readonly ComponentType[];
  env?: NodeJS.ProcessEnv;
  /**
   * Plugins the configured sources contribute, in source order. A plugin that
   * lives in a repository of its own contributes only once something has
   * fetched it: the scan itself never does, so no command pays for a plugin
   * nobody selected.
   */
  plugins?: readonly PluginDescriptor[];
}

export function scanLibrary(opts: ScanOptions = {}): LibraryInventory {
  const homes = resolveHomes(opts.env ?? process.env);
  const wanted = new Set<ComponentType>(opts.types ?? ['rules', 'skills', 'hooks', 'mcp']);
  const inventory: LibraryInventory = { components: [], failed: [], duplicates: [] };

  if (wanted.has('rules')) {
    const directory = path.join(homes.asbHome, 'rules');
    scanRulesDirectory({ type: 'rules', directory, owner: LIBRARY }, inventory);
  }
  if (wanted.has('skills')) {
    scanSkillsDirectory(path.join(homes.asbHome, 'skills'), LIBRARY, inventory);
  }
  if (wanted.has('hooks')) {
    scanHooksDirectory(path.join(homes.asbHome, 'hooks'), LIBRARY, inventory);
  }
  if (wanted.has('mcp')) {
    scanMcpDocument(path.join(homes.asbHome, 'mcp.json'), LIBRARY, inventory);
  }

  for (const plugin of opts.plugins ?? []) {
    if (plugin.root) scanPlugin(plugin, plugin.root, wanted, inventory);
  }

  dropDuplicates(inventory);
  inventory.components.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  inventory.failed.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  return inventory;
}
