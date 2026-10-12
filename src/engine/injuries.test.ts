// ============================================================================
// @userfiction/combat — src/engine/injuries.test.ts — T2 R2 body injuries
// through createSimulation (initial + runtime loss, derived combat effects)
// ============================================================================
// Drives the REAL engine to pin:
//   - initial `injuries` visible in snapshots with derived stat effects and
//     SCHEDULER integration (missing leg ⇒ slower readiness);
//   - the declarative apply-injury effect (idempotent, event visibility,
//     derived-speed reschedule of pending entries per D4e);
//   - heal-injury as the ONLY restore path (vague 'heal' never regrows);
//   - weapon/shield eligibility: two-handed needs both arms, any weapon
//     needs one, no arms ⇒ unarmed attacks and an inert shield (direct
//     mitigate-handler unit for the no-draw rule);
//   - NO random amputation: ordinary attacks never injure;
//   - transactional rollback for injuries (fault ⇒ body restored);
//   - snapshot restore bit-identity (R5).
// All expected values are derived from the D13 constants (INJURY_* factors,
// D4b interval math) and verified against the live engine.
// ============================================================================

import { createSimulation, defaultRules, renderEventText } from '../../index';
import type { BattleDefinition, CombatPlugin, EntityDefinition, RngStream, StateView } from '../../index';

const deterministic: CombatPlugin = {
    id: 'test/deterministic',
    overrides: ['attack:dodge', 'attack:crit'],
    hooks: {
        'attack:dodge': () => ({ dodged: false }),
        'attack:crit': () => ({ crit: false }),
    },
};

// The named actor casts the named ability when off cooldown (declared on the
// ability definition), everyone else attacks.
const caster = (actorId: string, abilityId: string, cooldown: number): CombatPlugin => ({
    id: `test/caster-${actorId}`,
    overrides: ['action:select'],
    hooks: {
        'action:select': (_view, _ctx, args) => {
            const actor = (args as { actor: { id: string; cooldowns: Record<string, number> } }).actor;
            if (actor.id !== actorId) return { kind: 'attack' };
            if ((actor.cooldowns[abilityId] ?? 0) > 0) return { kind: 'attack' };
            return { kind: 'ability', abilityId };
        },
    },
});

const duo = (hero: Partial<EntityDefinition> = {}, golem: Partial<EntityDefinition> = {}): EntityDefinition[] => [
    { id: 'hero', stats: { health: 20, strength: 0, speed: 1, precision: 10 }, ...hero },
    { id: 'golem', stats: { health: 30, strength: 0, speed: 1, precision: 10 }, ...golem },
];

const combatOf = (
    entities: EntityDefinition[],
    abilities: NonNullable<BattleDefinition['catalogs']>['abilities'],
    plugins: CombatPlugin[],
): ReturnType<typeof createSimulation> =>
    createSimulation(
        { schemaVersion: 1, mode: 'ffa', entities, startingConditions: { seed: 7 }, catalogs: { abilities } },
        { plugins: [deterministic, ...plugins] },
    );

// ----------------------------------------------------------------------------
// Initial injuries — snapshot visibility + derived stats + scheduler (R2)
// ----------------------------------------------------------------------------

