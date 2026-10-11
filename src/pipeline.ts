// ============================================================================
// @userfiction/combat — src/pipeline.ts — T5 turn skeleton (task §9 T5,
// D5a phases 1–15, D4e scheduling moves, D7 transaction + fault policy)
// ============================================================================
// The engine-owned per-step machinery. One `step()` = ONE picked schedule
// entry + full cascade (D4e/D5a), wrapped in the D7 transaction boundary:
//
//   before the turn: snapshotStateOf(state) + log marker (length + next id);
//   on any handler throw / invalid single-mode return / cascade-cap breach /
//   strike-depth violation: state + RNG + log + event counters are restored
//   to the marker, every event emitted inside the step is removed, ONE
//   'fault' event is appended, and the simulation enters terminal 'fault'
//   (no quarantine-and-continue, D7). The terminal 'outcome' event follows
//   the fault event (D11: emitted exactly once when terminal is stamped —
//   decide verdict OR engine fault).
//
// Mutation ownership (D7): handlers receive fresh deep-copied StateViews and
// return data; EVERY write goes through this module's state.ts helper calls
// (the EffectAdapter the interpreter mutates through, the phase defaults'
// PhaseDefaultApi, and the direct damage/status/cooldown writes below).
//
// Documented integration decisions (tensions resolved conservatively; each
// cites its source):
//   1. Readiness re-arm runs AFTER action:select, not literally inside
//      phase-1 (D5a.1 lists "advance readiness" before turn:start, but D4b
//      ties the interval to the ACTION's cost — ability cost is unknown
//      until selection). The action-cost + pick-time effective speed +
//      hook-routed interval all follow D4e exactly; event order is
//      unchanged (turn:start still precedes the action event).
//   2. The 'action' event is emitted once, after targeting resolves: a
//      null target downgrades the logged action to
//      { kind:'skip', reason:'no-target' } (D5a.3 "the turn logs a skip")
//      instead of double-logging.
//   3. crit multiplier is applied by the ENGINE between damage:base and
//      damage:mitigate (D5a.6 "damage ×1.5" + D5a.8 "a blocked crit is
//      ×0.75 net" — mitigate's args have no crit flag, so the amount
//      entering mitigate already carries it).
//   4. damage events carry payload.crit (see events.ts header) so the
//      pinned "(crit!)" renderer variant can fire.
//   5. Weapon choice with two weapon slots: weapon-1 first, else weapon-2
//      (D5e slots exist; the default attack order is unspecified — pinned
//      here, replaceable via damage hooks).
//   6. modify-stat speed on the CURRENT actor never reschedules its
//      just-re-armed entry (D4e reschedules "OTHER entities"; the actor's
//      readiness uses the speed snapshotted at pick time, D5a.1).
//   7. Ability cooldown: set on use, NOT decremented on the use turn
//      (skipped via cooldownSetThisTurn), so cooldown N costs exactly N
//      future own-turns (D9 "in the actor's own scheduled turns").
//   8. Unclaimed single hooks with builtinRules:false (D5g declares only
//      the decide-null behavior): scheduler:interval/order fall back to
//      scheduler.ts pure defaults (structural math, not gameplay rules);
//      action:select ⇒ wait; target:select ⇒ null; dodge/crit ⇒ false;
//      damage:base/mitigate/ability:execute ⇒ fault (no rule to compute).
//   9. Empty schedule + non-terminal (all dead, no decide handler): step()
//      makes no progress and returns false so run() stops instead of
//      spinning forever (declared; D5g builtinRules:false caveat).
//  10. outcome:decide ctx enforces "no rng / no emit" by throwing methods
//      (D7 "engine-enforced"); a handler that calls them faults the step.
//      Its refs.actor falls back to the first entity at step 0 (no actor
//      has acted yet).
// ============================================================================

import {
    advanceEntry,
    buildInitialEntries,
    defaultInterval,
    defaultOrder,
    pickNext,
    rescheduleEntry,
} from './scheduler';
import type { CandidateLookup, IntervalFn, OrderFn } from './scheduler';
import {
    addStatModifier,
    applyStatus,
    ARMOUR_SLOTS,
    breakGear,
    damageEntity,
    damageGear,
    decrementStatModifiers,
    dropScheduleEntries,
    effectiveStatsOf,
    entityViewOf,
    findEntity,
    healEntity,
    removeGear,
    removeStatus,
    restoreFrom,
    snapshotStateOf,
    stateViewOf,
} from './state';
import type { CombatState } from './state';
import { applyEquipmentPostDefault, applyStatusTurnEndDefault } from './rules';
import type { PhaseDefaultApi } from './rules';
import { applyEffects } from './effects';
import type { EffectAdapter, InterpreterDeps } from './effects';
import type { EventLog } from './events';
import type { PluginRegistry, PluginRegistryRuntime } from './plugins';
import {
    COMBAT_SCHEMA_VERSION,
    CRIT_MULTIPLIER,
    DAMAGE_TYPES,
    DEFAULT_ABILITY_COST,
    DEFAULT_ACTION_COST,
    MAX_STRIKE_DEPTH,
    MIN_INTERVAL_US,
} from './types';
import type {
    AbilityDefinition,
    ActionSelection,
    BattleDefinition,
    EffectDescriptor,
    EntityView,
    EquipmentEntry,
    EventDraft,
    GearDefinition,
    HookId,
    OutcomeDecideContext,
    OutcomeVerdict,
    ResolvedSimulationConfig,
    RngStream,
    SchedulerIntervalArgs,
    SchedulerOrderArgs,
    SingleHookId,
    StepContext,
    StepContextRefs,
} from './types';
import type { RngController } from './rng';

