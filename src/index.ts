#!/usr/bin/env node

/**
 * Agent Switchboard CLI Entry Point
 * Unified MCP server manager for AI coding agents
 */

import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import { getAgentById } from './agents/registry.js';
import { loadMcpConfig, updateEnabledFlags } from './config/mcp-config.js';
import type { McpServer } from './config/schemas.js';
import { loadSwitchboardConfig } from './config/switchboard-config.js';
import { RULE_SUPPORTED_AGENTS } from './rules/agents.js';
import { composeActiveRules } from './rules/composer.js';
import { distributeRules, listUnsupportedAgents } from './rules/distribution.js';
import { buildRuleInventory } from './rules/inventory.js';
import { loadRuleLibrary } from './rules/library.js';
import { loadRuleState, updateRuleState } from './rules/state.js';
import { showMcpServerUI } from './ui/mcp-ui.js';
import { showRuleSelector } from './ui/rule-ui.js';

const program = new Command();

program.name('asb').description('Unified MCP server manager for AI coding agents').version('0.1.0');

function formatSyncTimestamp(value: string | undefined): string {
  if (!value) return 'no sync recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

program
  .command('mcp')
  .description('Interactive UI to enable/disable MCP servers')
  .action(async () => {
    try {
      // Step 1: Show UI and get selected servers
      const selectedServers = await showMcpServerUI();

      if (selectedServers.length === 0 && loadMcpConfig().mcpServers) {
        console.log(chalk.yellow('\n⚠ No servers selected. Exiting without changes.'));
        return;
      }

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

        const columnWidths = header.map((col, index) =>
          Math.max(col.length, ...rows.map((row) => row[index].plain.length))
        );

        const formatRow = (values: { plain: string; formatted: string }[]): string =>
          values
            .map((cell, index) => {
              const width = columnWidths[index];
              const padding = ' '.repeat(Math.max(0, width - cell.plain.length));
              return `${cell.formatted}${padding}`;
            })
            .join('  ');

        const headerCells = header.map((col) => ({ plain: col, formatted: chalk.bold(col) }));
        console.log(formatRow(headerCells));
        rows.forEach((row) => {
          console.log(formatRow(row));
        });
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
