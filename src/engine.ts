// ============================================================================
// @userfiction/combat â€” src/engine.ts â€” T5 createSimulation wiring (task Â§9
// T5, D1/D2 construction, D9/D10 resolution + restore, D4f limits)
// ============================================================================
// The public headless entrypoint. Construction is FAIL-FAST (D2): the
// definition is validated with the REGISTERED plugin vocab ids (D8: an
// unregistered namespaced condition/effect type is a validation error once
// plugins are known â€” the standalone validator defers that check), then the
// plugin registry is built; either failure throws with the full collected
// error list (CombatValidationError / CombatPluginError â€” deliberate
// divergence from reader quarantine, D2 rationale).
//
// Order of construction (each step's rationale inline):
//   1. deep-copy the input            â€” R9 no-input-mutation + D7 "all
//      returned objects are deep copies"; the caller's object is never
//      aliased into engine state.
//   2. resolveBattleDefinition        â€” D10 "resolved copy (catalogs
//      merged)": Simulation.definition and every snapshot carry this.
//   3. vocab ids from [builtin?, plugins] â€” fed to validation (see header).
//   4. validateBattleDefinition       â€” collect-all, then throw.
//   5. registry (builtin â†’ code â†’ synthetic JSON rules, D6) with the
//      deferred runtime thunk (plugins.ts seam: the adapter needs the
//      registry for strike, so it is resolved lazily â€” no construction cycle).
//   6. fresh state OR restore (D10): restore validates schemaVersion/state
//      shape (state.ts guards, re-thrown as CombatValidationError per the
//      D2 fail-fast stance) AND definition compatibility (deep-equal against
//      the resolved definition â€” snapshots carry the resolved form, so a
//      mismatch means the snapshot was built from a different battle).
//   7. fresh path only: arm the schedule (D4a through the ACTIVE interval
//      hook), emit battle:start {seed, mode} (D11), run the step-0
//      outcome:decide evaluation (D5g no-enemies draw).
//
// RNG persistence (D4g/D10): the controller is the live stream; the plain
// {seed, state, draws} block is synced into state.rng at the end of every
// step and restored on rollback (pipeline) and on construction/restore here.
//
// Terminal idempotence (D5g): step()/run() on a terminal battle return the
// current snapshot unchanged and emit nothing. run(limit?) stops after
// `limit` extra steps; a non-terminal battle with an empty schedule (all
// dead, no decide handler â€” pipeline decision 9) also stops run() so the
// synchronous loop can never spin forever.
// ============================================================================

import { deepCopy, createCombatState, createEntityState, snapshotOf, restoreFrom } from './state';
import type { CombatState, EntityState } from './state';
import { createRng } from './rng';
import { createEventLog } from './events';
import { createPluginRegistry } from './plugins';
import type { PluginRegistry, PluginRegistryRuntime } from './plugins';
import { defaultRules, isDefaultRulesPlugin } from './rules';
import { defaultGearSeed, resolveBattleDefinition } from './catalogs';
import { validateBattleDefinition } from './validation';
import { createTurnRunner } from './pipeline';
import type { TurnRunner } from './pipeline';
import { namespaced } from './ids';
import {
    CombatValidationError,
    DEFAULT_ABILITY_COOLDOWN,
    DEFAULT_MAX_CASCADE,
    DEFAULT_MAX_LOG_EVENTS,
    DEFAULT_MAX_STEPS,
    DEFAULT_SEED,
} from './types';
import type {
    AbilityDefinition,
    BattleDefinition,
    CombatPlugin,
    CreateSimulation,
    EquipmentEntry,
    GearDefinition,
    GearRef,
    ResolvedSimulationConfig,
    Simulation,
    SimulationOptions,
    SimulationSnapshot,
} from './types';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Registered namespaced vocab type ids (D8): what the engine hands to
// validation so unregistered 'pluginId/name' types become errors. Defensive
// against malformed plugins (the registry reports those next; this pass only
// reads shapes).
const collectVocabIds = (plugins: readonly (CombatPlugin | undefined)[]): { conditions: string[]; effects: string[] } => {
    const conditions: string[] = [];
    const effects: string[] = [];
    for (const plugin of plugins) {
        if (plugin === undefined || typeof plugin !== 'object' || typeof plugin.id !== 'string') continue;
        if (plugin.vocab?.conditions) {
            for (const key of Object.keys(plugin.vocab.conditions)) conditions.push(namespaced(plugin.id, key));
        }
        if (plugin.vocab?.effects) {
            for (const key of Object.keys(plugin.vocab.effects)) effects.push(namespaced(plugin.id, key));
        }
    }
    return { conditions, effects };
};

// Order-insensitive deep equality over plain JSON data (D10 restore
// compatibility check). Kept local: state.ts exports deepCopy but no
// comparator, and this is the only engine-side need.
const deepEqualPlain = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, index) => deepEqualPlain(item, b[index]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = Object.keys(ao);
    if (keys.length !== Object.keys(bo).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqualPlain(ao[key], bo[key]));
};

// ----------------------------------------------------------------------------
// createSimulation (D2)
// ----------------------------------------------------------------------------

