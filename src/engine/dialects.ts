import os from 'node:os';
import { stringify as tomlStringify } from '@iarna/toml';
import type { HookEventMap, HookGroup, HookHandler } from './library.js';
import { tomlKey } from './shapes.js';

/**
 * Per-app content transforms. Only genuine transforms are functions; every
 * other per-app variation is a column in the apps table.
 */

/** Frozen 0.4.35 mdc frontmatter wrap used by cursor/trae/trae-cn rules targets. */
export function wrapMdcFrontmatter(body: string): string {
  const lines = ['---', 'description: Agent Switchboard Rules', 'alwaysApply: true', '---', ''];
  if (body.length > 0) lines.push(body);
  return lines.join('\n');
}

/** Identity render for apps that read the composed document as-is. */
export function rawBody(body: string): string {
  return body;
}

/**
 * Frozen 0.4.35 `preferHomeVar`: a distributed command path under the home
 * directory is recorded as `$HOME/...`, so machines sharing one dotfile tree
 * read the value they would each have written. The substitution is bound to
 * path-token starts, so for `/home/ada` neither `/home/ada2/x` nor
 * `/backup/home/ada/x` is rewritten.
 */
export function preferHomeVar(command: string, home: string = os.homedir()): string {
  const root = home.replace(/\/+$/, '');
  if (root.length === 0) return command;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`(^|[\\s"'\`=(:;&|<>])${escaped}/`, 'g'), '$1$HOME/');
}

const CODEX_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'Stop',
]);

const CODEX_HANDLER_KEYS: ReadonlySet<string> = new Set([
  'type',
  'command',
  'commandWindows',
  'command_windows',
  'timeout',
  'async',
  'statusMessage',
]);

function codexSupports(handler: HookHandler): boolean {
  if (handler.type !== 'command' || typeof handler.command !== 'string') return false;
  const commandWindows = handler.commandWindows ?? handler.command_windows;
  if (commandWindows !== undefined && typeof commandWindows !== 'string') return false;
  if (
    handler.timeout !== undefined &&
    !(
      typeof handler.timeout === 'number' &&
      Number.isSafeInteger(handler.timeout) &&
      handler.timeout >= 0
    )
  ) {
    return false;
  }
  if (handler.async !== undefined && handler.async !== false) return false;
  if (handler.statusMessage !== undefined && typeof handler.statusMessage !== 'string')
    return false;
  return Object.keys(handler).every((key) => CODEX_HANDLER_KEYS.has(key));
}

/**
 * Frozen 0.4.35 Codex compatibility filter: unsupported events, handler types
 * and options are dropped rather than published, and surviving handlers are
 * rebuilt from the allowlist so no unknown key (`_asb*` metadata included)
 * reaches hooks.json. An entry filtered down to nothing distributes nothing.
 */
export function filterCodexHooks(hooks: HookEventMap): HookEventMap {
  const filtered: HookEventMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!CODEX_EVENTS.has(event)) continue;
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const handlers = group.hooks.filter(codexSupports).map((handler) => {
        const commandWindows = handler.commandWindows ?? handler.command_windows;
        return {
          type: 'command' as const,
          command: handler.command as string,
          ...(commandWindows !== undefined ? { commandWindows } : {}),
          ...(handler.timeout !== undefined ? { timeout: handler.timeout } : {}),
          ...(handler.async !== undefined ? { async: handler.async } : {}),
          ...(handler.statusMessage !== undefined ? { statusMessage: handler.statusMessage } : {}),
        };
      });
      if (handlers.length > 0) {
        kept.push({
          ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
          hooks: handlers,
        });
      }
    }
    if (kept.length > 0) filtered[event] = kept;
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// MCP: the per-app server-value transforms, keyed from the table
// ---------------------------------------------------------------------------

export type McpServerValue = Record<string, unknown>;

/**
 * Frozen 0.4.35 `sanitizeMcpName`: apps that reject anything outside
 * `[a-zA-Z0-9_-]` get the rewritten key, and that key is what the ledger
 * records — it is what is on disk.
 */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Frozen 0.4.35 load-time type inference. Gemini and opencode both branch on
 * the type, so it is settled once in the library rather than per dialect, and
 * the inferred value is what verbatim apps write.
 */
export function inferServerType(server: McpServerValue): McpServerValue {
  if (typeof server.type === 'string') return server;
  if (typeof server.url === 'string' && server.url.length > 0) return { ...server, type: 'http' };
  if (typeof server.command === 'string' && server.command.length > 0) {
    return { ...server, type: 'stdio' };
  }
  return server;
}

/** Verbatim apps (claude-code, claude-desktop, cursor) write the definition as authored. */
export function verbatimServer(server: McpServerValue): McpServerValue {
  return server;
}

/**
 * Frozen 0.4.35 `mapServerForGemini`: http renames `url` to `httpUrl`, sse and
 * untyped url-only servers keep `url`, everything else is stdio. `type` never
 * survives, and stdio always spells out command/args/env.
 */
