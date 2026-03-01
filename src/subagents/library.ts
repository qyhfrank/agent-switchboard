import fs from 'node:fs';
import path from 'node:path';
import { getAgentsDir } from '../config/paths.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadEntriesFromSources } from '../marketplace/source-loader.js';

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

export function ensureAgentsDirectory(): string {
  const directory = getAgentsDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

function loadAgentsFromDirectory(directory: string, namespace?: string): SubagentEntry[] {
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
        throw new Error(`Failed to parse agent file "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  return result;
}

/**
 * Load all agents from default library, flat sources, and marketplace sources.
 */
export function loadSubagentLibrary(): SubagentEntry[] {
  const result: SubagentEntry[] = [];

  const defaultDir = ensureAgentsDirectory();
  result.push(...loadAgentsFromDirectory(defaultDir));

  const { flatSources, marketplaceEntries } = loadEntriesFromSources();

  for (const { namespace, basePath } of flatSources) {
    const agentsDir = path.join(basePath, 'agents');
    result.push(...loadAgentsFromDirectory(agentsDir, namespace));
  }

  result.push(...marketplaceEntries.agents);

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
