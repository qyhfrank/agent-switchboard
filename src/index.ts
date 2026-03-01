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
import {
  getApplicationOverride,
  resolveApplicationSectionConfig,
} from './config/application-config.js';
import { loadMcpConfig, stripLegacyEnabledFlagsFromMcpJson } from './config/mcp-config.js';
import {
  getAgentsDir,
  getAgentsHome,
  getClaudeDir,
  getCodexDir,
  getCommandsDir,
  getCursorDir,
  getGeminiDir,
  getHooksDir,
  getOpencodePath,
  getSkillsDir,
  getSourceCacheDir,
} from './config/paths.js';
import type { ConfigScope } from './config/scope.js';
import {
  loadSwitchboardConfig,
  loadSwitchboardConfigWithLayers,
} from './config/switchboard-config.js';
import { distributeHooks } from './hooks/distribution.js';
import { loadHookLibrary } from './hooks/library.js';
import { ensureLibraryDirectories, writeFileSecure } from './library/fs.js';
import {
  addLocalSource,
  addRemoteSource,
  getSources,
  inferSourceName,
  isGitUrl,
  parseGitUrl,
  removeSource,
  updateRemoteSources,
  validateSourcePath,
} from './library/sources.js';
import {
  loadLibraryStateSection,
  loadMcpActiveState,
  saveMcpActiveState,
} from './library/state.js';
import { readMarketplace } from './marketplace/reader.js';
import { RULE_SUPPORTED_AGENTS } from './rules/agents.js';
import { composeActiveRules } from './rules/composer.js';
import {
  distributeRules,
  listIndirectAgents,
  listPerFileAgents,
  listUnsupportedAgents,
} from './rules/distribution.js';
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
import { showHookSelector } from './ui/hook-ui.js';
import { showMcpServerUI } from './ui/mcp-ui.js';
import { showRuleSelector } from './ui/rule-ui.js';
import { showSkillSelector } from './ui/skill-ui.js';
import { showSubagentSelector } from './ui/subagent-ui.js';
import {
  printActiveSelection,
  printAgentSyncStatus,
  printDistributionResults,
  printTable,
  shortenPath,
} from './util/cli.js';

const program = new Command();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));

program
  .name('asb')
  .description(
    'Manage MCP servers, rules, commands, agents, skills, and hooks across AI coding agents'
  )
  .version(packageJson.version)
  .addHelpText(
    'after',
    `
Examples:
  $ asb mcp                          Enable/disable MCP servers interactively
  $ asb rule                         Select and order rule snippets
  $ asb sync                         Push all libraries to every active agent
  $ asb sync --project .             Sync with project-level overrides

Alias: agent-switchboard
Config: ~/.agent-switchboard/config.toml`
  );

// Initialize library directories for commands/agents (secure permissions)
ensureLibraryDirectories();

