/**
 * Block merge for shared rules files (CLAUDE.md, AGENTS.md).
 *
 * In managed project mode, ASB content is wrapped in markers so that
 * project-native content is preserved. If markers already exist, only
 * the block between them is replaced.
 */

const ASB_BLOCK_START = '<!-- asb:rules:start -->';
const ASB_BLOCK_END = '<!-- asb:rules:end -->';

/**
 * Merge ASB rules content into an existing file, preserving non-ASB content.
 *
 * - If markers exist: replace content between markers.
 * - If no markers: insert block according to `placement`.
 * - If `asbContent` is empty: remove the block entirely.
 */
export function mergeRulesBlock(
  existing: string,
  asbContent: string,
  placement: 'prepend' | 'append' = 'prepend'
): string {
  const startIdx = existing.indexOf(ASB_BLOCK_START);
  const endIdx = existing.indexOf(ASB_BLOCK_END);

  if (asbContent.length === 0) {
    // Remove existing block if present
    if (startIdx !== -1 && endIdx !== -1) {
      return removeRulesBlock(existing);
    }
    return existing;
  }

  const block = `${ASB_BLOCK_START}\n${asbContent.trimEnd()}\n${ASB_BLOCK_END}`;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + ASB_BLOCK_END.length);
    return `${before}${block}${after}`;
  }

  // Insert new block
  const trimmed = existing.trimEnd();
  if (placement === 'prepend') {
    if (trimmed.length === 0) return `${block}\n`;
    return `${block}\n\n${trimmed}\n`;
  }
  // append
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Remove ASB markers and their content from a file, preserving the rest.
 */
export function removeRulesBlock(content: string): string {
  const startIdx = content.indexOf(ASB_BLOCK_START);
  const endIdx = content.indexOf(ASB_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + ASB_BLOCK_END.length);

  // Clean up extra whitespace left by removal
  const result = (before + after).replace(/\n{3,}/g, '\n\n').trim();
  return result.length > 0 ? `${result}\n` : '';
}

/**
 * Check if a rules target file is a dedicated ASB file (safe for full replace)
 * vs a shared file (needs block merge).
 */
export function isDedicatedAsbRulesFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? '';
  return basename.startsWith('asb-rules');
}
