/**
 * Zod schemas for configuration validation
 */

import { z } from 'zod';

/**
 * Schema for MCP server configuration
 * Allows both command-based and URL-based servers
 * Preserves unknown fields for forward compatibility
 */
export const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    type: z.enum(['stdio', 'http']).optional(),
    enabled: z.boolean().default(true),
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
 * Schema for Agent Switchboard configuration file (~/.agent-switchboard/config.toml)
 */
export const switchboardConfigSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).default([]),
    mcp: selectionSectionSchema.default({ active: [] }),
    commands: selectionSectionSchema.default({ active: [] }),
    subagents: selectionSectionSchema.default({ active: [] }),
    skills: selectionSectionSchema.default({ active: [] }),
    rules: rulesSectionSchema.default({ active: [], includeDelimiters: false }),
    ui: uiSectionSchema.default({ pageSize: 20 }),
  })
  .passthrough();

/**
 * Input schema for partial config layers (no defaults)
 */
export const switchboardConfigLayerSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    mcp: selectionSectionBaseSchema.optional(),
    commands: selectionSectionBaseSchema.optional(),
    subagents: selectionSectionBaseSchema.optional(),
    skills: selectionSectionBaseSchema.optional(),
    rules: rulesSectionBaseSchema.optional(),
    ui: uiSectionBaseSchema.optional(),
  })
  .passthrough();

/**
 * Infer TypeScript types from schemas
 */
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type SelectionSection = z.infer<typeof selectionSectionSchema>;
export type RulesSection = z.infer<typeof rulesSectionSchema>;
export type UiSection = z.infer<typeof uiSectionSchema>;
export type SwitchboardConfig = z.infer<typeof switchboardConfigSchema>;
export type SwitchboardConfigLayer = z.infer<typeof switchboardConfigLayerSchema>;
