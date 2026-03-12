import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import { recordRulesEntry } from '../manifest/store.js';
import type { ProjectDistributionManifest } from '../manifest/types.js';
import {
  filterInstalled,
  getActiveTargetsForSection,
  getTargetsForSection,
} from '../targets/registry.js';
import { RULE_INDIRECT_AGENTS, RULE_PER_FILE_AGENTS, RULE_UNSUPPORTED_AGENTS } from './agents.js';
import { isDedicatedAsbRulesFile, mergeRulesBlock, removeRulesBlock } from './block-merge.js';
import type { ComposedRules } from './composer.js';
import { composeActiveRulesForApplication } from './composer.js';
import { loadRuleLibrary } from './library.js';
import { updateRuleAgentSync } from './state.js';

export type DistributionStatus = 'written' | 'skipped' | 'error' | 'deleted';

export interface DistributionResult {
  agent: string;
  filePath: string;
  status: DistributionStatus;
  reason?: string;
  error?: string;
}

export interface DistributionOutcome {
  composed: ComposedRules;
  results: DistributionResult[];
}

interface DistributionOptions {
  force?: boolean;
  activeAppIds?: string[];
  assumeInstalled?: ReadonlySet<string>;
  /** Project distribution manifest for managed mode */
  manifest?: ProjectDistributionManifest;
  /** Project distribution mode */
  projectMode?: 'managed' | 'exclusive' | 'none';
  /** Rules placement in shared files */
  rulesPlacement?: 'prepend' | 'append';
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const CURSOR_SINGLE_FILE = 'asb-rules.mdc';

/**
 * Remove legacy per-rule .mdc files left by the old Cursor distribution scheme.
 */
function cleanupLegacyCursorMdcFiles(scope?: ConfigScope): void {
  const cursorTarget = getTargetsForSection('rules').find((t) => t.id === 'cursor');
  if (!cursorTarget?.rules) return;

  const targetDir = path.dirname(cursorTarget.rules.resolveFilePath(scope));
  if (!fs.existsSync(targetDir)) return;

  const libraryIds = new Set(loadRuleLibrary(scope).map((r) => r.id));

  for (const file of fs.readdirSync(targetDir)) {
    if (!file.endsWith('.mdc') || file === CURSOR_SINGLE_FILE) continue;
    const fileId = file.slice(0, -4);
    if (libraryIds.has(fileId)) {
      try {
        fs.unlinkSync(path.join(targetDir, file));
      } catch {
        // best-effort
      }
    }
  }
}

export function distributeRules(
  options?: DistributionOptions,
  scope?: ConfigScope
): DistributionOutcome {
  const results: DistributionResult[] = [];
  const timestamp = new Date().toISOString();
  const forceRewrite = options?.force === true;
  const agentSyncUpdates = new Map<string, { hash: string; updatedAt: string }>();

  let firstComposed: ComposedRules | null = null;
  const managedProjectRoot = scope?.project;
  const isManaged = managedProjectRoot && (options?.projectMode ?? 'exclusive') === 'managed';
  const placement = options?.rulesPlacement ?? 'prepend';

  const activeAppIds = options?.activeAppIds;
  const targets = filterInstalled(
    activeAppIds
      ? getActiveTargetsForSection('rules', activeAppIds)
      : getTargetsForSection('rules'),
    options?.assumeInstalled
  );

  // Dedup shared physical paths: multiple targets (codex/gemini/opencode) may
  // point to the same file (e.g. AGENTS.md). Write once per physical path.
  const writtenPaths = new Map<string, string>();

  for (const target of targets) {
    if (!target.rules) continue;
    const handler = target.rules;
    const agent = target.id;

    const document = composeActiveRulesForApplication(agent, scope);
    if (!firstComposed) {
      firstComposed = document;
    }

    const filePath = handler.resolveFilePath(scope);
    const resolvedPath = path.resolve(filePath);

    // Shared-path dedup: if another target already wrote to this path, check content
    if (writtenPaths.has(resolvedPath)) {
      const prevContent = writtenPaths.get(resolvedPath);
      const thisContent = handler.render(document.content);
      if (prevContent !== thisContent && document.content.length > 0) {
        // Content differs between targets sharing the same path - report as error
        results.push({
          agent,
          filePath,
          status: 'error',
          error: 'shared path conflict: rendered content differs from previously written target',
        });
        // Do not update agentSync for a conflicting target
      } else {
        results.push({ agent, filePath, status: 'skipped', reason: 'deduped' });
        agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      }
      continue;
    }

    const useBlockMerge = isManaged && !isDedicatedAsbRulesFile(filePath);

    if (document.content.length === 0) {
      try {
        if (fs.existsSync(filePath)) {
          if (useBlockMerge) {
            // Shared file: only remove ASB block, preserve rest
            const existing = fs.readFileSync(filePath, 'utf-8');
            const cleaned = removeRulesBlock(existing);
            if (cleaned !== existing) {
              if (cleaned.trim().length === 0) {
                // File would be empty after removing block - keep empty file
                fs.writeFileSync(filePath, '', 'utf-8');
              } else {
                fs.writeFileSync(filePath, cleaned, 'utf-8');
              }
              results.push({ agent, filePath, status: 'written', reason: 'block-removed' });
            }
            // else: no ASB block in file, nothing to do - skip silently
          } else {
            // Dedicated file: delete entirely
            fs.unlinkSync(filePath);
            results.push({ agent, filePath, status: 'deleted', reason: 'no-rules-configured' });
          }
        }
        // else: file doesn't exist and no rules configured - skip silently
        agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ agent, filePath, status: 'error', error: message });
      }
      continue;
    }

