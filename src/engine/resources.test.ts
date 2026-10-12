// ============================================================================
// @userfiction/combat — src/engine/resources.test.ts — T2 R3 resource pools
// and skill costs through createSimulation
// ============================================================================
// Drives the REAL engine to pin:
//   - pool payment on actual execution (single resource:spent event with the
//     normalized costs, pools updated in the snapshot);
//   - affordability gating in the DEFAULT selector: unaffordable abilities
//     are excluded from the pool (fallback ladder → attack; legacy actors
//     without pools can never pay pool costs);
//   - plugin-selected recheck: an unaffordable FORCED ability is a contract
//     fault with full transactional rollback (R5);
//   - health costs spend EXISTING health and can never self-kill (strictly
//     health > cost at the gate AND at payment);
//   - combined health+stamina+mana payments in one transactional write;
//   - the energy alias normalized on BOTH the seed and the cost input;
//   - modify-resource as the only restore/spend path (no regeneration);
//   - payment rollback on fault; snapshot restore bit-identity.
// Determinism: dodge/crit replaced by declared overrides; forced selectors
// bypass the default pool by design (that IS the plugin recheck case).
// ============================================================================

import { createSimulation, renderEventText } from '../../index';
import type { BattleDefinition, CombatPlugin, EntityDefinition, RngStream, StateView } from '../../index';

const deterministic: CombatPlugin = {
    id: 'test/deterministic',
    overrides: ['attack:dodge', 'attack:crit'],
    hooks: {
        'attack:dodge': () => ({ dodged: false }),
        'attack:crit': () => ({ crit: false }),
    },
};

// Always returns the named ability (the plugin-recheck path — no gate).
const forcedAbility = (abilityId: string): CombatPlugin => ({
    id: 'test/forced',
    overrides: ['action:select'],
    hooks: {
        'action:select': () => ({ kind: 'ability', abilityId }),
    },
});

// Named hero ability when off cooldown, attack otherwise; golem attacks.
const castOnce = (abilityId: string, cooldown: number): CombatPlugin => ({
    id: 'test/cast-once',
    overrides: ['action:select'],
    hooks: {
        'action:select': (_view, _ctx, args) => {
            const actor = (args as { actor: { id: string; cooldowns: Record<string, number> } }).actor;
            if (actor.id !== 'hero') return { kind: 'attack' };
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
// Payment on execution (R3)
// ----------------------------------------------------------------------------

describe('resource costs paid on actual execution (R3)', () => {
    it('a stamina cost is paid once, inside the step, before the effects run', () => {
        // flurry costs stamina 2: pools 5/5 → 3/5; the payment event lands
        // between the action event and the effects' own events.
        const combat = combatOf(
            duo({ resources: { stamina: { current: 5, max: 5 } } }),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 2 } }],
            [castOnce('flurry', 0)],
        );
        // castOnce ignores cooldown when it is 0 — but the ability is cast
        // EVERY hero turn; cooldown 9 keeps the timeline single-cast
        const definition = combat.snapshot().definition; // sanity: resolved
        expect(definition.catalogs!.abilities![0].id).toBe('flurry');
        combat.run(1);
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 3, max: 5 } });
        const spent = combat.events().filter((event) => event.type === 'resource:spent');
        expect(spent).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'resource:spent', actor: 'hero', payload: { costs: { stamina: 2 } } },
        ]);
        expect(renderEventText(spent[0], combat.snapshot())).toBe('hero spends 2 stamina');
    });

    it('a combined health+stamina+mana cost pays every component in one write', () => {
        const combat = combatOf(
            duo({ resources: { stamina: { current: 4, max: 4 }, mana: { current: 3, max: 3 } } }),
            [{ id: 'blood-ritual', effects: [{ type: 'emit', message: 'ritual' }], costs: { health: 2, stamina: 1, mana: 1 } }],
            [forcedAbility('blood-ritual')],
        );
        combat.run(1);
        expect(combat.snapshot().state.entities[0].health).toBe(18);   // 20 − 2
        expect(combat.snapshot().state.entities[0].living).toBe(true); // 18 > 0
        expect(combat.snapshot().state.entities[0].resources).toEqual({
            stamina: { current: 3, max: 4 },
            mana: { current: 2, max: 3 },
        });
        expect(combat.events().filter((event) => event.type === 'resource:spent')).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'resource:spent', actor: 'hero', payload: { costs: { health: 2, stamina: 1, mana: 1 } } },
        ]);
    });

    it('the energy alias normalizes on BOTH the seed and the cost input (no second pool ever exists)', () => {
        const combat = combatOf(
            duo({ resources: { energy: { current: 4, max: 4 } } }),
            [{ id: 'dash', effects: [{ type: 'emit', message: 'dashed' }], costs: { energy: 2 } }],
            [castOnce('dash', 99)],
        );
        // the resolved definition carries the NORMALIZED forms
        expect(combat.snapshot().definition.catalogs!.abilities![0].costs).toEqual({ stamina: 2 });
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 4, max: 4 } });
        combat.run(1);
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 2, max: 4 } });
        expect(combat.events().filter((event) => event.type === 'resource:spent')).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'resource:spent', actor: 'hero', payload: { costs: { stamina: 2 } } },
        ]);
    });
});

