// ============================================================================
// @userfiction/combat — src/engine/pipeline.ts — T5 turn skeleton (task §9 T5,
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
    upsertEntry,
} from '../runtime/scheduler';
import type { CandidateLookup, IntervalFn, OrderFn } from '../runtime/scheduler';
import {
    addInjury,
    addStatModifier,
    adminSetStatus,
    applyStatus,
    ARMOUR_SLOTS,
    availableArmsOf,
    breakGear,
    canPayResourceCosts,
    clearSlotGear,
    damageEntity,
    damageGear,
    decrementStatModifiers,
    deepCopy,
    dropScheduleEntries,
    entityEffectiveStats,
    entityViewOf,
    findEntity,
    healEntity,
    healInjury,
    modifyResourcePool,
    normalizeResourceCost,
    patchStatusInstance,
    payResourceCosts,
    removeGear,
    removeStatus,
    restoreFrom,
    setSlotGear,
    snapshotStateOf,
    stateViewOf,
} from '../runtime/state';
import type { CombatState } from '../runtime/state';
import { applyEquipmentPostDefault, applyStatusTurnEndDefault } from '../behavior/rules';
import type { PhaseDefaultApi } from '../behavior/rules';
import { applyEffects } from '../behavior/effects';
import type { EffectAdapter, InterpreterDeps } from '../behavior/effects';
import type { EventLog } from '../runtime/events';
import type { PluginRegistry, PluginRegistryRuntime } from '../behavior/plugins';
import {
    BODY_PARTS,
    CombatValidationError,
    COMBAT_SCHEMA_VERSION,
    CRIT_MULTIPLIER,
    DAMAGE_TYPES,
    DEFAULT_ABILITY_COST,
    DEFAULT_ACTION_COST,
    MAX_DEFENSE,
    MAX_EVASION,
    MAX_GEAR_DURABILITY,
    MAX_HEALTH,
    MAX_PRECISION,
    MAX_RESOURCE_VALUE,
    MAX_SPEED,
    MAX_STATUS_STACKS,
    MAX_STRENGTH,
    MAX_STRIKE_DEPTH,
    MIN_DEFENSE,
    MIN_EVASION,
    MIN_GEAR_DURABILITY,
    MIN_HEALTH,
    MIN_INTERVAL_US,
    MIN_PRECISION,
    MIN_RESOURCE_VALUE,
    MIN_SPEED,
    MIN_STATUS_DURATION,
    MIN_STATUS_POTENCY,
    MIN_STRENGTH,
    SLOTS,
    STAT_KEYS,
} from '../contract/types';
import type {
    AbilityDefinition,
    ActionSelection,
    BattleDefinition,
    BodyPart,
    CombatantEdit,
    EffectDescriptor,
    EntityView,
    EquipmentEntry,
    EventDraft,
    GearDefinition,
    HookId,
    OutcomeDecideContext,
    OutcomeVerdict,
    ResourceKey,
    ResolvedSimulationConfig,
    RngStream,
    SchedulerIntervalArgs,
    SchedulerOrderArgs,
    SingleHookId,
    Slot,
    StatBlock,
    StatKey,
    StatusDefinition,
    StepContext,
    StepContextRefs,
} from '../contract/types';
import { isValidId } from '../contract/ids';
import type { RngController } from '../runtime/rng';

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
    // T2 (R1): resolved status-definition registry (merged default seed +
    // client patches) — consults drive modifier materialization, definition
    // turn-end processing and select gating plumbing. OPTIONAL for
    // integration-harness compatibility: the engine ALWAYS supplies it; a
    // missing lookup degrades to "no definitions registered" (legacy
    // behavior) rather than faulting.
    status?: (statusId: string) => StatusDefinition | undefined;
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
    // T3 live edit: validate + atomically patch one combatant of the RUNNING
    // battle between turns (types.ts CombatantEdit contract). Synchronous;
    // throws CombatValidationError (collect-all field errors, terminal or
    // reentrant edit, or a rolled-back plugin-hook throw). Never advances
    // step/virtualTime and never draws the default RNG path; on success
    // exactly one 'combatant:edited' event is appended with existing event
    // ids preserved.
    editCombatant(edit: CombatantEdit): void;
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
        // comment) — always recompute from base + modifiers + statuses +
        // injuries (D5c "effective stats are recomputed at each use"; T2
        // central derivation includes status-borne modifiers and injuries)
        return entityEffectiveStats(entity).speed;
    };

    const lookup: CandidateLookup = (entityId) => {
        const entity = findEntity(state, entityId);
        return { effectiveSpeed: entityEffectiveStats(entity).speed, order: entity.order };
    };

    // T2 (R1) registry lookup with the optional-field fallback: an absent
    // lookup (legacy harnesses) means "no definitions registered".
    const statusOf = (statusId: string): StatusDefinition | undefined => cfg.status?.(statusId);

    // T2 (R2): after any status/injury mutation that can move speed, the
    // D4e proportional-remaining-work rule applies to OTHER entities'
    // pending entries (the current actor's just-re-armed entry keeps the
    // pick-time speed, decision 6). No-op when speed did not change.
    const syncSpeedReschedule = (entityId: string, speedBefore: number): void => {
        if (entityId === currentActorId) return;
        const speedAfter = effSpeed(entityId);
        if (speedAfter === speedBefore) return;
        rescheduleEntry(state.schedule, entityId, state.virtualTime, speedBefore, speedAfter, intervalFn);
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

    // T2 (R2) weapon eligibility: hands budget shrinks with missing arms —
    // two-handed gear REQUIRES two available arms, ANY weapon requires at
    // least one, and with no arms no weapon is usable (attacks fall back to
    // unarmed). Equipment stays equipped-but-inert (never silently dropped):
    // healing the injury makes the weapon usable again. Unknown gear ids
    // (defensive; catalog-validated upstream) are treated as one-handed.
    const weaponUsable = (attacker: EntityView, entry: EquipmentEntry): boolean => {
        const arms = availableArmsOf(attacker.injuries);
        if (arms === 0) return false;
        const definition = cfg.gear(entry.gearId);
        if (definition && definition.handedness === 2) return arms >= 2;
        return true;
    };

    // decision 5: primary-hand weapon first (eligibility-filtered, T2)
    const currentWeapon = (attacker: EntityView): EquipmentEntry | undefined =>
        attacker.equipment.find((piece) => piece.slot === 'weapon-1' && weaponUsable(attacker, piece)) ??
        attacker.equipment.find((piece) => piece.slot === 'weapon-2' && weaponUsable(attacker, piece));

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
            // (D5c/D5e); the engine turns the result into events (D11).
            // T2 (R1): the resolved definition rides along so per-stack
            // modifiers are materialized (overwritten, never accumulated).
            const definition = statusOf(statusId);
            const speedBefore = effSpeed(entityId);
            const resistance = cfg.resistances[entityId]?.[statusId] ?? 0;
            const result = applyStatus(state, entityId, statusId, { stacks, duration, potency, resistance, definition });
            if (result.kind === 'resisted') {
                emit({ type: 'status:resisted', actor: entityId, payload: { statusId } });
            } else {
                const payload: Record<string, unknown> = { statusId, stacks: result.status.stacks ?? 1, potency: result.status.potency ?? 1 };
                if (result.status.duration !== undefined) payload.duration = result.status.duration;
                emit({ type: 'status:applied', actor: entityId, payload });
            }
            // T2 (R2): status-borne speed modifiers move readiness (D4e
            // proportional rule, other entities only)
            syncSpeedReschedule(entityId, speedBefore);
        },
        removeStatus: (entityId, statusId) => {
            // T2 (R2): removing a status un-applies its materialized
            // modifiers — pending schedule entries of OTHER entities follow
            // the D4e rule when derived speed moves (dispel case; expiry on
            // the actor's own turn-end is a no-op here by the actor check).
            const speedBefore = effSpeed(entityId);
            removeStatus(state, entityId, statusId);
            syncSpeedReschedule(entityId, speedBefore);
        },
        applyInjury: (entityId, part) => {
            // T2 (R2): idempotent part loss; visibility via injury:applied
            // only when something actually changed, then derived-speed sync.
            const speedBefore = effSpeed(entityId);
            const result = addInjury(state, entityId, part);
            if (result.alreadyMissing) return;
            emit({ type: 'injury:applied', actor: currentActorId, target: entityId, payload: { part: result.part } });
            syncSpeedReschedule(entityId, speedBefore);
        },
        healInjury: (entityId, part) => {
            // T2 (R2): the only coherent restore path (vague heal never
            // regrows parts). Event + speed sync only on an actual restore.
            const speedBefore = effSpeed(entityId);
            const result = healInjury(state, entityId, part);
            if (!result.wasMissing) return;
            emit({ type: 'injury:healed', actor: currentActorId, target: entityId, payload: { part: result.part } });
            syncSpeedReschedule(entityId, speedBefore);
        },
        modifyResource: (entityId, resource, amount) => {
            // T2 (R3): signed pool change clamped into [0, max]; dead
            // entities are not modified. Event only on an actual change.
            const result = modifyResourcePool(state, entityId, resource, amount);
            if (!result.changed) return;
            emit({
                type: 'resource:modified',
                actor: currentActorId,
                target: entityId,
                payload: { resource: result.resource, amount: result.applied, current: result.current },
            });
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
        healEntity: (entityId, amount) => healEntity(state, entityId, amount),
        removeStatus: (entityId, statusId) => {
            // T2 (R2): removal (effect or expiry) un-applies materialized
            // modifiers; other entities' pending entries follow D4e when
            // derived speed moves (own-turn expiry is filtered by the actor
            // check inside syncSpeedReschedule).
            const speedBefore = effSpeed(entityId);
            const removed = removeStatus(state, entityId, statusId);
            syncSpeedReschedule(entityId, speedBefore);
            return removed;
        },
        patchStatus: (entityId, statusId, patch, definition) => {
            // T2 (R1): state.ts patch + re-materialization when a definition
            // is supplied; then derived-speed sync (stack changes can move
            // speed-borne modifiers).
            const speedBefore = effSpeed(entityId);
            patchStatusInstance(state, entityId, statusId, patch, definition);
            syncSpeedReschedule(entityId, speedBefore);
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
        // post-turn advance even if modifiers land mid-cascade. T2 (R2):
        // central derivation includes status-borne modifiers and injuries.
        const effAtPick = entityEffectiveStats(actor).speed;
        emit({ type: 'turn:start', actor: currentActorId });

        // phase 2 — action:select (unclaimed ⇒ wait, decision 8); an unknown
        // abilityId is an invalid single result ⇒ fault attributed to the
        // owning selector (inside the attributed region via the validator)
        // T2 (R3): the selector's owner id is captured BEFORE the attributed
        // call (whose finally resets activePluginId/activeHook) so the
        // resource-payment gate below can attribute its fault to the plugin
        // whose selection is being rechecked.
        const selectionOwner = cfg.registry.singleOwner('action:select');
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
            // T2 (R3) resource payment — INSIDE the step transaction, before
            // any effect runs. The default selector only pools affordable
            // abilities; a PLUGIN-selected ability is rechecked here and an
            // unaffordable pick is a contract fault (D7 invalid single-mode
            // selection) with full transactional rollback.
            const costs = normalizeResourceCost(ability.costs);
            if (costs && !canPayResourceCosts(findEntity(state, currentActorId), costs)) {
                // attributed to the plugin whose action:select returned the
                // unaffordable pick (selectionOwner captured at phase 2 — the
                // withAttribution windows of the earlier hook calls are
                // already closed here, so the live active* fields are empty)
                throw new CombatFault(`ability '${ability.id}' cannot be paid: insufficient resources`, selectionOwner, 'action:select');
            }
            if (costs) {
                // payResourceCosts re-validates (defense in depth) and never
                // leaves a pool negative or the payer at 0 health.
                payResourceCosts(state, currentActorId, costs);
                emit({ type: 'resource:spent', actor: currentActorId, payload: { costs } });
            }

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
            // Attribution window: the interpreter runs INSIDE the
            // ability:execute hook's attribution so a malformed/throwing
            // effect (catalog data or a vocab handler) faults under the
            // owning plugin + hook, exactly like the chain-hook application
            // path in runChain (D7 fault event fields).
            withAttribution('ability:execute', cfg.registry.singleOwner('ability:execute'), () => {
                applyEffects(effects as EffectDescriptor[], interpreterDeps('ability:execute'));
            });
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
        // T2 (R1): the resolved status registry lookup rides along so
        // definition-driven statuses (tick/decay/skip) are processed by the
        // same default; ids WITHOUT a definition are inert bookkeeping (no
        // hardcoded per-id branch exists anywhere).
        if (cfg.builtinRules) applyStatusTurnEndDefault(phaseApi, { entity: entityViewOf(findEntity(state, currentActorId)) }, statusOf);
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
        // T3 edit-flow hole closure: an edit can leave ALL combatants dead
        // (schedule empty, non-terminal — deaths inside a step always reach
        // the phase-15 decide). Instead of the declared no-progress return,
        // give outcome:decide ONE pure-observation evaluation at the CURRENT
        // step/time so the next simulate() RESOLVES the battle (e.g. the
        // default decide stamps the mutual-destruction draw) instead of
        // returning no-progress forever. A verdict stamps terminal + the
        // single outcome event; no handler (or null verdict) keeps the
        // honest decision-9 return (builtinRules:false keeps its escape).
        if (state.schedule.length === 0) {
            const txn = { snap: snapshotStateOf(state), marker: cfg.log.marker() };
            stepEvents = 0;
            try {
                const verdict = decide();
                if (!verdict) return false; // no progress, nothing emitted
                stampOutcome(verdict);
                state.rng = cfg.rng.exportState();
                cfg.log.trim(state.step, state.virtualTime);
                return true;
            } catch (error) {
                applyFault(error, txn, txn.snap.step); // no turn consumed
                return true;
            }
        }
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

    // ----------------------------------------------------------------------------
    // T3 live edit — validated atomic combatant patch (types.ts CombatantEdit)
    // ----------------------------------------------------------------------------
    // Validation mirrors validation.ts's collect-all stance (exact
    // `<path>: <problem>` messages, D13 bounds imported from the contract)
    // but runs against LIVE state + the RESOLVED catalogs, with edits
    // PROJECTED onto the current equipment/injuries before cross-field rules
    // (hands budget, two-handed conflicts, arm anatomy) are judged — so a
    // multi-domain edit is validated as the coherent end state it will
    // produce, never against intermediate half-states.
    // ----------------------------------------------------------------------------

    // Per-stat validation bounds (mirrors validateStats: health is the only
    // integer-bounded stat; the rest are finite-number bounded).
    const STAT_EDIT_BOUNDS: Record<StatKey, { min: number; max: number; integer: boolean }> = {
        health: { min: MIN_HEALTH, max: MAX_HEALTH, integer: true },
        strength: { min: MIN_STRENGTH, max: MAX_STRENGTH, integer: false },
        speed: { min: MIN_SPEED, max: MAX_SPEED, integer: false },
        defense: { min: MIN_DEFENSE, max: MAX_DEFENSE, integer: false },
        precision: { min: MIN_PRECISION, max: MAX_PRECISION, integer: false },
        evasion: { min: MIN_EVASION, max: MAX_EVASION, integer: false },
    };
    // D5e hands budget surface (same slot set as validation.ts).
    const HAND_SLOTS: readonly Slot[] = ['weapon-1', 'weapon-2', 'shield'];
    const TWO_HANDED = 2;

    const editCombatant = (raw: CombatantEdit): void => {
        // reentrancy: an edit invoked from inside an executing hook (plugin
        // code mid-step) would mutate state under the D7 transaction —
        // rejected outright (declared contract).
        if (activeHook !== undefined || activePluginId !== undefined) {
            throw new CombatValidationError(['edit: reentrant edit inside an executing hook is rejected']);
        }
        // terminal battles are immutable (reset/rebuild is the only path back)
        if (state.terminal !== null) {
            throw new CombatValidationError(['edit: battle is terminal']);
        }
        if (!isPlainObject(raw)) {
            throw new CombatValidationError(['edit: expected a plain object']);
        }
        // id gate: every later check projects against the entity's live state
        const entityId = raw.entityId;
        if (typeof entityId !== 'string' || !isValidId(entityId) || !state.entities.some((candidate) => candidate.id === entityId)) {
            throw new CombatValidationError([`edit.entityId: unknown entity id '${String(entityId)}'`]);
        }
        const entity = findEntity(state, entityId);

        // ---- collect-all validation (never mutates) ----
        const errors: string[] = [];

        // health: finite required; out-of-range values are CLAMPED at
        // mutation (never rejected) — admin semantics documented in types.ts.
        if (raw.health !== undefined && (typeof raw.health !== 'number' || !Number.isFinite(raw.health))) {
            errors.push('edit.health: must be a finite number');
        }
        // baseStats.health bounds mirror validateStats (integer 1..100 000 —
        // maxHealth can never drop a living entity to 0 through the clamp)

        // baseStats: keys ⊆ STAT_KEYS, each within its D3/D13 bounds
        if (raw.baseStats !== undefined) {
            if (!isPlainObject(raw.baseStats)) {
                errors.push('edit.baseStats: expected a plain object');
            } else {
                const record = raw.baseStats as Record<string, unknown>;
                for (const key of Object.keys(record)) {
                    const path = `edit.baseStats['${key}']`;
                    if (!STAT_KEYS.includes(key as StatKey)) {
                        errors.push(`${path}: unknown stat key`);
                        continue;
                    }
                    const value = record[key];
                    const bounds = STAT_EDIT_BOUNDS[key as StatKey];
                    const valid = bounds.integer
                        ? typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max
                        : typeof value === 'number' && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
                    if (!valid) {
                        errors.push(
                            bounds.integer
                                ? `${path}: must be an integer between ${bounds.min} and ${bounds.max}`
                                : `${path}: must be a finite number between ${bounds.min} and ${bounds.max}`,
                        );
                    }
                }
            }
        }

        // injuries FIRST: the projected anatomy feeds the gear cross-field
        // rules below (arm-dependent hand gear).
        const injuriesAdd: BodyPart[] = [];
        const injuriesRemove: BodyPart[] = [];
        if (raw.injuries !== undefined) {
            if (!isPlainObject(raw.injuries)) {
                errors.push('edit.injuries: expected a plain object');
            } else {
                const record = raw.injuries as Record<string, unknown>;
                const bodyPartValues = BODY_PARTS.map((part) => `'${part}'`).join(', ');
                for (const direction of ['add', 'remove'] as const) {
                    const list = record[direction];
                    if (list === undefined) continue;
                    if (!Array.isArray(list)) {
                        errors.push(`edit.injuries.${direction}: must be an array`);
                        continue;
                    }
                    const seen = new Set<string>();
                    list.forEach((part, index) => {
                        const path = `edit.injuries.${direction}[${index}]`;
                        if (typeof part !== 'string' || !BODY_PARTS.includes(part as BodyPart)) {
                            errors.push(`${path}: must be one of ${bodyPartValues}`);
                            return;
                        }
                        if (seen.has(part)) {
                            errors.push(`${path}: duplicate body part '${part}'`);
                            return;
                        }
                        seen.add(part);
                        const currentlyMissing = (entity.injuries ?? []).includes(part as BodyPart);
                        if (direction === 'add') {
                            if (currentlyMissing) errors.push(`${path}: '${part}' is already missing`);
                            else injuriesAdd.push(part as BodyPart);
                        } else {
                            if (!currentlyMissing) errors.push(`${path}: '${part}' is not missing`);
                            else injuriesRemove.push(part as BodyPart);
                        }
                    });
                }
                for (const part of injuriesAdd) {
                    if (injuriesRemove.includes(part)) {
                        errors.push(`edit.injuries: '${part}' listed in both add and remove`);
                    }
                }
            }
        }
        // PROJECTED anatomy: current missing parts ∪ add − remove (R2)
        const projectedInjuries: BodyPart[] = (() => {
            const parts = new Set<BodyPart>(entity.injuries ?? []);
            for (const part of injuriesAdd) parts.add(part);
            for (const part of injuriesRemove) parts.delete(part);
            return [...parts];
        })();

        // gear: per-entry catalog/kind/slot/durability checks. The D5e
        // invariants (hands budget, two-handed conflicts, anatomy) run over
        // the PROJECTED loadout below — whenever EITHER gear or injuries is
        // touched, so an injuries-only edit still respects the CURRENT gear.
        if (raw.gear !== undefined) {
            if (!Array.isArray(raw.gear)) {
                errors.push('edit.gear: must be an array');
            } else {
                const editedSlots = new Set<Slot>();
                raw.gear.forEach((entry, index) => {
                    const path = `edit.gear[${index}]`;
                    if (!isPlainObject(entry)) {
                        errors.push(`${path}: expected a plain object`);
                        return;
                    }
                    const slot = entry['slot'];
                    if (typeof slot !== 'string' || !SLOTS.includes(slot as Slot)) {
                        errors.push(`${path}.slot: must be one of ${SLOTS.map((candidate) => `'${candidate}'`).join(', ')}`);
                        return;
                    }
                    if (editedSlots.has(slot as Slot)) {
                        errors.push(`${path}.slot: duplicate slot edit for '${slot}'`);
                        return;
                    }
                    editedSlots.add(slot as Slot);
                    const id = entry['id'];
                    if (id === null) {
                        // clear: durability is meaningless on a cleared slot
                        if (entry['durability'] !== undefined) errors.push(`${path}.durability: must not be present when id is null`);
                        if (!entity.equipment.some((piece) => piece.slot === slot)) errors.push(`${path}: slot '${slot}' is already empty`);
                        return;
                    }
                    if (typeof id !== 'string' || !isValidId(id)) {
                        errors.push(`${path}.id: must be a valid id string or null`);
                        return;
                    }
                    const definition = cfg.gear(id);
                    if (!definition) {
                        errors.push(`${path}.id: unknown gear id '${id}'`);
                        return;
                    }
                    // D9 kind/slot agreement (mirrors validateEquipment)
                    if (definition.kind === 'weapon' && slot !== 'weapon-1' && slot !== 'weapon-2') {
                        errors.push(`${path}.slot: gear '${id}' is a weapon and must go in 'weapon-1' or 'weapon-2'`);
                    }
                    if (definition.kind === 'armour' && slot !== definition.slot) {
                        errors.push(`${path}.slot: gear '${id}' occupies slot '${definition.slot}', not '${slot}'`);
                    }
                    if (entry['durability'] !== undefined) {
                        const value = entry['durability'];
                        if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_GEAR_DURABILITY || value > MAX_GEAR_DURABILITY) {
                            errors.push(`${path}.durability: must be an integer between ${MIN_GEAR_DURABILITY} and ${MAX_GEAR_DURABILITY}`);
                        }
                    }
                });
            }
        }

        // D5e invariants over the PROJECTED loadout × PROJECTED anatomy —
        // runs when either domain is touched (the gear-edit entries are
        // already per-entry validated above; projection here is shape-safe).
        if (raw.gear !== undefined || raw.injuries !== undefined) {
            // projected slot → occupant (current loadout first; edits
            // overwrite by slot or clear it)
            const projected = new Map<Slot, { gearId: string; durability: number; handedness: number; slot: Slot }>();
            for (const piece of entity.equipment) {
                const definition = cfg.gear(piece.gearId);
                projected.set(piece.slot, { gearId: piece.gearId, durability: piece.durability, handedness: definition?.handedness ?? 1, slot: piece.slot });
            }
            for (const entry of raw.gear ?? []) {
                if (!isPlainObject(entry)) continue;
                const slot = entry['slot'];
                if (typeof slot !== 'string' || !SLOTS.includes(slot as Slot)) continue;
                const id = entry['id'];
                if (id === null) {
                    projected.delete(slot as Slot);
                    continue;
                }
                const definition = typeof id === 'string' ? cfg.gear(id) : undefined;
                if (!definition) continue;
                const durability = entry['durability'] !== undefined && typeof entry['durability'] === 'number' ? entry['durability'] : definition.durability;
                projected.set(slot as Slot, { gearId: id, durability, handedness: definition.handedness, slot: slot as Slot });
            }

            // D5e hands budget: handedness of weapon-1 + weapon-2 + shield ≤ 2
            let handsUsed = 0;
            let twoHanded: { gearId: string; slot: Slot } | undefined;
            for (const piece of projected.values()) {
                if (HAND_SLOTS.includes(piece.slot)) handsUsed += piece.handedness;
                if (piece.handedness === TWO_HANDED && (piece.slot === 'weapon-1' || piece.slot === 'weapon-2')) {
                    twoHanded = { gearId: piece.gearId, slot: piece.slot };
                }
            }
            if (handsUsed > 2) {
                errors.push(`edit.gear: hands budget exceeded in the projected loadout (${handsUsed} > 2)`);
            }
            if (twoHanded !== undefined) {
                const conflict = [...projected.values()].some(
                    (piece) => piece.slot !== twoHanded!.slot && (piece.slot === 'weapon-2' || piece.slot === 'shield'),
                );
                if (conflict) errors.push(`edit.gear: two-handed gear '${twoHanded.gearId}' forbids 'weapon-2' and 'shield' occupants`);
            }

            // anatomy coherence over the PROJECTED injuries (R2 — mirrors
            // validateEquipment): every hand-held piece needs ≥ 1 arm,
            // two-handed pieces need BOTH.
            const armsAvailable = 2 - projectedInjuries.filter((part) => part === 'left-arm' || part === 'right-arm').length;
            for (const piece of projected.values()) {
                if (!HAND_SLOTS.includes(piece.slot)) continue;
                if (armsAvailable === 0) {
                    errors.push(`edit.gear: '${piece.gearId}' in slot '${piece.slot}' requires an arm but both arms are missing`);
                } else if (armsAvailable === 1 && piece.handedness === TWO_HANDED) {
                    errors.push(`edit.gear: two-handed gear '${piece.gearId}' requires two available arms (one is missing)`);
                }
            }
        }

        // statuses: per-op field/bounds checks against live instances
        if (raw.statuses !== undefined) {
            if (!Array.isArray(raw.statuses)) {
                errors.push('edit.statuses: must be an array');
            } else {
                const seen = new Set<string>();
                raw.statuses.forEach((entry, index) => {
                    const path = `edit.statuses[${index}]`;
                    if (!isPlainObject(entry)) {
                        errors.push(`${path}: expected a plain object`);
                        return;
                    }
                    const id = entry['id'];
                    if (typeof id !== 'string' || !isValidId(id)) {
                        errors.push(`${path}.id: must match /^[a-z0-9][a-z0-9-]*$/`);
                        return;
                    }
                    if (seen.has(id)) {
                        errors.push(`${path}.id: duplicate status edit for '${id}'`);
                        return;
                    }
                    seen.add(id);
                    if (entry['op'] !== 'set' && entry['op'] !== 'remove') {
                        errors.push(`${path}.op: must be 'set' or 'remove'`);
                        return;
                    }
                    if (entry['op'] === 'remove') {
                        for (const field of ['stacks', 'duration', 'potency'] as const) {
                            if (entry[field] !== undefined) errors.push(`${path}.${field}: must not be present on op 'remove'`);
                        }
                        if (!entity.statuses.some((status) => status.id === id)) {
                            errors.push(`${path}: status '${id}' is not present`);
                        }
                        return;
                    }
                    // op 'set' — admin bounds mirror the D3/D13 instance rules
                    const stacks = entry['stacks'];
                    if (stacks !== undefined && (typeof stacks !== 'number' || !Number.isInteger(stacks) || stacks < 1 || stacks > MAX_STATUS_STACKS)) {
                        errors.push(`${path}.stacks: must be an integer between 1 and ${MAX_STATUS_STACKS}`);
                    }
                    const duration = entry['duration'];
                    if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < MIN_STATUS_DURATION)) {
                        errors.push(`${path}.duration: must be an integer >= ${MIN_STATUS_DURATION}`);
                    }
                    const potency = entry['potency'];
                    if (potency !== undefined && (typeof potency !== 'number' || !Number.isInteger(potency) || potency < MIN_STATUS_POTENCY)) {
                        errors.push(`${path}.potency: must be an integer >= ${MIN_STATUS_POTENCY}`);
                    }
                });
            }
        }

        // resources: stamina/mana only (the energy alias is initial-input
        // only, never an edit contract — declared in types.ts); null removes
        // the pool, a plain object EXACTLY replaces it.
        if (raw.resources !== undefined) {
            if (!isPlainObject(raw.resources)) {
                errors.push('edit.resources: expected a plain object');
            } else {
                for (const key of Object.keys(raw.resources)) {
                    const path = `edit.resources['${key}']`;
                    if (key === 'energy') {
                        errors.push(`${path}: the energy alias is initial-input only — edit 'stamina' directly`);
                        continue;
                    }
                    if (key !== 'stamina' && key !== 'mana') {
                        errors.push(`${path}: unknown resource pool (expected stamina or mana)`);
                        continue;
                    }
                    const value = raw.resources[key];
                    if (value === null) continue; // removal is always valid
                    if (!isPlainObject(value)) {
                        errors.push(`${path}: expected a {current, max} object or null`);
                        continue;
                    }
                    const current = value['current'];
                    const max = value['max'];
                    if (typeof current !== 'number' || !Number.isInteger(current) || current < MIN_RESOURCE_VALUE || current > MAX_RESOURCE_VALUE) {
                        errors.push(`${path}.current: must be an integer between ${MIN_RESOURCE_VALUE} and ${MAX_RESOURCE_VALUE}`);
                    }
                    if (typeof max !== 'number' || !Number.isInteger(max) || max < MIN_RESOURCE_VALUE || max > MAX_RESOURCE_VALUE) {
                        errors.push(`${path}.max: must be an integer between ${MIN_RESOURCE_VALUE} and ${MAX_RESOURCE_VALUE}`);
                    }
                    if (typeof current === 'number' && typeof max === 'number' && current > max) {
                        errors.push(`${path}.current: must not exceed max (${current} > ${max})`);
                    }
                }
            }
        }

        if (errors.length > 0) throw new CombatValidationError(errors);

        // ---- atomic mutation with exact rollback (D7 machinery reused:
        // snapshot + log marker ⇒ state/RNG/log restored bit-for-bit on any
        // throw, e.g. a replaced scheduler:interval hook faulting during
        // revival/reschedule math) ----
        const speedBefore = effSpeed(entityId);
        const healthBefore = entity.health;
        const txn = { snap: snapshotStateOf(state), marker: cfg.log.marker() };
        try {
            // 1. baseStats merge; baseStats.health IS maxHealth (types.ts)
            const baseStatsEdit = raw.baseStats as Partial<StatBlock> | undefined;
            if (baseStatsEdit !== undefined) {
                for (const [key, value] of Object.entries(baseStatsEdit)) {
                    (entity.baseStats as Record<string, number>)[key] = value as number;
                }
                entity.maxHealth = entity.baseStats.health;
                // health NOT edited + max lowered ⇒ clamp coherently (the
                // floor is 1 — baseStats.health ≥ 1 can never kill here)
                if (raw.health === undefined && entity.health > entity.maxHealth) {
                    entity.health = entity.maxHealth;
                }
            }
            // 2. statuses — op 'set' is the DIRECT ADMIN SET (no resistance,
            // no stack-cap refresh math; definition modifiers materialized
            // when the id is registered; unregistered ids stay custom data)
            for (const statusEdit of raw.statuses ?? []) {
                if (statusEdit.op === 'remove') {
                    removeStatus(state, entityId, statusEdit.id);
                } else {
                    adminSetStatus(
                        state,
                        entityId,
                        {
                            id: statusEdit.id,
                            ...(statusEdit.stacks !== undefined ? { stacks: statusEdit.stacks } : {}),
                            ...(statusEdit.duration !== undefined ? { duration: statusEdit.duration } : {}),
                            ...(statusEdit.potency !== undefined ? { potency: statusEdit.potency } : {}),
                        },
                        statusOf(statusEdit.id),
                    );
                }
            }
            // 3. injuries — validated add/remove (the helpers keep the
            // additive-optional `injuries` field shape)
            for (const part of injuriesAdd) addInjury(state, entityId, part);
            for (const part of injuriesRemove) healInjury(state, entityId, part);
            // 4. resources — exact pool replace / removal (empty object gone)
            for (const [key, value] of Object.entries(raw.resources ?? {})) {
                if (value === null) {
                    if (entity.resources !== undefined) {
                        delete entity.resources[key as ResourceKey];
                        if (Object.keys(entity.resources).length === 0) delete entity.resources;
                    }
                } else if (value !== undefined) {
                    // undefined never reaches here: validation rejects it
                    // ("expected a {current, max} object or null")
                    if (entity.resources === undefined) entity.resources = {};
                    entity.resources[key as ResourceKey] = { current: value.current, max: value.max };
                }
            }
            // 5. gear — clear or replace-in-place per slot (validated)
            for (const gearEdit of raw.gear ?? []) {
                if (gearEdit.id === null) {
                    clearSlotGear(state, entityId, gearEdit.slot);
                } else {
                    setSlotGear(state, entityId, { gearId: gearEdit.id, slot: gearEdit.slot, durability: gearEdit.durability ?? (cfg.gear(gearEdit.id) as GearDefinition).durability });
                }
            }
            // 6. health + living/schedule coherence (AFTER the speed-relevant
            // domains so a revival entry uses the FINAL effective speed):
            // 0 ⇒ death (schedule dropped, D4e); > 0 on a dead entity ⇒
            // revival with the next entry at now + default interval through
            // the ACTIVE scheduler:interval hook.
            let revived = false;
            if (raw.health !== undefined) {
                const health = Math.max(0, Math.min(entity.maxHealth, raw.health));
                entity.health = health;
                const wasLiving = entity.living;
                entity.living = health > 0;
                if (wasLiving && !entity.living) {
                    dropScheduleEntries(state, entityId); // death removes schedule
                } else if (!wasLiving && entity.living) {
                    upsertEntry(state.schedule, entityId, state.virtualTime + intervalFn({ entityId, actionCost: DEFAULT_ACTION_COST, effectiveSpeed: effSpeed(entityId) }));
                    revived = true;
                }
            }
            // 7. derived stats + D4e speed sync: the edited entity is never
            // the current actor between turns, so its own pending entry
            // follows the proportional-remaining-work rule when derived
            // speed moved (base stats, status modifiers, leg injuries). A
            // freshly revived entry already carries the final speed; an
            // unchanged speed NEVER recomputes the entry (exactness — a
            // replaced interval hook's rounding curve must not re-fire).
            entity.stats = entityEffectiveStats(entity);
            const speedAfter = effSpeed(entityId);
            if (!revived && speedAfter !== speedBefore) {
                rescheduleEntry(state.schedule, entityId, state.virtualTime, speedBefore, speedAfter, intervalFn);
            }
        } catch (error) {
            // exact rollback: state + RNG + log marker, then the declared
            // CombatValidationError contract for ANY mutation-phase throw
            state = restoreStateFrom(txn.snap);
            cfg.rng.restoreState(txn.snap.rng);
            cfg.log.rollback(txn.marker);
            throw new CombatValidationError([`edit: ${messageOf(error)}`]);
        }

        // ---- the single edit event (D11): no step increment, existing ids
        // preserved; payload carries a meaningful per-domain summary ----
        const domains: string[] = [];
        const payload: Record<string, unknown> = { entityId };
        if (raw.health !== undefined) {
            domains.push('health');
            payload.health = { from: healthBefore, to: entity.health, max: entity.maxHealth, living: entity.living };
        }
        if (raw.baseStats !== undefined) {
            domains.push('baseStats');
            payload.baseStats = deepCopy(entity.baseStats);
        }
        if ((raw.statuses?.length ?? 0) > 0) {
            domains.push('statuses');
            payload.statuses = (raw.statuses ?? []).map((statusEdit) => {
                if (statusEdit.op === 'remove') return { id: statusEdit.id, op: 'remove' };
                const instance = entity.statuses.find((status) => status.id === statusEdit.id);
                return instance
                    ? { id: statusEdit.id, op: 'set', stacks: instance.stacks, duration: instance.duration, potency: instance.potency }
                    : { id: statusEdit.id, op: 'set' };
            });
        }
        if ((injuriesAdd.length > 0 || injuriesRemove.length > 0)) {
            domains.push('injuries');
            payload.injuries = { added: [...injuriesAdd], removed: [...injuriesRemove], missing: deepCopy(entity.injuries ?? []) };
        }
        if (raw.resources !== undefined) {
            domains.push('resources');
            payload.resources = Object.fromEntries(
                Object.keys(raw.resources).map((key) => [key, entity.resources?.[key as ResourceKey] ? deepCopy(entity.resources![key as ResourceKey]) : null]),
            );
        }
        if ((raw.gear?.length ?? 0) > 0) {
            domains.push('gear');
            payload.gear = (raw.gear ?? []).map((gearEdit) => {
                const occupant = entity.equipment.find((piece) => piece.slot === gearEdit.slot);
                return occupant
                    ? { slot: gearEdit.slot, id: occupant.gearId, durability: occupant.durability }
                    : { slot: gearEdit.slot, id: null };
            });
        }
        payload.domains = domains;
        cfg.log.emit({ type: 'combatant:edited', actor: entityId, payload }, state.step, state.virtualTime);
        cfg.log.trim(state.step, state.virtualTime);
    };

    return {
        state: () => state,
        setState: (next) => {
            state = next;
        },
        armInitialSchedule: () => {
            // D4a: every LIVING entity gets readyAt = interval(1, eff) from
            // time 0 — first readiness never 0; routed through the ACTIVE
            // interval hook (scheduler.ts header rule). T2 (R2): effective
            // speed comes from the central derivation (injuries included).
            state.schedule = buildInitialEntries(
                state.entities
                    .filter((entity) => entity.living)
                    .map((entity) => ({
                        entityId: entity.id,
                        actionCost: DEFAULT_ACTION_COST,
                        effectiveSpeed: entityEffectiveStats(entity).speed,
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
        // T3 live edit — see the editCombatant block above and the
        // TurnRunner interface comment.
        editCombatant,
        runtime: () => ({ adapter, view: () => stateViewOf(state) }),
    };
};
