export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeExtrasInto(
  base: Record<string, unknown>,
  extras: unknown,
  platform: string,
  omit: string[] = []
): void {
  if (!isObject(extras)) return;
  const plat = extras[platform as keyof typeof extras];
  if (!isObject(plat)) return;
  for (const [k, v] of Object.entries(plat)) {
    if (omit.includes(k)) continue;
    base[k] = v;
  }
}

export function excludeKey(extras: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(extras)) return undefined;
  const out = Object.fromEntries(Object.entries(extras).filter(([k]) => k !== key));
  return Object.keys(out).length > 0 ? out : undefined;
}

export function pickStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value.filter((t) => typeof t === 'string') as string[]) : [];
}
