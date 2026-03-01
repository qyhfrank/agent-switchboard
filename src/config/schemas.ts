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
 * Base schema for selection sections (commands, agents, etc.) without defaults
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
 * Incremental selection schema for per-application overrides
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
 * Per-application configuration override schema
 * Allows overriding mcp, commands, agents, skills, rules for a specific application
 */
export const applicationConfigOverrideSchema = z
  .object({
    mcp: incrementalSelectionSchema.optional(),
    commands: incrementalSelectionSchema.optional(),
    agents: incrementalSelectionSchema.optional(),
    skills: incrementalSelectionSchema.optional(),
    hooks: incrementalSelectionSchema.optional(),
    rules: incrementalRulesSchema.optional(),
  })
  .passthrough();

/**
 * Applications section schema with active list and per-application overrides.
 * Lists which AI agent applications (claude-code, cursor, codex, etc.) to sync to.
 * Format in TOML:
 *   [applications]
 *   active = ["claude-code", "codex"]
 *
 *   [applications.codex.skills]
 *   remove = ["skill-codex"]
 *
 * Note: Using passthrough() instead of catchall() to allow per-application overrides.
 * The per-application overrides are validated at runtime in application-config.ts.
 */
const applicationsSectionBaseSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const applicationsSectionSchema = z
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
 * Distribution configuration schema
 * Controls how skills/commands/agents are distributed to application targets.
 * - use_agents_dir: When true, skills are distributed to 2 targets (claude-code + agents).
 *   When false (default), skills use the legacy 4-target mode for backward compatibility.
 */
const distributionSectionBaseSchema = z
  .object({
    use_agents_dir: z.boolean().optional(),
  })
  .passthrough();

export const distributionSectionSchema = distributionSectionBaseSchema
  .extend({
    use_agents_dir: z.boolean().default(false),
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
 * - sources: Record of namespace -> local path or remote git source
 */
export const remoteSourceSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
  subdir: z.string().optional(),
});

export const sourceValueSchema = z.union([z.string().trim().min(1), remoteSourceSchema]);

const librarySectionBaseSchema = z
  .object({
    sources: z.record(z.string().trim().min(1), sourceValueSchema).optional(),
  })
  .passthrough();

export const librarySectionSchema = librarySectionBaseSchema
  .extend({
    sources: z.record(z.string().trim().min(1), sourceValueSchema).default({}),
  })
  .passthrough();

/**
 * Schema for Agent Switchboard configuration file (~/.agent-switchboard/config.toml)
 */
export const switchboardConfigSchema = z
  .object({
    applications: applicationsSectionSchema.default({ active: [] }),
    mcp: selectionSectionSchema.default({ active: [] }),
    commands: selectionSectionSchema.default({ active: [] }),
    agents: selectionSectionSchema.default({ active: [] }),
    skills: selectionSectionSchema.default({ active: [] }),
    hooks: selectionSectionSchema.default({ active: [] }),
    rules: rulesSectionSchema.default({ active: [], includeDelimiters: false }),
    distribution: distributionSectionSchema.default({ use_agents_dir: false }),
    ui: uiSectionSchema.default({ pageSize: 20 }),
    library: librarySectionSchema.default({ sources: {} }),
  })
  .passthrough();

/**
 * Input schema for partial config layers (no defaults)
 */
export const switchboardConfigLayerSchema = z
  .object({
    applications: applicationsSectionBaseSchema.optional(),
    mcp: selectionSectionBaseSchema.optional(),
    commands: selectionSectionBaseSchema.optional(),
    agents: selectionSectionBaseSchema.optional(),
    skills: selectionSectionBaseSchema.optional(),
    hooks: selectionSectionBaseSchema.optional(),
    rules: rulesSectionBaseSchema.optional(),
    distribution: distributionSectionBaseSchema.optional(),
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
export type ApplicationConfigOverride = z.infer<typeof applicationConfigOverrideSchema>;
export type ApplicationsSection = z.infer<typeof applicationsSectionSchema>;
export type RulesSection = z.infer<typeof rulesSectionSchema>;
export type DistributionSection = z.infer<typeof distributionSectionSchema>;
export type UiSection = z.infer<typeof uiSectionSchema>;
export type LibrarySection = z.infer<typeof librarySectionSchema>;
export type RemoteSource = z.infer<typeof remoteSourceSchema>;
export type SourceValue = z.infer<typeof sourceValueSchema>;
export type SwitchboardConfig = z.infer<typeof switchboardConfigSchema>;
export type SwitchboardConfigLayer = z.infer<typeof switchboardConfigLayerSchema>;
