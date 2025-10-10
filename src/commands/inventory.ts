import type { ConfigScope } from '../config/scope.js';
import { loadLibraryStateSection, type SectionState } from '../library/state.js';
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
    rows.push({
      id,
      title: (() => {
        const t = (e.metadata as Record<string, unknown>).title as unknown;
        return typeof t === 'string' ? t : null;
      })(),
      description: e.metadata.description ?? null,
      model: (() => {
        const extras = e.metadata.extras as Record<string, unknown> | undefined;
        const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
        const m = cc?.model as unknown as string | undefined;
        return typeof m === 'string' && m.trim().length > 0 ? m : null;
      })(),
      extrasKeys: e.metadata.extras ? Object.keys(e.metadata.extras) : [],
      active: true,
      order: null,
      filePath: e.filePath,
    });
  });

  const inactive = sortInactive(entries.filter((e) => !seen.has(e.id)));
  inactive.forEach((e) => {
    rows.push({
      id: e.id,
      title: (() => {
        const t = (e.metadata as Record<string, unknown>).title as unknown;
        return typeof t === 'string' ? t : null;
      })(),
      description: e.metadata.description ?? null,
      model: (() => {
        const extras = e.metadata.extras as Record<string, unknown> | undefined;
        const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
        const m = cc?.model as unknown as string | undefined;
        return typeof m === 'string' && m.trim().length > 0 ? m : null;
      })(),
      extrasKeys: e.metadata.extras ? Object.keys(e.metadata.extras) : [],
      active: false,
      order: null,
      filePath: e.filePath,
    });
  });

  return { entries: rows, state };
}
