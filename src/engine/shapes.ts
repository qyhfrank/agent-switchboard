import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as tomlStringify } from '@iarna/toml';
import {
  applyEdits,
  modify,
  type Node,
  type ParseError,
  parse as parseJsonc,
  parseTree,
} from 'jsonc-parser';
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml';

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

/**
 * Whether `content` is a composition of the given rule blocks and nothing
 * else. A version that wrote the whole host file left no marker to find, so
 * this is how such a file is still recognized as a render rather than as
 * something the user wrote: it reassembles from library blocks, joined the
 * way `composeRules` joins them.
 */
export function composedFromRuleBlocks(content: string, blocks: readonly string[]): boolean {
  if (content.length === 0 || blocks.length === 0) return false;
  let position = 0;
  while (position < content.length) {
    let matched = 0;
    for (const block of blocks) {
      if (block.length > matched && content.startsWith(block, position)) matched = block.length;
    }
    if (matched === 0) return false;
    position += matched;
    if (position === content.length) return true;
    if (content[position] !== '\n') return false;
    position += 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Region shape (markdown hosts; delimiters double as on-disk ownership proof)
// ---------------------------------------------------------------------------

const REGION_START = '<!-- rules:start -->';
const REGION_END = '<!-- rules:end -->';

/**
 * The pair an earlier version wrote. Locating accepts it so a host it wrapped
 * is found and rewritten rather than gaining a second region; writing only
 * ever emits the current pair.
 */
const LEGACY_REGION_START = '<!-- asb:rules:start -->';
const LEGACY_REGION_END = '<!-- asb:rules:end -->';

export type RegionPlacement = 'prepend' | 'append';

/**
 * The name an earlier version gave a dedicated rules file at this same path.
 * Sweeping it is what carries a machine across the rename; it goes once no
 * supported upgrade path still starts from a file carrying the old prefix.
 */
export function legacyDedicatedRulesPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `asb-${path.basename(targetPath)}`);
}

function markerOffsets(content: string, marker: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const offset = content.indexOf(marker, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + marker.length;
  }
  return offsets;
}

/**
 * Project AGENTS.md has a distinct peer marker contract. Any partial,
 * duplicated, or reordered marker set is ambiguous ownership and fails closed.
 */
export function projectRegion(content: string): string | null {
  const currentStarts = markerOffsets(content, REGION_START);
  const currentEnds = markerOffsets(content, REGION_END);
  const legacyStarts = markerOffsets(content, LEGACY_REGION_START);
  const legacyEnds = markerOffsets(content, LEGACY_REGION_END);

  const starts = [...currentStarts, ...legacyStarts];
  const ends = [...currentEnds, ...legacyEnds];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1 || ends.length > 1) {
    throw new Error('duplicate managed project markers');
  }
  const current = currentStarts.length === 1 && currentEnds.length === 1;
  const legacy = legacyStarts.length === 1 && legacyEnds.length === 1;
  if (!current && !legacy) {
    throw new Error('incomplete managed project markers');
  }
  if (starts[0] >= ends[0]) throw new Error('reordered managed project markers');
  return content.slice(starts[0], ends[0] + (current ? REGION_END : LEGACY_REGION_END).length);
}

export function mergeProjectRegion(
  existing: string,
  content: string,
  placement: RegionPlacement = 'prepend'
): string {
  const region = projectRegion(existing);
  const start = region === null ? -1 : existing.indexOf(region);
  if (content.length === 0) {
    if (region === null) return existing;
    let removeStart = start;
    let removeEnd = start + region.length;
    if (removeStart === 0) {
      if (existing.startsWith('\n\n', removeEnd)) removeEnd += 2;
      else if (existing.slice(removeEnd) === '\n') removeEnd += 1;
    } else if (existing.slice(removeEnd) === '\n') {
      removeEnd += 1;
      if (existing.slice(0, removeStart).endsWith('\n\n')) removeStart -= 1;
    }
    return `${existing.slice(0, removeStart)}${existing.slice(removeEnd)}`;
  }
  const block = `${REGION_START}\n${content.trimEnd()}\n${REGION_END}`;
  if (region !== null) {
    return `${existing.slice(0, start)}${block}${existing.slice(start + region.length)}`;
  }
  const trimmed = existing.trimEnd();
  if (trimmed.length === 0) return `${block}\n`;
  return placement === 'prepend' ? `${block}\n\n${trimmed}\n` : `${trimmed}\n\n${block}\n`;
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
): string[] {
  const root = path.resolve(bundleRoot);
  const leftBehind: string[] = [];
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
      if (fs.existsSync(path.join(root, rel))) leftBehind.push(rel);
    }
    pruneEmptyParents(root, rel);
  }
  return leftBehind;
}

