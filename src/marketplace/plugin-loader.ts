/**
 * Plugin component loader: extracts commands, agents, skills, and hooks from a
 * resolved plugin directory and maps them to ASB library entry formats.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

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
const warnedSkippedHookFiles = new Set<string>();
const copilotV1HookEvents = new Set([
  'agentStop',
  'errorOccurred',
  'notification',
  'permissionRequest',
  'postToolUse',
  'postToolUseFailure',
  'preCompact',
  'preToolUse',
  'sessionEnd',
  'sessionStart',
  'subagentStart',
  'subagentStop',
  'userPromptSubmitted',
  'ErrorOccurred',
  'Notification',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
]);
const copilotHttpsOnlyHookEvents = new Set([
  'permissionRequest',
  'preToolUse',
  'PermissionRequest',
  'PreToolUse',
]);

function isCopilotHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
          url.hostname === '[::1]'))
    );
  } catch {
    return false;
  }
}

const copilotCommandHookSchema = z
  .object({
    type: z.literal('command').optional(),
    bash: z.string().optional(),
    command: z.string().optional(),
    powershell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    matcher: z.string().optional(),
    timeout: z.number().optional(),
    timeoutSec: z.number().optional(),
  })
  .passthrough()
  .refine((handler) => handler.bash || handler.command || handler.powershell);
const copilotHookHandlerSchema = z.union([
  copilotCommandHookSchema,
  z
    .object({
      type: z.literal('http'),
      url: z.string().refine(isCopilotHttpUrl),
      headers: z.record(z.string()).optional(),
      allowedEnvVars: z.array(z.string()).optional(),
      matcher: z.string().optional(),
      timeout: z.number().optional(),
      timeoutSec: z.number().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('prompt'), prompt: z.string() }).passthrough(),
]);
const copilotV1HookFileSchema = z
  .object({
    version: z.literal(1),
    disableAllHooks: z.boolean().optional(),
    hooks: z.record(z.array(copilotHookHandlerSchema)),
  })
  .passthrough()
  .refine((file) => Object.keys(file.hooks).every((event) => copilotV1HookEvents.has(event)))
  .refine((file) =>
    Object.entries(file.hooks).every(
      ([event, handlers]) =>
        event === 'sessionStart' ||
        event === 'SessionStart' ||
        handlers.every((handler) => handler.type !== 'prompt')
    )
  )
  .refine((file) =>
    Object.entries(file.hooks).every(([event, handlers]) =>
      handlers.every(
        (handler) =>
          handler.type !== 'http' ||
          new URL(handler.url).protocol === 'https:' ||
          (!copilotHttpsOnlyHookEvents.has(event) && handler.allowedEnvVars === undefined)
      )
    )
  );

function isMarkdownFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function byEntryName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name.localeCompare(b.name);
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

/**
 * Load all components (commands, agents, skills) from a single plugin directory.
 * The namespace defaults to the plugin name, producing IDs like "plugin-name:component-id".
 *
 * When `customPaths` is present on the plugin (from strict mode resolution),
 * entries are loaded from those paths instead of the default component directories.
 */
export function loadPluginComponents(
  plugin: ResolvedPlugin,
  namespace = plugin.name
): PluginComponents {
  const result: PluginComponents = { commands: [], agents: [], skills: [], hooks: [] };

  if (plugin.customPaths?.commands) {
    result.commands = loadFromCustomPaths<CommandEntry>(
      plugin.localPath,
      plugin.customPaths.commands,
      namespace,
      'command'
    );
  } else {
    result.commands = loadMarkdownEntries<CommandEntry>(
      path.join(plugin.localPath, 'commands'),
      namespace,
      'command'
    );
  }

  if (plugin.customPaths?.agents) {
    result.agents = loadFromCustomPaths<SubagentEntry>(
      plugin.localPath,
      plugin.customPaths.agents,
      namespace,
      'agent'
    );
  } else {
    result.agents = loadMarkdownEntries<SubagentEntry>(
      path.join(plugin.localPath, 'agents'),
      namespace,
      'agent'
    );
  }

  result.skills = plugin.customPaths?.skills
    ? loadSkillEntriesFromCustomPaths(plugin.localPath, plugin.customPaths.skills, namespace)
    : loadSkillEntries(plugin.localPath, namespace);
  result.hooks = loadPluginHookEntries(plugin.localPath, namespace);

  return result;
}

/**
 * Load entries from explicit file paths (custom component paths from marketplace/plugin.json).
 * Paths are relative to the plugin root. Supports glob-like patterns for directory refs.
 */
