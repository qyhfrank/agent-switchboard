/**
 * Zod schemas for configuration validation
 */

import { z } from 'zod';

/**
 * Schema for MCP server configuration (definition only, no enabled state)
 * Allows both command-based and URL-based servers
 * Preserves unknown fields for forward compatibility
 */
export const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    type: z.enum(['stdio', 'sse', 'http']).optional(),
  })
  .passthrough(); // Allow unknown fields

/**
 * Schema for MCP configuration file (~/.agent-switchboard/mcp.json)
 */
export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
});

/**
 * Base schema for selection sections (commands, subagents, etc.) without defaults
 */
const selectionSectionBaseSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

export const selectionSectionSchema = selectionSectionBaseSchema
  .extend({
    active: z.array(z.string().trim().min(1)).default([]),
  })
  .passthrough();

/**
 * Incremental selection schema for per-agent overrides
 * - active: completely override the global list
 * - add: append to the global list
 * - remove: remove from the global list
 */
export const incrementalSelectionSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).optional(),
    add: z.array(z.string().trim().min(1)).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const incrementalRulesSchema = incrementalSelectionSchema.extend({
  includeDelimiters: z.boolean().optional(),
});

/**
 * Per-agent configuration override schema
 * Allows overriding mcp, commands, subagents, skills, rules for a specific agent
 */
export const agentConfigOverrideSchema = z
  .object({
    mcp: incrementalSelectionSchema.optional(),
    commands: incrementalSelectionSchema.optional(),
    subagents: incrementalSelectionSchema.optional(),
    skills: incrementalSelectionSchema.optional(),
    rules: incrementalRulesSchema.optional(),
  })
  .passthrough();

/**
 * Agents section schema with active list and per-agent overrides
 * Format in TOML:
 *   [agents]
 *   active = ["claude-code", "codex"]
 *
 *   [agents.codex.skills]
 *   remove = ["skill-codex"]
 *
 * Note: Using passthrough() instead of catchall() to allow per-agent overrides.
 * The per-agent overrides are validated at runtime in agent-config.ts.
 */
const agentsSectionBaseSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const agentsSectionSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).default([]),
  })
  .passthrough();

const rulesSectionBaseSchema = selectionSectionBaseSchema.extend({
  includeDelimiters: z.boolean().optional(),
});

export const rulesSectionSchema = rulesSectionBaseSchema
  .extend({
    active: z.array(z.string().trim().min(1)).default([]),
    includeDelimiters: z.boolean().default(false),
  })
  .passthrough();

/**
 * UI configuration schema
 */
const uiSectionBaseSchema = z
  .object({
    page_size: z.number().int().min(5).max(50).optional(),
  })
  .passthrough();

export const uiSectionSchema = uiSectionBaseSchema
  .extend({
    page_size: z.number().int().min(5).max(50).default(20),
  })
  .passthrough();

/**
 * Library configuration schema
 * - subscriptions: Record of namespace -> path for additional library sources
 */
const librarySectionBaseSchema = z
  .object({
    subscriptions: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
  })
  .passthrough();

export const librarySectionSchema = librarySectionBaseSchema
  .extend({
    subscriptions: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
  })
  .passthrough();

/**
 * Schema for Agent Switchboard configuration file (~/.agent-switchboard/config.toml)
 */
export const switchboardConfigSchema = z
  .object({
    agents: agentsSectionSchema.default({ active: [] }),
    mcp: selectionSectionSchema.default({ active: [] }),
    commands: selectionSectionSchema.default({ active: [] }),
    subagents: selectionSectionSchema.default({ active: [] }),
    skills: selectionSectionSchema.default({ active: [] }),
    rules: rulesSectionSchema.default({ active: [], includeDelimiters: false }),
    ui: uiSectionSchema.default({ pageSize: 20 }),
    library: librarySectionSchema.default({ subscriptions: {} }),
  })
  .passthrough();

/**
 * Input schema for partial config layers (no defaults)
 */
export const switchboardConfigLayerSchema = z
  .object({
    agents: agentsSectionBaseSchema.optional(),
    mcp: selectionSectionBaseSchema.optional(),
    commands: selectionSectionBaseSchema.optional(),
    subagents: selectionSectionBaseSchema.optional(),
    skills: selectionSectionBaseSchema.optional(),
    rules: rulesSectionBaseSchema.optional(),
    ui: uiSectionBaseSchema.optional(),
    library: librarySectionBaseSchema.optional(),
  })
  .passthrough();

/**
 * Infer TypeScript types from schemas
 */
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type SelectionSection = z.infer<typeof selectionSectionSchema>;
export type IncrementalSelection = z.infer<typeof incrementalSelectionSchema>;
export type AgentConfigOverride = z.infer<typeof agentConfigOverrideSchema>;
export type AgentsSection = z.infer<typeof agentsSectionSchema>;
export type RulesSection = z.infer<typeof rulesSectionSchema>;
export type UiSection = z.infer<typeof uiSectionSchema>;
export type LibrarySection = z.infer<typeof librarySectionSchema>;
export type SwitchboardConfig = z.infer<typeof switchboardConfigSchema>;
export type SwitchboardConfigLayer = z.infer<typeof switchboardConfigLayerSchema>;
