/**
 * Library subscription management utilities
 * Handles adding, removing, and listing library source subscriptions
 */

import fs from 'node:fs';
import path from 'node:path';
import { updateConfigLayer } from '../config/layered-config.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';

export interface Subscription {
  namespace: string;
  path: string;
}

/**
 * Get all library subscriptions from config
 */
export function getSubscriptions(): Subscription[] {
  const config = loadSwitchboardConfig();
  const subs = config.library.subscriptions;
  return Object.entries(subs).map(([namespace, subPath]) => ({
    namespace,
    path: subPath,
  }));
}

/**
 * Get subscriptions as a record (namespace -> path)
 */
export function getSubscriptionsRecord(): Record<string, string> {
  const config = loadSwitchboardConfig();
  return config.library.subscriptions;
}

/**
 * Add a library subscription
 * @param namespace - Unique namespace for this subscription
 * @param libraryPath - Path to the library directory
 * @throws Error if namespace already exists or path is invalid
 */
export function addSubscription(namespace: string, libraryPath: string): void {
  const resolvedPath = path.resolve(libraryPath);

  // Validate path exists and is a directory
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  // Validate namespace format (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}". Use only letters, numbers, hyphens, and underscores.`
    );
  }

  // Check if namespace already exists
  const current = getSubscriptionsRecord();
  if (namespace in current) {
    throw new Error(
      `Namespace "${namespace}" already exists. Use a different name or unsubscribe first.`
    );
  }

  // Update config
  updateConfigLayer((layer) => ({
    ...layer,
    library: {
      ...layer.library,
      subscriptions: {
        ...(layer.library?.subscriptions ?? {}),
        [namespace]: resolvedPath,
      },
    },
  }));
}

/**
 * Remove a library subscription by namespace
 * @param namespace - Namespace to remove
 * @throws Error if namespace doesn't exist
 */
export function removeSubscription(namespace: string): void {
  const current = getSubscriptionsRecord();
  if (!(namespace in current)) {
    throw new Error(`Namespace "${namespace}" not found in subscriptions.`);
  }

  updateConfigLayer((layer) => {
    const newSubs = { ...(layer.library?.subscriptions ?? {}) };
    delete newSubs[namespace];
    return {
      ...layer,
      library: {
        ...layer.library,
        subscriptions: newSubs,
      },
    };
  });
}

/**
 * Check if a subscription namespace exists
 */
export function hasSubscription(namespace: string): boolean {
  const current = getSubscriptionsRecord();
  return namespace in current;
}

/**
 * Validate a subscription path has expected library structure
 * Returns list of found library types
 */
export function validateSubscriptionPath(libraryPath: string): {
  valid: boolean;
  found: string[];
  missing: string[];
} {
  const resolvedPath = path.resolve(libraryPath);
  const libraryTypes = ['rules', 'commands', 'subagents', 'skills'];
  const found: string[] = [];
  const missing: string[] = [];

  for (const type of libraryTypes) {
    const typePath = path.join(resolvedPath, type);
    if (fs.existsSync(typePath) && fs.statSync(typePath).isDirectory()) {
      found.push(type);
    } else {
      missing.push(type);
    }
  }

  return {
    valid: found.length > 0,
    found,
    missing,
  };
}
