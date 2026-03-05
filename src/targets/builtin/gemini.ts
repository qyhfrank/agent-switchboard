import path from 'node:path';
import { stringify as toToml } from '@iarna/toml';
import { GeminiAgent } from '../../agents/gemini.js';
import { getGeminiDir, getProjectGeminiDir } from '../../config/paths.js';
import type { ApplicationTarget, GenericLibraryEntry } from '../types.js';
import { extractTomlId, getPlatformExtras, resolveProjectRoot } from './common.js';

const adapter = new GeminiAgent();

function renderGeminiCommand(entry: GenericLibraryEntry): string {
  const g = getPlatformExtras(entry, 'gemini');
  const obj: Record<string, unknown> = { prompt: entry.content.trimStart() };
  if (entry.metadata.description) obj.description = entry.metadata.description;
  if (g) {
    for (const [k, v] of Object.entries(g)) obj[k] = v;
  }
  // biome-ignore lint/suspicious/noExplicitAny: TOML stringify expects JSON-like values
  return toToml(obj as any);
}

export const geminiTarget: ApplicationTarget = {
  id: 'gemini',

  mcp: {
    configPath: () => adapter.configPath(),
    projectConfigPath: (root) => adapter.projectConfigPath(root),
    applyConfig: (config) => adapter.applyConfig(config),
    applyProjectConfig: (root, config) => adapter.applyProjectConfig(root, config),
  },

  rules: {
    resolveFilePath: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(root, 'AGENTS.md');
      return path.join(getGeminiDir(), 'AGENTS.md');
    },
    render: (content) => content,
  },

  commands: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectGeminiDir(root), 'commands');
      return path.join(getGeminiDir(), 'commands');
    },
    getFilename: (id) => `${id}.toml`,
    render: renderGeminiCommand,
    extractIdFromFilename: extractTomlId,
  },

  skills: {
    resolveParentDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectGeminiDir(root), 'skills');
      return path.join(getGeminiDir(), 'skills');
    },
    resolveTargetDir: (id, scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectGeminiDir(root), 'skills', id);
      return path.join(getGeminiDir(), 'skills', id);
    },
  },
};
