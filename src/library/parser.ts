import { parseMarkdownWithSchema } from '../util/markdown.js';
import { type LibraryFrontmatter, libraryFrontmatterSchema } from './schema.js';

export interface ParsedLibraryDoc {
  metadata: LibraryFrontmatter;
  content: string;
}

/** Parse a Markdown document using the unified library schema. */
export function parseLibraryMarkdown(source: string): ParsedLibraryDoc {
  return parseMarkdownWithSchema(source, libraryFrontmatterSchema, {
    label: 'Library',
    missingDelimiterError: 'Frontmatter is missing a closing delimiter (---)',
    parseErrorPrefix: 'Failed to parse frontmatter',
  });
}