    const renderedContent = handler.render(document.content);

    let existingContent: string | null = null;
    try {
      if (fs.existsSync(filePath)) {
        existingContent = fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      existingContent = null;
    }

    if (useBlockMerge) {
      // Block merge: insert/replace ASB block in shared file
      const base = existingContent ?? '';
      const merged = mergeRulesBlock(base, renderedContent, placement);

      if (!forceRewrite && existingContent !== null && existingContent === merged) {
        results.push({ agent, filePath, status: 'skipped', reason: 'up-to-date' });
      } else {
        try {
          ensureDirectory(filePath);
          fs.writeFileSync(filePath, merged, 'utf-8');
          results.push({
            agent,
            filePath,
            status: 'written',
            reason: existingContent !== null ? 'block-updated' : 'block-created',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ agent, filePath, status: 'error', error: message });
        }
      }
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      writtenPaths.set(resolvedPath, renderedContent);

      // Record in manifest
      if (options?.manifest && managedProjectRoot) {
        recordRulesEntry(
          options.manifest,
          path.relative(path.resolve(managedProjectRoot), filePath),
          {
            relativePath: path.relative(path.resolve(managedProjectRoot), filePath),
            mode: 'block',
            targetIds: [agent],
            hash: createHash('sha256').update(renderedContent).digest('hex'),
            updatedAt: timestamp,
          }
        );
      }
      continue;
    }

    // Full file replace (dedicated files or exclusive mode)
    const hadExistingFile = existingContent !== null;
    const contentMatches = existingContent !== null && existingContent === renderedContent;

    if (!forceRewrite && contentMatches) {
      results.push({ agent, filePath, status: 'skipped', reason: 'up-to-date' });
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      writtenPaths.set(resolvedPath, renderedContent);
      continue;
    }

    const reason = hadExistingFile ? (contentMatches ? 'refreshed' : 'updated') : 'created';

    try {
      ensureDirectory(filePath);
      fs.writeFileSync(filePath, renderedContent, 'utf-8');
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      results.push({ agent, filePath, status: 'written', reason });
      writtenPaths.set(resolvedPath, renderedContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ agent, filePath, status: 'error', error: message });
    }
  }

  cleanupLegacyCursorMdcFiles(scope);

  if (agentSyncUpdates.size > 0) {
    updateRuleAgentSync((current) => {
      const agentSync = { ...current };
      for (const [agent, update] of agentSyncUpdates.entries()) {
        agentSync[agent] = update;
      }
      return agentSync;
    });
  }

  return {
    composed: firstComposed ?? { content: '', hash: '', sections: [] },
    results,
  };
}

// ---------------------------------------------------------------------------
// Public helpers (backward compatible)
// ---------------------------------------------------------------------------

export function listUnsupportedAgents(): string[] {
  return [...RULE_UNSUPPORTED_AGENTS];
}

export function listIndirectAgents(): string[] {
  return [...RULE_INDIRECT_AGENTS];
}

export function listPerFileAgents(): string[] {
  return [...RULE_PER_FILE_AGENTS];
}

export function resolveRuleFilePath(agent: string, scope?: ConfigScope): string {
  const target = getTargetsForSection('rules').find((t) => t.id === agent);
  if (!target?.rules) {
    throw new Error(`No rules handler for agent: ${agent}`);
  }
  return target.rules.resolveFilePath(scope);
}
