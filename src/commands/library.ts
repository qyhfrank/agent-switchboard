import fs from 'node:fs';
import path from 'node:path';
import { getCommandsDir } from '../config/paths.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadEntriesFromSources } from '../marketplace/source-loader.js';

export interface CommandEntry {
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

export function ensureCommandsDirectory(): string {
  const directory = getCommandsDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

/**
 * Load commands from a specific directory
 * @param directory - Directory to load commands from
 * @param namespace - Optional namespace prefix for IDs
 */
function loadCommandsFromDirectory(directory: string, namespace?: string): CommandEntry[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const result: CommandEntry[] = [];

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
        throw new Error(`Failed to parse command file "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  return result;
}

/**
 * Load all commands from default library, flat sources, and marketplace sources.
 */
export function loadCommandLibrary(): CommandEntry[] {
  const result: CommandEntry[] = [];

  const defaultDir = ensureCommandsDirectory();
  result.push(...loadCommandsFromDirectory(defaultDir));

  const { flatSources, marketplaceEntries } = loadEntriesFromSources();

  for (const { namespace, basePath } of flatSources) {
    const commandsDir = path.join(basePath, 'commands');
    result.push(...loadCommandsFromDirectory(commandsDir, namespace));
  }

  result.push(...marketplaceEntries.commands);

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
