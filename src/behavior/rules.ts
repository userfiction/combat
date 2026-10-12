// ============================================================================
// @userfiction/combat — src/behavior/rules.ts — T5 default playable rules (task §9 T5,
// D5 formulas verbatim; D6 default-handler column; bounds pinned in types.ts)
// ============================================================================
// `defaultRules()` builds the builtin CombatPlugin (id '@userfiction/combat/
// rules', D5 preamble) that ships every SINGLE-mode default from the D6
// table. It claims NO overrides (D6: "the builtin defaultRules plugin ships
// the baseline single-mode handlers without overrides — it is the floor every
// override replaces"), so any client plugin declaring the hook replaces it
// (last-wins, D6).
//
// Chain-mode defaults (D5b durability in `equipment:post`, D5c fear/poison/
// stun in `status:turn-end`) CANNOT be plain handlers: handlers receive
// read-only views and may only return EffectDescriptors (D7), and the D8
// vocabulary has no durability/decay descriptor. Resolution (documented,
// matches D6 "default runs first, contributions after" and the D5 preamble
// "a client replaces any *single-mode* hook via overrides or ADDS chain
// contributions"): the engine executes these defaults through the exported
// phase-default functions below, gated on the builtin-rules flag — dropping
// the builtin floor (options.builtinRules === false) removes them, which IS
// their replaceability. The functions receive an engine-owned mutation API
// (D7 "only the engine mutates state") so the rule LOGIC stays here and is
// unit-testable with a recording mock.
//
// Catalog access (D5a.7/D5a.8): the view's EquipmentEntry carries
// { gearId, slot, durability } only (D7) — weapon damage/type and armour
// blunt/sharp resistances live in the gear catalog. The factory therefore
// accepts the EFFECTIVE gear list (client patches folded over
// defaultGearSeed, D9) plus the merged plugin vocab (for ability `conditions`
// gates, D9/D5a.2). Called bare — `defaultRules()` as in the §7 example — it
// falls back to the builtin seed and an empty vocab, so the shipped defaults
// are self-contained.
//
// RNG discipline (D4g): every roll below goes through ctx.rng ONLY, and the
// draw points are exactly the D5 order: fear roll at action:select (only
// when feared), target pick (rng.pick, one draw when ≥1 enemy), dodge roll
// (always when the hook runs), crit roll (always), block roll (ONLY when a
// shield is equipped), chance conditions (interpreter). Single-element
// action pools consume NO draw (D5a.2).
// ============================================================================

import { defaultInterval, defaultOrder } from '../runtime/scheduler';
import { defaultGearSeed } from '../data/catalogs';
import { evaluateCondition } from './effects';
import type { EffectAdapter, InterpreterDeps, VocabLookup } from './effects';
import { availableArmsOf, canPayResourceCosts, entityEffectiveStats, normalizeResourceCost } from '../runtime/state';
import { ARMOUR_SLOTS } from '../runtime/state';
import type { DamageResult, GearDamageResult, HealResult } from '../runtime/state';
import {
    ARMOUR_MITIGATION_FLOOR,
    BASE_DODGE_CHANCE,
    BLOCK_MULTIPLIER,
    CRIT_CHANCE,
    DEFENSE_DIVISOR_BASE,
    DEFAULT_ABILITY_COST,
    DODGE_CHANCE_CAP,
    DODGE_CHANCE_PER_POINT,
    FEAR_SKIP_CHANCE_PER_STACK,
    MIN_LANDED_DAMAGE,
    SHIELD_BLOCK_CHANCE,
    STRENGTH_FACTOR_PER_POINT,
    UNARMED_BASE_DAMAGE,
    DURABILITY_LOSS_PER_HIT,
} from '../contract/types';
import type {
    AbilityDefinition,
    ActionSelection,
    AttackRollArgs,
    CombatPlugin,
    DamageMitigateArgs,
    DamagePostArgs,
    DamageType,
    EquipmentEntry,
    EquipmentPostArgs,
    EntityView,
    EventDraft,
    GearDefinition,
    OutcomeDecideContext,
    SchedulerIntervalArgs,
    SchedulerOrderArgs,
    Slot,
    StatModifier,
    StateView,
    StatusDefinition,
    StatusInstance,
    StatusTurnEndArgs,
    StepContext,
} from '../contract/types';