program
  .command('sync')
  .description(
    'Synchronize active MCP servers, rules, commands, agents, and skills to application targets'
  )
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .option('--no-update', 'Skip updating remote sources')
  .action(async (options: ScopeOptionInput & { update: boolean }) => {
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

      if (options.update !== false) {
        const remoteResults = updateRemoteSources();
        if (remoteResults.length > 0) {
          console.log(chalk.blue('Remote source updates:'));
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
          console.log();
        }
      }

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
        const displayPath = entry.exists ? shortenPath(entry.path) : entry.path;
        const pathLabel = entry.exists ? chalk.dim(displayPath) : chalk.gray(displayPath);
        console.log(`  ${marker} ${entry.label}: ${pathLabel}`);
      }
      console.log();

      const globalAgentCount = config.agents.active.length;
      const perAppAdds: string[] = [];
      for (const appId of config.applications.active) {
        const override = getApplicationOverride(config, appId, 'agents');
        if (override?.add && override.add.length > 0) {
          perAppAdds.push(`${appId}+${override.add.length}`);
        }
      }
      const agentLabel =
        perAppAdds.length > 0
          ? `${chalk.cyan(String(globalAgentCount))} ${chalk.gray(`(${perAppAdds.join(', ')})`)}`
          : chalk.cyan(String(globalAgentCount));

      console.log(chalk.blue('Active selections:'));
      console.log(`  MCP servers: ${chalk.cyan(String(config.mcp.active.length))}`);
      console.log(`  Rules: ${chalk.cyan(String(config.rules.active.length))}`);
      console.log(`  Commands: ${chalk.cyan(String(config.commands.active.length))}`);
      console.log(`  Agents: ${agentLabel}`);
      console.log(`  Skills: ${chalk.cyan(String(config.skills.active.length))}`);
      console.log(`  Hooks: ${chalk.cyan(String(config.hooks.active.length))}`);
      if (config.applications.active.length > 0) {
        console.log(`  Applications: ${chalk.cyan(config.applications.active.join(', '))}`);
      } else {
        console.log(`  Applications: ${chalk.gray('none configured')}`);
      }
      console.log();

      // Effective inventory: what is active per application after overrides
      console.log(chalk.blue('Effective inventory:'));
      {
        const header = ['Section', 'Global', 'Effective per application', 'Preview'];
        const sections = ['mcp', 'rules', 'commands', 'agents', 'skills', 'hooks'] as const;

        const rows = sections.map((section) => {
          const globalActive = config[section].active;
          const globalCount = globalActive.length;

          const perAppEffective = config.applications.active.map((appId) => {
            const eff = resolveApplicationSectionConfig(section, appId, scope).active;
            const delta = eff.length - globalCount;
            const deltaLabel = delta === 0 ? '' : delta > 0 ? `(+${delta})` : `(${delta})`;
            return `${appId}:${eff.length}${deltaLabel}`;
          });

          const union = new Set<string>();
          for (const appId of config.applications.active) {
            const eff = resolveApplicationSectionConfig(section, appId, scope).active;
            for (const id of eff) union.add(id);
          }

          const previewIds = globalActive.length > 0 ? globalActive : [...union];
          const maxPreview = 5;
          const preview =
            previewIds.length === 0
              ? 'none'
              : previewIds.length <= maxPreview
                ? previewIds.join(', ')
                : `${previewIds.slice(0, maxPreview).join(', ')}, ... (+${
                    previewIds.length - maxPreview
                  } more)`;

          const sectionLabel =
            section === 'mcp'
              ? 'mcp'
              : section === 'agents'
                ? 'agents'
                : section === 'rules'
                  ? 'rules'
                  : section;

          return [
            { plain: sectionLabel, formatted: chalk.cyan(sectionLabel) },
            { plain: String(globalCount), formatted: chalk.cyan(String(globalCount)) },
            {
              plain: perAppEffective.join(' '),
              formatted: perAppEffective.length > 0 ? perAppEffective.join(chalk.gray(' ')) : '—',
            },
            { plain: preview, formatted: preview === 'none' ? chalk.gray(preview) : preview },
          ];
        });

        printTable(header, rows);
      }
      console.log();
      console.log(
        chalk.gray(
          'Note: some library types may distribute to additional platforms (e.g., gemini) even if not listed under [applications].'
        )
      );
      console.log();

      const mcpDistribution = await applyToAgents(scope, undefined, { useSpinner: false });

      const ruleDistribution = distributeRules(undefined, { force: true }, scope);
      const commandDistribution = distributeCommands(scope);
      const agentDistribution = distributeSubagents(scope);
      const skillDistribution = distributeSkills(scope, {
        useAgentsDir: config.distribution.use_agents_dir,
      });
      const hookDistribution = distributeHooks(scope);

      const ruleErrors = ruleDistribution.results.filter((result) => result.status === 'error');
      const commandErrors = commandDistribution.results.filter(
        (result) => result.status === 'error'
      );
      const agentErrors = agentDistribution.results.filter((result) => result.status === 'error');
      const skillErrors = skillDistribution.results.filter((result) => result.status === 'error');
      const hookErrors = hookDistribution.results.filter((result) => result.status === 'error');

      printDistributionResults({
        title: 'MCP server distribution',
        results: mcpDistribution,
        emptyMessage: 'no applications configured',
        getTargetLabel: (result) => result.application,
        getPath: (result) => result.filePath,
      });
      console.log();

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
        title: 'Agent distribution',
        results: agentDistribution.results,
        emptyMessage: 'no active agents',
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

      printDistributionResults({
        title: 'Hook distribution',
        results: hookDistribution.results,
        emptyMessage: 'no active hooks',
        getTargetLabel: (result) => result.platform,
        getPath: (result) =>
          'filePath' in result ? result.filePath : (result as { targetDir: string }).targetDir,
      });
      console.log();

      const hasErrors =
        ruleErrors.length > 0 ||
        commandErrors.length > 0 ||
        agentErrors.length > 0 ||
        skillErrors.length > 0 ||
        hookErrors.length > 0;
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
    case 'cursor':
      return path.join(getCursorDir(), 'commands');
    case 'gemini':
      return path.join(getGeminiDir(), 'commands');
    case 'opencode':
      return getOpencodePath('command');
  }
}

