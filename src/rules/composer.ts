import { createHash } from 'node:crypto';
import { resolveAgentSectionConfig } from '../config/agent-config.js';
import type { ConfigScope } from '../config/scope.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import type { RuleSnippet } from './library.js';
import { loadRuleLibrary } from './library.js';
import { loadRuleState } from './state.js';

export interface RuleSection {
  id: string;
  title: string | null;
  content: string;
}

export interface ComposedRules {
  content: string;
  hash: string;
  sections: RuleSection[];
}

interface ComposeOptions {
  includeDelimiters?: boolean;
}

function normalizeRuleContent(content: string): string {
  const unix = content.replace(/\r\n/g, '\n');
  const trimmed = unix.replace(/\s+$/u, '');
  if (trimmed.length === 0) {
    return '';
  }
  return `${trimmed}\n`;
}

function createSection(rule: RuleSnippet): RuleSection {
  return {
    id: rule.id,
    title: rule.metadata.title ?? null,
    content: normalizeRuleContent(rule.content),
  };
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function composeRules(
  activeIds: string[],
  rules: RuleSnippet[],
  options?: ComposeOptions
): ComposedRules {
  if (activeIds.length === 0) {
    return {
      content: '',
      hash: hashContent(''),
      sections: [],
    };
  }

  const includeDelimiters = options?.includeDelimiters === true;

  const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
  const sections: RuleSection[] = [];
  const blocks: string[] = [];

  for (const id of activeIds) {
    const rule = ruleMap.get(id);
    if (!rule) {
      throw new Error(`Active rule "${id}" is missing from the library.`);
    }

    const section = createSection(rule);
    sections.push(section);

    if (includeDelimiters) {
      const startDelimiter = `<!-- ${id}:start -->`;
      const endDelimiter = `<!-- ${id}:end -->`;
      let block = `${startDelimiter}\n`;
      if (section.content.length > 0) {
        block += section.content;
      }
      block += `${endDelimiter}\n`;
      blocks.push(block);
    } else if (section.content.length > 0) {
      blocks.push(section.content);
    }
  }

  const content = blocks.join('\n');

  return {
    content,
    hash: hashContent(content),
    sections,
  };
}

export function composeActiveRules(scope?: ConfigScope): ComposedRules {
  const rules = loadRuleLibrary();
  const state = loadRuleState(scope);
  const loadOptions = scope
    ? {
        profile: scope.profile ?? undefined,
        projectPath: scope.project ?? undefined,
      }
    : undefined;
  const config = loadSwitchboardConfig(loadOptions);
  return composeRules(state.active, rules, {
    includeDelimiters: config.rules?.includeDelimiters === true,
  });
}

/**
 * Compose active rules for a specific agent, applying per-agent overrides
 */
export function composeActiveRulesForAgent(agentId: string, scope?: ConfigScope): ComposedRules {
  const rules = loadRuleLibrary();
  const agentConfig = resolveAgentSectionConfig('rules', agentId, scope);
  const loadOptions = scope
    ? {
        profile: scope.profile ?? undefined,
        projectPath: scope.project ?? undefined,
      }
    : undefined;
  const config = loadSwitchboardConfig(loadOptions);
  return composeRules(agentConfig.active, rules, {
    includeDelimiters: config.rules?.includeDelimiters === true,
  });
}
