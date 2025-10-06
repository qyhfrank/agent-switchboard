/**
 * Agent adapter registry
 * Central registry for all supported agent adapters
 */

import type { AgentAdapter } from './adapter.js';

import { ClaudeCodeAgent } from './claude-code.js';
import { ClaudeDesktopAgent } from './claude-desktop.js';
import { CodexAgent } from './codex.js';
import { CursorAgent } from './cursor.js';
import { GeminiAgent } from './gemini.js';
import { OpencodeAgent } from './opencode.js';

/**
 * Registry of all available agent adapters
 * Add new adapters here when implemented
 */
const agents: AgentAdapter[] = [
  new ClaudeCodeAgent(),
  new ClaudeDesktopAgent(),
  new CodexAgent(),
  new CursorAgent(),
  new GeminiAgent(),
  new OpencodeAgent(),
];

/**
 * Get an agent adapter by its ID
 * @param id - Agent identifier (e.g., "claude-code", "codex", "cursor")
 * @returns Agent adapter instance
 * @throws {Error} If agent ID is not supported
 */
export function getAgentById(id: string): AgentAdapter {
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    throw new Error(
      `Unsupported agent: ${JSON.stringify(id)}. Supported agents: ${supportedAgentIds().join(', ')}`
    );
  }
  return agent;
}

/**
 * Get list of all supported agent IDs
 * @returns Array of agent IDs
 */
export function supportedAgentIds(): string[] {
  return agents.map((a) => a.id);
}

/**
 * Register a new agent adapter
 * Used for dynamic registration or testing
 * @param adapter - Agent adapter to register
 */
export function registerAgent(adapter: AgentAdapter): void {
  // Check if already registered
  const exists = agents.find((a) => a.id === adapter.id);
  if (exists) {
    throw new Error(`Agent ${adapter.id} is already registered`);
  }
  agents.push(adapter);
}