function defaultAgentSourceDir(platform: SubPlatform): string {
  switch (platform) {
    case 'claude-code':
      return path.join(getClaudeDir(), 'agents');
    case 'cursor':
      return path.join(getCursorDir(), 'agents');
    case 'opencode':
      return getOpencodePath('agent');
    default:
      throw new Error(`Unknown agent platform: ${String(platform)}`);
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
    case 'cursor':
      return path.join(getCursorDir(), 'skills');
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

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Preserve executable permissions
      try {
        const mode = fs.statSync(srcPath).mode;
        if (mode & 0o111) fs.chmodSync(destPath, mode & 0o777);
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Extract hooks from Claude Code's ~/.claude/settings.json and import as a
 * bundle into ~/.asb/hooks/. Copies referenced script files if they exist
 * alongside the hooks and rewrites commands to use ${HOOK_DIR}.
 */
async function importHooksFromClaudeCode(opts: { force?: boolean }): Promise<void> {
  const settingsPath = path.join(getClaudeDir(), 'settings.json');
  if (!isFile(settingsPath)) {
    console.error(chalk.red(`\n✗ Claude Code settings not found: ${settingsPath}`));
    process.exit(1);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || Object.keys(hooks).length === 0) {
    console.log(chalk.yellow('\n⚠ No hooks found in Claude Code settings.'));
    return;
  }

  // Filter out ASB-managed hooks (avoid re-importing our own output)
  const userHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const userGroups = (groups as Array<Record<string, unknown>>).filter(
      (g) => g._asb_source === undefined
    );
    if (userGroups.length > 0) userHooks[event] = userGroups;
  }

  if (Object.keys(userHooks).length === 0) {
    console.log(chalk.yellow('\n⚠ No user-defined hooks found (all are ASB-managed).'));
    return;
  }

  // Collect script paths referenced in commands
  const referencedScripts = new Set<string>();

  for (const groups of Object.values(userHooks)) {
    for (const group of groups as Array<Record<string, unknown>>) {
      const handlers = group.hooks as Array<Record<string, unknown>> | undefined;
      if (!handlers) continue;
      for (const handler of handlers) {
        if (typeof handler.command !== 'string') continue;
        // Extract file paths from commands like "node ~/.claude/hooks/script.mjs"
        const match = handler.command.match(
          /(?:^|\s)(~\/\.claude\/hooks\/\S+|(?:\/\S*\/)?\.claude\/hooks\/\S+)/
        );
        if (match) {
          const scriptPath = match[1].replace(/^~/, process.env.HOME ?? '');
          if (fs.existsSync(scriptPath)) {
            referencedScripts.add(scriptPath);
          }
        }
      }
    }
  }

  const slug = 'claude-code-hooks';
  const bundleDir = path.join(getHooksDir(), slug);

  if (fs.existsSync(bundleDir)) {
    if (!(await confirmOverwrite(bundleDir, opts.force))) return;
    fs.rmSync(bundleDir, { recursive: true });
  }

  fs.mkdirSync(bundleDir, { recursive: true });

  // Copy referenced scripts and rewrite commands to use ${HOOK_DIR}
  const { HOOK_DIR_PLACEHOLDER } = await import('./hooks/schema.js');
  const rewrittenHooks: Record<string, unknown[]> = {};

  for (const [event, groups] of Object.entries(userHooks)) {
    rewrittenHooks[event] = (groups as Array<Record<string, unknown>>).map((group) => {
      const handlers = group.hooks as Array<Record<string, unknown>> | undefined;
      if (!handlers) return group;

      return {
        ...group,
        hooks: handlers.map((handler) => {
          if (typeof handler.command !== 'string') return handler;

          let cmd = handler.command;
          for (const scriptPath of referencedScripts) {
            const scriptName = path.basename(scriptPath);
            if (
              cmd.includes(scriptPath) ||
              cmd.includes(scriptPath.replace(process.env.HOME ?? '', '~'))
            ) {
              cmd = cmd.replace(scriptPath, `${HOOK_DIR_PLACEHOLDER}/${scriptName}`);
              cmd = cmd.replace(
                scriptPath.replace(process.env.HOME ?? '', '~'),
                `${HOOK_DIR_PLACEHOLDER}/${scriptName}`
              );
            }
          }
          return { ...handler, command: cmd };
        }),
      };
    });
  }

  // Copy script files into the bundle
  let scriptsCopied = 0;
  for (const scriptPath of referencedScripts) {
    const scriptName = path.basename(scriptPath);
    const destPath = path.join(bundleDir, scriptName);
    fs.copyFileSync(scriptPath, destPath);
    try {
      const mode = fs.statSync(scriptPath).mode;
      if (mode & 0o111) fs.chmodSync(destPath, mode & 0o777);
    } catch {
      // Ignore
    }
    scriptsCopied++;
    console.log(`  ${chalk.green('✓')} ${chalk.dim(scriptName)}`);
  }

  // Write hook.json
  const hookJson = {
    name: 'claude-code-hooks',
    description: 'Hooks imported from Claude Code settings.json',
    hooks: rewrittenHooks,
  };
  fs.writeFileSync(
    path.join(bundleDir, 'hook.json'),
    `${JSON.stringify(hookJson, null, 2)}\n`,
    'utf-8'
  );

  const eventCount = Object.keys(rewrittenHooks).length;
  console.log(
    `\n${chalk.green('✓')} Imported ${eventCount} event(s) + ${scriptsCopied} script(s) → ${chalk.dim(bundleDir)}`
  );
  console.log(
    chalk.gray('  Activate with: asb hook  (interactive) or add to [hooks].active in config.toml')
  );
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
  .description('Select and order rule snippets interactively, then sync to agents')
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
      const perFileAgents = listPerFileAgents();
      if (perFileAgents.length > 0) {
        console.log(chalk.gray(`Per-file rules (.mdc): ${perFileAgents.join(', ')}`));
      }
      const indirectAgents = listIndirectAgents();
      if (indirectAgents.length > 0) {
        console.log(
          chalk.gray(
            `Indirect rules support (reads CLAUDE.md + AGENTS.md): ${indirectAgents.join(', ')}`
          )
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
    const perFileAgents = listPerFileAgents();
    if (perFileAgents.length > 0) {
      console.log(chalk.gray(`Per-file rules (.mdc): ${perFileAgents.join(', ')}`));
    }
    const indirectAgents = listIndirectAgents();
    if (indirectAgents.length > 0) {
      console.log(
        chalk.gray(
          `Indirect rules support (reads CLAUDE.md + AGENTS.md): ${indirectAgents.join(', ')}`
        )
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
  .description('Select slash commands interactively and distribute to agents')
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
    console.log(chalk.gray('Unsupported platforms (manual steps required): Claude Desktop'));
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
  .argument('<platform>', 'claude-code | codex | cursor | gemini | opencode')
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
      console.log(chalk.gray('Unsupported platforms (manual steps required): Claude Desktop'));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

// Agents library: load, list, and interactive distribute
const agentRoot = program
  .command('agent')
  .description('Select agent definitions interactively and distribute to applications')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

agentRoot.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showSubagentSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) return;
    console.log();
    printActiveSelection('agents', selection.active);

    const out = distributeSubagents(scope);
    if (out.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Agent distribution',
        results: out.results,
        getTargetLabel: (result) => result.platform,
        getPath: (result) => result.filePath,
      });
    }

    console.log();
    console.log(chalk.gray('Unsupported platforms (manual steps required): Codex, Gemini'));
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

agentRoot
  .command('load')
  .description('Import existing platform files into the agent library')
  .argument('<platform>', 'claude-code | opencode | cursor')
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
          srcPath && srcPath.trim().length > 0 ? srcPath : defaultAgentSourceDir(platform);
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

        const outDir = getAgentsDir();
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

        console.log(`\n${chalk.green('✓')} Imported ${imported} file(s) into agent library.`);
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`\n✗ Error: ${error.message}`));
        }
        process.exit(1);
      }
    }
  );

