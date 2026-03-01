import { z } from 'zod';

/**
 * Unified library frontmatter schema for commands and agents.
 * - Only global `description` (optional)
 * - All platform-native options live under `extras.<platform>` and are passed through verbatim
 * - Keep unknown keys for forward/backward compatibility
 */
export const libraryFrontmatterSchema = z
  .object({
    description: z.string().trim().optional(),
    extras: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type LibraryFrontmatter = z.infer<typeof libraryFrontmatterSchema>;
