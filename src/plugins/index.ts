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
import { getConfigDir } from '../config/paths.js';
import { loadConfiguredPortableSelections } from '../config/plugin-selection.js';
import type { McpServer, RemoteSource } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { getSourceRevision, getSources, type Source } from '../library/sources.js';
import { loadPluginComponents, loadPluginHookEntries } from '../marketplace/plugin-loader.js';
import {
  isMarketplace,
  isResolvedPlugin,
  type MarketplacePlugin,
  type NativePluginTarget,
  type ResolvedPlugin,
  readMarketplace,
  readPluginManifest,
  resolveMarketplacePlugin,
} from '../marketplace/reader.js';
import type { RuleSnippet } from '../rules/library.js';
import { parseRuleMarkdown } from '../rules/parser.js';
import { buildComponentId, buildPluginId, splitComponentId } from './identity.js';

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
  materialized?: boolean;
  native?: NativePluginMeta;
}

export interface NativePluginMeta {
  target: NativePluginTarget;
  marketplaceName: string;
  marketplacePath: string;
  remoteSource?: RemoteSource;
  pluginName: string;
  installRef: string;
  version?: string;
  /** Original plugin root for bare Codex plugins wrapped as ASB-owned local marketplaces. */
  sourcePath?: string;
}

export interface PluginDescriptor {
  name: string;
  id: string;
  refs: string[];
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
  /** Look up a native plugin by ASB ref or unambiguous native install ref */
  getNative(pluginId: string, target?: NativePluginTarget): PluginDescriptor | undefined;
  /** Expand a list of plugin IDs into per-section component IDs */
  expand(pluginIds: string[]): PluginComponents;
  /** Materialize selected marketplace plugins without expanding their components */
  materialize(pluginIds: string[]): PluginDescriptor[];
  /** Materialize portable plugins and component owners selected by configuration */
  materializeConfigured(): void;
  /** Normalize legacy or aliased component refs to canonical IDs */
  normalizeComponentId(componentId: string): string;
}

// ── Helpers ────────────────────────────────────────────────────────

function isMarkdownFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

function byEntryName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name.localeCompare(b.name);
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'plugin';
}

function getCodexNativeWrapperPath(namespace: string): string {
  return path.join(getConfigDir(), 'state', 'native-plugins', 'codex', safePathSegment(namespace));
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
  const entries = fs.readdirSync(rulesDir, { withFileTypes: true }).sort(byEntryName);

  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
    const absolutePath = path.join(rulesDir, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseRuleMarkdown(rawContent);
      const bareId = toId(entry.name);
      const id = buildComponentId(namespace, bareId);
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
      const serverId = buildComponentId(namespace, name);
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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byEntryName)) {
    if (entry.isFile() && isMarkdownFile(entry.name)) {
      ids.push(buildComponentId(namespace, toId(entry.name)));
    }
  }
  return ids;
}

function loadPluginSkillIds(basePath: string, namespace: string): string[] {
  const dir = path.join(basePath, 'skills');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byEntryName)) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
      ids.push(buildComponentId(namespace, entry.name));
    }
  }
  return ids;
}

function loadPluginHookIds(basePath: string, namespace: string): string[] {
  return loadPluginHookEntries(basePath, namespace).map((entry) => entry.id);
}

function loadPluginRuleIds(basePath: string, namespace: string): string[] {
  const dir = path.join(basePath, 'rules');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byEntryName)) {
    if (entry.isFile() && isMarkdownFile(entry.name)) {
      ids.push(buildComponentId(namespace, toId(entry.name)));
    }
  }
  return ids;
}

// ── Index builder ──────────────────────────────────────────────────

function emptyPluginComponents(): PluginComponents {
  return { commands: [], agents: [], skills: [], hooks: [], rules: [], mcp: [] };
}

function loadMarketplacePluginData(
  plugin: ResolvedPlugin,
  pluginId: string,
  allMcpServers: PluginMcpServer[],
  allRuleSnippets: PluginRuleSnippet[]
): PluginComponents {
  const components = loadPluginComponents(plugin, pluginId);
  const rulesResult = loadRulesFromPluginDir(plugin.localPath, pluginId);
  const mcpResult = loadMcpFromPluginDir(plugin.localPath, pluginId);

  if (plugin.mcpServers) {
    for (const [name, serverDef] of Object.entries(plugin.mcpServers)) {
      if (typeof serverDef !== 'object' || serverDef === null) continue;
      const serverId = buildComponentId(pluginId, name);
      if (!mcpResult.ids.includes(serverId)) {
        mcpResult.ids.push(serverId);
        mcpResult.servers.push({
          pluginId,
          serverId,
          server: serverDef as McpServer,
        });
      }
    }
  }

  allMcpServers.push(...mcpResult.servers);
  allRuleSnippets.push(...rulesResult.snippets);

  return {
    commands: components.commands.map((entry) => entry.id),
    agents: components.agents.map((entry) => entry.id),
    skills: components.skills.map((entry) => entry.id),
    hooks: components.hooks.map((entry) => entry.id),
    rules: rulesResult.ids,
    mcp: mcpResult.ids,
  };
}