describe('initial injuries (R2: snapshot + derivation + scheduler)', () => {
    it('a missing leg slows readiness: first interval 333333 µs at effective speed 3', () => {
        // speed 4 × 0.75 (one missing leg) = 3 ⇒ interval(1, 3) = 333333 µs;
        // golem speed 1 stays at 1e6. Fast hero takes the first three turns.
        const combat = combatOf(
            duo({ stats: { health: 20, strength: 0, speed: 4, precision: 10 }, injuries: ['left-leg'] }),
            [],
            [],
        );
        const initial = combat.snapshot();
        expect(initial.state.entities[0].injuries).toEqual(['left-leg']);
        expect(initial.state.entities[0].stats.speed).toBe(3);
        combat.run(4);
        expect(combat.events().filter((event) => event.type === 'turn:start').map((event) => [event.step, event.time, event.actor])).toEqual([
            [1, 333_333, 'hero'],
            [2, 666_666, 'hero'],
            [3, 999_999, 'hero'],
            [4, 1_000_000, 'golem'],
        ]);
    });

    it('missing eyes/ears derive flat precision/evasion penalties; nose has no derived effect', () => {
        const combat = combatOf(
            duo({
                stats: { health: 20, strength: 0, speed: 1, precision: 10, evasion: 5 },
                injuries: ['left-eye', 'right-ear', 'nose'],
            }),
            [],
            [],
        );
        const stats = combat.snapshot().state.entities[0].stats;
        expect(stats.precision).toBe(8);   // 10 − 2 (one missing eye)
        expect(stats.evasion).toBe(4);     // 5 − 1 (one missing ear)
        // nose rides the snapshot but contributes nothing derived
        expect(combat.snapshot().state.entities[0].injuries).toEqual(['left-eye', 'right-ear', 'nose']);
    });

    it('JSON restore keeps injuries and continues bit-identically (R5)', () => {
        const combat = combatOf(
            duo({ stats: { health: 20, strength: 0, speed: 4, precision: 10 }, injuries: ['left-leg'] }),
            [],
            [],
        );
        combat.run(2);
        const snapshot = JSON.parse(JSON.stringify(combat.snapshot()));
        expect(snapshot.state.entities[0].injuries).toEqual(['left-leg']);
        const resumed = createSimulation(
            {
                schemaVersion: 1,
                mode: 'ffa',
                entities: duo({ stats: { health: 20, strength: 0, speed: 4, precision: 10 }, injuries: ['left-leg'] }),
                startingConditions: { seed: 7 },
                catalogs: { abilities: [] },
            },
            { plugins: [deterministic], restore: snapshot },
        );
        resumed.run(2);
        combat.run(2);
        expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(combat.snapshot()));
    });
});

// ----------------------------------------------------------------------------
// Runtime injury effect — apply/heal (R2)
// ----------------------------------------------------------------------------

