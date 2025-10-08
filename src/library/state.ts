import fs from 'node:fs';
import { z } from 'zod';
import { getConfigDir, getRuleStatePath } from '../config/paths.js';

const agentSyncEntrySchema = z
  .object({
    hash: z.string().trim().min(1).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough();

const sectionStateSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).default([]),
    agentSync: z.record(z.string(), agentSyncEntrySchema).default({}),
  })
  .passthrough();

export type SectionState = z.infer<typeof sectionStateSchema>;

export function loadLibraryStateSection(section: 'commands' | 'subagents'): SectionState {
  const filePath = getRuleStatePath();
  if (!fs.existsSync(filePath)) {
    return { active: [], agentSync: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const obj = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})[
      section
    ];
    return sectionStateSchema.parse(obj ?? {});
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load ${section} state from ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function saveLibraryStateSection(
  section: 'commands' | 'subagents',
  state: SectionState
): void {
  const filePath = getRuleStatePath();
  const baseDir = getConfigDir();

  const validated = sectionStateSchema.parse(state);

  try {
    let root: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      root = JSON.parse(raw) as Record<string, unknown>;
    }

    root[section] = validated;

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    const json = `${JSON.stringify(root, null, 4)}\n`;
    fs.writeFileSync(filePath, json, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to save ${section} state to ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function updateLibraryStateSection(
  section: 'commands' | 'subagents',
  mutator: (current: SectionState) => SectionState
): SectionState {
  const current = loadLibraryStateSection(section);
  const next = mutator(current);
  saveLibraryStateSection(section, next);
  return loadLibraryStateSection(section);
}
