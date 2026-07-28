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
