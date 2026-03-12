export interface SelectionPersistenceOptions {
  effectiveEnabled: string[];
  selectedEnabled: string[];
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function shouldPersistSelection(options: SelectionPersistenceOptions): boolean {
  const { effectiveEnabled, selectedEnabled } = options;
  return !arraysEqual(effectiveEnabled, selectedEnabled);
}
