// ============================================================================
// @userfiction/combat — src/runtime/status-state.test.ts — T2 state-level
// derivation + mutation helpers (R1/R2/R3)
// ============================================================================
// Pins the CENTRAL effective-stat derivation (status-borne materialized
// modifiers, injury speed/precision/evasion), materialization lifecycle
// (apply refresh re-scale, seed materialization, patch re-scale), the
// injury mutation pair (idempotent add, coherent restore) and the resource
// cost gate/payment/modify trio. Every expected value is derived from the
// D13 constants in contract/types.ts (INJURY_* factors, bounds) — no
// observed-output guessing.
// ============================================================================

import {
    applyStatus,
    addInjury,
    addStatModifier,
    canPayResourceCosts,
    createCombatState,
    createEntityState,
    entityEffectiveStats,
    healInjury,
    materializeEntityStatuses,
    modifyResourcePool,
    normalizeResourceCost,
    patchStatusInstance,
    payResourceCosts,
    scaledStatusModifiers,
} from './state';
import type { CombatState, EntityState } from './state';
import { COMBAT_SCHEMA_VERSION, INJURY_LEG_SPEED_FACTOR } from '../contract/types';
import type { StatusDefinition } from '../contract/types';

const BUILTIN: Record<string, StatusDefinition> = {
    blinded: { id: 'blinded', decay: 'duration', modifiers: { precision: -2 } },
    hasted: { id: 'hasted', decay: 'duration', modifiers: { speed: 1 } },
    bleeding: { id: 'bleeding', decay: 'duration', tick: { damage: 2 } },
};

const mkState = (entities: EntityState[]): CombatState =>
    createCombatState({
        mode: 'ffa',
        entities,
        rng: { seed: 1, state: 1, draws: 0 },
    });

const bare = (id: string, over: Partial<EntityState> = {}): EntityState =>
    createEntityState({
        id,
        order: 0,
        stats: { health: 30, strength: 0, speed: 1 },
        ...over,
    });

// ----------------------------------------------------------------------------
// Central derivation (R1/R2)
// ----------------------------------------------------------------------------

describe('entityEffectiveStats (central derivation)', () => {
    it('sums ALL additive contributions first, then multiplies missing-leg speed', () => {
        // mkState deep-copies — the live entity under test is the COPY
        const state = mkState([createEntityState({
            id: 'a',
            order: 0,
            stats: { health: 30, strength: 8, speed: 4, precision: 10, evasion: 5 },
            statuses: [{ id: 'hasted', stacks: 1, potency: 1 }],
            injuries: ['left-leg'],
        })]);
        const entity = state.entities[0];
        // seeded statuses materialize via the registry (engine parity)
        materializeEntityStatuses(entity, (id) => BUILTIN[id]);
        addStatModifier(state, 'a', 'strength', 2, 2);
        // additive sum: strength 8 + 2 (timed), speed 4 + 1 (hasted);
        // THEN the leg factor: (4 + 1) × 0.75 = 3.75
        expect(entityEffectiveStats(entity)).toEqual({
            health: 30, strength: 10, speed: 3.75, defense: 0, precision: 10, evasion: 5,
        });
    });

    it('derives missing-eye precision and missing-ear evasion penalties (flat, per part)', () => {
        const entity = createEntityState({
            id: 'a',
            order: 0,
            stats: { health: 30, strength: 0, speed: 2, precision: 10, evasion: 5 },
            injuries: ['left-eye', 'right-ear'],
        });
        expect(entityEffectiveStats(entity)).toEqual({
            health: 30, strength: 0, speed: 2, defense: 0,
            precision: 10 - 2,   // INJURY_EYE_PRECISION_PENALTY × 1
            evasion: 5 - 1,      // INJURY_EAR_EVASION_PENALTY × 1
        });
        const both = createEntityState({
            id: 'b',
            order: 0,
            stats: { health: 30, strength: 0, speed: 2, precision: 10, evasion: 5 },
            injuries: ['left-eye', 'right-eye', 'left-ear', 'right-ear', 'nose'],
        });
        expect(entityEffectiveStats(both)).toEqual({
            health: 30, strength: 0, speed: 2, defense: 0,
            precision: 10 - 4,   // −2 per missing eye; nose contributes NOTHING
            evasion: 5 - 2,      // −1 per missing ear
        });
    });

    it('multiplies speed per missing leg and still clamps at the 0.001 floor', () => {
        const one = createEntityState({
            id: 'a', order: 0, stats: { health: 10, strength: 0, speed: 4 }, injuries: ['right-leg'],
        });
        expect(entityEffectiveStats(one).speed).toBe(4 * INJURY_LEG_SPEED_FACTOR); // 3
        const two = createEntityState({
            id: 'b', order: 0, stats: { health: 10, strength: 0, speed: 4 }, injuries: ['left-leg', 'right-leg'],
        });
        expect(entityEffectiveStats(two).speed).toBe(4 * 0.5625); // ×0.75²
        const slow = createEntityState({
            id: 'c', order: 0, stats: { health: 10, strength: 0, speed: 0.001 }, injuries: ['left-leg'],
        });
        expect(entityEffectiveStats(slow).speed).toBe(0.001); // floor wins
    });

    it('legacy entities (no statuses/injuries) derive exactly like effectiveStatsOf', () => {
        const entity = bare('a');
        expect(entityEffectiveStats(entity)).toEqual({
            health: 30, strength: 0, speed: 1, defense: 0, precision: 0, evasion: 0,
        });
    });
});

