import fs from 'node:fs';
import path from 'node:path';
import { CursorAgent } from '../../agents/cursor.js';
import { sanitizeMcpName } from '../../agents/json-utils.js';
import { getCursorDir, getProjectCursorDir } from '../../config/paths.js';
import { wrapFrontmatter } from '../../util/frontmatter.js';
import type { ApplicationTarget, GenericLibraryEntry } from '../types.js';
import { extractMdId, resolveProjectRoot, wrapMdcFrontmatter } from './common.js';

const adapter = new CursorAgent();

const CURSOR_SUBAGENT_FIELDS = new Set([
  'name',
  'description',
  'model',
  'readonly',
  'is_background',
]);

function buildCursorSubagentFrontmatter(entry: GenericLibraryEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (entry.metadata.description) base.description = entry.metadata.description;
  base.name = entry.id;
  const extras = entry.metadata.extras;
  const cursor = extras?.cursor;
  if (cursor && typeof cursor === 'object') {
    for (const [k, v] of Object.entries(cursor as Record<string, unknown>)) {
      if (CURSOR_SUBAGENT_FIELDS.has(k)) base[k] = v;
    }
  }
  if (!base.name) base.name = entry.id;
  if (!base.model) base.model = 'inherit';
  return base;
}

export const cursorTarget: ApplicationTarget = {
  id: 'cursor',
  isInstalled: () => fs.existsSync(getCursorDir()),

  mcp: {
    configPath: () => adapter.configPath(),
    projectConfigPath: (root) => adapter.projectConfigPath?.(root),
    applyConfig: (config) => adapter.applyConfig(config),
    applyProjectConfig: (root, config, options) =>
      adapter.applyProjectConfig?.(root, config, options),
    sanitizeServerName: sanitizeMcpName,
  },

  rules: {
    resolveFilePath: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCursorDir(root), 'rules', 'asb-rules.mdc');
      return path.join(getCursorDir(), 'rules', 'asb-rules.mdc');
    },
    render: wrapMdcFrontmatter,
  },

  commands: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCursorDir(root), 'commands');
      return path.join(getCursorDir(), 'commands');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => `${entry.content.trimEnd()}\n`,
    extractIdFromFilename: extractMdId,
  },

  agents: {
    resolveTargetDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCursorDir(root), 'agents');
      return path.join(getCursorDir(), 'agents');
    },
    getFilename: (id) => `${id}.md`,
    render: (entry) => {
      const fm = buildCursorSubagentFrontmatter(entry);
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  },

  skills: {
    resolveParentDir: (scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCursorDir(root), 'skills');
      return path.join(getCursorDir(), 'skills');
    },
    resolveTargetDir: (id, scope) => {
      const root = resolveProjectRoot(scope);
      if (root) return path.join(getProjectCursorDir(root), 'skills', id);
      return path.join(getCursorDir(), 'skills', id);
    },
  },
};
