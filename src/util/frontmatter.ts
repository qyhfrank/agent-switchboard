import { stringify as toYaml } from 'yaml';

export function wrapFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  // Avoid reflowing long scalars (e.g., description) to preserve original formatting intent
  const yaml = toYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}