// ----------------------------------------------------------------------------
// Affordability gating + plugin recheck (R3)
// ----------------------------------------------------------------------------

describe('affordability gating and plugin recheck (R3)', () => {
    it('an unaffordable ability is EXCLUDED from the default pool: the ladder falls back to attack', () => {
        // stamina 1 < cost 2 ⇒ flurry never enters the pool ⇒ single-element
        // [attack] selects directly (no draw). No payment, pools untouched.
        const combat = combatOf(
            duo({ resources: { stamina: { current: 1, max: 5 } } }),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 2 } }],
            [],
        );
        combat.run(2);
        expect(combat.events().filter((event) => event.type === 'action').map((event) => event.payload!.kind)).toEqual(['attack', 'attack']);
        expect(combat.events().filter((event) => event.type === 'resource:spent')).toEqual([]);
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 1, max: 5 } });
    });

    it('a LEGACY actor (no pools) can never pay pool costs: the ability is excluded', () => {
        const combat = combatOf(
            duo(),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 1 } }],
            [],
        );
        combat.run(1);
        expect(combat.events().filter((event) => event.type === 'action').map((event) => event.payload!.kind)).toEqual(['attack']);
        expect(combat.snapshot().state.entities[0].resources).toBeUndefined(); // defaults: no pools at all
    });

    it('a PLUGIN-forced unaffordable ability is a contract fault with full rollback (R5)', () => {
        const combat = combatOf(
            duo({ resources: { stamina: { current: 1, max: 5 } } }),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 2 } }],
            [forcedAbility('flurry')],
        );
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: "ability 'flurry' cannot be paid: insufficient resources" });
        expect(combat.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        // transactional rollback: the pool was never touched
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 1, max: 5 } });
    });
});

// ----------------------------------------------------------------------------
// Health costs (R3: existing health, never self-killing)
// ----------------------------------------------------------------------------

describe('health costs spend existing health (R3)', () => {
    it('a health cost equal to current health is NOT affordable (no self-kill) and a forced pick faults', () => {
        // default pool: sacrifice excluded (5 > 5 fails) ⇒ attack
        const defaultPool = combatOf(
            duo({ stats: { health: 5, strength: 0, speed: 1, precision: 10 } }),
            [{ id: 'sacrifice', effects: [{ type: 'emit', message: 'gone' }], costs: { health: 5 } }],
            [],
        );
        defaultPool.run(1);
        expect(defaultPool.events().filter((event) => event.type === 'action').map((event) => event.payload!.kind)).toEqual(['attack']);

        // plugin-forced: the engine recheck faults BEFORE any payment
        const forced = combatOf(
            duo({ stats: { health: 5, strength: 0, speed: 1, precision: 10 } }),
            [{ id: 'sacrifice', effects: [{ type: 'emit', message: 'gone' }], costs: { health: 5 } }],
            [forcedAbility('sacrifice')],
        );
        forced.step();
        expect(forced.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: "ability 'sacrifice' cannot be paid: insufficient resources" });
        expect(forced.snapshot().state.entities[0].health).toBe(5);
    });

    it('an affordable health cost leaves the payer alive and pays exactly', () => {
        const combat = combatOf(
            duo({ stats: { health: 5, strength: 0, speed: 1, precision: 10 } }),
            [{ id: 'sacrifice', effects: [{ type: 'emit', message: 'paid' }], costs: { health: 2 } }],
            [forcedAbility('sacrifice')],
        );
        combat.run(1);
        expect(combat.snapshot().state.entities[0].health).toBe(3);
        expect(combat.snapshot().state.entities[0].living).toBe(true);
        expect(combat.events().filter((event) => event.type === 'resource:spent')).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'resource:spent', actor: 'hero', payload: { costs: { health: 2 } } },
        ]);
    });
});

// ----------------------------------------------------------------------------
// modify-resource — the explicit restore/spend path (R3)
// ----------------------------------------------------------------------------

