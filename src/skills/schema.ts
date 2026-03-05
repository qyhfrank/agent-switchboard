import { z } from 'zod';
import { libraryFrontmatterSchema } from '../library/schema.js';

/**
 * Skill frontmatter schema - extends base library schema.
 * - `name` and `description` are required (matching Claude Code / Codex skill format)
 * - Preserves unknown fields for forward compatibility
 */
export const skillFrontmatterSchema = libraryFrontmatterSchema
  .extend({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
