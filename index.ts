// ============================================================================
// @userfiction/combat — Package barrel export
// ============================================================================
// Public npm entrypoint. Re-exports every combat module so external consumers
// resolve the full API from '@userfiction/combat'. Mirrors the barrel pattern
// used by @userfiction/core and @userfiction/engine (index.ts re-exporting
// each feature directory's index). T5 finalized the surface: exactly the D2
// list — value exports for the entrypoints, constants and error classes
// (errors are thrown by createSimulation, so consumers need the runtime
// values for instanceof), type-only exports for the rest.
// ============================================================================

// --- runtime values (D2) ---
export { createSimulation } from './src/engine';
export { validateBattleDefinition } from './src/validation';
export { defaultRules } from './src/rules';            // builtin rule plugin factory
export { createGearCatalog } from './src/catalogs';    // seed/patch/copy-on-read factory
export { defaultGearSeed } from './src/catalogs';      // builtin weapons/armour seed list
export { renderEventText } from './src/events';        // default text renderer
export {
    COMBAT_SCHEMA_VERSION,                             // = 1
    STAT_KEYS,                                         // ['health','strength','speed','defense','precision','evasion']
    HOOK_IDS,                                          // closed hook vocabulary (D6 table)
    DAMAGE_TYPES,                                      // ['blunt','sharp']
    GEAR_KINDS,                                        // ['weapon','armour']
    SLOTS,                                             // ['weapon-1','weapon-2','shield','head','body','hands','feet']
} from './src/types';
// Fail-fast construction errors (D2/D7): exported as VALUES so consumers can
// catch with instanceof; both carry `errors: string[]`.
export { CombatValidationError, CombatPluginError } from './src/types';

// --- public types (D2) ---
export type {
    // battle input (D3)
    BattleDefinition,
    EntityDefinition,
    StatInput,
    StatBlock,
    StatusInstance,
    GearDefinition,
    GearRef,
    AbilityDefinition,
    TeamDefinition,
    SimulationConfig,
    // declarative rules (D8) — StatKey/Slot/ChainHookId are referenced by D3/D8 and must be public
    DeclarativeRule,
    Condition,
    EffectDescriptor,
    Ref,
    ChainHookId,
    StatKey,
    Slot,
    // runtime surfaces (D2/D7/D10)
    Simulation,
    SimulationOptions,
    CombatValidation,
    SimulationSnapshot,
    EntitySnapshot,
    StatModifier,
    ScheduleEntry,
    EntityView,
    StateView,
    Outcome,
    OutcomeVerdict,
    BattleEvent,
    EventDraft,
    StepContext,
    HookHandler,
    CombatPlugin,
    HookId,
    RngStream,
} from './src/types';
