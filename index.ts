// ============================================================================
// @userfiction/combat — Package barrel export (root index.ts)
// ============================================================================
// Source-only publish surface (AGENTS.md runner policy (c)): package.json
// main/module/types/exports point straight at ./src/index.ts, so npm consumers
// land on the src barrel directly — there is no dist build and no
// `exports.development` condition any more.
// This root barrel remains the relative-import alias: FORWARDS to the src-level
// public barrel (src/index.ts), which owns the explicit export list: the D2
// public API (entrypoints, factories, constants, error classes, types) plus the
// T6 userCombat facade (userCombat / createUserCombat). Keeping the list in ONE
// place means the root alias, the demo's relative '../index' import and every
// test resolve the identical surface without dropping any prior export (R4).
// ============================================================================

export * from './src/index';
