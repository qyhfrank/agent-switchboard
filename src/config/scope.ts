import type { UpdateConfigLayerOptions } from './layered-config.js';

export interface ConfigScope {
  profile?: string | null;
  project?: string | null;
}

function normalizeString(input: string | null | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function scopeToLayerOptions(scope?: ConfigScope): UpdateConfigLayerOptions | undefined {
  if (!scope) return undefined;
  const profile = normalizeString(scope.profile ?? undefined);
  const projectPath = normalizeString(scope.project ?? undefined);
  if (!profile && !projectPath) return undefined;
  return {
    profile,
    projectPath,
  };
}
