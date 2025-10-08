import { checkbox, confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadLibraryStateSection, updateLibraryStateSection } from '../library/state.js';

export interface GenericSelectionResult {
  active: string[];
}

export interface LibrarySelectorOptions<TEntry> {
  section: 'commands' | 'subagents';
  emptyHint: string; // e.g. '  asb command load <platform> [path]'
  // Entry accessors
  loadEntries: () => TEntry[];
  getId: (e: TEntry) => string;
  getTitle: (e: TEntry) => string;
  getModel?: (e: TEntry) => string | undefined;
  noun: string; // e.g. 'command' | 'subagent'
  allowOrdering?: boolean; // default: true. If false, skip reordering prompt
}

function formatOrderList<TEntry>(
  order: string[],
  map: Map<string, TEntry>,
  getTitle: (e: TEntry) => string
): string {
  return order
    .map((id, index) => {
      const item = map.get(id);
      const title = item ? getTitle(item) : id;
      return `${index + 1}. ${title} ${chalk.gray(`(${id})`)}`;
    })
    .join('\n');
}

function resolveToken(token: string, order: string[]): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < order.length) return order[index];
    return null;
  }
  return trimmed;
}

async function promptOrder<TEntry>(
  label: string,
  initialOrder: string[],
  map: Map<string, TEntry>,
  getTitle: (e: TEntry) => string
): Promise<string[]> {
  if (initialOrder.length <= 1) return initialOrder;
  let currentOrder = [...initialOrder];
  while (true) {
    console.log();
    console.log(chalk.blue(`Selected ${label} order:`));
    console.log(formatOrderList(currentOrder, map, getTitle));
    console.log(
      chalk.gray(
        'Enter comma-separated IDs or numbers to reorder. Press Enter to keep the current order.'
      )
    );

    const response = await input({ message: 'New order (IDs or numbers):' });
    if (!response || response.trim().length === 0) return currentOrder;

    const tokens = response
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length !== currentOrder.length) {
      console.log(chalk.red('✗ Please provide exactly the same number of items as selected.'));
      continue;
    }

    const resolved: string[] = [];
    const seen = new Set<string>();
    let isValid = true;
    for (const token of tokens) {
      const id = resolveToken(token, currentOrder);
      if (!id || !map.has(id) || !currentOrder.includes(id)) {
        console.log(chalk.red(`✗ Invalid identifier: ${token}`));
        isValid = false;
        break;
      }
      if (seen.has(id)) {
        console.log(chalk.red(`✗ Duplicate identifier: ${token}`));
        isValid = false;
        break;
      }
      seen.add(id);
      resolved.push(id);
    }
    if (!isValid) continue;
    currentOrder = resolved;
    return currentOrder;
  }
}

export async function showLibrarySelector<TEntry>(
  opts: LibrarySelectorOptions<TEntry>
): Promise<GenericSelectionResult | null> {
  const allowOrdering = opts.allowOrdering !== false;
  const entries = opts.loadEntries();
  if (entries.length === 0) {
    console.log(chalk.yellow(`⚠ No ${opts.noun}s found.`));
    console.log();
    console.log('Use:');
    console.log(chalk.dim(`  ${opts.emptyHint}`));
    return null;
  }

  const map = new Map<string, TEntry>();
  for (const e of entries) map.set(opts.getId(e), e);

  const state = loadLibraryStateSection(opts.section);

  const describeEntry = (e: TEntry) => {
    const title = opts.getTitle(e).trim();
    const id = opts.getId(e);
    const idSuffix = title && title.length > 0 ? chalk.gray(` (${id})`) : '';
    const modelStr = opts.getModel ? opts.getModel(e) : undefined;
    const model = modelStr ? chalk.gray(` – ${modelStr}`) : '';
    return `${chalk.cyan(title || id)}${idSuffix}${model}`.trim();
  };

  const buildChoices = (activeIds: string[]) => {
    const activeSet = new Set(activeIds);
    const orderedActive: TEntry[] = [];
    for (const id of activeIds) {
      const entry = map.get(id);
      if (entry) orderedActive.push(entry);
    }

    const inactive = entries
      .filter((e) => !activeSet.has(opts.getId(e)))
      .sort((a, b) => opts.getTitle(a).localeCompare(opts.getTitle(b)));

    const ordered = [...orderedActive, ...inactive];
    return ordered.map((e) => ({
      name: describeEntry(e),
      value: opts.getId(e),
      checked: activeSet.has(opts.getId(e)),
    }));
  };

  while (true) {
    const choices = buildChoices(state.active);
    const selected = await checkbox({
      message: `Select ${opts.noun}s to enable (Space: toggle, a: all, i: invert, Enter: confirm):`,
      choices,
      pageSize: 15,
    });

    if (selected.length === 0) {
      const confirmed = await confirm({
        message: `No ${opts.noun}s selected. Proceed with empty configuration?`,
        default: false,
      });
      if (confirmed) {
        updateLibraryStateSection(opts.section, () => ({ active: [], agentSync: {} }));
        return { active: [] };
      }
      continue;
    }

    if (!allowOrdering) {
      updateLibraryStateSection(opts.section, () => ({ active: selected, agentSync: {} }));
      return { active: selected };
    }

    const ordered = await promptOrder(opts.noun, selected, map, opts.getTitle);
    updateLibraryStateSection(opts.section, () => ({ active: ordered, agentSync: {} }));
    return { active: ordered };
  }
}
