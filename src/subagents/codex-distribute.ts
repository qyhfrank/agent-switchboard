/**
 * Codex subagent distribution logic (standalone, no target-registry imports).
 *
 * Extracted from distribution.ts to break circular dependencies:
 * targets/builtin/codex.ts can import this; distribution.ts can import targets/registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as tomlStringify } from '@iarna/toml';
import { getCodexAgentsDir, getCodexConfigPath } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult, DistributionStatus } from '../library/distribute.js';
import { ensureParentDir } from '../library/fs.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import type { GenericLibraryEntry } from '../targets/types.js';

const ASB_MANAGED_MARKER = '# managed-by: asb';

const CODEX_ROLE_CONFIG_FIELDS = new Set([
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'sandbox_mode',
]);

function getCodexExtras(entry: GenericLibraryEntry): Record<string, unknown> | undefined {
  const extras = entry.metadata.extras;
  if (!extras?.codex) return undefined;
  const codex = extras.codex as Record<string, unknown>;
  return typeof codex === 'object' && Object.keys(codex).length > 0 ? codex : undefined;
}

function renderCodexRoleConfig(entry: GenericLibraryEntry): string {
  const codexExtras = getCodexExtras(entry) ?? {};

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

  let toml = '';
  try {
    toml = tomlStringify(config as Parameters<typeof tomlStringify>[0]);
  } catch {
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

function resolveCodexAgentFilePath(id: string): string {
  return path.join(getCodexAgentsDir(), `${id}.toml`);
}

/**
 * Distribute subagents to Codex as TOML role config files + config.toml injection.
 */
export function distributeCodexSubagents(
  _allEntries: GenericLibraryEntry[],
  byId: Map<string, GenericLibraryEntry>,
  scope?: ConfigScope
): DistributionResult<string>[] {
  const results: DistributionResult<string>[] = [];
  const platform = 'codex';

  const state = loadLibraryStateSectionForApplication('agents', platform, scope);
  const selected: GenericLibraryEntry[] = [];
  for (const id of state.enabled) {
    const e = byId.get(id);
    if (e && getCodexExtras(e)) selected.push(e);
  }

  const targetDir = getCodexAgentsDir();

  const activeIds = new Set<string>();
  for (const entry of selected) {
    activeIds.add(entry.id);
    const filePath = resolveCodexAgentFilePath(entry.id);
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
            entryId: id,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            platform,
            filePath,
            status: 'error',
            error: `Failed to delete orphan: ${msg}`,
            entryId: id,
          });
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  const injectionResult = injectCodexAgentEntries(selected, activeIds);
  if (injectionResult.configResult) {
    results.push(injectionResult.configResult);
  }

  return results;
}

function injectCodexAgentEntries(
  activeEntries: GenericLibraryEntry[],
  activeIds: Set<string>
): { configResult?: DistributionResult<string> } {
  const configPath = getCodexConfigPath();
  const platform = 'codex';

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

  const { mcp_servers, ...rest } = parsed;
  try {
    let newContent = tomlStringify(rest as Parameters<typeof tomlStringify>[0]).trimEnd();

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
