// ============================================================================
// @userfiction/combat — src/data/index.ts — data feature barrel
// ============================================================================
// Static-data feature: catalogs.ts (builtin gear seed, patch-by-id catalog
// factory, definition resolution) and validation.ts (collect-all D3
// battle-definition validation).
//
// Dependency note: validation.ts imports catalogs.ts directly (same feature),
// and both import the contract feature directly — never through a barrel —
// so no runtime cycles exist (R1 barrel rule).
// ============================================================================

export * from './catalogs';
export * from './validation';
