// ============================================================================
// @userfiction/combat — src/engine/ailments.test.ts — T2 R1 runtime ailments
// and buffs through createSimulation (dynamic status definitions)
// ============================================================================
// Drives the REAL engine (createSimulation + the builtin floor) to pin:
//   - builtin seed behavior (bleeding tick → decay → expiry, event order);
//   - custom ailment/buff REGISTRATION via definition catalogs (not blanket
//     application — actors only carry StatusInstance references);
//   - definition-driven gating (skipChancePerStack; stacks 4 ⇒ chance 1.0);
//   - seeded modifiers visible in effective stats + snapshots, reversal on
//     removal/expiry (derived centrally — no accumulation, no stat noise);
//   - custom overrides of registered defaults and of the LEGACY trio;
//   - resistance integration on generic statuses;
//   - JSON snapshot restore bit-identity (R5).
//
// Determinism notes (all derived, then verified by running the engine):
//   - the 'deterministic' plugin replaces dodge/crit rolls (declared
//     overrides) so asserted damage is pure formula output;
//   - equal-speed duo timeline: both entries start at 1e6 µs, so turns pair
//     up — step 1/2 at t=1e6, step 3/4 at t=2e6, … (D4d tie: higher
//     effective speed, then definition order ⇒ hero always first of a pair);
//   - castOnce selector: forced ability use respects cooldowns, so 'cut'
//     (cooldown 1) fires on the hero's 1st own turn only — clean
//     single-application timelines;
//   - skip gating MUST use the DEFAULT selector (overrides bypass the
//     builtin gates by design) with a single-element pool ⇒ no selection
//     draw; chance 0.25 × 4 stacks = 1.0 makes every skip roll certain.
// ============================================================================

import { createSimulation } from '../../index';
import type { BattleDefinition, CombatPlugin, EntityDefinition } from '../../index';

// Replaces the RNG-driven dodge/crit handlers (declared overrides, D6) so
// asserted damage/outcomes are pure formula results.
const deterministic: CombatPlugin = {
    id: 'test/deterministic',
    overrides: ['attack:dodge', 'attack:crit'],
    hooks: {
        'attack:dodge': () => ({ dodged: false }),
        'attack:crit': () => ({ crit: false }),
    },
};

// Per-entity forced actions that still respect cooldowns: hero casts the
// named ability whenever it is off cooldown, otherwise attacks.
const castOnce = (heroAbility: string, cooldown: number): CombatPlugin => ({
    id: 'test/forced-actions',
    overrides: ['action:select'],
    hooks: {
        'action:select': (_view, _ctx, args) => {
            const actor = (args as { actor: { id: string; cooldowns: Record<string, number> } }).actor;
            if (actor.id !== 'hero') return { kind: 'attack' };
            if ((actor.cooldowns[heroAbility] ?? 0) > 0) return { kind: 'attack' };
            return { kind: 'ability', abilityId: heroAbility };
        },
    },
    // cooldown is declared on the ability definition; the selector only reads it
});

// Per-entity forced actions WITHOUT cooldown respect (recasts every turn).
const castAlways = (heroAbility: string): CombatPlugin => ({
    id: 'test/forced-actions',
    overrides: ['action:select'],
    hooks: {
        'action:select': (_view, _ctx, args) => {
            const actor = (args as { actor: { id: string } }).actor;
            return actor.id === 'hero' ? { kind: 'ability', abilityId: heroAbility } : { kind: 'attack' };
        },
    },
});

// Compact event shape for exact-sequence assertions.
const shape = (events: { type: string; actor?: string; target?: string; payload?: Record<string, unknown>; message?: string }[]) =>
    events.map((event) => ({ type: event.type, actor: event.actor, target: event.target, payload: event.payload, message: event.message }));

const duo = (hero: Partial<EntityDefinition> = {}, golem: Partial<EntityDefinition> = {}): EntityDefinition[] => [
    { id: 'hero', stats: { health: 20, strength: 0, speed: 1, precision: 10 }, abilities: ['cut'], ...hero },
    { id: 'golem', stats: { health: 30, strength: 0, speed: 1, precision: 10 }, ...golem },
];