export const createSimulation: CreateSimulation = (input, options: SimulationOptions = {}) => {
    // 1. input deep copy â€” the stored/resolved definition shares no
    //    reference with the caller's object (R9)
    const inputCopy = deepCopy(input);

    // 2. resolved definition (D10): catalogs merged over the builtin seed
    const resolved: BattleDefinition = resolveBattleDefinition(inputCopy);

    // effective catalog lookups (D9): resolveBattleDefinition folded gear
    // patches when a catalogs section exists; no section â‡’ builtin seed
    const gearList: readonly GearDefinition[] = resolved.catalogs?.gear ?? defaultGearSeed;
    const gearById = new Map<string, GearDefinition>(gearList.map((definition) => [definition.id, definition]));
    const abilityList: readonly AbilityDefinition[] = resolved.catalogs?.abilities ?? [];
    const abilityById = new Map<string, AbilityDefinition>(abilityList.map((definition) => [definition.id, definition]));

    // 3. registered vocab ids â€” builtin ships no vocab today but is included
    //    so a future floor extension is validated consistently.
    //
    //    FLOOR NORMALIZATION (Â§7 canonical usage fix, D6/D7): a genuine
    //    defaultRules() instance passed in options.plugins (identity-branded
    //    by the factory, rules.ts) is NORMALIZED into the builtin floor
    //    instead of registering as an ordinary code plugin â€” re-passing it
    //    would otherwise trip duplicate-id AND ten undeclared-single-handler
    //    load rejections. The normalized floor is rebuilt against the
    //    RESOLVED battle catalog (defaults resolve to current gear/
    //    abilities, D9/D10), so the explicit instance's captured options are
    //    intentionally superseded. An explicit instance activates the floor
    //    even with builtinRules:false (the documented "client uses the same
    //    contract" path); the auto floor then must not duplicate it.
    //    Unbranded impostors reusing the id string stay ordinary plugins â€”
    //    arbitrary duplicate ids keep failing fast (D7).
    const codePlugins = options.plugins ?? [];
    let explicitFloor: CombatPlugin | undefined;
    for (const plugin of codePlugins) {
        if (isDefaultRulesPlugin(plugin)) explicitFloor = plugin; // last wins (D6 order philosophy)
    }
    const floorActive = options.builtinRules !== false || explicitFloor !== undefined;
    const clientPlugins = codePlugins.filter((plugin) => !isDefaultRulesPlugin(plugin));
    const vocabIds = collectVocabIds([floorActive ? defaultRules() : undefined, ...clientPlugins]);

    // 4. definition validation with registered ids (D2/D8) â€” throw the full
    //    collected list, never a silent skip
    const validation = validateBattleDefinition(inputCopy, { vocab: vocabIds });
    if (!validation.valid) throw new CombatValidationError(validation.errors);

    // limits + seed (D3/D13 defaults; validation already range-checked)
    const config: ResolvedSimulationConfig = {
        maxSteps: resolved.startingConditions?.config?.maxSteps ?? DEFAULT_MAX_STEPS,
        maxCascade: resolved.startingConditions?.config?.maxCascade ?? DEFAULT_MAX_CASCADE,
        maxLogEvents: resolved.startingConditions?.config?.maxLogEvents ?? DEFAULT_MAX_LOG_EVENTS,
    };
    const seed = resolved.startingConditions?.seed ?? DEFAULT_SEED;

    // status resistances (D5e) are DEFINITION data, not snapshot state
    // (EntitySnapshot has no such field) â€” derived from the resolved
    // definition, so a restore re-derives them identically from
    // snapshot.definition (which deep-equals the resolved definition).
    const resistances: Record<string, Record<string, number>> = {};
    for (const entity of resolved.entities) {
        if (entity.statusResistances) resistances[entity.id] = deepCopy(entity.statusResistances);
    }

    // 5. registry + runner behind a deferred runtime thunk (plugins.ts seam)
    const rng = createRng(seed);
    const log = createEventLog(config.maxLogEvents);
    // late-bound vocab for the default selector's ability-conditions gate
    // (rules.ts): the registry is the vocab source, built right after
    let registryRef: PluginRegistry | undefined;
    const lateVocab = {
        condition: (id: string) => registryRef?.vocab.condition(id),
        effect: (id: string) => registryRef?.vocab.effect(id),
    };
    const builtin = floorActive ? defaultRules({ gear: gearList, abilities: abilityList, vocab: lateVocab }) : undefined;
    const registry = createPluginRegistry({
        builtin,
        plugins: clientPlugins,
        rules: resolved.rules?.contributions,
        runtime: (): PluginRegistryRuntime => runner.runtime(),
    });
    registryRef = registry;

    // ---- fresh-state builders (used by construction AND reset) ----

    // Equipment refs â†’ pre-resolved EquipmentEntry (state.ts EntitySeed
    // contract): durability override or catalog value (D3 GearRef).
    const equipmentEntries = (refs: GearRef[] | undefined): EquipmentEntry[] =>
        (refs ?? []).map((ref) => ({
            gearId: ref.id,
            slot: ref.slot,
            durability: ref.durability ?? (gearById.get(ref.id) as GearDefinition).durability,
        }));

    const buildEntities = (): EntityState[] =>
        resolved.entities.map((entity, index) =>
            createEntityState({
                id: entity.id,
                name: entity.name,
                team: entity.team,
                order: index,
                stats: entity.stats,
                statuses: entity.statuses,
                equipment: [...equipmentEntries(entity.equipment?.weapons), ...equipmentEntries(entity.equipment?.armour)],
                // every declared ability starts off cooldown (D9 default 0)
                cooldowns: Object.fromEntries((entity.abilities ?? []).map((abilityId) => [abilityId, DEFAULT_ABILITY_COOLDOWN])),
            }),
        );

    const buildFreshState = (): CombatState => {
        // reset() re-derives the initial state with the SAME seed (D10):
        // rewind the controller first so state.rng below captures the fresh
        // position (mulberry32 initial state = seed normalized, 0 draws)
        rng.restoreState({ seed: seed >>> 0, state: seed >>> 0, draws: 0 });
        return createCombatState({
            mode: resolved.mode,
            entities: buildEntities(),
            rng: rng.exportState(),
            schedule: [],
            step: 0,
            virtualTime: 0,
            terminal: null,
        });
    };

    // 6/7. construction: restore path or fresh path
    let runner: TurnRunner;
    if (options.restore !== undefined) {
        const snapshot = options.restore;
        // D10 compatibility: the snapshot must come from THIS resolved
        // definition (plugins are not serialized â€” same-plugin-set is the
        // client's contract, declared in D10/D4g)
        if (!deepEqualPlain(snapshot.definition, resolved)) {
            throw new CombatValidationError(['restore: snapshot definition does not match the resolved battle definition']);
        }
        if (!Array.isArray(snapshot.events)) {
            throw new CombatValidationError(['restore: snapshot.events must be an array']);
        }
        let restored: CombatState;
        try {
            restored = restoreFrom(snapshot);
        } catch (error) {
            // state.ts shape guards â†’ D2 fail-fast error class
            throw new CombatValidationError([error instanceof Error ? error.message : String(error)]);
        }
        runner = createTurnRunner({
            state: restored,
            registry,
            rng,
            log,
            config,
            gear: (gearId) => gearById.get(gearId),
            ability: (abilityId) => abilityById.get(abilityId),
            resistances,
            builtinRules: floorActive,
        });
        // exact stream position (D10) + stored log with ids continuing from
        // max(id)+1; NO battle:start re-emit, NO re-arm, NO step-0 decide â€”
        // the restored log and schedule already carry them
        rng.restoreState(restored.rng);
        log.restore(snapshot.events);
    } else {
        runner = createTurnRunner({
            state: buildFreshState(),
            registry,
            rng,
            log,
            config,
            gear: (gearId) => gearById.get(gearId),
            ability: (abilityId) => abilityById.get(abilityId),
            resistances,
            builtinRules: floorActive,
        });
        runner.armInitialSchedule();
        // battle:start (D11) â€” direct log write: construction events are
        // outside any step transaction and must not touch the cascade counter
        log.emit({ type: 'battle:start', payload: { seed, mode: resolved.mode } }, 0, 0);
        runner.decideAtStepZero();
        log.trim(0, 0);
    }

    // ---- the public Simulation object (D2) -----------------------------------

    const simulation: Simulation = {
        // placeholder â€” replaced by the deep-copy getter below (D2: mutating
        // returned objects never affects engine state)
        definition: resolved,
        snapshot: (): SimulationSnapshot => snapshotOf(runner.state(), resolved, log.all()),
        events: () => deepCopy(log.all()),
        step: () => {
            if (runner.state().terminal === null) runner.step();
            return simulation.snapshot();
        },
        run: (limit?: number) => {
            let executed = 0;
            while (runner.state().terminal === null && (limit === undefined || executed < limit)) {
                const advanced = runner.step();
                executed += 1;
                // no progress possible (empty schedule, non-terminal) â€” stop
                // instead of spinning (pipeline decision 9)
                if (!advanced) break;
            }
            return simulation.snapshot();
        },
        reset: () => {
            // rewind to the initial state from the STORED definition copy
            // with the same seed â‡’ a fresh full run is reproducible (D10)
            runner.setState(buildFreshState());
            runner.armInitialSchedule();
            log.clear();
            log.emit({ type: 'battle:start', payload: { seed, mode: resolved.mode } }, 0, 0);
            runner.decideAtStepZero();
            log.trim(0, 0);
            return simulation.snapshot();
        },
        isTerminal: () => runner.state().terminal !== null,
        outcome: () => deepCopy(runner.state().terminal),
    };

    // Simulation.definition is a live deep copy per access (D2 copy rule);
    // defineProperty keeps the declared data-property shape of the interface.
    Object.defineProperty(simulation, 'definition', {
        get: (): BattleDefinition => deepCopy(resolved),
        enumerable: true,
        configurable: false,
    });

    return simulation;
};
