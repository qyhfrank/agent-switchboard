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

export function hashContent(content: string | Buffer): string {
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
// Own-dir shape (skill bundles): source walk, tree fingerprint, mode repair
// ---------------------------------------------------------------------------

export interface BundleFile {
  /** Path relative to the bundle root, '/'-separated. */
  rel: string;
  bytes: Buffer;
  /** Permission bits (mode & 0o777) of the source file. */
  mode: number;
}

/**
 * Desired bundle content from a library source directory. Dot-prefixed
 * entries are skipped at every level (source-side convention), symlinks and
 * non-regular files are skipped, and entries sort per level for determinism.
 */
export function listBundleFiles(root: string): BundleFile[] {
  const files: BundleFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const filePath = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(filePath, rel);
      } else if (entry.isFile()) {
        files.push({
          rel,
          bytes: fs.readFileSync(filePath),
          mode: fs.lstatSync(filePath).mode & 0o777,
        });
      }
    }
  };
  walk(path.resolve(root), '');
  return files;
}

/**
 * Frozen 0.4.35 tree hash over a target bundle: `tree:<sha256>` covering
 * every entry (dot files included), its rel path, and its permission bits.
 * Any symlink, non-regular entry, or non-directory root makes the tree
 * unprovable → undefined. Byte-compatible with 0.4 per-device manifests.
 */
export function bundleFingerprint(dir: string): string | undefined {
  let root: fs.Stats;
  try {
    root = fs.lstatSync(dir);
  } catch {
    return undefined;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) return undefined;
  const hash = createHash('sha256');
  const visit = (current: string, prefix = ''): boolean => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(current, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        hash.update(`d\0${relativePath}\0${stat.mode & 0o777}\0`);
        if (!visit(filePath, relativePath)) return false;
      } else if (stat.isFile()) {
        hash.update(`f\0${relativePath}\0${stat.mode & 0o777}\0`);
        hash.update(fs.readFileSync(filePath));
      } else {
        return false;
      }
    }
    return true;
  };
  if (!visit(path.resolve(dir))) return undefined;
  return `tree:${hash.digest('hex')}`;
}

export function executableBits(mode: number): number {
  return mode & 0o111;
}

/**
 * Frozen 0.4 mode contract: an executable source demands the exact source
 * mode on the target; a non-executable source only demands no exec bits.
 */
export function targetModeMatchesSourceExecutableBits(srcMode: number, dstMode: number): boolean {
  if (executableBits(srcMode) !== 0) {
    return dstMode === srcMode;
  }
  return executableBits(dstMode) === 0;
}

/** The mode a written target file should end up with (frozen 0.4 repair rule). */
export function desiredTargetMode(srcMode: number, currentMode: number): number {
  if (executableBits(srcMode) !== 0) {
    return srcMode;
  }
  return currentMode & 0o666;
}

export interface TargetFile {
  rel: string;
  hash: string;
  mode: number;
}

/**
 * Target-side bundle inventory: every file including dot files, hashed, with
 * permission bits. Null when any entry is a symlink or non-regular file —
 * such a tree is unprovable and gets neither byte comparison nor authority.
 */
export function listTargetFiles(dir: string): TargetFile[] | null {
  try {
    const root = fs.lstatSync(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const files: TargetFile[] = [];
  const visit = (current: string, prefix: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!visit(filePath, rel)) return false;
      } else if (stat.isFile()) {
        files.push({ rel, hash: hashContent(fs.readFileSync(filePath)), mode: stat.mode & 0o777 });
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(path.resolve(dir), '') ? files : null;
}

/** Prune now-empty directories along a rel path's parent chain, bottom-up. */
function pruneEmptyParents(bundleRoot: string, rel: string): void {
  let parent = path.posix.dirname(rel);
  while (parent !== '.' && parent !== '') {
    const dirPath = path.join(bundleRoot, parent);
    try {
      if (fs.readdirSync(dirPath).length > 0) return;
      fs.rmdirSync(dirPath);
    } catch {
      return;
    }
    parent = path.posix.dirname(parent);
  }
}

/**
 * Reconcile an owned bundle directory to the desired file set: write files
 * whose bytes or mode differ (atomic, mode per the 0.4 repair rule), delete
 * exactly the stale rels the caller's ownership record names, and prune
 * directories those deletions emptied. Files the record never covered are
 * left in place.
 */
export function applyBundleFiles(
  bundleRoot: string,
  files: readonly BundleFile[],
  stale: readonly string[]
): void {
  const root = path.resolve(bundleRoot);
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) {
    const filePath = path.join(root, file.rel);
    let currentMode: number | null = null;
    let equal = false;
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile()) {
        currentMode = stat.mode & 0o777;
        equal = Buffer.compare(fs.readFileSync(filePath), file.bytes) === 0;
      }
    } catch {
      // absent: written fresh below
    }
    if (!equal) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, file.bytes);
      currentMode = fs.lstatSync(filePath).mode & 0o777;
    }
    if (currentMode !== null && !targetModeMatchesSourceExecutableBits(file.mode, currentMode)) {
      fs.chmodSync(filePath, desiredTargetMode(file.mode, currentMode));
    }
  }
  const desired = new Set(files.map((file) => file.rel));
  for (const rel of stale) {
    if (desired.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(root, rel));
    } catch {
      // already gone
    }
    pruneEmptyParents(root, rel);
  }
}

/**
 * Remove an owned bundle's recorded files, prune emptied directories, and
 * drop the bundle directory itself only when nothing foreign remains.
 * Returns true when the directory is fully gone.
 */
export function removeBundleSlice(bundleRoot: string, recorded: readonly string[]): boolean {
  const root = path.resolve(bundleRoot);
  for (const rel of recorded) {
    try {
      fs.unlinkSync(path.join(root, rel));
    } catch {
      // already gone
    }
    pruneEmptyParents(root, rel);
  }
  try {
    if (fs.readdirSync(root).length === 0) {
      fs.rmdirSync(root);
      return true;
    }
  } catch {
    return !fs.existsSync(root);
  }
  return false;
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
    // A dangling symlink is still written through: resolve the link chain by
    // hand (0.4's writeFileSync followed it and created the backing file);
    // replacing the link with a plain file would break the user's setup.
    let followed = absolute;
    let endsAtNonLink = false;
    for (let depth = 0; depth < 32; depth++) {
      let link: string;
      try {
        link = fs.readlinkSync(followed);
      } catch {
        endsAtNonLink = true;
        break;
      }
      followed = path.resolve(path.dirname(followed), link);
    }
    if (!endsAtNonLink) {
      // 32 hops without reaching a non-link: a cycle. 0.4's writeFileSync
      // threw ELOOP here; renaming over the link would destroy it.
      throw new Error(`ELOOP: too many symbolic links encountered, '${absolute}'`);
    }
    if (followed !== absolute) return resolveWritePath(followed);

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
  try {
    const resolvedRoot = resolveWritePath(root);
    const resolvedParent = resolveWritePath(path.dirname(path.resolve(targetPath)));
    const relative = path.relative(resolvedRoot, resolvedParent);
    return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
  } catch {
    // Unresolvable (a link cycle in the chain): not provably contained. The
    // row blocks; the run and every other app continue.
    return true;
  }
}

/**
 * Atomic write through symlinks: the temp file is created in the resolved
 * target's own directory and renamed over the resolved path.
 */
export function writeFileAtomic(targetPath: string, content: string | Buffer): void {
  const resolved = resolveWritePath(targetPath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(resolved)}.asb-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    if (typeof content === 'string') fs.writeFileSync(temp, content, 'utf-8');
    else fs.writeFileSync(temp, content);
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
