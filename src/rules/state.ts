import type { UpdateConfigLayerOptions } from '../config/layered-config.js';
import { loadMergedSwitchboardConfig, updateConfigLayer } from '../config/layered-config.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';
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

function normalizeActive(ids: string[]): string[] {
  return deduplicateActive(ids.map((id) => id.trim()).filter((id) => id.length > 0));
}

function getConfigActive(options?: UpdateConfigLayerOptions): string[] {
  const { config } = loadMergedSwitchboardConfig(options);
  return [...config.rules.active];
}

function writeConfigActive(active: string[], options?: UpdateConfigLayerOptions): void {
  updateConfigLayer((layer) => {
    const next = { ...layer };
    const currentRules = (next.rules ?? {}) as Record<string, unknown>;
    next.rules = {
      ...currentRules,
      active: [...active],
    } as unknown as typeof next.rules;
    return next;
  }, options);
}

const agentSyncCache: RuleState['agentSync'] = {};

export function loadRuleState(scope?: ConfigScope): RuleState {
  const layerOptions = scopeToLayerOptions(scope);
  const active = normalizeActive(getConfigActive(layerOptions));
  return {
    active,
    agentSync: { ...agentSyncCache },
  };
}

export function saveRuleState(state: RuleState, scope?: ConfigScope): void {
  const layerOptions = scopeToLayerOptions(scope);
  const validated = ruleStateSchema.parse(state);
  const normalizedActive = normalizeActive(validated.active);
  writeConfigActive(normalizedActive, layerOptions);
  Object.keys(agentSyncCache).forEach((key) => {
    delete agentSyncCache[key];
  });
  for (const [key, value] of Object.entries(validated.agentSync)) {
    agentSyncCache[key] = { ...value };
  }
}

export function updateRuleState(
  mutator: (current: RuleState) => RuleState,
  scope?: ConfigScope
): RuleState {
  const current = loadRuleState(scope);
  const next = mutator(current);
  saveRuleState(next, scope);
  return loadRuleState(scope);
}
