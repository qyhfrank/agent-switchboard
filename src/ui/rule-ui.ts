import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import type { ConfigScope } from '../config/scope.js';
import { loadRuleLibrary, type RuleSnippet } from '../rules/library.js';
import { loadRuleState } from '../rules/state.js';
import { type FuzzyMultiSelectChoice, fuzzyMultiSelect } from './fuzzy-multi-select.js';
import { promptOrder } from './library-selector.js';

interface RuleSelectionResult {
  active: string[];
}

export interface RuleSelectorOptions {
  scope?: ConfigScope;
  pageSize?: number;
}

export async function showRuleSelector(
  options?: RuleSelectorOptions
): Promise<RuleSelectionResult | null> {
  const scope = options?.scope;
  const pageSize = options?.pageSize ?? 20;
  const rules = loadRuleLibrary();

  if (rules.length === 0) {
    console.log(chalk.yellow('⚠ No rule snippets found.'));
    console.log();
    console.log('Place Markdown files in:');
    console.log(chalk.dim('  ~/.agent-switchboard/rules/'));
    console.log();
    console.log('Each file may include YAML frontmatter, e.g.');
    console.log(
      chalk.dim(
        `  ---\n  title: Example Rule\n  description: Helpful note\n  tags:\n    - hygiene\n  ---\n  Always lint before committing.`
      )
    );
    return null;
  }

  const state = loadRuleState(scope);
  const ruleMap = new Map<string, RuleSnippet>();
  for (const rule of rules) {
    ruleMap.set(rule.id, rule);
  }

  const buildChoiceList = (activeIds: string[]): FuzzyMultiSelectChoice[] => {
    const activeSet = new Set(activeIds);
    const orderedActive: RuleSnippet[] = [];
    for (const id of activeIds) {
      const snippet = ruleMap.get(id);
      if (snippet) orderedActive.push(snippet);
    }

    const inactive = rules
      .filter((rule) => !activeSet.has(rule.id))
      .sort((a, b) => {
        const aTitle = (a.metadata.title ?? a.id).toLowerCase();
        const bTitle = (b.metadata.title ?? b.id).toLowerCase();
        return aTitle.localeCompare(bTitle);
      });

    const ordered = [...orderedActive, ...inactive];

    return ordered.map((rule) => {
      const label = rule.metadata.title?.trim() ?? '';
      const primary = label.length > 0 ? label : rule.id;
      const hintParts = new Set<string>();
      if (primary !== rule.id) hintParts.add(rule.id);
      if (rule.metadata.tags.length > 0) {
        hintParts.add(`tags: ${rule.metadata.tags.join(', ')}`);
      }
      if (rule.metadata.requires.length > 0) {
        hintParts.add(`requires: ${rule.metadata.requires.join(', ')}`);
      }
      if (rule.metadata.description) {
        hintParts.add(rule.metadata.description);
      }
      const keywordSet = new Set<string>();
      keywordSet.add(rule.id);
      if (label.length > 0) keywordSet.add(label);
      if (rule.metadata.description) keywordSet.add(rule.metadata.description);
      for (const tag of rule.metadata.tags) keywordSet.add(tag);
      for (const req of rule.metadata.requires) keywordSet.add(req);
      return {
        value: rule.id,
        label: primary,
        hint: hintParts.size > 0 ? Array.from(hintParts).join(' · ') : undefined,
        keywords: Array.from(keywordSet),
      } satisfies FuzzyMultiSelectChoice;
    });
  };

  while (true) {
    const selection = await fuzzyMultiSelect({
      message: 'Select rules to enable',
      choices: buildChoiceList(state.active),
      initialSelected: state.active,
      pageSize,
      allowEmpty: true,
    });

    const sanitized = selection.filter((id) => ruleMap.has(id));

    if (sanitized.length === 0) {
      const confirmed = await confirm({
        message: 'No rules selected. Proceed with empty configuration?',
        default: false,
      });
      if (confirmed) {
        return { active: [] };
      }
      continue;
    }

    const ordered = await promptOrder(
      'rule',
      sanitized,
      ruleMap,
      (rule) => rule.metadata.title ?? rule.id
    );
    return { active: ordered };
  }
}
