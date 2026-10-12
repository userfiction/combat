// ============================================================================
// @userfiction/combat — src/engine/userCombat.test.ts — T6 facade tests
// ============================================================================
// The facade suite imports ONLY the root package entry ('../../index'), pinning
// the R4 contract that every supported type/function resolves from the public
// barrel (root index.ts → src/index.ts → engine/userCombat.ts).
//
// Deterministic standard: every assertion is an exact value derived from the
// engine's own contracts (D5 formulas in rules.ts, D6 override semantics,
// D7 fault rollback, D13 bounds). Where RNG could flip an outcome, the
// 'deterministic' plugin replaces the roll-driven single-mode handlers
// (attack:dodge / attack:crit) — declared overrides, so no roll can change an
// asserted value; target:select in a 1v1 pool consumes a draw but its VALUE
// cannot change the pick. Derivations are commented inline at each pin.
// ============================================================================

import {
    CombatPluginError,
    CombatValidationError,
    createSimulation,
    createUserCombat,
    userCombat,
} from '../../index';
import type { CombatPlugin, EntityDefinition, GearDefinition } from '../../index';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

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

const quadActors = (): EntityDefinition[] => [
    { id: 'fast', stats: { health: 200, strength: 0, speed: 4, precision: 10 } },
    { id: 'slow', stats: { health: 200, strength: 0, speed: 1, precision: 10 } },
];

const tanks = (): EntityDefinition[] => [
    { id: 'a', stats: { health: 100_000, strength: 0, speed: 1 } },
    { id: 'b', stats: { health: 100_000, strength: 0, speed: 1 } },
];

const warhammer: GearDefinition = { id: 'warhammer', name: 'Warhammer', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'blunt', damage: 9, blunt: 0, sharp: 0, durability: 50 };
const mailShirt: GearDefinition = { id: 'mail-shirt', name: 'Mail Shirt', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.3, sharp: 0.2, durability: 50 };
const mace: GearDefinition = { id: 'mace', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'blunt', damage: 5, blunt: 0, sharp: 0, durability: 10 };
const vest: GearDefinition = { id: 'vest', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.2, sharp: 0.1, durability: 10 };

// Compact event shape for exact-sequence assertions (message field included;
// undefined fields compare equal to absent under toEqual).
const shape = (events: { type: string; actor?: string; target?: string; payload?: Record<string, unknown>; message?: string }[]) =>
    events.map((event) => ({ type: event.type, actor: event.actor, target: event.target, payload: event.payload, message: event.message }));

// Capture a rejection (or fail loudly on unexpected resolution).
const caught = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(() => {
        throw new Error('expected rejection');
    }, (error: unknown) => error);

// ----------------------------------------------------------------------------
// Chaining (R2)
// ----------------------------------------------------------------------------

describe('userCombat chaining (R2)', () => {
    it('every setter returns the same instance so configuration chains', () => {
        const combat = createUserCombat();
        expect(combat.actors([])).toBe(combat);
        expect(combat.equipments([])).toBe(combat);
        expect(combat.abilities([])).toBe(combat);
        expect(combat.mode('ffa')).toBe(combat);
        expect(combat.teams([])).toBe(combat);
        expect(combat.config({})).toBe(combat);
        expect(combat.seed(1)).toBe(combat);
        expect(combat.plugins([])).toBe(combat);
        expect(combat.builtinRules(true)).toBe(combat);
    });
});

// ----------------------------------------------------------------------------
// Equipment consumption through the facade (R2/R3)
// ----------------------------------------------------------------------------

