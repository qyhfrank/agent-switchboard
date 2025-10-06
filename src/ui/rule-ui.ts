import { checkbox, confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';

import { loadRuleLibrary, type RuleSnippet } from '../rules/library.js';
import { loadRuleState } from '../rules/state.js';

interface RuleSelectionResult {
  active: string[];
}

function buildRuleMap(rules: RuleSnippet[]): Map<string, RuleSnippet> {
  const map = new Map<string, RuleSnippet>();
  for (const rule of rules) {
    map.set(rule.id, rule);
  }
  return map;
}

function describeRule(rule: RuleSnippet): string {
  const title = rule.metadata.title?.trim();
  const label = title && title.length > 0 ? chalk.cyan(title) : chalk.cyan(rule.id);
  const idSuffix = title && title.length > 0 ? chalk.gray(` (${rule.id})`) : '';
  const tags =
    rule.metadata.tags.length > 0 ? chalk.gray(` [${rule.metadata.tags.join(', ')}]`) : '';
  const requires =
    rule.metadata.requires.length > 0
      ? chalk.yellow(` requires: ${rule.metadata.requires.join(', ')}`)
      : '';
  const description = rule.metadata.description
    ? chalk.gray(` – ${rule.metadata.description}`)
    : '';
  return `${label}${idSuffix}${tags}${requires}${description}`.trim();
}

function buildRuleChoices(rules: RuleSnippet[], activeIds: string[]) {
  const activeSet = new Set(activeIds);
  const ruleMap = buildRuleMap(rules);

  const orderedActive: RuleSnippet[] = [];
  for (const id of activeIds) {
    const rule = ruleMap.get(id);
    if (rule) orderedActive.push(rule);
  }

  const inactiveRules = rules
    .filter((rule) => !activeSet.has(rule.id))
    .sort((a, b) => {
      const aLabel = (a.metadata.title ?? a.id).toLowerCase();
      const bLabel = (b.metadata.title ?? b.id).toLowerCase();
      return aLabel.localeCompare(bLabel);
    });

  const ordered = [...orderedActive, ...inactiveRules];

  return ordered.map((rule) => ({
    name: describeRule(rule),
    value: rule.id,
    checked: activeSet.has(rule.id),
  }));
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

export async function showRuleSelector(): Promise<RuleSelectionResult | null> {
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

  const state = loadRuleState();
  const ruleMap = buildRuleMap(rules);

  while (true) {
    const choices = buildRuleChoices(rules, state.active);
    const selected = await checkbox({
      message: 'Select rule snippets to enable (Space: toggle, a: all, i: invert, Enter: confirm):',
      choices,
      pageSize: 15,
    });

    if (selected.length === 0) {
      const confirmed = await confirm({
        message: 'No rules selected. Proceed with empty configuration?',
        default: false,
      });
      if (confirmed) {
        return { active: [] };
      }
      continue;
    }

    const ordered = await promptRuleOrder(selected, ruleMap);
    return { active: ordered };
  }
}
