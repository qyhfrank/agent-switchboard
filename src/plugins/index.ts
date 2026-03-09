/**
 * Plugin index: discovers all plugins from configured sources and builds a
 * lookup table mapping pluginId -> component IDs for each library type.
 *
 * Two kinds of sources are indexed:
 *   - **Marketplace sources**: contain `.claude-plugin/marketplace.json`.
 *     Each plugin entry in the manifest becomes a PluginDescriptor.
 *   - **Plugin sources**: everything else. May optionally have
 *     `.claude-plugin/plugin.json` for metadata; component directories
 *     (commands/, agents/, skills/, hooks/, rules/, .mcp.json) are scanned
 *     regardless.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { getSourcesRecord } from '../library/sources.js';
import { loadPluginComponents } from '../marketplace/plugin-loader.js';
import { isMarketplace, readMarketplace } from '../marketplace/reader.js';
import type { RuleSnippet } from '../rules/library.js';
import { parseRuleMarkdown } from '../rules/parser.js';

export type PluginComponentSection = 'commands' | 'agents' | 'skills' | 'hooks' | 'rules' | 'mcp';

export interface PluginComponents {
  commands: string[];
  agents: string[];
  skills: string[];
  hooks: string[];
  rules: string[];
  mcp: string[];
}

export interface PluginMeta {
  description?: string;
  version?: string;
  owner?: string;
  sourcePath: string;
  sourceKind: 'marketplace' | 'plugin';
  /** Namespace of the source this plugin came from (for @source disambiguation) */
  sourceName: string;
}

export interface PluginDescriptor {
  id: string;
  meta: PluginMeta;
  components: PluginComponents;
}

export interface PluginMcpServer {
  pluginId: string;
  serverId: string;
  server: McpServer;
}

export interface PluginRuleSnippet extends RuleSnippet {
  pluginId: string;
}

export interface PluginIndex {
  plugins: PluginDescriptor[];
  mcpServers: PluginMcpServer[];
  ruleSnippets: PluginRuleSnippet[];
  /** Look up a plugin by ID */
  get(pluginId: string): PluginDescriptor | undefined;
  /** Expand a list of plugin IDs into per-section component IDs */
  expand(pluginIds: string[]): PluginComponents;
}

// ── Helpers ────────────────────────────────────────────────────────

function isMarkdownFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function loadRulesFromPluginDir(
  pluginDir: string,
  namespace: string
): { ids: string[]; snippets: PluginRuleSnippet[]; pluginId: string } {
  const rulesDir = path.join(pluginDir, 'rules');
  if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) {
    return { ids: [], snippets: [], pluginId: namespace };
  }

  const ids: string[] = [];
  const snippets: PluginRuleSnippet[] = [];
  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
    const absolutePath = path.join(rulesDir, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseRuleMarkdown(rawContent);
      const bareId = toId(entry.name);
      const id = `${namespace}:${bareId}`;
      ids.push(id);
      snippets.push({
        id,
        bareId,
        namespace,
        source: rulesDir,
        filePath: absolutePath,
        metadata: parsed.metadata,
        content: parsed.content,
        pluginId: namespace,
      });
    } catch {
      // Skip unparseable rule files
    }
  }

  return { ids, snippets, pluginId: namespace };
}

function loadMcpFromPluginDir(
  pluginDir: string,
  namespace: string
): { ids: string[]; servers: PluginMcpServer[] } {
  const mcpJsonPath = path.join(pluginDir, '.mcp.json');
  const ids: string[] = [];
  const servers: PluginMcpServer[] = [];

  if (!fs.existsSync(mcpJsonPath)) return { ids, servers };

  try {
    const raw = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    // Support both flat format { "server": {...} } and wrapped format { "mcpServers": { "server": {...} } }
    const parsed = typeof raw === 'object' && raw !== null ? raw : {};
    const entries =
      'mcpServers' in parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null
        ? parsed.mcpServers
        : parsed;

    for (const [name, serverDef] of Object.entries(entries)) {
      if (typeof serverDef !== 'object' || serverDef === null) continue;
      const serverId = `${namespace}:${name}`;
      ids.push(serverId);
      servers.push({
        pluginId: namespace,
        serverId,
        server: serverDef as McpServer,
      });
    }
  } catch {
    // Skip unparseable mcp.json
  }

  return { ids, servers };
}

