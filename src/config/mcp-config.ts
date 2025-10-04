/**
 * MCP configuration loader and saver with JSONC support
 * Preserves comments and unknown fields when reading/writing mcp.json
 */

import fs from "node:fs";
import { parse } from "jsonc-parser";
import { getConfigDir, getMcpConfigPath } from "./paths.js";
import { type McpConfig, mcpConfigSchema } from "./schemas.js";

/**
 * Loads the MCP configuration from ~/.agent-switchboard/mcp.json
 * Parses JSONC (JSON with comments) format
 * Returns default empty config if file doesn't exist
 * Auto-adds missing enable flags and saves the file
 *
 * @returns {McpConfig} Parsed and validated MCP configuration
 * @throws {Error} If file exists but contains invalid JSON or fails schema validation
 */
export function loadMcpConfig(): McpConfig {
	const configPath = getMcpConfigPath();

	// Return default config if file doesn't exist
	if (!fs.existsSync(configPath)) {
		return { mcpServers: {} };
	}

	try {
		// Read file content
		const content = fs.readFileSync(configPath, "utf-8");

		// Parse JSONC (preserves comments in the parser's internal state)
		const parsed = parse(content);

		// Validate against Zod schema (adds default enable: true if missing)
		const validated = mcpConfigSchema.parse(parsed);

		// Check if any server was missing enable flag
		let needsSave = false;
		if (parsed.mcpServers) {
			for (const [_, server] of Object.entries(parsed.mcpServers) as [
				string,
				// biome-ignore lint/suspicious/noExplicitAny: parsed JSON can be any shape
				any,
			][]) {
				if (typeof server?.enable === "undefined") {
					needsSave = true;
					break;
				}
			}
		}

		// Save back if defaults were added
		if (needsSave) {
			saveMcpConfig(validated);
		}

		return validated;
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Failed to load MCP config from ${configPath}: ${error.message}`);
		}
		throw error;
	}
}

/**
 * Saves the MCP configuration to ~/.agent-switchboard/mcp.json
 * Preserves comments and formatting when modifying existing files
 * Creates directory and file if they don't exist
 *
 * @param {McpConfig} config - Configuration to save
 * @throws {Error} If config fails schema validation or write operation fails
 */
export function saveMcpConfig(config: McpConfig): void {
    const configPath = getMcpConfigPath();
    const configDir = getConfigDir();

    try {
        // Validate config against schema before saving
        const validated = mcpConfigSchema.parse(config);

        // Ensure directory exists
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        // Pretty print with 4 spaces; do not preserve comments; ensure trailing newline
        const json = JSON.stringify(validated, null, 4) + "\n";
        fs.writeFileSync(configPath, json, "utf-8");
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to save MCP config to ${configPath}: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Updates enable flags for MCP servers based on selection
 * Preserves comments and unknown fields
 *
 * @param {string[]} enabledServerNames - Array of server names to enable
 */
export function updateEnableFlags(enabledServerNames: string[]): void {
	const config = loadMcpConfig();
	const enabledSet = new Set(enabledServerNames);

	// Update enable flag for each server
	for (const [name, server] of Object.entries(config.mcpServers)) {
		server.enable = enabledSet.has(name);
	}

	saveMcpConfig(config);
}
