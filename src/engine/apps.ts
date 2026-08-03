import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, type CustomTargetSpec, type Homes, type ResolvedConfig } from './config.js';
import {
  codexAgentConfigValue,
  codexServer,
  encodeComponentId,
  type FrontmatterTransformSpec,
  filterCodexHooks,
  geminiServer,
  importCodexAgent,
  importFrontmatterEntry,
  importGeminiCommand,
  importPlainEntry,
  type McpServerValue,
  opencodeServer,
  rawBody,
  renderClaudeAgent,
  renderClaudeCommand,
  renderCodexAgent,
  renderCodexAgentConfigTable,
  renderCodexCommand,
  renderCodexTable,
  renderCursorAgent,
  renderCursorCommand,
  renderCustomEntry,
  renderGeminiCommand,
  renderOpencodeAgent,
  renderOpencodeCommand,
  renderTraecliAgent,
  renderTraecliCommand,
  traeServer,
  transformMcpServer,
  verbatimServer,
  wrapMdcFrontmatter,
} from './dialects.js';
import type { Component, HookEventMap } from './library.js';
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
  root(homes: Homes, targetPath?: string): string;
  path(homes: Homes): string;
  /** Project destination; absent means this cell is global-only. */
  projectPath?(projectRoot: string): string;
  render(body: string, targetPath?: string): string;
  /** Whole-file target vs a host asb shares with the user. */
  dedicated: boolean;
  /**
   * The filename is this table's, so location alone proves the slice and
   * authorizes both the sweep on deselection and the sweep of the name an
   * earlier version used. A target whose path comes from configuration is the
   * user's choice and carries no such claim.
   */
  ownsName?: boolean;
}

export interface SkillsTargetRow {
  /** Directory whose resolved tree contains the skills parent; the containment root. */
  root(homes: Homes): string;
  /** Managed parent directory: each distributed skill is a child bundle of this. */
  dir(homes: Homes): string;
  /** Project managed parent; absent means this cell is global-only. */
  projectDir?(projectRoot: string): string;
  /** Child directory names that belong to the app itself, never scanned or claimed. */
  reserved: readonly string[];
  /** The predecessor exposed a library-ward importer for this app path. */
  importable?: boolean;
}

/** One component per file inside an app-owned directory. */
export interface EntryTargetRow {
  root(homes: Homes): string;
  dir(homes: Homes): string;
  /** Dormant until M7 wires project scope. */
  projectDir?(projectRoot: string): string;
  filename(id: string): string;
  /** Null is an explicit per-app eligibility skip. */
  render(component: Component): string | null;
  importer?: { extensions: readonly string[]; read(filePath: string): string };
  config?: EntryConfigTargetRow;
}

export interface EntryConfigTargetRow {
  root(homes: Homes): string;
  path(homes: Homes): string;
  format: 'toml';
  component(
    component: Component,
    filename: string
  ): { keyPath: string[]; value: Record<string, unknown>; text: string };
  activation?: { keyPath: string[]; value: unknown };
}