function loadFromCustomPaths<T extends CommandEntry | SubagentEntry>(
  pluginRoot: string,
  customPaths: string[],
  namespace: string,
  kind: string
): T[] {
  const result: T[] = [];

  for (const customPath of customPaths) {
    const absolutePath = path.resolve(pluginRoot, customPath);

    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
      result.push(...loadMarkdownEntries<T>(absolutePath, namespace, kind));
      continue;
    }

    if (!fs.existsSync(absolutePath)) continue;
    if (!isMarkdownFile(path.basename(absolutePath))) continue;

    try {
      const rawContent = fs.readFileSync(absolutePath, 'utf-8');
      const parsed = parseLibraryMarkdown(rawContent);
      const bareId = toId(path.basename(absolutePath));
      const id = `${namespace}:${bareId}`;

      result.push({
        id,
        bareId,
        namespace,
        source: path.dirname(absolutePath),
        filePath: absolutePath,
        metadata: parsed.metadata,
        content: parsed.content,
      } as T);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse plugin ${kind} at custom path "${customPath}": ${msg}`);
    }
  }

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

  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort(byEntryName);
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
  return loadSkillEntriesFromDirectory(path.join(pluginDir, 'skills'), namespace, false);
}

function loadSkillEntriesFromCustomPaths(
  pluginRoot: string,
  customPaths: string[],
  namespace: string
): SkillEntryFromPlugin[] {
  const result: SkillEntryFromPlugin[] = [];

  for (const customPath of customPaths) {
    const absolutePath = path.resolve(pluginRoot, customPath);
    if (
      fs.existsSync(absolutePath) &&
      fs.statSync(absolutePath).isFile() &&
      path.basename(absolutePath) === SKILL_FILE
    ) {
      const skillDir = path.dirname(absolutePath);
      result.push(parseSkillEntry(skillDir, skillDir, namespace));
      continue;
    }

    result.push(...loadSkillEntriesFromDirectory(absolutePath, namespace, true));
  }

  return result;
}

function loadSkillEntriesFromDirectory(
  skillsDir: string,
  namespace: string,
  allowDirectSkill: boolean
): SkillEntryFromPlugin[] {
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return [];
  }

  const directSkillPath = path.join(skillsDir, SKILL_FILE);
  if (allowDirectSkill && fs.existsSync(directSkillPath)) {
    return [parseSkillEntry(skillsDir, skillsDir, namespace)];
  }

  const result: SkillEntryFromPlugin[] = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).sort(byEntryName);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillPath = path.join(skillDir, SKILL_FILE);
    if (!fs.existsSync(skillPath)) continue;

    result.push(parseSkillEntry(skillDir, skillsDir, namespace));
  }

  return result;
}

function parseSkillEntry(
  skillDir: string,
  skillsDir: string,
  namespace: string
): SkillEntryFromPlugin {
  const skillPath = path.join(skillDir, SKILL_FILE);
  const bareId = path.basename(skillDir);

  try {
    const rawContent = fs.readFileSync(skillPath, 'utf-8');
    const parsed = parseSkillMarkdown(rawContent);
    const id = `${namespace}:${bareId}`;

    return {
      id,
      bareId,
      namespace,
      source: skillsDir,
      dirPath: skillDir,
      skillPath,
      metadata: parsed.metadata,
      content: parsed.content,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse plugin skill "${bareId}": ${msg}`);
  }
}

/**
 * Load hook entries from a plugin's hooks/ directory.
 * Supports both single-file hooks (*.json) and bundle hooks (subdirs with hook.json).
 * Claude Code plugins typically have hooks/hooks.json + script files at the same level.
 */
export function loadPluginHookEntries(pluginDir: string, namespace: string): HookEntry[] {
  const hooksDir = path.join(pluginDir, 'hooks');
  if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    return [];
  }

  const result: HookEntry[] = [];
  const entries = fs.readdirSync(hooksDir, { withFileTypes: true }).sort(byEntryName);

  for (const entry of entries) {
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
      const absolutePath = path.join(hooksDir, entry.name);

      try {
        const rawContent = fs.readFileSync(absolutePath, 'utf-8');
        const parsedJson = JSON.parse(rawContent);
        if (copilotV1HookFileSchema.safeParse(parsedJson).success) continue;
        const parsed = hookFileSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw parsed.error;
        }
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
          name: parsed.data.name,
          description: parsed.data.description,
          hooks: parsed.data.hooks,
          isBundle: hasScripts,
          dirPath: hasScripts ? hooksDir : undefined,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const warningKey = `${namespace}:${absolutePath}`;
        if (!warnedSkippedHookFiles.has(warningKey)) {
          warnedSkippedHookFiles.add(warningKey);
          console.warn(`[plugins] Skipping plugin hook "${namespace}:${entry.name}": ${msg}`);
        }
      }
    } else if (entry.isDirectory()) {
      const hookJsonPath = path.join(hooksDir, entry.name, 'hook.json');
      if (!fs.existsSync(hookJsonPath)) continue;

      try {
        const rawContent = fs.readFileSync(hookJsonPath, 'utf-8');
        const parsedJson = JSON.parse(rawContent);
        const parsed = hookFileSchema.parse(parsedJson);
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
