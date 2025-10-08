import fs from 'node:fs';
import path from 'node:path';
import { getSubagentsDir } from '../config/paths.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import type { LibraryFrontmatter } from '../library/schema.js';

export interface SubagentEntry {
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

export function ensureSubagentsDirectory(): string {
  const directory = getSubagentsDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

export function loadSubagentLibrary(): SubagentEntry[] {
  const directory = ensureSubagentsDirectory();
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  const result: SubagentEntry[] = [];

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
        throw new Error(`Failed to parse subagent file "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