export interface HooksTargetRow {
  /** Directory whose resolved tree contains the config and the bundles; the containment root. */
  root(homes: Homes): string;
  /** JSON config whose `hooks` key holds the event map. */
  path(homes: Homes): string;
  /** Managed parent: each distributed bundle hook is a child directory of this. */
  bundleDir(homes: Homes): string;
  projectPath?(projectRoot: string): string;
  projectBundleDir?(projectRoot: string): string;
  /** The file exists only to carry hooks, so an emptied one is removed outright. */
  deleteWhenEmpty: boolean;
  /** The app-native subset of the library shape, when the app supports less than Claude. */
  filter?: (hooks: HookEventMap) => HookEventMap;
  /** Import the user hook map from this row's host document. */
  importable?: boolean;
  /**
   * Reported alongside a write when the app gates newly written hooks behind
   * its own review step, so a distribution that lands is not mistaken for one
   * that runs.
   */
  reviewNotice?: string;
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
  /** Project host document; absent means this cell is global-only. */
  projectPath?(projectRoot: string): string;
  format: KeysFormat;
  /** Container key holding the server map. */
  rootKey: string;
  /** Record by default; YAML targets may address array members by identity. */
  structure?: 'record' | 'keyed-array';
  keyField?: string;
  /** The app rejects names outside `[a-zA-Z0-9_-]`, so keys are rewritten. */
  sanitize: boolean;
  /** Server-value transform; `verbatimServer` writes the definition as authored. */
  dialect(server: McpServerValue): McpServerValue | null;
  /** Child-map keys whose values explain must mask after this row's dialect. */
  credentialKeys: readonly string[];
  /**
   * Set when the dialect rewrites env maps to kv-arrays: the member field
   * holding the env name. Explain keeps that field visible and masks every
   * other member field.
   */
  envKeyName?: string;
  /** TOML hosts: how one addressed table serializes. JSON writes the value. */
  render?(keyPath: readonly string[], value: McpServerValue): string;
  /** A minimal host may be materialized when the document is absent. */
  create: boolean;
}

