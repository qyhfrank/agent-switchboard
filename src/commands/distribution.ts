import path from 'node:path';
import { stringify as toToml } from '@iarna/toml';
import {
  getClaudeDir,
  getCodexDir,
  getCursorDir,
  getGeminiDir,
  getOpencodePath,
  getProjectClaudeDir,
  getProjectCursorDir,
  getProjectGeminiDir,
  getProjectOpencodePath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type CleanupConfig,
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
} from '../library/distribute.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadLibraryStateSectionForAgent } from '../library/state.js';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { type CommandEntry, loadCommandLibrary } from './library.js';

export type CommandPlatform = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'opencode';

/**
 * Map platform to agent ID for per-agent configuration lookup
 */
function platformToAgentId(platform: CommandPlatform): string {
  return platform;
}

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
  return path.join(resolveCommandTargetDir(platform, scope), getCommandFilename(platform, id));
}

function resolveCommandTargetDir(platform: CommandPlatform, scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  switch (platform) {
    case 'claude-code': {
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectClaudeDir(projectRoot), 'commands');
      }
      return path.join(getClaudeDir(), 'commands');
    }
    case 'codex': {
      return path.join(getCodexDir(), 'prompts');
    }
    case 'cursor': {
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectCursorDir(projectRoot), 'commands');
      }
      return path.join(getCursorDir(), 'commands');
    }
    case 'gemini': {
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectGeminiDir(projectRoot), 'commands');
      }
      return path.join(getGeminiDir(), 'commands');
    }
    case 'opencode': {
      if (projectRoot && projectRoot.length > 0) {
        return getProjectOpencodePath(projectRoot, 'command');
      }
      return getOpencodePath('command');
    }
  }
}

function getCommandFilename(platform: CommandPlatform, id: string): string {
  return platform === 'gemini' ? `${id}.toml` : `${id}.md`;
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
      return (
        `<!-- [deprecated] Codex custom prompts are deprecated. Consider migrating to skills: https://developers.openai.com/codex/skills -->\n\n` +
        `${header}${entry.content.trimStart()}`
      );
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
    case 'cursor': {
      return `${entry.content.trimEnd()}\n`;
    }
  }
}

export function distributeCommands(scope?: ConfigScope): CommandDistributionOutcome {
  const entries = loadCommandLibrary();
  const byId = new Map(entries.map((e) => [e.id, e]));

  const platforms: CommandPlatform[] = ['claude-code', 'codex', 'cursor', 'gemini', 'opencode'];

  // Cleanup config to remove orphan command files
  const cleanup: CleanupConfig<CommandPlatform> = {
    resolveTargetDir: (p) => resolveCommandTargetDir(p, scope),
    extractId: (filename) => {
      // Try both extensions since we don't know platform in extractId
      if (filename.endsWith('.toml')) return filename.slice(0, -5);
      if (filename.endsWith('.md')) return filename.slice(0, -3);
      return null;
    },
  };

  // Filter entries based on per-agent configuration
  const filterSelected = (
    platform: CommandPlatform,
    _allEntries: CommandEntry[]
  ): CommandEntry[] => {
    const agentId = platformToAgentId(platform);
    const state = loadLibraryStateSectionForAgent('commands', agentId, scope);
    const activeIds = state.active;
    const selected: CommandEntry[] = [];
    for (const id of activeIds) {
      const e = byId.get(id);
      if (e) selected.push(e);
    }
    return selected;
  };

  const outcome = distributeLibrary<CommandEntry, CommandPlatform>({
    section: 'commands',
    selected: entries, // Pass all entries, filtering happens per-platform
    platforms,
    resolveFilePath: (p, e) => resolveCommandFilePath(p, e.id, scope),
    render: (p, e) => renderForPlatform(p, e),
    getId: (e) => e.id,
    cleanup,
    scope,
    filterSelected,
  }) as { results: DistributionResult<CommandPlatform>[] };

  // Warn about Codex custom prompts deprecation
  const codexWrites = outcome.results.filter(
    (r) => r.platform === 'codex' && r.status === 'written'
  );
  if (codexWrites.length > 0) {
    console.warn(
      `[codex] Custom prompts are deprecated. Consider migrating to skills: https://developers.openai.com/codex/skills`
    );
  }

  return outcome;
}