// ----------------------------------------------------------------------------
// Config + surface
// ----------------------------------------------------------------------------

export interface TurnRunnerConfig {
    state: CombatState;
    registry: PluginRegistry;
    rng: RngController;
    log: EventLog;
    config: ResolvedSimulationConfig;
    // effective catalog lookups (D9 merged gear; abilities have no seed, D9)
    gear: (gearId: string) => GearDefinition | undefined;
    ability: (abilityId: string) => AbilityDefinition | undefined;
    // entityId → statusId → 0..1 (D5e) — definition-derived, engine-owned
    resistances: Record<string, Record<string, number>>;
    // builtin floor active ⇒ D5b/D5c chain-phase defaults run (see rules.ts
    // header: that IS their replaceability — dropping the floor removes them)
    builtinRules: boolean;
}

export interface TurnRunner {
    state(): CombatState;
    setState(next: CombatState): void;
    // fresh construction: D4a initial entries through the ACTIVE interval hook
    armInitialSchedule(): void;
    // fresh construction: the step-0 outcome:decide evaluation (D5g
    // no-enemies draw); stamps terminal + emits the outcome event on verdict
    decideAtStepZero(): void;
    // one scheduled turn + cascade; false ⇒ no progress (decision 9)
    step(): boolean;
    // registry runtime seam (plugins.ts): adapter + fresh view provider
    runtime(): PluginRegistryRuntime;
}

// ----------------------------------------------------------------------------
// Fault carrier — internal control flow. Carries the D7 fault-event fields;
// attribution comes from the active hook/plugin tracked around every handler
// invocation (registry singleOwner/chainOwner).
// ----------------------------------------------------------------------------
class CombatFault extends Error {
    readonly pluginId?: string;
    readonly hook?: HookId;
    constructor(message: string, pluginId?: string, hook?: HookId) {
        super(message);
        this.name = 'CombatFault';
        this.pluginId = pluginId;
        this.hook = hook;
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

// ----------------------------------------------------------------------------
// createTurnRunner
// ----------------------------------------------------------------------------
export const createTurnRunner = (cfg: TurnRunnerConfig): TurnRunner => {
    let state = cfg.state;
    // cascade nesting counter (D5a.12 strike depth; ctx.depth)
    let attackDepth = 0;
    // events emitted within the current step (D4f maxCascade cap)
    let stepEvents = 0;
    // fault attribution: which hook/plugin was executing when a throw fired
    let activeHook: HookId | undefined;
    let activePluginId: string | undefined;
    // current turn refs (D7 StepContext.refs source)
    let currentActorId: string | undefined;
    let currentTargetId: string | undefined;
    // decision 7: cooldown set this turn is exempt from the same-turn decrement
    let cooldownSetThisTurn: string | undefined;

    // ---- helpers over live state ------------------------------------------------

    const effSpeed = (entityId: string): number => {
        const entity = findEntity(state, entityId);
        // entity.stats is DERIVED and stale between boundaries (state.ts
        // comment) — always recompute from base + modifiers (D5c "effective
        // stats are recomputed at each use")
        return effectiveStatsOf(entity.baseStats, entity.statModifiers).speed;
    };

    const lookup: CandidateLookup = (entityId) => {
        const entity = findEntity(state, entityId);
        return { effectiveSpeed: effectiveStatsOf(entity.baseStats, entity.statModifiers).speed, order: entity.order };
    };

    // THE append point: stamps id/step/time (events.ts) and enforces the
    // per-step cascade cap (D4f — exceeding is a FAULT, not a feature).
    const emit = (draft: EventDraft): void => {
        stepEvents += 1;
        if (stepEvents > cfg.config.maxCascade) {
            throw new CombatFault(
                `maxCascade exceeded: more than ${cfg.config.maxCascade} events in one step`,
                undefined,
                activeHook,
            );
        }
        cfg.log.emit(draft, state.step, state.virtualTime);
    };

    const buildRefs = (actorId?: string, targetId?: string): StepContextRefs => {
        const resolvedActor = actorId ?? currentActorId ?? state.entities[0]?.id;
        if (!resolvedActor) throw new CombatFault('hook invoked with no entities');
        const refs: StepContextRefs = { actor: entityViewOf(findEntity(state, resolvedActor)) };
        const resolvedTarget = targetId !== undefined ? targetId : currentTargetId;
        if (resolvedTarget !== undefined) refs.target = entityViewOf(findEntity(state, resolvedTarget));
        return refs;
    };

    const makeCtx = (hook: HookId, actorId?: string, targetId?: string): StepContext => ({
        rng: cfg.rng,
        emit,
        step: state.step,
        time: state.virtualTime,
        hook,
        depth: attackDepth,
        refs: buildRefs(actorId, targetId),
    });

    const withAttribution = <T>(hook: HookId, pluginId: string | undefined, run: () => T): T => {
        const prevHook = activeHook;
        const prevPlugin = activePluginId;
        activeHook = hook;
        activePluginId = pluginId;
        try {
            return run();
        } catch (error) {
            // an un-attributed throw from inside a handler becomes a fault
            // OWNED by this hook/plugin (D7 fault event fields) — the finally
            // below would otherwise erase the attribution on unwind
            if (error instanceof CombatFault && (error.hook !== undefined || error.pluginId !== undefined)) throw error;
            throw new CombatFault(messageOf(error), pluginId, hook);
        } finally {
            activeHook = prevHook;
            activePluginId = prevPlugin;
        }
    };

    // ---- single-mode hook calls + result validation (D6/D7: an invalid or
    // undefined return from a single-mode handler is a fault). The validator
    // runs INSIDE the attributed region so faults name the owning plugin. ---

    const callSingle = <T>(hook: SingleHookId, args: unknown, validate: (result: unknown) => T, actorId?: string, targetId?: string): T | undefined => {
        const handler = cfg.registry.single(hook);
        if (!handler) return undefined;
        return withAttribution(hook, cfg.registry.singleOwner(hook), () =>
            validate(handler(stateViewOf(state), makeCtx(hook, actorId, targetId), args)),
        );
    };

    const requireFinite = (value: unknown, label: string, field: string): number => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new CombatFault(`invalid ${label} result: '${field}' must be a finite number`, activePluginId, activeHook);
        }
        return value;
    };
    const requireBoolean = (value: unknown, label: string, field: string): boolean => {
        if (typeof value !== 'boolean') {
            throw new CombatFault(`invalid ${label} result: '${field}' must be a boolean`, activePluginId, activeHook);
        }
        return value;
    };

