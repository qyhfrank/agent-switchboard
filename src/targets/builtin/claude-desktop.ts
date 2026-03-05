import { ClaudeDesktopAgent } from '../../agents/claude-desktop.js';
import type { ApplicationTarget } from '../types.js';

const adapter = new ClaudeDesktopAgent();

export const claudeDesktopTarget: ApplicationTarget = {
  id: 'claude-desktop',

  mcp: {
    configPath: () => adapter.configPath(),
    applyConfig: (config) => adapter.applyConfig(config),
  },
};
