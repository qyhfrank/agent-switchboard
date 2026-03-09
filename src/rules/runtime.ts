import { loadWritableConfigLayer } from '../config/layered-config.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import { loadRuleLibrary, type RuleSnippet } from './library.js';
import type { RuleState } from './schema.js';
import { loadRuleState, loadWritableRuleState } from './state.js';

export interface RuleRuntimeContext {
  rules: RuleSnippet[];
  effectiveState: RuleState;
  writableState: RuleState;
  activeState: RuleState;
  includeDelimiters: boolean;
}

export function hasWritableRuleScope(scope?: ConfigScope): boolean {
  return Boolean(scope?.profile || scope?.project);
}

export function loadRuleIncludeDelimiters(scope?: ConfigScope): boolean {
  const config = hasWritableRuleScope(scope)
    ? loadWritableConfigLayer(scopeToLayerOptions(scope)).config
    : loadSwitchboardConfig(
        scope
          ? {
              profile: scope.profile ?? undefined,
              projectPath: scope.project ?? undefined,
            }
          : undefined
      );

  return config.rules?.includeDelimiters === true;
}

export function loadRuleRuntimeContext(scope?: ConfigScope): RuleRuntimeContext {
  const rules = loadRuleLibrary(scope);
  const effectiveState = loadRuleState(scope);
  const writableState = hasWritableRuleScope(scope) ? loadWritableRuleState(scope) : effectiveState;
  const activeState = hasWritableRuleScope(scope) ? writableState : effectiveState;

  return {
    rules,
    effectiveState,
    writableState,
    activeState,
    includeDelimiters: loadRuleIncludeDelimiters(scope),
  };
}
