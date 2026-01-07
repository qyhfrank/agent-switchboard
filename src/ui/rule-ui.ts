import { confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';

import type { ConfigScope } from '../config/scope.js';
import { loadRuleLibrary, type RuleSnippet } from '../rules/library.js';
import { loadRuleState } from '../rules/state.js';
import { type FuzzyMultiSelectChoice, fuzzyMultiSelect } from './fuzzy-multi-select.js';

interface RuleSelectionResult {
  active: string[];
}

export interface RuleSelectorOptions {
  scope?: ConfigScope;
  pageSize?: number;
}

function formatOrderList(order: string[], map: Map<string, RuleSnippet>): string {
  return order
    .map((id, index) => {
      const rule = map.get(id);
      const title = rule?.metadata.title ?? id;
      return `${index + 1}. ${title} ${chalk.gray(`(${id})`)}`;
    })
    .join('\n');
}

function resolveToken(token: string, order: string[]): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < order.length) {
      return order[index];
    }
    return null;
  }

  return trimmed;
}

async function promptRuleOrder(
  initialOrder: string[],
  ruleMap: Map<string, RuleSnippet>
): Promise<string[]> {
  if (initialOrder.length <= 1) {
    return initialOrder;
  }

  let currentOrder = [...initialOrder];

  while (true) {
    console.log();
    console.log(chalk.blue('Selected rule order:'));
    console.log(formatOrderList(currentOrder, ruleMap));
    console.log(
      chalk.gray(
        'Enter comma-separated IDs or numbers to reorder. Press Enter to keep the current order.'
      )
    );

    const response = await input({
      message: 'New order (IDs or numbers):',
    });

    if (!response || response.trim().length === 0) {
      return currentOrder;
    }

    const tokens = response
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length !== currentOrder.length) {
      console.log(chalk.red('✗ Please provide exactly the same number of items as selected.'));
      continue;
    }

    const resolved: string[] = [];
    const seen = new Set<string>();
    let isValid = true;

    for (const token of tokens) {
      const resolvedId = resolveToken(token, currentOrder);
      if (!resolvedId || !ruleMap.has(resolvedId) || !currentOrder.includes(resolvedId)) {
        console.log(chalk.red(`✗ Invalid identifier: ${token}`));
        isValid = false;
        break;
      }
      if (seen.has(resolvedId)) {
        console.log(chalk.red(`✗ Duplicate identifier: ${token}`));
        isValid = false;
        break;
      }
      seen.add(resolvedId);
      resolved.push(resolvedId);
    }

    if (!isValid) {
      continue;
    }

    currentOrder = resolved;
    return currentOrder;
  }
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

    const ordered = await promptRuleOrder(sanitized, ruleMap);
    return { active: ordered };
  }
}
