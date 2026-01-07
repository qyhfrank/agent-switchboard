import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir } from '../config/paths.js';
import { parseSkillMarkdown } from './parser.js';

export type SkillImportPlatform = 'claude-code' | 'codex';

const SKILL_FILE = 'SKILL.md';

export interface ImportedSkill {
  /** Skill ID (directory name) */
  id: string;
  /** Skill name from frontmatter */
  name: string;
  /** Source directory path */
  sourcePath: string;
  /** Target directory path in ASB library */
  targetPath: string;
  /** Number of files to copy */
  fileCount: number;
}

export interface SkillImportResult {
  skill: ImportedSkill;
  status: 'success' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

/**
 * List all skill directories in a source directory.
 * Returns directories that contain a SKILL.md file.
 */
export function listSkillsInDirectory(sourceDir: string): string[] {
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories
    if (entry.name.startsWith('.')) continue;

    const skillPath = path.join(sourceDir, entry.name, SKILL_FILE);
    if (fs.existsSync(skillPath)) {
      result.push(entry.name);
    }
  }

  return result.sort();
}

/**
 * Count files in a directory recursively.
 */
function countFilesRecursive(dir: string): number {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      count += countFilesRecursive(fullPath);
    } else if (entry.isFile()) {
      count++;
    }
  }

  return count;
}

/**
 * Copy a directory recursively.
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/directories (like .git)
    if (entry.name.startsWith('.')) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);

      // Preserve executable permission
      try {
        const srcMode = fs.statSync(srcPath).mode;
        if (srcMode & 0o111) {
          fs.chmodSync(destPath, srcMode & 0o777);
        }
      } catch {
        // Ignore permission errors
      }
    }
  }
}

/**
 * Prepare skill import info without actually copying.
 */
export function prepareSkillImport(
  _platform: SkillImportPlatform,
  sourceDir: string,
  skillId: string
): ImportedSkill {
  const sourcePath = path.join(sourceDir, skillId);
  const skillPath = path.join(sourcePath, SKILL_FILE);

  if (!fs.existsSync(skillPath)) {
    throw new Error(`SKILL.md not found in ${sourcePath}`);
  }

  const rawContent = fs.readFileSync(skillPath, 'utf-8');
  const parsed = parseSkillMarkdown(rawContent);

  const targetPath = path.join(getSkillsDir(), skillId);
  const fileCount = countFilesRecursive(sourcePath);

  return {
    id: skillId,
    name: parsed.metadata.name,
    sourcePath,
    targetPath,
    fileCount,
  };
}

/**
 * Import a skill from a platform directory to ASB library.
 */
export function importSkill(
  platform: SkillImportPlatform,
  sourceDir: string,
  skillId: string,
  options?: { force?: boolean }
): SkillImportResult {
  const force = options?.force ?? false;

  try {
    const skill = prepareSkillImport(platform, sourceDir, skillId);

    // Check if target already exists
    if (fs.existsSync(skill.targetPath)) {
      if (!force) {
        return {
          skill,
          status: 'skipped',
          reason: 'already exists (use --force to overwrite)',
        };
      }
      // Remove existing directory for force overwrite
      fs.rmSync(skill.targetPath, { recursive: true });
    }

    // Copy skill directory
    copyDirRecursive(skill.sourcePath, skill.targetPath);

    return {
      skill,
      status: 'success',
      reason: force ? 'overwritten' : 'created',
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      skill: {
        id: skillId,
        name: skillId,
        sourcePath: path.join(sourceDir, skillId),
        targetPath: path.join(getSkillsDir(), skillId),
        fileCount: 0,
      },
      status: 'error',
      error: errorMsg,
    };
  }
}

/**
 * Import all skills from a platform directory.
 */
export function importAllSkills(
  platform: SkillImportPlatform,
  sourceDir: string,
  options?: { force?: boolean; filter?: (id: string) => boolean }
): SkillImportResult[] {
  const skillIds = listSkillsInDirectory(sourceDir);
  const results: SkillImportResult[] = [];

  for (const id of skillIds) {
    // Apply filter if provided
    if (options?.filter && !options.filter(id)) {
      continue;
    }

    const result = importSkill(platform, sourceDir, id, { force: options?.force });
    results.push(result);
  }

  return results;
}
