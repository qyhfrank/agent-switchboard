import fs from 'node:fs';

import { getConfigDir, getRuleStatePath } from '../config/paths.js';
import { type RuleState, ruleStateSchema } from './schema.js';

export const DEFAULT_RULE_STATE: RuleState = {
  active: [],
  agentSync: {},
};

function deduplicateActive(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeState(input: RuleState): RuleState {
  const active = deduplicateActive(
    input.active.map((id) => id.trim()).filter((id) => id.length > 0)
  );
  return {
    ...input,
    active,
  };
}

export function loadRuleState(): RuleState {
  const filePath = getRuleStatePath();
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_RULE_STATE };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = ruleStateSchema.parse(parsed);
    return normalizeState(validated);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load rule state from ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function saveRuleState(state: RuleState): void {
  const filePath = getRuleStatePath();
  const configDir = getConfigDir();

  try {
    const validated = ruleStateSchema.parse(state);
    const normalized = normalizeState(validated);

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const json = `${JSON.stringify(normalized, null, 4)}\n`;
    fs.writeFileSync(filePath, json, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to save rule state to ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function updateRuleState(mutator: (current: RuleState) => RuleState): RuleState {
  const current = loadRuleState();
  const next = mutator(current);
  saveRuleState(next);
  return loadRuleState();
}
