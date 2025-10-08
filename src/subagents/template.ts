export function renderDefaultSubagentTemplate(): string {
  return `---
description: Identify potential defects and provide actionable fixes before merge
---

You are a strict reviewer. Output issues with location, severity, impact, and a concise fix.
`;
}