function loadPluginComponentIds(
  basePath: string,
  namespace: string,
  type: 'commands' | 'agents'
): string[] {
  const dir = path.join(basePath, type);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && isMarkdownFile(entry.name)) {
      ids.push(`${namespace}:${toId(entry.name)}`);
    }
  }
  return ids;
}

function loadPluginSkillIds(basePath: string, namespace: string): string[] {
  const dir = path.join(basePath, 'skills');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
      ids.push(`${namespace}:${entry.name}`);
    }
  }
  return ids;
}

function loadPluginHookIds(basePath: string, namespace: string): string[] {
  const dir = path.join(basePath, 'hooks');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'hook.json'))) {
      ids.push(`${namespace}:${entry.name}`);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
      ids.push(`${namespace}:${toId(entry.name)}`);
    }
  }
  return ids;
}

function loadPluginRuleIds(basePath: string, namespace: string): string[] {
  const dir = path.join(basePath, 'rules');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && isMarkdownFile(entry.name)) {
      ids.push(`${namespace}:${toId(entry.name)}`);
    }
  }
  return ids;
}

// ── Index builder ──────────────────────────────────────────────────

function buildFromMarketplace(
  sourceName: string,
  basePath: string,
  allPlugins: PluginDescriptor[],
  allMcpServers: PluginMcpServer[],
  allRuleSnippets: PluginRuleSnippet[]
): void {
  const result = readMarketplace(basePath);

  for (const plugin of result.plugins) {
    const components = loadPluginComponents(plugin);
    const namespace = plugin.name;

    const commandIds = components.commands.map((c) => c.id);
    const agentIds = components.agents.map((a) => a.id);
    const skillIds = components.skills.map((s) => s.id);
    const hookIds = components.hooks.map((h) => h.id);

    const rulesResult = loadRulesFromPluginDir(plugin.localPath, namespace);
    const mcpResult = loadMcpFromPluginDir(plugin.localPath, namespace);

    // Also pick up mcpServers declared in the marketplace entry / plugin.json
    if (plugin.mcpServers) {
      for (const [name, serverDef] of Object.entries(plugin.mcpServers)) {
        if (typeof serverDef !== 'object' || serverDef === null) continue;
        const serverId = `${namespace}:${name}`;
        if (!mcpResult.ids.includes(serverId)) {
          mcpResult.ids.push(serverId);
          mcpResult.servers.push({
            pluginId: namespace,
            serverId,
            server: serverDef as McpServer,
          });
        }
      }
    }

    allMcpServers.push(...mcpResult.servers);
    allRuleSnippets.push(...rulesResult.snippets);

    allPlugins.push({
      id: namespace,
      meta: {
        description: plugin.description,
        version: plugin.version,
        owner: result.owner.name,
        sourcePath: plugin.localPath,
        sourceKind: 'marketplace',
        sourceName,
      },
      components: {
        commands: commandIds,
        agents: agentIds,
        skills: skillIds,
        hooks: hookIds,
        rules: rulesResult.ids,
        mcp: mcpResult.ids,
      },
    });
  }
}

