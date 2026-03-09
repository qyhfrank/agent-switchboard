import type { UpdateConfigLayerOptions } from '../config/layered-config.js';
import {
  loadMergedSwitchboardConfig,
  loadWritableConfigLayer,
  updateConfigLayer,
} from '../config/layered-config.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';
import { type RuleState, ruleStateSchema } from './schema.js';

export const DEFAULT_RULE_STATE: RuleState = {
  enabled: [],
  agentSync: {},
};

function deduplicateEnabled(ids: string[]): string[] {
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

function normalizeEnabled(ids: string[]): string[] {
  return deduplicateEnabled(ids.map((id) => id.trim()).filter((id) => id.length > 0));
}

function getConfigEnabled(options?: UpdateConfigLayerOptions): string[] {
  const { config } = loadMergedSwitchboardConfig(options);
  return [...config.rules.enabled];
}

function getWritableConfigEnabled(options?: UpdateConfigLayerOptions): string[] {
  const layer = loadWritableConfigLayer(options);
  return Array.isArray(layer.config.rules?.enabled) ? [...layer.config.rules.enabled] : [];
}

function writeConfigEnabled(enabled: string[], options?: UpdateConfigLayerOptions): void {
  updateConfigLayer((layer) => {
    const next = { ...layer };
    const currentRules = (next.rules ?? {}) as Record<string, unknown>;
    next.rules = {
      ...currentRules,
      enabled: [...enabled],
    } as unknown as typeof next.rules;
    return next;
  }, options);
}

const agentSyncCache: RuleState['agentSync'] = {};

export function loadRuleState(scope?: ConfigScope): RuleState {
  const layerOptions = scopeToLayerOptions(scope);
  const enabled = normalizeEnabled(getConfigEnabled(layerOptions));
  return {
    enabled,
    agentSync: { ...agentSyncCache },
  };
}

export function loadWritableRuleState(scope?: ConfigScope): RuleState {
  const layerOptions = scopeToLayerOptions(scope);
  const enabled = normalizeEnabled(getWritableConfigEnabled(layerOptions));
  return {
    enabled,
    agentSync: { ...agentSyncCache },
  };
}

export function loadRuleAgentSync(): RuleState['agentSync'] {
  return { ...agentSyncCache };
}

export function saveRuleState(state: RuleState, scope?: ConfigScope): void {
  const layerOptions = scopeToLayerOptions(scope);
  const validated = ruleStateSchema.parse(state);
  const normalizedEnabled = normalizeEnabled(validated.enabled);
  writeConfigEnabled(normalizedEnabled, layerOptions);
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
  const current = loadWritableRuleState(scope);
  const next = mutator(current);
  saveRuleState(next, scope);
  return loadWritableRuleState(scope);
}

export function updateRuleAgentSync(
  mutator: (current: RuleState['agentSync']) => RuleState['agentSync']
): RuleState['agentSync'] {
  Object.keys(agentSyncCache).forEach((key) => {
    delete agentSyncCache[key];
  });
  for (const [key, value] of Object.entries(mutator(loadRuleAgentSync()))) {
    agentSyncCache[key] = { ...value };
  }
  return loadRuleAgentSync();
}
