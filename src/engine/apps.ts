import os from 'node:os';
import path from 'node:path';
import type { Homes } from './config.js';
import { rawBody, wrapMdcFrontmatter } from './dialects.js';

/**
 * The app × type table. Variation that fits a column is a column: detect
 * probe, per-type target rows (shape, path, create, render, containment
 * root), reserved names. Paths and formats are frozen 0.4.35 values.
 */

function opencodeRoot(agentsHome: string): string {
  return process.platform === 'win32'
    ? path.join(agentsHome, 'AppData', 'Roaming', 'opencode')
    : path.join(agentsHome, '.config', 'opencode');
}

function vendorDataDir(agentsHome: string, appName: string): string {
  switch (os.platform()) {
    case 'darwin':
      return path.join(agentsHome, 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(agentsHome, 'AppData', 'Roaming', appName);
    default:
      return path.join(agentsHome, '.config', appName);
  }
}

export interface RulesTargetRow {
  /** Directory whose resolved tree contains the target; the containment root. */
  root(homes: Homes): string;
  path(homes: Homes): string;
  render(body: string): string;
  /** Dedicated asb-named file (full ownership by name) vs shared host. */
  dedicated: boolean;
}

export interface AppRow {
  id: string;
  detectDir(homes: Homes): string;
  rules?: RulesTargetRow;
}

export const APP_ROWS: readonly AppRow[] = [
  {
    id: 'claude-code',
    detectDir: (homes) => path.join(homes.agentsHome, '.claude'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      path: (homes) => path.join(homes.agentsHome, '.claude', 'CLAUDE.md'),
      render: rawBody,
      dedicated: false,
    },
  },
  {
    id: 'claude-desktop',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Claude'),
  },
  {
    id: 'codex',
    detectDir: (homes) => path.join(homes.agentsHome, '.codex'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      path: (homes) => path.join(homes.agentsHome, '.codex', 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
  },
  {
    id: 'gemini',
    detectDir: (homes) => path.join(homes.agentsHome, '.gemini'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      path: (homes) => path.join(homes.agentsHome, '.gemini', 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
  },
  {
    id: 'opencode',
    detectDir: (homes) => opencodeRoot(homes.agentsHome),
    rules: {
      root: (homes) => opencodeRoot(homes.agentsHome),
      path: (homes) => path.join(opencodeRoot(homes.agentsHome), 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
  },
  {
    id: 'cursor',
    detectDir: (homes) => path.join(homes.agentsHome, '.cursor'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      path: (homes) => path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc'),
      render: wrapMdcFrontmatter,
      dedicated: true,
    },
  },
  {
    id: 'trae',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Trae'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      path: (homes) => path.join(homes.agentsHome, '.trae', 'user_rules', 'asb-rules.md'),
      render: wrapMdcFrontmatter,
      dedicated: true,
    },
  },
  {
    id: 'trae-cn',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Trae CN'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.trae-cn'),
      path: (homes) => path.join(homes.agentsHome, '.trae-cn', 'user_rules', 'asb-rules.md'),
      render: wrapMdcFrontmatter,
      dedicated: true,
    },
  },
];

export function appRow(id: string): AppRow | undefined {
  return APP_ROWS.find((row) => row.id === id);
}
