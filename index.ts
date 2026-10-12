// ============================================================================
// @userfiction/combat — Package barrel export (root index.ts)
// ============================================================================
// Public npm entrypoint (package.json exports.development + vite lib.entry).
// FORWARDS to the src-level public barrel (src/index.ts), which owns the
// explicit export list: the D2 public API (entrypoints, factories,
// constants, error classes, types) plus the T6 userCombat facade
// (userCombat / createUserCombat). Keeping the list in ONE place means the
// root entry, the demo's relative '../index' import and every test resolve
// the identical surface without dropping any prior export (R4).
// ============================================================================

export * from './src/index';
