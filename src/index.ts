#!/usr/bin/env node

/**
 * Agent Switchboard CLI Entry Point
 * Unified MCP server manager for AI coding agents
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';

import { getAgentById } from './agents/registry.js';
import type { CommandPlatform as CmdPlatform } from './commands/distribution.js';
import { distributeCommands } from './commands/distribution.js';
import { importCommandFromFile } from './commands/importer.js';

import type { CommandInventoryRow } from './commands/inventory.js';
import { buildCommandInventory } from './commands/inventory.js';
import { resolveAgentSectionConfig } from './config/agent-config.js';
import { loadMcpConfig, stripLegacyEnabledFlagsFromMcpJson } from './config/mcp-config.js';
import {
  getAgentsHome,
  getClaudeDir,
  getCodexDir,
  getCommandsDir,
  getGeminiDir,
  getOpencodePath,
  getSkillsDir,
  getSubagentsDir,
} from './config/paths.js';
import type { ConfigScope } from './config/scope.js';
import {
  loadSwitchboardConfig,
  loadSwitchboardConfigWithLayers,
} from './config/switchboard-config.js';
import { ensureLibraryDirectories, writeFileSecure } from './library/fs.js';
import { loadMcpActiveState, saveMcpActiveState } from './library/state.js';
import {
  addSubscription,
  getSubscriptions,
  removeSubscription,
  validateSubscriptionPath,
} from './library/subscriptions.js';
import { RULE_SUPPORTED_AGENTS } from './rules/agents.js';
import { composeActiveRules } from './rules/composer.js';
import { distributeRules, listUnsupportedAgents } from './rules/distribution.js';
import { buildRuleInventory } from './rules/inventory.js';
import { loadRuleLibrary } from './rules/library.js';
import { loadRuleState, updateRuleState } from './rules/state.js';
import { distributeSkills } from './skills/distribution.js';
import type { SkillImportPlatform } from './skills/importer.js';
import { importSkill, listSkillsInDirectory } from './skills/importer.js';
import { buildSkillInventory } from './skills/inventory.js';
import type { SubagentPlatform as SubPlatform } from './subagents/distribution.js';
import { distributeSubagents } from './subagents/distribution.js';
import { importSubagentFromFile } from './subagents/importer.js';
import { buildSubagentInventory } from './subagents/inventory.js';

import { showCommandSelector } from './ui/command-ui.js';
import { showMcpServerUI } from './ui/mcp-ui.js';
import { showRuleSelector } from './ui/rule-ui.js';
import { showSkillSelector } from './ui/skill-ui.js';
import { showSubagentSelector } from './ui/subagent-ui.js';
import {
  printActiveSelection,
  printAgentSyncStatus,
  printDistributionResults,
  printTable,
} from './util/cli.js';

const program = new Command();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));

program
  .name('asb')
  .description('Unified MCP server manager for AI coding agents')
  .version(packageJson.version);

// Initialize library directories for commands/subagents (secure permissions)
ensureLibraryDirectories();

program
  .command('sync')
  .description(
    'Synchronize active MCP servers, rules, commands, subagents, and skills to agent targets'
  )
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action(async (options: ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const loadOptions = scopeToLoadOptions(scope);
      const { config, layers } = loadSwitchboardConfigWithLayers(loadOptions);

      console.log();
      console.log(
        `${chalk.bgRed.white(' WARNING ')} ${chalk.red(
          '`asb sync` overwrites target files without diff checks.'
        )}`
      );
      console.log(chalk.red('Proceeding with synchronization...'));
      console.log();

      console.log(chalk.blue('Configuration layers:'));
      const layerEntries: Array<{
        label: string;
        exists: boolean;
        path: string;
      }> = [
        { label: 'User', exists: layers.user.exists, path: layers.user.path },
        {
          label: 'Profile',
          exists: layers.profile?.exists === true,
          path: layers.profile?.path ?? '(none)',
        },
        {
          label: 'Project',
          exists: layers.project?.exists === true,
          path: layers.project?.path ?? '(none)',
        },
      ];
      for (const entry of layerEntries) {
        const marker = entry.exists ? chalk.green('✓') : chalk.gray('•');
        const pathLabel = entry.exists ? chalk.dim(entry.path) : chalk.gray(entry.path);
        console.log(`  ${marker} ${entry.label}: ${pathLabel}`);
      }
      console.log();

      console.log(chalk.blue('Active selections:'));
      console.log(`  MCP servers: ${chalk.cyan(String(config.mcp.active.length))}`);
      console.log(`  Rules: ${chalk.cyan(String(config.rules.active.length))}`);
      console.log(`  Commands: ${chalk.cyan(String(config.commands.active.length))}`);
      console.log(`  Subagents: ${chalk.cyan(String(config.subagents.active.length))}`);
      console.log(`  Skills: ${chalk.cyan(String(config.skills.active.length))}`);
      if (config.agents.active.length > 0) {
        console.log(`  Agents: ${chalk.cyan(config.agents.active.join(', '))}`);
      } else {
        console.log(`  Agents: ${chalk.gray('none configured')}`);
      }
      console.log();

      // Sync MCP servers to agents
      console.log(chalk.blue('MCP server distribution:'));
      await applyToAgents(scope);

      const ruleDistribution = distributeRules(undefined, { force: true }, scope);
      const commandDistribution = distributeCommands(scope);
      const subagentDistribution = distributeSubagents(scope);
      const skillDistribution = distributeSkills(scope, {
        useAgentsDir: config.distribution.use_agents_dir,
      });

      const ruleErrors = ruleDistribution.results.filter((result) => result.status === 'error');
      const commandErrors = commandDistribution.results.filter(
        (result) => result.status === 'error'
      );
      const subagentErrors = subagentDistribution.results.filter(
        (result) => result.status === 'error'
      );
      const skillErrors = skillDistribution.results.filter((result) => result.status === 'error');

      printDistributionResults({
        title: 'Rule distribution',
        results: ruleDistribution.results,
        emptyMessage: 'no supported agents configured',
        getTargetLabel: (result) => result.agent,
        getPath: (result) => result.filePath,
      });
      console.log();

      printDistributionResults({
        title: 'Command distribution',
        results: commandDistribution.results,
        emptyMessage: 'no active commands',
        getTargetLabel: (result) => result.platform,
        getPath: (result) => result.filePath,
      });
      console.log();

      printDistributionResults({
        title: 'Subagent distribution',
        results: subagentDistribution.results,
        emptyMessage: 'no active subagents',
        getTargetLabel: (result) => result.platform,
        getPath: (result) => result.filePath,
      });
      console.log();

      printDistributionResults({
        title: 'Skill distribution',
        results: skillDistribution.results,
        emptyMessage: 'no active skills',
        getTargetLabel: (result) =>
          result.platform === 'agents' ? 'codex+gemini+opencode' : result.platform,
        getPath: (result) => result.targetDir,
      });
      console.log();

      const hasErrors =
        ruleErrors.length > 0 ||
        commandErrors.length > 0 ||
        subagentErrors.length > 0 ||
        skillErrors.length > 0;
      if (hasErrors) {
        console.log(chalk.red('✗ Synchronization completed with errors.'));
        process.exit(1);
      } else {
        console.log(chalk.green('✓ Synchronization complete.'));
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

function isDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

interface ScopeOptionInput {
  profile?: string;
  project?: string;
}

function resolveScope(input?: ScopeOptionInput): ConfigScope | undefined {
  if (!input) return undefined;
  const profile = input.profile?.trim();
  const projectRaw = input.project?.trim();
  const project = projectRaw && projectRaw.length > 0 ? path.resolve(projectRaw) : undefined;
  if (!profile && !project) return undefined;
  return {
    profile: profile && profile.length > 0 ? profile : undefined,
    project: project,
  };
}

function scopeToLoadOptions(scope?: ConfigScope) {
  return scope
    ? {
        profile: scope.profile ?? undefined,
        projectPath: scope.project ?? undefined,
      }
    : undefined;
}

function defaultCommandSourceDir(platform: CmdPlatform): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'commands');
    case 'codex':
      return path.join(getCodexDir(), 'prompts');
    case 'gemini':
      return path.join(getGeminiDir(), 'commands');
    case 'opencode':
      return getOpencodePath('command');
  }
}

function defaultSubagentSourceDir(platform: SubPlatform): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'agents');
    case 'opencode':
      return getOpencodePath('agent');
  }
}

function defaultSkillSourceDir(platform: SkillImportPlatform): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'skills');
    case 'codex': {
      // Primary: ~/.agents/skills (agentskills.io standard, Codex v0.94+)
      const primary = path.join(getAgentsHome(), '.agents', 'skills');
      if (fs.existsSync(primary)) return primary;
      // Fallback: ~/.codex/skills (legacy, still scanned for compatibility)
      const legacy = path.join(getCodexDir(), 'skills');
      if (fs.existsSync(legacy)) return legacy;
      return primary;
    }
  }
}

function listFilesRecursively(root: string, filterExts: string[]): string[] {
  const out: string[] = [];
  const exts = new Set(filterExts.map((e) => e.toLowerCase()));
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext)) out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

async function confirmOverwrite(filePath: string, force?: boolean): Promise<boolean> {
  if (!fs.existsSync(filePath)) return true;
  if (force) return true;
  return await confirm({ message: `File exists: ${filePath}. Overwrite?`, default: false });
}

program
  .command('mcp')
  .description('Interactive UI to enable/disable MCP servers')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action(async (options: ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const { config, layers } = loadSwitchboardConfigWithLayers(scopeToLoadOptions(scope));
      const mcpConfig = loadMcpConfig();

      // Determine initial selection:
      // - If writing to project/profile scope, only use that layer's explicit [mcp].active (no fallback).
      // - If writing to user scope and [mcp].active is missing, fall back to legacy mcp.json enabled flags.
      let currentActive: string[] = [];
      if (scope?.project) {
        const projectActive = layers.project?.config?.mcp?.active;
        currentActive = Array.isArray(projectActive) ? [...projectActive] : [];
      } else if (scope?.profile) {
        const profileActive = layers.profile?.config?.mcp?.active;
        currentActive = Array.isArray(profileActive) ? [...profileActive] : [];
      } else {
        const userActive = layers.user.config?.mcp?.active;
        if (Array.isArray(userActive)) {
          currentActive = [...userActive];
        } else {
          // Read from legacy mcp.json enabled flags
          currentActive = Object.entries(mcpConfig.mcpServers)
            .filter(([, server]) => (server as Record<string, unknown>).enabled === true)
            .map(([name]) => name);
        }
      }

      // Step 1: Show UI and get selected servers
      const selectedServers = await showMcpServerUI({
        pageSize: config.ui.page_size,
        enabled: currentActive,
      });

      // Step 2: Save active state to config.toml (appropriate layer based on scope)
      const spinner = ora('Updating MCP configuration...').start();
      saveMcpActiveState(selectedServers, scope);
      const layerName = scope?.project
        ? 'project .asb.toml'
        : scope?.profile
          ? `profile ${scope.profile}.toml`
          : 'config.toml';
      spinner.succeed(chalk.green(`✓ Updated ${layerName} [mcp].active`));

      // After user-level write, strip legacy enabled flags from mcp.json (definition-only file).
      if (!scope?.profile && !scope?.project) {
        const cleaned = stripLegacyEnabledFlagsFromMcpJson();
        if (cleaned) {
          console.log(chalk.green('✓ Removed legacy "enabled" flags from mcp.json'));
        }
      }

      // Step 3: Apply to registered agents
      await applyToAgents(scope, selectedServers);

      // Step 4: Show summary
      showSummary(selectedServers, scope);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

const ruleCommand = program
  .command('rule')
  .description('Manage rule snippets and synchronization')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

ruleCommand
  .command('list')
  .description('Display rule snippets and sync information')
  .option('--json', 'Output inventory as JSON')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: { json?: boolean } & ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const inventory = buildRuleInventory(scope);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              snippets: inventory.snippets,
              agentSync: inventory.state.agentSync,
              activeOrder: inventory.state.active,
            },
            null,
            2
          )
        );
        return;
      }

      if (inventory.snippets.length === 0) {
        console.log(chalk.yellow('⚠ No rule snippets found. Use `asb rule` to add selections.'));
      } else {
        console.log(chalk.blue('Rule snippets:'));
        const header = ['Order', 'ID', 'Active', 'Title', 'Tags', 'Requires'];
        const rows = inventory.snippets.map((row) => {
          const orderPlain = row.active && typeof row.order === 'number' ? String(row.order) : '—';
          const idPlain = row.missing ? `${row.id} (missing)` : row.id;
          const activePlain = row.active ? 'yes' : 'no';
          const titlePlain = row.title ?? '—';
          const tagsPlain = row.tags.length > 0 ? row.tags.join(', ') : '—';
          const requiresPlain = row.requires.length > 0 ? row.requires.join(', ') : '—';

          return [
            { plain: orderPlain, formatted: orderPlain },
            {
              plain: idPlain,
              formatted: row.missing ? chalk.red(idPlain) : idPlain,
            },
            {
              plain: activePlain,
              formatted: row.active ? chalk.green(activePlain) : chalk.gray(activePlain),
            },
            { plain: titlePlain, formatted: titlePlain },
            { plain: tagsPlain, formatted: tagsPlain },
            { plain: requiresPlain, formatted: requiresPlain },
          ];
        });
        printTable(header, rows);
      }

      console.log();
      printAgentSyncStatus({
        agentSync: inventory.state.agentSync,
        agents: RULE_SUPPORTED_AGENTS,
      });

      const unsupportedAgents = listUnsupportedAgents();
      if (unsupportedAgents.length > 0) {
        console.log();
        console.log(
          chalk.gray(`Unsupported agents (manual update required): ${unsupportedAgents.join(', ')}`)
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

ruleCommand.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showRuleSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) {
      return;
    }

    const rules = loadRuleLibrary();
    const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));

    const previousState = loadRuleState(scope);
    const desiredActive = selection.active;

    const arraysEqual = (a: string[], b: string[]): boolean => {
      if (a.length !== b.length) return false;
      return a.every((value, index) => value === b[index]);
    };

    const selectionChanged = !arraysEqual(previousState.active, desiredActive);

    const updatedState = updateRuleState((current) => {
      if (!selectionChanged) {
        return current;
      }
      return {
        ...current,
        active: desiredActive,
        agentSync: {},
      };
    }, scope);

    if (!selectionChanged) {
      console.log(chalk.gray('\nNo changes to active rules. Refreshing agent files...'));
    } else {
      console.log();
      if (updatedState.active.length === 0) {
        console.log(
          chalk.yellow(
            '⚠ Active rule set cleared. Agents will receive empty instructions on next sync.'
          )
        );
      } else {
        console.log(chalk.green('✓ Updated active rule order:'));
        for (const [index, id] of updatedState.active.entries()) {
          const rule = ruleMap.get(id);
          const title = rule?.metadata.title?.trim();
          const name = title && title.length > 0 ? title : id;
          const suffix = title && title.length > 0 ? chalk.gray(` (${id})`) : '';
          console.log(`  ${index + 1}. ${chalk.cyan(name)}${suffix}`);
        }
      }
    }

    const distribution = distributeRules(
      composeActiveRules(scope),
      { force: !selectionChanged },
      scope
    );

    if (distribution.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Rule distribution',
        results: distribution.results,
        getTargetLabel: (result) => result.agent,
        getPath: (result) => result.filePath,
      });
    }

    const distributionErrors = distribution.results.filter((r) => r.status === 'error');
    if (distributionErrors.length > 0) {
      process.exit(1);
    }

    const unsupportedAgents = listUnsupportedAgents();
    if (unsupportedAgents.length > 0) {
      console.log();
      console.log(
        chalk.gray(`Unsupported agents (manual update required): ${unsupportedAgents.join(', ')}`)
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

// Commands library: manage and distribute commands
const commandRoot = program
  .command('command')
  .description('Manage command library')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

commandRoot.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showCommandSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) return;
    console.log();
    printActiveSelection('commands', selection.active);

    const out = distributeCommands(scope);
    if (out.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Command distribution',
        results: out.results,
        getTargetLabel: (result) => result.platform,
        getPath: (result) => result.filePath,
      });
    }
    // Guidance: unsupported platforms for commands
    console.log();
    console.log(
      chalk.gray('Unsupported platforms (manual steps required): Claude Desktop, Cursor')
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

// Commands library: load (import) existing platform files into library
commandRoot
  .command('load')
  .description('Import existing platform files into the command library')
  .argument('<platform>', 'claude-code | codex | gemini | opencode')
  .argument('[path]', 'Source file or directory (defaults by platform)')
  .option('-r, --recursive', 'When [path] is a directory, import files recursively')
  .option('-f, --force', 'Overwrite existing library files without confirmation')
  .action(
    async (
      platform: CmdPlatform,
      srcPath: string | undefined,
      opts: { recursive?: boolean; force?: boolean }
    ) => {
      try {
        const exts = platform === 'gemini' ? ['.toml'] : ['.md', '.markdown'];
        const source =
          srcPath && srcPath.trim().length > 0 ? srcPath : defaultCommandSourceDir(platform);
        if (!fs.existsSync(source)) {
          console.error(chalk.red(`\n✗ Source not found: ${source}`));
          process.exit(1);
        }

        const inputs: string[] = [];
        if (isFile(source)) {
          inputs.push(source);
        } else if (isDir(source)) {
          if (!opts.recursive) {
            console.error(
              chalk.red('\n✗ Source is a directory. Use -r/--recursive to import recursively.')
            );
            process.exit(1);
          }
          inputs.push(...listFilesRecursively(source, exts));
        }

        if (inputs.length === 0) {
          console.log(chalk.yellow('\n⚠ No files to import.'));
          return;
        }

        const outDir = getCommandsDir();
        let imported = 0;
        for (const file of inputs) {
          try {
            const { slug, content } = importCommandFromFile(platform, file);
            const target = path.join(outDir, `${slug}.md`);
            if (!(await confirmOverwrite(target, opts.force))) continue;
            writeFileSecure(target, content);
            imported++;
            console.log(`${chalk.green('✓')} ${chalk.cyan(slug)} → ${chalk.dim(target)}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`${chalk.red('✗')} ${chalk.dim(file)} ${chalk.red(msg)}`);
          }
        }

        console.log(`\n${chalk.green('✓')} Imported ${imported} file(s) into command library.`);
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`\n✗ Error: ${error.message}`));
        }
        process.exit(1);
      }
    }
  );

// Commands library: list inventory
commandRoot
  .command('list')
  .description('Display command inventory and sync information')
  .option('--json', 'Output inventory as JSON')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: { json?: boolean } & ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const inventory = buildCommandInventory(scope);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              entries: inventory.entries,
              agentSync: inventory.state.agentSync,
              active: inventory.state.active,
            },
            null,
            2
          )
        );
        return;
      }

      if (inventory.entries.length === 0) {
        console.log(chalk.yellow('⚠ No commands found. Use `asb command load <platform> [path]`.'));
      } else {
        console.log(chalk.blue('Commands:'));
        const header = ['ID', 'Active', 'Title', 'Model', 'Extras'];
        const rows = inventory.entries.map((row: CommandInventoryRow) => {
          const activePlain = row.active ? 'yes' : 'no';
          const titlePlain = row.title ?? '—';
          const modelPlain = row.model ?? '—';
          const extrasPlain = row.extrasKeys.length > 0 ? row.extrasKeys.join(', ') : '—';
          return [
            { plain: row.id, formatted: row.id },
            {
              plain: activePlain,
              formatted: row.active ? chalk.green(activePlain) : chalk.gray(activePlain),
            },
            { plain: titlePlain, formatted: titlePlain },
            { plain: modelPlain, formatted: modelPlain },
            { plain: extrasPlain, formatted: extrasPlain },
          ];
        });
        printTable(header, rows);
      }

      console.log();
      printAgentSyncStatus({ agentSync: inventory.state.agentSync });

      // Guidance: unsupported platforms for commands
      console.log();
      console.log(
        chalk.gray('Unsupported platforms (manual steps required): Claude Desktop, Cursor')
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

// Subagents library: scaffold, load, list, and interactive distribute
const subagentRoot = program
  .command('subagent')
  .description('Manage subagent (persona) library')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

subagentRoot.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showSubagentSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) return;
    console.log();
    printActiveSelection('subagents', selection.active);

    const out = distributeSubagents(scope);
    if (out.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Subagent distribution',
        results: out.results,
        getTargetLabel: (result) => result.platform,
        getPath: (result) => result.filePath,
      });
    }

    // Guidance: unsupported platforms for subagents
    console.log();
    console.log(chalk.gray('Unsupported platforms (manual steps required): Codex, Gemini'));
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

subagentRoot
  .command('list')
  .description('Display subagent inventory and sync information')
  .option('--json', 'Output inventory as JSON')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: { json?: boolean } & ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const inventory = buildSubagentInventory(scope);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              entries: inventory.entries,
              agentSync: inventory.state.agentSync,
              activeOrder: inventory.state.active,
            },
            null,
            2
          )
        );
        return;
      }

      if (inventory.entries.length === 0) {
        console.log(
          chalk.yellow('⚠ No subagents found. Use `asb subagent load <platform> [path]`.')
        );
      } else {
        console.log(chalk.blue('Subagents:'));
        const header = ['ID', 'Active', 'Title', 'Model', 'Tools', 'Extras'];
        const rows = inventory.entries.map((row) => {
          const activePlain = row.active ? 'yes' : 'no';
          const titlePlain = row.title ?? '—';
          const modelPlain = row.model ?? '—';
          const toolsPlain = row.tools.length > 0 ? row.tools.join(', ') : '—';
          const extrasPlain = row.extrasKeys.length > 0 ? row.extrasKeys.join(', ') : '—';
          return [
            { plain: row.id, formatted: row.id },
            {
              plain: activePlain,
              formatted: row.active ? chalk.green(activePlain) : chalk.gray(activePlain),
            },
            { plain: titlePlain, formatted: titlePlain },
            { plain: modelPlain, formatted: modelPlain },
            { plain: toolsPlain, formatted: toolsPlain },
            { plain: extrasPlain, formatted: extrasPlain },
          ];
        });
        printTable(header, rows);
      }

      console.log();
      printAgentSyncStatus({ agentSync: inventory.state.agentSync });

      // Guidance: unsupported platforms for subagents
      console.log();
      console.log(chalk.gray('Unsupported platforms (manual steps required): Codex, Gemini'));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

subagentRoot
  .command('load')
  .description('Import existing platform files into the subagent library')
  .argument('<platform>', 'claude-code | opencode')
  .argument('[path]', 'Source file or directory (defaults by platform)')
  .option('-r, --recursive', 'When [path] is a directory, import files recursively')
  .option('-f, --force', 'Overwrite existing library files without confirmation')
  .action(
    async (
      platform: SubPlatform,
      srcPath: string | undefined,
      opts: { recursive?: boolean; force?: boolean }
    ) => {
      try {
        const exts = ['.md', '.markdown'];
        const source =
          srcPath && srcPath.trim().length > 0 ? srcPath : defaultSubagentSourceDir(platform);
        if (!fs.existsSync(source)) {
          console.error(chalk.red(`\n✗ Source not found: ${source}`));
          process.exit(1);
        }

        const inputs: string[] = [];
        if (isFile(source)) {
          inputs.push(source);
        } else if (isDir(source)) {
          if (!opts.recursive) {
            console.error(
              chalk.red('\n✗ Source is a directory. Use -r/--recursive to import recursively.')
            );
            process.exit(1);
          }
          inputs.push(...listFilesRecursively(source, exts));
        }

        if (inputs.length === 0) {
          console.log(chalk.yellow('\n⚠ No files to import.'));
          return;
        }

        const outDir = getSubagentsDir();
        let imported = 0;
        for (const file of inputs) {
          try {
            const { slug, content } = importSubagentFromFile(platform, file);
            const target = path.join(outDir, `${slug}.md`);
            if (!(await confirmOverwrite(target, opts.force))) continue;
            writeFileSecure(target, content);
            imported++;
            console.log(`${chalk.green('✓')} ${chalk.cyan(slug)} → ${chalk.dim(target)}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`${chalk.red('✗')} ${chalk.dim(file)} ${chalk.red(msg)}`);
          }
        }

        console.log(`\n${chalk.green('✓')} Imported ${imported} file(s) into subagent library.`);
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`\n✗ Error: ${error.message}`));
        }
        process.exit(1);
      }
    }
  );

// Skills library: manage and distribute skill bundles
const skillRoot = program
  .command('skill')
  .description('Manage skill library')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

skillRoot.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showSkillSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) return;
    console.log();
    printActiveSelection('skills', selection.active);

    const out = distributeSkills(scope, {
      useAgentsDir: config.distribution.use_agents_dir,
    });
    if (out.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Skill distribution',
        results: out.results,
        getTargetLabel: (result) =>
          result.platform === 'agents' ? 'codex+gemini+opencode' : result.platform,
        getPath: (result) => result.targetDir,
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

skillRoot
  .command('list')
  .description('Display skill inventory and sync information')
  .option('--json', 'Output inventory as JSON')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: { json?: boolean } & ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const inventory = buildSkillInventory(scope);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              entries: inventory.entries,
              agentSync: inventory.state.agentSync,
              active: inventory.state.active,
            },
            null,
            2
          )
        );
        return;
      }

      if (inventory.entries.length === 0) {
        console.log(chalk.yellow('⚠ No skills found. Use `asb skill load <platform> [path]`.'));
      } else {
        console.log(chalk.blue('Skills:'));
        const header = ['ID', 'Active', 'Name', 'Description'];
        const rows = inventory.entries.map((row) => {
          const activePlain = row.active ? 'yes' : 'no';
          const descPlain =
            row.description.length > 50
              ? `${row.description.substring(0, 47)}...`
              : row.description;
          return [
            { plain: row.id, formatted: row.id },
            {
              plain: activePlain,
              formatted: row.active ? chalk.green(activePlain) : chalk.gray(activePlain),
            },
            { plain: row.name, formatted: row.name },
            { plain: descPlain, formatted: descPlain },
          ];
        });
        printTable(header, rows);
      }

      console.log();
      printAgentSyncStatus({ agentSync: inventory.state.agentSync });

      // Guidance: all skill-capable platforms are supported via claude-code + agents targets
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

skillRoot
  .command('load')
  .description('Import existing platform skill directories into the skill library')
  .argument('<platform>', 'claude-code | codex')
  .argument('[path]', 'Source directory (defaults by platform)')
  .option('-f, --force', 'Overwrite existing library directories without confirmation')
  .action(
    async (
      platform: SkillImportPlatform,
      srcPath: string | undefined,
      opts: { force?: boolean }
    ) => {
      try {
        const source =
          srcPath && srcPath.trim().length > 0 ? srcPath : defaultSkillSourceDir(platform);
        if (!fs.existsSync(source)) {
          console.error(chalk.red(`\n✗ Source not found: ${source}`));
          process.exit(1);
        }

        if (!isDir(source)) {
          console.error(chalk.red('\n✗ Source must be a directory containing skill folders.'));
          process.exit(1);
        }

        const skillIds = listSkillsInDirectory(source);

        if (skillIds.length === 0) {
          console.log(
            chalk.yellow('\n⚠ No skills to import (no SKILL.md found in subdirectories).')
          );
          return;
        }

        const outDir = getSkillsDir();
        let imported = 0;
        let skipped = 0;

        for (const id of skillIds) {
          const result = importSkill(platform, source, id, { force: opts.force });

          if (result.status === 'success') {
            imported++;
            console.log(
              `${chalk.green('✓')} ${chalk.cyan(result.skill.name)} → ${chalk.dim(result.skill.targetPath)}`
            );
          } else if (result.status === 'skipped') {
            skipped++;
            console.log(`${chalk.gray('•')} ${chalk.cyan(id)} ${chalk.gray(`(${result.reason})`)}`);
          } else {
            console.log(
              `${chalk.red('✗')} ${chalk.cyan(id)} ${chalk.red(result.error ?? 'unknown error')}`
            );
          }
        }

        console.log();
        if (imported > 0) {
          console.log(
            `${chalk.green('✓')} Imported ${imported} skill(s) into ${chalk.dim(outDir)}`
          );
        }
        if (skipped > 0) {
          console.log(
            chalk.gray(`  ${skipped} skill(s) skipped (already exist, use --force to overwrite)`)
          );
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`\n✗ Error: ${error.message}`));
        }
        process.exit(1);
      }
    }
  );

/**
 * Apply enabled MCP servers to all registered agents
 * @param scope - Configuration scope (profile/project)
 * @param enabledServerNames - List of enabled server names
 */
