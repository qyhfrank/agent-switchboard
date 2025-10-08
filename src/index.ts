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
  getOpencodePath,
  getSubagentsDir,
} from './config/paths.js';
import type { McpServer } from './config/schemas.js';
import { loadSwitchboardConfig } from './config/switchboard-config.js';
import { ensureLibraryDirectories, writeFileSecure } from './library/fs.js';
import { RULE_SUPPORTED_AGENTS } from './rules/agents.js';
import { composeActiveRules } from './rules/composer.js';
import { distributeRules, listUnsupportedAgents } from './rules/distribution.js';
import { buildRuleInventory } from './rules/inventory.js';
import { loadRuleLibrary } from './rules/library.js';
import { loadRuleState, updateRuleState } from './rules/state.js';

import { showCommandSelector } from './ui/command-ui.js';
import { showMcpServerUI } from './ui/mcp-ui.js';
import { showRuleSelector } from './ui/rule-ui.js';
import { showSubagentSelector } from './ui/subagent-ui.js';

const program = new Command();

program.name('asb').description('Unified MCP server manager for AI coding agents').version('0.1.0');

// Initialize library directories for commands/subagents (secure permissions)
ensureLibraryDirectories();

import type { SubagentPlatform as SubPlatform } from './subagents/distribution.js';

// Subagent library wiring
import { distributeSubagents } from './subagents/distribution.js';
import { importSubagentFromFile } from './subagents/importer.js';
import { buildSubagentInventory } from './subagents/inventory.js';
// Shared CLI helpers
import { formatSyncTimestamp, printTable } from './util/cli.js';

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
  .action(async () => {
    try {
      // Step 1: Show UI and get selected servers
      const selectedServers = await showMcpServerUI();

      // Proceed even if no servers are selected: this means disable all.
      // Previous behavior incorrectly bailed out and prevented users from clearing selections.

      // Step 2: Update enabled flags in mcp.json
      const spinner = ora('Updating MCP configuration...').start();
      updateEnabledFlags(selectedServers);
      spinner.succeed(chalk.green('✓ Updated ~/.agent-switchboard/mcp.json'));

      // Step 3: Apply to registered agents
      await applyToAgents();

      // Step 4: Show summary
      showSummary(selectedServers);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

const ruleCommand = program.command('rule').description('Manage rule snippets and synchronization');

ruleCommand
  .command('list')
  .description('Display rule snippets and sync information')
  .option('--json', 'Output inventory as JSON')
  .action((options: { json?: boolean }) => {
    try {
      const inventory = buildRuleInventory();

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

ruleCommand.action(async () => {
  try {
    const selection = await showRuleSelector();
    if (!selection) {
      return;
    }

    const rules = loadRuleLibrary();
    const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));

    const previousState = loadRuleState();
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
    });

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

    const distribution = distributeRules(composeActiveRules(), { force: !selectionChanged });

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
const commandRoot = program.command('command').description('Manage command library');

commandRoot.action(async () => {
  try {
    const selection = await showCommandSelector();
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

    const out = distributeCommands();
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

// (add removed) — commands are created via `load` from platform sources

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

  .action((options: { json?: boolean }) => {
    try {
      const inventory = buildCommandInventory();

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
const subagentRoot = program.command('subagent').description('Manage subagent (persona) library');

subagentRoot.action(async () => {
  try {
    const selection = await showSubagentSelector();
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

    const out = distributeSubagents();
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
  .action((options: { json?: boolean }) => {
    try {
      const inventory = buildSubagentInventory();

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

/**
 * Apply enabled MCP servers to all registered agents
 */
async function applyToAgents(): Promise<void> {
  const mcpConfig = loadMcpConfig();
  const switchboardConfig = loadSwitchboardConfig();

  // Check if any agents are registered
  if (switchboardConfig.agents.length === 0) {
    console.log(chalk.yellow('\n⚠ No agents found in ~/.agent-switchboard/config.toml'));
    console.log();
    console.log('Please add agents to:');
    console.log(chalk.dim('  ~/.agent-switchboard/config.toml'));
    console.log();
    console.log('Example:');
    console.log(chalk.dim('  agents = ["claude-code", "cursor"]'));
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
function showSummary(selectedServers: string[]): void {
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

  const switchboardConfig = loadSwitchboardConfig();
  if (switchboardConfig.agents.length > 0) {
    console.log(chalk.blue(`\nApplied to agents (${switchboardConfig.agents.length}):`));
    for (const agent of switchboardConfig.agents) {
      console.log(`  ${chalk.dim('•')} ${agent}`);
    }
  }

  console.log();
}

program.parse(process.argv);
