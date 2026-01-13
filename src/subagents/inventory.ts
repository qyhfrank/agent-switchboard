import type { ConfigScope } from '../config/scope.js';
import { loadLibraryStateSection, type SectionState } from '../library/state.js';
import { listExtraKeys, pickFirstPlatformArray, pickFirstPlatformString } from '../util/extras.js';
import { loadSubagentLibrary, type SubagentEntry } from './library.js';

export interface SubagentInventoryRow {
  id: string;
  title: string | null;
  description: string | null;
  model: string | null;
  tools: string[];
  extrasKeys: string[];
  active: boolean;
  order: number | null;
  filePath: string | null;
}

export interface SubagentInventory {
  entries: SubagentInventoryRow[];
  state: SectionState;
}

function sortInactive(entries: SubagentEntry[]): SubagentEntry[] {
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

function getSubagentTitle(entry: SubagentEntry): string | null {
  const meta = entry.metadata as Record<string, unknown>;
  const title = meta.title as unknown;
  return typeof title === 'string' ? title : null;
}

function getSubagentModel(entry: SubagentEntry): string | null {
  return pickFirstPlatformString(entry.metadata.extras, ['claude-code', 'opencode'], 'model');
}

function getSubagentTools(entry: SubagentEntry): string[] {
  return pickFirstPlatformArray(entry.metadata.extras, ['claude-code', 'opencode'], 'tools');
}

function buildSubagentRow(
  entry: SubagentEntry,
  active: boolean,
  order: number | null
): SubagentInventoryRow {
  return {
    id: entry.id,
    title: getSubagentTitle(entry),
    description: entry.metadata.description ?? null,
    model: getSubagentModel(entry),
    tools: getSubagentTools(entry),
    extrasKeys: listExtraKeys(entry.metadata.extras),
    active,
    order,
    filePath: entry.filePath,
  };
}

export function buildSubagentInventory(scope?: ConfigScope): SubagentInventory {
  const entries = loadSubagentLibrary();
  const state = loadLibraryStateSection('subagents', scope);

  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows: SubagentInventoryRow[] = [];
  const seen = new Set<string>();

  state.active.forEach((id, index) => {
    const e = byId.get(id);
    if (!e) {
      rows.push({
        id,
        title: null,
        description: null,
        model: null,
        tools: [],
        extrasKeys: [],
        active: true,
        order: index + 1,
        filePath: null,
      });
      return;
    }
    seen.add(id);
    rows.push(buildSubagentRow(e, true, index + 1));
  });

  const inactive = sortInactive(entries.filter((e) => !seen.has(e.id)));
  inactive.forEach((e) => {
    rows.push(buildSubagentRow(e, false, null));
  });

  return { entries: rows, state };
}