// Builtin floor plugin id (D5 preamble, verbatim).
export const BUILTIN_RULES_PLUGIN_ID = '@userfiction/combat/rules';

// Floor identity brand (engine integration, §7 usage fix): createSimulation
// NORMALIZES a genuine defaultRules() instance found in options.plugins
// into the builtin floor instead of registering it as an ordinary code
// plugin — otherwise the canonical §7 usage `plugins: [defaultRules(), ...]`
// trips both load rejections (duplicate id against the auto floor AND ten
// undeclared single-mode handlers, D6/D7). Symbol-keyed + non-enumerable:
// invisible to JSON/deepCopy/structural checks, carried by object IDENTITY,
// so an untrusted impostor that merely reuses the id string is NOT exempted
// (arbitrary duplicate ids keep failing fast). Symbol.for: a dev-source and
// dist copy of the module still recognize each other.
const DEFAULT_RULES_BRAND = Symbol.for('@userfiction/combat/defaultRules');

// True only for objects RETURNED by this module's defaultRules() factory.
export const isDefaultRulesPlugin = (plugin: unknown): boolean =>
    typeof plugin === 'object' && plugin !== null && (plugin as Record<symbol, unknown>)[DEFAULT_RULES_BRAND] === true;

// Factory options (see header): effective gear list + ability catalog (for
// the D9 conditions availability gate) + merged plugin vocab + the RESOLVED
// STATUS REGISTRY (T2 R1: the select/turn-end floor consults status
// definitions). All optional — bare `defaultRules()` (the §7 form) runs on
// the builtin seeds alone.
export interface DefaultRulesOptions {
    gear?: readonly GearDefinition[];
    abilities?: readonly AbilityDefinition[];
    vocab?: VocabLookup;
    statuses?: readonly StatusDefinition[];
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

// Living enemies of one entity (D5a.3 targeting sets): teams ⇒ living
// members of OTHER teams; ffa ⇒ every other living entity.
export const enemiesOf = (view: StateView, entity: EntityView): EntityView[] =>
    view.entities.filter(
        (candidate) =>
            candidate.living &&
            candidate.id !== entity.id &&
            (view.mode === 'teams' ? candidate.team !== entity.team : true),
    );

// Does ANY living entity have a living enemy? (D5g no-enemies invariant.)
const anyHasEnemy = (view: StateView): boolean =>
    view.entities.some((entity) => entity.living && enemiesOf(view, entity).length > 0);

// Conditions never mutate, but InterpreterDeps requires an adapter; this
// throw-on-use adapter surfaces a condition that wrongly expects effects.
const conditionOnlyAdapter = (): EffectAdapter => {
    const fault = (): never => {
        throw new Error('EffectAdapter used from a read-only condition context');
    };
    return {
        strike: fault,
        damageFlat: fault,
        heal: fault,
        applyStatus: fault,
        removeStatus: fault,
        applyInjury: fault,
        healInjury: fault,
        modifyResource: fault,
        breakEquipment: fault,
        modifyStat: fault,
        emitMessage: fault,
    };
};

// ----------------------------------------------------------------------------
// defaultRules — the builtin plugin (D5/D6)
// ----------------------------------------------------------------------------

export const defaultRules = (options: DefaultRulesOptions = {}): CombatPlugin => {
    // Effective catalog lookups (D9 merged list; builtin seed when omitted —
    // the bare `defaultRules()` §7 form must resolve builtin gear standalone).
    const gear = options.gear ?? defaultGearSeed;
    const gearById = new Map<string, GearDefinition>(gear.map((definition) => [definition.id, definition]));
    const abilityById = new Map<string, AbilityDefinition>((options.abilities ?? []).map((definition) => [definition.id, definition]));
    // T2 (R1): the RESOLVED status registry — select/turn-end consult these
    // definitions; legacy fear/poison/stun keep their hardcoded semantics
    // only for ids WITHOUT a definition here.
    const statusById = new Map<string, StatusDefinition>((options.statuses ?? []).map((definition) => [definition.id, definition]));
    const vocab = options.vocab ?? { condition: () => undefined, effect: () => undefined };
    const adapter = conditionOnlyAdapter();

    const plugin: CombatPlugin = {
        id: BUILTIN_RULES_PLUGIN_ID,
        hooks: {
            // --- scheduler defaults (D4b / D4d) — pure math floor reused
            // from scheduler.ts so hook and standalone paths never differ ---
            'scheduler:interval': (_view, _ctx, args: SchedulerIntervalArgs) => defaultInterval(args),
            'scheduler:order': (_view, _ctx, args: SchedulerOrderArgs) => defaultOrder(args),

            // --- action:select (D5a.2) — fixed order: stun gate, fear roll,
            // definition-driven skip rolls (T2), usable hostile pool (with
            // resource-cost affordability, R3), wait ONLY as the empty-pool
            // fallback ---
            'action:select': (view, ctx, args) => {
                const actor = (args as { actor: EntityView }).actor;
                // stun gates the whole turn (D5c): forced skip, no roll, no draw
                if (actor.statuses.some((status) => status.id === 'stun')) {
                    return { kind: 'skip', reason: 'stunned' } satisfies ActionSelection;
                }
                // fear roll (D5a.2): rng < 0.25 × stacks; the roll happens
                // (consumes one draw) whenever fear is present, skip or not.
                // Decay is NOT here — it runs at status:turn-end (D5c).
                const fear = actor.statuses.find((status) => status.id === 'fear');
                if (fear) {
                    if (ctx.rng.next() < FEAR_SKIP_CHANCE_PER_STACK * (fear.stacks ?? 1)) {
                        return { kind: 'skip', reason: 'feared' } satisfies ActionSelection;
                    }
                }
                // T2 (R1) definition-driven skip rolls: every status whose
                // resolved definition carries skipChancePerStack rolls
                // rng < chance × stacks (one draw each, stored order —
                // deterministic). Reason = the status id (open set, D6).
                for (const status of actor.statuses) {
                    const definition = statusById.get(status.id);
                    const chance = definition?.skipChancePerStack ?? 0;
                    if (chance <= 0) continue;
                    if (ctx.rng.next() < chance * (status.stacks ?? 1)) {
                        return { kind: 'skip', reason: status.id } satisfies ActionSelection;
                    }
                }
                // usable hostile actions (D5a.2): [attack] ∪ ready abilities,
                // each gated on a valid enemy target existing (usability rule
                // that guarantees R6 real attacks beside an eligible target).
                const enemies = enemiesOf(view, actor);
                const pool: ActionSelection[] = [];
                if (enemies.length > 0) pool.push({ kind: 'attack' });
                for (const abilityId of Object.keys(actor.cooldowns)) {
                    // cooldown counted in the actor's own scheduled turns (D9)
                    if ((actor.cooldowns[abilityId] ?? 0) > 0) continue;
                    const ability = gearAbility(abilityId);
                    if (!ability) continue; // catalog-validated upstream; defensive
                    if (enemies.length === 0) continue;
                    // T2 (R3) affordability gate: an ability whose resource
                    // costs exceed the actor's pools/health is NOT in the
                    // pool — the fallback ladder falls through to other
                    // actions or wait. Health must survive the payment
                    // (strictly > cost ⇒ never self-killing via costs).
                    if (!canPayResourceCosts(actor, normalizeResourceCost(ability.costs))) continue;
                    // availability gate (D9): conditions may consume draws via
                    // chance — deterministic pipeline order (D4g)
                    if (ability.conditions && !evaluateCondition(ability.conditions, deps(view, ctx))) continue;
                    pool.push({ kind: 'ability', abilityId });
                }
                // wait = fallback ONLY when the usable set is empty (D5a.2)
                if (pool.length === 0) return { kind: 'wait' } satisfies ActionSelection;
                // single-element pool selects directly WITHOUT a draw (D5a.2)
                if (pool.length === 1) return pool[0];
                return ctx.rng.pick(pool) as ActionSelection;
            },

            // --- target:select (D5a.3): uniform rng.pick among living
            // enemies; none ⇒ null (engine logs the no-target skip). One
            // draw whenever ≥1 enemy exists — the no-draw exemption is
            // scoped to action pools (D5a.2), not targeting. ---
            'target:select': (view, ctx, args) => {
                const actor = (args as { actor: EntityView }).actor;
                const enemies = enemiesOf(view, actor);
                if (enemies.length === 0) return null;
                return (ctx.rng.pick(enemies) as EntityView).id;
            },

            // --- attack:dodge (D5a.5): clamp(0.05 + (evasion − precision) ×
            // 0.005, 0, 0.75); the roll always consumes one draw. ---
            'attack:dodge': (_view, ctx, args) => {
                const { attacker, target } = args as AttackRollArgs;
                const chance = Math.min(
                    DODGE_CHANCE_CAP,
                    Math.max(0, BASE_DODGE_CHANCE + (target.stats.evasion - attacker.stats.precision) * DODGE_CHANCE_PER_POINT),
                );
                return { dodged: ctx.rng.next() < chance };
            },

            // --- attack:crit (D5a.6): flat 5%, roll always. ---
            'attack:crit': (_view, ctx) => ({ crit: ctx.rng.next() < CRIT_CHANCE }),

            // --- damage:base (D5a.7/D5d): raw = (weapon.damage else unarmed
            // 1) × (1 + 0.05 × strength); unarmed type is 'blunt'. No
            // rounding here — the single rounding point is mitigate (D5a.8). ---
            'damage:base': (_view, _ctx, args) => {
                const { attacker, weapon } = args as AttackRollArgs;
                const strengthFactor = 1 + STRENGTH_FACTOR_PER_POINT * attacker.stats.strength;
                if (weapon) {
                    const definition = gearById.get(weapon.gearId);
                    if (definition) {
                        return { amount: definition.damage * strengthFactor, damageType: definition.type };
                    }
                }
                return { amount: UNARMED_BASE_DAMAGE * strengthFactor, damageType: 'blunt' as DamageType };
            },

            // --- damage:mitigate (D5a.8), fixed internal order: block roll
            // (shield ⇒ 15%, ×0.5 — a blocked crit nets ×0.75 because the
            // engine pre-multiplied crit) → armour Π(1−resist) floored ×0.1
            // → defense 100/(100+defense) → max(1, round(everything)). ---
            'damage:mitigate': (_view, ctx, args) => {
                const { target, amount, damageType } = args as DamageMitigateArgs;
                let factor = 1;
                let blocked = false;
                // shield = armour-kind piece in slot 'shield' (D5e); the
                // block roll consumes a draw ONLY when a shield is equipped.
                // T2 (R2): a shield occupies a hand — with NO available arms
                // (both missing) the shield is inert and consumes NO draw.
                const shield = target.equipment.find((piece) => piece.slot === 'shield');
                if (shield !== undefined && availableArmsOf(target.injuries) > 0 && ctx.rng.next() < SHIELD_BLOCK_CHANCE) {
                    blocked = true;
                    factor *= BLOCK_MULTIPLIER;
                }
                // armour mitigation: pieces with resistance > 0 for the
                // incoming type (D5a.8); weapons' blunt/sharp are inert (D9).
                let armourFactor = 1;
                for (const piece of target.equipment) {
                    if (!ARMOUR_SLOTS.includes(piece.slot)) continue;
                    const definition = gearById.get(piece.gearId);
                    if (!definition) continue;
                    const resist = damageType === 'blunt' ? definition.blunt : definition.sharp;
                    if (resist > 0) armourFactor *= 1 - resist;
                }
                armourFactor = Math.max(ARMOUR_MITIGATION_FLOOR, armourFactor);
                const defenseFactor = DEFENSE_DIVISOR_BASE / (DEFENSE_DIVISOR_BASE + target.stats.defense);
                const final = Math.max(MIN_LANDED_DAMAGE, Math.round(amount * factor * armourFactor * defenseFactor));
                return { amount: final, blocked, armourFactor, defenseFactor };
            },

            // --- ability:execute (D5a.12/D8): interpret the catalog
            // effects — the engine applies them through its adapter. Copy so
            // the returned descriptors can never alias the live catalog. ---
            'ability:execute': (_view, _ctx, args) => {
                const { ability } = args as { actor: EntityView; target?: EntityView; ability: AbilityDefinition };
                return ability.effects.map((effect) => ({ ...effect }));
            },

            // --- outcome:decide (D5g invariants), checked in order:
            // mutual-destruction → step-0 no-enemies → victory → step-limit.
            // Pure observation: ctx here carries no working rng/emit (the
            // engine enforces, D7); args = { step, time, config }. ---
            'outcome:decide': (view, _ctx, args) => {
                const { step, config } = args as OutcomeDecideContext;
                const living = view.entities.filter((entity) => entity.living);
                // 0 living ⇒ draw mutual-destruction (both modes, D5g)
                if (living.length === 0) return { outcome: 'draw', reason: 'mutual-destruction' };
                // step-0 no-enemies draw (D5g: e.g. all entities on one team)
                if (step === 0 && !anyHasEnemy(view)) return { outcome: 'draw', reason: 'no-enemies' };
                if (view.mode === 'teams') {
                    const teams = new Set(living.map((entity) => entity.team));
                    if (teams.size === 1) return { outcome: 'victory', winner: living[0].team };
                } else if (living.length === 1) {
                    // FFA last-man-standing (D5g)
                    return { outcome: 'victory', winner: living[0].id };
                }
                // step cap ⇒ undecided step-limit (D4f/D5g) — checked LAST so
                // a battle resolved on its final allowed step still wins.
                if (step >= config.maxSteps) return { outcome: 'undecided', reason: 'step-limit' };
                return null;
            },
        },
    };

    // brand the factory's output so the engine can normalize it into the
    // builtin floor by identity, not by id string (see header)
    Object.defineProperty(plugin, DEFAULT_RULES_BRAND, { value: true });
    return plugin;

    // ability catalog (D9): existence + conditions gate; the engine
    // validates abilityId before calling, so this lookup is defensive only.
    function gearAbility(abilityId: string): AbilityDefinition | undefined {
        return abilityById.get(abilityId);
    }
    function deps(view: StateView, ctx: StepContext): InterpreterDeps {
        return { view, ctx, vocab, adapter };
    }
};

// ----------------------------------------------------------------------------
// Chain-phase defaults (see header resolution note) — engine-executed,
// mutation through the injected API only (D7).
// ----------------------------------------------------------------------------

// Engine-owned mutation surface for the phase defaults. Every method maps 1:1
// onto a state.ts helper; the pipeline implements them as thin closures over
// the live CombatState + event log.
export interface PhaseDefaultApi {
    damageGear(entityId: string, slot: Slot, amount?: number): GearDamageResult | null;
    removeGear(entityId: string, slot: Slot): EquipmentEntry | null;
    damageEntity(entityId: string, amount: number): DamageResult;
    // T2 (R1): definition tick heals route through the engine (clamped at
    // maxHealth, no revive) — same contract as the D8 heal effect.
    healEntity(entityId: string, amount: number): HealResult;
    removeStatus(entityId: string, statusId: string): boolean;
    // overwrite stacks/duration on an existing instance (fear decay, poison/
    // stun duration decay, T2 definition decay) — no event; callers emit per
    // D5c rules. T2: `definition` provided ⇒ the engine re-materializes the
    // definition's per-stack modifiers after the patch (a stack change must
    // re-scale status-borne modifiers immediately).
    patchStatus(entityId: string, statusId: string, patch: { stacks?: number; duration?: number }, definition?: StatusDefinition): void;
    decrementStatModifiers(entityId: string): StatModifier[];
    dropScheduleEntries(entityId: string): void;
    emit(draft: EventDraft): void;
}

// D5b durability and breakage (equipment:post default, runs BEFORE chain
// contributions). On each LANDED hit: attacker's weapon −1 (unarmed:
// nothing); each defender armour piece that CONTRIBUTED resistance for the
// incoming type −1 (contributors are computed by the engine — D5b "the
// breaking piece still contributed its resistance to that hit" is satisfied
// because this phase runs after damage application). Durability 0 ⇒
// gear:broken + removal (the engine's removeGear frees the slot; a broken
// weapon falls back to unarmed on subsequent attacks, D5d).
export const applyEquipmentPostDefault = (api: PhaseDefaultApi, args: EquipmentPostArgs): void => {
    const wear = (entityId: string, slot: Slot): void => {
        const result = api.damageGear(entityId, slot, DURABILITY_LOSS_PER_HIT);
        if (!result) return; // slot already emptied mid-cascade — tolerate
        api.emit({ type: 'gear:damaged', actor: entityId, payload: { gearId: result.gearId, slot: result.slot, durability: result.durability } });
        if (result.broken) {
            api.removeGear(entityId, slot);
            api.emit({ type: 'gear:broken', actor: entityId, payload: { gearId: result.gearId, slot: result.slot } });
        }
    };
    // attacker's weapon (undefined weapon ⇒ unarmed, no bookkeeping, D5d)
    if (args.attacker && args.weapon) wear(args.attacker.id, args.weapon.slot);
    // defender's contributing armour pieces (D5b)
    if (args.target) {
        for (const piece of args.contributedArmour ?? []) wear(args.target.id, piece.slot);
    }
};

// D5c affliction behavior at the END of the afflicted entity's own scheduled
// turn (status:turn-end default, runs BEFORE chain contributions):
//   fear  (stacks): stacks −1; expired at 0 (status:expired). Silent decay.
//   poison (duration): deal potency × stacks direct damage (status:tick +
//     damage event, source 'poison', bypasses mitigation, CAN kill — death
//     drops the schedule), THEN duration −1; expired at 0.
//   stun  (duration): duration −1; expired at 0 (the skip itself was gated
//     at action:select).
//
// T2 (R1) definition-driven statuses: when the RESOLVED status registry has
// a definition for the instance's id, the GENERIC path handles it — per own
// turn, in order: tick (damage → heal, × stacks) then decay
// ('stacks' −1 per turn / 'duration' countdown / 'none' permanent). The
// legacy trio keeps its hardcoded semantics ONLY while no definition exists
// for its id; a client definition deliberately replaces it (documented).
// `statusOf` is the resolved-registry lookup — omitted by older callers
// (2-argument signature preserved) which then get exact legacy behavior.
// Temporary stat modifiers decrement in the same phase (D5c); each expired
// modifier fires stat:expired (D11). Statuses iterate in stored order —
// deterministic.
export const applyStatusTurnEndDefault = (
    api: PhaseDefaultApi,
    args: StatusTurnEndArgs,
    statusOf?: (statusId: string) => StatusDefinition | undefined,
): void => {
    const entity = args.entity;
    for (const status of entity.statuses) {
        const stacks = status.stacks ?? 1;
        const potency = status.potency ?? 1;
        const definition = statusOf?.(status.id);
        if (definition) {
            applyDefinitionTurnEnd(api, entity, status, stacks, definition);
            continue;
        }
        if (status.id === 'fear') {
            const remaining = stacks - 1;
            if (remaining <= 0) {
                api.removeStatus(entity.id, 'fear');
                api.emit({ type: 'status:expired', actor: entity.id, payload: { statusId: 'fear' } });
            } else {
                api.patchStatus(entity.id, 'fear', { stacks: remaining });
            }
        } else if (status.id === 'poison') {
            // tick FIRST, then decay (D5c "after the final tick" expiry fires
            // after the damage); damage bypasses mitigation, can kill.
            const result = api.damageEntity(entity.id, potency * stacks);
            api.emit({ type: 'status:tick', actor: entity.id, payload: { statusId: 'poison', damage: result.applied } });
            api.emit({
                type: 'damage',
                actor: entity.id,
                target: entity.id,
                payload: {
                    amount: result.applied,
                    damageType: 'true',
                    source: 'poison',
                    mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 },
                },
            });
            if (result.killed) {
                api.emit({ type: 'death', actor: entity.id, payload: {} });
                api.dropScheduleEntries(entity.id);
            }
            const remaining = (status.duration ?? 0) - 1;
            if (remaining <= 0) {
                api.removeStatus(entity.id, 'poison');
                api.emit({ type: 'status:expired', actor: entity.id, payload: { statusId: 'poison' } });
            } else {
                api.patchStatus(entity.id, 'poison', { duration: remaining });
            }
        } else if (status.id === 'stun') {
            const remaining = (status.duration ?? 0) - 1;
            if (remaining <= 0) {
                api.removeStatus(entity.id, 'stun');
                api.emit({ type: 'status:expired', actor: entity.id, payload: { statusId: 'stun' } });
            } else {
                api.patchStatus(entity.id, 'stun', { duration: remaining });
            }
        }
        // any other id: bookkeeping only — semantics live in plugin chain
        // contributions (D5f honest statement), or in the definition-driven
        // branch above when the resolved registry has a definition.
    }
    // temporary stat modifiers decrement in the same phase (D5c)
    for (const expired of api.decrementStatModifiers(entity.id)) {
        api.emit({ type: 'stat:expired', actor: entity.id, payload: { stat: expired.stat, amount: expired.amount } });
    }
};

