import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppRow } from './apps.js';
import { ConfigError, effectiveSelection, type Homes, type ResolvedConfig } from './config.js';
import type { LibraryInventory } from './library.js';
import { renderHookGroups } from './plan.js';
import { writeFileAtomic } from './shapes.js';

export type ImportType = 'commands' | 'agents' | 'skills' | 'hooks';

export interface ImportOptions {
  types?: readonly string[];
  recursive?: boolean;
  force?: boolean;
  confirm?: (targetPath: string) => Promise<boolean>;
}

export interface ImportEntry {
  type: ImportType;
  id: string;
  sourcePath: string;
  path: string;
  outcome: 'written' | 'skipped' | 'failed';
  reason?: string;
}

export interface ImportResult {
  entries: ImportEntry[];
  exitCode: number;
}

function slugify(input: string): string {
  return (
    input
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

function importableTypes(row: AppRow): ImportType[] {
  const result: ImportType[] = [];
  if (row.commands?.importer) result.push('commands');
  if (row.agents?.importer) result.push('agents');
  if (row.skills?.importable) result.push('skills');
  if (row.hooks?.importable) result.push('hooks');
  return result;
}

function filesUnder(root: string, extensions: readonly string[], recursive: boolean): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) result.push(...filesUnder(entryPath, extensions, true));
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      result.push(entryPath);
    }
  }
  return result.sort();
}

async function mayWrite(target: string, options: ImportOptions): Promise<boolean> {
  if (!fs.existsSync(target) || options.force) return true;
  return options.confirm ? options.confirm(target) : false;
}

function overlayBundle(source: string, target: string, skipHidden: boolean): string[] {
  const copied: string[] = [];
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipHidden && entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), rel);
      else if (entry.isFile()) copied.push(rel);
    }
  };
  visit(source);
  const overwritten = copied.filter((rel) => fs.existsSync(path.join(target, rel)));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    ...(skipHidden
      ? {
          filter: (candidate: string) =>
            candidate === source || !path.basename(candidate).startsWith('.'),
        }
      : {}),
  });
  return overwritten;
}

