/**
 * Shared helpers for built-in target implementations.
 */

import path from 'node:path';
import type { ConfigScope } from '../../config/scope.js';
import type { GenericLibraryEntry } from '../types.js';

/**
 * Extract platform-specific extras from a library entry's frontmatter.
 */
export function getPlatformExtras(
  entry: GenericLibraryEntry,
  platformKey: string
): Record<string, unknown> | undefined {
  const extras = entry.metadata.extras;
  if (!extras) return undefined;
  const val = extras[platformKey];
  return typeof val === 'object' && val !== null ? (val as Record<string, unknown>) : undefined;
}

/**
 * Build frontmatter by merging base description with platform-specific extras.
 * Common pattern used by claude-code, opencode, and similar markdown-based targets.
 */
export function buildPlatformFrontmatter(
  entry: GenericLibraryEntry,
  platformKey: string
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  const extras = getPlatformExtras(entry, platformKey);
  if (extras) {
    for (const [k, v] of Object.entries(extras)) base[k] = v;
  }
  return base;
}

/** MDC frontmatter wrapper for rules (used by cursor, trae) */
export function wrapMdcFrontmatter(body: string): string {
  const lines = ['---', 'description: Agent Switchboard Rules', 'alwaysApply: true', '---', ''];
  if (body.length > 0) {
    lines.push(body);
  }
  return lines.join('\n');
}

/** Extract entry ID from a .md filename */
export function extractMdId(filename: string): string | null {
  if (filename.endsWith('.md')) return filename.slice(0, -3);
  if (filename.endsWith('.markdown')) return filename.slice(0, -9);
  return null;
}

/** Extract entry ID from a .toml filename */
export function extractTomlId(filename: string): string | null {
  return filename.endsWith('.toml') ? filename.slice(0, -5) : null;
}

/** Resolve project root, returning undefined if not set */
export function resolveProjectRoot(scope?: ConfigScope): string | undefined {
  const p = scope?.project?.trim();
  return p && p.length > 0 ? path.resolve(p) : undefined;
}
