// ============================================================================
// @userfiction/combat — src/engine/index.ts — engine feature barrel
// ============================================================================
// Orchestration feature: pipeline.ts (one scheduled turn + cascade, D5a/D7
// transaction boundary), engine.ts (createSimulation construction, D2) and
// userCombat.ts (the T6 chainable userCombat facade over createSimulation).
//
// Internal order (all direct module imports, no barrel cycles): pipeline.ts
// imports scheduler/state/rules/effects/events/plugins; engine.ts imports
// pipeline + runtime/behavior/data modules; userCombat.ts imports engine.ts.
// This is the top of the dependency graph — no other feature imports it.
// ============================================================================

export * from './pipeline';
export * from './engine';
export * from './userCombat';