describe('equipments feed the gear catalog consumed by actor loadouts', () => {
    it('catalog weapon damage and armour resistance land in the first step exactly', async () => {
        const combat = createUserCombat()
            .equipments([warhammer, mailShirt])
            .actors([
                { id: 'attacker', name: 'Attacker', stats: { health: 50, strength: 0, speed: 2, precision: 10 }, equipment: { weapons: [{ id: 'warhammer', slot: 'weapon-1', durability: 30 }] } },
                { id: 'defender', name: 'Defender', stats: { health: 50, strength: 0, speed: 1, precision: 10 }, equipment: { armour: [{ id: 'mail-shirt', slot: 'body' }] } },
            ])
            .plugins([deterministic])
            .seed(7);

        const snapshot = await combat.simulate();
        expect(snapshot.state.step).toBe(1);
        expect(snapshot.state.virtualTime).toBe(500_000);
        // fast actor first (speed 2 ⇒ readyAt 500_000 µs); hit:
        // base 9 (warhammer × strength 0) × armourFactor 0.7 (blunt 0.3)
        // = 6.3 ⇒ round 6 (D5a.8 single rounding point)
        expect(snapshot.state.entities.map((entity) => entity.health)).toEqual([50, 44]);
        // durability override on the GearRef (30 ⇒ 29) vs catalog value (50 ⇒ 49)
        expect(snapshot.state.entities[0].equipment).toEqual([{ gearId: 'warhammer', slot: 'weapon-1', durability: 29 }]);
        expect(snapshot.state.entities[1].equipment).toEqual([{ gearId: 'mail-shirt', slot: 'body', durability: 49 }]);
        expect(shape(snapshot.events)).toEqual([
            { type: 'battle:start', actor: undefined, target: undefined, payload: { seed: 7, mode: 'ffa' }, message: undefined },
            { type: 'turn:start', actor: 'attacker', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'attacker', target: undefined, payload: { kind: 'attack' }, message: undefined },
            { type: 'damage', actor: 'attacker', target: 'defender', payload: { amount: 6, damageType: 'blunt', source: 'weapon', weaponId: 'warhammer', crit: false, mitigations: { blocked: false, armourFactor: 0.7, defenseFactor: 1 } }, message: undefined },
            { type: 'gear:damaged', actor: 'attacker', target: undefined, payload: { gearId: 'warhammer', slot: 'weapon-1', durability: 29 }, message: undefined },
            { type: 'gear:damaged', actor: 'defender', target: undefined, payload: { gearId: 'mail-shirt', slot: 'body', durability: 49 }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 500_000 }, message: undefined },
        ]);
    });
});

// ----------------------------------------------------------------------------
// Abilities through the facade (R2)
// ----------------------------------------------------------------------------

describe('abilities feed the ability catalog consumed by actor loadouts', () => {
    it('a forced ability action executes the catalog effects exactly', async () => {
        // default action:select pools attack + ability (rng.pick) — the
        // override pins the ability choice; ability:execute runs the effects.
        const useShove: CombatPlugin = {
            id: 'test/use-shove',
            overrides: ['action:select'],
            hooks: { 'action:select': () => ({ kind: 'ability', abilityId: 'shove' }) },
        };
        const combat = createUserCombat()
            .abilities([{ id: 'shove', name: 'Shove', effects: [{ type: 'emit', message: 'shoved' }] }])
            .actors([
                { id: 'pusher', stats: { health: 10, strength: 0, speed: 2 }, abilities: ['shove'] },
                { id: 'victim', stats: { health: 10, strength: 0, speed: 1 } },
            ])
            .plugins([useShove])
            .seed(3);

        const snapshot = await combat.simulate();
        expect(snapshot.state.step).toBe(1);
        expect(shape(snapshot.events)).toEqual([
            { type: 'battle:start', actor: undefined, target: undefined, payload: { seed: 3, mode: 'ffa' }, message: undefined },
            { type: 'turn:start', actor: 'pusher', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'pusher', target: undefined, payload: { kind: 'ability', abilityId: 'shove' }, message: undefined },
            // D8 'emit' effect ⇒ pipeline type 'message'; message rides the event field
            { type: 'message', actor: 'pusher', target: undefined, payload: undefined, message: 'shoved' },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 500_000 }, message: undefined },
        ]);
    });
});

// ----------------------------------------------------------------------------
// Single-step async behavior (R3)
// ----------------------------------------------------------------------------