function buildFromMarketplace(
  source: Source,
  allPlugins: PluginDescriptor[],
  allMcpServers: PluginMcpServer[],
  allRuleSnippets: PluginRuleSnippet[],
  deferredLoaders: Map<string, () => void>
): void {
  const { namespace: sourceName, path: basePath, remote } = source;
  const result = readMarketplace(basePath, sourceName);

  for (const plugin of result.plugins) {
    const pluginId = buildPluginId(plugin.name, sourceName, 'marketplace');
    const initialComponents = isResolvedPlugin(plugin)
      ? loadMarketplacePluginData(plugin, pluginId, allMcpServers, allRuleSnippets)
      : emptyPluginComponents();
    const descriptor: PluginDescriptor = {
      name: plugin.name,
      id: pluginId,
      refs: [pluginId],
      meta: {
        description: plugin.description,
        version: plugin.version,
        owner: result.owner.name,
        sourcePath: plugin.localPath ?? basePath,
        sourceKind: 'marketplace',
        sourceName,
        materialized: isResolvedPlugin(plugin),
        native: {
          target: result.nativeTarget,
          marketplaceName: result.name,
          marketplacePath: basePath,
          remoteSource: remote,
          pluginName: plugin.name,
          installRef: `${plugin.name}@${result.name}`,
          version: plugin.version,
        },
      },
      components: initialComponents,
    };
    allPlugins.push(descriptor);

    if (!isResolvedPlugin(plugin)) {
      deferredLoaders.set(pluginId, () => {
        let resolved: ResolvedPlugin | null;
        try {
          resolved = resolveMarketplacePlugin(plugin as MarketplacePlugin);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to materialize marketplace plugin "${pluginId}": ${detail}`);
        }
        if (!resolved) {
          throw new Error(`Failed to materialize marketplace plugin "${pluginId}".`);
        }
        descriptor.components = loadMarketplacePluginData(
          resolved,
          pluginId,
          allMcpServers,
          allRuleSnippets
        );
        descriptor.meta.description = resolved.description;
        descriptor.meta.version = resolved.version;
        descriptor.meta.sourcePath = resolved.localPath;
        descriptor.meta.materialized = true;
      });
    }
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

  const codexManifest = readPluginManifest(basePath, 'codex');
  const manifest = readPluginManifest(basePath, 'claude-code') ?? codexManifest;
  const native = codexManifest
    ? {
        target: 'codex' as const,
        marketplaceName: namespace,
        marketplacePath: getCodexNativeWrapperPath(namespace),
        pluginName: codexManifest.name,
        installRef: `${codexManifest.name}@${namespace}`,
        version: codexManifest.version,
        sourcePath: basePath,
      }
    : undefined;

  if (!hasAny && !native) return;

  allPlugins.push({
    name: native?.pluginName ?? namespace,
    id: namespace,
    refs: [namespace],
    meta: {
      description: manifest?.description,
      version: manifest?.version,
      sourcePath: basePath,
      sourceKind: 'plugin',
      sourceName: namespace,
      native,
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
  const sourceRevision = getSourceRevision();
  return JSON.stringify({ asbHome, agentsHome, profile, project, sourceRevision });
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
  const deferredLoaders = new Map<string, () => void>();
  const sources = getSources(scope);

  for (const source of sources) {
    if (isMarketplace(source.path)) {
      buildFromMarketplace(source, plugins, mcpServers, ruleSnippets, deferredLoaders);
    } else {
      buildFromPlugin(source.namespace, source.path, plugins, mcpServers, ruleSnippets);
    }
  }

  // Build lookup maps: canonical IDs always work; bare names work only when unambiguous.
  const byId = new Map<string, PluginDescriptor>();
  const byName = new Map<string, PluginDescriptor[]>();
  const nativeRefAliases = new Map<string, PluginDescriptor[]>();
  for (const p of plugins) {
    byId.set(p.id, p);
    if (p.meta.native) {
      const key = `${p.meta.native.target}\0${p.meta.native.installRef}`;
      const existing = nativeRefAliases.get(key);
      if (existing) {
        existing.push(p);
      } else {
        nativeRefAliases.set(key, [p]);
      }
    }
    const existing = byName.get(p.name);
    if (existing) {
      existing.push(p);
    } else {
      byName.set(p.name, [p]);
    }
  }

  for (const [name, descriptors] of byName) {
    if (descriptors.length === 1) {
      const descriptor = descriptors[0];
      byId.set(name, descriptor);
      if (!descriptor.refs.includes(name)) {
        descriptor.refs.push(name);
      }
    } else {
      const sources = descriptors.map((d) => d.meta.sourceName).join(', ');
      console.warn(
        `[plugins] Ambiguous plugin name "${name}" found in sources: ${sources}. ` +
          `Use name@source syntax (e.g., "${name}@${descriptors[0].meta.sourceName}") to disambiguate.`
      );
    }
  }

  const byNativeRef = new Map<string, PluginDescriptor>();
  for (const [nativeKey, descriptors] of nativeRefAliases) {
    if (descriptors.length === 1) {
      const descriptor = descriptors[0];
      byNativeRef.set(nativeKey, descriptor);
    } else {
      const [, nativeRef] = nativeKey.split('\0');
      const sources = descriptors.map((d) => d.meta.sourceName).join(', ');
      console.warn(
        `[plugins] Ambiguous native plugin ref "${nativeRef}" found in sources: ${sources}. ` +
          `Use the ASB source-qualified ref for the intended source.`
      );
    }
  }

  const componentAliases = new Map<string, string>();
  const registerComponentAliases = (plugin: PluginDescriptor) => {
    for (const section of ['commands', 'agents', 'skills', 'hooks', 'rules', 'mcp'] as const) {
      for (const componentId of plugin.components[section]) {
        componentAliases.set(componentId, componentId);

        const parsed = splitComponentId(componentId);
        if (!parsed) continue;

        if (plugin.refs.includes(plugin.name)) {
          componentAliases.set(buildComponentId(plugin.name, parsed.bareId), componentId);
        }
      }
    }
  };
  for (const plugin of plugins) {
    registerComponentAliases(plugin);
  }

  const materialize = (pluginIds: string[]): PluginDescriptor[] => {
    const result: PluginDescriptor[] = [];
    for (const pluginId of pluginIds) {
      const plugin = byId.get(pluginId);
      if (!plugin) continue;
      const loader = deferredLoaders.get(plugin.id);
      if (loader) {
        loader();
        deferredLoaders.delete(plugin.id);
        registerComponentAliases(plugin);
      }
      result.push(plugin);
    }
    return result;
  };

  const normalizeComponentId = (componentId: string): string => {
    const existing = componentAliases.get(componentId);
    if (existing) return existing;

    const parsed = splitComponentId(componentId);
    if (parsed && byId.has(parsed.pluginId)) {
      materialize([parsed.pluginId]);
    }
    return componentAliases.get(componentId) ?? componentId;
  };

  let configuredSelectionKey = '';
  const materializeConfigured = (): void => {
    const configured = loadConfiguredPortableSelections(scope, {
      pluginRef: (ref) => byId.get(ref)?.id ?? ref,
      componentRef: (ref) => {
        const parsed = splitComponentId(ref);
        if (!parsed) return ref;
        const plugin = byId.get(parsed.pluginId);
        return plugin ? buildComponentId(plugin.id, parsed.bareId) : ref;
      },
    });
    const selectionKey = JSON.stringify(configured);
    if (selectionKey === configuredSelectionKey) return;
    materialize(configured.pluginRefs);
    for (const componentRef of configured.componentRefs) {
      normalizeComponentId(componentRef);
    }
    configuredSelectionKey = selectionKey;
  };

  const index: PluginIndex = {
    plugins,
    get mcpServers() {
      materializeConfigured();
      return mcpServers;
    },
    get ruleSnippets() {
      materializeConfigured();
      return ruleSnippets;
    },

    get(pluginId: string) {
      return byId.get(pluginId);
    },

    getNative(pluginId: string, target?: NativePluginTarget) {
      const direct = byId.get(pluginId);
      if (direct?.meta.native && (!target || direct.meta.native.target === target)) return direct;
      if (!target) {
        for (const nativeTarget of ['claude-code', 'codex'] as const) {
          const candidate = byNativeRef.get(`${nativeTarget}\0${pluginId}`);
          if (candidate) return candidate;
        }
        return undefined;
      }
      return byNativeRef.get(`${target}\0${pluginId}`);
    },

    materialize,
    materializeConfigured,

    expand(pluginIds: string[]): PluginComponents {
      const result: PluginComponents = {
        commands: [],
        agents: [],
        skills: [],
        hooks: [],
        rules: [],
        mcp: [],
      };

      for (const descriptor of materialize(pluginIds)) {
        for (const section of ['commands', 'agents', 'skills', 'hooks', 'rules', 'mcp'] as const) {
          result[section].push(...descriptor.components[section]);
        }
      }

      return result;
    },

    normalizeComponentId(componentId: string) {
      return normalizeComponentId(componentId);
    },
  };

  cachedIndices.set(cacheKey, index);
  return index;
}
