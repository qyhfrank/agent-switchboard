import type { ConfigLayers, LoadConfigLayersOptions } from './layered-config.js';
import { loadMergedSwitchboardConfig } from './layered-config.js';
import type { SwitchboardConfig } from './schemas.js';

export interface SwitchboardConfigLoadOptions extends LoadConfigLayersOptions {}

export interface SwitchboardConfigLoadResult {
  config: SwitchboardConfig;
  layers: ConfigLayers;
}

/**
 * Loads the Agent Switchboard configuration from the resolved user config path.
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
