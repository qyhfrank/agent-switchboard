/**
 * Application Target registry.
 *
 * Merges built-in targets with extension-registered targets.
 * Distribution modules query this registry to discover active targets.
 */

import { BUILTIN_TARGETS } from './builtin/index.js';
import { compileTargetSpec } from './dsl/compiler.js';
import type { ApplicationTarget, TargetSection } from './types.js';

const extensionTargets: ApplicationTarget[] = [];

/** Get a target by ID (built-in or extension-registered) */
export function getTargetById(id: string): ApplicationTarget | undefined {
  return extensionTargets.find((t) => t.id === id) ?? BUILTIN_TARGETS.find((t) => t.id === id);
}

/** Get all known target IDs (built-in + extension) */
export function allTargetIds(): string[] {
  const ids = new Set<string>();
  for (const t of BUILTIN_TARGETS) ids.add(t.id);
  for (const t of extensionTargets) ids.add(t.id);
  return [...ids];
}

/** Check if a target ID is known (built-in or extension-registered) */
export function isKnownTarget(id: string): boolean {
  return getTargetById(id) !== undefined;
}

/**
 * Get active targets filtered by a specific section capability.
 * Only returns targets that: (1) are in activeAppIds, (2) support the section.
 */
export function getActiveTargetsForSection(
  section: TargetSection,
  activeAppIds: string[]
): ApplicationTarget[] {
  const result: ApplicationTarget[] = [];
  for (const appId of activeAppIds) {
    const target = getTargetById(appId);
    if (!target) continue;
    if (target[section]) result.push(target);
  }
  return result;
}

/**
 * Register an extension-provided target.
 * Extension targets take precedence over built-in targets with the same ID.
 */
export function registerExtensionTarget(target: ApplicationTarget): void {
  const existing = extensionTargets.findIndex((t) => t.id === target.id);
  if (existing >= 0) {
    extensionTargets[existing] = target;
  } else {
    extensionTargets.push(target);
  }
}

/**
 * Get all targets (built-in + extension) that support a given section,
 * regardless of whether they are in `applications.active`.
 * Used by distribution modules to enumerate all known platforms.
 */
export function getTargetsForSection(section: TargetSection): ApplicationTarget[] {
  const seen = new Set<string>();
  const result: ApplicationTarget[] = [];
  for (const t of extensionTargets) {
    if (t[section]) {
      result.push(t);
      seen.add(t.id);
    }
  }
  for (const t of BUILTIN_TARGETS) {
    if (seen.has(t.id)) continue;
    if (t[section]) result.push(t);
  }
  return result;
}

/**
 * Register targets defined via [targets.<id>] in config.toml.
 * Each entry is compiled from its TargetSpec into an ApplicationTarget.
 */
export function registerConfigTargets(targets: Record<string, Record<string, unknown>>): void {
  for (const [id, spec] of Object.entries(targets)) {
    try {
      const target = compileTargetSpec(id, spec);
      registerExtensionTarget(target);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[asb] Failed to compile config target "${id}": ${msg}`);
    }
  }
}

/**
 * Filter targets to only those that are installed (or have no detection).
 * Targets in `assumeInstalled` bypass the detection check.
 */
export function filterInstalled(
  targets: ApplicationTarget[],
  assumeInstalled?: ReadonlySet<string>
): ApplicationTarget[] {
  return targets.filter((t) => assumeInstalled?.has(t.id) || t.isInstalled?.() !== false);
}

/** Clear all extension targets (for testing) */
export function clearExtensionTargets(): void {
  extensionTargets.length = 0;
}
