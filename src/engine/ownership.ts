import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENTS_SKILLS_UNION } from './apps.js';
import { type ComponentType, ConfigError } from './config.js';
import { sanitizeMcpName } from './dialects.js';
import type { Component } from './library.js';
import { type Action, type PlanInput, renderHookGroups } from './plan.js';
import {
  applyKeysEdits,
  bundleFingerprint,
  hashContent,
  type KeysEdit,
  keyedArraySegment,
  listTargetFiles,
  mergeProjectRegion,
  parseStructured,
  projectRegion,
  resolveWritePath,
  sliceHash,
  type TargetFile,
  targetModeMatchesSourceExecutableBits,
  valueAtKeyPath,
  writeFileAtomic,
} from './shapes.js';
import type { SourceCatalog } from './sources.js';

const refSchema = z.object({ id: z.string(), source: z.string(), path: z.string() });
const sliceSchema = z.object({
  app: z.string(),
  type: z.enum(['rules', 'skills', 'commands', 'agents', 'hooks', 'mcp']),
  id: z.string().nullable(),
  path: z.string(),
  root: z.string(),
  members: z.array(z.string()).optional(),
  refs: z.array(refSchema),
  shape: z.enum(['file', 'bundle', 'region', 'key', 'hook']),
  hash: z.string(),
  format: z.enum(['json', 'toml', 'yaml']).optional(),
  keyPath: z.array(z.string()).optional(),
  event: z.string().optional(),
  hookPeers: z.array(z.string()).optional(),
  cleared: z.boolean().optional(),
  files: z.array(z.object({ rel: z.string(), hash: z.string(), mode: z.number() })).optional(),
});
const stateSchema = z.object({ version: z.literal(1), slices: z.array(sliceSchema) }).strict();
export type OwnedSlice = z.infer<typeof sliceSchema>;

/** A physical slice can outlive its source, profile, or application selection. */
function slot(slice: OwnedSlice): string {
  return JSON.stringify([
    slice.path,
    slice.shape,
    slice.keyPath,
    slice.event,
    slice.shape === 'hook' ? slice.hash : undefined,
  ]);
}

function bundleHash(files: readonly TargetFile[]): string {
  return sliceHash(
    [...files]
      .map(({ rel, hash, mode }) => ({ rel, hash, mode: (mode & 0o111) === 0 ? 0 : mode }))
      .sort((a, b) => a.rel.localeCompare(b.rel))
  );
}

function reference(component: Component) {
  return { id: component.id, source: component.source, path: component.path };
}

