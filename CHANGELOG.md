# Changelog

## 0.5.0

### Migration notes

- **MIG-01, strict plugin configuration:** Unknown keys under `[plugins]` are
  rejected. Supported predecessor spellings are migrated before strict schema
  validation; other unknown top-level, nested, target, and transform keys fail
  before planning.
- **MIG-02, predecessor marketplace cache:** The predecessor
  `state/marketplace-plugins` cache is read only to retire identity-verified
  entries. Version 0.5 does not write it.
- **MIG-03, source removal:** `asb remove` retires plugin-expanded enabled ids
  contributed by the removed source.
- **MIG-04, empty MCP hosts:** Version 0.5 neither creates empty MCP host files
  nor treats an empty container as ownership evidence.
- **MIG-05, byte preservation:** Shared-document writers preserve unrelated
  bytes. They cannot restore comments or formatting already destroyed by a
  predecessor whole-file rewrite.
- **MIG-06, managed MCP values:** An owned MCP value is replaced wholly. Bytes
  modified since the recorded write cause a conflict instead of a deep merge
  with foreign subkeys.
- **MIG-07, Codex project trust:** Trust is add-only. Existing trusted values
  are preserved, untrusted or malformed values are refused, and ASB provides
  no removal path.

### Compatibility boundaries

- Executable target extensions are replaced by `[targets.<id>]` data. Leftover
  `.mjs` and `.js` files remain untouched for a 0.4 peer sharing `ASB_HOME`.
- Hook bundle groups can recover ownership from recognized managed paths and
  predecessor evidence after state loss. Definition hooks remain unclaimable
  without state; byte equality is not ownership proof, so an identical
  hand-written group is preserved and a definition may be appended again.
- Configuration validation is strict after the explicit compatibility
  migrations for `active`, the agents/subagents split, legacy plugin forms,
  legacy home resolution, and `[extensions]` parser tolerance.
