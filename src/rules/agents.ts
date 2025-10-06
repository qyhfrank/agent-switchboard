export const RULE_SUPPORTED_AGENTS = ['claude-code', 'codex', 'gemini', 'opencode'] as const;

export const RULE_UNSUPPORTED_AGENTS = ['claude-desktop', 'cursor'] as const;

export type RuleSupportedAgent = (typeof RULE_SUPPORTED_AGENTS)[number];
