import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useRef,
  useState,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import chalk from 'chalk';

interface ChoiceInput {
  value: string;
  label: string;
  hint?: string;
  keywords: string[];
}

export interface FuzzyMultiSelectChoice extends ChoiceInput {}

export interface FuzzyMultiSelectOptions {
  message: string;
  choices: FuzzyMultiSelectChoice[];
  initialSelected?: string[];
  pageSize?: number;
  allowEmpty?: boolean;
  helpText?: string;
}

interface NormalizedChoice extends ChoiceInput {
  order: number;
  searchText: string;
}

interface FilteredChoice extends NormalizedChoice {
  highlightedLabel: string;
  highlightedHint?: string;
  matchScore: number;
}

interface PromptConfig extends FuzzyMultiSelectOptions {}

const DEFAULT_HELP =
  'Space: toggle • Arrow keys: move • A: select all • I: invert • Esc: clear filter • Enter: confirm';

const prompt = createPrompt<string[], PromptConfig>((config, done) => {
  const { choices, initialSelected, pageSize = 12, allowEmpty = true, helpText } = config;
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const selectedRef = useRef<Set<string>>(new Set(initialSelected ?? []));
  const [renderTick, setRenderTick] = useState(0);

  const prefix = usePrefix({ status });

  const normalizedChoices = useMemo<NormalizedChoice[]>(
    () =>
      choices.map((choice, index) => ({
        ...choice,
        order: index,
        searchText: buildSearchText(choice),
      })),
    [choices]
  );

  const filteredChoices = useMemo<FilteredChoice[]>(
    () => filterChoices(normalizedChoices, filter),
    [normalizedChoices, filter]
  );

  useEffect(() => {
    if (filteredChoices.length === 0) {
      setActive(0);
      return;
    }
    if (active >= filteredChoices.length) {
      setActive(filteredChoices.length - 1);
    }
  }, [filteredChoices, active]);

  const renderSelected = () => {
    const ordered = normalizeSelectionOrder(config.choices, selectedRef.current);
    if (ordered.length === 0) {
      return chalk.gray('none');
    }
    return chalk.cyan(ordered.join(', '));
  };

  const toggleValue = (value: string) => {
    const next = new Set(selectedRef.current);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    selectedRef.current = next;
    setRenderTick(renderTick + 1);
  };

  const selectAll = (values: string[]) => {
    const next = new Set(selectedRef.current);
    for (const value of values) next.add(value);
    selectedRef.current = next;
    setRenderTick(renderTick + 1);
  };

  const invertSelection = (values: string[]) => {
    const next = new Set(selectedRef.current);
    for (const value of values) {
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
    }
    selectedRef.current = next;
    setRenderTick(renderTick + 1);
  };

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      const ordered = normalizeSelectionOrder(config.choices, selectedRef.current);
      if (!allowEmpty && ordered.length === 0) {
        setError('Please select at least one item');
        rl.write(filter);
        return;
      }
      setStatus('done');
      done(ordered);
      return;
    }

    if (filteredChoices.length > 0 && isUpKey(key)) {
      rl.clearLine(0);
      rl.write(filter);
      const nextIndex = (active - 1 + filteredChoices.length) % filteredChoices.length;
      setActive(nextIndex);
      return;
    }

    if (filteredChoices.length > 0 && isDownKey(key)) {
      rl.clearLine(0);
      rl.write(filter);
      const nextIndex = (active + 1) % filteredChoices.length;
      setActive(nextIndex);
      return;
    }

    if (key.name === 'space') {
      rl.clearLine(0);
      rl.write(filter);
      const target = filteredChoices[active];
      if (target) {
        setError(undefined);
        toggleValue(target.value);
      }
      return;
    }

    if (key.name === 'a' && !key.ctrl) {
      rl.clearLine(0);
      rl.write(filter);
      const values = filteredChoices.map((choice) => choice.value);
      if (values.length > 0) {
        setError(undefined);
        selectAll(values);
      }
      return;
    }

    if (key.name === 'i' && !key.ctrl) {
      rl.clearLine(0);
      rl.write(filter);
      const values = filteredChoices.map((choice) => choice.value);
      if (values.length > 0) {
        setError(undefined);
        invertSelection(values);
      }
      return;
    }

    if (key.name === 'escape') {
      rl.clearLine(0);
      setFilter('');
      setError(undefined);
      return;
    }

    setError(undefined);
    setFilter(rl.line);
  });

  if (status === 'done') {
    return `${prefix} ${config.message} ${renderSelected()}`;
  }

  const selectedCount = selectedRef.current.size;
  const filterLabel = filter.length > 0 ? chalk.cyan(filter) : chalk.gray('type to filter');
  const selectionBadge =
    selectedCount === 0 ? chalk.gray('0 selected') : chalk.cyan(`${selectedCount} selected`);
  const header = `${prefix} ${config.message} ${selectionBadge}`;
  const filterLine = `  ${chalk.gray('Filter:')} ${filterLabel}`;

  let listBlock: string;
  if (filteredChoices.length === 0) {
    listBlock = `  ${chalk.gray('No matches')}`;
  } else {
    const page = usePagination({
      items: filteredChoices,
      active,
      pageSize,
      loop: true,
      renderItem({ item, isActive }) {
        const pointer = isActive ? chalk.cyan(figures.pointerSmall) : ' ';
        const checked = selectedRef.current.has(item.value) ? chalk.green('◉') : chalk.gray('◯');
        const label = item.highlightedLabel;
        const hint = item.highlightedHint ?? item.hint;
        const hintSuffix = hint ? ` ${chalk.gray(hint)}` : '';
        return `  ${pointer} ${checked} ${label}${hintSuffix}`;
      },
    });
    listBlock = page;
  }

  const helpLine = `  ${chalk.gray(helpText ?? DEFAULT_HELP)}`;
  const errorLine = error ? `  ${chalk.red(error)}` : '';

  return [header, filterLine, listBlock, helpLine, errorLine].filter(Boolean).join('\n');
});

