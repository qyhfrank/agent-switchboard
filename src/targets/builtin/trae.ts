import fs from 'node:fs';
import path from 'node:path';
import { TraeAgent } from '../../agents/trae.js';
import {
  getProjectTraeDir,
  getTraeDataDir,
  getTraeUserDataDir,
  type TraeVariant,
} from '../../config/paths.js';
import type { McpServer } from '../../config/schemas.js';
import type { ApplicationTarget } from '../types.js';
import { resolveProjectRoot, wrapMdcFrontmatter } from './common.js';

/**
 * Trae infers transport from `url` (HTTP/SSE) vs `command` (stdio) and does
 * not recognize the explicit `type` field. Strip it to avoid unknown-key
 * warnings or parse errors in the IDE.
 */
function stripMcpType(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): {
  mcpServers: Record<string, Omit<McpServer, 'enabled'>>;
} {
  const servers: Record<string, Omit<McpServer, 'enabled'>> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    servers[name] = { ...(server as Record<string, unknown>), type: undefined } as Omit<
      McpServer,
      'enabled'
    >;
  }
  return { mcpServers: servers };
}

function createTraeTarget(variant: TraeVariant): ApplicationTarget {
  const adapter = new TraeAgent(variant);

  return {
    id: variant,
    isInstalled: () => fs.existsSync(getTraeUserDataDir(variant)),

    mcp: {
      configPath: () => adapter.configPath(),
      projectConfigPath: (root) => adapter.projectConfigPath(root),
      applyConfig: (config) => adapter.applyConfig(stripMcpType(config)),
      applyProjectConfig: (root, config) => adapter.applyProjectConfig(root, stripMcpType(config)),
    },

    rules: {
      resolveFilePath: (scope) => {
        const root = resolveProjectRoot(scope);
        if (root) return path.join(getProjectTraeDir(root), 'rules', 'asb-rules.md');
        return path.join(getTraeDataDir(variant), 'user_rules', 'asb-rules.md');
      },
      render: wrapMdcFrontmatter,
    },

    skills: {
      resolveParentDir: (scope) => {
        const root = resolveProjectRoot(scope);
        if (root) return path.join(getProjectTraeDir(root), 'skills');
        return path.join(getTraeDataDir(variant), 'skills');
      },
      resolveTargetDir: (id, scope) => {
        const root = resolveProjectRoot(scope);
        if (root) return path.join(getProjectTraeDir(root), 'skills', id);
        return path.join(getTraeDataDir(variant), 'skills', id);
      },
    },
  };
}

export const traeTarget = createTraeTarget('trae');
export const traeCnTarget = createTraeTarget('trae-cn');
