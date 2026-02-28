/** Agents that receive a single composed rules file (CLAUDE.md / AGENTS.md) */
export const RULE_SUPPORTED_AGENTS = ['claude-code', 'codex', 'gemini', 'opencode'] as const;

/** Agents that receive individual .mdc rule files */
export const RULE_PER_FILE_AGENTS = ['cursor'] as const;

export const RULE_INDIRECT_AGENTS = [] as const;

export const RULE_UNSUPPORTED_AGENTS = ['claude-desktop'] as const;

export type RuleSupportedAgent = (typeof RULE_SUPPORTED_AGENTS)[number];
export type RulePerFileAgent = (typeof RULE_PER_FILE_AGENTS)[number];
