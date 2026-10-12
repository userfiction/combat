// ============================================================================
// @userfiction/combat — src/engine/userCombat.ts — userCombat facade (T6)
// ============================================================================
// Chainable configuration facade over createSimulation (engine.ts, D2). Two
// surfaces with the same contract:
//
//   userCombat        — a ready-to-configure SINGLETON for the simple
//                       single-battle flow. Its configuration ACCUMULATES
//                       across uses (see "Configuration semantics" below),
//                       so concurrent consumers would stomp each other —
//                       that is what createUserCombat() is for.
//   createUserCombat() — a fresh ISOLATED builder starting from engine
//                       defaults; independent instances never share state.
//
// Lazy lifecycle (coherent with the synchronous engine, D1/D2):
//   1. No Simulation exists while only setters run. The engine is created
//      on the FIRST access (simulate/snapshot/events/reset/isTerminal/
//      outcome) from the accumulated configuration via createSimulation —
//      the engine's own fail-fast validation (D2) is the single validation
//      path; the facade never re-implements it.
//   2. Deterministic invalidation: EVERY setter marks the built battle
//      stale. The next access REBUILDS from scratch — prior battle progress
//      is discarded and the next simulate() advances step 1 of the new
//      battle. Deterministic: the same accumulated configuration + seed
//      always yield a bit-identical fresh battle (snapshot.definition is
//      rebuilt verbatim; the engine deep-copies input, R9).
//   3. simulate() = exactly ONE existing engine step (Simulation.step, one
//      scheduled turn + cascade, D5a) wrapped in a Promise, returning the
//      step's snapshot. Terminal idempotence is the engine's own (D5g):
//      stepping a terminal battle returns the current snapshot unchanged
//      and emits nothing.
//   4. Failure modes match the engine: configuration errors surface as
//      CombatValidationError (values, catchable with instanceof) — thrown
//      SYNCHRONOUSLY by the observation methods (snapshot/events/reset/
//      isTerminal/outcome) and REJECTED by the async simulate().
//
// Configuration semantics (each setter REPLACES its domain; config MERGES):
//   - actors/equipments(gears)/abilities(skills)/teams/plugins: the array is
//     stored as a copy; a later call REPLACES the previous list wholesale
//     (last call wins). equipments() is the deprecated identical alias of
//     gears() (R4); skills() the identical alias of abilities(). These
//     fill definition.catalogs — actor EquipmentLoadout/GearRef fields stay
//     on the actors exactly as in a hand-written BattleDefinition (D3).
//   - ailments()/buff() (T2 R1): REGISTER StatusDefinitions, ACCUMULATING
//     into one status registry (two doors, one catalog); re-registering an
//     id replaces that registration. They never apply statuses to actors.
//   - config(SimulationConfig): MERGES the provided keys into the
//     accumulated config (later keys win). Keys never set stay ABSENT from
//     the definition, so engine defaults apply (D3/D13: maxSteps 10_000,
//     maxCascade 1_000, maxLogEvents 100_000 — engine.ts applies them).
//     Keys set with undefined fall back to engine defaults the same way.
//   - seed/mode/builtinRules: scalar REPLACES. mode defaults to 'ffa'.
//     builtinRules stays UNSET (engine default true, D2) until called.
//   - Not exposed: restore snapshots, declarative JSON rule contributions,
//     definition name — the full BattleDefinition surface remains available
//     through createSimulation(input, options) directly.
//
// Reset semantics: reset() is the ENGINE's reset (D10) on the CURRENT
// battle — rewind to the initial state derived from the accumulated
// configuration with the same seed, ids restart, events log empties to
// battle:start. After a setter, reset() rebuilds the fresh battle first
// (invalidation rule 2), so the returned snapshot is the new battle's
// initial state, never the discarded one.
//
// T3 live edit: editCombatant(edit) is SYNCHRONOUS and deliberately NOT a
// setter — it patches the CURRENT battle in place (validate + atomic
// combatant patch, one 'combatant:edited' event, step/time/RNG preserved)
// without marking the builder stale, so the next simulate() continues the
// same battle WITH the adjustments. Reset discards edits (they are state,
// not configuration); a setter rebuild naturally discards them too, while a
// restore retains them (the snapshot carries the edited state).
// ============================================================================

import { createSimulation } from './engine';
import { COMBAT_SCHEMA_VERSION } from '../contract/types';
import type {
    AbilityDefinition,
    BattleDefinition,
    BattleEvent,
    BattleMode,
    CombatantEdit,
    CombatPlugin,
    EntityDefinition,
    GearDefinition,
    Outcome,
    Simulation,
    SimulationConfig,
    SimulationOptions,
    SimulationSnapshot,
    StatusDefinition,
    TeamDefinition,
} from '../contract/types';