// ----------------------------------------------------------------------------
// Materialization lifecycle (R1)
// ----------------------------------------------------------------------------

describe('scaledStatusModifiers + applyStatus materialization', () => {
    it('scales modifiers per stack and drops empty materializations', () => {
        expect(scaledStatusModifiers({ precision: -2 }, 3)).toEqual({ precision: -6 });
        expect(scaledStatusModifiers(undefined, 2)).toBeUndefined();
    });

    it('materializes on apply and re-SCALES (never accumulates) on refresh', () => {
        const state = mkState([bare('a')]);
        const first = applyStatus(state, 'a', 'blinded', { stacks: 1, duration: 3, definition: BUILTIN.blinded });
        expect(first).toEqual({
            kind: 'applied',
            status: { id: 'blinded', stacks: 1, potency: 1, duration: 3, modifiers: { precision: -2 } },
        });
        const refresh = applyStatus(state, 'a', 'blinded', { stacks: 2, definition: BUILTIN.blinded });
        expect(refresh).toEqual({
            kind: 'refreshed',
            status: { id: 'blinded', stacks: 3, potency: 1, duration: 3, modifiers: { precision: -6 } },
        });
        // the live instance holds exactly one materialized contribution
        expect(state.entities[0].statuses).toHaveLength(1);
        expect(entityEffectiveStats(state.entities[0]).precision).toBe(-6);
    });

    it('a definition without modifiers clears stale materialized values', () => {
        const state = mkState([bare('a')]);
        applyStatus(state, 'a', 'blinded', { stacks: 1, definition: BUILTIN.blinded });
        expect(state.entities[0].statuses[0].modifiers).toEqual({ precision: -2 });
        // a definition-less re-apply cannot carry modifiers
        applyStatus(state, 'a', 'blinded', { stacks: 1 });
        expect(state.entities[0].statuses[0].modifiers).toBeUndefined();
        expect(entityEffectiveStats(state.entities[0]).precision).toBe(0);
    });

    it('patchStatusInstance re-scales on stack decay; materializeEntityStatuses covers seeded statuses', () => {
        const entity = createEntityState({
            id: 'a', order: 0,
            stats: { health: 10, strength: 0, speed: 1, precision: 10 },
            statuses: [{ id: 'blinded', stacks: 3, duration: 5 }],
        });
        materializeEntityStatuses(entity, (id) => BUILTIN[id]);
        expect(entity.statuses[0].modifiers).toEqual({ precision: -6 });
        expect(entityEffectiveStats(entity).precision).toBe(4);

        // mkState deep-copies — patch operates on the LIVE copy inside state
        const state = mkState([entity]);
        const live = state.entities[0];
        patchStatusInstance(state, 'a', 'blinded', { stacks: 2 }, BUILTIN.blinded);
        expect(live.statuses[0].modifiers).toEqual({ precision: -4 });
        // duration-only patch does not touch the scaled value
        patchStatusInstance(state, 'a', 'blinded', { duration: 2 }, BUILTIN.blinded);
        expect(live.statuses[0]).toEqual({ id: 'blinded', stacks: 2, potency: 1, duration: 2, modifiers: { precision: -4 } });
        // unknown instance is a no-op
        expect(patchStatusInstance(state, 'a', 'ghost', { stacks: 1 })).toBeUndefined();
    });

    it('removing the instance removes its contribution (buff deactivation without residual modifiers)', () => {
        const state = mkState([createEntityState({
            id: 'a', order: 0,
            stats: { health: 10, strength: 0, speed: 1, precision: 5 },
            statuses: [{ id: 'blinded', stacks: 1, duration: 9 }],
        })]);
        materializeEntityStatuses(state.entities[0], (id) => BUILTIN[id]);
        expect(entityEffectiveStats(state.entities[0]).precision).toBe(3);
        state.entities[0].statuses.length = 0;
        expect(entityEffectiveStats(state.entities[0]).precision).toBe(5);
    });
});

// ----------------------------------------------------------------------------
// Injuries (R2)
// ----------------------------------------------------------------------------