    // Per-hook validators — each returns the normalized result or faults.
    const validateActionSelect = (result: unknown): ActionSelection => {
        if (!isPlainObject(result)) throw new CombatFault('invalid action:select result: expected an object', activePluginId, activeHook);
        const kind = result.kind;
        if (kind !== 'attack' && kind !== 'ability' && kind !== 'wait' && kind !== 'skip') {
            throw new CombatFault(`invalid action:select result: unknown kind '${String(kind)}'`, activePluginId, activeHook);
        }
        const selection: ActionSelection = { kind };
        if (result.abilityId !== undefined) {
            if (typeof result.abilityId !== 'string' || result.abilityId === '') {
                throw new CombatFault('invalid action:select result: abilityId must be a non-empty string', activePluginId, activeHook);
            }
            selection.abilityId = result.abilityId;
        }
        if (result.reason !== undefined) {
            if (typeof result.reason !== 'string') {
                throw new CombatFault('invalid action:select result: reason must be a string', activePluginId, activeHook);
            }
            selection.reason = result.reason;
        }
        if (kind === 'ability' && selection.abilityId === undefined) {
            throw new CombatFault("invalid action:select result: kind 'ability' requires abilityId", activePluginId, activeHook);
        }
        return selection;
    };

    const validateTargetSelect = (result: unknown): string | null => {
        if (result === null) return null;
        if (typeof result !== 'string') {
            throw new CombatFault('invalid target:select result: expected entityId string or null', activePluginId, activeHook);
        }
        // D6/D5a.3 closed contract: a valid target is a LIVING ENEMY — ffa
        // every other living entity, teams a living member of ANOTHER team.
        // A teammate (or self/dead/unknown) return is an invalid single-mode
        // result ⇒ fault with rollback; targeting is not a friendly-fire
        // mechanic clients can bend through this hook.
        const entity = state.entities.find((candidate) => candidate.id === result);
        const actorEntity = currentActorId === undefined ? undefined : state.entities.find((candidate) => candidate.id === currentActorId);
        const validEnemy =
            entity !== undefined &&
            entity.living &&
            result !== currentActorId &&
            (state.mode !== 'teams' || entity.team !== actorEntity?.team);
        if (!validEnemy) {
            throw new CombatFault(`invalid target:select result: '${result}' is not a living enemy`, activePluginId, activeHook);
        }
        return result;
    };

    const validateDodge = (result: unknown): { dodged: boolean } => {
        if (!isPlainObject(result)) throw new CombatFault('invalid attack:dodge result: expected an object', activePluginId, activeHook);
        return { dodged: requireBoolean(result.dodged, 'attack:dodge', 'dodged') };
    };

    const validateCrit = (result: unknown): { crit: boolean } => {
        if (!isPlainObject(result)) throw new CombatFault('invalid attack:crit result: expected an object', activePluginId, activeHook);
        return { crit: requireBoolean(result.crit, 'attack:crit', 'crit') };
    };

    const validateBase = (result: unknown): { amount: number; damageType: 'blunt' | 'sharp' } => {
        if (!isPlainObject(result)) throw new CombatFault('invalid damage:base result: expected an object', activePluginId, activeHook);
        const amount = requireFinite(result.amount, 'damage:base', 'amount');
        if (amount < 0) throw new CombatFault('invalid damage:base result: amount must be >= 0', activePluginId, activeHook);
        if (!DAMAGE_TYPES.includes(result.damageType as 'blunt' | 'sharp')) {
            throw new CombatFault(`invalid damage:base result: damageType '${String(result.damageType)}'`, activePluginId, activeHook);
        }
        return { amount, damageType: result.damageType as 'blunt' | 'sharp' };
    };