// ----------------------------------------------------------------------------
// Public facade contract. Every method returns the SAME instance so calls
// chain fluently (R2); `this`-typed via the explicit UserCombat return.
//
// T2 additions (R4):
//   skills(...)  — registers the ability/skill catalog (identical to
//                  abilities()); actors reference skills by id through
//                  `abilities` (or the intuitive `skills` alias — both are
//                  validated, presenting both is an error).
//   gears(...)   — the preferred gear-catalog setter; equipments() is kept
//                  as a DEPRECATED identical alias.
//   ailments(...)/buff(...) — REGISTER StatusDefinitions into the status
//                  catalog (they do NOT apply anything to actors; statuses
//                  reach actors only through effects / starting instances).
//                  Both accumulate into the same section (ailments and
//                  buffs are two doors into one registry); re-registering
//                  an id REPLACES that registration (later wins).
// ----------------------------------------------------------------------------
export interface UserCombat {
    /** Replace the combatant list (EntityDefinition[], D3). Copied on set. */
    actors(entities: EntityDefinition[]): UserCombat;
    /** Replace the gear catalog section (GearDefinition[] patch definitions, D9). Actor loadouts stay on the actors. */
    gears(gear: GearDefinition[]): UserCombat;
    /** DEPRECATED identical alias of gears() (R4 compatibility). */
    equipments(gear: GearDefinition[]): UserCombat;
    /** Replace the ability catalog section (AbilityDefinition[], D9). Actors reference them by id. */
    abilities(abilities: AbilityDefinition[]): UserCombat;
    /** Register the skill catalog — identical to abilities() (R4 facade naming). */
    skills(skills: AbilityDefinition[]): UserCombat;
    /** Register ailment (negative status) definitions — they join the status catalog, they do NOT apply to actors (R1). */
    ailments(statuses: StatusDefinition[]): UserCombat;
    /** Register buff (beneficial status) definitions — same registry as ailments() (R1). */
    buff(statuses: StatusDefinition[]): UserCombat;
    /** Replace the battle mode ('ffa' default; 'teams' requires teams(), D3). */
    mode(mode: BattleMode): UserCombat;
    /** Replace the team declarations (TeamDefinition[], D3 bidirectional agreement). */
    teams(teams: TeamDefinition[]): UserCombat;
    /** MERGE run-limit overrides (SimulationConfig, D3/D13): provided keys win, unset keys keep engine defaults. */
    config(config: SimulationConfig): UserCombat;
    /** Replace the RNG seed (integer 0..2^32−1 validated by the engine, D4g). */
    seed(seed: number): UserCombat;
    /** Replace the plugin list (CombatPlugin[], D6/D7). */
    plugins(plugins: CombatPlugin[]): UserCombat;
    /** Replace the builtin-rules floor flag (engine default true, D2). */
    builtinRules(active: boolean): UserCombat;
    /** Advance EXACTLY ONE engine step (D5a) and resolve with its snapshot; idempotent at terminal (D5g). */
    simulate(): Promise<SimulationSnapshot>;
    /** Current battle snapshot (D10) — creates the engine lazily, never advances it. */
    snapshot(): SimulationSnapshot;
    /** Event log so far, deep copies (D11). */
    events(): BattleEvent[];
    /** Engine reset (D10) on the current battle; after setters this is the rebuilt battle's initial state. */
    reset(): SimulationSnapshot;
    /** Live edit (T3): synchronous validated atomic combatant patch on the CURRENT battle — like reset/observations it does NOT mark the builder stale (edits are part of the live battle and survive until a setter rebuilds or reset rewinds). Throws CombatValidationError. */
    editCombatant(edit: CombatantEdit): SimulationSnapshot;
    /** True once the battle is terminal (fault/outcome/undecided). */
    isTerminal(): boolean;
    /** Terminal verdict, or null while running (D5g/D10). */
    outcome(): Outcome | null;
}

// ----------------------------------------------------------------------------
// Accumulated builder state — the single mutable record every setter writes
// and buildDefinition/buildOptions read. Own copies only: caller arrays are
// copied on set (no shared mutable defaults leak in either direction).
//
// T2: `statuses` is a Map (id → definition) because ailments()/buff()
// ACCUMULATE into one registry (documented above) while re-registering an
// id replaces it — insertion order stays deterministic for the definition.
// ----------------------------------------------------------------------------
interface BuilderState {
    entities: EntityDefinition[];
    gear: GearDefinition[];
    abilities: AbilityDefinition[];
    statuses: Map<string, StatusDefinition>;
    mode: BattleMode;
    teams: TeamDefinition[];
    config: SimulationConfig;              // only EXPLICITLY set keys
    seed: number | undefined;
    plugins: CombatPlugin[];
    builtinRules: boolean | undefined;     // undefined ⇒ leave engine default
}

