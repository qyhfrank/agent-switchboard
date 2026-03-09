import chalk from 'chalk';
import { distributeCommands } from '../commands/distribution.js';
import { resolveEffectiveSectionConfig } from '../config/application-config.js';
import type { ConfigLayers } from '../config/layered-config.js';
import type { SwitchboardConfig } from '../config/schemas.js';
import { type ConfigScope, scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfigWithLayers } from '../config/switchboard-config.js';
import { distributeHooks } from '../hooks/distribution.js';
import { updateRemoteSources } from '../library/sources.js';
import { resetAgentSyncCache } from '../library/state.js';
import { distributeMcp } from '../mcp/distribution.js';
import { buildPluginIndex } from '../plugins/index.js';
import { distributeRules } from '../rules/distribution.js';
import { distributeSkills } from '../skills/distribution.js';
import { distributeSubagents } from '../subagents/distribution.js';
import { initTargets } from '../targets/init.js';
import {
  filterInstalled,
  getTargetById,
  getTargetsForSection,
  registerConfigTargets,
} from '../targets/registry.js';
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
    const remoteResults = updateRemoteSources();
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

  if (scope?.project) {
    const { config: globalConfig, layers: globalLayers } = loadSwitchboardConfigWithLayers(
      scopeToLayerOptions(undefined)
    );
    await initTargets(globalConfig);

    console.log(chalk.blue.bold('── Global ──'));
    const globalErrors = await runSyncPhase({
      scope: undefined,
      config: globalConfig,
      layers: globalLayers,
    });

    console.log();
    resetAgentSyncCache();
    console.log(chalk.blue.bold(`── Project: ${shortenPath(scope.project)} ──`));
    const { config: projectConfig, layers: projectLayers } = loadSwitchboardConfigWithLayers(
      scopeToLayerOptions(scope)
    );
    const projectTargets = (projectConfig as Record<string, unknown>).targets as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (projectTargets && Object.keys(projectTargets).length > 0) {
      registerConfigTargets(projectTargets);
    }
    const projectErrors = await runSyncPhase({
      scope,
      config: projectConfig,
      layers: projectLayers,
    });

    return globalErrors || projectErrors;
  }

  const { config, layers } = loadSwitchboardConfigWithLayers(scopeToLayerOptions(scope));
  await initTargets(config);
  return runSyncPhase({ scope, config, layers });
}

export async function runSyncPhase({ scope, config, layers }: SyncPhaseOptions): Promise<boolean> {
  const activeLayers: string[] = [];
  if (layers.user.exists) activeLayers.push(shortenPath(layers.user.path));
  if (layers.profile?.exists) activeLayers.push(shortenPath(layers.profile.path));
  if (layers.project?.exists) activeLayers.push(shortenPath(layers.project.path));
  console.log(
    `${chalk.blue('Config:')} ${activeLayers.length > 0 ? chalk.dim(activeLayers.join(' + ')) : chalk.gray('no config files')}`
  );

  const assumeInstalledSet = new Set(config.applications.assume_installed);
  const appsLabel =
    config.applications.active.length > 0
      ? config.applications.active
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

  const cursorSkillsDeduped =
    config.applications.active.includes('claude-code') &&
    resolveEffectiveSectionConfig('skills', 'claude-code', scope).enabled.length > 0;
  console.log(chalk.blue('Inventory:'));
  {
    const sections = ['mcp', 'rules', 'commands', 'agents', 'skills', 'hooks'] as const;

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
      ...sections.map((section) => `(${config[section].enabled.length})`.length)
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
      const globalActive = config[section].enabled;
      const globalCount = globalActive.length;

      const supported = new Set(sectionPlatforms[section] ?? []);
      const applicableApps = config.applications.active.filter((id) => supported.has(id));

      const effectiveByApp = new Map<string, string[]>();
      for (const appId of applicableApps) {
        effectiveByApp.set(appId, resolveEffectiveSectionConfig(section, appId, scope).enabled);
      }

      const perAppParts = applicableApps.map((appId) => {
        const enabled = effectiveByApp.get(appId) ?? [];
        const delta = enabled.length - globalCount;
        const suffix = delta === 0 ? '' : delta > 0 ? `(+${delta})` : `(${delta})`;
        return `${appId}:${enabled.length}${suffix}`;
      });

      const union = new Set<string>();
      for (const [, ids] of effectiveByApp) {
        for (const id of ids) union.add(id);
      }
      const previewIds = globalActive.length > 0 ? [...globalActive] : [...union];

      const paddedSection = section.padEnd(maxSectionLen);
      const countStr = `(${globalCount})`.padStart(maxCountLen);
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
    const pluginIndex = buildPluginIndex();
    const enabledPluginRefs = config.plugins.enabled;
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
    } else if (pluginIndex.plugins.length > 0) {
      console.log(
        `  ${chalk.magenta('plugins')} ${chalk.gray('(0)')}  ${chalk.gray(`${pluginIndex.plugins.length} available`)}`
      );
    }
  }

  console.log();
  const notes: string[] = [];
  if (cursorSkillsDeduped && config.applications.active.includes('cursor')) {
    notes.push('cursor reads skills via claude-code');
  }
  if (config.distribution.use_agents_dir) {
    const agentsMembers = (['codex', 'gemini', 'opencode'] as const).filter((appId) =>
      config.applications.active.includes(appId)
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

  const activeAppIds = config.applications.active;
  const mcpDistribution = await distributeMcp(scope, undefined, {
    useSpinner: false,
    assumeInstalled: assumeInstalledSet,
  });
  const ruleDistribution = distributeRules(
    undefined,
    { activeAppIds, assumeInstalled: assumeInstalledSet },
    scope
  );
  const commandDistribution = distributeCommands(scope, activeAppIds, assumeInstalledSet);
  const agentDistribution = distributeSubagents(scope, activeAppIds, assumeInstalledSet);
  const skillDistribution = distributeSkills(scope, {
    useAgentsDir: config.distribution.use_agents_dir,
    activeAppIds,
    assumeInstalled: assumeInstalledSet,
  });
  const hookDistribution = distributeHooks(scope, activeAppIds, assumeInstalledSet);

  const distSections: CompactDistributionSection<DistributionResultLike>[] = [
    {
      label: 'mcp',
      results: mcpDistribution,
      emptyMessage: 'no apps configured',
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