function buildFromPlugin(
  namespace: string,
  basePath: string,
  allPlugins: PluginDescriptor[],
  allMcpServers: PluginMcpServer[],
  allRuleSnippets: PluginRuleSnippet[]
): void {
  const commandIds = loadPluginComponentIds(basePath, namespace, 'commands');
  const agentIds = loadPluginComponentIds(basePath, namespace, 'agents');
  const skillIds = loadPluginSkillIds(basePath, namespace);
  const hookIds = loadPluginHookIds(basePath, namespace);
  const ruleIds = loadPluginRuleIds(basePath, namespace);

  const mcpResult = loadMcpFromPluginDir(basePath, namespace);
  allMcpServers.push(...mcpResult.servers);

  const rulesResult = loadRulesFromPluginDir(basePath, namespace);
  allRuleSnippets.push(...rulesResult.snippets);

  const hasAny =
    commandIds.length > 0 ||
    agentIds.length > 0 ||
    skillIds.length > 0 ||
    hookIds.length > 0 ||
    ruleIds.length > 0 ||
    mcpResult.ids.length > 0;

  if (!hasAny) return;

  let description: string | undefined;
  let version: string | undefined;
  const manifestPath = path.join(basePath, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      description = raw.description;
      version = raw.version;
    } catch {
      // ignore unparseable manifest
    }
  }

  allPlugins.push({
    id: namespace,
    meta: {
      description,
      version,
      sourcePath: basePath,
      sourceKind: 'plugin',
      sourceName: namespace,
    },
    components: {
      commands: commandIds,
      agents: agentIds,
      skills: skillIds,
      hooks: hookIds,
      rules: ruleIds,
      mcp: mcpResult.ids,
    },
  });
}

// ── Public API ─────────────────────────────────────────────────────

const cachedIndices = new Map<string, PluginIndex>();

function getScopeCacheKey(scope?: ConfigScope): string {
  const profile = scope?.profile?.trim() ?? '';
  const project = scope?.project?.trim() ?? '';
  const asbHome = process.env.ASB_HOME ?? '';
  const agentsHome = process.env.ASB_AGENTS_HOME ?? '';
  return JSON.stringify({ asbHome, agentsHome, profile, project });
}

export function clearPluginIndexCache(): void {
  cachedIndices.clear();
}

export function buildPluginIndex(scope?: ConfigScope): PluginIndex {
  const cacheKey = getScopeCacheKey(scope);
  const cachedIndex = cachedIndices.get(cacheKey);
  if (cachedIndex) return cachedIndex;

  const plugins: PluginDescriptor[] = [];
  const mcpServers: PluginMcpServer[] = [];
  const ruleSnippets: PluginRuleSnippet[] = [];
  const sources = getSourcesRecord(scope);

  for (const [namespace, basePath] of Object.entries(sources)) {
    if (isMarketplace(basePath)) {
      buildFromMarketplace(namespace, basePath, plugins, mcpServers, ruleSnippets);
    } else {
      buildFromPlugin(namespace, basePath, plugins, mcpServers, ruleSnippets);
    }
  }

  // Build lookup maps: unique IDs get direct entry, collisions tracked for @source disambiguation
  const byId = new Map<string, PluginDescriptor>();
  const byName = new Map<string, PluginDescriptor[]>();
  for (const p of plugins) {
    byId.set(`${p.id}@${p.meta.sourceName}`, p);
    const existing = byName.get(p.id);
    if (existing) {
      existing.push(p);
    } else {
      byName.set(p.id, [p]);
    }
  }
  // Bare name resolves only when unambiguous (exactly one plugin with that name)
  for (const [name, descriptors] of byName) {
    if (descriptors.length === 1) {
      byId.set(name, descriptors[0]);
    }
  }

  const index: PluginIndex = {
    plugins,
    mcpServers,
    ruleSnippets,

    get(pluginId: string) {
      // Direct match: bare name (if unambiguous) or name@source
      const direct = byId.get(pluginId);
      if (direct) return direct;

      // Support `name@source` disambiguation syntax
      const atIdx = pluginId.lastIndexOf('@');
      if (atIdx > 0) {
        return byId.get(pluginId);
      }

      return undefined;
    },

    expand(pluginIds: string[]): PluginComponents {
      const result: PluginComponents = {
        commands: [],
        agents: [],
        skills: [],
        hooks: [],
        rules: [],
        mcp: [],
      };

      for (const pid of pluginIds) {
        const descriptor = this.get(pid);
        if (!descriptor) continue;
        for (const section of ['commands', 'agents', 'skills', 'hooks', 'rules', 'mcp'] as const) {
          result[section].push(...descriptor.components[section]);
        }
      }

      return result;
    },
  };

  cachedIndices.set(cacheKey, index);
  return index;
}