// T2 (R1) generic definition-driven own-turn processing (mirrors the poison
// event order exactly: tick events → death bookkeeping → decay/expiry).
const applyDefinitionTurnEnd = (
    api: PhaseDefaultApi,
    entity: EntityView,
    status: StatusInstance,
    stacks: number,
    definition: StatusDefinition,
): void => {
    const statusId = status.id;
    // damage tick (before decay, D5c order): × stacks, true damage, can kill
    const tickDamage = definition.tick?.damage;
    if (tickDamage !== undefined && tickDamage > 0) {
        const result = api.damageEntity(entity.id, tickDamage * stacks);
        api.emit({ type: 'status:tick', actor: entity.id, payload: { statusId, damage: result.applied } });
        api.emit({
            type: 'damage',
            actor: entity.id,
            target: entity.id,
            payload: {
                amount: result.applied,
                damageType: 'true',
                source: statusId,
                mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 },
            },
        });
        if (result.killed) {
            api.emit({ type: 'death', actor: entity.id, payload: {} });
            api.dropScheduleEntries(entity.id);
        }
    }
    // heal tick: clamped at maxHealth, never revives
    const tickHeal = definition.tick?.heal;
    if (tickHeal !== undefined && tickHeal > 0) {
        const result = api.healEntity(entity.id, tickHeal * stacks);
        api.emit({ type: 'heal', actor: entity.id, target: entity.id, payload: { amount: result.applied } });
    }
    // decay + expiry
    if (definition.decay === 'stacks') {
        const remaining = stacks - 1;
        if (remaining <= 0) {
            api.removeStatus(entity.id, statusId);
            api.emit({ type: 'status:expired', actor: entity.id, payload: { statusId } });
        } else {
            api.patchStatus(entity.id, statusId, { stacks: remaining }, definition);
        }
    } else if (definition.decay === 'duration') {
        const remaining = (status.duration ?? 0) - 1;
        if (remaining <= 0) {
            api.removeStatus(entity.id, statusId);
            api.emit({ type: 'status:expired', actor: entity.id, payload: { statusId } });
        } else {
            api.patchStatus(entity.id, statusId, { duration: remaining }, definition);
        }
    }
    // decay 'none' (or unset): permanent until removed — nothing here
};