    const validateMitigate = (result: unknown): { amount: number; blocked: boolean; armourFactor: number; defenseFactor: number } => {
        if (!isPlainObject(result)) throw new CombatFault('invalid damage:mitigate result: expected an object', activePluginId, activeHook);
        const amount = requireFinite(result.amount, 'damage:mitigate', 'amount');
        if (amount < 0) throw new CombatFault('invalid damage:mitigate result: amount must be >= 0', activePluginId, activeHook);
        const blocked = requireBoolean(result.blocked, 'damage:mitigate', 'blocked');
        const armourFactor = requireFinite(result.armourFactor, 'damage:mitigate', 'armourFactor');
        const defenseFactor = requireFinite(result.defenseFactor, 'damage:mitigate', 'defenseFactor');
        return { amount, blocked, armourFactor, defenseFactor };
    };

    const validateEffects = (result: unknown): unknown[] => {
        if (!Array.isArray(result)) throw new CombatFault('invalid ability:execute result: expected an EffectDescriptor[]', activePluginId, activeHook);
        return result;
    };

    const validateDecide = (result: unknown): OutcomeVerdict | null => {
        if (result === null || result === undefined) return null;
        if (!isPlainObject(result)) throw new CombatFault('invalid outcome:decide result: expected verdict object or null', activePluginId, activeHook);
        const kind = result.outcome;
        if (kind !== 'victory' && kind !== 'draw' && kind !== 'undecided' && kind !== 'fault') {
            throw new CombatFault(`invalid outcome:decide result: unknown outcome '${String(kind)}'`, activePluginId, activeHook);
        }
        const verdict: OutcomeVerdict = { outcome: kind };
        for (const field of ['winner', 'reason', 'error'] as const) {
            const value = result[field];
            if (value !== undefined) {
                if (typeof value !== 'string') {
                    throw new CombatFault(`invalid outcome:decide result: '${field}' must be a string`, activePluginId, activeHook);
                }
                verdict[field] = value;
            }
        }
        return verdict;
    };

    // ---- scheduler hook routing (D4e: EVERY entry computation goes through
    // the ACTIVE hooks; unclaimed ⇒ scheduler.ts structural defaults, 8) -----

