import chalk from 'chalk';
import { distributeCommands } from '../commands/distribution.js';
import { resolveScopedSectionConfig } from '../config/application-config.js';
import type { ConfigLayers } from '../config/layered-config.js';
import type { SwitchboardConfig } from '../config/schemas.js';
import { type ConfigScope, scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfigWithLayers } from '../config/switchboard-config.js';
import { distributeHooks } from '../hooks/distribution.js';
import { updateRemoteSources } from '../library/sources.js';
import { loadManifest, saveManifest } from '../manifest/store.js';
import type { ProjectDistributionManifest } from '../manifest/types.js';
import { distributeMcp } from '../mcp/distribution.js';
import { buildPluginIndex } from '../plugins/index.js';
import { distributeRules } from '../rules/distribution.js';
import { distributeSkills } from '../skills/distribution.js';
import { distributeSubagents } from '../subagents/distribution.js';
import { initTargets } from '../targets/init.js';
import { filterInstalled, getTargetById, getTargetsForSection } from '../targets/registry.js';
import {
  type CompactDistributionSection,
  type DistributionResultLike,
  printCompactDistributions,
  shortenPath,
} from '../util/cli.js';

interface SyncPhaseOptions {
  scope?: ConfigScope;
  config: SwitchboardConfig;
  layers: ConfigLayers;
}

export interface RunSyncCommandOptions {
  scope?: ConfigScope;
  updateSources?: boolean;
}

export async function runSyncCommand(options: RunSyncCommandOptions): Promise<boolean> {
  const { scope, updateSources = true } = options;

  console.log(chalk.yellow('⚠ Sync overwrites agent config without diff.'));
  console.log();

  if (updateSources) {
    const remoteResults = updateRemoteSources(scope);
    if (remoteResults.length > 0) {
      console.log(chalk.blue('Sources:'));
      for (const result of remoteResults) {
        if (result.status === 'updated') {
          console.log(
            `  ${chalk.green('✓')} ${chalk.cyan(result.namespace)} ${chalk.dim(result.url)}`
          );
        } else {
          console.log(
            `  ${chalk.yellow('⚠')} ${chalk.cyan(result.namespace)} ${chalk.yellow(result.error ?? 'update failed')}`
          );
        }
      }
    }
  }

  const { config, layers } = loadSwitchboardConfigWithLayers(scopeToLayerOptions(scope));
  await initTargets(config);

  if (scope?.project) {
    console.log(chalk.blue.bold(`── Project: ${shortenPath(scope.project)} ──`));
  } else if (scope?.profile) {
    console.log(chalk.blue.bold(`── Profile: ${scope.profile} ──`));
  }

  return runSyncPhase({ scope, config, layers });
}

