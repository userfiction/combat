// ============================================================================
// @userfiction/combat — src/runtime/state.test.ts — T4 state module tests
// ============================================================================
// Pins the D10 snapshot/restore contract, the D7 copy-safety rule ("no
// mutable references escape"), effective-stat math (D4b/D5c) and every
// mutation helper's exact numbers (D5a.9 damage, D5c status stacking/
// resistance/caps, D8 modify-stat bookkeeping, D5b durability timing,
// D4e schedule drops). All assertions are exact values (task §6 standards).
// ============================================================================

import {
    addStatModifier,
    applyStatus,
    breakGear,
    createCombatState,
    createEntityState,
    damageEntity,
    damageGear,
    deepCopy,
    decrementStatModifiers,
    dropScheduleEntries,
    effectiveStatsOf,
    entityViewOf,
    healEntity,
    removeGear,
    removeStatus,
    resolveStatBlock,
    restoreFrom,
    snapshotOf,
    snapshotStateOf,
    stateViewOf,
} from './state';
import type { CombatState, EntityState } from './state';
import type { BattleDefinition, BattleEvent, StatBlock } from '../contract/types';

// ----------------------------------------------------------------------------
// Fixtures — two-entity teams battle reused across the file; every test gets
// a FRESH state via mkState() so mutation helpers never leak between tests.
// ----------------------------------------------------------------------------

