import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type ComponentType, resolveHomes } from './config.js';
import { type BundleFile, listBundleFiles } from './shapes.js';

/**
 * Library scan: content directories under the asb home become Components.
 * Scanning creates nothing on disk; a malformed entry becomes a failed
 * component carrying its parser message and path, never a thrown run.
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
}

export interface FailedComponent {
  type: ComponentType;
  id: string;
  source: string;
  path: string;
  error: string;
}

export interface LibraryInventory {
  components: Component[];
  failed: FailedComponent[];
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

interface ScanTarget {
  type: ComponentType;
  directory: string;
}

function scanRulesDirectory(target: ScanTarget, inventory: LibraryInventory): void {
  if (!fs.existsSync(target.directory)) return;

  const entries = fs.readdirSync(target.directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(target.directory, entry.name);
    const id = componentIdFromFile(entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: target.type,
        id,
        source: 'library',
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
        source: 'library',
        path: absolutePath,
        content: parsed.content,
        metadata: parsed.metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: target.type,
        id,
        source: 'library',
        path: absolutePath,
        error: message,
      });
    }
  }
}

const SKILL_FILE = 'SKILL.md';

/**
 * Skills scan: each non-dot child directory of <asbHome>/skills/ holding a
 * SKILL.md is one component whose id is the directory name; the component
 * path is the bundle directory. Directories without a SKILL.md are not
 * skills and are skipped silently. A malformed SKILL.md fails that entry
 * with the frozen 0.4.35 error string (0.4 aborted the whole run instead).
 */
function scanSkillsDirectory(directory: string, inventory: LibraryInventory): void {
  if (!fs.existsSync(directory)) return;

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const dirPath = path.join(directory, entry.name);
    const skillPath = path.join(dirPath, SKILL_FILE);
    if (!fs.existsSync(skillPath)) continue;

    try {
      const parsed = parseFrontmatterMarkdown(
        fs.readFileSync(skillPath, 'utf-8'),
        skillMetadataSchema,
        'Skill'
      );
      inventory.components.push({
        type: 'skills',
        id: entry.name,
        source: 'library',
        path: dirPath,
        content: parsed.content,
        metadata: parsed.metadata,
        files: listBundleFiles(dirPath),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inventory.failed.push({
        type: 'skills',
        id: entry.name,
        source: 'library',
        path: skillPath,
        error: `Failed to parse skill "${entry.name}": ${message}`,
      });
    }
  }
}

const HOOK_FILE = 'hook.json';

/**
 * Hooks scan: `<asbHome>/hooks/<id>.json` is a definition entry, and a child
 * directory holding `hook.json` is a bundle entry whose files are distributed
 * beside the app config. A malformed entry fails alone (0.4 threw and aborted
 * the whole load).
 */
function scanHooksDirectory(directory: string, inventory: LibraryInventory): void {
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

    const id = isBundle ? entry.name : componentIdFromFile(entry.name);
    const filePath = isBundle ? path.join(entryPath, HOOK_FILE) : entryPath;
    try {
      const parsed = hookFileSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      inventory.components.push({
        type: 'hooks',
        id,
        source: 'library',
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
        source: 'library',
        path: filePath,
        error: `Failed to parse hook "${id}": ${message}`,
      });
    }
  }
}

export interface ScanOptions {
  types?: readonly ComponentType[];
  env?: NodeJS.ProcessEnv;
}

export function scanLibrary(opts: ScanOptions = {}): LibraryInventory {
  const homes = resolveHomes(opts.env ?? process.env);
  const wanted = new Set<ComponentType>(opts.types ?? ['rules', 'skills', 'hooks']);
  const inventory: LibraryInventory = { components: [], failed: [] };

  if (wanted.has('rules')) {
    scanRulesDirectory({ type: 'rules', directory: path.join(homes.asbHome, 'rules') }, inventory);
  }
  if (wanted.has('skills')) {
    scanSkillsDirectory(path.join(homes.asbHome, 'skills'), inventory);
  }
  if (wanted.has('hooks')) {
    scanHooksDirectory(path.join(homes.asbHome, 'hooks'), inventory);
  }

  inventory.components.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  inventory.failed.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  return inventory;
}