describe('modify-resource effect (R3: restore/spend, no regeneration)', () => {
    it('restores clamped at max and drains floored at 0, with visibility events', () => {
        // fortify: +2 (2 → 4, at max) then −9 (4 → 0, floored)
        const combat = combatOf(
            duo({ resources: { stamina: { current: 2, max: 4 } } }),
            [{ id: 'fortify', cooldown: 99, effects: [
                { type: 'modify-resource', target: 'self', resource: 'stamina', amount: 2 },
                { type: 'modify-resource', target: 'self', resource: 'stamina', amount: -9 },
            ] }],
            [castOnce('fortify', 99)],
        );
        combat.run(1);
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 0, max: 4 } });
        const modified = combat.events().filter((event) => event.type === 'resource:modified');
        expect(modified).toEqual([
            { id: 4, step: 1, time: 1_000_000, type: 'resource:modified', actor: 'hero', target: 'hero', payload: { resource: 'stamina', amount: 2, current: 4 } },
            { id: 5, step: 1, time: 1_000_000, type: 'resource:modified', actor: 'hero', target: 'hero', payload: { resource: 'stamina', amount: -4, current: 0 } },
        ]);
        expect(renderEventText(modified[0], combat.snapshot())).toBe('hero restores 2 stamina (4 left)');
        expect(renderEventText(modified[1], combat.snapshot())).toBe('hero drains 4 stamina (0 left)');
    });

    it('pools NEVER regenerate on their own (R3): ten plain attack steps keep stamina frozen', () => {
        const combat = combatOf(
            duo({ resources: { stamina: { current: 5, max: 5 }, mana: { current: 2, max: 2 } } }),
            [],
            [],
        );
        combat.run(10);
        expect(combat.snapshot().state.entities[0].resources).toEqual({
            stamina: { current: 5, max: 5 },
            mana: { current: 2, max: 2 },
        });
        expect(combat.events().filter((event) => event.type.startsWith('resource:'))).toEqual([]);
    });
});

// ----------------------------------------------------------------------------
// Transactional rollback + restore (R5)
// ----------------------------------------------------------------------------

describe('payment rollback and snapshot restore (R5)', () => {
    it('a fault AFTER payment restores the pools exactly (no partial spend survives)', () => {
        const exploder: CombatPlugin = {
            id: 'test/vocab',
            vocab: { effects: { explode: () => { throw new Error('boom'); } } },
        };
        const combat = combatOf(
            duo({ resources: { stamina: { current: 5, max: 5 } } }),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }, { type: 'test/vocab/explode' }], costs: { stamina: 2 } }],
            [castOnce('flurry', 99), exploder],
        );
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'boom' });
        expect(combat.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect(combat.snapshot().state.entities[0].resources).toEqual({ stamina: { current: 5, max: 5 } });
    });

    it('pools ride snapshots and restore continues bit-identically', () => {
        const setup = (): [EntityDefinition[], NonNullable<BattleDefinition['catalogs']>['abilities']] => [
            duo({ resources: { stamina: { current: 5, max: 5 } } }),
            [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 2 } }],
        ];
        const [entities, abilities] = setup();
        const original = combatOf(entities, abilities, [castOnce('flurry', 99)]);
        original.run(2);
        const snapshot = JSON.parse(JSON.stringify(original.snapshot()));
        expect(snapshot.state.entities[0].resources).toEqual({ stamina: { current: 3, max: 5 } });
        const resumed = createSimulation(
            {
                schemaVersion: 1, mode: 'ffa', entities: duo({ resources: { stamina: { current: 5, max: 5 } } }),
                startingConditions: { seed: 7 },
                catalogs: { abilities: [{ id: 'flurry', effects: [{ type: 'emit', message: 'flurried' }], costs: { stamina: 2 } }] },
            },
            { plugins: [deterministic, castOnce('flurry', 99)], restore: snapshot },
        );
        resumed.run(2);
        original.run(2);
        expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(original.snapshot()));
    });
});

// ----------------------------------------------------------------------------
// Engine-level validation of costs (D2 fail-fast)
// ----------------------------------------------------------------------------

describe('engine validation rejects malformed costs (D2)', () => {
    it('a negative cost fails construction with the exact collected error', () => {
        let thrown: unknown;
        try {
            combatOf(
                duo({ resources: { stamina: { current: 5, max: 5 } } }),
                [{ id: 'flurry', effects: [], costs: { stamina: -1 } }],
                [],
            );
        } catch (error) {
            thrown = error;
        }
        expect((thrown as { errors: string[] }).errors).toEqual([
            'catalogs.abilities[0].costs.stamina: must be a finite number between 0 and 1000000',
        ]);
    });
});

// The RngStream/StateView imports document the harness shape parity with
// injuries.test.ts (direct-handler style) without unused-value noise.
export type { RngStream, StateView };
