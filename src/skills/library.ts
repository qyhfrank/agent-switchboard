import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir } from '../config/paths.js';
import { getSourcesRecord } from '../library/sources.js';
import { parseSkillMarkdown } from './parser.js';
import type { SkillFrontmatter } from './schema.js';

export interface SkillEntry {
  /** Skill identifier (may include namespace prefix) */
  id: string;
  /** Original skill identifier without namespace */
  bareId: string;
  /** Namespace name (undefined for default library) */
  namespace?: string;
  /** Source library path */
  source: string;
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
 * Load skills from a specific directory
 * @param directory - Directory to load skills from
 * @param namespace - Optional namespace prefix for IDs
 */
function loadSkillsFromDirectory(directory: string, namespace?: string): SkillEntry[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

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
      const bareId = entry.name;
      const id = namespace ? `${namespace}:${bareId}` : bareId;

      // Warn if directory name doesn't match skill name
      if (parsed.metadata.name !== entry.name) {
        console.warn(
          `Warning: Skill folder "${entry.name}" differs from frontmatter name "${parsed.metadata.name}"`
        );
      }

      result.push({
        id,
        bareId,
        namespace,
        source: directory,
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

  return result;
}

/**
 * Load all skills from default library and external sources.
 * Each skill is a directory containing a SKILL.md file.
 */
export function loadSkillLibrary(): SkillEntry[] {
  const result: SkillEntry[] = [];

  // Load from default library (no namespace)
  const defaultDir = ensureSkillsDirectory();
  result.push(...loadSkillsFromDirectory(defaultDir));

  const sources = getSourcesRecord();
  for (const [namespace, basePath] of Object.entries(sources)) {
    const skillsDir = path.join(basePath, 'skills');
    result.push(...loadSkillsFromDirectory(skillsDir, namespace));
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