export interface AppRow {
  id: string;
  detectDir(homes: Homes): string;
  rules?: RulesTargetRow;
  commands?: EntryTargetRow;
  agents?: EntryTargetRow;
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

const MCP_CREDENTIAL_KEYS = ['env', 'headers', 'http_headers', 'env_http_headers'] as const;

const JSON_MCP_ROW = {
  format: 'json',
  rootKey: 'mcpServers',
  dialect: verbatimServer,
  credentialKeys: MCP_CREDENTIAL_KEYS,
  create: true,
} as const;

/**
 * With `distribution.use_agents_dir`, codex/gemini/opencode/traecli read
 * skills from the shared open-agent standard directory instead of their own
 * rows; the union row distributes the union of the active members' effective
 * selections.
 */
export const AGENTS_SKILLS_UNION = {
  members: ['codex', 'gemini', 'opencode', 'traecli'] as readonly string[],
  root: (homes: Homes, projectRoot?: string): string =>
    path.join(projectRoot ?? homes.agentsHome, '.agents'),
  dir: (homes: Homes, projectRoot?: string): string =>
    path.join(projectRoot ?? homes.agentsHome, '.agents', 'skills'),
  reserved: ['.system'] as readonly string[],
  // Capture scans on this predicate (an enabled-member superset); the
  // planner additionally requires detection, so an enabled but uninstalled
  // member leaves union state untouched. With no member enabled the union
  // is dormant: records and files stay untouched until a member returns.
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
      projectPath: (root) => path.join(root, '.claude', 'CLAUDE.md'),
      render: rawBody,
      dedicated: false,
    },
    commands: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      dir: (homes) => path.join(homes.agentsHome, '.claude', 'commands'),
      projectDir: (root) => path.join(path.resolve(root), '.claude', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderClaudeCommand,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importFrontmatterEntry(filePath, 'claude-code'),
      },
    },
    agents: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      dir: (homes) => path.join(homes.agentsHome, '.claude', 'agents'),
      projectDir: (root) => path.join(path.resolve(root), '.claude', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderClaudeAgent,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importFrontmatterEntry(filePath, 'claude-code'),
      },
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      dir: (homes) => path.join(homes.agentsHome, '.claude', 'skills'),
      projectDir: (root) => path.join(root, '.claude', 'skills'),
      reserved: [],
      importable: true,
    },
    hooks: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      path: (homes) => path.join(homes.agentsHome, '.claude', 'settings.json'),
      bundleDir: (homes) => path.join(homes.agentsHome, '.claude', 'hooks', 'managed'),
      projectPath: (root) => path.join(root, '.claude', 'settings.local.json'),
      projectBundleDir: (root) => path.join(root, '.claude', 'hooks', 'managed'),
      deleteWhenEmpty: false,
      importable: true,
    },
    mcp: {
      ...JSON_MCP_ROW,
      // Claude Code reads ~/.claude.json, not a file under .claude/.
      root: (homes) => homes.agentsHome,
      path: (homes) => path.join(homes.agentsHome, '.claude.json'),
      projectPath: (root) => path.join(root, '.mcp.json'),
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
      projectPath: (root) => path.join(root, 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
    commands: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      dir: (homes) => path.join(homes.agentsHome, '.codex', 'prompts'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderCodexCommand,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importPlainEntry(filePath, 'codex'),
      },
    },
    agents: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      dir: (homes) => path.join(homes.agentsHome, '.codex', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.toml`,
      render: renderCodexAgent,
      importer: { extensions: ['.toml'], read: importCodexAgent },
      config: {
        root: (homes) => path.join(homes.agentsHome, '.codex'),
        path: (homes) => path.join(homes.agentsHome, '.codex', 'config.toml'),
        format: 'toml',
        component: (component, filename) => {
          const keyPath = ['agents', component.id];
          const value = codexAgentConfigValue(component, filename);
          return { keyPath, value, text: renderCodexAgentConfigTable(keyPath, value) };
        },
        activation: { keyPath: ['features', 'multi_agent'], value: true },
      },
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      dir: (homes) => path.join(homes.agentsHome, '.codex', 'skills'),
      projectDir: (root) => path.join(root, '.agents', 'skills'),
      reserved: ['.system'],
      importable: true,
    },
    hooks: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      path: (homes) => path.join(homes.agentsHome, '.codex', 'hooks.json'),
      bundleDir: (homes) => path.join(homes.agentsHome, '.codex', 'hooks', 'managed'),
      projectPath: (root) => path.join(root, '.codex', 'hooks.json'),
      projectBundleDir: (root) => path.join(root, '.codex', 'hooks', 'managed'),
      deleteWhenEmpty: true,
      filter: filterCodexHooks,
      // Codex records trust against each hook's current hash and skips new or
      // changed non-managed hooks until they are reviewed. Interactive Codex
      // warns at startup; `codex exec` just runs without them.
      reviewNotice:
        'Codex skips new or changed hooks until they are trusted: run /hooks in Codex to review them, or headless codex exec runs without them',
    },
    mcp: {
      root: (homes) => path.join(homes.agentsHome, '.codex'),
      path: (homes) => path.join(homes.agentsHome, '.codex', 'config.toml'),
      projectPath: (root) => path.join(root, '.codex', 'config.toml'),
      format: 'toml',
      rootKey: 'mcp_servers',
      sanitize: true,
      dialect: codexServer,
      credentialKeys: MCP_CREDENTIAL_KEYS,
      render: renderCodexTable,
      create: true,
    },
    native: {
      bin: 'codex',
      target: 'codex',
      settings: (homes) => path.join(homes.agentsHome, '.codex', 'config.toml'),
    },
  },
  {
    id: 'gemini',
    detectDir: (homes) => path.join(homes.agentsHome, '.gemini'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      path: (homes) => path.join(homes.agentsHome, '.gemini', 'AGENTS.md'),
      projectPath: (root) => path.join(root, 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
    commands: {
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      dir: (homes) => path.join(homes.agentsHome, '.gemini', 'commands'),
      projectDir: (root) => path.join(path.resolve(root), '.gemini', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.toml`,
      render: renderGeminiCommand,
      importer: { extensions: ['.toml'], read: importGeminiCommand },
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      dir: (homes) => path.join(homes.agentsHome, '.gemini', 'skills'),
      projectDir: (root) => path.join(root, '.gemini', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => path.join(homes.agentsHome, '.gemini'),
      // settings.json carries every other Gemini CLI setting; only the
      // addressed slice is ever rewritten.
      path: (homes) => path.join(homes.agentsHome, '.gemini', 'settings.json'),
      projectPath: (root) => path.join(root, '.gemini', 'settings.json'),
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
      projectPath: (root) => path.join(root, 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
    commands: {
      root: (homes) => opencodeRoot(homes.agentsHome),
      dir: (homes) => path.join(opencodeRoot(homes.agentsHome), 'commands'),
      projectDir: (root) => path.join(path.resolve(root), '.opencode', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderOpencodeCommand,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importFrontmatterEntry(filePath, 'opencode'),
      },
    },
    agents: {
      root: (homes) => opencodeRoot(homes.agentsHome),
      dir: (homes) => path.join(opencodeRoot(homes.agentsHome), 'agents'),
      projectDir: (root) => path.join(path.resolve(root), '.opencode', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderOpencodeAgent,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importFrontmatterEntry(filePath, 'opencode'),
      },
    },
    skills: {
      root: (homes) => opencodeRoot(homes.agentsHome),
      dir: (homes) => path.join(opencodeRoot(homes.agentsHome), 'skills'),
      projectDir: (root) => path.join(root, '.opencode', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => opencodeRoot(homes.agentsHome),
      path: (homes) => opencodeConfigPath(opencodeRoot(homes.agentsHome)),
      projectPath: (root) => opencodeConfigPath(path.join(root, '.opencode')),
      rootKey: 'mcp',
      sanitize: false,
      dialect: opencodeServer,
      credentialKeys: [...MCP_CREDENTIAL_KEYS, 'environment'],
    },
  },
  {
    id: 'cursor',
    detectDir: (homes) => path.join(homes.agentsHome, '.cursor'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      path: (homes) => path.join(homes.agentsHome, '.cursor', 'rules', 'rules.mdc'),
      projectPath: (root) => path.join(root, '.cursor', 'rules', 'rules.mdc'),
      render: wrapMdcFrontmatter,
      dedicated: true,
      ownsName: true,
    },
    commands: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      dir: (homes) => path.join(homes.agentsHome, '.cursor', 'commands'),
      projectDir: (root) => path.join(path.resolve(root), '.cursor', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderCursorCommand,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importPlainEntry(filePath, 'cursor'),
      },
    },
    agents: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      dir: (homes) => path.join(homes.agentsHome, '.cursor', 'agents'),
      projectDir: (root) => path.join(path.resolve(root), '.cursor', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderCursorAgent,
      importer: {
        extensions: ['.md', '.markdown'],
        read: (filePath) => importFrontmatterEntry(filePath, 'cursor'),
      },
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      dir: (homes) => path.join(homes.agentsHome, '.cursor', 'skills'),
      projectDir: (root) => path.join(root, '.cursor', 'skills'),
      reserved: [],
      importable: true,
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      path: (homes) => path.join(homes.agentsHome, '.cursor', 'mcp.json'),
      projectPath: (root) => path.join(root, '.cursor', 'mcp.json'),
      sanitize: true,
    },
  },
  {
    id: 'trae',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Trae'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      path: (homes) => path.join(homes.agentsHome, '.trae', 'user_rules', 'rules.md'),
      projectPath: (root) => path.join(root, '.trae', 'rules', 'rules.md'),
      render: wrapMdcFrontmatter,
      dedicated: true,
      ownsName: true,
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      dir: (homes) => path.join(homes.agentsHome, '.trae', 'skills'),
      projectDir: (root) => path.join(root, '.trae', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      // The MCP host lives in the vendor data dir, not the ~/.trae dotdir
      // the rules row writes.
      root: (homes) => vendorDataDir(homes.agentsHome, 'Trae'),
      path: (homes) => path.join(vendorDataDir(homes.agentsHome, 'Trae'), 'User', 'mcp.json'),
      projectPath: (root) => path.join(root, '.trae', 'mcp.json'),
      sanitize: true,
      dialect: traeServer,
    },
  },
  {
    id: 'trae-cn',
    detectDir: (homes) => vendorDataDir(homes.agentsHome, 'Trae CN'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.trae-cn'),
      path: (homes) => path.join(homes.agentsHome, '.trae-cn', 'user_rules', 'rules.md'),
      projectPath: (root) => path.join(root, '.trae', 'rules', 'rules.md'),
      render: wrapMdcFrontmatter,
      dedicated: true,
      ownsName: true,
    },
    skills: {
      root: (homes) => path.join(homes.agentsHome, '.trae-cn'),
      dir: (homes) => path.join(homes.agentsHome, '.trae-cn', 'skills'),
      projectDir: (root) => path.join(root, '.trae', 'skills'),
      reserved: [],
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => vendorDataDir(homes.agentsHome, 'Trae CN'),
      path: (homes) => path.join(vendorDataDir(homes.agentsHome, 'Trae CN'), 'User', 'mcp.json'),
      projectPath: (root) => path.join(root, '.trae', 'mcp.json'),
      sanitize: true,
      dialect: traeServer,
    },
  },
  {
    // TRAE CLI 2.0: a codex fork sharing ~/.trae with the Trae IDE rows.
    // ~/.trae/skills stays owned by the trae row, so no skills cell here.
    id: 'traecli',
    detectDir: (homes) => path.join(homes.agentsHome, '.trae', 'cli'),
    rules: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      path: (homes) => path.join(homes.agentsHome, '.trae', 'AGENTS.md'),
      projectPath: (root) => path.join(root, 'AGENTS.md'),
      render: rawBody,
      dedicated: false,
    },
    commands: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      dir: (homes) => path.join(homes.agentsHome, '.trae', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderTraecliCommand,
    },
    agents: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      dir: (homes) => path.join(homes.agentsHome, '.trae', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      // traecli's own migration imports ~/.claude/agents verbatim, so the
      // agent document shape is Claude's; the extras namespace is its own.
      render: renderTraecliAgent,
    },
    mcp: {
      root: (homes) => path.join(homes.agentsHome, '.trae'),
      path: (homes) => path.join(homes.agentsHome, '.trae', 'traecli.toml'),
      format: 'toml',
      rootKey: 'mcp_servers',
      sanitize: true,
      dialect: codexServer,
      credentialKeys: MCP_CREDENTIAL_KEYS,
      render: renderCodexTable,
      create: true,
    },
  },
];

export function appRow(id: string): AppRow | undefined {
  return APP_ROWS.find((row) => row.id === id);
}

function customPath(value: string, homes: Homes): string {
  if (value === '~') return homes.agentsHome;
  if (value.startsWith('~/')) return path.join(homes.agentsHome, value.slice(2));
  return path.resolve(value);
}

function customEntryRow(
  id: string,
  spec: NonNullable<CustomTargetSpec['commands']>
): EntryTargetRow {
  const pattern = spec.filename_pattern ?? '{id}.md';
  const platform = spec.platform_key ?? id;
  return {
    root: (homes) => customPath(spec.target_dir, homes),
    dir: (homes) => customPath(spec.target_dir, homes),
    ...(spec.project_target_dir
      ? { projectDir: (root: string) => path.resolve(root, spec.project_target_dir as string) }
      : {}),
    filename: (componentId) => pattern.replace('{id}', encodeComponentId(componentId)),
    render: (component) =>
      renderCustomEntry(
        component,
        platform,
        spec.frontmatter as FrontmatterTransformSpec | undefined
      ),
  };
}

function compileCustomRow(id: string, spec: CustomTargetSpec): AppRow {
  const detect = spec.detect ?? (spec.mcp ? path.dirname(spec.mcp.config_path) : null);
  const row: AppRow = {
    id,
    detectDir: (homes) => (detect ? customPath(detect, homes) : homes.agentsHome),
  };
  if (spec.rules) {
    const rules = spec.rules;
    row.rules = {
      root: (homes) => path.dirname(customPath(rules.file_path, homes)),
      path: (homes) => customPath(rules.file_path, homes),
      ...(rules.project_file_path
        ? {
            projectPath: (root: string) => path.resolve(root, rules.project_file_path as string),
          }
        : {}),
      render: rules.format === 'mdc' ? wrapMdcFrontmatter : rawBody,
      dedicated: true,
    };
  }
  if (spec.commands) row.commands = customEntryRow(id, spec.commands);
  if (spec.agents) row.agents = customEntryRow(id, spec.agents);
  if (spec.skills) {
    const skills = spec.skills;
    row.skills = {
      root: (homes) => customPath(skills.parent_dir, homes),
      dir: (homes) => customPath(skills.parent_dir, homes),
      ...(skills.project_parent_dir
        ? {
            projectDir: (root: string) => path.resolve(root, skills.project_parent_dir as string),
          }
        : {}),
      reserved: [],
    };
  }
  if (spec.mcp) {
    const mcp = spec.mcp;
    const envTransform = mcp.env_transform
      ? { keyName: mcp.env_transform.key_name, valueName: mcp.env_transform.value_name }
      : undefined;
    row.mcp = {
      root: (homes) => path.dirname(customPath(mcp.config_path, homes)),
      path: (homes) => customPath(mcp.config_path, homes),
      ...(mcp.project_config_path
        ? {
            projectPath: (root: string) => path.resolve(root, mcp.project_config_path as string),
          }
        : {}),
      format: mcp.format,
      rootKey: mcp.root_key ?? 'mcpServers',
      structure: mcp.structure ?? 'record',
      keyField: mcp.key_field ?? 'name',
      sanitize: false,
      dialect: (server) =>
        transformMcpServer(server, {
          ...(envTransform ? { envTransform } : {}),
          ...(mcp.defaults ? { defaults: mcp.defaults } : {}),
        }),
      credentialKeys: MCP_CREDENTIAL_KEYS,
      ...(envTransform ? { envKeyName: envTransform.keyName ?? 'key' } : {}),
      create: true,
    };
  }
  return row;
}

/** Builtins plus strict config-defined rows; a custom row never overrides data. */
export function appRows(config: Pick<ResolvedConfig, 'targets'>): readonly AppRow[] {
  const builtin = new Set(APP_ROWS.map((row) => row.id));
  const custom: AppRow[] = [];
  for (const [id, spec] of Object.entries(config.targets)) {
    if (builtin.has(id)) {
      throw new ConfigError(
        `Invalid configuration: target id "${id}" collides with builtin "${id}"; choose another id.`
      );
    }
    custom.push(compileCustomRow(id, spec));
  }
  return [...APP_ROWS, ...custom];
}

/**
 * Project scope is the same data table with unsupported cells removed and
 * explicit project columns fixed to one canonical root. No global path is a
 * fallback, and native managers are global-only.
 */
export function projectAppRows(table: readonly AppRow[], projectRoot: string): readonly AppRow[] {
  const root = path.resolve(projectRoot);
  return table.map((row) => {
    const project: AppRow = { id: row.id, detectDir: row.detectDir };
    if (row.rules?.projectPath) {
      const rules = row.rules;
      project.rules = {
        ...rules,
        root: () => root,
        path: () => rules.projectPath?.(root) as string,
      };
    }
    for (const type of ['commands', 'agents'] as const) {
      const entry = row[type];
      if (!entry?.projectDir) continue;
      project[type] = {
        ...entry,
        root: () => root,
        dir: () => entry.projectDir?.(root) as string,
        config: undefined,
      };
    }
    if (row.skills?.projectDir) {
      const skills = row.skills;
      project.skills = {
        ...skills,
        root: () => root,
        dir: () => skills.projectDir?.(root) as string,
      };
    }
    if (row.hooks?.projectPath && row.hooks.projectBundleDir) {
      const hooks = row.hooks;
      project.hooks = {
        ...hooks,
        root: () => root,
        path: () => hooks.projectPath?.(root) as string,
        bundleDir: () => hooks.projectBundleDir?.(root) as string,
      };
    }
    if (row.mcp?.projectPath) {
      const mcp = row.mcp;
      project.mcp = {
        ...mcp,
        root: () => root,
        path: () => mcp.projectPath?.(root) as string,
      };
    }
    return project;
  });
}
