import path from 'node:path';
import { stringify as toToml } from '@iarna/toml';
import {
  getClaudeDir,
  getCodexDir,
  getGeminiDir,
  getOpencodePath,
  getProjectClaudeDir,
  getProjectGeminiDir,
  getProjectOpencodePath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
} from '../library/distribute.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadLibraryStateSection } from '../library/state.js';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { type CommandEntry, loadCommandLibrary } from './library.js';

export type CommandPlatform = 'claude-code' | 'codex' | 'gemini' | 'opencode';

export interface CommandDistributionResult {
  platform: CommandPlatform;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export type CommandDistributionOutcome = DistributeOutcome<CommandPlatform>;

export function resolveCommandFilePath(
  platform: CommandPlatform,
  id: string,
  scope?: ConfigScope
): string {
  const projectRoot = scope?.project?.trim();
  switch (platform) {
    case 'claude-code': {
      // Project-level supported: .claude/commands/
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectClaudeDir(projectRoot), 'commands', `${id}.md`);
      }
      return path.join(getClaudeDir(), 'commands', `${id}.md`);
    }
    case 'codex': {
      // Project-level prompts not supported (per docs): always global
      return path.join(getCodexDir(), 'prompts', `${id}.md`);
    }
    case 'gemini': {
      // Project-level supported: .gemini/commands/
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectGeminiDir(projectRoot), 'commands', `${id}.toml`);
      }
      return path.join(getGeminiDir(), 'commands', `${id}.toml`);
    }
    case 'opencode': {
      // Project-level supported: .opencode/command/
      if (projectRoot && projectRoot.length > 0) {
        return getProjectOpencodePath(projectRoot, 'command', `${id}.md`);
      }
      return getOpencodePath('command', `${id}.md`);
    }
  }
}

function buildFrontmatterForClaude(entry: CommandEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
  if (cc && typeof cc === 'object') {
    for (const [k, v] of Object.entries(cc)) base[k] = v;
  }
  return base;
}

function buildFrontmatterForOpencode(entry: CommandEntry): Record<string, unknown> {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const opencode = (extras?.opencode as Record<string, unknown>) ?? undefined;
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  if (opencode && typeof opencode === 'object') {
    for (const [k, v] of Object.entries(opencode)) base[k] = v;
  }
  return base;
}

function renderForPlatform(platform: CommandPlatform, entry: CommandEntry): string {
  switch (platform) {
    case 'claude-code': {
      const fm = buildFrontmatterForClaude(entry);
      return wrapFrontmatter(fm, entry.content);
    }
    case 'codex': {
      const desc = entry.metadata.description?.trim();
      const header = desc && desc.length > 0 ? `<!-- ${desc} -->\n\n` : '';
      return `${header}${entry.content.trimStart()}`;
    }
    case 'gemini': {
      const extras = (entry.metadata as LibraryFrontmatter).extras as
        | Record<string, unknown>
        | undefined;
      const g = (extras?.gemini as Record<string, unknown>) ?? undefined;
      const obj: Record<string, unknown> = {
        prompt: entry.content.trimStart(),
      };
      if (entry.metadata.description) obj.description = entry.metadata.description;
      if (g && typeof g === 'object') {
        for (const [k, v] of Object.entries(g)) obj[k] = v;
      }
      // biome-ignore lint/suspicious/noExplicitAny: TOML stringify expects JSON-like values; cast is safe here
      return toToml(obj as any);
    }
    case 'opencode': {
      const fm = buildFrontmatterForOpencode(entry);
      return wrapFrontmatter(fm, entry.content);
    }
  }
}

export function distributeCommands(scope?: ConfigScope): CommandDistributionOutcome {
  const entries = loadCommandLibrary();
  const state = loadLibraryStateSection('commands', scope);
  const activeIds = state.active;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const selected: CommandEntry[] = [];
  for (const id of activeIds) {
    const e = byId.get(id);
    if (e) selected.push(e);
  }

  const platforms: CommandPlatform[] = ['claude-code', 'codex', 'gemini', 'opencode'];

  return distributeLibrary<CommandEntry, CommandPlatform>({
    section: 'commands',
    selected,
    platforms,
    resolveFilePath: (p, e) => resolveCommandFilePath(p, e.id, scope),
    render: (p, e) => renderForPlatform(p, e),
    scope,
  }) as { results: DistributionResult<CommandPlatform>[] };
}
