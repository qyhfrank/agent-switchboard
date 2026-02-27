export const RULE_SUPPORTED_AGENTS = ['claude-code', 'codex', 'gemini', 'opencode'] as const;

export const RULE_INDIRECT_AGENTS = ['cursor'] as const;

export const RULE_UNSUPPORTED_AGENTS = ['claude-desktop'] as const;

export type RuleSupportedAgent = (typeof RULE_SUPPORTED_AGENTS)[number];