    const intervalFn: IntervalFn = (args: SchedulerIntervalArgs) => {
        const result = callSingle('scheduler:interval', args, (raw) => {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
                throw new CombatFault('invalid scheduler:interval result: expected a finite number', activePluginId, activeHook);
            }
            return raw;
        }, args.entityId);
        // unclaimed ⇒ scheduler.ts structural default (decision 8)
        const value = result ?? defaultInterval(args);
        // integer-µs contract re-applied to whatever the hook returns (D4b)
        return Math.max(MIN_INTERVAL_US, Math.round(value));
    };

    const orderFn: OrderFn = (args: SchedulerOrderArgs) => {
        const result = callSingle('scheduler:order', args, (raw) => {
            if (typeof raw !== 'string' || !args.candidates.some((candidate) => candidate.entityId === raw)) {
                throw new CombatFault('invalid scheduler:order result: not a candidate entityId', activePluginId, activeHook);
            }
            return raw;
        });
        return result ?? defaultOrder(args);
    };

    // ---- equipment helpers ------------------------------------------------------

    // decision 5: primary-hand weapon first
    const currentWeapon = (attacker: EntityView): EquipmentEntry | undefined =>
        attacker.equipment.find((piece) => piece.slot === 'weapon-1') ?? attacker.equipment.find((piece) => piece.slot === 'weapon-2');

    // D5b contributors: equipped armour pieces with resistance > 0 for the
    // incoming type — computed by the ENGINE so chain handlers never need the
    // catalog (types.ts EquipmentPostArgs comment).
    const contributors = (target: EntityView, damageType: 'blunt' | 'sharp'): EquipmentEntry[] =>
        target.equipment.filter((piece) => {
            if (!ARMOUR_SLOTS.includes(piece.slot)) return false;
            const definition = cfg.gear(piece.gearId);
            if (!definition) return false;
            return (damageType === 'blunt' ? definition.blunt : definition.sharp) > 0;
        });

    // death bookkeeping (D5a.9): entries dropped immediately (D4e)
    const handleDeath = (entityId: string, killed: boolean, killerId?: string): void => {
        if (!killed) return;
        emit({ type: 'death', actor: entityId, payload: killerId ? { killerId } : {} });
        dropScheduleEntries(state, entityId);
    };

    // ---- engine-owned mutation adapter (effects.ts EffectAdapter contract) ----

    const adapter: EffectAdapter = {
        // D5a.12: strike runs phases 5–11 for the CURRENT refs; depth guard
        // (exceeding MAX_STRIKE_DEPTH ⇒ fault, D8)
        strike: () => {
            const nextDepth = attackDepth + 1;
            if (nextDepth > MAX_STRIKE_DEPTH) {
                throw new CombatFault(`strike recursion depth exceeded (max ${MAX_STRIKE_DEPTH})`, activePluginId, activeHook);
            }
            runAttack(nextDepth);
        },
        damageFlat: (entityId, amount, damageType) => {
            // D8: bypasses mitigation, can kill; 'true' bypasses armour (it
            // never enters mitigation at all). Engine emits the damage event
            // with source 'effect' (D11).
            const result = damageEntity(state, entityId, amount);
            emit({
                type: 'damage',
                actor: currentActorId,
                target: entityId,
                payload: {
                    amount: result.applied,
                    damageType: damageType ?? 'true',
                    source: 'effect',
                    crit: false,
                    mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 },
                },
            });
            handleDeath(entityId, result.killed, currentActorId);
        },
        heal: (entityId, amount) => {
            const result = healEntity(state, entityId, amount);
            emit({ type: 'heal', actor: currentActorId, target: entityId, payload: { amount: result.applied } });
        },
        applyStatus: (entityId, statusId, stacks, duration, potency) => {
            // resistances + stack cap + duration refresh inside state.ts
            // (D5c/D5e); the engine turns the result into events (D11)
            const resistance = cfg.resistances[entityId]?.[statusId] ?? 0;
            const result = applyStatus(state, entityId, statusId, { stacks, duration, potency, resistance });
            if (result.kind === 'resisted') {
                emit({ type: 'status:resisted', actor: entityId, payload: { statusId } });
            } else {
                const payload: Record<string, unknown> = { statusId, stacks: result.status.stacks ?? 1, potency: result.status.potency ?? 1 };
                if (result.status.duration !== undefined) payload.duration = result.status.duration;
                emit({ type: 'status:applied', actor: entityId, payload });
            }
        },
        removeStatus: (entityId, statusId) => {
            removeStatus(state, entityId, statusId);
        },
        breakEquipment: (entityId, slot) => {
            for (const piece of breakGear(state, entityId, slot)) {
                emit({ type: 'gear:broken', actor: entityId, payload: { gearId: piece.gearId, slot: piece.slot } });
            }
        },
        modifyStat: (entityId, stat, amount, duration) => {
            // D4e reschedule needs the OLD effective speed — capture before
            // the write; duration omitted ⇒ permanent (remainingTurns 0
            // sentinel, state.ts)
            const oldEff = effSpeed(entityId);
            const modifier = addStatModifier(state, entityId, stat, amount, duration ?? 0);
            emit({ type: 'stat:modified', actor: currentActorId, target: entityId, payload: { stat, amount, remainingTurns: modifier.remainingTurns } });
            if (stat === 'speed' && entityId !== currentActorId) {
                // decision 6: the actor's just-re-armed entry keeps the
                // pick-time speed; everyone else's pending entry follows the
                // proportional-remaining-work rule through the ACTIVE hook
                rescheduleEntry(state.schedule, entityId, state.virtualTime, oldEff, effSpeed(entityId), intervalFn);
            }
        },
        emitMessage: (message) => {
            emit({ type: 'message', actor: currentActorId, message });
        },
    };

    const interpreterDeps = (hook: HookId, actorId?: string, targetId?: string): InterpreterDeps => ({
        view: stateViewOf(state),
        ctx: makeCtx(hook, actorId, targetId),
        vocab: cfg.registry.vocab,
        adapter,
    });

    // ---- chain hook execution (D6: ALL handlers, registration order;
    // returned descriptors applied by the engine, D7) --------------------------

    const runChain = (hook: 'attack:pre' | 'damage:post' | 'equipment:post' | 'status:turn-end' | 'step:end', args: unknown): void => {
        const handlers = cfg.registry.chain(hook);
        for (let index = 0; index < handlers.length; index += 1) {
            const handler = handlers[index];
            const owner = cfg.registry.chainOwner(hook, index);
            withAttribution(hook, owner, () => {
                const result = handler(stateViewOf(state), makeCtx(hook), args);
                if (result === undefined || result === null) return; // void contribution
                if (!Array.isArray(result)) {
                    throw new CombatFault(`invalid chain result from '${hook}' handler: expected void or EffectDescriptor[]`, owner, hook);
                }
                applyEffects(result as EffectDescriptor[], interpreterDeps(hook));
            });
        }
    };

    // ---- PhaseDefaultApi: state.ts closures for the rules.ts chain defaults --
    const phaseApi: PhaseDefaultApi = {
        damageGear: (entityId, slot, amount) => damageGear(state, entityId, slot, amount),
        removeGear: (entityId, slot) => removeGear(state, entityId, slot),
        damageEntity: (entityId, amount) => damageEntity(state, entityId, amount),
        removeStatus: (entityId, statusId) => removeStatus(state, entityId, statusId),
        patchStatus: (entityId, statusId, patch) => {
            const entity = findEntity(state, entityId);
            const instance = entity.statuses.find((status) => status.id === statusId);
            if (!instance) return;
            if (patch.stacks !== undefined) instance.stacks = patch.stacks;
            if (patch.duration !== undefined) instance.duration = patch.duration;
        },
        decrementStatModifiers: (entityId) => decrementStatModifiers(state, entityId),
        dropScheduleEntries: (entityId) => {
            dropScheduleEntries(state, entityId);
        },
        emit,
    };

    // ---- phases 5–11: one attack (basic attack depth 1; strikes nest, D5a.12) --
    function runAttack(depth: number): void {
        const previousDepth = attackDepth;
        attackDepth = depth;
        try {
            if (!currentActorId || !currentTargetId) return; // defensive: no refs ⇒ no attack
            const attacker = entityViewOf(findEntity(state, currentActorId));
            const target = entityViewOf(findEntity(state, currentTargetId));
            const weapon = currentWeapon(attacker);
            const rollArgs = { attacker, target, ...(weapon ? { weapon } : {}) };

            // phase 5 — dodge: a dodge ENDS the attack (no damage, no
            // durability, D5a.5); unclaimed ⇒ never dodged (decision 8)
            const dodge = callSingle('attack:dodge', rollArgs, validateDodge) ?? { dodged: false };
            if (dodge.dodged) {
                emit({ type: 'dodge', actor: target.id, target: attacker.id });
                return;
            }

            // phase 6 — crit; unclaimed ⇒ never crits (decision 8)
            const crit = callSingle('attack:crit', rollArgs, validateCrit) ?? { crit: false };
            if (crit.crit) emit({ type: 'crit', actor: attacker.id, target: target.id });

            // phase 7 — base damage: no handler ⇒ no rule to compute damage,
            // an honest fault (decision 8)
            const base = callSingle('damage:base', rollArgs, validateBase);
            if (base === undefined) {
                throw new CombatFault('no handler for damage:base (decision 8)', undefined, 'damage:base');
            }
            // decision 3: crit multiplier rides INTO mitigate
            const rawAmount = crit.crit ? base.amount * CRIT_MULTIPLIER : base.amount;

            // phase 8 — mitigation (fixed internal order lives in rules.ts)
            const mitigation = callSingle('damage:mitigate', { attacker, target, amount: rawAmount, damageType: base.damageType }, validateMitigate);
            if (mitigation === undefined) {
                throw new CombatFault('no handler for damage:mitigate (decision 8)', undefined, 'damage:mitigate');
            }
            if (mitigation.blocked) emit({ type: 'block', actor: target.id, target: attacker.id });

            // contributors captured at hit time (D5b: the breaking piece
            // still contributed THIS hit — removal happens in phase 11)
            const contributedArmour = contributors(target, base.damageType);

            // phase 9 — apply + death check (D5a.9)
            const damageResult = damageEntity(state, target.id, mitigation.amount);
            emit({
                type: 'damage',
                actor: attacker.id,
                target: target.id,
                payload: {
                    amount: mitigation.amount,
                    damageType: base.damageType,
                    source: weapon ? 'weapon' : 'unarmed',
                    ...(weapon ? { weaponId: weapon.gearId } : {}),
                    crit: crit.crit,
                    mitigations: {
                        blocked: mitigation.blocked,
                        armourFactor: mitigation.armourFactor,
                        defenseFactor: mitigation.defenseFactor,
                    },
                },
            });
            handleDeath(target.id, damageResult.killed, attacker.id);

            // phase 10 — damage:post chain (killed flag rides, D6)
            runChain('damage:post', { amount: mitigation.amount, killed: damageResult.killed, attacker, target, damageType: base.damageType });

            // phase 11 — equipment:post: builtin durability default FIRST
            // (D6 "default runs first"), then contributions
            const equipmentArgs = { attacker, target, ...(weapon ? { weapon } : {}), damageType: base.damageType, contributedArmour };
            if (cfg.builtinRules) applyEquipmentPostDefault(phaseApi, equipmentArgs);
            runChain('equipment:post', equipmentArgs);
        } finally {
            attackDepth = previousDepth;
        }
    }

    // ---- phase 15 — outcome:decide (D5g: pure observation) -------------------

    // engine-enforced no-rng/no-emit context (D7): calling either faults.
    const observeOnlyRng: RngStream = {
        next: () => {
            throw new CombatFault('outcome:decide handlers must not consume rng (pure observation, D5g)', activePluginId, 'outcome:decide');
        },
        int: () => {
            throw new CombatFault('outcome:decide handlers must not consume rng (pure observation, D5g)', activePluginId, 'outcome:decide');
        },
        pick: () => {
            throw new CombatFault('outcome:decide handlers must not consume rng (pure observation, D5g)', activePluginId, 'outcome:decide');
        },
    };
    const observeOnlyEmit = (): never => {
        throw new CombatFault('outcome:decide handlers must not emit events (pure observation, D5g)', activePluginId, 'outcome:decide');
    };

    const decide = (): OutcomeVerdict | null => {
        const handler = cfg.registry.single('outcome:decide');
        if (!handler) return null; // D5g: unclaimed ⇒ every decision continues
        return withAttribution('outcome:decide', cfg.registry.singleOwner('outcome:decide'), () => {
            const ctx: StepContext = {
                rng: observeOnlyRng,
                emit: observeOnlyEmit,
                step: state.step,
                time: state.virtualTime,
                hook: 'outcome:decide',
                depth: 0,
                refs: buildRefs(),
            };
            const args: OutcomeDecideContext = { step: state.step, time: state.virtualTime, config: cfg.config };
            return validateDecide(handler(stateViewOf(state), ctx, args));
        });
    };

    const stampOutcome = (verdict: OutcomeVerdict): void => {
        // engine stamps step + emits exactly ONE outcome event (D5g/D11)
        state.terminal = { ...verdict, step: state.step };
        const payload: Record<string, unknown> = { outcome: verdict.outcome };
        if (verdict.winner !== undefined) payload.winner = verdict.winner;
        if (verdict.reason !== undefined) payload.reason = verdict.reason;
        if (verdict.error !== undefined) payload.error = verdict.error;
        emit({ type: 'outcome', payload });
    };

    // ---- one full turn: D5a phases 1–15 ---------------------------------------

    const runTurn = (): boolean => {
        // phase 1 — pick (D4d tie rule through the ACTIVE order hook);
        // empty schedule ⇒ no progress (decision 9)
        if (state.schedule.length === 0) return false;
        const picked = pickNext(state.schedule, lookup, orderFn);
        if (!picked) return false;
        state.virtualTime = picked.time;
        state.step += 1;
        currentActorId = picked.entry.entityId;
        currentTargetId = undefined;
        cooldownSetThisTurn = undefined;
        const actor = findEntity(state, currentActorId);
        // D5a.1/D4e: effective speed snapshotted at pick time drives the
        // post-turn advance even if modifiers land mid-cascade
        const effAtPick = effectiveStatsOf(actor.baseStats, actor.statModifiers).speed;
        emit({ type: 'turn:start', actor: currentActorId });

        // phase 2 — action:select (unclaimed ⇒ wait, decision 8); an unknown
        // abilityId is an invalid single result ⇒ fault attributed to the
        // owning selector (inside the attributed region via the validator)
        const selection = callSingle('action:select', { actor: entityViewOf(actor) }, (raw) => {
            const parsed = validateActionSelect(raw);
            if (parsed.kind === 'ability' && !cfg.ability(parsed.abilityId as string)) {
                throw new CombatFault(`action:select returned unknown abilityId '${parsed.abilityId}'`, activePluginId, activeHook);
            }
            return parsed;
        }) ?? { kind: 'wait' as const };
        const ability = selection.kind === 'ability' ? cfg.ability(selection.abilityId as string) : undefined;
        // readiness re-arm with the ACTION cost (decision 1; D4b ability
        // costs, D4e pick-time speed, ACTIVE interval hook)
        const cost = ability ? ability.cost ?? DEFAULT_ABILITY_COST : DEFAULT_ACTION_COST;
        advanceEntry(state.schedule, currentActorId, state.virtualTime, cost, effAtPick, intervalFn);

        // phase 3 — targeting for attack/ability (unclaimed ⇒ null, decision 8)
        let actionEvent: ActionSelection = selection;
        if (selection.kind === 'attack' || selection.kind === 'ability') {
            const targetId = callSingle('target:select', { actor: entityViewOf(actor), action: selection }, validateTargetSelect) ?? null;
            if (targetId === null) {
                actionEvent = { kind: 'skip', reason: 'no-target' };
            } else {
                currentTargetId = targetId;
            }
        }

        // the single 'action' event (decision 2)
        const actionPayload: Record<string, unknown> = { kind: actionEvent.kind };
        if (actionEvent.kind === 'ability' && actionEvent.abilityId) actionPayload.abilityId = actionEvent.abilityId;
        if (actionEvent.reason !== undefined) actionPayload.reason = actionEvent.reason;
        emit({ type: 'action', actor: currentActorId, payload: actionPayload });

        if (actionEvent.kind === 'attack' && currentTargetId) {
            // phase 4 — attack:pre chain (basic attack only; ability strikes
            // run phases 5–11, D5a.12)
            const attackerView = entityViewOf(findEntity(state, currentActorId));
            const targetView = entityViewOf(findEntity(state, currentTargetId));
            runChain('attack:pre', { actor: attackerView, target: targetView, ...(currentWeapon(attackerView) ? { weapon: currentWeapon(attackerView) } : {}) });
            runAttack(1);
        } else if (actionEvent.kind === 'ability' && ability && currentTargetId) {
            // phase 12 — ability:execute (unclaimed ⇒ fault: an ability with
            // no interpreter has no semantics, decision 8)
            const effects = callSingle('ability:execute', {
                actor: entityViewOf(findEntity(state, currentActorId)),
                target: entityViewOf(findEntity(state, currentTargetId)),
                ability,
            }, validateEffects);
            if (effects === undefined) {
                throw new CombatFault('no handler for ability:execute (decision 8)', undefined, 'ability:execute');
            }
            applyEffects(effects as EffectDescriptor[], interpreterDeps('ability:execute'));
            // cooldown bookkeeping (D9; decision 7 exempts the use turn)
            const cooldown = ability.cooldown ?? 0;
            if (cooldown > 0) {
                findEntity(state, currentActorId).cooldowns[ability.id] = cooldown;
                cooldownSetThisTurn = ability.id;
            }
        }
        // wait / skip (incl. no-target downgrade): nothing between phases —
        // a skipped turn is still a consumed step (D5a.2)

        // phase 13 — status:turn-end: builtin status default FIRST (D6),
        // then contributions. Runs even if the actor died mid-cascade
        // (deterministic bookkeeping; damage on a dead entity applies 0).
        if (cfg.builtinRules) applyStatusTurnEndDefault(phaseApi, { entity: entityViewOf(findEntity(state, currentActorId)) });
        runChain('status:turn-end', { entity: entityViewOf(findEntity(state, currentActorId)) });

        // cooldown decrement in the actor's own scheduled turns (D9) —
        // engine bookkeeping, exempting the ability just used (decision 7)
        const cooldowns = findEntity(state, currentActorId).cooldowns;
        for (const key of Object.keys(cooldowns)) {
            if (key === cooldownSetThisTurn) continue;
            if (cooldowns[key] > 0) cooldowns[key] -= 1;
        }

        // phase 14 — step:end: engine event first, then observer contributions
        // (D5a.14: no terminal decision here)
        emit({ type: 'step:end', payload: { step: state.step, time: state.virtualTime } });
        runChain('step:end', { step: state.step, time: state.virtualTime });

        // phase 15 — outcome:decide (D5a.15: after the step:end chain)
        const verdict = decide();
        if (verdict) stampOutcome(verdict);
        return true;
    };

    // ---- transaction boundary (D7) ---------------------------------------------

    // SnapshotState → live CombatState: state.ts restoreFrom needs a
    // definition (only .mode is read), so the transaction rolls back through
    // a minimal pseudo-snapshot. Derived stats are recomputed (state.ts).
    const restoreStateFrom = (snapshot: ReturnType<typeof snapshotStateOf>): CombatState =>
        restoreFrom({
            schemaVersion: COMBAT_SCHEMA_VERSION,
            definition: { schemaVersion: COMBAT_SCHEMA_VERSION, mode: state.mode, entities: [] } as unknown as BattleDefinition,
            state: snapshot,
            events: [],
        });

    // D7 fault policy, shared by step() and the step-0 decide evaluation:
    // restore state + RNG + log + counters to the transaction marker, append
    // the single fault event, stamp terminal 'fault', append the single
    // outcome event, enforce the log cap. faultStep is the step the faulting
    // work belonged to (attempted turn = snap.step + 1; battle-start decide
    // consumed no turn ⇒ snap.step itself).
    const applyFault = (
        error: unknown,
        txn: { snap: ReturnType<typeof snapshotStateOf>; marker: ReturnType<EventLog['marker']> },
        faultStep: number,
    ): void => {
        const faultError =
            error instanceof CombatFault
                ? error
                : new CombatFault(messageOf(error), activePluginId, activeHook);
        state = restoreStateFrom(txn.snap);
        cfg.rng.restoreState(txn.snap.rng);
        cfg.log.rollback(txn.marker);
        currentActorId = undefined;
        currentTargetId = undefined;
        attackDepth = 0;
        cooldownSetThisTurn = undefined;
        const faultTime = txn.snap.virtualTime;
        // fault event + terminal stamp + the single outcome event (D7/D11)
        const faultPayload: Record<string, unknown> = { error: faultError.message };
        if (faultError.pluginId !== undefined) faultPayload.pluginId = faultError.pluginId;
        if (faultError.hook !== undefined) faultPayload.hook = faultError.hook;
        cfg.log.emit({ type: 'fault', payload: faultPayload }, faultStep, faultTime);
        state.terminal = { outcome: 'fault', step: faultStep, reason: 'fault', error: faultError.message };
        cfg.log.emit({ type: 'outcome', payload: { outcome: 'fault', reason: 'fault', error: faultError.message } }, faultStep, faultTime);
        cfg.log.trim(faultStep, faultTime);
    };

    const step = (): boolean => {
        if (state.terminal) return true; // idempotent (D5g) — engine guards too
        const txn = { snap: snapshotStateOf(state), marker: cfg.log.marker() };
        stepEvents = 0;
        try {
            const advanced = runTurn();
            if (!advanced) return false; // no progress (decision 9) — nothing emitted
            // persist the RNG position into plain state (D10/D4g)
            state.rng = cfg.rng.exportState();
            // deterministic log cap enforcement (events.ts header: end of
            // step only, so the transaction marker stays exact)
            cfg.log.trim(state.step, state.virtualTime);
            return true;
        } catch (error) {
            // the faulting step number: the turn that was attempted
            applyFault(error, txn, txn.snap.step + 1);
            return true;
        }
    };

    return {
        state: () => state,
        setState: (next) => {
            state = next;
        },
        armInitialSchedule: () => {
            // D4a: every LIVING entity gets readyAt = interval(1, eff) from
            // time 0 — first readiness never 0; routed through the ACTIVE
            // interval hook (scheduler.ts header rule)
            state.schedule = buildInitialEntries(
                state.entities
                    .filter((entity) => entity.living)
                    .map((entity) => ({
                        entityId: entity.id,
                        actionCost: DEFAULT_ACTION_COST,
                        effectiveSpeed: effectiveStatsOf(entity.baseStats, entity.statModifiers).speed,
                    })),
                intervalFn,
            );
        },
        decideAtStepZero: () => {
            // D5g: decide runs once at battle start (step 0, after
            // battle:start) — the no-enemies draw lands here. D7 fault
            // policy applies to this evaluation too: a throwing/invalid
            // decide handler becomes a terminal fault with rollback to the
            // initial state + log, NOT an exception escaping construction.
            const txn = { snap: snapshotStateOf(state), marker: cfg.log.marker() };
            stepEvents = 0;
            try {
                const verdict = decide();
                if (verdict) stampOutcome(verdict);
            } catch (error) {
                applyFault(error, txn, txn.snap.step); // no turn consumed at step 0
            }
        },
        step,
        runtime: () => ({ adapter, view: () => stateViewOf(state) }),
    };
};