agentRoot
  .command('list')
  .description('Display agent inventory and sync information')
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
        console.log(chalk.yellow('⚠ No agents found. Use `asb agent load <platform> [path]`.'));
      } else {
        console.log(chalk.blue('Agents:'));
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

      console.log();
      console.log(chalk.gray('Unsupported platforms (manual steps required): Codex, Gemini'));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

// Skills library: manage and distribute skill bundles
const skillRoot = program
  .command('skill')
  .description('Select skill bundles interactively and distribute to agents')
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
  .argument('<platform>', 'claude-code | codex | cursor')
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

// Hooks library: manage and distribute hooks to Claude Code
const hookRoot = program
  .command('hook')
  .description('Select hooks interactively and distribute to Claude Code')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml');

hookRoot.action(async (options: ScopeOptionInput) => {
  try {
    const scope = resolveScope(options);
    const config = loadSwitchboardConfig(scopeToLoadOptions(scope));
    const selection = await showHookSelector({ scope, pageSize: config.ui.page_size });
    if (!selection) return;
    console.log();
    printActiveSelection('hooks', selection.active);

    const out = distributeHooks(scope);
    if (out.results.length > 0) {
      console.log();
      printDistributionResults({
        title: 'Hook distribution',
        results: out.results,
        getTargetLabel: (result) => result.platform,
        getPath: (result) =>
          'filePath' in result ? result.filePath : (result as { targetDir: string }).targetDir,
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Error: ${error.message}`));
    }
    process.exit(1);
  }
});

hookRoot
  .command('list')
  .description('Display hook library entries')
  .option('--json', 'Output as JSON')
  .option('-p, --profile <name>', 'Profile configuration to use')
  .option('--project <path>', 'Project directory containing .asb.toml')
  .action((options: { json?: boolean } & ScopeOptionInput) => {
    try {
      const scope = resolveScope(options);
      const entries = loadHookLibrary();
      const state = loadLibraryStateSection('hooks', scope);
      const activeSet = new Set(state.active);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              entries: entries.map((e) => ({
                id: e.id,
                name: e.name,
                description: e.description,
                events: Object.keys(e.hooks),
                active: activeSet.has(e.id),
              })),
              active: state.active,
            },
            null,
            2
          )
        );
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.yellow(`⚠ No hooks found. Add JSON hook files to ${getHooksDir()}`));
      } else {
        console.log(chalk.blue('Hooks:'));
        const header = ['ID', 'Active', 'Name', 'Events', 'Description'];
        const rows = entries.map((e) => {
          const active = activeSet.has(e.id);
          const activePlain = active ? 'yes' : 'no';
          const events = Object.keys(e.hooks).join(', ');
          const desc = e.description ?? '—';
          const descTrunc = desc.length > 40 ? `${desc.substring(0, 37)}...` : desc;
          return [
            { plain: e.id, formatted: e.id },
            {
              plain: activePlain,
              formatted: active ? chalk.green(activePlain) : chalk.gray(activePlain),
            },
            { plain: e.name ?? e.id, formatted: e.name ?? e.id },
            { plain: events, formatted: events },
            { plain: descTrunc, formatted: descTrunc },
          ];
        });
        printTable(header, rows);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

hookRoot
  .command('load')
  .description(
    'Import hooks into the library. Accepts:\n' +
      '  - A JSON file (single-file hook)\n' +
      '  - A directory with hook.json (bundle hook)\n' +
      '  - "claude-code" to extract from ~/.claude/settings.json'
  )
  .argument('<source>', 'JSON file, directory, or "claude-code"')
  .option('-f, --force', 'Overwrite existing library entries without confirmation')
  .option('-n, --name <name>', 'Override the hook ID (default: basename of source)')
  .action(async (source: string, opts: { force?: boolean; name?: string }) => {
    try {
      if (source === 'claude-code') {
        await importHooksFromClaudeCode(opts);
        return;
      }

      const resolved = path.resolve(source);

      if (isFile(resolved)) {
        // Single-file hook import
        const content = fs.readFileSync(resolved, 'utf-8');
        try {
          const { hookFileSchema } = await import('./hooks/schema.js');
          hookFileSchema.parse(JSON.parse(content));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\n✗ Invalid hook file: ${msg}`));
          process.exit(1);
        }

        const slug = opts.name ?? path.basename(resolved, path.extname(resolved));
        const target = path.join(getHooksDir(), `${slug}.json`);

        if (!(await confirmOverwrite(target, opts.force))) return;

        writeFileSecure(target, content);
        console.log(`${chalk.green('✓')} ${chalk.cyan(slug)} → ${chalk.dim(target)}`);
      } else if (isDir(resolved)) {
        // Bundle hook import (directory with hook.json + scripts)
        const hookJsonPath = path.join(resolved, 'hook.json');
        if (!isFile(hookJsonPath)) {
          console.error(chalk.red('\n✗ Directory does not contain hook.json'));
          process.exit(1);
        }

        // Validate hook.json
        try {
          const { hookFileSchema } = await import('./hooks/schema.js');
          hookFileSchema.parse(JSON.parse(fs.readFileSync(hookJsonPath, 'utf-8')));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\n✗ Invalid hook.json: ${msg}`));
          process.exit(1);
        }

        const slug = opts.name ?? path.basename(resolved);
        const targetDir = path.join(getHooksDir(), slug);

        if (fs.existsSync(targetDir)) {
          if (!(await confirmOverwrite(targetDir, opts.force))) return;
          fs.rmSync(targetDir, { recursive: true });
        }

        // Copy entire directory
        copyDirRecursive(resolved, targetDir);
        const fileCount = listFilesRecursively(targetDir, []).length;
        console.log(
          `${chalk.green('✓')} ${chalk.cyan(slug)} → ${chalk.dim(targetDir)} (${fileCount} files)`
        );
      } else {
        console.error(chalk.red(`\n✗ Source not found: ${resolved}`));
        process.exit(1);
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
 * @param scope - Configuration scope (profile/project)
 * @param enabledServerNames - List of enabled server names
 */
type McpDistributionResult = {
  application: string;
  filePath: string;
  status: 'written' | 'error';
  reason?: string;
  error?: string;
};

async function applyToAgents(
  scope?: ConfigScope,
  enabledServerNames?: string[],
  options?: { useSpinner?: boolean }
): Promise<McpDistributionResult[]> {
  const mcpConfig = loadMcpConfig();
  const switchboardConfig = loadSwitchboardConfig(scopeToLoadOptions(scope));
  const useSpinner = options?.useSpinner ?? true;
  const results: McpDistributionResult[] = [];

  if (switchboardConfig.applications.active.length === 0) {
    if (useSpinner) {
      console.log(chalk.yellow('\n⚠ No applications found in the active configuration stack.'));
      console.log();
      console.log('Add applications under the relevant TOML layer (user, profile, or project).');
      console.log(chalk.dim('  Example: [applications]\n  active = ["claude-code", "cursor"]'));
    }
    return results;
  }

  // Global MCP servers list (from UI selection or config)
  const globalMcpServers = enabledServerNames ?? loadMcpActiveState(scope);

  for (const agentId of switchboardConfig.applications.active) {
    const spinner = useSpinner ? ora({ indent: 2 }).start(`Applying to ${agentId}...`) : null;
    const persist = (symbol: string, text: string) => {
      if (!spinner) return;
      spinner.stopAndPersist({ symbol: `  ${symbol}`, text });
    };

    try {
      const agentMcpConfig = resolveApplicationSectionConfig('mcp', agentId, scope);
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
        persist(chalk.green('✓'), `${chalk.cyan(agentId)} ${chalk.dim(shortenPath(projectPath))}`);
        results.push({
          application: agentId,
          filePath: projectPath,
          status: 'written',
          reason: 'applied',
        });
      } else {
        agent.applyConfig(configToApply);
        persist(
          chalk.green('✓'),
          `${chalk.cyan(agentId)} ${chalk.dim(shortenPath(agent.configPath()))}`
        );
        results.push({
          application: agentId,
          filePath: agent.configPath(),
          status: 'written',
          reason: 'applied',
        });
      }
    } catch (error) {
      if (error instanceof Error) {
        persist(chalk.yellow('⚠'), `${chalk.cyan(agentId)} - ${error.message} (skipped)`);
        results.push({
          application: agentId,
          filePath: '(unknown)',
          status: 'error',
          error: `${error.message} (skipped)`,
        });
      }
    }
  }

  return results;
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
  if (switchboardConfig.applications.active.length > 0) {
    console.log(
      chalk.blue(`\nApplied to applications (${switchboardConfig.applications.active.length}):`)
    );
    for (const agent of switchboardConfig.applications.active) {
      console.log(`  ${chalk.dim('•')} ${agent}`);
    }
  }

  console.log();
}

function printMarketplaceSummary(localPath: string): void {
  try {
    const mp = readMarketplace(localPath);
    console.log(chalk.dim(`  Type: marketplace (${mp.name})`));
    console.log(chalk.dim(`  Plugins: ${mp.plugins.length}`));
    for (const plugin of mp.plugins) {
      const desc = plugin.description ? ` - ${plugin.description}` : '';
      console.log(chalk.dim(`    ${plugin.name}${desc}`));
    }
    for (const w of mp.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`  ⚠ Failed to read marketplace: ${msg}`));
  }
}

const sourceRoot = program
  .command('source')
  .description('Manage external library sources (local paths or git repos)');

sourceRoot
  .command('add')
  .description('Add a library source (local path or git URL)')
  .argument('<location>', 'Local path or git URL (e.g., https://github.com/org/repo)')
  .argument('[name]', 'Namespace (defaults to repo or directory name)')
  .action((location: string, nameArg: string | undefined) => {
    try {
      const name = nameArg ?? inferSourceName(location);
      if (isGitUrl(location)) {
        const parsed = parseGitUrl(location);
        const spinner = ora(`Cloning ${parsed.url}...`).start();
        try {
          addRemoteSource(name, {
            url: parsed.url,
            ref: parsed.ref,
            subdir: parsed.subdir,
          });
          spinner.succeed(chalk.green(`✓ Cloned ${parsed.url}`));
        } catch (err) {
          spinner.fail(chalk.red('Failed to clone'));
          throw err;
        }

        let effectivePath = getSourceCacheDir(name);
        if (parsed.subdir) effectivePath = path.join(effectivePath, parsed.subdir);
        const validation = validateSourcePath(effectivePath);

        if (!validation.valid) {
          removeSource(name);
          console.error(
            chalk.red(
              '\n✗ Cloned repository does not contain any library folders (rules/, commands/, agents/, skills/) or marketplace manifest.'
            )
          );
          process.exit(1);
        }

        console.log(chalk.green(`\n✓ Added source "${name}" from ${parsed.url}`));
        if (parsed.ref) console.log(chalk.dim(`  Ref: ${parsed.ref}`));
        if (parsed.subdir) console.log(chalk.dim(`  Subdir: ${parsed.subdir}`));
        if (validation.isMarketplace) {
          printMarketplaceSummary(effectivePath);
        } else {
          console.log(chalk.dim(`  Found: ${validation.found.join(', ')}`));
          if (validation.missing.length > 0) {
            console.log(chalk.dim(`  Missing: ${validation.missing.join(', ')}`));
          }
        }
      } else {
        const validation = validateSourcePath(location);
        if (!validation.valid) {
          console.error(
            chalk.red(
              '\n✗ Path does not contain any library folders (rules/, commands/, agents/, skills/) or marketplace manifest.'
            )
          );
          process.exit(1);
        }

        addLocalSource(name, location);

        console.log(chalk.green(`\n✓ Added source "${name}" at ${path.resolve(location)}`));
        if (validation.isMarketplace) {
          printMarketplaceSummary(path.resolve(location));
        } else {
          console.log(chalk.dim(`  Found: ${validation.found.join(', ')}`));
          if (validation.missing.length > 0) {
            console.log(chalk.dim(`  Missing: ${validation.missing.join(', ')}`));
          }
        }
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

sourceRoot
  .command('remove')
  .description('Remove a library source by namespace')
  .argument('<name>', 'Namespace to remove')
  .action((name: string) => {
    try {
      const sources = getSources();
      const source = sources.find((s) => s.namespace === name);
      removeSource(name);
      if (source?.remote) {
        console.log(chalk.green(`\n✓ Removed source "${name}" and cleaned up cache`));
      } else {
        console.log(chalk.green(`\n✓ Removed source "${name}"`));
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\n✗ Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

sourceRoot
  .command('list')
  .description('List all library sources')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    try {
      const sources = getSources();

      if (options.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }

      if (sources.length === 0) {
        console.log(chalk.yellow('\n⚠ No library sources configured.'));
        console.log(chalk.dim('  Use `asb source add <location> [name]` to add one.'));
        return;
      }

      console.log(chalk.blue('\nLibrary sources:'));
      const header = ['Namespace', 'Type', 'Source', 'Status', 'Contains'];
      const rows = sources.map((src) => {
        const isRemote = !!src.remote;
        const exists = fs.existsSync(src.path);
        const validation = exists
          ? validateSourcePath(src.path)
          : { found: [], missing: [], isMarketplace: false };

        const typePlain = validation.isMarketplace ? 'marketplace' : isRemote ? 'remote' : 'local';
        const sourcePlain = isRemote ? (src.remote?.url ?? src.path) : src.path;

        let statusPlain: string;
        if (isRemote) {
          statusPlain = exists ? 'cached' : 'not cached';
        } else {
          statusPlain = exists ? 'ok' : 'missing';
        }

        let containsPlain: string;
        if (validation.isMarketplace && exists) {
          try {
            const mp = readMarketplace(src.path);
            containsPlain = `${mp.plugins.length} plugin(s)`;
          } catch {
            containsPlain = 'marketplace (error)';
          }
        } else {
          containsPlain = validation.found.length > 0 ? validation.found.join(', ') : '-';
        }

        return [
          { plain: src.namespace, formatted: chalk.cyan(src.namespace) },
          {
            plain: typePlain,
            formatted: validation.isMarketplace
              ? chalk.magenta(typePlain)
              : isRemote
                ? chalk.blue(typePlain)
                : chalk.gray(typePlain),
          },
          { plain: sourcePlain, formatted: chalk.dim(sourcePlain) },
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

sourceRoot.action(() => {
  sourceRoot.commands.find((c) => c.name() === 'list')?.parse(process.argv);
});

program.parse(process.argv);
