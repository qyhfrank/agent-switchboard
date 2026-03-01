import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentsHome,
  getClaudeDir,
  getCodexDir,
  getCursorDir,
  getGeminiDir,
  getOpencodePath,
  getProjectCursorDir,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  RULE_INDIRECT_AGENTS,
  RULE_PER_FILE_AGENTS,
  RULE_SUPPORTED_AGENTS,
  RULE_UNSUPPORTED_AGENTS,
} from './agents.js';
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
}

function resolveRuleFile(
  agent: (typeof RULE_SUPPORTED_AGENTS)[number],
  scope?: ConfigScope
): string {
  const home = getAgentsHome();
  const projectRoot = scope?.project?.trim();
  switch (agent) {
    case 'claude-code':
      // Project-level supported conventionally under .claude/CLAUDE.md, else user-level
      if (projectRoot && projectRoot.length > 0) {
        return path.join(path.resolve(projectRoot), '.claude', 'CLAUDE.md');
      }
      return path.join(getClaudeDir(), 'CLAUDE.md');
    case 'codex':
      // Codex supports project-root AGENTS.md; otherwise use CODEX_HOME
      if (projectRoot && projectRoot.length > 0) {
        return path.join(path.resolve(projectRoot), 'AGENTS.md');
      }
      return path.join(getCodexDir(), 'AGENTS.md');
    case 'gemini':
      // Gemini uses AGENTS.md
      if (projectRoot && projectRoot.length > 0) {
        return path.join(path.resolve(projectRoot), 'AGENTS.md');
      }
      return path.join(getGeminiDir(), 'AGENTS.md');
    case 'cursor':
      if (projectRoot && projectRoot.length > 0) {
        return path.join(getProjectCursorDir(projectRoot), 'rules', 'asb-rules.mdc');
      }
      return path.join(getCursorDir(), 'rules', 'asb-rules.mdc');
    case 'opencode':
      // OpenCode supports project-level AGENTS.md at repository root; otherwise use global.
      if (projectRoot && projectRoot.length > 0) {
        return path.join(path.resolve(projectRoot), 'AGENTS.md');
      }
      return getOpencodePath('AGENTS.md');
    default:
      return path.join(home, agent, 'AGENTS.md');
  }
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function wrapMdcFrontmatter(body: string): string {
  const lines = ['---', 'description: Agent Switchboard Rules', 'alwaysApply: true', '---', ''];
  if (body.length > 0) {
    lines.push(body);
  }
  return lines.join('\n');
}

const CURSOR_SINGLE_FILE = 'asb-rules.mdc';

/**
 * Remove legacy per-rule .mdc files left by the old Cursor distribution scheme.
 * Only deletes files whose basename (minus .mdc) matches a known rule library ID,
 * leaving user-created .mdc files and the new single-file untouched.
 */
function cleanupLegacyCursorMdcFiles(scope?: ConfigScope): void {
  const projectRoot = scope?.project?.trim();
  const targetDir =
    projectRoot && projectRoot.length > 0
      ? path.join(getProjectCursorDir(projectRoot), 'rules')
      : path.join(getCursorDir(), 'rules');

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

  // Track the first composed document for return value (backwards compatibility)
  let firstComposed: ComposedRules | null = null;

  for (const agent of RULE_SUPPORTED_AGENTS) {
    // Compose rules for this specific agent (applies per-agent overrides)
    const document = composeActiveRulesForApplication(agent, scope);
    if (!firstComposed) {
      firstComposed = document;
    }

    const filePath = resolveRuleFile(agent, scope);
    const finalContent =
      agent === 'cursor' ? wrapMdcFrontmatter(document.content) : document.content;

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
      results.push({
        agent,
        filePath,
        status: 'skipped',
        reason: 'up-to-date',
      });
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

  // Clean up legacy per-rule .mdc files from the old Cursor distribution scheme.
  // The new approach writes a single asb-rules.mdc; old <ruleId>.mdc files are orphans.
  cleanupLegacyCursorMdcFiles(scope);

  if (agentSyncUpdates.size > 0) {
    updateRuleState((current) => {
      const agentSync = { ...current.agentSync };
      for (const [agent, update] of agentSyncUpdates.entries()) {
        agentSync[agent] = update;
      }
      return {
        ...current,
        agentSync,
      };
    }, scope);
  }

  return {
    composed: firstComposed ?? { content: '', hash: '', sections: [] },
    results,
  };
}

// ---------------------------------------------------------------------------
// Public helpers
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

export function resolveRuleFilePath(
  agent: (typeof RULE_SUPPORTED_AGENTS)[number],
  scope?: ConfigScope
): string {
  return resolveRuleFile(agent, scope);
}
