/**
 * Core type definitions for Agent Switchboard
 */

// Intentionally no direct imports to avoid circular/duplicate type declarations

/**
 * Re-export config types from schemas
 * These are inferred from Zod schemas to maintain single source of truth
 */
export type {
  McpConfig,
  McpServer,
  SwitchboardConfig,
} from './config/schemas.js';

// AgentAdapter is defined in src/agents/adapter.ts; keep a single source of truth.
