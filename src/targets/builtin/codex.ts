import path from 'node:path';
import { CodexAgent } from '../../agents/codex.js';
import { getCodexDir, getProjectCodexSkillsDir } from '../../config/paths.js';
import { distributeCodexSubagents } from '../../subagents/codex-distribute.js';
import type { ApplicationTarget } from '../types.js';
import { extractMdId, resolveProjectRoot } from './common.js';

const adapter = new CodexAgent();

export const codexTarget: ApplicationTarget = {
  id: 'codex',

  mcp: {
    configPath: () => adapter.configPath(),
    projectConfigPath: (root) => adapter.projectConfigPath(root),
    applyConfig: (config) => adapter.applyConfig(config),
    applyProjectConfig: (root, config) => adapter.applyProjectConfig!(root, config),
  },

  rules: {
    resolveFilePath: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(root, 'AGENTS.md');
      return path.join(getCodexDir(), 'AGENTS.md');
    },
    render: (content) => content,
  },

  commands: {
    resolveTargetDir: () => path.join(getCodexDir(), 'prompts'),
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const desc = entry.metadata.description?.trim();
      const header = desc && desc.length > 0 ? `<!-- ${desc} -->\n\n` : '';
      return (
        '<!-- [deprecated] Codex custom prompts are deprecated. ' +
        'Consider migrating to skills: https://developers.openai.com/codex/skills -->\n\n' +
        `${header}${entry.content.trimStart()}`
      );
    },
    extractIdFromFilename: extractMdId,
  },

  agents: {
    custom: true,
    distribute: distributeCodexSubagents,
  },

  skills: {
    resolveParentDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return getProjectCodexSkillsDir(root);
      return path.join(getCodexDir(), 'skills');
    },
    resolveTargetDir: (id, scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCodexSkillsDir(root), id);
      return path.join(getCodexDir(), 'skills', id);
    },
    isReservedDir: (id) => id === '.system',
  },
};

export const CODEX_SKILLS_RESERVED_DIRS = new Set(['.system']);
