import fs from 'node:fs';
import path from 'node:path';
import { getSubagentsDir } from '../config/paths.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { getSubscriptionsRecord } from '../library/subscriptions.js';

export interface SubagentEntry {
  id: string;
  bareId: string;
  namespace?: string;
  source: string;
  filePath: string;
  metadata: LibraryFrontmatter;
  content: string;
}

function isMarkdownFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

export function ensureSubagentsDirectory(): string {
  const directory = getSubagentsDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

/**
 * Load subagents from a specific directory
 * @param directory - Directory to load subagents from
 * @param namespace - Optional namespace prefix for IDs
 */
function loadSubagentsFromDirectory(directory: string, namespace?: string): SubagentEntry[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const result: SubagentEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseLibraryMarkdown(rawContent);
      const bareId = toId(entry.name);
      const id = namespace ? `${namespace}:${bareId}` : bareId;

      result.push({
        id,
        bareId,
        namespace,
        source: directory,
        filePath: absolutePath,
        metadata: parsed.metadata,
        content: parsed.content,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse subagent file "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  return result;
}

/**
 * Load all subagents from default library and subscribed libraries
 */
export function loadSubagentLibrary(): SubagentEntry[] {
  const result: SubagentEntry[] = [];

  // Load from default library (no namespace)
  const defaultDir = ensureSubagentsDirectory();
  result.push(...loadSubagentsFromDirectory(defaultDir));

  // Load from subscribed libraries (with namespace prefix)
  const subscriptions = getSubscriptionsRecord();
  for (const [namespace, basePath] of Object.entries(subscriptions)) {
    const subagentsDir = path.join(basePath, 'subagents');
    result.push(...loadSubagentsFromDirectory(subagentsDir, namespace));
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
