import path from 'node:path';
import { getProjectTraeDir, getTraeConfigPath, type TraeVariant } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import { applyJsonMcpConfig } from './json-utils.js';

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
    applyJsonMcpConfig(this.configPath(), config.mcpServers as Record<string, object>);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> },
    options?: { previouslyOwned?: ReadonlySet<string> }
  ): void {
    applyJsonMcpConfig(
      this.projectConfigPath(projectRoot),
      config.mcpServers as Record<string, object>,
      {
        previouslyOwned: options?.previouslyOwned,
      }
    );
  }
}
