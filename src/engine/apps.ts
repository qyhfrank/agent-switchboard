import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Homes } from './config.js';
import {
  codexServer,
  filterCodexHooks,
  geminiServer,
  type McpServerValue,
  opencodeServer,
  rawBody,
  renderCodexTable,
  traeServer,
  verbatimServer,
  wrapMdcFrontmatter,
} from './dialects.js';
import type { HookEventMap } from './library.js';
import type { KeysFormat } from './shapes.js';
import type { NativeTarget } from './sources.js';

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

export interface SkillsTargetRow {
  /** Directory whose resolved tree contains the skills parent; the containment root. */
  root(homes: Homes): string;
  /** Managed parent directory: each distributed skill is a child bundle of this. */
  dir(homes: Homes): string;
  /** Child directory names that belong to the app itself, never scanned or claimed. */
  reserved: readonly string[];
}

export interface HooksTargetRow {
  /** Directory whose resolved tree contains the config and the bundles; the containment root. */
  root(homes: Homes): string;
  /** JSON config whose `hooks` key holds the event map. */
  path(homes: Homes): string;
  /** Managed parent: each distributed bundle hook is a child directory of this. */
  bundleDir(homes: Homes): string;
  /** The file exists only to carry hooks, so an emptied one is removed outright. */
  deleteWhenEmpty: boolean;
  /** The app-native subset of the library shape, when the app supports less than Claude. */
  filter?: (hooks: HookEventMap) => HookEventMap;
  /** Peer state target name: `<ASB_HOME>/state/hooks/<target>.json`. */
  stateTarget: 'claude-code' | 'codex';
}

/**
 * Apps that ship their own plugin manager. There is no file to own: the
 * manager's reported state stands in for ownership, and asb speaks to it
 * through its own CLI.
 */
export interface NativeManagerRow {
  /** Manager CLI, found on the run's PATH. */
  bin: string;
  /** Marketplace manifest family this manager reads. */
  target: NativeTarget;
  /** Document carrying the portable-marketplace declaration. */
  settings(homes: Homes): string;
}

/**
 * An MCP server map inside a document the app and the user also own. Every
 * per-app difference that is data lives here; only the four real value
 * transforms are functions.
 */
export interface McpTargetRow {
  /** Directory whose resolved tree contains the host document. */
  root(homes: Homes): string;
  /**
   * Host document. Resolved once per run during capture — opencode's probe
   * reads the disk, so the planner takes the path from the capture.
   */
  path(homes: Homes): string;
  format: KeysFormat;
  /** Container key holding the server map. */
  rootKey: string;
  /** The app rejects names outside `[a-zA-Z0-9_-]`, so keys are rewritten. */
  sanitize: boolean;
  /** Server-value transform; `verbatimServer` writes the definition as authored. */
  dialect(server: McpServerValue): McpServerValue | null;
  /** TOML hosts: how one addressed table serializes. JSON writes the value. */
  render?(keyPath: readonly string[], value: McpServerValue): string;
  /** A minimal host may be materialized when the document is absent. */
  create: boolean;
}

export interface AppRow {
  id: string;
  detectDir(homes: Homes): string;
  rules?: RulesTargetRow;
  skills?: SkillsTargetRow;
  hooks?: HooksTargetRow;
  mcp?: McpTargetRow;
  native?: NativeManagerRow;
}

/** Frozen 0.4.35 probe: a commented opencode.jsonc wins over opencode.json. */
function opencodeConfigPath(root: string): string {
  const jsonc = path.join(root, 'opencode.jsonc');
  return fs.existsSync(jsonc) ? jsonc : path.join(root, 'opencode.json');
}

const JSON_MCP_ROW = {
  format: 'json',
  rootKey: 'mcpServers',
  dialect: verbatimServer,
  create: true,
} as const;

/**
 * With `distribution.use_agents_dir`, codex/gemini/opencode read skills from
 * the shared open-agent standard directory instead of their own rows; the
 * union row distributes the union of the active members' effective selections.
 */
