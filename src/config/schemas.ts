/**
 * Zod schemas for configuration validation
 */

import { z } from 'zod';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeApplicationsSection(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const normalized = { ...value };
  if ('active' in normalized) {
    if (!('enabled' in normalized)) {
      normalized.enabled = normalized.active;
    }
    delete normalized.active;
  }
  return normalized;
}

/**
 * Schema for MCP server configuration (definition only, no enabled state)
 * Allows both command-based and URL-based servers
 * Preserves unknown fields for forward compatibility
 */
export const mcpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    type: z.enum(['stdio', 'sse', 'http']).optional(),
  })
  .passthrough(); // Allow unknown fields

/**
 * Schema for MCP configuration file (~/.agent-switchboard/mcp.json)
 */
export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
});

/**
 * Base schema for selection sections (commands, agents, etc.) without defaults.
 * `enabled` is an ordered array: array position = composition/priority order.
 */
const selectionSectionBaseSchema = z
  .object({
    enabled: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

export const selectionSectionSchema = selectionSectionBaseSchema
  .extend({
    enabled: z.array(z.string().trim().min(1)).default([]),
  })
  .passthrough();

/**
 * Incremental selection schema for per-application overrides
 * - enabled: completely override the global list
 * - add: append to the global list
 * - remove: remove from the global list
 */
export const incrementalSelectionSchema = z
  .object({
    enabled: z.array(z.string().trim().min(1)).optional(),
    add: z.array(z.string().trim().min(1)).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

const incrementalRulesSchema = incrementalSelectionSchema.extend({
  includeDelimiters: z.boolean().optional(),
});

/**
 * Per-application configuration override schema
 * Allows overriding mcp, commands, agents, skills, rules for a specific application
 */
export const applicationConfigOverrideSchema = z
  .object({
    plugins: incrementalSelectionSchema.optional(),
    mcp: incrementalSelectionSchema.optional(),
    commands: incrementalSelectionSchema.optional(),
    agents: incrementalSelectionSchema.optional(),
    skills: incrementalSelectionSchema.optional(),
    hooks: incrementalSelectionSchema.optional(),
    rules: incrementalRulesSchema.optional(),
  })
  .passthrough();

/**
 * Applications section schema with enabled list and per-application overrides.
 * Lists which AI agent applications (claude-code, cursor, codex, etc.) to sync to.
 * Format in TOML:
 *   [applications]
 *   enabled = ["claude-code", "codex"]
 *
 *   [applications.codex.skills]
 *   remove = ["skill-codex"]
 *
 * Note: Using passthrough() instead of catchall() to allow per-application overrides.
 * The per-application overrides are validated at runtime in application-config.ts.
 */
const applicationsSectionBaseSchema = z.preprocess(
  normalizeApplicationsSection,
  z
    .object({
      enabled: z.array(z.string().trim().min(1)).optional(),
      assume_installed: z.array(z.string().trim().min(1)).optional(),
    })
    .passthrough()
);

const applicationsSectionSchema = z.preprocess(
  normalizeApplicationsSection,
  z
    .object({
      enabled: z.array(z.string().trim().min(1)).default([]),
      assume_installed: z.array(z.string().trim().min(1)).default([]),
    })
    .passthrough()
);

const rulesSectionBaseSchema = selectionSectionBaseSchema.extend({
  includeDelimiters: z.boolean().optional(),
});

export const rulesSectionSchema = rulesSectionBaseSchema
  .extend({
    enabled: z.array(z.string().trim().min(1)).default([]),
    includeDelimiters: z.boolean().default(false),
  })
  .passthrough();

/**
 * Distribution configuration schema
 * Controls how skills/commands/agents are distributed to application targets.
 * - use_agents_dir: When true, skills are distributed to 2 targets (claude-code + agents).
 *   When false (default), skills use the legacy 4-target mode for backward compatibility.
 * - project: Controls project-level distribution behavior.
 *   - mode: "managed" (default) = only manage ASB-owned content, preserve project-native.
 *     "exclusive" = ASB owns entire target area (current global behavior).
 *     "none" = skip project distribution.
 *   - collision: What to do when target path exists but isn't ASB-owned.
 *   - drift: What to do when ASB-owned content was manually edited.
 *   - rules.placement: Where to insert ASB rules block in shared files.
 */
const projectRulesDistributionBaseSchema = z
  .object({
    placement: z.enum(['prepend', 'append']).optional(),
  })
  .passthrough();

const projectDistributionBaseSchema = z
  .object({
    mode: z.enum(['managed', 'exclusive', 'none']).optional(),
    collision: z.enum(['warn-skip', 'error', 'takeover']).optional(),
    rules: projectRulesDistributionBaseSchema.optional(),
  })
  .passthrough();

const projectDistributionFullSchema = projectDistributionBaseSchema
  .extend({
    mode: z.enum(['managed', 'exclusive', 'none']).default('managed'),
    collision: z.enum(['warn-skip', 'error', 'takeover']).default('warn-skip'),
    rules: projectRulesDistributionBaseSchema
      .extend({
        placement: z.enum(['prepend', 'append']).default('prepend'),
      })
      .passthrough()
      .default({ placement: 'prepend' }),
  })
  .passthrough();

const distributionSectionBaseSchema = z
  .object({
    use_agents_dir: z.boolean().optional(),
    project: projectDistributionBaseSchema.optional(),
  })
  .passthrough();

export const distributionSectionSchema = distributionSectionBaseSchema
  .extend({
    use_agents_dir: z.boolean().default(false),
    project: projectDistributionFullSchema.default({}),
  })
  .passthrough();

/**
 * UI configuration schema
 */
const uiSectionBaseSchema = z
  .object({
    page_size: z.number().int().min(5).max(50).optional(),
  })
  .passthrough();

export const uiSectionSchema = uiSectionBaseSchema
  .extend({
    page_size: z.number().int().min(5).max(50).default(20),
  })
  .passthrough();

/**
 * Source value schema for plugin sources.
 * Accepts a string (local path or git URL) or an object with url/ref/subdir.
 * GitHub tree URLs are parsed at runtime into ref+subdir.
 */
export const remoteSourceSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
  subdir: z.string().optional(),
});

export const sourceValueSchema = z.union([z.string().trim().min(1), remoteSourceSchema]);

/**
 * Plugin exclude schema: per-section lists of entry IDs to exclude from
 * plugin expansion. Lets users cherry-pick within an activated plugin.
 *
 * TOML example:
 *   [plugins.exclude]
 *   commands = ["context7:docs"]
 *   rules = ["context7:use-context7"]
 */
const pluginExcludeSchema = z
  .object({
    commands: z.array(z.string().trim().min(1)).optional(),
    agents: z.array(z.string().trim().min(1)).optional(),
    skills: z.array(z.string().trim().min(1)).optional(),
    hooks: z.array(z.string().trim().min(1)).optional(),
    rules: z.array(z.string().trim().min(1)).optional(),
    mcp: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

/**
 * Plugins section schema.
 *
 * On-disk format:
 *   [plugins]
 *   enabled = ["context7", "my-plugin@community"]
 *
 *   [plugins.sources]
 *   community = "https://github.com/anthropics/community-marketplace.git"
 *   team-lib = "/Users/me/team-library"
 *
 *   [plugins.exclude]
 *   commands = ["context7:docs"]
 *
 * `enabled` is an ordered array, consistent with all other sections.
 * `sources` declares explicit plugin locations; local plugins in
 * `~/.asb/plugins/` are auto-discovered without configuration.
 *
 * Legacy formats (flat boolean map and old `[plugins.sources]` +
 * `[plugins.enabled]` record) are auto-migrated via `z.preprocess`.
 */

function migratePluginsSection(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;

  // Current format: enabled is already an array
  if (Array.isArray(obj.enabled)) return input;

  // Old legacy format: enabled is a Record<string, boolean>
  const e = obj.enabled;
  if (e !== undefined && typeof e === 'object' && e !== null && !Array.isArray(e)) {
    return {
      ...obj,
      enabled: Object.entries(e as Record<string, boolean>)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    };
  }

  // Old legacy format: has sources sub-object but no enabled
  const s = obj.sources;
  if (
    s !== undefined &&
    typeof s === 'object' &&
    s !== null &&
    !Array.isArray(s) &&
    !('source' in (s as Record<string, unknown>))
  ) {
    return { ...obj, enabled: [] };
  }

  // Flat boolean-map format: boolean values + [plugins.<name>] source tables
  const sources: Record<string, unknown> = {};
  const enabled: string[] = [];
  let exclude: unknown;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'exclude' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const maybeExclude = value as Record<string, unknown>;
      if (!('source' in maybeExclude)) {
        exclude = value;
        continue;
      }
    }
    if (typeof value === 'boolean') {
      if (value) enabled.push(key);
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'source' in (value as Record<string, unknown>)
    ) {
      const entry = value as Record<string, unknown>;
      sources[key] = entry.source;
      if (entry.enabled === true) enabled.push(key);
    }
  }

  const result: Record<string, unknown> = { sources, enabled };
  if (exclude !== undefined) result.exclude = exclude;
  return result;
}

const pluginsSectionInnerBase = z
  .object({
    sources: z.record(z.string().trim().min(1), sourceValueSchema).optional(),
    enabled: z.array(z.string().trim().min(1)).optional(),
    exclude: pluginExcludeSchema.optional(),
  })
  .passthrough();

const pluginsSectionInnerFull = z
  .object({
    sources: z.record(z.string().trim().min(1), sourceValueSchema).default({}),
    enabled: z.array(z.string().trim().min(1)).default([]),
    exclude: pluginExcludeSchema.default({}),
  })
  .passthrough();

const pluginsSectionBaseSchema = z.preprocess(migratePluginsSection, pluginsSectionInnerBase);

export const pluginsSectionSchema = z.preprocess(migratePluginsSection, pluginsSectionInnerFull);

/**
 * Extensions section: enable/disable map for extension modules.
 * Modules are auto-discovered from `~/.asb/extensions/` (`.mjs`/`.js` files).
 * The map controls which discovered modules are loaded:
 *   - `true`  = enabled
 *   - `false` = disabled
 *   - absent  = enabled (auto-discovered modules are opt-out)
 *
 * TOML example:
 *   [extensions]
 *   my-extension = true
 *   disabled-one = false
 */
const extensionsSectionBaseSchema = z.record(z.string(), z.boolean());

export const extensionsSectionSchema = extensionsSectionBaseSchema;

/**
 * Config-driven target spec (TargetSpec). Allows declaring custom application
 * targets purely via configuration. The spec is compiled into an
 * ApplicationTarget at startup by the DSL engine.
 *
 * TOML example:
 *   [targets.my-agent.mcp]
 *   format = "yaml"
 *   config_path = "~/.my-agent/config.yaml"
 *
 * The spec schema is intentionally permissive (.passthrough) so the DSL
 * engine can evolve without schema churn. Validation happens at compile time.
 */
export const targetSpecSchema = z.object({}).passthrough();

/**
 * Schema for Agent Switchboard configuration file (~/.agent-switchboard/config.toml)
 */
export const switchboardConfigSchema = z
  .object({
    applications: applicationsSectionSchema.default({ enabled: [] }),
    plugins: pluginsSectionSchema.default({}),
    extensions: extensionsSectionSchema.default({}),
    targets: z.record(z.string().trim().min(1), targetSpecSchema).default({}),
    mcp: selectionSectionSchema.default({ enabled: [] }),
    commands: selectionSectionSchema.default({ enabled: [] }),
    agents: selectionSectionSchema.default({ enabled: [] }),
    skills: selectionSectionSchema.default({ enabled: [] }),
    hooks: selectionSectionSchema.default({ enabled: [] }),
    rules: rulesSectionSchema.default({ enabled: [], includeDelimiters: false }),
    distribution: distributionSectionSchema.default({ use_agents_dir: false }),
    ui: uiSectionSchema.default({ pageSize: 20 }),
  })
  .passthrough();

/**
 * Input schema for partial config layers (no defaults)
 */
export const switchboardConfigLayerSchema = z
  .object({
    applications: applicationsSectionBaseSchema.optional(),
    plugins: pluginsSectionBaseSchema.optional(),
    extensions: extensionsSectionBaseSchema.optional(),
    targets: z.record(z.string().trim().min(1), targetSpecSchema).optional(),
    mcp: selectionSectionBaseSchema.optional(),
    commands: selectionSectionBaseSchema.optional(),
    agents: selectionSectionBaseSchema.optional(),
    skills: selectionSectionBaseSchema.optional(),
    hooks: selectionSectionBaseSchema.optional(),
    rules: rulesSectionBaseSchema.optional(),
    distribution: distributionSectionBaseSchema.optional(),
    ui: uiSectionBaseSchema.optional(),
  })
  .passthrough();

/**
 * Infer TypeScript types from schemas
 */
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type SelectionSection = z.infer<typeof selectionSectionSchema>;
export type IncrementalSelection = z.infer<typeof incrementalSelectionSchema>;
export type ApplicationConfigOverride = z.infer<typeof applicationConfigOverrideSchema>;
export type ApplicationsSection = z.infer<typeof applicationsSectionSchema>;
export type RulesSection = z.infer<typeof rulesSectionSchema>;
export type DistributionSection = z.infer<typeof distributionSectionSchema>;
export type ProjectDistributionConfig = z.infer<typeof projectDistributionFullSchema>;
export type UiSection = z.infer<typeof uiSectionSchema>;
export type RemoteSource = z.infer<typeof remoteSourceSchema>;
export type SourceValue = z.infer<typeof sourceValueSchema>;
export type PluginExclude = z.infer<typeof pluginExcludeSchema>;
export type PluginsSection = z.infer<typeof pluginsSectionSchema>;
export type ExtensionsSection = z.infer<typeof extensionsSectionSchema>;
export type TargetSpec = z.infer<typeof targetSpecSchema>;
export type SwitchboardConfig = z.infer<typeof switchboardConfigSchema>;
export type SwitchboardConfigLayer = z.infer<typeof switchboardConfigLayerSchema>;
