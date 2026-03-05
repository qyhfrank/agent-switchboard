import { parseMarkdownWithSchema } from '../util/markdown.js';
import { type SkillFrontmatter, skillFrontmatterSchema } from './schema.js';

export interface ParsedSkillDoc {
  metadata: SkillFrontmatter;
  content: string;
}

/** Parse a SKILL.md document using the skill schema. */
export function parseSkillMarkdown(source: string): ParsedSkillDoc {
  return parseMarkdownWithSchema(source, skillFrontmatterSchema, {
    label: 'Skill',
    missingDelimiterError: 'Skill frontmatter is missing a closing delimiter (---)',
    parseErrorPrefix: 'Failed to parse skill frontmatter',
  });
}
