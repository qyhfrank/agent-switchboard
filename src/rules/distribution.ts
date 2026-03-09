import fs from 'node:fs';
import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import {
  filterInstalled,
  getActiveTargetsForSection,
  getTargetsForSection,
} from '../targets/registry.js';
import { RULE_INDIRECT_AGENTS, RULE_PER_FILE_AGENTS, RULE_UNSUPPORTED_AGENTS } from './agents.js';
import type { ComposedRules } from './composer.js';
import { composeActiveRulesForApplication } from './composer.js';
import { loadRuleLibrary } from './library.js';
import { updateRuleState } from './state.js';

export type DistributionStatus = 'written' | 'skipped' | 'error';

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

  const libraryIds = new Set(loadRuleLibrary().map((r) => r.id));

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
  _composed?: ComposedRules,
  options?: DistributionOptions,
  scope?: ConfigScope
): DistributionOutcome {
  const results: DistributionResult[] = [];
  const timestamp = new Date().toISOString();
  const forceRewrite = options?.force === true;
  const agentSyncUpdates = new Map<string, { hash: string; updatedAt: string }>();

  let firstComposed: ComposedRules | null = null;

  const activeAppIds = options?.activeAppIds;
  const targets = filterInstalled(
    activeAppIds ? getActiveTargetsForSection('rules', activeAppIds) : getTargetsForSection('rules'),
    options?.assumeInstalled
  );

  for (const target of targets) {
    if (!target.rules) continue;
    const handler = target.rules;
    const agent = target.id;

    const document = composeActiveRulesForApplication(agent, scope);
    if (!firstComposed) {
      firstComposed = document;
    }

    const filePath = handler.resolveFilePath(scope);
    const finalContent = handler.render(document.content);

    let existingContent: string | null = null;
    try {
      if (fs.existsSync(filePath)) {
        existingContent = fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      existingContent = null;
    }

    const hadExistingFile = existingContent !== null;
    const contentMatches = existingContent !== null && existingContent === finalContent;

    if (!forceRewrite && contentMatches) {
      results.push({ agent, filePath, status: 'skipped', reason: 'up-to-date' });
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      continue;
    }

    const reason = hadExistingFile ? (contentMatches ? 'refreshed' : 'updated') : 'created';

    try {
      ensureDirectory(filePath);
      fs.writeFileSync(filePath, finalContent, 'utf-8');
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      results.push({ agent, filePath, status: 'written', reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ agent, filePath, status: 'error', error: message });
    }
  }

  cleanupLegacyCursorMdcFiles(scope);

  if (agentSyncUpdates.size > 0) {
    updateRuleState((current) => {
      const agentSync = { ...current.agentSync };
      for (const [agent, update] of agentSyncUpdates.entries()) {
        agentSync[agent] = update;
      }
      return { ...current, agentSync };
    }, scope);
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
