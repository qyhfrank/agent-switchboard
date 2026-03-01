/**
 * Plugin component loader: extracts commands, agents, skills, and hooks from a
 * resolved plugin directory and maps them to ASB library entry formats.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CommandEntry } from '../commands/library.js';
import type { HookEntry } from '../hooks/library.js';
import { hookFileSchema } from '../hooks/schema.js';
import { parseLibraryMarkdown } from '../library/parser.js';
import { parseSkillMarkdown } from '../skills/parser.js';
import type { SkillFrontmatter } from '../skills/schema.js';
import type { SubagentEntry } from '../subagents/library.js';
import type { ResolvedPlugin } from './reader.js';

export interface SkillEntryFromPlugin {
  id: string;
  bareId: string;
  namespace: string;
  source: string;
  dirPath: string;
  skillPath: string;
  metadata: SkillFrontmatter;
  content: string;
}

export interface PluginComponents {
  commands: CommandEntry[];
  agents: SubagentEntry[];
  skills: SkillEntryFromPlugin[];
  hooks: HookEntry[];
}

const SKILL_FILE = 'SKILL.md';

function isMarkdownFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

/**
 * Load all components (commands, agents, skills) from a single plugin directory.
 * The namespace is the plugin name, producing IDs like "plugin-name:component-id".
 */
export function loadPluginComponents(plugin: ResolvedPlugin): PluginComponents {
  const namespace = plugin.name;
  const result: PluginComponents = { commands: [], agents: [], skills: [], hooks: [] };

  result.commands = loadMarkdownEntries<CommandEntry>(
    path.join(plugin.localPath, 'commands'),
    namespace,
    'command'
  );

  result.agents = loadMarkdownEntries<SubagentEntry>(
    path.join(plugin.localPath, 'agents'),
    namespace,
    'agent'
  );

  result.skills = loadSkillEntries(plugin.localPath, namespace);
  result.hooks = loadHookEntries(plugin.localPath, namespace);

  return result;
}

/**
 * Load markdown-based library entries (commands or agents) from a directory.
 */
function loadMarkdownEntries<T extends CommandEntry | SubagentEntry>(
  directory: string,
  namespace: string,
  kind: string
): T[] {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const result: T[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseLibraryMarkdown(rawContent);
      const bareId = toId(entry.name);
      const id = `${namespace}:${bareId}`;

      result.push({
        id,
        bareId,
        namespace,
        source: directory,
        filePath: absolutePath,
        metadata: parsed.metadata,
        content: parsed.content,
      } as T);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse plugin ${kind} "${entry.name}": ${msg}`);
    }
  }

  return result;
}

/**
 * Load skill entries from a plugin's skills/ directory.
 * Each subdirectory containing SKILL.md is a skill bundle.
 */
function loadSkillEntries(pluginDir: string, namespace: string): SkillEntryFromPlugin[] {
  const skillsDir = path.join(pluginDir, 'skills');
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return [];
  }

  const result: SkillEntryFromPlugin[] = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillPath = path.join(skillDir, SKILL_FILE);
    if (!fs.existsSync(skillPath)) continue;

    try {
      const rawContent = fs.readFileSync(skillPath, 'utf-8');
      const parsed = parseSkillMarkdown(rawContent);
      const bareId = entry.name;
      const id = `${namespace}:${bareId}`;

      result.push({
        id,
        bareId,
        namespace,
        source: skillsDir,
        dirPath: skillDir,
        skillPath,
        metadata: parsed.metadata,
        content: parsed.content,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse plugin skill "${entry.name}": ${msg}`);
    }
  }

  return result;
}

/**
 * Load hook entries from a plugin's hooks/ directory.
 * Supports both single-file hooks (*.json) and bundle hooks (subdirs with hook.json).
 * Claude Code plugins typically have hooks/hooks.json + script files at the same level.
 */
function loadHookEntries(pluginDir: string, namespace: string): HookEntry[] {
  const hooksDir = path.join(pluginDir, 'hooks');
  if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    return [];
  }

  const result: HookEntry[] = [];
  const entries = fs.readdirSync(hooksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
      const absolutePath = path.join(hooksDir, entry.name);
      const rawContent = fs.readFileSync(absolutePath, 'utf-8');

      try {
        const parsed = hookFileSchema.parse(JSON.parse(rawContent));
        const bareId = path.basename(entry.name, '.json');
        const id = `${namespace}:${bareId}`;

        // Detect if script files exist alongside the JSON (bundle-like plugin layout)
        const hasScripts = entries.some((e) => e.isFile() && !e.name.endsWith('.json'));

        result.push({
          id,
          bareId,
          namespace,
          source: hooksDir,
          filePath: absolutePath,
          name: parsed.name,
          description: parsed.description,
          hooks: parsed.hooks,
          isBundle: hasScripts,
          dirPath: hasScripts ? hooksDir : undefined,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse plugin hook "${entry.name}": ${msg}`);
      }
    } else if (entry.isDirectory()) {
      const hookJsonPath = path.join(hooksDir, entry.name, 'hook.json');
      if (!fs.existsSync(hookJsonPath)) continue;

      try {
        const rawContent = fs.readFileSync(hookJsonPath, 'utf-8');
        const parsed = hookFileSchema.parse(JSON.parse(rawContent));
        const bareId = entry.name;
        const id = `${namespace}:${bareId}`;
        const bundleDir = path.join(hooksDir, entry.name);

        result.push({
          id,
          bareId,
          namespace,
          source: hooksDir,
          filePath: hookJsonPath,
          name: parsed.name,
          description: parsed.description,
          hooks: parsed.hooks,
          isBundle: true,
          dirPath: bundleDir,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse plugin hook bundle "${entry.name}": ${msg}`);
      }
    }
  }

  return result;
}
