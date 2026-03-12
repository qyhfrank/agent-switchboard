/**
 * Target system initialization.
 *
 * Registers config-driven targets and loads extension modules.
 * Should be called once after config is loaded, before distribution.
 */

import type { SwitchboardConfig } from '../config/schemas.js';
import { loadExtensions } from '../extensions/loader.js';
import { clearExtensionTargets, registerConfigTargets } from './registry.js';

let initialized = false;

/**
 * Initialize the target system: compile config-driven targets, load extensions.
 * Safe to call multiple times; only runs initialization once.
 */
export async function initTargets(config: SwitchboardConfig): Promise<void> {
  if (initialized) return;
  initialized = true;

  const targets = (config as Record<string, unknown>).targets as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (targets && Object.keys(targets).length > 0) {
    registerConfigTargets(targets);
  }

  await loadExtensions(config);
}

/** Reset initialization state and clear extension targets (for testing) */
export function resetTargetInit(): void {
  initialized = false;
  clearExtensionTargets();
}
