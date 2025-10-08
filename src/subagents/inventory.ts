import { loadLibraryStateSection, type SectionState } from '../library/state.js';
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

export function buildSubagentInventory(): SubagentInventory {
  const entries = loadSubagentLibrary();
  const state = loadLibraryStateSection('subagents');

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
        const oc = (extras?.opencode as Record<string, unknown>) ?? undefined;
        const m1 = cc?.model as unknown as string | undefined;
        const m2 = oc?.model as unknown as string | undefined;
        return typeof m1 === 'string' && m1.trim().length > 0
          ? m1
          : typeof m2 === 'string' && m2.trim().length > 0
            ? m2
            : null;
      })(),
      tools: (() => {
        const extras = e.metadata.extras as Record<string, unknown> | undefined;
        const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
        const oc = (extras?.opencode as Record<string, unknown>) ?? undefined;
        const ccTools = cc?.tools;
        const t1 = Array.isArray(ccTools) ? (ccTools as string[]) : undefined;
        const ocTools = oc?.tools;
        const t2 = Array.isArray(ocTools) ? (ocTools as string[]) : undefined;
        return t1 ?? t2 ?? [];
      })(),
      extrasKeys: e.metadata.extras ? Object.keys(e.metadata.extras) : [],
      active: true,
      order: index + 1,
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
        const oc = (extras?.opencode as Record<string, unknown>) ?? undefined;
        const m1 = cc?.model as unknown as string | undefined;
        const m2 = oc?.model as unknown as string | undefined;
        return typeof m1 === 'string' && m1.trim().length > 0
          ? m1
          : typeof m2 === 'string' && m2.trim().length > 0
            ? m2
            : null;
      })(),
      tools: (() => {
        const extras = e.metadata.extras as Record<string, unknown> | undefined;
        const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
        const oc = (extras?.opencode as Record<string, unknown>) ?? undefined;
        const ccTools = cc?.tools;
        const t1 = Array.isArray(ccTools) ? (ccTools as string[]) : undefined;
        const ocTools = oc?.tools;
        const t2 = Array.isArray(ocTools) ? (ocTools as string[]) : undefined;
        return t1 ?? t2 ?? [];
      })(),
      extrasKeys: e.metadata.extras ? Object.keys(e.metadata.extras) : [],
      active: false,
      order: null,
      filePath: e.filePath,
    });
  });

  return { entries: rows, state };
}