/** Desired slices are hashes only; structured values and bundle bytes never enter state. */
export function desiredSlices(input: PlanInput, actions: readonly Action[]): OwnedSlice[] {
  const { config, inventory, table, capture } = input;
  const result: OwnedSlice[] = [];
  const components = (app: string, type: ComponentType) =>
    inventory.components.filter(
      (component) => component.type === type && input.selection(app, type).includes(component.id)
    );
  const add = (slice: OwnedSlice) => {
    result.push(slice);
  };
  const addBundle = (
    app: string,
    component: Component,
    dir: string,
    root: string,
    members?: string[]
  ) => {
    if (!component.files) return;
    add({
      app,
      type: component.type,
      id: component.id,
      path: path.join(dir, component.id),
      root,
      refs: [reference(component)],
      shape: 'bundle',
      members,
      files: component.files.map((file) => ({
        rel: file.rel,
        hash: hashContent(file.bytes),
        mode: file.mode,
      })),
      hash: bundleHash(
        component.files.map((file) => ({
          rel: file.rel,
          hash: hashContent(file.bytes),
          mode: file.mode,
        }))
      ),
    });
  };
  const active = config.apps.enabled.filter(
    (app) => capture.installed[app] || config.apps.assumeInstalled.includes(app)
  );
  for (const app of active) {
    const row = table.find((candidate) => candidate.id === app);
    if (!row) continue;
    const rules = components(app, 'rules');
    if (row.rules && rules.length) {
      const target = capture.rulePaths[app] ?? row.rules.path(config.homes);
      const action = actions.find(
        (candidate) =>
          candidate.path === target &&
          candidate.type === 'rules' &&
          (candidate.op === 'write' || candidate.outcome === 'unchanged')
      );
      const content = action?.content ?? capture.targets[target]?.content;
      if (action && content != null) {
        const region = projectRegion(content);
        add({
          app,
          type: 'rules',
          id: null,
          path: target,
          root: row.rules.root(config.homes, target),
          refs: rules.map(reference),
          members: action.members,
          shape: region === null ? 'file' : 'region',
          hash: hashContent(region ?? content),
        });
      }
    }
    for (const type of ['commands', 'agents'] as const) {
      const target = row[type];
      if (!target) continue;
      for (const component of components(app, type)) {
        let content: string | null;
        try {
          content = target.render(component);
        } catch {
          continue;
        }
        if (content === null) continue;
        const filename = target.filename(component.id);
        add({
          app,
          type,
          id: component.id,
          path: path.join(target.dir(config.homes), filename),
          root: target.root(config.homes),
          refs: [reference(component)],
          shape: 'file',
          hash: hashContent(content),
        });
        if (target.config) {
          const key = target.config.component(component, filename);
          add({
            app,
            type,
            id: component.id,
            path: target.config.path(config.homes),
            root: target.config.root(config.homes),
            refs: [reference(component)],
            shape: 'key',
            hash: sliceHash(key.value),
            keyPath: key.keyPath,
            format: target.config.format,
          });
        }
      }
    }
    if (
      row.skills &&
      !(config.distribution.useAgentsDir && AGENTS_SKILLS_UNION.members.includes(app))
    ) {
      for (const component of components(app, 'skills'))
        addBundle(app, component, row.skills.dir(config.homes), row.skills.root(config.homes));
    }
    if (row.hooks) {
      const target = row.hooks;
      for (const component of components(app, 'hooks')) {
        if (!component.hooks) continue;
        const hooks = target.filter ? target.filter(component.hooks) : component.hooks;
        if (!Object.keys(hooks).length) continue;
        const dir = target.bundleDir(config.homes);
        const groups = renderHookGroups(
          hooks,
          component.files ? path.join(dir, component.id) : undefined
        );
        for (const [event, entries] of Object.entries(groups)) {
          for (const group of entries)
            add({
              app,
              type: 'hooks',
              id: component.id,
              path: target.path(config.homes),
              root: target.root(config.homes),
              refs: [reference(component)],
              shape: 'hook',
              hash: sliceHash(group),
              event,
              format: 'json',
            });
        }
        addBundle(app, component, dir, target.root(config.homes));
      }
    }
    if (row.mcp) {
      const target = row.mcp;
      for (const component of components(app, 'mcp')) {
        if (!component.server) continue;
        const value = target.dialect(component.server);
        if (value === null) continue;
        const id = target.sanitize ? sanitizeMcpName(component.id) : component.id;
        const field = target.keyField ?? 'name';
        const array = target.structure === 'keyed-array';
        add({
          app,
          type: 'mcp',
          id: component.id,
          path: capture.mcp[app]?.path ?? target.path(config.homes),
          root: target.root(config.homes),
          refs: [reference(component)],
          shape: 'key',
          hash: sliceHash(array ? { ...value, [field]: id } : value),
          format: target.format,
          keyPath: array ? [keyedArraySegment(target.rootKey, field, id)] : [target.rootKey, id],
        });
      }
    }
  }
  const members = active.filter((app) => AGENTS_SKILLS_UNION.members.includes(app));
  if (config.distribution.useAgentsDir && members.length) {
    for (const app of members)
      for (const component of components(app, 'skills')) {
        addBundle(
          'agents',
          component,
          AGENTS_SKILLS_UNION.dir(config.homes, config.project ?? undefined),
          AGENTS_SKILLS_UNION.root(config.homes, config.project ?? undefined),
          members
        );
      }
  }
  return [...new Map(result.map((slice) => [slot(slice), slice])).values()];
}

