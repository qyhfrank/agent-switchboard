import path from 'node:path';
import { stringify as toToml } from '@iarna/toml';
import { getClaudeDir, getCodexDir, getGeminiDir, getOpencodePath } from '../config/paths.js';
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

export function resolveCommandFilePath(platform: CommandPlatform, id: string): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'commands', `${id}.md`);
    case 'codex':
      return path.join(getCodexDir(), 'prompts', `${id}.md`);
    case 'gemini':
      return path.join(getGeminiDir(), 'commands', `${id}.toml`);
    case 'opencode':
      return getOpencodePath('command', `${id}.md`);
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

export function distributeCommands(): CommandDistributionOutcome {
  const entries = loadCommandLibrary();
  const state = loadLibraryStateSection('commands');
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
    resolveFilePath: (p, e) => resolveCommandFilePath(p, e.id),
    render: (p, e) => renderForPlatform(p, e),
  }) as { results: DistributionResult<CommandPlatform>[] };
}
