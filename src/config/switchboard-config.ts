/**
 * Agent Switchboard configuration loader and saver (TOML format)
 * Manages the list of agents to apply MCP configs to
 */

import fs from 'node:fs';
import { parse, stringify } from '@iarna/toml';
import { getConfigDir, getSwitchboardConfigPath } from './paths.js';
import { type SwitchboardConfig, switchboardConfigSchema } from './schemas.js';

/**
 * Loads the Agent Switchboard configuration from ~/.agent-switchboard/config.toml
 * Returns default empty agents list if file doesn't exist
 *
 * @returns {SwitchboardConfig} Parsed and validated configuration
 * @throws {Error} If file exists but contains invalid TOML or fails schema validation
 */
export function loadSwitchboardConfig(): SwitchboardConfig {
  const configPath = getSwitchboardConfigPath();

  // Return default config if file doesn't exist
  if (!fs.existsSync(configPath)) {
    return switchboardConfigSchema.parse({});
  }

  try {
    // Read file content
    const content = fs.readFileSync(configPath, 'utf-8');

    // Parse TOML
    const parsed = parse(content);

    // Validate against Zod schema
    const validated = switchboardConfigSchema.parse(parsed);

    return validated;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to load Agent Switchboard config from ${configPath}: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Saves the Agent Switchboard configuration to ~/.agent-switchboard/config.toml
 * Creates directory and file if they don't exist
 *
 * @param {SwitchboardConfig} config - Configuration to save
 * @throws {Error} If config fails schema validation or write operation fails
 */
export function saveSwitchboardConfig(config: SwitchboardConfig): void {
  const configPath = getSwitchboardConfigPath();
  const configDir = getConfigDir();

  try {
    // Validate config against schema before saving
    const validated = switchboardConfigSchema.parse(config);

    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Stringify to TOML format
    const portable = JSON.parse(JSON.stringify(validated));
    // biome-ignore lint/suspicious/noExplicitAny: TOML stringify requires JsonMap typing
    const content = stringify(portable as any);

    // Write to file
    fs.writeFileSync(configPath, content, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to save Agent Switchboard config to ${configPath}: ${error.message}`);
    }
    throw error;
  }
}
