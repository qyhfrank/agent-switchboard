import { loadRuleLibrary, type RuleSnippet } from './library.js';
import type { RuleState } from './schema.js';
import { loadRuleState } from './state.js';

export interface RuleInventoryRow {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[];
  requires: string[];
  active: boolean;
  order: number | null;
  missing: boolean;
  filePath: string | null;
}

export interface RuleInventory {
  snippets: RuleInventoryRow[];
  state: RuleState;
}

function sortInactiveRules(rules: RuleSnippet[]): RuleSnippet[] {
  return [...rules].sort((a, b) => {
    const aLabel = (a.metadata.title ?? a.id).toLowerCase();
    const bLabel = (b.metadata.title ?? b.id).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}

export function buildRuleInventory(): RuleInventory {
  const rules = loadRuleLibrary();
  const state = loadRuleState();

  const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
  const rows: RuleInventoryRow[] = [];

  const seen = new Set<string>();

  // Active rules in configured order
  state.active.forEach((id, index) => {
    const rule = ruleMap.get(id);
    if (!rule) {
      rows.push({
        id,
        title: null,
        description: null,
        tags: [],
        requires: [],
        active: true,
        order: index + 1,
        missing: true,
        filePath: null,
      });
      return;
    }

    seen.add(id);
    rows.push({
      id,
      title: rule.metadata.title ?? null,
      description: rule.metadata.description ?? null,
      tags: rule.metadata.tags,
      requires: rule.metadata.requires,
      active: true,
      order: index + 1,
      missing: false,
      filePath: rule.filePath,
    });
  });

  // Inactive rules sorted alphabetically
  const inactiveRules = sortInactiveRules(rules.filter((rule) => !seen.has(rule.id)));
  inactiveRules.forEach((rule) => {
    rows.push({
      id: rule.id,
      title: rule.metadata.title ?? null,
      description: rule.metadata.description ?? null,
      tags: rule.metadata.tags,
      requires: rule.metadata.requires,
      active: false,
      order: null,
      missing: false,
      filePath: rule.filePath,
    });
  });

  return {
    snippets: rows,
    state,
  };
}
