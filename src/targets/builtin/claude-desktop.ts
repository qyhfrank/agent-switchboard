import fs from 'node:fs';
import path from 'node:path';
import { ClaudeDesktopAgent } from '../../agents/claude-desktop.js';
import { getClaudeDesktopConfigPath } from '../../config/paths.js';
import type { ApplicationTarget } from '../types.js';

const adapter = new ClaudeDesktopAgent();

export const claudeDesktopTarget: ApplicationTarget = {
  id: 'claude-desktop',
  isInstalled: () => fs.existsSync(path.dirname(getClaudeDesktopConfigPath())),

  mcp: {
    configPath: () => adapter.configPath(),
    applyConfig: (config) => adapter.applyConfig(config),
  },
};
