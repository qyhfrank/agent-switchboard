import fs from 'node:fs';
import path from 'node:path';
import { ClaudeCodeAgent } from '../../agents/claude-code.js';
import { getClaudeDir, getProjectClaudeDir } from '../../config/paths.js';
import { wrapFrontmatter } from '../../util/frontmatter.js';
import type { ApplicationTarget } from '../types.js';
import { buildPlatformFrontmatter, extractMdId, resolveProjectRoot } from './common.js';

const adapter = new ClaudeCodeAgent();

/** Top-level frontmatter fields forwarded for agent entries (extras override). */
const AGENT_PASSTHROUGH: ReadonlySet<string> = new Set(['model']);

export const claudeCodeTarget: ApplicationTarget = {
  id: 'claude-code',
  isInstalled: () => fs.existsSync(getClaudeDir()),

  mcp: {
    configPath: () => adapter.configPath(),
    projectConfigPath: (root) => adapter.projectConfigPath(root),
    applyConfig: (config) => adapter.applyConfig(config),
    applyProjectConfig: (root, config, options) =>
      adapter.applyProjectConfig(root, config, options),
    // No sanitizeServerName: Claude Code's .mcp.json natively supports
    // server names with special characters (colons, dots, etc.)
  },

  rules: {
    resolveFilePath: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(root, '.claude', 'CLAUDE.md');
      return path.join(getClaudeDir(), 'CLAUDE.md');
    },
    render: (content) => content,
  },

  commands: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectClaudeDir(root), 'commands');
      return path.join(getClaudeDir(), 'commands');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const fm = buildPlatformFrontmatter(entry, 'claude-code');
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  },

  agents: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectClaudeDir(root), 'agents');
      return path.join(getClaudeDir(), 'agents');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const fm = buildPlatformFrontmatter(entry, 'claude-code', AGENT_PASSTHROUGH);
      if (typeof fm.name !== 'string' || fm.name.trim().length === 0) {
        fm.name = entry.id;
      }
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  },

  skills: {
    resolveParentDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectClaudeDir(root), 'skills');
      return path.join(getClaudeDir(), 'skills');
    },
    resolveTargetDir: (id, scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectClaudeDir(root), 'skills', id);
      return path.join(getClaudeDir(), 'skills', id);
    },
  },

  hooks: {
    distribute: () => ({ results: [] }),
  },
};
