export { createSimulation } from './src/engine';
export { validateBattleDefinition } from './src/validation';
export { defaultRules } from './src/rules';
export { createGearCatalog } from './src/catalogs';
export { defaultGearSeed } from './src/catalogs';
export { renderEventText } from './src/events';
export { COMBAT_SCHEMA_VERSION, // = 1
STAT_KEYS, // ['health','strength','speed','defense','precision','evasion']
HOOK_IDS, // closed hook vocabulary (D6 table)
DAMAGE_TYPES, // ['blunt','sharp']
GEAR_KINDS, // ['weapon','armour']
SLOTS, } from './src/types';
export { CombatValidationError, CombatPluginError } from './src/types';
export type { BattleDefinition, EntityDefinition, StatInput, StatBlock, StatusInstance, GearDefinition, GearRef, AbilityDefinition, TeamDefinition, SimulationConfig, DeclarativeRule, Condition, EffectDescriptor, Ref, ChainHookId, StatKey, Slot, Simulation, SimulationOptions, CombatValidation, SimulationSnapshot, EntitySnapshot, StatModifier, ScheduleEntry, EntityView, StateView, Outcome, OutcomeVerdict, BattleEvent, EventDraft, StepContext, HookHandler, CombatPlugin, HookId, RngStream, } from './src/types';