/** Read failures never turn into an empty ownership set. */
export class DistributionOwnership {
  readonly file: string;
  slices: OwnedSlice[];
  readonly retiring = new Set<string>();

  owns(targetPath: string, keyPath?: readonly string[]): boolean {
    return this.slices.some(
      (slice) =>
        !slice.cleared &&
        slice.path === targetPath &&
        (keyPath
          ? slice.shape === 'key' && JSON.stringify(slice.keyPath) === JSON.stringify(keyPath)
          : slice.shape === 'file' || slice.shape === 'bundle' || slice.shape === 'region')
    );
  }

  constructor(input: Pick<PlanInput, 'config' | 'project'>) {
    const { config, project } = input;
    const scope = hashContent(
      JSON.stringify([config.homes.asbHome, config.homes.agentsHome, project?.root ?? null])
    );
    this.file = path.join(config.homes.stateHome, 'distribution', `${scope}.json`);
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.slices = [];
        return;
      }
      throw new ConfigError(`Cannot read distribution ownership at ${this.file}`);
    }
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    const state = stateSchema.safeParse(parsed);
    if (!state.success)
      throw new ConfigError(
        `Invalid distribution ownership at ${this.file}; restore the file before syncing`
      );
    this.slices = state.data.slices;
    for (const slice of this.slices) {
      const relative = path.relative(slice.root, slice.path);
      if (
        !path.isAbsolute(slice.root) ||
        !path.isAbsolute(slice.path) ||
        relative === '' ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        (slice.shape === 'key' && (!slice.format || !slice.keyPath?.length)) ||
        (slice.shape === 'hook' && !slice.event)
      ) {
        throw new ConfigError(`Unsafe distribution ownership at ${this.file}`);
      }
    }
  }

  /** Persist intent before writes, so a crash never loses the address of newly written output. */
  save(slices: OwnedSlice[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, slices }, null, 2)}\n`);
    fs.chmodSync(this.file, 0o600);
    this.slices = slices;
  }
}

/** An unavailable provider or a parse failure is not evidence of deletion. */
export function unavailable(slice: OwnedSlice, input: PlanInput, catalog: SourceCatalog): boolean {
  const members =
    slice.app === 'agents' ? AGENTS_SKILLS_UNION.members : (slice.members ?? [slice.app]);
  if (
    members.some(
      (app) =>
        input.config.apps.enabled.includes(app) &&
        !input.capture.installed[app] &&
        !input.config.apps.assumeInstalled.includes(app) &&
        slice.refs.some((ref) => input.selection(app, slice.type).includes(ref.id))
    )
  )
    return true;
  return slice.refs.some((ref) => {
    if (
      input.inventory.components.some(
        (component) => component.type === slice.type && component.id === ref.id
      )
    )
      return false;
    if (
      input.inventory.failed.some(
        (failure) => failure.type === slice.type && failure.source === ref.source
      )
    )
      return true;
    return (
      catalog.absent.some((plugin) => plugin.id === ref.source) ||
      catalog.unresolved.some(
        (source) => source.namespace === ref.source || ref.source.endsWith(`@${source.namespace}`)
      )
    );
  });
}

/** Filter only previously distributed missing ids, preserving unknown-id diagnostics. */
export function ownershipSelection(
  input: PlanInput,
  state: DistributionOwnership,
  catalog: SourceCatalog
): PlanInput['selection'] {
  return (app, type) =>
    input.selection(app, type).filter((id) => {
      if (
        input.inventory.components.some(
          (component) => component.type === type && component.id === id
        )
      )
        return true;
      const evidence = state.slices.find(
        (slice) => slice.type === type && slice.refs.some((ref) => ref.id === id)
      );
      return !evidence || unavailable(evidence, input, catalog);
    });
}

function liveHash(slice: OwnedSlice, content?: string): string | null {
  if (slice.shape === 'bundle') {
    const files = listTargetFiles(slice.path);
    if (files === null) {
      if (!fs.existsSync(slice.path)) return null;
      throw new Error('cannot inspect owned bundle');
    }
    return bundleHash(files);
  }
  const text = content ?? fs.readFileSync(slice.path, 'utf8');
  if (slice.shape === 'file') return hashContent(text);
  if (slice.shape === 'region') {
    const region = projectRegion(text);
    return region === null ? null : hashContent(region);
  }
  const parsed = parseStructured(text, slice.format ?? 'json');
  if (parsed.error || !parsed.root) throw new Error('cannot parse owned host');
  if (slice.shape === 'key') {
    const value = valueAtKeyPath(parsed.root, slice.keyPath ?? []);
    return value === undefined ? null : sliceHash(value);
  }
  const groups = valueAtKeyPath(parsed.root, ['hooks', slice.event ?? '']);
  return Array.isArray(groups) && groups.some((group) => sliceHash(group) === slice.hash)
    ? slice.hash
    : null;
}

function matches(slice: OwnedSlice, content?: string): boolean {
  try {
    return liveHash(slice, content) === slice.hash;
  } catch {
    return false;
  }
}

/** Locate an edited managed group only while the surrounding foreign slots still match. */
function hookHashes(slice: OwnedSlice, state: DistributionOwnership): string[] {
  if (slice.cleared) return [];
  try {
    const parsed = parseStructured(fs.readFileSync(slice.path, 'utf8'), 'json');
    const groups = valueAtKeyPath(parsed.root, ['hooks', slice.event ?? '']);
    if (!Array.isArray(groups)) return [];
    const hashes = groups.map(sliceHash);
    if (hashes.includes(slice.hash)) return [slice.hash];
    const peers = slice.hookPeers;
    if (!peers || peers.length !== hashes.length) return [];
    const owned = new Set(
      state.slices
        .filter(
          (candidate) =>
            candidate.path === slice.path &&
            candidate.shape === 'hook' &&
            candidate.event === slice.event
        )
        .map((candidate) => candidate.hash)
    );
    if (!peers.every((hash, index) => hashes[index] === hash || owned.has(hash))) return [];
    return peers.flatMap((hash, index) => (hash === slice.hash ? [hashes[index]] : []));
  } catch {
    return [];
  }
}

function removable(slice: OwnedSlice, content?: string): boolean {
  if (slice.shape !== 'bundle' || !slice.files) return matches(slice, content);
  const files = listTargetFiles(slice.path);
  if (files === null) return false;
  return files.every((file) =>
    slice.files?.some(
      (previous) =>
        previous.rel === file.rel &&
        previous.hash === file.hash &&
        targetModeMatchesSourceExecutableBits(previous.mode, file.mode)
    )
  );
}

/** One retirement rule for files, bundles, regions, keys and individual hook groups. */
export function reconcileOwnership(
  input: PlanInput,
  state: DistributionOwnership,
  catalog: SourceCatalog,
  actions: Action[],
  desired: OwnedSlice[]
): Action[] {
  const wanted = new Set(desired.map(slot));
  const retired = new Map<string, OwnedSlice>();
  for (const slice of state.slices) {
    if (slice.cleared) continue;
    const editedHook =
      slice.shape === 'hook' && !matches(slice) && hookHashes(slice, state).length > 0;
    if ((wanted.has(slot(slice)) && !editedHook) || unavailable(slice, input, catalog)) continue;
    if (!retired.has(slot(slice)) || removable(slice)) retired.set(slot(slice), slice);
  }
  const protectedSlices = state.slices.filter((slice) => unavailable(slice, input, catalog));
  const result = actions.map(
    (action): Action =>
      action.op !== 'none' &&
      protectedSlices.some(
        (slice) =>
          slice.type === action.type &&
          slice.path === action.path &&
          ((slice.shape !== 'key' && slice.shape !== 'hook') ||
            (matches(slice) && (action.content === undefined || !matches(slice, action.content))))
      )
        ? {
            ...action,
            op: 'none',
            outcome: 'skipped',
            detail: 'source-unavailable',
            reason: 'recorded output is preserved until its source can be read',
            keyEdits: undefined,
          }
        : action
  );
  for (const slice of retired.values()) {
    if (
      slice.app === 'codex' &&
      slice.type === 'hooks' &&
      input.config.apps.enabled.includes('codex') &&
      input
        .selection('codex', 'hooks')
        .some(
          (id) =>
            !input.inventory.components.some(
              (component) => component.type === 'hooks' && component.id === id
            )
        )
    )
      continue;
    // A current writer of this physical slice supersedes its older generation.
    const existing = result.find(
      (action) => action.path === slice.path && action.type === slice.type && action.op !== 'none'
    );
    if (
      result.some(
        (action) =>
          action.path === slice.path && ['failed', 'blocked', 'conflict'].includes(action.outcome)
      )
    )
      continue;
    if (
      existing?.op === 'write' &&
      (slice.shape === 'bundle' || slice.shape === 'file' || slice.shape === 'region')
    )
      continue;
    if (result.some((action) => action.path === slice.path && action.outcome === 'skipped'))
      continue;
    if (
      existing?.keyEdits?.edits.some(
        (edit) =>
          slice.shape === 'key' && JSON.stringify(edit.keyPath) === JSON.stringify(slice.keyPath)
      )
    )
      continue;
    const source = slice.refs.length === 1 ? slice.refs[0].source.split('@').at(-1) : undefined;
    const base = {
      app: slice.app,
      type: slice.type,
      id: slice.id,
      path: slice.path,
      members: slice.members,
      source,
    };
    const replacements = desired.filter(
      (candidate) =>
        candidate.type === slice.type &&
        candidate.id === slice.id &&
        candidate.shape === slice.shape &&
        candidate.path !== slice.path &&
        (candidate.app === slice.app ||
          (candidate.app === 'agents' && AGENTS_SKILLS_UNION.members.includes(slice.app)) ||
          (slice.app === 'agents' && AGENTS_SKILLS_UNION.members.includes(candidate.app)))
    );
    if (replacements.some((replacement) => !matches(replacement))) {
      const waiting =
        existing ??
        result.find(
          (action) =>
            action.path === slice.path && action.id === slice.id && action.outcome === 'left-behind'
        );
      if (waiting) {
        waiting.op = 'none';
        waiting.outcome = 'skipped';
        waiting.detail = 'replacement-pending';
        waiting.reason = 'kept until the replacement distribution is present';
      } else
        result.push({
          ...base,
          op: 'none',
          outcome: 'skipped',
          detail: 'replacement-pending',
          reason: 'kept until the replacement distribution is present',
        });
      continue;
    }
    let content: string | undefined;
    try {
      if (!fs.existsSync(slice.path)) continue;
      if (slice.shape !== 'bundle') content = fs.readFileSync(slice.path, 'utf8');
      // Ownership names the managed destination. Content drift does not release
      // it; the live hash below only guards changes between planning and apply.
      if (slice.shape !== 'bundle' && slice.shape !== 'hook' && liveHash(slice, content) === null)
        continue;
      if (existing?.op === 'remove') {
        state.retiring.add(slot(slice));
        continue;
      }
      if (slice.shape === 'bundle') {
        const files = listTargetFiles(slice.path);
        const fingerprint = bundleFingerprint(slice.path);
        if (!files || !fingerprint) throw new Error('cannot inspect owned bundle');
        state.retiring.add(slot(slice));
        result.push({
          ...base,
          op: 'remove',
          outcome: 'removed',
          detail: 'retired-distribution',
          root: slice.root,
          expectedHash: fingerprint,
          bundle: { files: [], stale: files.map((file) => file.rel) },
        });
        continue;
      }
      if (slice.shape === 'file' || slice.shape === 'region') {
        state.retiring.add(slot(slice));
        const next = slice.shape === 'region' ? mergeProjectRegion(content ?? '', '') : '';
        const keepHost =
          slice.shape === 'region' &&
          slice.path.endsWith(`${path.sep}AGENTS.md`) &&
          (() => {
            try {
              return (
                fs.readlinkSync(path.join(path.dirname(slice.path), 'CLAUDE.md')) === 'AGENTS.md'
              );
            } catch {
              return false;
            }
          })();
        result.push({
          ...base,
          op: next || keepHost ? 'write' : 'remove',
          outcome: 'removed',
          detail: 'retired-distribution',
          root: slice.root,
          expectedHash: hashContent(content ?? ''),
          content: next,
          expectedPaths: [{ path: slice.path, resolvedPath: resolveWritePath(slice.path) }],
        });
        continue;
      }
      const format = slice.format ?? 'json';
      const host = existing?.content ?? content ?? '';
      const edits: KeysEdit[] = [];
      if (slice.shape === 'key') {
        if (format === 'toml') {
          const parsed = parseStructured(host, format);
          const key = slice.keyPath ?? [];
          if (
            !parsed.tables.some((parts) => JSON.stringify(parts) === JSON.stringify(key)) ||
            parsed.tables.some(
              (parts) =>
                parts.length > key.length && key.every((part, index) => parts[index] === part)
            )
          ) {
            result.push({
              ...base,
              op: 'none',
              outcome: 'left-behind',
              detail: 'modified',
              reason: 'recorded TOML table is no longer independently addressable; preserved',
            });
            continue;
          }
        }
        edits.push({ keyPath: slice.keyPath ?? [], remove: true });
      } else {
        const parsed = parseStructured(host, format);
        if (!parsed.root || parsed.error) throw new Error('cannot parse owned hook host');
        const hooks = valueAtKeyPath(parsed.root, ['hooks']) as
          | Record<string, unknown[]>
          | undefined;
        const groups = hooks?.[slice.event ?? ''];
        if (!Array.isArray(groups)) continue;
        const ownedHashes = new Set(hookHashes(slice, state));
        const remaining = groups.filter((group) => !ownedHashes.has(sliceHash(group)));
        if (remaining.length === groups.length) continue;
        const next = { ...hooks };
        if (remaining.length) next[slice.event ?? ''] = remaining;
        else delete next[slice.event ?? ''];
        edits.push(
          Object.keys(next).length
            ? { keyPath: ['hooks'], value: next }
            : { keyPath: ['hooks'], remove: true }
        );
      }
      // Merge against the planned host while keeping one compare-and-write boundary.
      const nextContent = applyKeysEdits(host, format, edits);
      state.retiring.add(slot(slice));
      if (existing?.keyEdits) {
        const replacing = new Set(edits.map((edit) => JSON.stringify(edit.keyPath)));
        existing.keyEdits.edits = [
          ...existing.keyEdits.edits.filter((edit) => !replacing.has(JSON.stringify(edit.keyPath))),
          ...edits,
        ];
        existing.content = nextContent;
        existing.reason = [existing.reason, `retired ${slice.id ?? slice.type}`]
          .filter(Boolean)
          .join('; ');
      } else {
        result.push({
          ...base,
          op: 'write',
          outcome: 'removed',
          detail: 'retired-distribution',
          root: slice.root,
          expectedHash: hashContent(content ?? ''),
          content: nextContent,
          keyEdits: { format, edits, baseContent: content ?? '' },
        });
      }
    } catch {
      result.push({
        ...base,
        op: 'none',
        outcome: 'failed',
        detail: 'ownership-read',
        reason: 'cannot inspect or edit recorded distribution; preserved for retry',
      });
    }
  }
  for (const action of result) {
    if (action.type !== 'hooks' || action.op !== 'write' || action.content === undefined) continue;
    const target = input.table.find((row) => row.id === action.app)?.hooks;
    if (!target?.deleteWhenEmpty || action.path !== target.path(input.config.homes)) continue;
    const parsed = parseStructured(action.content, 'json');
    if (parsed.root && Object.keys(parsed.root).length === 0) {
      action.op = 'remove';
      action.outcome = 'removed';
      action.keyEdits = undefined;
    }
  }
  return result.filter(
    (action) =>
      action.outcome !== 'left-behind' ||
      !result.some(
        (other) =>
          other.path === action.path &&
          other.id === action.id &&
          other.op !== 'none' &&
          other.outcome === 'removed'
      )
  );
}

/** Record filtered actions and forget absent slices once selection no longer names them. */
export function applyWithOwnership(
  state: DistributionOwnership,
  desired: OwnedSlice[],
  actions: readonly Action[],
  apply: () => void,
  keepMissing: (slice: OwnedSlice) => boolean
): void {
  const eligible = desired.filter((slice) =>
    actions.some(
      (action) =>
        action.path === slice.path &&
        (action.type === slice.type || (action.type === null && action.keyEdits)) &&
        ((action.op === 'write' &&
          (slice.shape === 'bundle'
            ? action.bundle !== undefined
            : matches(slice, action.content))) ||
          (action.outcome === 'unchanged' && matches(slice)))
    )
  );
  // An aggregate can lose one source while still carrying others. Retain the
  // retired id until selection stops naming it, without retaining its payload.
  for (const slice of eligible) {
    if (slice.shape === 'hook') {
      const action = actions.find(
        (candidate) => candidate.path === slice.path && candidate.op === 'write'
      );
      const content = action?.content ?? fs.readFileSync(slice.path, 'utf8');
      const root = parseStructured(content, 'json').root;
      const groups = valueAtKeyPath(root, ['hooks', slice.event ?? '']);
      if (Array.isArray(groups)) slice.hookPeers = groups.map(sliceHash);
    }
    const refs = new Map(slice.refs.map((ref) => [ref.id, ref]));
    for (const previous of state.slices.filter((candidate) => slot(candidate) === slot(slice))) {
      for (const ref of previous.refs) {
        if (!refs.has(ref.id) && keepMissing({ ...previous, refs: [ref] })) refs.set(ref.id, ref);
      }
    }
    slice.refs = [...refs.values()];
  }
  const before = state.slices;
  const combined = [
    ...new Map(
      [...before, ...eligible].map((slice) => [`${slot(slice)}:${slice.hash}`, slice])
    ).values(),
  ];
  if (JSON.stringify(combined) !== JSON.stringify(before)) state.save(combined);
  apply();
  const proven = new Set(eligible.filter((slice) => matches(slice)).map(slot));
  const retained = combined.filter((slice) => {
    if (proven.has(slot(slice)))
      return eligible.some(
        (candidate) => slot(candidate) === slot(slice) && candidate.hash === slice.hash
      );
    try {
      const current = liveHash(slice);
      if (
        current === null &&
        keepMissing(slice) &&
        (slice.shape !== 'hook' ||
          (state.retiring.has(slot(slice)) &&
            actions.some((action) => action.path === slice.path && action.op !== 'none')))
      ) {
        slice.cleared = true;
      }
      return current !== null || keepMissing(slice);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && keepMissing(slice))
        slice.cleared = true;
      return (error as NodeJS.ErrnoException).code !== 'ENOENT' || keepMissing(slice);
    }
  });
  if (JSON.stringify(retained) !== JSON.stringify(state.slices)) state.save(retained);
}