describe('simulate advances exactly ONE engine step per await (R3)', () => {
    it('step/virtualTime advance by one scheduled turn and match createSimulation bit-for-bit', async () => {
        const actors = quadActors();
        const facade = createUserCombat().actors(actors).seed(7);
        // direct engine with the SAME definition the facade assembles
        // (schemaVersion + mode 'ffa' default + entities + seed only)
        const direct = createSimulation({ schemaVersion: 1, mode: 'ffa', entities: actors, startingConditions: { seed: 7 } });

        const first = await facade.simulate();
        expect(first.state.step).toBe(1);
        expect(first.state.virtualTime).toBe(250_000);
        direct.step();
        expect(JSON.stringify(facade.snapshot())).toBe(JSON.stringify(direct.snapshot()));

        await facade.simulate();
        await facade.simulate();
        direct.step();
        direct.step();
        expect(JSON.stringify(facade.snapshot())).toBe(JSON.stringify(direct.snapshot()));
        expect(facade.snapshot().state.step).toBe(3);
        expect(facade.snapshot().state.virtualTime).toBe(750_000);
        // 4× speed acceptance rows (D4c): fast attacks at 250k/500k/750k µs
        expect(facade.snapshot().events.filter((event) => event.type === 'turn:start').map((event) => [event.step, event.time, event.actor])).toEqual([
            [1, 250_000, 'fast'],
            [2, 500_000, 'fast'],
            [3, 750_000, 'fast'],
        ]);
    });
});

// ----------------------------------------------------------------------------
// Config merging + engine default preservation (R2)
// ----------------------------------------------------------------------------

describe('config merges overrides and preserves engine defaults', () => {
    it('set keys ride the definition; unset keys stay absent so defaults hold', async () => {
        const combat = createUserCombat()
            .actors(tanks())
            .config({ maxSteps: 3 })
            .seed(1);

        const initial = combat.snapshot();
        expect(initial.state.step).toBe(0);
        expect(initial.definition.startingConditions).toEqual({ seed: 1, config: { maxSteps: 3 } });

        // the overridden maxSteps is honored BY THE ENGINE'S DEFAULT decide
        // floor (its step-limit verdict proves the builtin rules stayed active)
        await combat.simulate();
        await combat.simulate();
        await combat.simulate();
        expect(combat.isTerminal()).toBe(true);
        expect(combat.outcome()).toEqual({ outcome: 'undecided', reason: 'step-limit', step: 3 });

        // merging: additional keys join the accumulated config (later keys win)
        combat.config({ maxCascade: 4, maxLogEvents: 7 });
        const rebuilt = combat.snapshot();
        expect(rebuilt.definition.startingConditions).toEqual({ seed: 1, config: { maxSteps: 3, maxCascade: 4, maxLogEvents: 7 } });
        // invalidation: the rebuild discarded the finished battle
        expect(rebuilt.state.step).toBe(0);
        expect(combat.isTerminal()).toBe(false);
    });

    it('a maxCascade override faults the step exactly like the engine (D4f rollback)', async () => {
        const combat = createUserCombat()
            .equipments([mace, vest])
            .actors([
                { id: 'a', stats: { health: 100_000, strength: 0, speed: 1, precision: 10 }, equipment: { weapons: [{ id: 'mace', slot: 'weapon-1' }] } },
                { id: 'b', stats: { health: 100_000, strength: 0, speed: 1, precision: 10 }, equipment: { armour: [{ id: 'vest', slot: 'body' }] } },
            ])
            .plugins([deterministic])
            .config({ maxCascade: 4 })
            .seed(1);

        await combat.simulate();
        // step 1 emits turn:start, action, damage, gear:damaged(weapon) and
        // then exceeds the cap on the 5th emit (armour contributor wear):
        // rollback removes the step events; fault + outcome remain.
        expect(combat.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'maxCascade exceeded: more than 4 events in one step' });
        expect(combat.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        const snapshot = combat.snapshot();
        expect(snapshot.state.step).toBe(0);
        expect(snapshot.state.entities.map((entity) => entity.health)).toEqual([100_000, 100_000]);
        // reconfiguration clears the terminal: the next access rebuilds fresh
        combat.seed(2);
        expect(combat.isTerminal()).toBe(false);
    });
});

// ----------------------------------------------------------------------------
// Terminal idempotence (R3)
// ----------------------------------------------------------------------------

