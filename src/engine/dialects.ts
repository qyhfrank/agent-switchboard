import os from 'node:os';
import type { HookEventMap, HookGroup, HookHandler } from './library.js';

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
