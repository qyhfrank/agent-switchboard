function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value.filter((t) => typeof t === 'string') as string[]) : [];
}

function getPlatformExtras(extras: unknown, platform: string): Record<string, unknown> | undefined {
  if (!isObject(extras)) return undefined;
  const candidate = extras[platform as keyof typeof extras];
  return isObject(candidate) ? candidate : undefined;
}

export function pickFirstPlatformString(
  extras: unknown,
  platforms: string[],
  key: string
): string | null {
  for (const platform of platforms) {
    const platformExtras = getPlatformExtras(extras, platform);
    const value = platformExtras?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

export function pickFirstPlatformArray(
  extras: unknown,
  platforms: string[],
  key: string
): string[] {
  for (const platform of platforms) {
    const platformExtras = getPlatformExtras(extras, platform);
    const value = platformExtras?.[key];
    if (Array.isArray(value)) {
      return pickStringArray(value);
    }
  }
  return [];
}

export function listExtraKeys(extras: unknown): string[] {
  return isObject(extras) ? Object.keys(extras) : [];
}

/** Shared platform priority for model/tools extraction from extras. */
export const PLATFORM_PRIORITY = ['claude-code', 'opencode', 'cursor', 'codex'] as const;
