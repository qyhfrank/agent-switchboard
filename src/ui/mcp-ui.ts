/**
 * Interactive UI for managing MCP servers
 * Based on claude-ext UI patterns
 */

import { checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadMcpConfig } from '../config/mcp-config.js';
import type { CheckboxItem } from '../types.js';

/**
 * Create checkbox items for MCP servers
 * Displays servers with status icons and pre-selects enabled servers
 * @returns Array of checkbox items sorted alphabetically
 */
export function createMcpServerItems(): CheckboxItem[] {
  const config = loadMcpConfig();
  const items: CheckboxItem[] = [];

  // Create items for all servers
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const isEnabled = server.enabled === true;
    const icon = isEnabled ? chalk.green('✓') : chalk.red('✗');
    const status = isEnabled ? chalk.gray('(enabled)') : chalk.gray('(disabled)');

    items.push({
      name: `${icon} ${name} ${status}`,
      value: name,
      checked: isEnabled,
    });
  }

  // Sort alphabetically by server name
  return items.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Show interactive checkbox UI for MCP server selection
 * @returns Array of selected server names
 */
export async function showMcpServerUI(): Promise<string[]> {
  const items = createMcpServerItems();

  if (items.length === 0) {
    console.log(chalk.yellow('⚠ No MCP servers found in ~/.agent-switchboard/mcp.json'));
    console.log();
    console.log('Please add servers manually to the config file:');
    console.log(chalk.dim('  ~/.agent-switchboard/mcp.json'));
    console.log();
    console.log('Example:');
    console.log(
      chalk.dim(`  {
    "mcpServers": {
      "my-server": {
        "command": "npx",
        "args": ["-y", "package"],
        "env": {},
        "enabled": true
      }
    }
  }`)
    );
    return [];
  }

  console.log(chalk.blue('MCP Server Management'));
  console.log(chalk.gray('Select which MCP servers should be enabled:'));
  console.log();

  const selectedServers = await checkbox({
    message: 'Toggle MCP servers (Space: toggle, a: all, i: invert, Enter: confirm):',
    choices: items,
    pageSize: 15,
  });

  return selectedServers;
}
