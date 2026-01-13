import type { ConfigScope } from '../config/scope.js';
import { loadLibraryStateSection, type SectionState } from '../library/state.js';
import { listExtraKeys, pickFirstPlatformString } from '../util/extras.js';
import { type CommandEntry, loadCommandLibrary } from './library.js';

export interface CommandInventoryRow {
  id: string;
  title: string | null;
  description: string | null;
  model: string | null;
  extrasKeys: string[];
  active: boolean;
  order: number | null;
  filePath: string | null;
}

export interface CommandInventory {
  entries: CommandInventoryRow[];
  state: SectionState;
}

function sortInactive(entries: CommandEntry[]): CommandEntry[] {
  return [...entries].sort((a, b) => {
    const aMeta = a.metadata as Record<string, unknown>;
    const bMeta = b.metadata as Record<string, unknown>;
    const aTitle = aMeta.title as unknown;
    const bTitle = bMeta.title as unknown;
    const aLabel = (
      typeof aTitle === 'string' && aTitle.trim().length > 0 ? aTitle : a.id
    ).toLowerCase();
    const bLabel = (
      typeof bTitle === 'string' && bTitle.trim().length > 0 ? bTitle : b.id
    ).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}

function getCommandTitle(entry: CommandEntry): string | null {
  const meta = entry.metadata as Record<string, unknown>;
  const title = meta.title as unknown;
  return typeof title === 'string' ? title : null;
}

function getCommandModel(entry: CommandEntry): string | null {
  return pickFirstPlatformString(entry.metadata.extras, ['claude-code'], 'model');
}

function buildCommandRow(entry: CommandEntry, active: boolean): CommandInventoryRow {
  return {
    id: entry.id,
    title: getCommandTitle(entry),
    description: entry.metadata.description ?? null,
    model: getCommandModel(entry),
    extrasKeys: listExtraKeys(entry.metadata.extras),
    active,
    order: null,
    filePath: entry.filePath,
  };
}

export function buildCommandInventory(scope?: ConfigScope): CommandInventory {
  const entries = loadCommandLibrary();
  const state = loadLibraryStateSection('commands', scope);

  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows: CommandInventoryRow[] = [];
  const seen = new Set<string>();

  state.active.forEach((id) => {
    const e = byId.get(id);
    if (!e) {
      rows.push({
        id,
        title: null,
        description: null,
        model: null,
        extrasKeys: [],
        active: true,
        order: null,
        filePath: null,
      });
      return;
    }
    seen.add(id);
    rows.push(buildCommandRow(e, true));
  });

  const inactive = sortInactive(entries.filter((e) => !seen.has(e.id)));
  inactive.forEach((e) => {
    rows.push(buildCommandRow(e, false));
  });

  return { entries: rows, state };
}
