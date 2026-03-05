import path from 'node:path';
import { OpencodeAgent } from '../../agents/opencode.js';
import {
  getOpencodePath,
  getOpencodeRoot,
  getProjectOpencodePath,
  getProjectOpencodeRoot,
} from '../../config/paths.js';
import { wrapFrontmatter } from '../../util/frontmatter.js';
import type { ApplicationTarget } from '../types.js';
import { buildPlatformFrontmatter, extractMdId, resolveProjectRoot } from './common.js';

const adapter = new OpencodeAgent();

export const opencodeTarget: ApplicationTarget = {
  id: 'opencode',

  mcp: {
    configPath: () => adapter.configPath(),
    projectConfigPath: (root) => adapter.projectConfigPath!(root),
    applyConfig: (config) => adapter.applyConfig(config),
    applyProjectConfig: (root, config) => adapter.applyProjectConfig!(root, config),
  },

  rules: {
    resolveFilePath: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(root, 'AGENTS.md');
      return getOpencodePath('AGENTS.md');
    },
    render: (content) => content,
  },

  commands: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return getProjectOpencodePath(root, 'command');
      return getOpencodePath('command');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const fm = buildPlatformFrontmatter(entry, 'opencode');
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  },

  agents: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return getProjectOpencodePath(root, 'agent');
      return getOpencodePath('agent');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const fm = buildPlatformFrontmatter(entry, 'opencode');
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  },

  skills: {
    resolveParentDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectOpencodeRoot(root), 'skill');
      return path.join(getOpencodeRoot(), 'skill');
    },
    resolveTargetDir: (id, scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectOpencodeRoot(root), 'skill', id);
      return path.join(getOpencodeRoot(), 'skill', id);
    },
  },
};
