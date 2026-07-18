import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir } from '../config/paths.js';
import { copyDirRecursive } from '../library/fs.js';
import { parseSkillMarkdown } from './parser.js';

export type SkillImportPlatform = 'claude-code' | 'codex' | 'cursor';

const SKILL_FILE = 'SKILL.md';

interface ImportedSkill {
  /** Skill ID (directory name) */
  id: string;
  /** Skill name from frontmatter */
  name: string;
  /** Source directory path */
  sourcePath: string;
  /** Target directory path in ASB library */
  targetPath: string;
}

interface SkillImportResult {
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
 * Prepare skill import info without actually copying.
 */
function prepareSkillImport(sourceDir: string, skillId: string): ImportedSkill {
  const sourcePath = path.join(sourceDir, skillId);
  const skillPath = path.join(sourcePath, SKILL_FILE);

  if (!fs.existsSync(skillPath)) {
    throw new Error(`SKILL.md not found in ${sourcePath}`);
  }

  const rawContent = fs.readFileSync(skillPath, 'utf-8');
  const parsed = parseSkillMarkdown(rawContent);

  const targetPath = path.join(getSkillsDir(), skillId);

  return {
    id: skillId,
    name: parsed.metadata.name,
    sourcePath,
    targetPath,
  };
}

/**
 * Import a skill from a platform directory to ASB library.
 */
export function importSkill(
  _platform: SkillImportPlatform,
  sourceDir: string,
  skillId: string,
  options?: { force?: boolean }
): SkillImportResult {
  const force = options?.force ?? false;

  try {
    const skill = prepareSkillImport(sourceDir, skillId);

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
    copyDirRecursive(skill.sourcePath, skill.targetPath, { skipHidden: true });

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
      },
      status: 'error',
      error: errorMsg,
    };
  }
}
