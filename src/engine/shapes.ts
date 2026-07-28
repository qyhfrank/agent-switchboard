import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write shapes and slice renderers. Every owned slice is defined here in
 * exactly one place: how it renders, how it hashes, how it is written and
 * removed. Writes resolve symlinks first and go through them; the temp file
 * lives in the resolved target's own directory so rename never crosses
 * devices.
 */

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Rules aggregate render (frozen 0.4.35 compose semantics)
// ---------------------------------------------------------------------------

export interface ComposableRule {
  id: string;
  content: string;
  metadata?: { title?: string };
}

export interface ComposedSection {
  id: string;
  title: string | null;
  content: string;
}

export interface ComposedRules {
  content: string;
  hash: string;
  sections: ComposedSection[];
}

function normalizeRuleContent(content: string): string {
  const unix = content.replace(/\r\n/g, '\n');
  const trimmed = unix.replace(/\s+$/u, '');
  if (trimmed.length === 0) return '';
  return `${trimmed}\n`;
}

/**
 * Compose rule bodies in caller order (selection order is composition order).
 * With delimiters, each section is wrapped in `<!-- id:start/end -->` markers.
 */
export function composeRules(
  rules: readonly ComposableRule[],
  options?: { includeDelimiters?: boolean }
): ComposedRules {
  if (rules.length === 0) {
    return { content: '', hash: hashContent(''), sections: [] };
  }

  const includeDelimiters = options?.includeDelimiters === true;
  const sections: ComposedSection[] = [];
  const blocks: string[] = [];

  for (const rule of rules) {
    const section: ComposedSection = {
      id: rule.id,
      title: rule.metadata?.title ?? null,
      content: normalizeRuleContent(rule.content),
    };
    sections.push(section);

    if (includeDelimiters) {
      let block = `<!-- ${rule.id}:start -->\n`;
      if (section.content.length > 0) block += section.content;
      block += `<!-- ${rule.id}:end -->\n`;
      blocks.push(block);
    } else if (section.content.length > 0) {
      blocks.push(section.content);
    }
  }

  const content = blocks.join('\n');
  return { content, hash: hashContent(content), sections };
}

// ---------------------------------------------------------------------------
// Region shape (markdown hosts; delimiters double as on-disk ownership proof)
// ---------------------------------------------------------------------------

const REGION_START = '<!-- asb:rules:start -->';
const REGION_END = '<!-- asb:rules:end -->';

export type RegionPlacement = 'prepend' | 'append';

/**
 * Merge managed content into a shared host, preserving everything outside the
 * markers. Existing marker pair → replace between them; no markers → insert
 * per placement; empty content → remove the block entirely.
 */
export function mergeRegion(
  existing: string,
  content: string,
  placement: RegionPlacement = 'prepend'
): string {
  const startIdx = existing.indexOf(REGION_START);
  const endIdx = existing.indexOf(REGION_END);

  if (content.length === 0) {
    if (startIdx !== -1 && endIdx !== -1) return removeRegion(existing);
    return existing;
  }

  const block = `${REGION_START}\n${content.trimEnd()}\n${REGION_END}`;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + REGION_END.length);
    return `${before}${block}${after}`;
  }

  const trimmed = existing.trimEnd();
  if (trimmed.length === 0) return `${block}\n`;
  if (placement === 'prepend') return `${block}\n\n${trimmed}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/** Remove the managed block and its markers, preserving the rest. */
export function removeRegion(content: string): string {
  const startIdx = content.indexOf(REGION_START);
  const endIdx = content.indexOf(REGION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + REGION_END.length);

  const result = (before + after).replace(/\n{3,}/g, '\n\n').trim();
  return result.length > 0 ? `${result}\n` : '';
}

/** The managed slice of a host, or null when no marker pair exists. */
export function extractRegion(content: string): string | null {
  const startIdx = content.indexOf(REGION_START);
  const endIdx = content.indexOf(REGION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return content.slice(startIdx, endIdx + REGION_END.length);
}

/** True when the host has asb's own region markers (ownership proof 2). */
export function hasRegionMarkers(content: string): boolean {
  return extractRegion(content) !== null;
}

/**
 * A dedicated asb file (asb-rules prefix) is safe for full replace; a shared
 * file needs region merge in managed contexts.
 */
export function isDedicatedFile(filePath: string): boolean {
  const basename = path.basename(filePath).split('\\').pop() ?? '';
  return basename.startsWith('asb-rules');
}

// ---------------------------------------------------------------------------
// Write mechanics (symlink-through, atomic, contained)
// ---------------------------------------------------------------------------

/**
 * Resolve the real write location for a target path: the file itself when it
 * exists (following links), else the resolved parent joined with the leaf.
 * Missing ancestor directories resolve through their deepest existing parent.
 */
export function resolveWritePath(targetPath: string): string {
  const absolute = path.resolve(targetPath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // Target does not exist yet: resolve the deepest existing ancestor.
    let existing = path.dirname(absolute);
    const pending: string[] = [path.basename(absolute)];
    while (!fs.existsSync(existing)) {
      pending.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    let resolvedBase: string;
    try {
      resolvedBase = fs.realpathSync(existing);
    } catch {
      resolvedBase = existing;
    }
    return path.join(resolvedBase, ...pending);
  }
}

/** True when `candidate` (resolved) sits inside `root` (resolved). */
export function isContainedIn(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Escape check for a declared target: its PARENT chain must resolve inside
 * the app root. The file's own symlink is deliberately not followed here —
 * a user-linked target file (Mackup) is written through, while a parent
 * directory swapped for a link pointing elsewhere is an escape.
 */
export function targetEscapesRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = resolveWritePath(root);
  const resolvedParent = resolveWritePath(path.dirname(path.resolve(targetPath)));
  const relative = path.relative(resolvedRoot, resolvedParent);
  return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
}

/**
 * Atomic write through symlinks: the temp file is created in the resolved
 * target's own directory and renamed over the resolved path.
 */
export function writeFileAtomic(targetPath: string, content: string): void {
  const resolved = resolveWritePath(targetPath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(resolved)}.asb-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    fs.writeFileSync(temp, content, 'utf-8');
    fs.renameSync(temp, resolved);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort: the temp file may never have been created
    }
    throw error;
  }
}

/**
 * Remove the managed file at its declared path. A symlinked target loses the
 * link only — the user's backing file (Mackup store) is never deleted, and no
 * dangling link is left behind by removing the destination instead.
 */
export function removeManagedFile(targetPath: string): void {
  fs.unlinkSync(path.resolve(targetPath));
}
