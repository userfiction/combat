// ============================================================================
// @userfiction/combat — src/contract/index.ts — contract feature barrel
// ============================================================================
// Shared vocabulary feature: types.ts (the single source of truth for every
// public type, D13 bounds constant and fail-fast error class) and ids.ts (id
// pattern + 'pluginId/name' namespacing helper).
//
// Barrel discipline (R1): source modules NEVER import through feature
// barrels — they import sibling/feature modules directly
// (e.g. behavior/plugins.ts → '../contract/types') so the runtime dependency
// graph stays acyclic. Feature barrels exist for ergonomic external access
// (tests, src/index.ts) and are the only place `export *` is used.
// ============================================================================

export * from './types';
export * from './ids';
