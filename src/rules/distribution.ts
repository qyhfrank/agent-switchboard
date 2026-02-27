import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentsHome,
  getClaudeDir,
  getCodexDir,
  getGeminiDir,
  getOpencodePath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import { RULE_INDIRECT_AGENTS, RULE_SUPPORTED_AGENTS, RULE_UNSUPPORTED_AGENTS } from './agents.js';
import type { ComposedRules } from './composer.js';
import { composeActiveRulesForAgent } from './composer.js';
import { updateRuleState } from './state.js';

export type DistributionStatus = 'written' | 'skipped' | 'error';

export interface DistributionResult {
  agent: (typeof RULE_SUPPORTED_AGENTS)[number];
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

export function distributeRules(
  _composed?: ComposedRules,
  options?: DistributionOptions,
  scope?: ConfigScope
): DistributionOutcome {
  const results: DistributionResult[] = [];
  const timestamp = new Date().toISOString();
  const forceRewrite = options?.force === true;
  const agentSyncUpdates = new Map<
    (typeof RULE_SUPPORTED_AGENTS)[number],
    { hash: string; updatedAt: string }
  >();

  // Track the first composed document for return value (backwards compatibility)
  let firstComposed: ComposedRules | null = null;

  for (const agent of RULE_SUPPORTED_AGENTS) {
    // Compose rules for this specific agent (applies per-agent overrides)
    const document = composeActiveRulesForAgent(agent, scope);
    if (!firstComposed) {
      firstComposed = document;
    }

    const filePath = resolveRuleFile(agent, scope);

    let existingContent: string | null = null;
    try {
      if (fs.existsSync(filePath)) {
        existingContent = fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      existingContent = null;
    }

    const hadExistingFile = existingContent !== null;
    const contentMatches = existingContent !== null && existingContent === document.content;

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
      fs.writeFileSync(filePath, document.content, 'utf-8');
      agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      results.push({ agent, filePath, status: 'written', reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ agent, filePath, status: 'error', error: message });
    }
  }

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

export function listUnsupportedAgents(): string[] {
  return [...RULE_UNSUPPORTED_AGENTS];
}

export function listIndirectAgents(): string[] {
  return [...RULE_INDIRECT_AGENTS];
}

export function resolveRuleFilePath(
  agent: (typeof RULE_SUPPORTED_AGENTS)[number],
  scope?: ConfigScope
): string {
  return resolveRuleFile(agent, scope);
}