export function geminiServer(server: McpServerValue): McpServerValue {
  const { type, url, command, args, env, ...rest } = server;
  if (type === 'http' && typeof url === 'string') return { httpUrl: url, ...rest };
  if ((type === 'sse' || type === undefined) && typeof url === 'string' && !command) {
    return { url, ...rest };
  }
  const stdio: McpServerValue = {};
  if (command !== undefined) stdio.command = command;
  if (args !== undefined) stdio.args = args;
  if (env !== undefined) stdio.env = env;
  return { ...stdio, ...rest };
}

/**
 * Frozen 0.4.35 opencode mapping: remote when typed http/sse or carrying a
 * url, local otherwise. `command` becomes `[cmd, ...args]`, `env` becomes
 * `environment`, and every asb-written entry carries `enabled: true`.
 */
export function opencodeServer(server: McpServerValue): McpServerValue {
  const remote = server.type === 'http' || server.type === 'sse' || typeof server.url === 'string';
  const next: McpServerValue = {};
  if (remote) {
    next.type = 'remote';
    if (typeof server.url === 'string') next.url = server.url;
    if (server.headers && typeof server.headers === 'object') next.headers = server.headers;
  } else {
    next.type = 'local';
    const args = Array.isArray(server.args) ? server.args : [];
    if (typeof server.command === 'string' && server.command.length > 0) {
      next.command = [server.command, ...args];
    }
    if (server.env && typeof server.env === 'object') next.environment = server.env;
  }
  next.enabled = true;
  return next;
}

/**
 * Frozen 0.4.35 `stripMcpType`: Trae infers transport from url vs command and
 * rejects an explicit `type`. The value written is the whole server without
 * it, so a stale `type` in the target is replaced away rather than merged
 * around.
 */
export function traeServer(server: McpServerValue): McpServerValue {
  const { type: _type, ...rest } = server;
  return rest;
}

const CODEX_KEY_ORDER: readonly string[] = [
  'command',
  'args',
  'url',
  'cwd',
  'bearer_token_env_var',
  'env_file',
  'required',
  'enabled_tools',
  'disabled_tools',
  'env_vars',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
];

const CODEX_SPECIAL_KEYS: ReadonlySet<string> = new Set([
  'env',
  'headers',
  'http_headers',
  'env_http_headers',
  'type',
  'enabled',
]);

const CODEX_INLINE_TABLES: ReadonlySet<string> = new Set(['http_headers', 'env_http_headers']);

function isTomlPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isTomlEmittable(value: unknown): boolean {
  return isTomlPrimitive(value) || (Array.isArray(value) && value.every(isTomlPrimitive));
}

/** A string map with sorted keys and coerced values, or undefined when empty. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item)]));
}

/**
 * Frozen 0.4.35 `buildNestedToml` semantics as a value: canonical key order,
 * `headers` renamed to `http_headers` with an explicit one winning, sorted
 * inline-table headers, `env` sorted and string-coerced, unknown keys last in
 * alphabetical order, and `type`/`enabled` never emitted. Codex reads stdio
 * and http only, so an sse server renders as nothing at all.
 *
 * The result is exactly what `renderCodexTable` serializes and what parsing
 * that table back yields, so the recorded slice hash survives a round trip.
 */
export function codexServer(server: McpServerValue): McpServerValue | null {
  if (server.type === 'sse') return null;
  const value: McpServerValue = {};
  for (const key of CODEX_KEY_ORDER) {
    const item = server[key];
    if (item === undefined || item === null || !isTomlEmittable(item)) continue;
    value[key] = item;
  }
  const httpHeaders = stringMap(server.http_headers ?? server.headers);
  if (httpHeaders) value.http_headers = httpHeaders;
  const envHttpHeaders = stringMap(server.env_http_headers);
  if (envHttpHeaders) value.env_http_headers = envHttpHeaders;
  const env = stringMap(server.env);
  if (env) value.env = env;
  const known = new Set([...CODEX_KEY_ORDER, ...CODEX_SPECIAL_KEYS]);
  for (const key of Object.keys(server)
    .filter((candidate) => !known.has(candidate))
    .sort((a, b) => a.localeCompare(b))) {
    const item = server[key];
    if (item === undefined || item === null || !isTomlEmittable(item)) continue;
    value[key] = item;
  }
  return value;
}

/** One `[mcp_servers.<name>]` table: the canonical value, serialized. */
export function renderCodexTable(keyPath: readonly string[], value: McpServerValue): string {
  const lines = [`[${keyPath.map(tomlKey).join('.')}]`];
  for (const [key, item] of Object.entries(value)) {
    if (key === 'env') {
      for (const [name, entry] of Object.entries(item as Record<string, string>)) {
        lines.push(`env.${tomlKey(name)} = ${tomlStringify.value(entry)}`);
      }
      continue;
    }
    if (CODEX_INLINE_TABLES.has(key)) {
      const pairs = Object.entries(item as Record<string, string>)
        .map(([name, entry]) => `${tomlStringify.value(name)} = ${tomlStringify.value(entry)}`)
        .join(', ');
      lines.push(`${key} = { ${pairs} }`);
      continue;
    }
    lines.push(`${tomlKey(key)} = ${tomlStringify.value(item as string)}`);
  }
  return lines.join('\n');
}
