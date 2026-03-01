import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as tomlStringify } from '@iarna/toml';
import {
  getClaudeDir,
  getCodexAgentsDir,
  getCodexConfigPath,
  getCursorDir,
  getOpencodePath,
  getProjectClaudeDir,
  getProjectCursorDir,
  getProjectOpencodePath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type CleanupConfig,
  type DistributeOutcome,
  type DistributionResult,
  type DistributionStatus,
  distributeLibrary,
} from '../library/distribute.js';
import { ensureParentDir } from '../library/fs.js';
import type { LibraryFrontmatter } from '../library/schema.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { loadSubagentLibrary, type SubagentEntry } from './library.js';

export type SubagentPlatform = 'claude-code' | 'opencode' | 'cursor' | 'codex';

type MarkdownPlatform = 'claude-code' | 'opencode' | 'cursor';

function platformToAgentId(platform: SubagentPlatform): string {
  return platform;
}

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
  const dir = resolveSubagentTargetDir(platform, scope);
  const ext = platform === 'codex' ? '.toml' : '.md';
  return path.join(dir, `${id}${ext}`);
}

function resolveSubagentTargetDir(platform: SubagentPlatform, scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  switch (platform) {
    case 'claude-code': {
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectClaudeDir(projectRoot), 'agents');
      }
      return path.join(getClaudeDir(), 'agents');
    }
    case 'opencode': {
      if (projectRoot && projectRoot.length > 0) {
        return getProjectOpencodePath(projectRoot, 'agent');
      }
      return getOpencodePath('agent');
    }
    case 'cursor': {
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectCursorDir(projectRoot), 'agents');
      }
      return path.join(getCursorDir(), 'agents');
    }
    case 'codex': {
      return getCodexAgentsDir();
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown-based platforms (Claude Code, OpenCode, Cursor)
// ---------------------------------------------------------------------------

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

const CURSOR_SUBAGENT_FIELDS = new Set([
  'name',
  'description',
  'model',
  'readonly',
  'is_background',
]);

function buildFrontmatterForCursor(entry: SubagentEntry): Record<string, unknown> {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const cursor = (extras?.cursor as Record<string, unknown>) ?? undefined;
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  base.name = entry.id;
  if (cursor && typeof cursor === 'object') {
    for (const [k, v] of Object.entries(cursor)) {
      if (CURSOR_SUBAGENT_FIELDS.has(k)) base[k] = v;
    }
  }
  if (!base.name) base.name = entry.id;
  if (!base.model) base.model = 'inherit';
  return base;
}

function renderForMarkdownPlatform(platform: MarkdownPlatform, entry: SubagentEntry): string {
  switch (platform) {
    case 'claude-code': {
      const fm = buildFrontmatterForClaude(entry);
      return wrapFrontmatter(fm, entry.content);
    }
    case 'opencode': {
      const fm = buildFrontmatterForOpencode(entry);
      return wrapFrontmatter(fm, entry.content);
    }
    case 'cursor': {
      const fm = buildFrontmatterForCursor(entry);
      return wrapFrontmatter(fm, entry.content);
    }
  }
}

// ---------------------------------------------------------------------------
// Codex platform (TOML-based agent roles)
// ---------------------------------------------------------------------------

const ASB_MANAGED_MARKER = '# managed-by: asb';

const CODEX_ROLE_CONFIG_FIELDS = new Set([
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'sandbox_mode',
]);

function hasCodexExtras(entry: SubagentEntry): boolean {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  if (!extras?.codex) return false;
  const codex = extras.codex as Record<string, unknown>;
  return typeof codex === 'object' && Object.keys(codex).length > 0;
}

function renderCodexRoleConfig(entry: SubagentEntry): string {
  const extras = (entry.metadata as LibraryFrontmatter).extras as
    | Record<string, unknown>
    | undefined;
  const codexExtras = (extras?.codex as Record<string, unknown>) ?? {};

  const config: Record<string, unknown> = {};
  for (const field of CODEX_ROLE_CONFIG_FIELDS) {
    const value = codexExtras[field];
    if (value !== undefined && value !== null) {
      config[field] = value;
    }
  }

  const trimmedContent = entry.content.trim();
  if (trimmedContent.length > 0) {
    config.developer_instructions = trimmedContent;
  }

  // Use @iarna/toml for correct value formatting
  let toml = '';
  try {
    toml = tomlStringify(config as Parameters<typeof tomlStringify>[0]);
  } catch {
    // Fallback: skip developer_instructions if it breaks TOML serialization
    const { developer_instructions: _ignored, ...rest } = config;
    toml = tomlStringify(rest as Parameters<typeof tomlStringify>[0]);
  }

  return `${ASB_MANAGED_MARKER}\n${toml}`;
}

function isAsbManagedToml(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.startsWith(ASB_MANAGED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Distribute subagents to Codex as TOML role config files + config.toml injection.
 * Handles:
 *  1. Writing role config TOML files to ~/.codex/agents/
 *  2. Cleaning up orphan ASB-managed TOML files
 *  3. Injecting [agents.<id>] declarations into ~/.codex/config.toml
 *  4. Enabling [features].multi_agent if needed
 */
function distributeCodexSubagents(
  _allEntries: SubagentEntry[],
  byId: Map<string, SubagentEntry>,
  scope?: ConfigScope
): DistributionResult<SubagentPlatform>[] {
  const results: DistributionResult<SubagentPlatform>[] = [];
  const platform: SubagentPlatform = 'codex';

  // Resolve active IDs for Codex via per-agent config
  const state = loadLibraryStateSectionForApplication('agents', platformToAgentId(platform), scope);
  const selected: SubagentEntry[] = [];
  for (const id of state.active) {
    const e = byId.get(id);
    // Only include entries that have extras.codex (Codex-compatible config)
    if (e && hasCodexExtras(e)) selected.push(e);
  }

  const targetDir = resolveSubagentTargetDir(platform, scope);

  // Step 1: Write TOML role config files
  const activeIds = new Set<string>();
  for (const entry of selected) {
    activeIds.add(entry.id);
    const filePath = resolveSubagentFilePath(platform, entry.id, scope);
    const content = renderCodexRoleConfig(entry);

    ensureParentDir(filePath);

    let existing: string | null = null;
    try {
      if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      existing = null;
    }

    if (existing !== null && existing === content) {
      results.push({ platform, filePath, status: 'skipped', reason: 'up-to-date' });
    } else {
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
        results.push({
          platform,
          filePath,
          status: 'written',
          reason: existing ? 'updated' : 'created',
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ platform, filePath, status: 'error', error: msg });
      }
    }
  }

  // Step 2: Clean up orphan ASB-managed TOML files
  if (fs.existsSync(targetDir)) {
    try {
      for (const file of fs.readdirSync(targetDir)) {
        if (!file.endsWith('.toml')) continue;
        const id = file.slice(0, -5);
        if (activeIds.has(id)) continue;

        const filePath = path.join(targetDir, file);
        if (fs.statSync(filePath).isDirectory()) continue;
        if (!isAsbManagedToml(filePath)) continue;

        try {
          fs.unlinkSync(filePath);
          results.push({
            platform,
            filePath,
            status: 'deleted' as DistributionStatus,
            reason: 'orphan',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            filePath,
            status: 'error',
            error: `Failed to delete orphan: ${msg}`,
          });
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // Step 3: Inject agent role declarations into config.toml
  const injectionResult = injectCodexAgentEntries(selected, activeIds);
  if (injectionResult.configResult) {
    results.push(injectionResult.configResult);
  }

  return results;
}

/**
 * Inject/remove [agents.<id>] declarations in ~/.codex/config.toml.
 * Also enables [features].multi_agent when roles are distributed.
 */
function injectCodexAgentEntries(
  activeEntries: SubagentEntry[],
  activeIds: Set<string>
): { configResult?: DistributionResult<SubagentPlatform> } {
  const configPath = getCodexConfigPath();
  const platform: SubagentPlatform = 'codex';

  let content = '';
  try {
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf-8');
    }
  } catch {
    return {
      configResult: {
        platform,
        filePath: configPath,
        status: 'error',
        error: 'Failed to read config.toml',
      },
    };
  }

  let parsed: Record<string, unknown> = {};
  try {
    if (content.trim().length > 0) {
      parsed = parseToml(content) as Record<string, unknown>;
    }
  } catch {
    return {
      configResult: {
        platform,
        filePath: configPath,
        status: 'error',
        error: 'Failed to parse config.toml',
      },
    };
  }

  const agents = (parsed.agents ?? {}) as Record<string, unknown>;
  const reservedKeys = new Set(['max_threads', 'max_depth']);
  let changed = false;

  // Add/update entries for active subagents
  for (const entry of activeEntries) {
    const existing = agents[entry.id] as Record<string, unknown> | undefined;
    const newEntry = {
      description: entry.metadata.description || `ASB-managed agent role: ${entry.id}`,
      config_file: `agents/${entry.id}.toml`,
    };

    if (
      !existing ||
      existing.description !== newEntry.description ||
      existing.config_file !== newEntry.config_file
    ) {
      agents[entry.id] = newEntry;
      changed = true;
    }
  }

  // Remove orphan ASB-managed entries: entries pointing to agents/<id>.toml
  // where the file no longer exists (was cleaned up in step 2) or id is not active
  for (const [key, value] of Object.entries(agents)) {
    if (reservedKeys.has(key)) continue;
    if (activeIds.has(key)) continue;
    if (typeof value !== 'object' || value === null) continue;

    const roleConfig = value as Record<string, unknown>;
    const configFile = roleConfig.config_file;
    if (
      typeof configFile === 'string' &&
      configFile.startsWith('agents/') &&
      configFile.endsWith('.toml')
    ) {
      // Check if the target file is ASB-managed (or already deleted)
      const fullPath = path.join(path.dirname(configPath), configFile);
      if (!fs.existsSync(fullPath) || isAsbManagedToml(fullPath)) {
        delete agents[key];
        changed = true;
      }
    }
  }

  if (!changed && activeEntries.length === 0) {
    return {};
  }

  parsed.agents = agents;

  // Enable multi_agent feature flag when distributing roles
  if (activeEntries.length > 0) {
    const features = (parsed.features ?? {}) as Record<string, unknown>;
    if (features.multi_agent !== true) {
      features.multi_agent = true;
      changed = true;
    }
    parsed.features = features;
  }

  if (!changed) {
    return {};
  }

  // Rewrite config.toml preserving all sections.
  // Separate mcp_servers to avoid @iarna/toml reformatting issues with its custom rendering.
  const { mcp_servers, ...rest } = parsed;
  try {
    let newContent = tomlStringify(rest as Parameters<typeof tomlStringify>[0]).trimEnd();

    // Re-append mcp_servers if they existed (preserved verbatim from parsed structure)
    if (mcp_servers && typeof mcp_servers === 'object' && Object.keys(mcp_servers).length > 0) {
      const mcpPart = tomlStringify({
        mcp_servers,
      } as Parameters<typeof tomlStringify>[0]).trimEnd();
      newContent = `${newContent}\n\n${mcpPart}`;
    }

    newContent = `${newContent}\n`;

    ensureParentDir(configPath);
    fs.writeFileSync(configPath, newContent, 'utf-8');
    return {
      configResult: {
        platform,
        filePath: configPath,
        status: 'written',
        reason: 'agents injected',
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      configResult: {
        platform,
        filePath: configPath,
        status: 'error',
        error: `Failed to write config.toml: ${msg}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Main distribution entry point
// ---------------------------------------------------------------------------

export function distributeSubagents(scope?: ConfigScope): SubagentDistributionOutcome {
  const entries = loadSubagentLibrary();
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Markdown-based platforms use the generic distributeLibrary framework
  const markdownPlatforms: MarkdownPlatform[] = ['claude-code', 'opencode', 'cursor'];

  const cleanup: CleanupConfig<MarkdownPlatform> = {
    resolveTargetDir: (p) => resolveSubagentTargetDir(p, scope),
    extractId: (filename) => {
      if (!filename.endsWith('.md')) return null;
      return filename.slice(0, -3);
    },
  };

  const filterSelected = (
    platform: MarkdownPlatform,
    _allEntries: SubagentEntry[]
  ): SubagentEntry[] => {
    const appId = platformToAgentId(platform);
    const state = loadLibraryStateSectionForApplication('agents', appId, scope);
    const selected: SubagentEntry[] = [];
    for (const id of state.active) {
      const e = byId.get(id);
      if (e) selected.push(e);
    }
    return selected;
  };

  const markdownOutcome = distributeLibrary<SubagentEntry, MarkdownPlatform>({
    section: 'agents',
    selected: entries,
    platforms: markdownPlatforms,
    resolveFilePath: (p, e) => resolveSubagentFilePath(p, e.id, scope),
    render: (p, e) => renderForMarkdownPlatform(p, e),
    getId: (e) => e.id,
    cleanup,
    scope,
    filterSelected,
  });

  // Codex: custom distribution (TOML files + config.toml injection)
  const codexResults = distributeCodexSubagents(entries, byId, scope);

  return {
    results: [
      ...markdownOutcome.results,
      ...codexResults,
    ] as DistributionResult<SubagentPlatform>[],
  };
}
