// ============================================================================
// @userfiction/combat — src/index.ts — public barrel (src-level)
// ============================================================================
// Single owner of the package's public export list (R4). The root index.ts
// forwards HERE (`export * from './src/index'`), and the demo imports the
// root entry relatively ('../index'), so npm consumers, the demo and every
// test resolve one identical surface.
//
// Exports are SELECTIVE: the D2 public API (entrypoints, factories,
// constants, error classes, types) plus the T6 userCombat facade. Feature
// barrels (contract/data/runtime/behavior/engine) are internal integration
// surfaces and are NOT re-exported wholesale — private internals
// (PluginRegistry, TurnRunner, EventLog, scheduler internals, …) never leak
// into the public API.
// ============================================================================

// --- entrypoints + factories (runtime values) -------------------------------
export { createSimulation } from './engine';
// T6 facade: the ready-to-configure singleton + isolated builder factory.
export { userCombat, createUserCombat } from './engine';
export type { UserCombat } from './engine';

export { validateBattleDefinition } from './data';          // soft UI pre-check (D2)
export { defaultRules } from './behavior';                  // builtin rule plugin factory (D5)
export { createGearCatalog, defaultGearSeed } from './data'; // seed/patch/copy-on-read factory + builtin seed (D9)
export { renderEventText } from './runtime';                 // default text renderer (D11)

// --- closed vocabularies + constants (D2 barrel constants; D6 hook table) ---
export {
    COMBAT_SCHEMA_VERSION,                             // = 1
    STAT_KEYS,                                         // ['health','strength','speed','defense','precision','evasion']
    HOOK_IDS,                                          // closed hook vocabulary (D6 table)
    DAMAGE_TYPES,                                      // ['blunt','sharp']
    GEAR_KINDS,                                        // ['weapon','armour']
    SLOTS,                                             // ['weapon-1','weapon-2','shield','head','body','hands','feet']
    // T2 (R2) anatomy + R3 resource vocabularies
    BODY_PARTS,                                        // ['left-arm','right-arm','left-leg','right-leg','left-eye','right-eye','left-ear','right-ear','nose']
    RESOURCE_KEYS,                                     // ['stamina','mana'] — non-health pools (energy is an input alias)
    STATUS_DECAY_MODES,                                // ['stacks','duration','none'] (R1)
    // T2 derivation + bounds constants (R1/R2/R3)
    INJURY_LEG_SPEED_FACTOR,                           // 0.75 per missing leg (multiplicative)
    INJURY_EYE_PRECISION_PENALTY,                      // −2 precision per missing eye
    INJURY_EAR_EVASION_PENALTY,                        // −1 evasion per missing ear
    MIN_RESOURCE_VALUE, MAX_RESOURCE_VALUE,
    MIN_STATUS_MODIFIER, MAX_STATUS_MODIFIER,
    MIN_STATUS_TICK_VALUE, MAX_STATUS_TICK_VALUE,
    MIN_SKIP_CHANCE, MAX_SKIP_CHANCE,
} from './contract';
// Fail-fast construction errors (D2/D7): exported as VALUES so consumers can
// catch with instanceof; both carry `errors: string[]`.
export { CombatValidationError, CombatPluginError } from './contract';
// T2 (R1): the builtin status-definition seed (registered ailment/buff
// defaults) — exported from the data feature like defaultGearSeed (D9).
export { defaultStatusSeed } from './data';

// --- public types (D2 list) --------------------------------------------------
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
    // T2 additions (R1/R2/R3)
    StatusDefinition,
    StatusTickEffect,
    StatusDecayMode,
    BodyPart,
    ResourcePool,
    EntityResources,
    EntityResourcesInput,
    ResourceCost,
    ResourceCostInput,
    ResourceKey,
    // T3 live-edit contract (CombatantEdit + its domain shapes)
    CombatantEdit,
    CombatantGearEdit,
    CombatantStatusEdit,
    CombatantInjuriesEdit,
    CombatantResourceEdit,
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
} from './contract';
