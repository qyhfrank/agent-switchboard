import path from 'node:path';
import {
  getClaudeDir,
  getOpencodePath,
  getProjectClaudeDir,
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

export function resolveSubagentFilePath(
  platform: SubagentPlatform,
  id: string,
  scope?: ConfigScope
): string {
  const projectRoot = scope?.project?.trim();
  switch (platform) {
    case 'claude-code': {
      // Project-level supported: .claude/agents/
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectClaudeDir(projectRoot), 'agents', `${id}.md`);
      }
      return path.join(getClaudeDir(), 'agents', `${id}.md`);
    }
    case 'opencode': {
      // Project-level supported: .opencode/agent/
      if (projectRoot && projectRoot.length > 0) {
        return getProjectOpencodePath(projectRoot, 'agent', `${id}.md`);
      }
      return getOpencodePath('agent', `${id}.md`);
    }
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
  // Claude Code requires `name` in frontmatter. If missing/empty, use filename (entry.id).
  const rawName = base.name as unknown as string | undefined;
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    base.name = entry.id;
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

export function distributeSubagents(scope?: ConfigScope): SubagentDistributionOutcome {
  const entries = loadSubagentLibrary();
  const state = loadLibraryStateSection('subagents', scope);
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
    resolveFilePath: (p, e) => resolveSubagentFilePath(p, e.id, scope),
    render: (p, e) => renderForPlatform(p, e),
    scope,
  }) as { results: DistributionResult<SubagentPlatform>[] };
}