describe('addInjury / healInjury', () => {
    it('add is idempotent; heal restores only actually-missing parts; the field clears when empty', () => {
        const state = mkState([bare('a')]);
        expect(addInjury(state, 'a', 'left-arm')).toEqual({ part: 'left-arm', alreadyMissing: false });
        expect(state.entities[0].injuries).toEqual(['left-arm']);
        expect(addInjury(state, 'a', 'left-arm')).toEqual({ part: 'left-arm', alreadyMissing: true });
        expect(state.entities[0].injuries).toEqual(['left-arm']);
        expect(healInjury(state, 'a', 'nose')).toEqual({ part: 'nose', wasMissing: false });
        expect(healInjury(state, 'a', 'left-arm')).toEqual({ part: 'left-arm', wasMissing: true });
        expect(state.entities[0].injuries).toBeUndefined(); // additive-optional rule
        expect(() => addInjury(state, 'a', 'tail' as never)).toThrow("unknown body part: 'tail'");
    });
});

// ----------------------------------------------------------------------------
// Resource pools + costs (R3)
// ----------------------------------------------------------------------------

describe('normalizeResourceCost / canPayResourceCosts', () => {
    it('folds the energy alias to stamina and drops empty cost objects', () => {
        expect(normalizeResourceCost({ health: 2, energy: 3 } as never)).toEqual({ health: 2, stamina: 3 });
        expect(normalizeResourceCost({ stamina: 1 })).toEqual({ stamina: 1 });
        expect(normalizeResourceCost(undefined)).toBeNull();
        expect(normalizeResourceCost({})).toBeNull();
    });

    it('gates pools with ≥ and health STRICTLY above the cost (no self-kill at the gate)', () => {
        const payer = { health: 5, resources: { stamina: { current: 2, max: 5 }, mana: { current: 0, max: 5 } } };
        expect(canPayResourceCosts(payer, { health: 4 })).toBe(true);   // 5 > 4
        expect(canPayResourceCosts(payer, { health: 5 })).toBe(false);  // 5 > 5 fails
        expect(canPayResourceCosts(payer, { stamina: 2 })).toBe(true);  // 2 ≥ 2
        expect(canPayResourceCosts(payer, { stamina: 3 })).toBe(false);
        expect(canPayResourceCosts(payer, { mana: 1 })).toBe(false);    // current 0
        expect(canPayResourceCosts(payer, null)).toBe(true);
        // a legacy actor without pools can never pay pool costs
        expect(canPayResourceCosts({ health: 10 }, { stamina: 1 })).toBe(false);
    });
});

describe('payResourceCosts / modifyResourcePool', () => {
    const payer = (): CombatState =>
        mkState([createEntityState({
            id: 'a', order: 0,
            stats: { health: 10, strength: 0, speed: 1 },
            resources: { stamina: { current: 4, max: 4 }, mana: { current: 3, max: 3 } },
        })]);

    it('pays every declared component in one transactional write', () => {
        const state = payer();
        expect(payResourceCosts(state, 'a', { health: 2, stamina: 4, mana: 1 })).toEqual({ health: 2, stamina: 4, mana: 1 });
        expect(state.entities[0].health).toBe(8);
        expect(state.entities[0].resources).toEqual({ stamina: { current: 0, max: 4 }, mana: { current: 2, max: 3 } });
        expect(state.entities[0].living).toBe(true);
    });

    it('throws (fault-rollback fuel) when a payment would kill, overdraw, or miss a missing pool', () => {
        const state = payer();
        expect(() => payResourceCosts(state, 'a', { health: 10 })).toThrow('resource payment refused: health 10 cannot pay 10 (payment must leave the payer alive)');
        expect(() => payResourceCosts(state, 'a', { stamina: 5 })).toThrow('resource payment refused: stamina 4 cannot pay 5');
        expect(() => payResourceCosts(state, 'a', { mana: 4 })).toThrow('resource payment refused: mana 3 cannot pay 4');
        // nothing was written by the failed attempts
        expect(state.entities[0].health).toBe(10);
        expect(state.entities[0].resources!.stamina!.current).toBe(4);
    });

    it('modify-resource clamps into [0, max], refuses dead actors, and reports no-op changes', () => {
        const state = payer();
        expect(modifyResourcePool(state, 'a', 'stamina', 3)).toEqual({ resource: 'stamina', applied: 0, current: 4, changed: false }); // clamp at max
        expect(modifyResourcePool(state, 'a', 'stamina', -6)).toEqual({ resource: 'stamina', applied: -4, current: 0, changed: true }); // floor at 0
        expect(modifyResourcePool(state, 'a', 'mana', 2)).toEqual({ resource: 'mana', applied: 0, current: 3, changed: false }); // clamp at max
        // dead entities are never modified (damage/heal dead-entity parity)
        const dying = payer();
        dying.entities[0].living = false;
        expect(modifyResourcePool(dying, 'a', 'stamina', 5)).toEqual({ resource: 'stamina', applied: 0, current: 4, changed: false });
        // an actor without the pool is a reported no-op
        expect(modifyResourcePool(payer(), 'a', 'spirit' as never, 1)).toEqual({ resource: 'spirit', applied: 0, current: 0, changed: false });
    });
});