const combatOf = (
    entities: EntityDefinition[],
    abilities: NonNullable<BattleDefinition['catalogs']>['abilities'],
    plugins: CombatPlugin[],
    statuses?: NonNullable<BattleDefinition['catalogs']>['statuses'],
): ReturnType<typeof createSimulation> => {
    const definition: BattleDefinition = {
        schemaVersion: 1,
        mode: 'ffa',
        entities,
        startingConditions: { seed: 7 },
    };
    definition.catalogs = { abilities };
    if (statuses) definition.catalogs.statuses = statuses;
    return createSimulation(definition, { plugins: [deterministic, ...plugins] });
};

// ----------------------------------------------------------------------------
// Builtin seed ailment — bleeding: tick 2 × stacks, duration decay
// ----------------------------------------------------------------------------

describe('builtin bleeding (registered seed consulted by the turn engine)', () => {
    it('ticks 2 damage per own turn before duration decay and expires after the final tick', () => {
        // cut (cooldown 1) applies bleeding duration 2 ONCE at step 1.
        // Equal-speed timeline: steps 1/2 at t=1e6, steps 3/4 at t=2e6.
        // step 1: hero cuts → status:applied stacks 1 duration 2.
        // step 2: golem attacks hero (1) + turn-end tick 2 (duration 2→1).
        // step 3: hero attacks (cut on cooldown 1) — golem −1.
        // step 4: golem attacks (hero −1) + tick 2 + duration 1→0 ⇒ expired.
        // Health: hero 20−1−1 = 18; golem 30−2−2−1 = 25? NO — golem takes
        // ticks only: 30 −2 −2 = 26, plus hero's step-3 attack −1 ⇒ 25.
        const combat = combatOf(
            duo(),
            [{ id: 'cut', cost: 1, cooldown: 1, effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', duration: 2 }] }],
            [castOnce('cut', 1)],
        );
        combat.run(4);
        expect(shape(combat.events())).toEqual([
            { type: 'battle:start', actor: undefined, target: undefined, payload: { seed: 7, mode: 'ffa' }, message: undefined },
            { type: 'turn:start', actor: 'hero', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'hero', target: undefined, payload: { kind: 'ability', abilityId: 'cut' }, message: undefined },
            { type: 'status:applied', actor: 'golem', target: undefined, payload: { statusId: 'bleeding', stacks: 1, potency: 1, duration: 2 }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 1_000_000 }, message: undefined },
            { type: 'turn:start', actor: 'golem', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'golem', target: undefined, payload: { kind: 'attack' }, message: undefined },
            { type: 'damage', actor: 'golem', target: 'hero', payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'status:tick', actor: 'golem', target: undefined, payload: { statusId: 'bleeding', damage: 2 }, message: undefined },
            { type: 'damage', actor: 'golem', target: 'golem', payload: { amount: 2, damageType: 'true', source: 'bleeding', mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 2, time: 1_000_000 }, message: undefined },
            { type: 'turn:start', actor: 'hero', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'hero', target: undefined, payload: { kind: 'attack' }, message: undefined },
            { type: 'damage', actor: 'hero', target: 'golem', payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 3, time: 2_000_000 }, message: undefined },
            { type: 'turn:start', actor: 'golem', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'golem', target: undefined, payload: { kind: 'attack' }, message: undefined },
            { type: 'damage', actor: 'golem', target: 'hero', payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'status:tick', actor: 'golem', target: undefined, payload: { statusId: 'bleeding', damage: 2 }, message: undefined },
            { type: 'damage', actor: 'golem', target: 'golem', payload: { amount: 2, damageType: 'true', source: 'bleeding', mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'status:expired', actor: 'golem', target: undefined, payload: { statusId: 'bleeding' }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 4, time: 2_000_000 }, message: undefined },
        ]);
        expect(combat.snapshot().state.entities.map((entity) => entity.health)).toEqual([18, 25]);
        expect(combat.snapshot().state.entities[1].statuses).toEqual([]);
    });

    it('refresh on re-application scales stacks and the tick (no accumulation of modifiers)', () => {
        // castAlways recasts cut each hero turn: step 3 re-apply ⇒ stacks
        // 1+1 = 2 (D5c refresh), duration max(1, 2) = 2 ⇒ step-4 tick 2 × 2 = 4.
        const combat = combatOf(
            duo(),
            [{ id: 'cut', effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', duration: 2 }] }],
            [castAlways('cut')],
        );
        combat.run(4);
        // after step 4's decay the refreshed instance reads stacks 2,
        // duration 1 (refresh raised duration to 2, the final turn decremented it)
        expect(combat.snapshot().state.entities[1].statuses).toEqual([
            { id: 'bleeding', stacks: 2, potency: 1, duration: 1 },
        ]);
        expect(combat.events().filter((event) => event.type === 'status:tick').map((event) => event.payload!.damage)).toEqual([2, 4]);
        // golem: 30 − 2 − 4 = 24 (hero's cut deals no direct damage)
        expect(combat.snapshot().state.entities.map((entity) => entity.health)).toEqual([18, 24]);
    });

    it('honors statusResistances on generic statuses (floored added stacks scale the tick)', () => {
        // resistance 0.5: added = floor(2 × 0.5) = 1 stack ⇒ tick 2 × 1 = 2;
        // duration 1 expires after the golem's first own-turn tick.
        const combat = combatOf(
            duo(undefined, { statusResistances: { bleeding: 0.5 } }),
            [{ id: 'cut', effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', stacks: 2, duration: 1 }] }],
            [castOnce('cut', 1)],
        );
        combat.run(2);
        expect(combat.events().filter((event) => event.type === 'status:applied')).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'status:applied', actor: 'golem', payload: { statusId: 'bleeding', stacks: 1, potency: 1, duration: 1 } },
        ]);
        expect(combat.snapshot().state.entities[1].statuses).toEqual([]);
        expect(combat.events().filter((event) => event.type === 'status:tick')).toEqual([
            { id: 9, step: 2, time: 1_000_000, type: 'status:tick', actor: 'golem', payload: { statusId: 'bleeding', damage: 2 } },
        ]);
    });
});

// ----------------------------------------------------------------------------
// Custom registration — gating, buffs, tick heals
// ----------------------------------------------------------------------------

describe('custom registered ailments/buffs (R1: definition registration, not blanket application)', () => {
    it('skipChancePerStack gating uses the DEFAULT selector; stacks 4 ⇒ chance 1.0 ⇒ guaranteed skip', () => {
        // screaming without decay (never expires): 0.25 × 4 stacks = 1.0 ⇒
        // rng.next() < 1.0 always true ⇒ hero skips EVERY turn with reason
        // 'screaming'; the roll consumes one draw per hero turn. The pool
        // pick never happens (skip returns before pool build).
        const combat = combatOf(
            duo({ statuses: [{ id: 'screaming', stacks: 4 }] }),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [],
            [{ id: 'screaming', skipChancePerStack: 0.25 }],
        );
        combat.run(3);
        // ids shift with the skip: no cut message at hero turns (skipped)
        expect(combat.events().filter((event) => event.type === 'action')).toEqual([
            { id: 3, step: 1, time: 1_000_000, type: 'action', actor: 'hero', payload: { kind: 'skip', reason: 'screaming' } },
            { id: 6, step: 2, time: 1_000_000, type: 'action', actor: 'golem', payload: { kind: 'attack' } },
            { id: 10, step: 3, time: 2_000_000, type: 'action', actor: 'hero', payload: { kind: 'skip', reason: 'screaming' } },
        ]);
        // no decay configured ⇒ stacks stay 4
        expect(combat.snapshot().state.entities[0].statuses).toEqual([{ id: 'screaming', stacks: 4, potency: 1 }]);
    });

    it("'stacks' decay loses one stack per own turn even on skipped turns", () => {
        const combat = combatOf(
            duo({ statuses: [{ id: 'screaming', stacks: 4 }] }),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [castAlways('cut')],
            [{ id: 'screaming', decay: 'stacks' }],
        );
        combat.run(3); // hero turns at steps 1 and 3: 4→3→2
        expect(combat.snapshot().state.entities[0].statuses).toEqual([{ id: 'screaming', stacks: 2, potency: 1 }]);
        // no skipChancePerStack ⇒ hero acts normally (castAlways)
        expect(combat.events().filter((event) => event.type === 'action').map((event) => event.payload!.kind)).toEqual(['ability', 'attack', 'ability']);
        // hero's cut deals no direct damage; golem hit hero once at step 2
        expect(combat.snapshot().state.entities.map((entity) => entity.health)).toEqual([19, 30]);
    });

    it('a custom buff raises effective stats, rides the snapshot, and reverses exactly on expiry', () => {
        // sharpened: +3 precision per stack, duration decay; single-element
        // hero pool (attack only) keeps ids deterministic. Hero's own turns
        // at steps 1 and 3: duration 2→1 then 1→0 ⇒ expired at step 3.
        const combat = combatOf(
            duo({ abilities: [], statuses: [{ id: 'sharpened', duration: 2 }] }),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [],
            [{ id: 'sharpened', decay: 'duration', modifiers: { precision: 3 } }],
        );
        const initial = combat.snapshot();
        expect(initial.state.entities[0].stats.precision).toBe(13);
        expect(initial.state.entities[0].statuses).toEqual([
            { id: 'sharpened', stacks: 1, potency: 1, duration: 2, modifiers: { precision: 3 } },
        ]);
        combat.run(3);
        expect(combat.snapshot().state.entities[0].stats.precision).toBe(10);
        expect(combat.snapshot().state.entities[0].statuses).toEqual([]);
        // NO stat:modified/stat:expired noise — the reversal is pure central
        // derivation (removing the instance removes the contribution)
        expect(combat.events().filter((event) => event.type.startsWith('stat:'))).toEqual([]);
        expect(combat.events().filter((event) => event.type === 'status:expired')).toEqual([
            { id: 13, step: 3, time: 2_000_000, type: 'status:expired', actor: 'hero', payload: { statusId: 'sharpened' } },
        ]);
    });

    it('a permanent buff (decay none) applies modifiers until explicitly removed', () => {
        // swift: +1 speed with no decay — hero keeps effective speed 3 until
        // cleanse removes the instance (derived speed 3 → 2).
        const combat = combatOf(
            duo({ stats: { health: 20, strength: 0, speed: 2, precision: 10 }, abilities: ['cleanse'], statuses: [{ id: 'swift' }] }),
            [{ id: 'cleanse', effects: [{ type: 'remove-status', target: 'self', status: 'swift' }] }],
            [castOnce('cleanse', 0)],
            [{ id: 'swift', decay: 'none', modifiers: { speed: 1 } }],
        );
        expect(combat.snapshot().state.entities[0].stats.speed).toBe(3);
        combat.step(); // hero casts cleanse on himself
        expect(combat.snapshot().state.entities[0].statuses).toEqual([]);
        expect(combat.snapshot().state.entities[0].stats.speed).toBe(2);
    });

    it('a heal-tick buff restores health per own turn, clamped at maxHealth', () => {
        // regenerating: permanent +3 heal per hero turn end. Health starts
        // AT max (5) — the first tick clamps to 0 applied; golem hits at
        // steps 2/4 ⇒ heals applied [0, 1, 1]; hero back at max 5.
        const combat = combatOf(
            duo({ stats: { health: 5, strength: 0, speed: 1, precision: 10 }, statuses: [{ id: 'regenerating' }] }),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [castAlways('cut')],
            [{ id: 'regenerating', decay: 'none', tick: { heal: 3 } }],
        );
        combat.run(5);
        expect(combat.events().filter((event) => event.type === 'heal').map((event) => event.payload!.amount)).toEqual([0, 1, 1]);
        expect(combat.snapshot().state.entities.map((entity) => entity.health)).toEqual([5, 30]);
    });
});

// ----------------------------------------------------------------------------
// Overrides — registered defaults and the legacy trio
// ----------------------------------------------------------------------------

describe('definition overrides (R1: custom definitions replace registered defaults predictably)', () => {
    it('a client patch of bleeding keeps the seed decay but changes the tick', () => {
        const combat = combatOf(
            duo(),
            [{ id: 'cut', cooldown: 1, effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', duration: 1 }] }],
            [castOnce('cut', 1)],
            [{ id: 'bleeding', tick: { damage: 7 } }],
        );
        combat.run(2);
        expect(combat.snapshot().state.entities[1].health).toBe(30 - 7);
        expect(combat.events().filter((event) => event.type === 'status:tick')).toEqual([
            { id: 9, step: 2, time: 1_000_000, type: 'status:tick', actor: 'golem', payload: { statusId: 'bleeding', damage: 7 } },
        ]);
    });

    it('defining the LEGACY fear id replaces the hardcoded semantics (tick + duration instead of stack decay)', () => {
        // client fear: no skip gating (no skipChancePerStack), tick 1 ×
        // stacks 2, duration decay; the hardcoded stack-decay path must NOT
        // run (stacks stay 2). Hero acts normally (castOnce: cut at step 1,
        // attack at step 3).
        const combat = combatOf(
            duo({ statuses: [{ id: 'fear', stacks: 2, duration: 2 }] }),
            [{ id: 'cut', cooldown: 1, effects: [{ type: 'emit', message: 'cut' }] }],
            [castOnce('cut', 1)],
            [{ id: 'fear', decay: 'duration', tick: { damage: 1 } }],
        );
        combat.run(2);
        expect(combat.events().filter((event) => event.type === 'action').map((event) => event.payload!.kind)).toEqual(['ability', 'attack']);
        // stacks untouched by the generic path (still 2); duration 2→1
        expect(combat.snapshot().state.entities[0].statuses).toEqual([
            { id: 'fear', stacks: 2, potency: 1, duration: 1 },
        ]);
        // hero health: 20 − 1 (golem hit step 2) − 2 (fear tick 1 × 2 stacks, step 1) = 17
        expect(combat.snapshot().state.entities[0].health).toBe(17);
        combat.run(1); // hero's 2nd own turn: tick 2 + duration 1→0 ⇒ expired
        expect(combat.snapshot().state.entities[0].statuses).toEqual([]);
        expect(combat.snapshot().state.entities[0].health).toBe(15);
        expect(combat.events().filter((event) => event.type === 'status:expired')).toEqual([
            { id: 17, step: 3, time: 2_000_000, type: 'status:expired', actor: 'hero', payload: { statusId: 'fear' } },
        ]);
    });

    it('legacy fear WITHOUT a definition keeps the exact hardcoded semantics (silent stack decay + expired event)', () => {
        const combat = combatOf(
            duo({ statuses: [{ id: 'fear', stacks: 2 }] }),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [castAlways('cut')],
        );
        combat.run(2);
        expect(combat.snapshot().state.entities[0].statuses).toEqual([{ id: 'fear', stacks: 1, potency: 1 }]);
        expect(combat.events().filter((event) => event.type === 'status:tick')).toEqual([]); // no tick without definition
        combat.run(1); // hero's 2nd own turn (step 3): stacks 1 → 0 ⇒ expired
        expect(combat.events().filter((event) => event.type === 'status:expired')).toEqual([
            { id: 13, step: 3, time: 2_000_000, type: 'status:expired', actor: 'hero', payload: { statusId: 'fear' } },
        ]);
    });
});

// ----------------------------------------------------------------------------
// Snapshot restore (R5) with T2 state riding along
// ----------------------------------------------------------------------------

describe('snapshot restore with status state (R5)', () => {
    it('JSON roundtrip restores statuses/materialized modifiers and continues bit-identically', () => {
        const setup = (): [EntityDefinition[], NonNullable<BattleDefinition['catalogs']>['abilities'], NonNullable<BattleDefinition['catalogs']>['statuses']] => [
            duo(),
            [{ id: 'cut', cooldown: 1, effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', duration: 3 }] }],
            [{ id: 'bleeding', tick: { damage: 2 }, modifiers: { strength: -1 } }],
        ];
        const [entities, abilities, statuses] = setup();
        const original = combatOf(entities, abilities, [castOnce('cut', 1)], statuses);
        original.run(2);
        const snapshot = JSON.parse(JSON.stringify(original.snapshot()));
        // materialized modifiers ride the snapshot instance (stack 1 ⇒ −1)
        expect(snapshot.state.entities[1].statuses[0].modifiers).toEqual({ strength: -1 });
        const resumed = createSimulation(
            {
                schemaVersion: 1, mode: 'ffa', entities: duo(), startingConditions: { seed: 7 },
                catalogs: { abilities, statuses },
            },
            { plugins: [deterministic, castOnce('cut', 1)], restore: snapshot },
        );
        resumed.run(2);
        original.run(2);
        expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(original.snapshot()));
        // the strength debuff is derived on restore too (stack 1 ⇒ −1)
        expect(resumed.snapshot().state.entities[1].stats.strength).toBe(-1);
    });
});

// ----------------------------------------------------------------------------
// Registration is inert without statuses on actors (R1)
// ----------------------------------------------------------------------------

describe('registration is inert without statuses on actors (R1)', () => {
    it('a registered catalog produces NO status activity while no instance exists', () => {
        const combat = combatOf(
            duo(),
            [{ id: 'cut', effects: [{ type: 'emit', message: 'cut' }] }],
            [castAlways('cut')],
            [{ id: 'plague', decay: 'duration', tick: { damage: 9 } }],
        );
        combat.run(2);
        expect(combat.events().filter((event) => event.type.startsWith('status:'))).toEqual([]);
        // the resolved definition carries the merged registry for inspection
        expect(combat.snapshot().definition.catalogs!.statuses!.map((entry) => entry.id)).toContain('plague');
    });
});
