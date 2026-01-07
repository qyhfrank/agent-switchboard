#!/usr/bin/env node

/**
 * Agent Switchboard CLI Entry Point
 * Unified MCP server manager for AI coding agents
 */

import fs from 'node:fs';
import path from 'node:path';
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
import { loadMcpConfig, updateEnabledFlags } from './config/mcp-config.js';
import {
  getClaudeDir,
  getCodexDir,
  getCommandsDir,
  getGeminiDir,
  getMcpConfigPath,
  getOpencodePath,
  getSkillsDir,
  getSubagentsDir,
} from './config/paths.js';
import type { McpServer } from './config/schemas.js';
import type { ConfigScope } from './config/scope.js';
import {
  loadSwitchboardConfig,
  loadSwitchboardConfigWithLayers,
} from './config/switchboard-config.js';
import { ensureLibraryDirectories, writeFileSecure } from './library/fs.js';
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
import { formatSyncTimestamp, printTable } from './util/cli.js';

const program = new Command();

program.name('asb').description('Unified MCP server manager for AI coding agents').version('0.1.0');

// Initialize library directories for commands/subagents (secure permissions)
ensureLibraryDirectories();

program
  .command('sync')
  .description('Synchronize active rules, commands, and subagents to agent targets')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: ScopeOptionInput) => {
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
      console.log(`  Rules: ${chalk.cyan(String(config.rules.active.length))}`);
      console.log(`  Commands: ${chalk.cyan(String(config.commands.active.length))}`);
      console.log(`  Subagents: ${chalk.cyan(String(config.subagents.active.length))}`);
      console.log(`  Skills: ${chalk.cyan(String(config.skills.active.length))}`);
      if (config.agents.length > 0) {
        console.log(`  Agents: ${chalk.cyan(config.agents.join(', '))}`);
      } else {
        console.log(`  Agents: ${chalk.gray('none configured')}`);
      }
      console.log();

      const ruleDistribution = distributeRules(undefined, { force: true }, scope);
      const commandDistribution = distributeCommands(scope);
      const subagentDistribution = distributeSubagents(scope);
      const skillDistribution = distributeSkills(scope);

      const ruleErrors = ruleDistribution.results.filter((result) => result.status === 'error');
      const commandErrors = commandDistribution.results.filter(
        (result) => result.status === 'error'
      );
      const subagentErrors = subagentDistribution.results.filter(
        (result) => result.status === 'error'
      );
      const skillErrors = skillDistribution.results.filter((result) => result.status === 'error');

      console.log(chalk.blue('Rule distribution:'));
      for (const result of ruleDistribution.results) {
        const pathLabel = chalk.dim(result.filePath);
        if (result.status === 'written') {
          const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(result.agent)} ${pathLabel}${reason}`);
        } else if (result.status === 'skipped') {
          const reason = result.reason
            ? chalk.gray(` (${result.reason})`)
            : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(result.agent)} ${pathLabel}${reason}`);
        } else {
          const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
          console.log(`  ${chalk.red('✗')} ${chalk.cyan(result.agent)} ${pathLabel}${errorLabel}`);
        }
      }
      if (ruleDistribution.results.length === 0) {
        console.log(`  ${chalk.gray('no supported agents configured')}`);
      }
      console.log();

      console.log(chalk.blue('Command distribution:'));
      if (commandDistribution.results.length === 0) {
        console.log(`  ${chalk.gray('no active commands')}`);
      }
      for (const result of commandDistribution.results) {
        const pathLabel = chalk.dim(result.filePath);
        if (result.status === 'written') {
          const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else if (result.status === 'skipped') {
          const reason = result.reason
            ? chalk.gray(` (${result.reason})`)
            : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else {
          const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
          console.log(
            `  ${chalk.red('✗')} ${chalk.cyan(result.platform)} ${pathLabel}${errorLabel}`
          );
        }
      }
      console.log();

      console.log(chalk.blue('Subagent distribution:'));
      if (subagentDistribution.results.length === 0) {
        console.log(`  ${chalk.gray('no active subagents')}`);
      }
      for (const result of subagentDistribution.results) {
        const pathLabel = chalk.dim(result.filePath);
        if (result.status === 'written') {
          const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else if (result.status === 'skipped') {
          const reason = result.reason
            ? chalk.gray(` (${result.reason})`)
            : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else {
          const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
          console.log(
            `  ${chalk.red('✗')} ${chalk.cyan(result.platform)} ${pathLabel}${errorLabel}`
          );
        }
      }
      console.log();

      console.log(chalk.blue('Skill distribution:'));
      if (skillDistribution.results.length === 0) {
        console.log(`  ${chalk.gray('no active skills')}`);
      }
      for (const result of skillDistribution.results) {
        const pathLabel = chalk.dim(result.targetDir);
        if (result.status === 'written') {
          const reason = result.reason ? chalk.gray(` (${result.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else if (result.status === 'skipped') {
          const reason = result.reason
            ? chalk.gray(` (${result.reason})`)
            : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(result.platform)} ${pathLabel}${reason}`);
        } else {
          const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
          console.log(
            `  ${chalk.red('✗')} ${chalk.cyan(result.platform)} ${pathLabel}${errorLabel}`
          );
        }
      }
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
    case 'codex':
      return path.join(getCodexDir(), 'skills');
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
      const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
      // Step 1: Show UI and get selected servers
      const selectedServers = await showMcpServerUI({ pageSize: config.ui.page_size });

      // Proceed even if no servers are selected: this means disable all.
      // Previous behavior incorrectly bailed out and prevented users from clearing selections.

      // Step 2: Update enabled flags in mcp.json
      const spinner = ora('Updating MCP configuration...').start();
      updateEnabledFlags(selectedServers);
      const cfgPath = getMcpConfigPath();
      spinner.succeed(chalk.green(`✓ Updated ${cfgPath}`));

      // Step 3: Apply to registered agents
      await applyToAgents(scope);

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
      console.log(chalk.blue('Agent sync status:'));
      RULE_SUPPORTED_AGENTS.forEach((agent) => {
        const sync = inventory.state.agentSync[agent];
        const formatted = formatSyncTimestamp(sync?.updatedAt);
        const display = sync?.updatedAt ? formatted : chalk.gray(formatted);
        console.log(`  ${chalk.cyan(agent)} ${chalk.gray('-')} ${display}`);
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
      console.log(chalk.blue('Rule distribution:'));
      for (const result of distribution.results) {
        const pathLabel = chalk.dim(result.filePath);
        if (result.status === 'written') {
          const reasonLabel = result.reason ? chalk.gray(` (${result.reason})`) : '';
          console.log(
            `  ${chalk.green('✓')} ${chalk.cyan(result.agent)} ${pathLabel}${reasonLabel}`
          );
        } else if (result.status === 'skipped') {
          const reasonLabel = result.reason
            ? chalk.gray(` (${result.reason})`)
            : chalk.gray(' (unchanged)');
          console.log(
            `  ${chalk.gray('•')} ${chalk.cyan(result.agent)} ${pathLabel}${reasonLabel}`
          );
        } else {
          const errorLabel = result.error ? ` ${chalk.red(result.error)}` : '';
          console.log(`  ${chalk.red('✗')} ${chalk.cyan(result.agent)} ${pathLabel}${errorLabel}`);
        }
      }
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
    console.log(chalk.green('✓ Updated active commands:'));
    if (selection.active.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
    } else {
      for (const id of selection.active) {
        console.log(`  ${chalk.cyan(id)}`);
      }
    }

    const out = distributeCommands(scope);
    if (out.results.length > 0) {
      console.log();
      console.log(chalk.blue('Command distribution:'));
      for (const r of out.results) {
        const pathLabel = chalk.dim(r.filePath);
        if (r.status === 'written') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else if (r.status === 'skipped') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else {
          const err = r.error ? ` ${chalk.red(r.error)}` : '';
          console.log(`  ${chalk.red('✗')} ${chalk.cyan(r.platform)} ${pathLabel}${err}`);
        }
      }
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
      console.log(chalk.blue('Agent sync status:'));
      const keys = Object.keys(inventory.state.agentSync);
      if (keys.length === 0) {
        console.log(`  ${chalk.gray('no sync recorded')}`);
      } else {
        for (const agent of keys) {
          const sync = inventory.state.agentSync[agent];
          const stamp = formatSyncTimestamp(sync?.updatedAt);
          const display = sync?.updatedAt ? stamp : chalk.gray(stamp);
          console.log(`  ${chalk.cyan(agent)} ${chalk.gray('-')} ${display}`);
        }
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
    console.log(chalk.green('✓ Updated active subagents:'));
    if (selection.active.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
    } else {
      for (const id of selection.active) {
        console.log(`  ${chalk.cyan(id)}`);
      }
    }

    const out = distributeSubagents(scope);
    if (out.results.length > 0) {
      console.log();
      console.log(chalk.blue('Subagent distribution:'));
      for (const r of out.results) {
        const pathLabel = chalk.dim(r.filePath);
        if (r.status === 'written') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else if (r.status === 'skipped') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else {
          const err = r.error ? ` ${chalk.red(r.error)}` : '';
          console.log(`  ${chalk.red('✗')} ${chalk.cyan(r.platform)} ${pathLabel}${err}`);
        }
      }
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
      console.log(chalk.blue('Agent sync status:'));
      const keys = Object.keys(inventory.state.agentSync);
      if (keys.length === 0) {
        console.log(`  ${chalk.gray('no sync recorded')}`);
      } else {
        for (const agent of keys) {
          const sync = inventory.state.agentSync[agent];
          const stamp = formatSyncTimestamp(sync?.updatedAt);
          const display = sync?.updatedAt ? stamp : chalk.gray(stamp);
          console.log(`  ${chalk.cyan(agent)} ${chalk.gray('-')} ${display}`);
        }
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
    console.log(chalk.green('✓ Updated active skills:'));
    if (selection.active.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
    } else {
      for (const id of selection.active) {
        console.log(`  ${chalk.cyan(id)}`);
      }
    }

    const out = distributeSkills(scope);
    if (out.results.length > 0) {
      console.log();
      console.log(chalk.blue('Skill distribution:'));
      for (const r of out.results) {
        const pathLabel = chalk.dim(r.targetDir);
        if (r.status === 'written') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : '';
          console.log(`  ${chalk.green('✓')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else if (r.status === 'skipped') {
          const reason = r.reason ? chalk.gray(` (${r.reason})`) : chalk.gray(' (unchanged)');
          console.log(`  ${chalk.gray('•')} ${chalk.cyan(r.platform)} ${pathLabel}${reason}`);
        } else {
          const err = r.error ? ` ${chalk.red(r.error)}` : '';
          console.log(`  ${chalk.red('✗')} ${chalk.cyan(r.platform)} ${pathLabel}${err}`);
        }
      }
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
      console.log(chalk.blue('Agent sync status:'));
      const keys = Object.keys(inventory.state.agentSync);
      if (keys.length === 0) {
        console.log(`  ${chalk.gray('no sync recorded')}`);
      } else {
        for (const agent of keys) {
          const sync = inventory.state.agentSync[agent];
          const stamp = formatSyncTimestamp(sync?.updatedAt);
          const display = sync?.updatedAt ? stamp : chalk.gray(stamp);
          console.log(`  ${chalk.cyan(agent)} ${chalk.gray('-')} ${display}`);
        }
      }

      // Guidance: unsupported platforms for skills
      console.log();
      console.log(chalk.gray('Unsupported platforms (manual steps required): Gemini, OpenCode'));
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
 */
async function applyToAgents(scope?: ConfigScope): Promise<void> {
  const mcpConfig = loadMcpConfig();
  const switchboardConfig = loadSwitchboardConfig(scopeToLoadOptions(scope));

  if (switchboardConfig.agents.length === 0) {
    console.log(chalk.yellow('\n⚠ No agents found in the active configuration stack.'));
    console.log();
    console.log('Add agents under the relevant TOML layer (user, profile, or project).');
    console.log(chalk.dim('  Example: agents = ["claude-code", "cursor"]'));
    return;
  }

  // Filter enabled servers and remove 'enabled' field
  const enabledServers = Object.fromEntries(
    Object.entries(mcpConfig.mcpServers)
      .filter(([, server]) => server.enabled === true)
      .map(([name, server]) => {
        const { enabled: _enabled, ...rest } = server;
        return [name, rest as Omit<McpServer, 'enabled'>];
      })
  );

  const configToApply = { mcpServers: enabledServers };

  console.log();

  // Apply to each registered agent
  for (const agentId of switchboardConfig.agents) {
    const spinner = ora().start(`Applying to ${agentId}...`);

    try {
      const agent = getAgentById(agentId);
      agent.applyConfig(configToApply);
      spinner.succeed(`${chalk.green('✓')} ${agentId} ${chalk.dim(agent.configPath())}`);
    } catch (error) {
      if (error instanceof Error) {
        spinner.warn(`${chalk.yellow('⚠')} ${agentId} - ${error.message} (skipped)`);
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
  if (switchboardConfig.agents.length > 0) {
    console.log(chalk.blue(`\nApplied to agents (${switchboardConfig.agents.length}):`));
    for (const agent of switchboardConfig.agents) {
      console.log(`  ${chalk.dim('•')} ${agent}`);
    }
  }

  console.log();
}

program.parse(process.argv);
