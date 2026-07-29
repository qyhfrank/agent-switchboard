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
  renderCocoAgent,
  renderCocoCommand,
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

function cocoConfigDir(homes: Homes): string {
  return os.platform() === 'darwin'
    ? path.join(homes.agentsHome, 'Library', 'Application Support', 'coco')
    : path.join(homes.configHome ?? path.join(homes.agentsHome, '.config'), 'coco');
}

function cocoDataDir(homes: Homes): string {
  return path.join(homes.agentsHome, '.coco');
}

export interface RulesTargetRow {
  /** Directory whose resolved tree contains the target; the containment root. */
  root(homes: Homes, targetPath?: string): string;
  path(homes: Homes): string;
  render(body: string, targetPath?: string): string;
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
  /** The file exists only to carry hooks, so an emptied one is removed outright. */
  deleteWhenEmpty: boolean;
  /** The app-native subset of the library shape, when the app supports less than Claude. */
  filter?: (hooks: HookEventMap) => HookEventMap;
  /** Peer state target name: `<ASB_HOME>/state/hooks/<target>.json`. */
  stateTarget: 'claude-code' | 'codex';
  /** Import the user hook map from this row's host document. */
  importable?: boolean;
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
  /** Record by default; YAML targets may address array members by identity. */
  structure?: 'record' | 'keyed-array';
  keyField?: string;
  /** The app rejects names outside `[a-zA-Z0-9_-]`, so keys are rewritten. */
  sanitize: boolean;
  /** Server-value transform; `verbatimServer` writes the definition as authored. */
  dialect(server: McpServerValue): McpServerValue | null;
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
      reserved: [],
      importable: true,
    },
    hooks: {
      root: (homes) => path.join(homes.agentsHome, '.claude'),
      path: (homes) => path.join(homes.agentsHome, '.claude', 'settings.json'),
      bundleDir: (homes) => path.join(homes.agentsHome, '.claude', 'hooks', 'managed'),
      deleteWhenEmpty: false,
      stateTarget: 'claude-code',
      importable: true,
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
      reserved: ['.system'],
      importable: true,
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
      reserved: [],
      importable: true,
    },
    mcp: {
      ...JSON_MCP_ROW,
      root: (homes) => path.join(homes.agentsHome, '.cursor'),
      path: (homes) => path.join(homes.agentsHome, '.cursor', 'mcp.json'),
      sanitize: true,
    },
  },
  {
    id: 'coco',
    detectDir: cocoConfigDir,
    rules: {
      root: (homes, targetPath) =>
        targetPath?.includes(`${path.sep}.cursor${path.sep}`)
          ? path.join(homes.agentsHome, '.cursor')
          : cocoDataDir(homes),
      path: (homes) => {
        const cursor = path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc');
        return fs.existsSync(cursor) ? cursor : path.join(cocoDataDir(homes), 'AGENTS.md');
      },
      render: (body, targetPath) =>
        targetPath?.endsWith(`${path.sep}asb-rules.mdc`) ? wrapMdcFrontmatter(body) : body,
      dedicated: false,
    },
    commands: {
      root: cocoDataDir,
      dir: (homes) => path.join(cocoDataDir(homes), 'commands'),
      projectDir: (root) => path.join(path.resolve(root), '.coco', 'commands'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderCocoCommand,
    },
    agents: {
      root: cocoDataDir,
      dir: (homes) => path.join(cocoDataDir(homes), 'agents'),
      projectDir: (root) => path.join(path.resolve(root), '.coco', 'agents'),
      filename: (id) => `${encodeComponentId(id)}.md`,
      render: renderCocoAgent,
    },
    skills: {
      root: cocoDataDir,
      dir: (homes) => path.join(cocoDataDir(homes), 'skills'),
      reserved: [],
    },
    mcp: {
      root: cocoConfigDir,
      path: (homes) => path.join(cocoConfigDir(homes), 'coco.yaml'),
      format: 'yaml',
      rootKey: 'mcp_servers',
      structure: 'keyed-array',
      keyField: 'name',
      sanitize: false,
      dialect: (server) =>
        transformMcpServer(server, {
          envTransform: { keyName: 'key', valueName: 'value' },
          defaults: { type: 'stdio' },
        }),
      envKeyName: 'key',
      create: true,
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
