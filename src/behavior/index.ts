// ============================================================================
// @userfiction/combat — src/behavior/index.ts — behavior feature barrel
// ============================================================================
// Gameplay-behavior feature: effects.ts (bounded D8 condition/effect
// interpreter), plugins.ts (D6/D7 hook registry) and rules.ts (the D5
// defaultRules builtin floor + phase defaults).
//
// Internal order (all direct module imports, no barrel cycles): effects.ts
// imports the contract + runtime features; plugins.ts imports effects.ts;
// rules.ts imports scheduler/catalogs/effects/state directly.
// ============================================================================

export * from './effects';
export * from './plugins';
export * from './rules';