const mkEntityA = (): EntityState =>
    createEntityState({
        id: 'a',
        name: 'Alpha',
        team: 'x',
        order: 0,
        stats: { health: 30, strength: 8, speed: 1, defense: 3 },
        statuses: [{ id: 'wilt' }],
        equipment: [
            { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
            { gearId: 'warden-mail', slot: 'body', durability: 8 },
        ],
    });

const mkEntityB = (): EntityState =>
    createEntityState({ id: 'b', name: 'Bravo', team: 'y', order: 1, stats: { health: 40, strength: 10, speed: 4 } });

const mkState = (): CombatState =>
    createCombatState({
        mode: 'teams',
        entities: [mkEntityA(), mkEntityB()],
        rng: { seed: 7, state: 7, draws: 0 },
        schedule: [
            { entityId: 'a', readyAt: 1000000 },
            { entityId: 'b', readyAt: 250000 },
            { entityId: 'a', readyAt: 2000000 },
        ],
    });

const definition: BattleDefinition = {
    schemaVersion: 1,
    mode: 'teams',
    entities: [
        { id: 'a', name: 'Alpha', team: 'x', stats: { health: 30, strength: 8, speed: 1, defense: 3 } },
        { id: 'b', name: 'Bravo', team: 'y', stats: { health: 40, strength: 10, speed: 4 } },
    ],
};

const events: BattleEvent[] = [{ id: 1, step: 0, time: 0, type: 'battle:start', payload: { seed: 7, mode: 'teams' } }];

describe('deepCopy', () => {
    it('should clone nested structures and fully isolate them from the source', () => {
        const source = { a: 1, b: [1, { c: 'x' }], d: { e: { f: null } } };
        const copy = deepCopy(source) as {
            a: number;
            b: Array<number | { c: string }>;
            d: { e: { f: string | null } };
        };
        expect(copy).toEqual(source);
        // Mutating every nested level of the copy must never touch the source.
        copy.a = 2;
        (copy.b[1] as { c: string }).c = 'mutated';
        copy.d.e.f = 'set';
        expect(source).toEqual({ a: 1, b: [1, { c: 'x' }], d: { e: { f: null } } });
    });

    it('should pass primitives through unchanged', () => {
        expect(deepCopy(7)).toBe(7);
        expect(deepCopy('s')).toBe('s');
        expect(deepCopy(true)).toBe(true);
        expect(deepCopy(null)).toBe(null);
        expect(deepCopy(undefined)).toBe(undefined);
    });
});

describe('resolveStatBlock', () => {
    it('should fill optional stats with 0 (D3)', () => {
        expect(resolveStatBlock({ health: 30, strength: 8, speed: 1 })).toEqual({
            health: 30, strength: 8, speed: 1, defense: 0, precision: 0, evasion: 0,
        });
    });
});

describe('createEntityState', () => {
    it('should resolve name/team/stat/status defaults exactly', () => {
        const entity = createEntityState({
            id: 'knight',
            order: 0,
            stats: { health: 30, strength: 8, speed: 1, defense: 3 },
            statuses: [{ id: 'wilt' }],
            equipment: [{ gearId: 'longsword', slot: 'weapon-1', durability: 12 }],
        });
        expect(entity).toEqual({
            id: 'knight',
            name: 'knight', // name defaults to id (D3)
            order: 0,
            living: true,
            health: 30,
            maxHealth: 30,
            // derived EFFECTIVE block (EntitySnapshot shape, D10) — recomputed
            // at every snapshot/restore/view boundary.
            stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
            baseStats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
            statModifiers: [],
            statuses: [{ id: 'wilt', stacks: 1, potency: 1 }], // D3/D5c defaults filled
            equipment: [{ gearId: 'longsword', slot: 'weapon-1', durability: 12 }],
            cooldowns: {},
        });
        // team absent ⇒ key never present (ffa semantics, D3).
        expect('team' in entity).toBe(false);
    });

    it('should deep-copy seed arrays so later caller mutations cannot leak in', () => {
        const statuses = [{ id: 'wilt' }];
        const equipment = [{ gearId: 'longsword', slot: 'weapon-1' as const, durability: 12 }];
        const entity = createEntityState({ id: 'k', order: 0, stats: { health: 10, strength: 1, speed: 1 }, statuses, equipment });
        statuses[0].id = 'mire';
        equipment[0].durability = 1;
        expect(entity.statuses).toEqual([{ id: 'wilt', stacks: 1, potency: 1 }]);
        expect(entity.equipment).toEqual([{ gearId: 'longsword', slot: 'weapon-1', durability: 12 }]);
    });

    it('should reject an empty id', () => {
        expect(() => createEntityState({ id: '', order: 0, stats: { health: 10, strength: 1, speed: 1 } }))
            .toThrow('entity seed requires a non-empty string id');
    });
});

describe('createCombatState', () => {
    it('should apply defaults and deep-copy the seed', () => {
        const entities = [mkEntityB()];
        const state = createCombatState({ mode: 'ffa', entities, rng: { seed: 1, state: 1, draws: 0 } });
        expect(state.step).toBe(0);
        expect(state.virtualTime).toBe(0);
        expect(state.schedule).toEqual([]);
        expect(state.terminal).toBe(null);
        entities[0].health = 1; // seed array mutation must not affect live state
        expect(state.entities[0].health).toBe(40);
    });

    it('should reject an invalid mode', () => {
        expect(() => createCombatState({ mode: 'solo' as never, entities: [], rng: { seed: 1, state: 1, draws: 0 } }))
            .toThrow('combat state seed mode must be "ffa" or "teams"');
    });
});

describe('effectiveStatsOf', () => {
    const base: StatBlock = { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 };

    it('should sum all modifiers per stat (D7 effective block)', () => {
        expect(effectiveStatsOf(base, [
            { stat: 'strength', amount: 4, remainingTurns: 2 },
            { stat: 'strength', amount: -1, remainingTurns: 0 },
        ])).toEqual({ health: 30, strength: 11, speed: 1, defense: 3, precision: 0, evasion: 0 });
    });

    it('should clamp effective speed to the 0.001 floor (D4b)', () => {
        expect(effectiveStatsOf(base, [{ stat: 'speed', amount: -2, remainingTurns: 1 }]).speed).toBe(0.001);
    });
});

describe('entityViewOf / stateViewOf', () => {
    it('should produce the exact read-only views (D7)', () => {
        const state = mkState();
        expect(entityViewOf(state.entities[0])).toEqual({
            id: 'a', name: 'Alpha', team: 'x', order: 0, living: true, health: 30, maxHealth: 30,
            stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
            statuses: [{ id: 'wilt', stacks: 1, potency: 1 }],
            equipment: [
                { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
                { gearId: 'warden-mail', slot: 'body', durability: 8 },
            ],
            cooldowns: {},
        });
        expect(stateViewOf(state)).toEqual({
            mode: 'teams',
            step: 0,
            time: 0,
            entities: [
                {
                    id: 'a', name: 'Alpha', team: 'x', order: 0, living: true, health: 30, maxHealth: 30,
                    stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
                    statuses: [{ id: 'wilt', stacks: 1, potency: 1 }],
                    equipment: [
                        { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
                        { gearId: 'warden-mail', slot: 'body', durability: 8 },
                    ],
                    cooldowns: {},
                },
                {
                    id: 'b', name: 'Bravo', team: 'y', order: 1, living: true, health: 40, maxHealth: 40,
                    stats: { health: 40, strength: 10, speed: 4, defense: 0, precision: 0, evasion: 0 },
                    statuses: [], equipment: [], cooldowns: {},
                },
            ],
        });
    });

    it('should never let view mutations reach live state (D7 no-escape rule)', () => {
        const state = mkState();
        const view = entityViewOf(state.entities[0]);
        view.statuses[0].stacks = 99;
        view.stats.strength = 0;
        view.equipment[0].durability = 0;
        view.cooldowns['x'] = 5;
        expect(state.entities[0].statuses[0].stacks).toBe(1);
        expect(state.entities[0].baseStats.strength).toBe(8);
        expect(state.entities[0].equipment[0].durability).toBe(12);
        expect(state.entities[0].cooldowns).toEqual({});
    });
});

describe('snapshotOf / restoreFrom (D10)', () => {
    it('should round-trip exactly, including through JSON', () => {
        const state = mkState();
        const snap = snapshotOf(state, definition, events);
        expect(snap.schemaVersion).toBe(1);
        expect(snap.events).toEqual(events);
        expect(snap.state).toEqual({
            step: 0,
            virtualTime: 0,
            rng: { seed: 7, state: 7, draws: 0 },
            entities: [
                {
                    id: 'a', name: 'Alpha', team: 'x', order: 0, living: true, health: 30, maxHealth: 30,
                    stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
                    statuses: [{ id: 'wilt', stacks: 1, potency: 1 }],
                    equipment: [
                        { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
                        { gearId: 'warden-mail', slot: 'body', durability: 8 },
                    ],
                    cooldowns: {},
                    baseStats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
                    statModifiers: [],
                },
                {
                    id: 'b', name: 'Bravo', team: 'y', order: 1, living: true, health: 40, maxHealth: 40,
                    stats: { health: 40, strength: 10, speed: 4, defense: 0, precision: 0, evasion: 0 },
                    statuses: [], equipment: [], cooldowns: {},
                    baseStats: { health: 40, strength: 10, speed: 4, defense: 0, precision: 0, evasion: 0 },
                    statModifiers: [],
                },
            ],
            schedule: [
                { entityId: 'a', readyAt: 1000000 },
                { entityId: 'b', readyAt: 250000 },
                { entityId: 'a', readyAt: 2000000 },
            ],
            terminal: null,
        });

        // restore → snapshot must equal the original state block bit-for-bit.
        const restored = restoreFrom(snap);
        expect(snapshotStateOf(restored)).toEqual(snap.state);
        // JSON roundtrip holds (D10).
        const round = JSON.parse(JSON.stringify(snap));
        expect(snapshotStateOf(restoreFrom(round))).toEqual(snap.state);
        // mode is re-derived from the resolved definition.
        expect(stateViewOf(restored).mode).toBe('teams');
    });

    it('should deep-copy on snapshot so later mutation cannot corrupt it', () => {
        const state = mkState();
        const snap = snapshotOf(state, definition, events);
        snap.state.entities[0].statuses[0].stacks = 42;
        snap.definition.entities[0].stats.health = 1;
        snap.events.push({ id: 2, step: 0, time: 0, type: 'custom' });
        expect(state.entities[0].statuses[0].stacks).toBe(1);
        expect(definition.entities[0].stats.health).toBe(30);
        expect(events.length).toBe(1);
    });

    it('should reject corrupt restore input with exact messages', () => {
        const state = mkState();
        const snap = snapshotOf(state, definition, events);
        expect(() => restoreFrom({ ...snap, schemaVersion: 2 } as never))
            .toThrow('restore: unsupported schemaVersion: 2');
        expect(() => restoreFrom({ ...snap, definition: { ...snap.definition, mode: 'solo' } } as never))
            .toThrow('restore: definition.mode must be "ffa" or "teams"');
        expect(() => restoreFrom({ ...snap, state: { ...snap.state, entities: 3 } } as never))
            .toThrow('restore: snapshot.state.entities must be an array');
    });
});

describe('damageEntity / healEntity (D5a.9)', () => {
    it('should subtract, clamp at 0 and flip living exactly once', () => {
        const state = mkState();
        expect(damageEntity(state, 'a', 20)).toEqual({ entityId: 'a', applied: 20, health: 10, killed: false });
        expect(damageEntity(state, 'a', 10)).toEqual({ entityId: 'a', applied: 10, health: 0, killed: true });
        expect(state.entities[0].living).toBe(false);
        // Dead entities absorb no further damage (no overkill mechanic).
        expect(damageEntity(state, 'a', 5)).toEqual({ entityId: 'a', applied: 0, health: 0, killed: false });
    });

    it('should clamp heals at maxHealth and never revive', () => {
        const state = mkState();
        damageEntity(state, 'a', 20);
        expect(healEntity(state, 'a', 50)).toEqual({ entityId: 'a', applied: 20, health: 30 });
        expect(healEntity(state, 'a', 1)).toEqual({ entityId: 'a', applied: 0, health: 30 });
        damageEntity(state, 'a', 30); // kill
        expect(healEntity(state, 'a', 10)).toEqual({ entityId: 'a', applied: 0, health: 0 });
    });

    it('should throw on unknown entity and invalid amounts', () => {
        const state = mkState();
        expect(() => damageEntity(state, 'zz', 1)).toThrow("unknown entity id: 'zz'");
        expect(() => damageEntity(state, 'a', NaN)).toThrow('damage amount must be a finite number >= 0');
        expect(() => damageEntity(state, 'a', -1)).toThrow('damage amount must be a finite number >= 0');
        expect(() => healEntity(state, 'a', Infinity)).toThrow('heal amount must be a finite number >= 0');
    });
});

describe('applyStatus (D5c stacking + D5e resistance)', () => {
    it('should apply, refresh and cap with exact numbers', () => {
        const state = mkState();
        expect(applyStatus(state, 'b', 'mire', { stacks: 2, duration: 3, potency: 2 }))
            .toEqual({ kind: 'applied', status: { id: 'mire', stacks: 2, duration: 3, potency: 2 } });
        // refresh: stacks 2+2=4; duration max(3,2)=3; potency keeps the existing 2.
        expect(applyStatus(state, 'b', 'mire', { stacks: 2, duration: 2, potency: 5 }))
            .toEqual({ kind: 'refreshed', status: { id: 'mire', stacks: 4, duration: 3, potency: 2 } });
        // cap: min(4+9, 9) = 9 (D5c/D13).
        expect(applyStatus(state, 'b', 'mire', { stacks: 9 }))
            .toEqual({ kind: 'refreshed', status: { id: 'mire', stacks: 9, duration: 3, potency: 2 } });
        // defaults: wilt re-application on entity a (stacks 1) → 2, no duration either side.
        expect(applyStatus(state, 'a', 'wilt'))
            .toEqual({ kind: 'refreshed', status: { id: 'wilt', stacks: 2, potency: 1 } });
    });

    it('should honor resistance: floor(added × (1 − resist)), full resist, and zeroed stacks', () => {
        const state = mkState();
        // floor(3 × 0.5) = 1
        expect(applyStatus(state, 'b', 'wilt', { stacks: 3, resistance: 0.5 }))
            .toEqual({ kind: 'applied', status: { id: 'wilt', stacks: 1, potency: 1 } });
        // resist ≥ 1 ⇒ full resist, nothing written (D5e).
        expect(applyStatus(state, 'b', 'numb', { stacks: 5, duration: 2, resistance: 1 })).toEqual({ kind: 'resisted' });
        // floor(1 × 0.5) = 0 on a NEW status ⇒ resisted (declared edge).
        expect(applyStatus(state, 'b', 'daze', { stacks: 1, resistance: 0.5 })).toEqual({ kind: 'resisted' });
        expect(state.entities[1].statuses).toEqual([
            { id: 'wilt', stacks: 1, potency: 1 },
        ]);
    });

    it('should return copies, never live status references', () => {
        const state = mkState();
        const result = applyStatus(state, 'b', 'burn', { stacks: 1 });
        expect(result.kind).toBe('applied');
        if (result.kind !== 'resisted') {
            result.status.stacks = 99;
            expect(state.entities[1].statuses).toEqual([{ id: 'burn', stacks: 1, potency: 1 }]);
        }
    });
});

describe('removeStatus', () => {
    it('should remove once and report misses', () => {
        const state = mkState();
        expect(removeStatus(state, 'a', 'wilt')).toBe(true);
        expect(removeStatus(state, 'a', 'wilt')).toBe(false);
        expect(state.entities[0].statuses).toEqual([]);
    });
});

describe('stat modifiers (D8 modify-stat / D5c decrement / D10)', () => {
    it('should add, reflect in effective stats, decrement and expire exactly', () => {
        const state = mkState();
        expect(addStatModifier(state, 'a', 'speed', -1, 2)).toEqual({ stat: 'speed', amount: -1, remainingTurns: 2 });
        addStatModifier(state, 'a', 'strength', 3, 0); // 0 = permanent sentinel
        // speed 1−1=0 → clamped to 0.001 (D4b); strength 8+3=11.
        expect(entityViewOf(state.entities[0]).stats).toEqual({
            health: 30, strength: 11, speed: 0.001, defense: 3, precision: 0, evasion: 0,
        });
        // first own-turn tick: timed modifier 2→1, permanent untouched.
        expect(decrementStatModifiers(state, 'a')).toEqual([]);
        expect(state.entities[0].statModifiers).toEqual([
            { stat: 'speed', amount: -1, remainingTurns: 1 },
            { stat: 'strength', amount: 3, remainingTurns: 0 },
        ]);
        // second tick: speed expires (returned for stat:expired events), strength stays.
        expect(decrementStatModifiers(state, 'a')).toEqual([{ stat: 'speed', amount: -1, remainingTurns: 0 }]);
        expect(state.entities[0].statModifiers).toEqual([{ stat: 'strength', amount: 3, remainingTurns: 0 }]);
        // snapshot stats are RECOMPUTED from base + modifiers, never stale (D10).
        expect(snapshotStateOf(state).entities[0].stats.strength).toBe(11);
    });

    it('should throw on invalid modifier numbers', () => {
        const state = mkState();
        expect(() => addStatModifier(state, 'a', 'speed', NaN, 1)).toThrow('stat modifier amount must be a finite number');
        expect(() => addStatModifier(state, 'a', 'speed', 1, 1.5)).toThrow('stat modifier remainingTurns must be an integer >= 0');
    });
});

describe('gear durability / breakage (D5b/D8)', () => {
    it('should decrement, report breakage, and keep the piece until the engine removes it', () => {
        const state = mkState();
        expect(damageGear(state, 'a', 'weapon-1')).toEqual({ gearId: 'longsword', slot: 'weapon-1', durability: 11, broken: false });
        expect(damageGear(state, 'a', 'weapon-1', 11)).toEqual({ gearId: 'longsword', slot: 'weapon-1', durability: 0, broken: true });
        // D5b timing: the breaking piece still occupies its slot until removed.
        expect(state.entities[0].equipment.length).toBe(2);
        expect(removeGear(state, 'a', 'weapon-1')).toEqual({ gearId: 'longsword', slot: 'weapon-1', durability: 0 });
        // Empty slot ⇒ null (legal mid-cascade race, not a fault).
        expect(damageGear(state, 'a', 'weapon-1')).toBeNull();
        expect(removeGear(state, 'a', 'weapon-1')).toBeNull();
    });

    it('should break the given slot, or all weapon slots when slot is omitted', () => {
        const state = mkState();
        expect(breakGear(state, 'a')).toEqual([{ gearId: 'longsword', slot: 'weapon-1', durability: 12 }]);
        expect(state.entities[0].equipment).toEqual([{ gearId: 'warden-mail', slot: 'body', durability: 8 }]);
        expect(breakGear(state, 'a', 'body')).toEqual([{ gearId: 'warden-mail', slot: 'body', durability: 8 }]);
        expect(breakGear(state, 'a')).toEqual([]);
    });
});

describe('dropScheduleEntries (D4e)', () => {
    it('should remove every entry for the dead entity and report the count', () => {
        const state = mkState();
        expect(dropScheduleEntries(state, 'a')).toBe(2);
        expect(state.schedule).toEqual([{ entityId: 'b', readyAt: 250000 }]);
        expect(dropScheduleEntries(state, 'a')).toBe(0);
    });
});
