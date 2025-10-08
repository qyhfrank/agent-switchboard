import path from 'node:path';
import { getClaudeDir, getOpencodePath } from '../config/paths.js';
import {
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
} from '../library/distribute.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadLibraryStateSection } from '../library/state.js';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { loadSubagentLibrary, type SubagentEntry } from './library.js';

export type SubagentPlatform = 'claude-code' | 'opencode';

export interface SubagentDistributionResult {
  platform: SubagentPlatform;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export type SubagentDistributionOutcome = DistributeOutcome<SubagentPlatform>;

export function resolveSubagentFilePath(platform: SubagentPlatform, id: string): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'agents', `${id}.md`);
    case 'opencode':
      return getOpencodePath('agent', `${id}.md`);
  }
}

function buildFrontmatterForClaude(entry: SubagentEntry): Record<string, unknown> {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  if (cc && typeof cc === 'object') {
    for (const [k, v] of Object.entries(cc)) base[k] = v;
  }
  return base;
}

function buildFrontmatterForOpencode(entry: SubagentEntry): Record<string, unknown> {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const op = (extras?.opencode as Record<string, unknown>) ?? undefined;
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  if (op && typeof op === 'object') {
    for (const [k, v] of Object.entries(op)) base[k] = v;
  }
  return base;
}

function renderForPlatform(platform: SubagentPlatform, entry: SubagentEntry): string {
  switch (platform) {
    case 'claude-code': {
      const fm = buildFrontmatterForClaude(entry);
      return wrapFrontmatter(fm, entry.content);
    }
    case 'opencode': {
      const fm = buildFrontmatterForOpencode(entry);
      return wrapFrontmatter(fm, entry.content);
    }
  }
}

export function distributeSubagents(): SubagentDistributionOutcome {
  const entries = loadSubagentLibrary();
  const state = loadLibraryStateSection('subagents');
  const activeIds = state.active;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const selected: SubagentEntry[] = [];
  for (const id of activeIds) {
    const e = byId.get(id);
    if (e) selected.push(e);
  }

  const platforms: SubagentPlatform[] = ['claude-code', 'opencode'];

  return distributeLibrary<SubagentEntry, SubagentPlatform>({
    section: 'subagents',
    selected,
    platforms,
    resolveFilePath: (p, e) => resolveSubagentFilePath(p, e.id),
    render: (p, e) => renderForPlatform(p, e),
  }) as { results: DistributionResult<SubagentPlatform>[] };
}