describe('apply-injury / heal-injury effects (R2)', () => {
    it('apply-injury is idempotent, fires one event, and reschedules the victim pending entry (D4e)', () => {
        // hero (speed 4) casts maim at t=250000: golem loses left-leg.
        // golem pending entry readyAt 1e6 > now ⇒ D4e reschedule:
        // remaining = (1e6−250000)×1/1e6 = 0.75 cost-units at eff 0.75 ⇒
        // interval(0.75, 0.75) = 1e6 ⇒ readyAt 1_250_000. The duplicate
        // apply-injury in the same cast is an idempotent no-op (one event).
        const combat = combatOf(
            duo({ stats: { health: 20, strength: 0, speed: 4, precision: 10 }, abilities: ['maim'] }),
            [{ id: 'maim', cooldown: 99, effects: [
                { type: 'apply-injury', target: 'target', part: 'left-leg' },
                { type: 'apply-injury', target: 'target', part: 'left-leg' },
            ] }],
            [caster('hero', 'maim', 99)],
        );
        combat.run(6);
        const injuries = combat.events().filter((event) => event.type === 'injury:applied');
        expect(injuries).toEqual([
            { id: 4, step: 1, time: 250_000, type: 'injury:applied', actor: 'hero', target: 'golem', payload: { part: 'left-leg' } },
        ]);
        // the renderer has a dedicated formatter for injury events
        expect(renderEventText(injuries[0], combat.snapshot())).toBe('golem loses left-leg');
        // golem's first turn lands at the RESCHEDULED 1_250_000 (not 1e6);
        // the hero's 5th entry lands exactly at 1e6 + 5×250000 = 1.25e6 —
        // the tie goes to the higher effective speed (hero, 4 vs 0.75, D4d)
        // so the slowed golem finally acts at step 6.
        expect(combat.events().filter((event) => event.type === 'turn:start').map((event) => [event.step, event.time, event.actor])).toEqual([
            [1, 250_000, 'hero'],
            [2, 500_000, 'hero'],
            [3, 750_000, 'hero'],
            [4, 1_000_000, 'hero'],
            [5, 1_250_000, 'hero'],
            [6, 1_250_000, 'golem'],
        ]);
        const golem = combat.snapshot().state.entities[1];
        expect(golem.injuries).toEqual(['left-leg']);
        expect(golem.stats.speed).toBe(0.75);
        expect(golem.health).toBe(26); // hero's four attacks (unarmed 1 each)
        expect(combat.snapshot().state.entities[0].health).toBe(19); // golem's step-6 hit
    });

    it('vague heal does NOT regrow; heal-injury is the only coherent restore', () => {
        // golem STARTS missing left-leg; hero casts mend: [heal 5 (no regrow),
        // heal-injury left-leg (restores)]. One cast, ordered effects.
        const combat = combatOf(
            duo(
                { stats: { health: 20, strength: 0, speed: 4, precision: 10 }, abilities: ['mend'] },
                { injuries: ['left-leg'] },
            ),
            [{ id: 'mend', cooldown: 99, effects: [
                { type: 'heal', target: 'target', amount: 5 },
                { type: 'heal-injury', target: 'target', part: 'left-leg' },
            ] }],
            [caster('hero', 'mend', 99)],
        );
        combat.step(); // hero casts mend at t=250000
        expect(combat.snapshot().state.entities[1].injuries).toBeUndefined();
        expect(combat.snapshot().state.entities[1].stats.speed).toBe(1); // fully restored
        expect(combat.snapshot().state.entities[1].health).toBe(30);     // heal clamped at max
        const events = combat.events().filter((event) => event.type === 'heal' || event.type === 'injury:healed');
        expect(events.map((event) => event.type)).toEqual(['heal', 'injury:healed']);
        expect(events[1]).toEqual({ id: 5, step: 1, time: 250_000, type: 'injury:healed', actor: 'hero', target: 'golem', payload: { part: 'left-leg' } });
        expect(renderEventText(events[1], combat.snapshot())).toBe('golem recovers left-leg');
    });
});

// ----------------------------------------------------------------------------
// Weapon/shield eligibility (R2)
// ----------------------------------------------------------------------------

