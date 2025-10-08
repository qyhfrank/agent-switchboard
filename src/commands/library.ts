import fs from 'node:fs';
import path from 'node:path';
import { getCommandsDir } from '../config/paths.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import type { LibraryFrontmatter } from '../library/schema.js';

export interface CommandEntry {
  id: string;
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

export function loadCommandLibrary(): CommandEntry[] {
  const directory = ensureCommandsDirectory();
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  const result: CommandEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseLibraryMarkdown(rawContent);
      result.push({
        id: toId(entry.name),
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

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