/**
 * Remove the files the render names inside a bundle, prune emptied
 * directories, and drop the bundle directory itself only when nothing foreign
 * remains. Returns the named rels still on disk afterwards: a deletion that
 * could not happen must never be reported as one. An empty result means asb's
 * whole slice is gone, whether or not foreign files kept the directory alive.
 */
export function removeBundleSlice(bundleRoot: string, slice: readonly string[]): string[] {
  const root = path.resolve(bundleRoot);
  const leftBehind: string[] = [];
  for (const rel of slice) {
    const filePath = path.join(root, rel);
    try {
      fs.unlinkSync(filePath);
    } catch {
      if (fs.existsSync(filePath)) leftBehind.push(rel);
    }
    pruneEmptyParents(root, rel);
  }
  try {
    if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch {
    // Gone already, or holding files the render never named.
  }
  return leftBehind;
}

// ---------------------------------------------------------------------------
// Keys shape (structured hosts): addressed slices, byte-preserving elsewhere
// ---------------------------------------------------------------------------

export type KeysFormat = 'json' | 'toml' | 'yaml';

const KEYED_ARRAY_PREFIX = '@array:';

/**
 * One persisted identity segment. Percent encoding keeps the grammar
 * unambiguous for component ids containing `:`, `@`, `=`, or `]`.
 */
export function keyedArraySegment(key: string, field: string, identity: string): string {
  return `${KEYED_ARRAY_PREFIX}${encodeURIComponent(key)}[${encodeURIComponent(field)}=${encodeURIComponent(identity)}]`;
}

interface KeyedArrayAddress {
  key: string;
  field: string;
  identity: string;
}

function parseKeyedArraySegment(segment: string): KeyedArrayAddress | null {
  if (!segment.startsWith(KEYED_ARRAY_PREFIX)) return null;
  const match = /^@array:([^[]+)\[([^=\]]+)=([^\]]*)\]$/.exec(segment);
  if (!match) return null;
  try {
    return {
      key: decodeURIComponent(match[1]),
      field: decodeURIComponent(match[2]),
      identity: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

export function keyedArrayProblem(
  root: Record<string, unknown>,
  key: string,
  field: string
): string | null {
  const value = root[key];
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${key} is not an array`;
  const seen = new Set<string>();
  for (const member of value) {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) {
      return `${key} contains a member that is not an object`;
    }
    const identity = (member as Record<string, unknown>)[field];
    if (typeof identity !== 'string' || identity.length === 0) {
      return `${key} contains a member missing identity field "${field}"`;
    }
    if (seen.has(identity)) return `${key} contains duplicate identity "${identity}"`;
    seen.add(identity);
  }
  return null;
}

export interface StructuredDocument {
  /** Parsed root, or null when the document is unreadable or not an object. */
  root: Record<string, unknown> | null;
  /** Why the document could not be used. */
  error?: string;
  /**
   * TOML only: the table headers the byte-splice writer can address, one
   * segment array per header. Segments stay separate because the joined
   * spelling is lossy: `[a."b.c"]` names a sibling `b.c`, not a descendant
   * `b` -> `c`. A key the document expresses some other way (inline table,
   * dotted assignment) is readable but not editable, so it is never spliced.
   */
  tables: string[][];
}

/** Render header segments back to TOML spelling, quoting non-bare segments. */
export function tomlHeaderName(parts: readonly string[]): string {
  return parts
    .map((part) =>
      TOML_BARE_KEY.test(part) ? part : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    )
    .join('.');
}

/**
 * A TOML parse failure, position only. `@iarna/toml` quotes the failing source
 * lines under its message, and a host's MCP `env` values live on those lines;
 * a document error travels into reports, so it carries what the JSON branch
 * carries — where the parser stopped, never what it read there.
 */
function tomlErrorText(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid TOML';
  const [head] = error.message.split('\n');
  return head.replace(/,? pos \d+:?\s*$/, '').trim() || 'invalid TOML';
}

/** Read a structured host. JSON hosts are parsed as JSONC: comments are legal. */
export function parseStructured(content: string, format: KeysFormat): StructuredDocument {
  if (content.trim().length === 0) return { root: {}, tables: [] };
  if (format === 'toml') {
    try {
      const parsed = parseToml(content) as Record<string, unknown>;
      return { root: parsed, tables: scanTomlTables(content).map((table) => table.parts) };
    } catch (error) {
      return { root: null, error: tomlErrorText(error), tables: [] };
    }
  }
  if (format === 'yaml') {
    const document = parseDocument(content, { keepSourceTokens: true });
    if (document.errors.length > 0) {
      const position = document.errors[0]?.linePos?.[0];
      const at = position ? ` at line ${position.line}, column ${position.col}` : '';
      return { root: null, error: `invalid YAML${at}`, tables: [] };
    }
    if (document.contents !== null && !isMap(document.contents)) {
      return { root: null, error: 'document root must be an object', tables: [] };
    }
    return {
      root: (document.toJS() ?? {}) as Record<string, unknown>,
      tables: [],
    };
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    return { root: null, error: `invalid JSON at offset ${errors[0].offset}`, tables: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { root: null, error: 'document root must be an object', tables: [] };
  }
  return { root: parsed as Record<string, unknown>, tables: [] };
}

/** The value a key path addresses, or undefined when nothing is there. */
export function valueAtKeyPath(
  root: Record<string, unknown> | null,
  keyPath: readonly string[]
): unknown {
  let current: unknown = root;
  for (const segment of keyPath) {
    const address = keyPath.length === 1 ? parseKeyedArraySegment(segment) : null;
    if (address) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      const members = (current as Record<string, unknown>)[address.key];
      if (!Array.isArray(members)) return undefined;
      current = members.find(
        (member) =>
          member !== null &&
          typeof member === 'object' &&
          !Array.isArray(member) &&
          (member as Record<string, unknown>)[address.field] === address.identity
      );
      continue;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Ownership hash of one owned slice: the value asb renders there, order
 * included. Reformatting the host leaves it alone; editing the value inside
 * asb's key does not.
 */
export function sliceHash(value: unknown): string {
  return hashContent(JSON.stringify(value ?? null));
}

/** Upsert (`value`) or reclaim (`remove`) one addressed slice. */
export interface KeysEdit {
  keyPath: readonly string[];
  value?: unknown;
  /** TOML: the fully rendered table block, header included. */
  text?: string;
  /** TOML: address one assignment inside the parent table, not a table block. */
  scalar?: true;
  remove?: true;
}

/**
 * The document's own indentation and line ending, so a written slice reads
 * like the file it lands in rather than imposing asb's defaults on it.
 */
function jsonFormatting(content: string): { tabSize: number; insertSpaces: boolean; eol: string } {
  const indent = content.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return indent.startsWith('\t')
    ? { tabSize: 2, insertSpaces: false, eol }
    : { tabSize: indent.length, insertSpaces: true, eol };
}

/**
 * Apply every edit to one host in one pass. JSON goes through jsonc-parser's
 * modify/applyEdits, so comments, key order and untouched formatting survive;
 * TOML is spliced by byte span and never re-serialized, so a value asb cannot
 * render can never take the rest of the document with it.
 */
export function applyKeysEdits(
  content: string,
  format: KeysFormat,
  edits: readonly KeysEdit[]
): string {
  if (edits.length === 0) return content;
  const next =
    format === 'toml'
      ? applyTomlEdits(content, edits)
      : format === 'yaml'
        ? applyYamlEdits(content, edits)
        : applyJsonEdits(content, edits);
  return next.endsWith('\n') ? next : `${next}\n`;
}

function applyYamlEdits(content: string, edits: readonly KeysEdit[]): string {
  const blank = content.trim().length === 0;
  const document = blank ? new Document({}) : parseDocument(content, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error('invalid YAML');
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error('document root must be an object');
  }
  const root = (document.toJS() ?? {}) as Record<string, unknown>;
  const addresses = edits
    .map((edit) => (edit.keyPath.length === 1 ? parseKeyedArraySegment(edit.keyPath[0]) : null))
    .filter((address): address is KeyedArrayAddress => address !== null);
  for (const address of addresses) {
    const problem = keyedArrayProblem(root, address.key, address.field);
    if (problem) throw new Error(problem);
  }

  if (!blank && document.toString() !== content) {
    // ponytail: this conservative gate also rejects normalization confined to
    // a managed node. Upgrade by comparing CST ranges once such a real input
    // must be supported; whole-document refusal cannot alter user bytes.
    throw new Error('unmanaged YAML would not round-trip byte-identically');
  }

  for (const edit of edits) {
    const address = edit.keyPath.length === 1 ? parseKeyedArraySegment(edit.keyPath[0]) : null;
    if (!address) {
      if (edit.remove) document.deleteIn([...edit.keyPath]);
      else document.setIn([...edit.keyPath], edit.value);
      continue;
    }

    let sequence = document.get(address.key, true);
    if (sequence === undefined) {
      if (edit.remove) continue;
      document.set(address.key, document.createNode([]));
      sequence = document.get(address.key, true);
    }
    if (!isSeq(sequence)) throw new Error(`${address.key} is not an array`);
    const items = sequence as YAMLSeq;
    const index = items.items.findIndex(
      (item) => isMap(item) && item.get(address.field) === address.identity
    );
    if (edit.remove) {
      if (index >= 0) items.items.splice(index, 1);
      continue;
    }
    if (edit.value === null || typeof edit.value !== 'object' || Array.isArray(edit.value)) {
      throw new Error(`${address.key} member "${address.identity}" is not an object`);
    }
    const identity = (edit.value as Record<string, unknown>)[address.field];
    if (identity !== address.identity) {
      throw new Error(
        `${address.key} member identity must be ${address.field}="${address.identity}"`
      );
    }
    const node = document.createNode(edit.value);
    if (index >= 0) items.items[index] = node;
    else items.add(node);
  }
  return document.toString();
}

/**
 * `modify` edits the first occurrence of a key while `JSON.parse` (and every
 * consuming application) honors the last, so an addressed duplicate would be
 * edited in a dead occurrence and the effective value would not change. Fail
 * closed instead of publishing a write that does not take effect.
 */
function assertUniqueAddressedKeys(text: string, keyPath: readonly string[]): void {
  let node: Node | undefined = parseTree(text) ?? undefined;
  for (const segment of keyPath) {
    if (!node || node.type !== 'object') return;
    const matches = (node.children ?? []).filter(
      (property) => property.type === 'property' && property.children?.[0]?.value === segment
    );
    if (matches.length > 1) {
      throw new Error(
        `duplicate key "${segment}" in the JSON document; remove the duplicate by hand, then re-run asb sync`
      );
    }
    node = matches[0]?.children?.[1];
  }
}

function applyJsonEdits(content: string, edits: readonly KeysEdit[]): string {
  const formattingOptions = jsonFormatting(content);
  let text = content.trim().length === 0 ? '{}\n' : content;
  for (const edit of edits) {
    assertUniqueAddressedKeys(
      text,
      edit.keyPath.length === 1 && parseKeyedArraySegment(edit.keyPath[0])
        ? [parseKeyedArraySegment(edit.keyPath[0])?.key ?? edit.keyPath[0]]
        : edit.keyPath
    );
    const address = edit.keyPath.length === 1 ? parseKeyedArraySegment(edit.keyPath[0]) : null;
    if (address) {
      const parsed = parseStructured(text, 'json');
      if (parsed.root === null) throw new Error(parsed.error ?? 'document root must be an object');
      const problem = keyedArrayProblem(parsed.root, address.key, address.field);
      if (problem) throw new Error(problem);
      const members = parsed.root[address.key] as unknown[] | undefined;
      const index =
        members?.findIndex(
          (member) =>
            member !== null &&
            typeof member === 'object' &&
            !Array.isArray(member) &&
            (member as Record<string, unknown>)[address.field] === address.identity
        ) ?? -1;
      if (edit.remove) {
        if (index < 0) continue;
        text = applyEdits(
          text,
          modify(text, [address.key, index], undefined, { formattingOptions })
        );
        continue;
      }
      if (edit.value === null || typeof edit.value !== 'object' || Array.isArray(edit.value)) {
        throw new Error(`${address.key} member "${address.identity}" is not an object`);
      }
      const identity = (edit.value as Record<string, unknown>)[address.field];
      if (identity !== address.identity) {
        throw new Error(
          `${address.key} member identity must be ${address.field}="${address.identity}"`
        );
      }
      const keyPath =
        members === undefined
          ? [address.key]
          : [address.key, index === -1 ? members.length : index];
      const value = members === undefined ? [edit.value] : edit.value;
      text = applyEdits(
        text,
        modify(text, keyPath, value, {
          formattingOptions,
          ...(index === -1 ? { isArrayInsertion: true } : {}),
        })
      );
      continue;
    }
    text = applyEdits(
      text,
      modify(text, [...edit.keyPath], edit.remove ? undefined : edit.value, { formattingOptions })
    );
  }
  return text;
}

interface TomlTable {
  /** Unquoted header segments, one per key part. */
  parts: string[];
  /** Offset of the header's opening bracket. */
  start: number;
  /** Offset where the next header starts, or the end of the document. */
  end: number;
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** Quote a TOML key exactly as 0.4.35 did: bare when it can be, else escaped. */
export function tomlKey(key: string): string {
  if (TOML_BARE_KEY.test(key)) return key;
  return `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function skipTomlString(content: string, from: number, quote: string): number {
  for (let i = from; i < content.length; i++) {
    if (content[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (content[i] === quote) return i + 1;
    if (content[i] === '\n') return i;
  }
  return content.length;
}

function skipTomlMultiline(content: string, from: number, fence: string): number {
  const close = content.indexOf(fence, from);
  return close === -1 ? content.length : close + 3;
}

/** Read a `[a.b."c"]` header, returning its unquoted segments and the offset after `]`. */
function readTomlHeader(content: string, from: number): { parts: string[]; after: number } | null {
  let i = from;
  const parts: string[] = [];
  while (i < content.length) {
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] === ']') return { parts, after: i + 1 };
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      const end = skipTomlString(content, i + 1, quote);
      if (content[end - 1] !== quote) return null;
      parts.push(
        content
          .slice(i + 1, end - 1)
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      );
      i = end;
    } else {
      const start = i;
      while (i < content.length && /[A-Za-z0-9_-]/.test(content[i])) i++;
      if (i === start) return null;
      parts.push(content.slice(start, i));
    }
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] === '.') i++;
    else if (content[i] !== ']') return null;
  }
  return null;
}

/**
 * Every table header in a TOML document with the byte span it owns, tracking
 * strings, comments and bracket depth so a `[` inside a multi-line string or a
 * nested array is never mistaken for a header.
 */
function scanTomlTables(content: string): TomlTable[] {
  const tables: TomlTable[] = [];
  let lineStart = true;
  let depth = 0;
  let i = 0;
  const close = (end: number): void => {
    const last = tables[tables.length - 1];
    if (last) last.end = end;
  };
  while (i < content.length) {
    const ch = content[i];
    if (ch === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (content.startsWith('"""', i) || content.startsWith("'''", i)) {
      i = skipTomlMultiline(content, i + 3, content.slice(i, i + 3));
      lineStart = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipTomlString(content, i + 1, ch);
      lineStart = false;
      continue;
    }
    if (ch === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (lineStart && depth === 0 && ch === '[') {
      const arrayOfTables = content[i + 1] === '[';
      const header = readTomlHeader(content, i + (arrayOfTables ? 2 : 1));
      if (header) {
        close(i);
        // An array-of-tables entry is a repeated name; it is scanned so its
        // span closes the table before it, never addressed as a slice.
        tables.push({
          parts: arrayOfTables
            ? [...header.parts.slice(0, -1), `${header.parts.at(-1)}[]`]
            : header.parts,
          start: i,
          end: content.length,
        });
        i = header.after + (arrayOfTables ? 1 : 0);
        lineStart = false;
        continue;
      }
    }
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    lineStart = false;
    i++;
  }
  return tables;
}

function applyTomlEdits(content: string, edits: readonly KeysEdit[]): string {
  let text = content;
  for (const edit of edits) {
    // A missing table block means this is an addressed scalar within its
    // parent table (Codex `[features].multi_agent`). Keep every sibling byte
    // and splice only that assignment line. ponytail: inline-comment scanning
    // assumes this owned scalar is not a quoted string containing `#`; add a
    // TOML token scanner if another real scalar key needs that value shape.
    if (edit.scalar === true && edit.keyPath.length >= 2) {
      const parent = edit.keyPath.slice(0, -1);
      const leaf = edit.keyPath.at(-1) as string;
      const table = scanTomlTables(text).find(
        (candidate) =>
          candidate.parts.length === parent.length &&
          parent.every((segment, i) => candidate.parts[i] === segment)
      );
      const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const assignment = new RegExp(`^(\\s*)(?:${escaped}|"${escaped}"|'${escaped}')\\s*=.*$`, 'm');
      if (table) {
        const block = text.slice(table.start, table.end);
        const match = block.match(assignment);
        if (edit.remove) {
          if (match?.index !== undefined) {
            const end = block.indexOf('\n', match.index) + 1 || block.length;
            const remaining = block.slice(0, match.index) + block.slice(end);
            const [header, ...body] = remaining.split(/\r?\n/);
            text =
              !header.includes('#') && body.every((line) => line.trim().length === 0)
                ? text.slice(0, table.start) + text.slice(table.end)
                : text.slice(0, table.start) + remaining + text.slice(table.end);
          }
          continue;
        }
        const rendered = `${tomlKey(leaf)} = ${tomlStringify.value(edit.value as never)}`;
        if (match?.index !== undefined) {
          const lineEnd = block.indexOf('\n', match.index);
          const end = lineEnd === -1 ? block.length : lineEnd;
          const oldLine = block.slice(match.index, end);
          const commentAt = oldLine.indexOf('#');
          const suffix = commentAt >= 0 ? ` ${oldLine.slice(commentAt).trimStart()}` : '';
          text =
            text.slice(0, table.start + match.index) +
            `${match[1]}${rendered}${suffix}` +
            text.slice(table.start + end);
        } else {
          const trailing = block.match(/\n*$/)?.[0] ?? '\n';
          const body = block.slice(0, block.length - trailing.length).trimEnd();
          text = `${text.slice(0, table.start)}${body}\n${rendered}${trailing}${text.slice(table.end)}`;
        }
        continue;
      }
      if (edit.remove) continue;
      const head = text.trimEnd();
      const block = `[${parent.map(tomlKey).join('.')}]\n${tomlKey(leaf)} = ${tomlStringify.value(edit.value as never)}\n`;
      text = head.length === 0 ? block : `${head}\n\n${block}`;
      continue;
    }
    const table = scanTomlTables(text).find(
      (candidate) =>
        candidate.parts.length === edit.keyPath.length &&
        edit.keyPath.every((segment, i) => candidate.parts[i] === segment)
    );
    if (edit.remove) {
      if (table) text = text.slice(0, table.start) + text.slice(table.end);
      continue;
    }
    const block = `${(edit.text ?? '').trimEnd()}\n`;
    if (table) {
      // The span's own trailing blank lines are its separation from what
      // follows; the replacement keeps them so unrelated spacing survives.
      const trailing = text.slice(table.start, table.end).match(/\n*$/)?.[0] ?? '\n';
      text = text.slice(0, table.start) + block.trimEnd() + trailing + text.slice(table.end);
      continue;
    }
    const head = text.trimEnd();
    text = head.length === 0 ? block : `${head}\n\n${block}`;
  }
  return text;
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
  const existing = fs.statSync(resolved, { throwIfNoEntry: false });
  const mode = existing ? existing.mode & 0o777 : null;
  const temp = path.join(
    directory,
    `.${path.basename(resolved)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    if (typeof content === 'string') {
      fs.writeFileSync(temp, content, { encoding: 'utf-8', ...(mode !== null ? { mode } : {}) });
    } else {
      fs.writeFileSync(temp, content, mode !== null ? { mode } : undefined);
    }
    if (mode !== null) fs.chmodSync(temp, mode);
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
 * dangling link is left behind by removing the destination instead. Targets
 * whose emptied form must survive removal (a config asb only holds a slice of)
 * pass that form: the link keeps pointing at a file the store still owns,
 * emptied through the link rather than orphaned behind a deleted link.
 */
export function removeManagedFile(targetPath: string, emptyForm?: string): void {
  const absolute = path.resolve(targetPath);
  if (emptyForm !== undefined && fs.lstatSync(absolute).isSymbolicLink()) {
    writeFileAtomic(absolute, emptyForm);
    return;
  }
  fs.unlinkSync(absolute);
}
