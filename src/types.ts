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
} from "./config/schemas.js";

/**
 * Checkbox item for interactive UI
 */
export interface CheckboxItem {
	/** Display name with status indicators */
	name: string;
	/** Actual server name (value returned when selected) */
	value: string;
	/** Initial checkbox state */
	checked: boolean;
}

// AgentAdapter is defined in src/agents/adapter.ts; keep a single source of truth.