export async function fuzzyMultiSelect(config: FuzzyMultiSelectOptions): Promise<string[]> {
  return prompt(config);
}

function buildSearchText(choice: ChoiceInput): string {
  const parts = new Set<string>();
  parts.add(choice.value.toLowerCase());
  parts.add(choice.label.toLowerCase());
  for (const keyword of choice.keywords) {
    if (keyword.trim().length === 0) continue;
    parts.add(keyword.toLowerCase());
  }
  return Array.from(parts).join(' ');
}

function filterChoices(choices: NormalizedChoice[], query: string): FilteredChoice[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return choices.map((choice) => ({
      ...choice,
      highlightedLabel: choice.label,
      highlightedHint: choice.hint,
      matchScore: choice.order,
    }));
  }
  const tokens = trimmed
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  const results: FilteredChoice[] = [];
  for (const choice of choices) {
    const score = computeMatch(choice.searchText, tokens);
    if (score === null) continue;
    results.push({
      ...choice,
      highlightedLabel: highlight(choice.label, tokens),
      highlightedHint: choice.hint ? highlight(choice.hint, tokens) : choice.hint,
      matchScore: score,
    });
  }
  results.sort((a, b) => {
    if (a.matchScore !== b.matchScore) return a.matchScore - b.matchScore;
    return a.order - b.order;
  });
  return results;
}

function computeMatch(text: string, tokens: string[]): number | null {
  let cursor = 0;
  let total = 0;
  for (const token of tokens) {
    const result = locateSubsequence(text, token, cursor);
    if (!result) return null;
    total += result.score;
    cursor = result.nextIndex;
  }
  return total;
}

function locateSubsequence(
  text: string,
  token: string,
  start: number
): { score: number; nextIndex: number } | null {
  let score = 0;
  let cursor = start;
  for (const char of token) {
    const index = text.indexOf(char, cursor);
    if (index === -1) return null;
    score += index - cursor;
    cursor = index + 1;
  }
  return { score, nextIndex: cursor };
}

function highlight(text: string, tokens: string[]): string {
  if (tokens.length === 0) return text;
  const lower = text.toLowerCase();
  const positions = new Set<number>();
  let cursor = 0;
  for (const token of tokens) {
    const result = capturePositions(lower, token, cursor);
    if (!result) continue;
    for (const pos of result.positions) positions.add(pos);
    cursor = result.nextIndex;
  }
  if (positions.size === 0) return text;
  const chars = Array.from(text);
  return chars.map((char, index) => (positions.has(index) ? chalk.cyan(char) : char)).join('');
}

function capturePositions(
  text: string,
  token: string,
  start: number
): { positions: number[]; nextIndex: number } | null {
  const positions: number[] = [];
  let cursor = start;
  for (const char of token) {
    const index = text.indexOf(char, cursor);
    if (index === -1) return null;
    positions.push(index);
    cursor = index + 1;
  }
  return { positions, nextIndex: cursor };
}

function normalizeSelectionOrder(originalChoices: ChoiceInput[], selected: Set<string>): string[] {
  const order: string[] = [];
  for (const choice of originalChoices) {
    if (selected.has(choice.value)) {
      order.push(choice.value);
    }
  }
  return order;
}
