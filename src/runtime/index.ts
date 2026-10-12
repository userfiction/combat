// ============================================================================
// @userfiction/combat — src/runtime/index.ts — runtime feature barrel
// ============================================================================
// Runtime machinery feature: rng.ts (Mulberry32 shared stream, D4g),
// scheduler.ts (integer-µs virtual-time scheduler, D4), state.ts (mutable
// state + views + snapshots, D7/D10) and events.ts (event log + text
// renderer, D11).
//
// The four modules are mutually independent (each imports only the contract
// feature directly), so this barrel introduces no cycles (R1 barrel rule).
// ============================================================================

export * from './rng';
export * from './scheduler';
export * from './state';
export * from './events';
