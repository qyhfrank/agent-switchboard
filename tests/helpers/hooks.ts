import fs from 'node:fs';
import path from 'node:path';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import type { ScratchHomes } from './scratch.js';

/**
 * Fixtures and readers for the hooks cell: the two apps that carry hooks, the
 * library shapes a selection is seeded from, and the app-config readers every
 * hook assertion goes through.
 */

export type HookApp = 'claude-code' | 'codex';

export const APP_DIR: Record<HookApp, string> = { 'claude-code': '.claude', codex: '.codex' };

/** The bundle-directory placeholder a library command writes. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal
export const HOOK_DIR = '${HOOK_DIR}';

/** The script a runner bundle distributes. */
export const RUN_SH = '#!/bin/sh\necho bt\n';

/** claude-code merges hooks into settings.json; codex keeps its own hooks.json. */
export function configPath(homes: ScratchHomes, app: HookApp): string {
  const file = app === 'claude-code' ? 'settings.json' : 'hooks.json';
  return path.join(homes.agentsHome, APP_DIR[app], file);
}

/** The directory distributed bundles live under. */
export function managedParent(homes: ScratchHomes, app: HookApp): string {
  return path.join(homes.agentsHome, APP_DIR[app], 'hooks', 'managed');
}

export function managedDir(homes: ScratchHomes, app: HookApp, id: string): string {
  return path.join(managedParent(homes, app), id);
}

/** Seed a definition hook at <asbHome>/hooks/<id>.json. */
export function seedHook(homes: ScratchHomes, id: string, hooks: unknown): string {
  const dir = path.join(homes.asbHome, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ name: id, hooks }, null, 2), 'utf-8');
  return filePath;
}

/** Seed a bundle hook at <asbHome>/hooks/<id>/hook.json plus its payload files. */
export function seedHookBundle(
  homes: ScratchHomes,
  id: string,
  hooks: unknown,
  files: Record<string, string> = {}
): string {
  const dir = path.join(homes.asbHome, 'hooks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ name: id, hooks }, null, 2));
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(dir, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return dir;
}

/** A bundle hook whose only command runs the script it distributes. */
export function seedRunner(homes: ScratchHomes, id: string, script = RUN_SH, args = ''): string {
  return seedHookBundle(
    homes,
    id,
    { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh${args}` }] }] },
    { 'run.sh': script }
  );
}

export function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/** The groups an app config holds for one event, empty when it holds none. */
export function eventGroups(filePath: string, event: string): Array<Record<string, unknown>> {
  const hooks = readJson(filePath).hooks as Record<string, unknown[]> | undefined;
  return (hooks?.[event] ?? []) as Array<Record<string, unknown>>;
}

export function commandsOf(groups: Array<Record<string, unknown>>): string[] {
  return groups.flatMap((group) =>
    (Array.isArray(group.hooks) ? group.hooks : [])
      .map((handler) => (handler as Record<string, unknown>).command)
      .filter((command): command is string => typeof command === 'string')
  );
}

/** A user config enabling `apps` and selecting `hooks`. */
export function configFor(apps: readonly string[], hooks: readonly string[]): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${list(apps)}]\n\n[hooks]\nenabled = [${list(hooks)}]\n`;
}

export function hooksRows(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'hooks');
}