async function applyToAgents(scope?: ConfigScope, enabledServerNames?: string[]): Promise<void> {
  const mcpConfig = loadMcpConfig();
  const switchboardConfig = loadSwitchboardConfig(scopeToLoadOptions(scope));

  if (switchboardConfig.agents.active.length === 0) {
    console.log(chalk.yellow('\n⚠ No agents found in the active configuration stack.'));
    console.log();
    console.log('Add agents under the relevant TOML layer (user, profile, or project).');
    console.log(chalk.dim('  Example: [agents]\n  active = ["claude-code", "cursor"]'));
    return;
  }

  // Global MCP servers list (from UI selection or config)
  const globalMcpServers = enabledServerNames ?? loadMcpActiveState(scope);

  // Apply to each registered agent with per-agent MCP overrides
  for (const agentId of switchboardConfig.agents.active) {
    const spinner = ora({ indent: 2 }).start(`Applying to ${agentId}...`);
    const persist = (symbol: string, text: string) =>
      spinner.stopAndPersist({ symbol: `  ${symbol}`, text });

    try {
      // Get per-agent MCP config (applies add/remove overrides)
      const agentMcpConfig = resolveAgentSectionConfig('mcp', agentId, scope);
      // If user selected servers via UI, use that as base; otherwise use per-agent resolved config
      const agentActiveServers = enabledServerNames
        ? agentMcpConfig.active.filter((s) => globalMcpServers.includes(s))
        : agentMcpConfig.active;

      // Filter to only enabled servers for this agent
      const activeSet = new Set(agentActiveServers);
      const enabledServers = Object.fromEntries(
        Object.entries(mcpConfig.mcpServers).filter(([name]) => activeSet.has(name))
      );
      const configToApply = { mcpServers: enabledServers };

      const agent = getAgentById(agentId);

      // Use project-level config when --project is specified
      if (scope?.project && agent.applyProjectConfig) {
        agent.applyProjectConfig(scope.project, configToApply);
        const projectPath = agent.projectConfigPath?.(scope.project) ?? 'project config';
        persist(chalk.green('✓'), `${chalk.cyan(agentId)} ${chalk.dim(projectPath)}`);
      } else {
        agent.applyConfig(configToApply);
        persist(chalk.green('✓'), `${chalk.cyan(agentId)} ${chalk.dim(agent.configPath())}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        persist(chalk.yellow('⚠'), `${chalk.cyan(agentId)} - ${error.message} (skipped)`);
      }
    }
  }
}

/**
 * Show summary of enabled/disabled servers and applied agents
 */
function showSummary(selectedServers: string[], scope?: ConfigScope): void {
  const mcpConfig = loadMcpConfig();
  const allServers = Object.keys(mcpConfig.mcpServers);

  const enabledServers = selectedServers;
  const disabledServers = allServers.filter((s) => !selectedServers.includes(s));

  console.log();
  console.log(chalk.blue('Summary:'));

  if (enabledServers.length > 0) {
    console.log(chalk.green(`\nEnabled servers (${enabledServers.length}):`));
    for (const server of enabledServers) {
      console.log(`  ${chalk.green('✓')} ${server}`);
    }
  }

  if (disabledServers.length > 0) {
    console.log(chalk.gray(`\nDisabled servers (${disabledServers.length}):`));
    for (const server of disabledServers) {
      console.log(`  ${chalk.gray('✗')} ${server}`);
    }
  }

  const switchboardConfig = loadSwitchboardConfig(scopeToLoadOptions(scope));
  if (switchboardConfig.agents.active.length > 0) {
    console.log(chalk.blue(`\nApplied to agents (${switchboardConfig.agents.active.length}):`));
    for (const agent of switchboardConfig.agents.active) {
      console.log(`  ${chalk.dim('•')} ${agent}`);
    }
  }

  console.log();
}

// Library subscription commands
program
  .command('subscribe')
  .description('Add a library subscription with a namespace')
  .argument('<name>', 'Namespace for this subscription (e.g., "team", "project")')
  .argument('<path>', 'Path to the library directory')
  .action((name: string, libraryPath: string) => {
    try {
      // Validate the path has library structure
      const validation = validateSubscriptionPath(libraryPath);
      if (!validation.valid) {
        console.error(
          chalk.red(
            `\n✗ Path does not contain any library folders (rules/, commands/, subagents/, skills/).`
          )
        );
        process.exit(1);
      }

      addSubscription(name, libraryPath);

      console.log(chalk.green(`\n✓ Subscribed to "${name}" at ${path.resolve(libraryPath)}`));
      console.log(chalk.dim(`  Found: ${validation.found.join(', ')}`));
      if (validation.missing.length > 0) {
        console.log(chalk.dim(`  Missing: ${validation.missing.join(', ')}`));
      }
      console.log();
      console.log(
        chalk.dim('Library entries will now use the namespace prefix, e.g., ') +
          chalk.cyan(`${name}:my-rule`)
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

program
  .command('unsubscribe')
  .description('Remove a library subscription by namespace')
  .argument('<name>', 'Namespace to remove')
  .action((name: string) => {
    try {
      removeSubscription(name);
      console.log(chalk.green(`\n✓ Unsubscribed from "${name}"`));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

program
  .command('subscriptions')
  .description('List all library subscriptions')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    try {
      const subscriptions = getSubscriptions();

      if (options.json) {
        console.log(JSON.stringify(subscriptions, null, 2));
        return;
      }

      if (subscriptions.length === 0) {
        console.log(chalk.yellow('\n⚠ No library subscriptions configured.'));
        console.log(chalk.dim('  Use `asb subscribe <name> <path>` to add one.'));
        return;
      }

      console.log(chalk.blue('\nLibrary subscriptions:'));
      const header = ['Namespace', 'Path', 'Status', 'Contains'];
      const rows = subscriptions.map((sub: { namespace: string; path: string }) => {
        const exists = fs.existsSync(sub.path);
        const validation = exists ? validateSubscriptionPath(sub.path) : { found: [], missing: [] };
        const statusPlain = exists ? 'ok' : 'missing';
        const containsPlain = validation.found.length > 0 ? validation.found.join(', ') : '-';

        return [
          { plain: sub.namespace, formatted: chalk.cyan(sub.namespace) },
          { plain: sub.path, formatted: chalk.dim(sub.path) },
          {
            plain: statusPlain,
            formatted: exists ? chalk.green(statusPlain) : chalk.red(statusPlain),
          },
          { plain: containsPlain, formatted: containsPlain },
        ];
      });
      printTable(header, rows);
      console.log();
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