describe('simulate at terminal is idempotent (R3/D5g)', () => {
    it('awaiting simulate returns the current snapshot unchanged and emits nothing', async () => {
        const combat = createUserCombat()
            .actors([
                // unarmed 6 = 1 × (1 + 0.05 × 100); b (health 1) dies on hit 1
                { id: 'a', stats: { health: 5, strength: 100, speed: 1 } },
                { id: 'b', stats: { health: 1, strength: 0, speed: 1 } },
            ])
            .plugins([deterministic])
            .seed(2);

        const first = await combat.simulate();
        expect(combat.isTerminal()).toBe(true);
        expect(combat.outcome()).toEqual({ outcome: 'victory', winner: 'a', step: 1 });
        expect(first.state.entities.map((entity) => entity.health)).toEqual([5, 0]);
        expect(shape(first.events)).toEqual([
            { type: 'battle:start', actor: undefined, target: undefined, payload: { seed: 2, mode: 'ffa' }, message: undefined },
            { type: 'turn:start', actor: 'a', target: undefined, payload: undefined, message: undefined },
            { type: 'action', actor: 'a', target: undefined, payload: { kind: 'attack' }, message: undefined },
            { type: 'damage', actor: 'a', target: 'b', payload: { amount: 6, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } }, message: undefined },
            { type: 'death', actor: 'b', target: undefined, payload: { killerId: 'a' }, message: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 1_000_000 }, message: undefined },
            { type: 'outcome', actor: undefined, target: undefined, payload: { outcome: 'victory', winner: 'a' }, message: undefined },
        ]);

        const terminal = combat.snapshot();
        const again = await combat.simulate();
        expect(again).toEqual(terminal);
        expect(combat.events()).toHaveLength(7);
        expect(combat.outcome()).toEqual({ outcome: 'victory', winner: 'a', step: 1 });
    });
});

// ----------------------------------------------------------------------------
// Reconfiguration + reset lifecycle (R2)
// ----------------------------------------------------------------------------

describe('reconfiguration rebuilds deterministically; reset rewinds (R2)', () => {
    it('a setter discards prior progress; the next simulate starts the rebuilt battle at step 1', async () => {
        const actors = quadActors();
        const combat = createUserCombat().actors(actors).seed(7);
        await combat.simulate();
        await combat.simulate();
        expect(combat.snapshot().state.step).toBe(2);

        combat.seed(8);
        const rebuilt = await combat.simulate();
        expect(rebuilt.state.step).toBe(1);
        expect(rebuilt.state.virtualTime).toBe(250_000);
        expect(rebuilt.events.map((event) => event.type)).toEqual(['battle:start', 'turn:start', 'action', 'damage', 'step:end']);
        // deterministic rebuild: bit-identical to a fresh builder + one step
        const fresh = await createUserCombat().actors(actors).seed(8).simulate();
        expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(fresh));
    });

    it('reset rewinds the current battle and the replay is bit-identical (D10)', async () => {
        const combat = createUserCombat().actors(quadActors()).seed(7);
        await combat.simulate();
        const afterOne = combat.snapshot();
        await combat.simulate();
        const afterTwo = combat.snapshot();

        const initial = combat.reset();
        expect(initial.state.step).toBe(0);
        expect(initial.events.map((event) => event.type)).toEqual(['battle:start']);
        expect(await combat.simulate()).toEqual(afterOne);
        await combat.simulate();
        expect(combat.snapshot()).toEqual(afterTwo);
    });

    it('reset after reconfiguration returns the REBUILT battle initial state', async () => {
        const combat = createUserCombat().actors(quadActors()).seed(7);
        await combat.simulate();

        combat.seed(9);
        // stale ⇒ resolve() rebuilds with seed 9, THEN engine reset rewinds it
        const initial = combat.reset();
        expect(initial.state.step).toBe(0);
        expect(initial.definition.startingConditions).toEqual({ seed: 9 });
        expect(initial.events.map((event) => event.type)).toEqual(['battle:start']);
    });
});

// ----------------------------------------------------------------------------
// Live edit through the facade (T3)
// ----------------------------------------------------------------------------

