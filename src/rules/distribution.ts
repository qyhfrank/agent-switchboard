import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentsHome,
  getClaudeDir,
  getCodexDir,
  getGeminiDir,
  getOpencodePath,
} from '../config/paths.js';

import { RULE_SUPPORTED_AGENTS, RULE_UNSUPPORTED_AGENTS } from './agents.js';
import type { ComposedRules } from './composer.js';
import { composeActiveRules } from './composer.js';
import { loadRuleState, updateRuleState } from './state.js';

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

function resolveRuleFile(agent: (typeof RULE_SUPPORTED_AGENTS)[number]): string {
  const home = getAgentsHome();
  switch (agent) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'CLAUDE.md');
    case 'codex':
      return path.join(getCodexDir(), 'AGENTS.md');
    case 'gemini':
      return path.join(getGeminiDir(), 'AGENTS.md');
    case 'opencode':
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
  composed?: ComposedRules,
  options?: DistributionOptions
): DistributionOutcome {
  const document = composed ?? composeActiveRules();
  const state = loadRuleState();
  const results: DistributionResult[] = [];
  const timestamp = new Date().toISOString();
  const forceRewrite = options?.force === true;
  const agentSyncUpdates = new Map<
    (typeof RULE_SUPPORTED_AGENTS)[number],
    { hash: string; updatedAt: string }
  >();

  for (const agent of RULE_SUPPORTED_AGENTS) {
    const filePath = resolveRuleFile(agent);
    const previousHash = state.agentSync[agent]?.hash;

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
      if (previousHash !== document.hash) {
        agentSyncUpdates.set(agent, { hash: document.hash, updatedAt: timestamp });
      }
      continue;
    }

    const reason = hadExistingFile
      ? forceRewrite && contentMatches
        ? 'refreshed'
        : previousHash === document.hash
          ? 'restored'
          : 'updated'
      : 'created';

    try {
      ensureDirectory(filePath);
      // No backup; write-through only
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
    });
  }

  return {
    composed: document,
    results,
  };
}

export function listUnsupportedAgents(): string[] {
  return [...RULE_UNSUPPORTED_AGENTS];
}

export function resolveRuleFilePath(agent: (typeof RULE_SUPPORTED_AGENTS)[number]): string {
  return resolveRuleFile(agent);
}