async function importEntries(
  type: 'commands' | 'agents',
  row: AppRow,
  homes: Homes,
  sourceOverride: string | undefined,
  options: ImportOptions
): Promise<ImportEntry[]> {
  const targetRow = row[type];
  if (!targetRow?.importer) return [];
  const source = path.resolve(sourceOverride ?? targetRow.dir(homes));
  if (!fs.existsSync(source)) {
    return sourceOverride
      ? [
          {
            type,
            id: '',
            sourcePath: source,
            path: '',
            outcome: 'failed',
            reason: 'source not found',
          },
        ]
      : [];
  }
  const stat = fs.statSync(source);
  if (sourceOverride && stat.isDirectory() && !options.recursive) {
    return [
      {
        type,
        id: '',
        sourcePath: source,
        path: '',
        outcome: 'failed',
        reason: 'source is a directory; use -r/--recursive',
      },
    ];
  }
  const files = stat.isFile()
    ? [source]
    : filesUnder(source, targetRow.importer.extensions, options.recursive === true);
  const entries: ImportEntry[] = [];
  for (const filePath of files) {
    const id = slugify(path.basename(filePath, path.extname(filePath)));
    const target = path.join(homes.asbHome, type, `${id}.md`);
    try {
      if (!(await mayWrite(target, options))) {
        entries.push({ type, id, sourcePath: filePath, path: target, outcome: 'skipped' });
        continue;
      }
      writeFileAtomic(target, targetRow.importer.read(filePath));
      entries.push({ type, id, sourcePath: filePath, path: target, outcome: 'written' });
    } catch (error) {
      entries.push({
        type,
        id,
        sourcePath: filePath,
        path: target,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}

async function importSkills(
  row: AppRow,
  homes: Homes,
  sourceOverride: string | undefined,
  options: ImportOptions
): Promise<ImportEntry[]> {
  if (!row.skills?.importable) return [];
  const source = path.resolve(sourceOverride ?? row.skills.dir(homes));
  if (!fs.existsSync(source)) {
    return sourceOverride
      ? [
          {
            type: 'skills',
            id: '',
            sourcePath: source,
            path: '',
            outcome: 'failed',
            reason: 'source not found',
          },
        ]
      : [];
  }
  const roots = fs.existsSync(path.join(source, 'SKILL.md'))
    ? [source]
    : fs
        .readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(source, entry.name))
        .filter((entry) => fs.existsSync(path.join(entry, 'SKILL.md')));
  const entries: ImportEntry[] = [];
  for (const skill of roots) {
    const id = path.basename(skill);
    const target = path.join(homes.asbHome, 'skills', id);
    try {
      if (!(await mayWrite(target, options))) {
        entries.push({ type: 'skills', id, sourcePath: skill, path: target, outcome: 'skipped' });
        continue;
      }
      const overwritten = overlayBundle(skill, target, true);
      entries.push({
        type: 'skills',
        id,
        sourcePath: skill,
        path: target,
        outcome: 'written',
        ...(overwritten.length > 0 ? { reason: `overwrote ${overwritten.join(', ')}` } : {}),
      });
    } catch (error) {
      entries.push({
        type: 'skills',
        id,
        sourcePath: skill,
        path: target,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}

async function importHooks(
  row: AppRow,
  homes: Homes,
  sourceOverride: string | undefined,
  options: ImportOptions,
  context: { config: ResolvedConfig; inventory: LibraryInventory }
): Promise<ImportEntry[]> {
  if (!row.hooks?.importable) return [];
  const source = path.resolve(sourceOverride ?? row.hooks.path(homes));
  if (!fs.existsSync(source)) {
    return sourceOverride
      ? [
          {
            type: 'hooks',
            id: '',
            sourcePath: source,
            path: '',
            outcome: 'failed',
            reason: 'source not found',
          },
        ]
      : [];
  }
  const bundleFile = fs.statSync(source).isDirectory() ? path.join(source, 'hook.json') : undefined;
  const id = bundleFile
    ? path.basename(source)
    : sourceOverride
      ? slugify(path.basename(source, path.extname(source)))
      : `${row.id}-hooks`;
  const target = bundleFile
    ? path.join(homes.asbHome, 'hooks', id)
    : path.join(homes.asbHome, 'hooks', `${id}.json`);
  try {
    const document = JSON.parse(fs.readFileSync(bundleFile ?? source, 'utf-8')) as Record<
      string,
      unknown
    >;
    let content = sourceOverride ? document : { hooks: document.hooks };
    if (!content.hooks || typeof content.hooks !== 'object') throw new Error('hook map is absent');
    if (!sourceOverride) {
      // What asb already put in this config is what the library renders for
      // the ids currently selected: importing the rest is what makes this an
      // import of the user's own hooks rather than a round trip.
      const byId = new Map(
        context.inventory.components
          .filter((component) => component.type === 'hooks')
          .map((component) => [component.id, component])
      );
      const owned: Record<string, unknown[]> = {};
      for (const selected of effectiveSelection(context.config, row.id, 'hooks')) {
        const component = byId.get(selected);
        if (!component?.hooks) continue;
        const filtered = row.hooks.filter ? row.hooks.filter(component.hooks) : component.hooks;
        const bundleDir = component.files
          ? path.join(row.hooks.bundleDir(homes), selected)
          : undefined;
        for (const [event, groups] of Object.entries(renderHookGroups(filtered, bundleDir))) {
          owned[event] = [...(owned[event] ?? []), ...groups];
        }
      }
      const userHooks: Record<string, unknown[]> = {};
      for (const [event, groups] of Object.entries(content.hooks as Record<string, unknown[]>)) {
        const remaining = [...groups];
        for (const group of owned[event] ?? []) {
          const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, group));
          if (index >= 0) remaining.splice(index, 1);
        }
        if (remaining.length > 0) userHooks[event] = remaining;
      }
      content = { hooks: userHooks };
    }
    if (!(await mayWrite(target, options))) {
      return [{ type: 'hooks', id, sourcePath: source, path: target, outcome: 'skipped' }];
    }
    if (bundleFile) {
      const overwritten = overlayBundle(source, target, false);
      return [
        {
          type: 'hooks',
          id,
          sourcePath: source,
          path: target,
          outcome: 'written',
          ...(overwritten.length > 0 ? { reason: `overwrote ${overwritten.join(', ')}` } : {}),
        },
      ];
    } else {
      writeFileAtomic(target, `${JSON.stringify(content, null, 2)}\n`);
    }
    return [{ type: 'hooks', id, sourcePath: source, path: target, outcome: 'written' }];
  } catch (error) {
    return [
      {
        type: 'hooks',
        id,
        sourcePath: source,
        path: target,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

export async function importFromApp(
  row: AppRow,
  homes: Homes,
  sourcePath: string | undefined,
  options: ImportOptions,
  context: { config: ResolvedConfig; inventory: LibraryInventory }
): Promise<ImportResult> {
  const supported = importableTypes(row);
  const requested = options.types?.length ? [...new Set(options.types)] : supported;
  for (const type of requested) {
    if (!supported.includes(type as ImportType)) {
      throw new ConfigError(
        `App "${row.id}" cannot import type "${type}"; choose one of: ${supported.join(', ') || 'none'}.`
      );
    }
  }
  if (sourcePath && requested.length !== 1) {
    throw new ConfigError('An explicit import path requires exactly one --type.');
  }
  const entries: ImportEntry[] = [];
  for (const type of requested as ImportType[]) {
    if (type === 'commands' || type === 'agents') {
      entries.push(...(await importEntries(type, row, homes, sourcePath, options)));
    } else if (type === 'skills') {
      entries.push(...(await importSkills(row, homes, sourcePath, options)));
    } else {
      entries.push(...(await importHooks(row, homes, sourcePath, options, context)));
    }
  }
  return { entries, exitCode: entries.some((entry) => entry.outcome === 'failed') ? 1 : 0 };
}