describe('missing arms and weapon eligibility (R2)', () => {
    it('a two-handed weapon goes INERT (not dropped) after an arm loss: next attack is unarmed', () => {
        // step 1: hero (first by order) attacks with great-axe ⇒ 8 sharp.
        // step 2: golem casts sever ⇒ hero loses right-arm (arms do NOT
        //   affect derived speed — only legs do — so the hero's pending
        //   entry at 2e6 is untouched).
        // step 3: hero attacks — great-axe needs TWO arms ⇒ inert ⇒
        //   unarmed 1 blunt; the axe REMAINS equipped.
        const combat = combatOf(
            duo(
                { stats: { health: 20, strength: 0, speed: 1, precision: 10 }, equipment: { weapons: [{ id: 'great-axe', slot: 'weapon-1' }] } },
                { abilities: ['sever'] },
            ),
            [{ id: 'sever', cooldown: 99, effects: [{ type: 'apply-injury', target: 'target', part: 'right-arm' }] }],
            [caster('golem', 'sever', 99)],
        );
        combat.run(3);
        expect(combat.events().filter((event) => event.type === 'damage').map((event) => [event.actor, event.payload!.amount, event.payload!.source])).toEqual([
            ['hero', 8, 'weapon'],
            ['hero', 1, 'unarmed'],
        ]);
        const hero = combat.snapshot().state.entities[0];
        expect(hero.injuries).toEqual(['right-arm']);
        expect(hero.equipment).toEqual([{ gearId: 'great-axe', slot: 'weapon-1', durability: 9 }]);
        // no derived-speed change (arms ≠ legs) ⇒ hero's next turn stays at 2e6
        expect(combat.events().filter((event) => event.type === 'turn:start').map((event) => event.time)).toEqual([
            1_000_000, 1_000_000, 2_000_000,
        ]);
    });

    it('with NO arms even a one-handed weapon is inert (direct mitigate unit: a shield consumes NO block draw)', () => {
        // The load-time validator rejects hand-held gear on an armless actor
        // (status-catalog.test.ts); RUNTIME losses make gear inert instead.
        // damage:mitigate is invoked directly here (rules.test.ts harness
        // style) to pin the no-draw rule exactly.
        const mitigate = defaultRules().hooks!['damage:mitigate'] as (view: StateView, ctx: unknown, args: unknown) => unknown;
        const recorder = { draws: 0 };
        const rng: RngStream = { next: () => (recorder.draws += 1, 0), int: () => 0, pick: (list) => list[0] };
        const ctx = { rng, emit: () => undefined, step: 0, time: 0, hook: 'damage:mitigate', depth: 0, refs: {} };
        const view: StateView = { mode: 'ffa', step: 0, time: 0, entities: [] };

        // armless defender with a buckler: NO block roll, NO draw, plain armour factor
        const armless = { id: 'd', name: 'd', order: 0, living: true, health: 10, maxHealth: 10, stats: { health: 10, strength: 0, speed: 1, defense: 0, precision: 0, evasion: 0 }, statuses: [], injuries: ['left-arm', 'right-arm'], equipment: [{ gearId: 'buckler', slot: 'shield', durability: 6 }], cooldowns: {} };
        const result = mitigate(view, ctx, { attacker: undefined, target: armless, amount: 10, damageType: 'blunt' }) as { amount: number; blocked: boolean; armourFactor: number };
        expect(result).toEqual({ amount: Math.max(1, Math.round(10 * 0.9)), blocked: false, armourFactor: 0.9, defenseFactor: 1 });
        expect(recorder.draws).toBe(0);

        // the SAME defender WITH arms: the block roll consumes exactly one draw
        // (scripted draw 0 < 0.15 ⇒ blocked)
        recorder.draws = 0;
        const armed = { ...armless, injuries: undefined };
        const blockedResult = mitigate(view, ctx, { attacker: undefined, target: armed, amount: 10, damageType: 'blunt' }) as { amount: number; blocked: boolean };
        expect(blockedResult.blocked).toBe(true);
        expect(recorder.draws).toBe(1);
    });

    it('ordinary attacks NEVER amputate: a long unarmed duel produces zero injury events (R2 default)', () => {
        const combat = combatOf(duo(), [], []);
        combat.run(12);
        expect(combat.events().filter((event) => event.type.startsWith('injury:'))).toEqual([]);
        expect(combat.snapshot().state.entities.map((entity) => entity.injuries)).toEqual([undefined, undefined]);
    });
});

// ----------------------------------------------------------------------------
// Transactional rollback (R5): an injury inside a faulting step reverts
// ----------------------------------------------------------------------------

describe('injury rollback inside the transaction (R5)', () => {
    it('a fault after apply-injury restores the body exactly (no partial amputation survives)', () => {
        // maim applies the injury, then the registered vocab effect explodes;
        // the D7 transaction rolls the whole step back — the golem keeps
        // both arms, the injury event is removed, and the battle terminates
        // with a fault outcome. NOTE the namespaced vocab id 'test/vocab/explode'
        // (plugin id + short name, ids.ts namespaced()).
        const exploder: CombatPlugin = {
            id: 'test/vocab',
            vocab: { effects: { explode: () => { throw new Error('boom'); } } },
        };
        const combat = combatOf(
            duo({ stats: { health: 20, strength: 0, speed: 4, precision: 10 }, abilities: ['maim'] }),
            [{ id: 'maim', cooldown: 99, effects: [
                { type: 'apply-injury', target: 'target', part: 'left-leg' },
                { type: 'test/vocab/explode' },
            ] }],
            [caster('hero', 'maim', 99), exploder],
        );
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'boom' });
        expect(combat.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect(combat.snapshot().state.entities[1].injuries).toBeUndefined();
        expect(combat.snapshot().state.entities[1].stats.speed).toBe(1);
    });
});
