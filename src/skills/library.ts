import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir } from '../config/paths.js';
import { parseSkillMarkdown } from './parser.js';
import type { SkillFrontmatter } from './schema.js';

export interface SkillEntry {
  /** Skill identifier (directory name) */
  id: string;
  /** Absolute path to skill directory */
  dirPath: string;
  /** Absolute path to SKILL.md */
  skillPath: string;
  /** Parsed frontmatter metadata */
  metadata: SkillFrontmatter;
  /** SKILL.md body content (without frontmatter) */
  content: string;
}

export interface BundleFile {
  /** Absolute source path */
  sourcePath: string;
  /** Path relative to skill directory */
  relativePath: string;
}

const SKILL_FILE = 'SKILL.md';

export function ensureSkillsDirectory(): string {
  const directory = getSkillsDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

/**
 * Load all skills from the skills library directory.
 * Each skill is a directory containing a SKILL.md file.
 */
export function loadSkillLibrary(): SkillEntry[] {
  const directory = ensureSkillsDirectory();
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  const result: SkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(directory, entry.name);
    const skillPath = path.join(dirPath, SKILL_FILE);

    if (!fs.existsSync(skillPath)) continue;

    const rawContent = fs.readFileSync(skillPath, 'utf-8');

    try {
      const parsed = parseSkillMarkdown(rawContent);

      // Warn if directory name doesn't match skill name
      if (parsed.metadata.name !== entry.name) {
        console.warn(
          `Warning: Skill folder "${entry.name}" differs from frontmatter name "${parsed.metadata.name}"`
        );
      }

      result.push({
        id: entry.name,
        dirPath,
        skillPath,
        metadata: parsed.metadata,
        content: parsed.content,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse skill "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/**
 * List all files in a skill directory for bundle distribution.
 * Recursively walks the directory tree.
 */
export function listSkillFiles(entry: SkillEntry): BundleFile[] {
  const files: BundleFile[] = [];

  function walk(dir: string, prefix: string): void {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      // Skip hidden files/directories (like .git)
      if (item.name.startsWith('.')) continue;

      const sourcePath = path.join(dir, item.name);
      const relativePath = prefix ? path.join(prefix, item.name) : item.name;

      if (item.isDirectory()) {
        walk(sourcePath, relativePath);
      } else if (item.isFile()) {
        files.push({ sourcePath, relativePath });
      }
    }
  }

  walk(entry.dirPath, '');
  return files;
}