describe('editCombatant patches the live battle (T3 — sync, never stale)', () => {
    it('edits synchronously and the next simulate() continues the SAME battle with the adjustment', async () => {
        const combat = createUserCombat()
            .actors(quadActors())
            .plugins([deterministic])
            .seed(7);
        await combat.simulate(); // fast (speed 4, unarmed 1 dmg) hits slow ⇒ slow 199
        const before = combat.snapshot();
        expect(before.state.step).toBe(1);

        // synchronous (NOT a promise): the edit applies to the live battle
        const edited = combat.editCombatant({ entityId: 'slow', health: 90 });
        expect(edited.state.step).toBe(1); // no step increment
        expect(edited.state.entities[1].health).toBe(90);
        const editedEvent = edited.events.find((event) => event.type === 'combatant:edited')!;
        expect(editedEvent.payload).toEqual({ entityId: 'slow', domains: ['health'], health: { from: 199, to: 90, max: 200, living: true } });

        // the edit did NOT mark the builder stale: the next simulate()
        // CONTINUES the same battle (step 2 at 500k, log grows — no rebuild)
        const after = await combat.simulate();
        expect(after.state.step).toBe(2);
        expect(after.state.virtualTime).toBe(500_000); // fast's next readiness (250k + 250k)
        expect(after.state.entities[1].health).toBe(89); // fast hit the edited 90 hp
        expect(after.events.length).toBe(before.events.length + 1 /* edit event */ + 4 /* step 2 events */);
    });

    it('edit validation errors throw SYNCHRONOUSLY like the other observation methods', () => {
        const combat = createUserCombat()
            .actors(quadActors())
            .seed(7);
        combat.snapshot(); // engine built
        let thrown: unknown;
        try {
            combat.editCombatant({ entityId: 'ghost', health: 1 });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(CombatValidationError);
        expect((thrown as CombatValidationError).errors).toEqual(["edit.entityId: unknown entity id 'ghost'"]);
        // the failed edit left the live battle untouched
        expect(combat.snapshot().events.every((event) => event.type !== 'combatant:edited')).toBe(true);
    });

    it('a terminal battle rejects edits synchronously (reset/rebuild is the only path)', async () => {
        const combat = createUserCombat()
            .actors([
                { id: 'a', stats: { health: 5, strength: 100, speed: 1 } },
                { id: 'b', stats: { health: 1, strength: 0, speed: 1 } },
            ])
            .plugins([deterministic])
            .seed(2);
        await combat.simulate(); // a kills b — terminal
        expect(combat.isTerminal()).toBe(true);
        expect(() => combat.editCombatant({ entityId: 'a', health: 1 })).toThrow(CombatValidationError);
        try {
            combat.editCombatant({ entityId: 'a', health: 1 });
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual(['edit: battle is terminal']);
        }
    });
});

// ----------------------------------------------------------------------------
// Mode + teams setters (R2)
// ----------------------------------------------------------------------------

describe('mode/teams setters compose a teams battle', () => {
    it('runs a teams duel to the exact engine-derived outcome', async () => {
        const combat = createUserCombat()
            .mode('teams')
            .teams([
                { id: 'crown', name: 'Crown', members: ['knight'] },
                { id: 'fang', name: 'Fang', members: ['brute'] },
            ])
            .actors([
                // unarmed math: knight 1 × 1.4 ⇒ round 1; brute 1 × 1.5 ⇒ round 2
                { id: 'knight', team: 'crown', stats: { health: 30, strength: 8, speed: 1, defense: 3 } },
                { id: 'brute', team: 'fang', stats: { health: 40, strength: 10, speed: 1 } },
            ])
            .plugins([deterministic])
            .seed(7);

        // alternate turns (equal speed ⇒ definition order). Unarmed math with
        // mitigation (D5a.8): knight hits brute for round(1 × 1.4 × 1) = 1
        // (brute defense 0); brute hits knight for round(1.5 × 100/103) = 1
        // (knight defense 3). Knight (health 30) dies on brute's 30th turn
        // ⇒ step 60 ⇒ team victory 'fang'
        while (!combat.isTerminal()) await combat.simulate();
        expect(combat.outcome()).toEqual({ outcome: 'victory', winner: 'fang', step: 60 });
    });
});

// ----------------------------------------------------------------------------
// Failures consistent with the engine (R3/R4)
// ----------------------------------------------------------------------------

describe('failure modes match createSimulation fail-fast (D2)', () => {
    it('unconfigured simulate() rejects with the engine collected validation list', async () => {
        const rejection = await caught(createUserCombat().simulate());
        expect(rejection).toBeInstanceOf(CombatValidationError);
        expect((rejection as CombatValidationError).errors).toEqual(['entities: must be an array of at least 2 entities']);
    });

    it('observation methods throw the same error synchronously', () => {
        const combat = createUserCombat();
        expect(() => combat.snapshot()).toThrow(CombatValidationError);
        expect(() => combat.events()).toThrow(CombatValidationError);
        expect(() => combat.reset()).toThrow(CombatValidationError);
        expect(() => combat.isTerminal()).toThrow(CombatValidationError);
        expect(() => combat.outcome()).toThrow(CombatValidationError);
        let thrown: unknown;
        try {
            combat.snapshot();
        } catch (error) {
            thrown = error;
        }
        expect((thrown as CombatValidationError).errors).toEqual(['entities: must be an array of at least 2 entities']);
    });

    it('invalid entity stats surface the engine exact error list', async () => {
        const rejection = await caught(createUserCombat()
            .actors([
                { id: 'a', stats: { health: 0, strength: 1, speed: 1 } },
                { id: 'b', stats: { health: 5, strength: 1, speed: 1 } },
            ])
            .simulate());
        expect(rejection).toBeInstanceOf(CombatValidationError);
        expect((rejection as CombatValidationError).errors).toEqual(['entities[0].stats.health: must be an integer between 1 and 100000']);
    });

    it('teams mode without team declarations collects the engine full error list', async () => {
        const rejection = await caught(createUserCombat()
            .mode('teams')
            .actors([
                { id: 'a', stats: { health: 10, strength: 1, speed: 1 } },
                { id: 'b', stats: { health: 10, strength: 1, speed: 1 } },
            ])
            .simulate());
        // validateTeamAgreement returns EARLY when teams is absent/not an
        // array — the entity-side agreement loop only runs on a teams array
        expect(rejection).toBeInstanceOf(CombatValidationError);
        expect((rejection as CombatValidationError).errors).toEqual([
            'teams: teams mode requires at least 2 teams',
        ]);
    });

    it('seed range validation matches the engine (D4g)', async () => {
        const rejection = await caught(createUserCombat()
            .actors(tanks())
            .seed(4_294_967_296)
            .simulate());
        expect(rejection).toBeInstanceOf(CombatValidationError);
        expect((rejection as CombatValidationError).errors).toEqual(['startingConditions.seed: must be an integer between 0 and 4294967295']);
    });

    it('plugin load errors reject with CombatPluginError (D7, definition validated first)', async () => {
        const rogue: CombatPlugin = { id: 'bad', hooks: { 'attack:dodge': () => ({ dodged: false }) } } as CombatPlugin;
        const rejection = await caught(createUserCombat()
            .actors(tanks())
            .plugins([rogue])
            .simulate());
        expect(rejection).toBeInstanceOf(CombatPluginError);
        expect((rejection as CombatPluginError).errors).toEqual(["plugin 'bad' ships single-mode handler 'attack:dodge' without declaring it in overrides"]);
    });
});

// ----------------------------------------------------------------------------
// The shared singleton (R2)
// ----------------------------------------------------------------------------

describe('userCombat singleton (R2)', () => {
    it('runs a fully reconfigured battle and stays isolated from factory instances', async () => {
        // The singleton ACCUMULATES configuration (documented JSDoc): every
        // domain is re-set explicitly so this battle is fully specified.
        expect(userCombat.mode('ffa')).toBe(userCombat);
        userCombat.teams([]).equipments([]).abilities([]);
        userCombat.config({ maxSteps: 10_000, maxCascade: 1_000, maxLogEvents: 100_000 });
        userCombat.builtinRules(true);
        userCombat.actors([
            { id: 'a', stats: { health: 5, strength: 100, speed: 1 } },
            { id: 'b', stats: { health: 1, strength: 0, speed: 1 } },
        ]).plugins([deterministic]).seed(2);

        await userCombat.simulate();
        expect(userCombat.outcome()).toEqual({ outcome: 'victory', winner: 'a', step: 1 });

        // a fresh factory instance knows nothing of the singleton
        const rejection = await caught(createUserCombat().simulate());
        expect((rejection as CombatValidationError).errors).toEqual(['entities: must be an array of at least 2 entities']);
        // …and the singleton battle is untouched
        expect(userCombat.outcome()).toEqual({ outcome: 'victory', winner: 'a', step: 1 });
    });
});
