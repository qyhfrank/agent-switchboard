import type { ApplicationTarget } from '../types.js';
import { claudeCodeTarget } from './claude-code.js';
import { claudeDesktopTarget } from './claude-desktop.js';
import { codexTarget } from './codex.js';
import { cursorTarget } from './cursor.js';
import { geminiTarget } from './gemini.js';
import { opencodeTarget } from './opencode.js';
import { traeCnTarget, traeTarget } from './trae.js';

export const BUILTIN_TARGETS: readonly ApplicationTarget[] = [
  claudeCodeTarget,
  claudeDesktopTarget,
  codexTarget,
  cursorTarget,
  geminiTarget,
  opencodeTarget,
  traeTarget,
  traeCnTarget,
];

export {
  claudeCodeTarget,
  claudeDesktopTarget,
  codexTarget,
  cursorTarget,
  geminiTarget,
  opencodeTarget,
  traeTarget,
  traeCnTarget,
};
