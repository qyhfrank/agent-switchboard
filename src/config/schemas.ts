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
 * Schema for Agent Switchboard configuration file (~/.agent-switchboard/config.toml)
 */
export const ruleOutputConfigSchema = z
  .object({
    includeDelimiters: z.boolean().default(false),
  })
  .passthrough()
  .default({ includeDelimiters: false });

export const switchboardConfigSchema = z.object({
  agents: z.array(z.string()).default([]),
  rules: ruleOutputConfigSchema.default({ includeDelimiters: false }),
});

/**
 * Infer TypeScript types from schemas
 */
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type RuleOutputConfig = z.infer<typeof ruleOutputConfigSchema>;
export type SwitchboardConfig = z.infer<typeof switchboardConfigSchema>;
