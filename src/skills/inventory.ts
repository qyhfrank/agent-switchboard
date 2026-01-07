import type { ConfigScope } from '../config/scope.js';
import { loadLibraryStateSection, type SectionState } from '../library/state.js';
import { loadSkillLibrary, type SkillEntry } from './library.js';

export interface SkillInventoryRow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  order: number | null;
  dirPath: string | null;
}

export interface SkillInventory {
  entries: SkillInventoryRow[];
  state: SectionState;
}

function sortInactive(entries: SkillEntry[]): SkillEntry[] {
  return [...entries].sort((a, b) => {
    const aLabel = a.metadata.name.toLowerCase();
    const bLabel = b.metadata.name.toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}

export function buildSkillInventory(scope?: ConfigScope): SkillInventory {
  const entries = loadSkillLibrary();
  const state = loadLibraryStateSection('skills', scope);

  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows: SkillInventoryRow[] = [];
  const seen = new Set<string>();

  // First, add active skills in order
  state.active.forEach((id, index) => {
    const e = byId.get(id);
    if (!e) {
      // Missing skill
      rows.push({
        id,
        name: id,
        description: '(not found)',
        active: true,
        order: index + 1,
        dirPath: null,
      });
      return;
    }
    seen.add(id);
    rows.push({
      id,
      name: e.metadata.name,
      description: e.metadata.description,
      active: true,
      order: index + 1,
      dirPath: e.dirPath,
    });
  });

  // Then add inactive skills sorted by name
  const inactive = sortInactive(entries.filter((e) => !seen.has(e.id)));
  for (const e of inactive) {
    rows.push({
      id: e.id,
      name: e.metadata.name,
      description: e.metadata.description,
      active: false,
      order: null,
      dirPath: e.dirPath,
    });
  }

  return { entries: rows, state };
}
