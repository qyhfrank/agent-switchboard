/**
 * Zod schemas for hook library entries.
 *
 * Hooks can be stored as:
 * - **Bundles**: a directory containing `hook.json` + script files
 * - **Single files**: a standalone `.json` file (no scripts to sync)
 *
 * In bundle mode, commands in hook.json can reference `${HOOK_DIR}` which
 * gets replaced at distribution time with the absolute path to the
 * distributed hook directory.
 */

import { z } from 'zod';

const hookHandlerSchema = z
  .object({
    type: z.enum(['command', 'http', 'prompt', 'agent']),
    command: z.string().optional(),
    url: z.string().optional(),
    prompt: z.string().optional(),
    model: z.string().optional(),
    timeout: z.number().optional(),
    statusMessage: z.string().optional(),
    async: z.boolean().optional(),
    once: z.boolean().optional(),
    headers: z.record(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
  })
  .passthrough();

const matcherGroupSchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(hookHandlerSchema).min(1),
  })
  .passthrough();

/**
 * Schema for a hook library JSON file (both bundle hook.json and standalone .json).
 * Top-level `name` and `description` are ASB metadata;
 * `hooks` holds the Claude Code-native event map.
 */
export const hookFileSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    hooks: z.record(z.string(), z.array(matcherGroupSchema)),
  })
  .passthrough();

export type HookHandler = z.infer<typeof hookHandlerSchema>;
export type MatcherGroup = z.infer<typeof matcherGroupSchema>;
export type HookFile = z.infer<typeof hookFileSchema>;

/** Placeholder in hook commands that gets replaced with the distributed bundle path */
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
export const HOOK_DIR_PLACEHOLDER = '${HOOK_DIR}';