// Assemble the minimal plain BattleDefinition: only sections the caller
// configured are present, so engine validation errors and default
// resolution (D9 catalog merge, D13 defaults) behave exactly as they would
// for a hand-written definition of the same shape.
const buildDefinition = (state: BuilderState): BattleDefinition => {
    const definition: BattleDefinition = {
        schemaVersion: COMBAT_SCHEMA_VERSION,
        mode: state.mode,
        entities: state.entities,
    };
    if (state.teams.length > 0) definition.teams = [...state.teams];
    if (state.gear.length > 0 || state.abilities.length > 0 || state.statuses.size > 0) {
        definition.catalogs = {};
        if (state.gear.length > 0) definition.catalogs.gear = [...state.gear];
        if (state.abilities.length > 0) definition.catalogs.abilities = [...state.abilities];
        if (state.statuses.size > 0) definition.catalogs.statuses = [...state.statuses.values()];
    }
    if (state.seed !== undefined || Object.keys(state.config).length > 0) {
        definition.startingConditions = {};
        if (state.seed !== undefined) definition.startingConditions.seed = state.seed;
        if (Object.keys(state.config).length > 0) definition.startingConditions.config = { ...state.config };
    }
    return definition;
};

// Assemble the engine construction options (D2): plugin list and the
// builtin-rules flag only when actually configured — absent fields keep the
// engine's own defaults (floor active, no plugins).
const buildOptions = (state: BuilderState): SimulationOptions => {
    const options: SimulationOptions = {};
    if (state.plugins.length > 0) options.plugins = [...state.plugins];
    if (state.builtinRules !== undefined) options.builtinRules = state.builtinRules;
    return options;
};

// ----------------------------------------------------------------------------
// createUserCombat — isolated builder factory (R2). The returned instance
// owns its BuilderState; nothing is shared with the userCombat singleton or
// with other instances.
// ----------------------------------------------------------------------------
export const createUserCombat = (): UserCombat => {
    const state: BuilderState = {
        entities: [],
        gear: [],
        abilities: [],
        statuses: new Map<string, StatusDefinition>(),
        mode: 'ffa',
        teams: [],
        config: {},
        seed: undefined,
        plugins: [],
        builtinRules: undefined,
    };

    // Lazy engine handle: built on first access, rebuilt after ANY setter
    // (documented invalidation rule 2 in the file header).
    let simulation: Simulation | undefined;
    let stale = true;
    const resolve = (): Simulation => {
        if (stale || simulation === undefined) {
            simulation = createSimulation(buildDefinition(state), buildOptions(state));
            stale = false;
        }
        return simulation;
    };

    // status-definition registration shared by ailments()/buff() (R1):
    // accumulate into ONE registry; re-registering an id REPLACES it.
    const registerStatuses = (definitions: StatusDefinition[]): UserCombat => {
        for (const definition of definitions) state.statuses.set(definition.id, { ...definition });
        stale = true;
        return api;
    };

    const api: UserCombat = {
        actors: (entities) => {
            state.entities = [...entities];
            stale = true;
            return api;
        },
        gears: (gear) => {
            state.gear = [...gear];
            stale = true;
            return api;
        },
        // Deprecated identical alias of gears() (R4 compatibility — every
        // prior caller keeps working; the JSDoc marks it deprecated).
        equipments: (gear) => api.gears(gear),
        abilities: (abilities) => {
            state.abilities = [...abilities];
            stale = true;
            return api;
        },
        // Identical registration surface to abilities() (R4 facade naming);
        // both replace the same domain (last call wins).
        skills: (skills) => api.abilities(skills),
        ailments: registerStatuses,
        buff: registerStatuses,
        mode: (mode) => {
            state.mode = mode;
            stale = true;
            return api;
        },
        teams: (teams) => {
            state.teams = [...teams];
            stale = true;
            return api;
        },
        // config MERGES: later keys win, earlier keys persist until
        // overridden; keys never set stay absent ⇒ engine defaults (header).
        config: (config) => {
            state.config = { ...state.config, ...config };
            stale = true;
            return api;
        },
        seed: (seed) => {
            state.seed = seed;
            stale = true;
            return api;
        },
        plugins: (plugins) => {
            state.plugins = [...plugins];
            stale = true;
            return api;
        },
        builtinRules: (active) => {
            state.builtinRules = active;
            stale = true;
            return api;
        },
        // Async boundary: resolve() may throw CombatValidationError /
        // CombatPluginError synchronously — inside an async method that
        // becomes the promise REJECTION (sync accessors throw, simulate
        // rejects; documented failure-mode split in the header).
        simulate: async () => resolve().step(),
        snapshot: () => resolve().snapshot(),
        events: () => resolve().events(),
        reset: () => resolve().reset(),
        // T3 live edit: SYNCHRONOUS like reset/observations, and — unlike
        // every setter — it does NOT set `stale`: the edit applies to the
        // live battle in place (validate + atomic patch through the runner).
        editCombatant: (edit) => resolve().editCombatant(edit),
        isTerminal: () => resolve().isTerminal(),
        outcome: () => resolve().outcome(),
    };
    return api;
};

// Ready-to-configure singleton (R2). Configuration ACCUMULATES across uses —
// see the header ("Configuration semantics") for the replace/merge rules and
// use createUserCombat() whenever battles must stay isolated.
export const userCombat: UserCombat = createUserCombat();
