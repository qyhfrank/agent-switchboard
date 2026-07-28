import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type ComponentType, resolveHomes } from './config.js';

/**
 * Library scan: content directories under the asb home become Components.
 * Scanning creates nothing on disk; a malformed entry becomes a failed
 * component carrying its parser message and path, never a thrown run.
 */

export interface RuleMetadata {
  title?: string;
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

// Frozen 0.4.35 frontmatter grammar: ---\n...\n---\n(optional newline)
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function parseRuleMarkdown(source: string): { metadata: RuleMetadata; content: string } {
  const sanitized = source.replace(/^\uFEFF/, '');
  const match = sanitized.match(FRONTMATTER_PATTERN);

  if (sanitized.trimStart().startsWith('---') && !match) {
    throw new Error('Rule frontmatter is missing a closing delimiter (---)');
  }

  let metadataInput: Record<string, unknown> = {};
  let bodyStart = 0;

  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? '') ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse rule frontmatter: ${message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Rule frontmatter must evaluate to an object');
    }
    metadataInput = parsed as Record<string, unknown>;
    bodyStart = match[0].length;
  }

  const metadata = ruleMetadataSchema.parse(metadataInput) as RuleMetadata;
  let body = sanitized.slice(bodyStart);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return { metadata, content: body };
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

export interface ScanOptions {
  types?: readonly ComponentType[];
  env?: NodeJS.ProcessEnv;
}

export function scanLibrary(opts: ScanOptions = {}): LibraryInventory {
  const homes = resolveHomes(opts.env ?? process.env);
  const wanted = new Set<ComponentType>(opts.types ?? ['rules']);
  const inventory: LibraryInventory = { components: [], failed: [] };

  if (wanted.has('rules')) {
    scanRulesDirectory({ type: 'rules', directory: path.join(homes.asbHome, 'rules') }, inventory);
  }

  inventory.components.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  inventory.failed.sort((a, b) =>
    a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)
  );
  return inventory;
}
