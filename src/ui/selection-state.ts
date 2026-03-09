export interface SelectionPersistenceOptions {
  currentEnabled: string[];
  effectiveEnabled: string[];
  selectedEnabled: string[];
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function shouldPersistSelection(options: SelectionPersistenceOptions): boolean {
  const { currentEnabled, effectiveEnabled, selectedEnabled } = options;
  if (selectedEnabled.length === 0) {
    return currentEnabled.length > 0 || effectiveEnabled.length > 0;
  }
  return !arraysEqual(currentEnabled, selectedEnabled);
}
