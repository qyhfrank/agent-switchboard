#!/usr/bin/env node

/**
 * Agent Switchboard CLI Entry Point
 * Unified MCP server manager for AI coding agents
 */

import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import { getAgentById } from "./agents/registry.js";
import { loadMcpConfig, updateEnableFlags } from "./config/mcp-config.js";
import type { McpServer } from "./config/schemas.js";
import { loadSwitchboardConfig } from "./config/switchboard-config.js";
import { showMcpServerUI } from "./ui/mcp-ui.js";

const program = new Command();

program.name("asb").description("Unified MCP server manager for AI coding agents").version("0.1.0");

program
	.command("mcp")
	.description("Interactive UI to enable/disable MCP servers")
	.action(async () => {
		try {
			// Step 1: Show UI and get selected servers
			const selectedServers = await showMcpServerUI();

			if (selectedServers.length === 0 && loadMcpConfig().mcpServers) {
				console.log(chalk.yellow("\n⚠ No servers selected. Exiting without changes."));
				return;
			}

			// Step 2: Update enable flags in mcp.json
			const spinner = ora("Updating MCP configuration...").start();
			updateEnableFlags(selectedServers);
			spinner.succeed(chalk.green("✓ Updated ~/.agent-switchboard/mcp.json"));

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

/**
 * Apply enabled MCP servers to all registered agents
 */
async function applyToAgents(): Promise<void> {
	const mcpConfig = loadMcpConfig();
	const switchboardConfig = loadSwitchboardConfig();

	// Check if any agents are registered
	if (switchboardConfig.agents.length === 0) {
		console.log(chalk.yellow("\n⚠ No agents found in ~/.agent-switchboard/config.toml"));
		console.log();
		console.log("Please add agents to:");
		console.log(chalk.dim("  ~/.agent-switchboard/config.toml"));
		console.log();
		console.log("Example:");
		console.log(chalk.dim('  agents = ["claude-code", "cursor"]'));
		return;
	}

	// Filter enabled servers and remove 'enable' field
	const enabledServers = Object.fromEntries(
		Object.entries(mcpConfig.mcpServers)
			.filter(([_, server]) => server.enable === true)
			.map(([name, server]) => {
				// Remove 'enable' field before applying to agents
				const { enable: _enable, ...rest } = server;
				return [name, rest] as [string, Omit<McpServer, "enable">];
			}),
	);

	const configToApply = { mcpServers: enabledServers };

	console.log();

	// Apply to each registered agent
	for (const agentId of switchboardConfig.agents) {
		const spinner = ora().start(`Applying to ${agentId}...`);

		try {
			const agent = getAgentById(agentId);
			agent.applyConfig(configToApply);
			spinner.succeed(`${chalk.green("✓")} ${agentId} ${chalk.dim(agent.configPath())}`);
		} catch (error) {
			if (error instanceof Error) {
				spinner.warn(`${chalk.yellow("⚠")} ${agentId} - ${error.message} (skipped)`);
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
	console.log(chalk.blue("Summary:"));

	if (enabledServers.length > 0) {
		console.log(chalk.green(`\nEnabled servers (${enabledServers.length}):`));
		for (const server of enabledServers) {
			console.log(`  ${chalk.green("✓")} ${server}`);
		}
	}

	if (disabledServers.length > 0) {
		console.log(chalk.gray(`\nDisabled servers (${disabledServers.length}):`));
		for (const server of disabledServers) {
			console.log(`  ${chalk.gray("✗")} ${server}`);
		}
	}

	const switchboardConfig = loadSwitchboardConfig();
	if (switchboardConfig.agents.length > 0) {
		console.log(chalk.blue(`\nApplied to agents (${switchboardConfig.agents.length}):`));
		for (const agent of switchboardConfig.agents) {
			console.log(`  ${chalk.dim("•")} ${agent}`);
		}
	}

	console.log();
}

program.parse(process.argv);
