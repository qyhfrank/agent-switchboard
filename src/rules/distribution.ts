import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentSectionConfig } from '../config/agent-config.js';
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
  type RulePerFileAgent,
  type RuleSupportedAgent,
} from './agents.js';
import type { ComposedRules } from './composer.js';
import { composeActiveRulesForAgent } from './composer.js';
import type { RuleSnippet } from './library.js';
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
    RuleSupportedAgent | RulePerFileAgent,
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

  // Distribute individual .mdc files to per-file agents (Cursor)
  const perFileResults = distributeCursorRules(forceRewrite, scope);
  results.push(...perFileResults.results);
  for (const [agent, update] of perFileResults.syncUpdates.entries()) {
    agentSyncUpdates.set(agent, update);
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

// ---------------------------------------------------------------------------
// Cursor .mdc per-file distribution
// ---------------------------------------------------------------------------

function resolveCursorRulesDir(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return path.join(getProjectCursorDir(projectRoot), 'rules');
  }
  return path.join(getCursorDir(), 'rules');
}

function renderMdcRule(rule: RuleSnippet): string {
  const extras = (rule.metadata as Record<string, unknown>).extras as
    | Record<string, unknown>
    | undefined;
  const cursorExtras = (extras?.cursor ?? {}) as Record<string, unknown>;

  const description =
    typeof cursorExtras.description === 'string'
      ? cursorExtras.description
      : (rule.metadata.description ?? rule.metadata.title ?? rule.id);
  const alwaysApply =
    typeof cursorExtras.alwaysApply === 'boolean' ? cursorExtras.alwaysApply : true;

  const lines = ['---', `description: ${description}`, `alwaysApply: ${alwaysApply}`];
  if (typeof cursorExtras.globs === 'string' && cursorExtras.globs.length > 0) {
    lines.push(`globs: ${cursorExtras.globs}`);
  }
  lines.push('---', '');

  const body = rule.content.replace(/\r\n/g, '\n').replace(/\s+$/u, '');
  if (body.length > 0) {
    lines.push(body);
    lines.push('');
  }

  return lines.join('\n');
}

function distributeCursorRules(
  forceRewrite: boolean,
  scope?: ConfigScope
): {
  results: DistributionResult[];
  syncUpdates: Map<RulePerFileAgent, { hash: string; updatedAt: string }>;
} {
  const results: DistributionResult[] = [];
  const syncUpdates = new Map<RulePerFileAgent, { hash: string; updatedAt: string }>();
  const timestamp = new Date().toISOString();

  for (const agent of RULE_PER_FILE_AGENTS) {
    const agentConfig = resolveAgentSectionConfig('rules', agent, scope);
    const activeIds = new Set(agentConfig.active);
    const rules = loadRuleLibrary();
    const ruleMap = new Map(rules.map((r) => [r.id, r]));
    const libraryIds = new Set(rules.map((r) => r.id));
    const targetDir = resolveCursorRulesDir(scope);

    const hashes: string[] = [];
    let hadError = false;

    for (const id of agentConfig.active) {
      const rule = ruleMap.get(id);
      if (!rule) continue;

      const filePath = path.join(targetDir, `${id}.mdc`);
      const content = renderMdcRule(rule);
      hashes.push(createHash('sha256').update(content).digest('hex'));

      let existing: string | null = null;
      try {
        if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
      } catch {
        existing = null;
      }

      if (!forceRewrite && existing === content) {
        results.push({ agent, filePath, status: 'skipped', reason: 'up-to-date' });
        continue;
      }

      try {
        ensureDirectory(filePath);
        fs.writeFileSync(filePath, content, 'utf-8');
        results.push({
          agent,
          filePath,
          status: 'written',
          reason: existing !== null ? 'updated' : 'created',
        });
      } catch (error) {
        hadError = true;
        const message = error instanceof Error ? error.message : String(error);
        results.push({ agent, filePath, status: 'error', error: message });
      }
    }

    // Cleanup orphan .mdc files: files in target dir whose ID is in the library but not active
    if (fs.existsSync(targetDir)) {
      for (const file of fs.readdirSync(targetDir)) {
        if (!file.endsWith('.mdc')) continue;
        const fileId = file.slice(0, -4);
        if (libraryIds.has(fileId) && !activeIds.has(fileId)) {
          try {
            fs.unlinkSync(path.join(targetDir, file));
          } catch {
            // best-effort cleanup
          }
        }
      }
    }

    if (!hadError) {
      const combinedHash = createHash('sha256').update(hashes.join(':')).digest('hex');
      syncUpdates.set(agent, { hash: combinedHash, updatedAt: timestamp });
    }
  }

  return { results, syncUpdates };
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