export const AGENTS_SKILLS_UNION = {
  members: ['codex', 'gemini', 'opencode'] as readonly string[],
  root: (homes: Homes): string => path.join(homes.agentsHome, '.agents'),
  dir: (homes: Homes): string => path.join(homes.agentsHome, '.agents', 'skills'),
  reserved: ['.system'] as readonly string[],
  // Capture and planner must agree on this predicate: a row the planner
  // builds over an uncaptured directory reads as absent and mis-reports
  // removal. With every member disabled the union is dormant — records and
  // files stay untouched until a member returns.
  participates: (enabled: readonly string[]): boolean =>
    AGENTS_SKILLS_UNION.members.some((member) => enabled.includes(member)),
};

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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      dir: (homes) => path.join(homes.agentsHome, '.claude', 'skills'),
      reserved: [],
    },
    hooks: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      path: (homes) => path.join(homes.agentsHome, '.claude', 'settings.json'),
      bundleDir: (homes) => path.join(homes.agentsHome, '.claude', 'hooks', 'managed'),
      deleteWhenEmpty: false,
      stateTarget: 'claude-code',
    },
    mcp: {
      ...JSON_MCP_ROW,
      // Claude Code reads ~/.claude.json, not a file under .claude/.
      root: (homes) => homes.agentsHome,
      path: (homes) => path.join(homes.agentsHome, '.claude.json'),
      // Claude Code accepts colons and dots in server names.
      sanitize: false,
    },
    native: {
      bin: 'claude',
      target: 'claude-code',
      settings: (homes) => path.join(homes.agentsHome, '.claude', 'settings.json'),
    },
  },
  {
    // MCP is the only type Claude Desktop takes, and only at global scope.
    id: 'claude-desktop',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Claude'),
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => vendorDataDir(homes.agentsHome, 'Claude'),
      path: (homes) =>
        path.join(vendorDataDir(homes.agentsHome, 'Claude'), 'claude_desktop_config.json'),
      sanitize: false,
    },
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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      dir: (homes) => path.join(homes.agentsHome, '.codex', 'skills'),
      reserved: ['.system'],
    },
    hooks: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      path: (homes) => path.join(homes.agentsHome, '.codex', 'hooks.json'),
      bundleDir: (homes) => path.join(homes.agentsHome, '.codex', 'hooks', 'managed'),
      deleteWhenEmpty: true,
      filter: filterCodexHooks,
      stateTarget: 'codex',
    },
    mcp: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      path: (homes) => path.join(homes.agentsHome, '.codex', 'config.toml'),
      format: 'toml',
      rootKey: 'mcp_servers',
      sanitize: true,
      dialect: codexServer,
      render: renderCodexTable,
      create: true,
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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      dir: (homes) => path.join(homes.agentsHome, '.gemini', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      // settings.json carries every other Gemini CLI setting; only the
      // addressed slice is ever rewritten.
      path: (homes) => path.join(homes.agentsHome, '.gemini', 'settings.json'),
      sanitize: false,
      dialect: geminiServer,
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
    skills: {
      root: (homes) => opencodeRoot(homes.agentsHome),
      dir: (homes) => path.join(opencodeRoot(homes.agentsHome), 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => opencodeRoot(homes.agentsHome),
      path: (homes) => opencodeConfigPath(opencodeRoot(homes.agentsHome)),
      rootKey: 'mcp',
      sanitize: false,
      dialect: opencodeServer,
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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      dir: (homes) => path.join(homes.agentsHome, '.cursor', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      path: (homes) => path.join(homes.agentsHome, '.cursor', 'mcp.json'),
      sanitize: true,
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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      dir: (homes) => path.join(homes.agentsHome, '.trae', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      // The MCP host lives in the vendor data dir, not the ~/.trae dotdir
      // the rules row writes.
      root: (homes) => vendorDataDir(homes.agentsHome, 'Trae'),
      path: (homes) => path.join(vendorDataDir(homes.agentsHome, 'Trae'), 'User', 'mcp.json'),
      sanitize: true,
      dialect: traeServer,
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
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.trae-cn'),
      dir: (homes) => path.join(homes.agentsHome, '.trae-cn', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => vendorDataDir(homes.agentsHome, 'Trae CN'),
      path: (homes) => path.join(vendorDataDir(homes.agentsHome, 'Trae CN'), 'User', 'mcp.json'),
      sanitize: true,
      dialect: traeServer,
    },
  },
];

export function appRow(id: string): AppRow | undefined {
  return APP_ROWS.find((row) => row.id === id);
}
