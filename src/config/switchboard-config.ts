/**
 * Agent Switchboard configuration loader and saver (TOML format)
 * Manages target applications and library state
 */

import fs from 'node:fs';
import { stringify } from '@iarna/toml';
import type { ConfigLayers, LoadConfigLayersOptions } from './layered-config.js';
import { loadMergedSwitchboardConfig } from './layered-config.js';
import { getConfigDir, getSwitchboardConfigPath } from './paths.js';
import { type SwitchboardConfig, switchboardConfigSchema } from './schemas.js';

export interface SwitchboardConfigLoadOptions extends LoadConfigLayersOptions {}

export interface SwitchboardConfigLoadResult {
  config: SwitchboardConfig;
  layers: ConfigLayers;
}

/**
 * Loads the Agent Switchboard configuration from ~/.agent-switchboard/config.toml.
 * Returns default empty applications list if file doesn't exist.
 */
export function loadSwitchboardConfig(options?: SwitchboardConfigLoadOptions): SwitchboardConfig {
  return loadMergedSwitchboardConfig(options).config;
}

export function loadSwitchboardConfigWithLayers(
  options?: SwitchboardConfigLoadOptions
): SwitchboardConfigLoadResult {
  return loadMergedSwitchboardConfig(options);
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