export async function runSyncPhase({ scope, config, layers }: SyncPhaseOptions): Promise<boolean> {
  const writableConfig = scope?.project
    ? layers.project?.config
    : scope?.profile
      ? layers.profile?.config
      : undefined;
  const getDisplayEnabled = (
    section: 'mcp' | 'rules' | 'commands' | 'agents' | 'skills' | 'hooks'
  ): string[] => {
    if (!scope?.project && !scope?.profile) {
      return config[section].enabled;
    }
    return writableConfig?.[section]?.enabled ?? [];
  };
  const displayPluginRefs =
    scope?.project || scope?.profile
      ? (writableConfig?.plugins?.enabled ?? [])
      : config.plugins.enabled;

  const activeLayers: string[] = [];
  if (layers.user.exists) activeLayers.push(shortenPath(layers.user.path));
  if (layers.profile?.exists) activeLayers.push(shortenPath(layers.profile.path));
  if (layers.project?.exists) activeLayers.push(shortenPath(layers.project.path));
  console.log(
    `${chalk.blue('Config:')} ${activeLayers.length > 0 ? chalk.dim(activeLayers.join(' + ')) : chalk.gray('no config files')}`
  );

  const assumeInstalledSet = new Set(config.applications.assume_installed);
  const appsLabel =
    config.applications.enabled.length > 0
      ? config.applications.enabled
          .map((id) => {
            const target = getTargetById(id);
            if (target?.isInstalled?.() === false) {
              if (assumeInstalledSet.has(id)) return chalk.yellow(`${id} (assumed installed)`);
              return chalk.gray(`${id} (not installed)`);
            }
            return chalk.cyan(id);
          })
          .join(', ')
      : chalk.gray('none configured');
  console.log(`${chalk.blue('Apps:')}   ${appsLabel}`);
  console.log();

  const sections = ['mcp', 'rules', 'commands', 'agents', 'skills', 'hooks'] as const;

  // Precompute per-section per-app effective configs
  const sectionAppConfigs = new Map<string, Map<string, string[]>>();
  for (const section of sections) {
    const appMap = new Map<string, string[]>();
    for (const appId of config.applications.enabled) {
      appMap.set(appId, resolveScopedSectionConfig(section, appId, scope).enabled);
    }
    sectionAppConfigs.set(section, appMap);
  }

  const cursorSkillsDeduped =
    config.applications.enabled.includes('claude-code') &&
    (sectionAppConfigs.get('skills')?.get('claude-code')?.length ?? 0) > 0;
  console.log(chalk.blue('Inventory:'));
  {
    const sectionPlatforms: Record<string, readonly string[]> = {};
    for (const section of sections) {
      let ids = filterInstalled(getTargetsForSection(section), assumeInstalledSet).map((t) => t.id);
      if (section === 'skills' && cursorSkillsDeduped) {
        ids = ids.filter((id) => id !== 'cursor');
      }
      sectionPlatforms[section] = ids;
    }

    const termWidth = process.stdout.columns || 80;
    const maxSectionLen = Math.max(...sections.map((section) => section.length));
    const maxCountLen = Math.max(
      ...sections.map((section) => `(${getDisplayEnabled(section).length})`.length)
    );
    const prefixPlainLen = 2 + maxSectionLen + 1 + maxCountLen + 2;

    const fitPreview = (ids: string[], maxWidth: number): string => {
      if (ids.length === 0) return chalk.gray('none');
      const full = ids.join(', ');
      if (full.length <= maxWidth) return full;

      let text = '';
      let shown = 0;
      for (let index = 0; index < ids.length; index++) {
        const separator = shown > 0 ? ', ' : '';
        const candidate = text + separator + ids[index];
        const remaining = ids.length - (index + 1);
        if (remaining > 0) {
          const suffix = `, ... (+${remaining} more)`;
          if (candidate.length + suffix.length > maxWidth && shown > 0) {
            const left = ids.length - shown;
            return `${text}${chalk.gray(`, ... (+${left} more)`)}`;
          }
        }
        text = candidate;
        shown++;
      }
      return text;
    };

    for (const section of sections) {
      const displayEnabled = getDisplayEnabled(section);
      const displayCount = displayEnabled.length;

      const supported = new Set(sectionPlatforms[section] ?? []);
      const applicableApps = config.applications.enabled.filter((id) => supported.has(id));

      const allAppConfigs = sectionAppConfigs.get(section) ?? new Map<string, string[]>();
      const effectiveByApp = new Map<string, string[]>();
      for (const appId of applicableApps) {
        effectiveByApp.set(appId, allAppConfigs.get(appId) ?? []);
      }

      const perAppParts = applicableApps.map((appId) => {
        const enabled = effectiveByApp.get(appId) ?? [];
        const delta = enabled.length - displayCount;
        const suffix = delta === 0 ? '' : delta > 0 ? `(+${delta})` : `(${delta})`;
        return `${appId}:${enabled.length}${suffix}`;
      });

      const union = new Set<string>();
      for (const [, ids] of effectiveByApp) {
        for (const id of ids) union.add(id);
      }
      const previewIds = displayEnabled.length > 0 ? [...displayEnabled] : [...union];

      const paddedSection = section.padEnd(maxSectionLen);
      const countStr = `(${displayCount})`.padStart(maxCountLen);
      const appsStr = perAppParts.join('  ');
      console.log(`  ${chalk.cyan(paddedSection)} ${chalk.gray(countStr)}  ${appsStr}`);

      if (previewIds.length > 0) {
        const indent = ' '.repeat(prefixPlainLen);
        const previewWidth = Math.max(20, termWidth - prefixPlainLen - 2);
        const preview = fitPreview(previewIds, previewWidth);
        console.log(`${indent}${chalk.gray('→')} ${preview}`);
      }
    }
  }

  {
    const pluginIndex = buildPluginIndex(scope);
    const enabledPluginRefs = displayPluginRefs;
    if (enabledPluginRefs.length > 0) {
      const names = enabledPluginRefs
        .map((pluginId) => {
          const plugin = pluginIndex.get(pluginId);
          return plugin ? pluginId : chalk.strikethrough(pluginId);
        })
        .join(', ');
      console.log(
        `  ${chalk.magenta('plugins')} ${chalk.gray(`(${enabledPluginRefs.length})`)}  ${names}`
      );
    } else if (!scope?.project && !scope?.profile && pluginIndex.plugins.length > 0) {
      console.log(
        `  ${chalk.magenta('plugins')} ${chalk.gray('(0)')}  ${chalk.gray(`${pluginIndex.plugins.length} available`)}`
      );
    }
  }

  console.log();
  const notes: string[] = [];
  if (cursorSkillsDeduped && config.applications.enabled.includes('cursor')) {
    notes.push('cursor reads skills via claude-code');
  }
  if (config.distribution.use_agents_dir) {
    const agentsMembers = (['codex', 'gemini', 'opencode'] as const).filter((appId) =>
      config.applications.enabled.includes(appId)
    );
    if (agentsMembers.length > 0) {
      notes.push(`skills for ${agentsMembers.join(', ')} sync to shared .agents/skills`);
    }
  }
  for (let index = 0; index < notes.length; index++) {
    const prefix = index === 0 ? '  Note: ' : '        ';
    console.log(chalk.gray(`${prefix}${notes[index]}.`));
  }
  if (notes.length > 0) console.log();

  const activeAppIds = config.applications.enabled;

  // Project-level managed distribution: load manifest and determine mode
  const projectRoot = scope?.project;
  const projectMode = projectRoot ? config.distribution.project.mode : undefined;
  const isManaged = projectRoot != null && projectMode === 'managed';
  let manifest: ProjectDistributionManifest | undefined;
  if (isManaged) {
    const result = loadManifest(projectRoot);
    if (result.corrupt) {
      console.warn(`[asb] Aborting managed sync: corrupt manifest in ${projectRoot}`);
      console.warn('[asb] Fix or remove the manifest before retrying to avoid unsafe cleanup.');
      return true;
    } else {
      manifest = result.manifest;
    }
  }

  const collision = isManaged ? config.distribution.project.collision : undefined;
  const rulesPlacement = isManaged ? config.distribution.project.rules.placement : undefined;

  let mcpDistribution: Awaited<ReturnType<typeof distributeMcp>>;
  let ruleDistribution: ReturnType<typeof distributeRules>;
  let commandDistribution: ReturnType<typeof distributeCommands>;
  let agentDistribution: ReturnType<typeof distributeSubagents>;
  let skillDistribution: ReturnType<typeof distributeSkills>;
  let hookDistribution: ReturnType<typeof distributeHooks>;

  try {
    mcpDistribution = await distributeMcp(scope, undefined, {
      useSpinner: false,
      assumeInstalled: assumeInstalledSet,
      manifest,
      projectMode,
    });
    ruleDistribution = distributeRules(
      {
        activeAppIds,
        assumeInstalled: assumeInstalledSet,
        manifest,
        projectMode,
        rulesPlacement,
      },
      scope
    );
    commandDistribution = distributeCommands(scope, activeAppIds, assumeInstalledSet, {
      manifest,
      projectMode,
      collision,
    });
    agentDistribution = distributeSubagents(scope, activeAppIds, assumeInstalledSet, {
      manifest,
      projectMode,
      collision,
    });
    skillDistribution = distributeSkills(scope, {
      useAgentsDir: config.distribution.use_agents_dir,
      activeAppIds,
      assumeInstalled: assumeInstalledSet,
      manifest,
      projectMode,
      collision,
    });
    hookDistribution = distributeHooks(scope, activeAppIds, assumeInstalledSet);
  } finally {
    // Save manifest even if distribution throws, to preserve partial progress
    if (isManaged && manifest) {
      saveManifest(projectRoot, manifest);
    }
  }

  const distSections: CompactDistributionSection<DistributionResultLike>[] = [
    {
      label: 'mcp',
      results: mcpDistribution,
      emptyMessage: 'none',
      getTargetLabel: (result) => (result as (typeof mcpDistribution)[number]).application,
      getPath: (result) => (result as (typeof mcpDistribution)[number]).filePath,
    },
    {
      label: 'rules',
      results: ruleDistribution.results,
      emptyMessage: 'none',
      getTargetLabel: (result) => (result as (typeof ruleDistribution.results)[number]).agent,
      getPath: (result) => (result as (typeof ruleDistribution.results)[number]).filePath,
    },
    {
      label: 'commands',
      results: commandDistribution.results,
      emptyMessage: 'none',
      getTargetLabel: (result) => (result as (typeof commandDistribution.results)[number]).platform,
      getPath: (result) => (result as (typeof commandDistribution.results)[number]).filePath,
    },
    {
      label: 'agents',
      results: agentDistribution.results,
      emptyMessage: 'none',
      getTargetLabel: (result) => (result as (typeof agentDistribution.results)[number]).platform,
      getPath: (result) => (result as (typeof agentDistribution.results)[number]).filePath,
    },
    {
      label: 'skills',
      results: skillDistribution.results,
      emptyMessage: 'none',
      getTargetLabel: (result) => {
        const skillResult = result as (typeof skillDistribution.results)[number];
        if (skillResult.platform === 'agents') {
          const members = (['codex', 'gemini', 'opencode'] as const).filter((appId) =>
            activeAppIds.includes(appId)
          );
          return members.length > 0 ? members.join('+') : 'agents';
        }
        return skillResult.platform;
      },
      getPath: (result) => (result as (typeof skillDistribution.results)[number]).targetDir,
    },
    {
      label: 'hooks',
      results: hookDistribution.results,
      emptyMessage: 'none',
      getTargetLabel: (result) => (result as (typeof hookDistribution.results)[number]).platform,
      getPath: (result) => {
        const hookResult = result as (typeof hookDistribution.results)[number];
        return 'filePath' in hookResult
          ? hookResult.filePath
          : (hookResult as { targetDir: string }).targetDir;
      },
    },
  ];

  const { hasErrors } = printCompactDistributions(distSections);
  return hasErrors;
}
