import fs from 'node:fs';
import path from 'node:path';
import { getProjectTraeDir, getTraeConfigPath, type TraeVariant } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import {
  type JsonAgentConfig,
  loadJsonFile,
  managedMergeMcp,
  mergeMcpIntoAgent,
  sanitizeServerKeys,
  saveJsonFile,
} from './json-utils.js';

export class TraeAgent implements AgentAdapter {
  readonly id: string;
  private readonly variant: TraeVariant;

  constructor(variant: TraeVariant) {
    this.variant = variant;
    this.id = variant;
  }

  configPath(): string {
    return getTraeConfigPath(this.variant);
  }

  projectConfigPath(projectRoot: string): string {
    return path.join(getProjectTraeDir(projectRoot), 'mcp.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const configPath = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const servers = sanitizeServerKeys(config.mcpServers);
    const merged = mergeMcpIntoAgent(agentConfig, servers as Record<string, object>);
    saveJsonFile(configPath, merged);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> },
    options?: { previouslyOwned?: ReadonlySet<string> }
  ): void {
    const configPath = this.projectConfigPath(projectRoot);
    const existing = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const servers = sanitizeServerKeys(config.mcpServers);
    const merged = options?.previouslyOwned
      ? managedMergeMcp(existing, servers as Record<string, object>, options.previouslyOwned)
      : mergeMcpIntoAgent(existing, servers as Record<string, object>);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
