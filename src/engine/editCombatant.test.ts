// ============================================================================
// @userfiction/combat — src/engine/editCombatant.test.ts — T3 live-edit matrix
// (Simulation.editCombatant: validated atomic combatant patch on the RUNNING
// battle between turns)
// ============================================================================
// Drives the PUBLIC surface (createSimulation through the root barrel) to
// pin the frozen shared API with the demo UI worker:
//   - exact CombatValidationError messages, collect-all field validation,
//     terminal and reentrant rejection;
//   - health edits: clamp into [0, maxHealth], 0 kills (schedule dropped),
//     > 0 revives (next entry at now + default interval), no step increment;
//   - baseStats: baseStats.health IS maxHealth, coherent clamp, D4e
//     proportional reschedule on speed changes (exact µs);
//   - gear: catalog/kind/slot/durability validation against the PROJECTED
//     loadout × PROJECTED injuries (hands budget, two-handed, anatomy);
//   - statuses: DIRECT ADMIN SET (no resistance, no accumulation,
//     definition modifiers materialized; unregistered ids stay inert custom
//     data), remove semantics, exact validation bounds;
//   - injuries: strict add/remove coherence with derived speed reschedule;
//   - resources: stamina/mana exact replace/remove, energy alias rejected;
//   - preservation: step/time/RNG/log preserved on success; exact state/
//     log/RNG rollback on a plugin-hook throw inside the edit;
//   - ALL-dead empty schedule: the next simulate() runs outcome:decide
//     instead of returning no-progress forever (hole closed);
//   - reset discards edits; JSON restore retains them (R4).
// All expected values are derived from the D13/D4b/D4e contracts and the
// deterministic-plugin timeline (commented at each pin).
// ============================================================================

import {
    CombatValidationError,
    createSimulation,
    defaultStatusSeed,
} from '../../index';
import type {
    BattleDefinition,
    CombatantEdit,
    CombatPlugin,
    Simulation,
    SimulationSnapshot,
} from '../../index';
// defaultInterval is an internal scheduler helper (not on the public barrel)
// — sibling import, same convention as rules.test.ts.
import { defaultInterval } from '../runtime/scheduler';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Replaces the RNG-driven dodge/crit handlers (declared overrides, D6) so
// asserted damage is pure formula output (unarmed 1 × (1 + 0.05 × strength)).
const deterministic: CombatPlugin = {
    id: 'test/deterministic',
    overrides: ['attack:dodge', 'attack:crit'],
    hooks: {
        'attack:dodge': () => ({ dodged: false }),
        'attack:crit': () => ({ crit: false }),
    },
};

// ffa duo: a (speed 2) always acts first at t=500k; b at t=1M. Unarmed math
// (strength 0): every landed hit deals exactly 1.
const duel = (over: Partial<BattleDefinition> = {}, seed = 7): BattleDefinition => ({
    schemaVersion: 1,
    mode: 'ffa',
    entities: [
        { id: 'a', stats: { health: 50, strength: 0, speed: 2 } },
        { id: 'b', stats: { health: 50, strength: 0, speed: 1 } },
    ],
    startingConditions: { seed },
    ...over,
});

const combatOf = (over: Partial<BattleDefinition> = {}, plugins: CombatPlugin[] = [deterministic]): Simulation =>
    createSimulation(duel(over), { plugins });

// One scheduled step: a attacks b for 1 (a re-armed at 1M, b pending at 1M).
const stepOne = (combat: Simulation): SimulationSnapshot => {
    combat.step();
    return combat.snapshot();
};

const eventTypes = (snapshot: SimulationSnapshot): string[] => snapshot.events.map((event) => event.type);
// The single edit event's payload (undefined when no edit has happened).
const editPayload = (snapshot: SimulationSnapshot): Record<string, unknown> | undefined =>
    snapshot.events.find((event) => event.type === 'combatant:edited')?.payload as Record<string, unknown> | undefined;

// ----------------------------------------------------------------------------
// Validation — exact messages, collect-all, terminal/reentrant rejection (R2)
// ----------------------------------------------------------------------------

describe('editCombatant validation (R2)', () => {
    it('rejects an unknown entity id with the exact message', () => {
        const combat = combatOf();
        try {
            combat.editCombatant({ entityId: 'ghost', health: 1 });
            throw new Error('expected throw');
        } catch (error) {
            expect(error).toBeInstanceOf(CombatValidationError);
            expect((error as CombatValidationError).errors).toEqual(["edit.entityId: unknown entity id 'ghost'"]);
        }
    });

    it('rejects a terminal battle and collects multiple field errors in ONE throw', () => {
        const combat = combatOf();
        combat.run(); // a (speed 2) kills b at some step; terminal victory
        expect(combat.isTerminal()).toBe(true);
        try {
            combat.editCombatant({ entityId: 'a', health: Number.NaN });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual(['edit: battle is terminal']);
        }
    });

    it('collects every invalid field into one error list (never fail-fast)', () => {
        const combat = combatOf();
        combat.step();
        try {
            combat.editCombatant({
                entityId: 'a',
                health: Number.NaN,
                baseStats: { spirit: 1, speed: 0 },
                injuries: { add: ['tail'], remove: ['left-leg'] },
                gear: [{ slot: 'weapon-1', id: 'no-such-gear' }, { slot: 'weapon-1', id: 'rusted-dagger' }],
                statuses: [{ id: 'x-ail', op: 'toggle' }, { id: 'y-ail', op: 'set', stacks: 0 }, { id: 'y-ail', op: 'set', stacks: 1 }],
                resources: { energy: { current: 1, max: 1 } },
            } as unknown as CombatantEdit);
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                'edit.health: must be a finite number',
                "edit.baseStats['spirit']: unknown stat key",
                'edit.baseStats[\'speed\']: must be a finite number between 0.1 and 100',
                "edit.injuries.add[0]: must be one of 'left-arm', 'right-arm', 'left-leg', 'right-leg', 'left-eye', 'right-eye', 'left-ear', 'right-ear', 'nose'",
                "edit.injuries.remove[0]: 'left-leg' is not missing",
                "edit.gear[0].id: unknown gear id 'no-such-gear'",
                "edit.gear[1].slot: duplicate slot edit for 'weapon-1'",
                "edit.statuses[0].op: must be 'set' or 'remove'",
                'edit.statuses[1].stacks: must be an integer between 1 and 9',
                "edit.statuses[2].id: duplicate status edit for 'y-ail'",
                "edit.resources['energy']: the energy alias is initial-input only — edit 'stamina' directly",
            ]);
        }
    });

    it('rejects a reentrant edit from inside an executing hook and leaves the battle unharmed', () => {
        const holder: { sim?: Simulation; caught: string[][] } = { caught: [] };
        const reentrant: CombatPlugin = {
            id: 'p/reentrant',
            hooks: {
                'step:end': () => {
                    try {
                        holder.sim!.editCombatant({ entityId: 'a', health: 5 });
                    } catch (error) {
                        holder.caught.push((error as CombatValidationError).errors);
                    }
                },
            },
        };
        const combat = combatOf({}, [deterministic, reentrant]);
        holder.sim = combat;
        combat.step();
        expect(holder.caught).toEqual([['edit: reentrant edit inside an executing hook is rejected']]);
        // the rejected edit never mutated: a still at full health, no fault
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities.map((entity) => [entity.id, entity.health])).toEqual([['a', 50], ['b', 49]]);
        expect(eventTypes(snapshot)).not.toContain('fault');
        expect(eventTypes(snapshot)).not.toContain('combatant:edited');
    });

    it('a rejected edit appends nothing to the log (validation precedes the transaction)', () => {
        const combat = combatOf();
        const before = combat.snapshot();
        try {
            combat.editCombatant({ entityId: 'a', statuses: [{ id: 'nope-id', op: 'remove' }] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual(["edit.statuses[0]: status 'nope-id' is not present"]);
        }
        const after = combat.snapshot();
        expect(after.events).toEqual(before.events);
        expect(after.state).toEqual(before.state);
    });
});

// ----------------------------------------------------------------------------
// Health edits — clamp, death (schedule drop), revival (default interval)
// ----------------------------------------------------------------------------

describe('editCombatant health (living/schedule coherence)', () => {
    it('replaces current health coherently; the next simulate uses the adjustment', () => {
        const combat = combatOf();
        const afterStepOne = stepOne(combat); // a hit b for 1 ⇒ b 49
        combat.editCombatant({ entityId: 'b', health: 30 });
        const snapshot = combat.snapshot();
        // step/time/RNG untouched by the edit; only the event appended
        expect(snapshot.state.step).toBe(afterStepOne.state.step);
        expect(snapshot.state.virtualTime).toBe(afterStepOne.state.virtualTime);
        expect(snapshot.state.rng).toEqual(afterStepOne.state.rng);
        expect(snapshot.state.entities[1].health).toBe(30);
        const edited = editPayload(snapshot)!;
        expect(edited).toEqual({
            entityId: 'b',
            domains: ['health'],
            health: { from: 49, to: 30, max: 50, living: true },
        });
        // event ids continue from the previous log (existing ids preserved)
        const editedEvent = snapshot.events.find((event) => event.type === 'combatant:edited')!;
        expect(editedEvent.id).toBe(afterStepOne.events.length + 1);
        // next simulate: b is hit again — health 30 − 1 = 29 (adjustment used)
        combat.step();
        expect(combat.snapshot().state.entities[1].health).toBe(29);
    });

    it('clamps into [0, maxHealth]: above max ⇒ max, below 0 ⇒ death + schedule drop', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'b', health: 999 });
        expect(combat.snapshot().state.entities[1].health).toBe(50);
        combat.editCombatant({ entityId: 'a', health: -5 });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[0].living).toBe(false);
        expect(snapshot.state.entities[0].health).toBe(0);
        // death drops the dead entity's pending entry immediately (D4e)
        expect(snapshot.state.schedule).toEqual([{ entityId: 'b', readyAt: 1_000_000 }]);
        // next simulate: a waits (no target), then ffa victory for b
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'victory', winner: 'b', step: 2 });
    });

    it('revives a dead combatant with the next entry at now + default interval (active hook)', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', health: 0 }); // kill a: schedule [b @ 1M]
        expect(combat.snapshot().state.schedule).toEqual([{ entityId: 'b', readyAt: 1_000_000 }]);
        combat.editCombatant({ entityId: 'a', health: 10 }); // revive at t=500k
        const snapshot = combat.snapshot();
        // interval(1, eff 2) = 500 000 µs through the ACTIVE scheduler:interval
        expect(snapshot.state.schedule).toEqual([
            { entityId: 'b', readyAt: 1_000_000 },
            { entityId: 'a', readyAt: 1_000_000 },
        ]);
        expect(snapshot.state.entities[0].living).toBe(true);
        // the tie at 1M resolves to the faster entity (a, D4d)
        combat.step();
        expect(combat.snapshot().state.step).toBe(2);
        expect(combat.snapshot().state.entities[1].health).toBe(48); // a hit b again
    });

    it('a revival entry uses a REPLACED scheduler:interval hook (D6 hook routing)', () => {
        const metronome: CombatPlugin = {
            id: 't/metronome',
            overrides: ['scheduler:interval'],
            hooks: { 'scheduler:interval': () => 1_000_000 },
        };
        const combat = combatOf({}, [deterministic, metronome]);
        // both entries armed at 1M by the replaced hook; a wins the tie at
        // step 1 (speed 2), so virtualTime is 1M when the edit runs
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', health: 0 });
        combat.editCombatant({ entityId: 'a', health: 10 });
        // the replaced hook governs revival too: 1M (now) + 1M (hook interval)
        expect(combat.snapshot().state.schedule).toEqual([
            { entityId: 'b', readyAt: 1_000_000 },
            { entityId: 'a', readyAt: 2_000_000 },
        ]);
    });
});

// ----------------------------------------------------------------------------
// baseStats edits — maxHealth coherence + D4e speed reschedule (exact µs)
// ----------------------------------------------------------------------------

describe('editCombatant baseStats', () => {
    it('baseStats.health IS maxHealth; lowering it clamps current health coherently', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'b', baseStats: { health: 20 } });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[1].maxHealth).toBe(20);
        expect(snapshot.state.entities[1].health).toBe(20); // 49 > 20 ⇒ clamped
        expect(snapshot.state.entities[1].baseStats).toEqual({ health: 20, strength: 0, speed: 1, defense: 0, precision: 0, evasion: 0 });
        expect(snapshot.state.entities[1].living).toBe(true); // clamp floor is 1 — never kills
        // raising maxHealth leaves current health alone
        combat.editCombatant({ entityId: 'b', baseStats: { health: 100 } });
        expect(combat.snapshot().state.entities[1].maxHealth).toBe(100);
        expect(combat.snapshot().state.entities[1].health).toBe(20);
    });

    it('a speed change reschedules the pending entry with proportional remaining work (D4e, exact µs)', () => {
        const combat = combatOf();
        stepOne(combat); // a re-armed at 1M (speed 2 at pick time), b at 1M
        combat.editCombatant({ entityId: 'a', baseStats: { speed: 4 } });
        const snapshot = combat.snapshot();
        // remaining = (1M − 500k) × 2 / 1e6 = 1 cost unit ⇒ interval(1, 4)
        // = 250 000 µs ⇒ readyAt 750 000
        expect(snapshot.state.schedule).toEqual([
            { entityId: 'a', readyAt: 750_000 },
            { entityId: 'b', readyAt: 1_000_000 },
        ]);
        expect(snapshot.state.entities[0].stats.speed).toBe(4);
        // the next pick honors the new readiness: a acts at t=750k
        combat.step();
        expect(combat.snapshot().state.virtualTime).toBe(750_000);
    });

    it('an unchanged speed NEVER recomputes the pending entry (exactness, replaced hook safe)', () => {
        const metronome: CombatPlugin = {
            id: 't/metronome',
            overrides: ['scheduler:interval'],
            hooks: { 'scheduler:interval': () => 7_000_000 }, // nonlinear replacement
        };
        const combat = combatOf({}, [deterministic, metronome]);
        // both armed at 7M; step 1: a wins the tie, re-arms at 7M + 7M
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', baseStats: { strength: 3 } }); // speed untouched
        // NO reschedule fired: the entries keep their exact armed values
        // (array order: a's entry was upserted in place at step 1)
        expect(combat.snapshot().state.schedule).toEqual([
            { entityId: 'a', readyAt: 14_000_000 },
            { entityId: 'b', readyAt: 7_000_000 },
        ]);
    });

    it('rejects out-of-bounds stat keys with exact messages and validates per-key bounds', () => {
        const combat = combatOf();
        try {
            combat.editCombatant({ entityId: 'a', baseStats: { health: 0, speed: 0, strength: 1001 } });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                'edit.baseStats[\'health\']: must be an integer between 1 and 100000',
                'edit.baseStats[\'speed\']: must be a finite number between 0.1 and 100',
                'edit.baseStats[\'strength\']: must be a finite number between 0 and 1000',
            ]);
        }
    });
});

// ----------------------------------------------------------------------------
// Gear edits — catalog/kind/slot validation × projected loadout × anatomy
// ----------------------------------------------------------------------------

describe('editCombatant gear', () => {
    it('equips from the catalog with the default durability; the next attack uses it', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'rusted-dagger' }] });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[0].equipment).toEqual([{ gearId: 'rusted-dagger', slot: 'weapon-1', durability: 8 }]);
        expect(editPayload(snapshot)!.gear).toEqual([{ slot: 'weapon-1', id: 'rusted-dagger', durability: 8 }]);
        // next attack: dagger 3 × (1 + 0.05 × 0) = 3 sharp
        combat.step();
        const damage = combat.events().filter((event) => event.type === 'damage').at(-1)!;
        expect(damage.payload).toEqual({
            amount: 3,
            damageType: 'sharp',
            source: 'weapon',
            weaponId: 'rusted-dagger',
            crit: false,
            mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 },
        });
    });

    it('a durability override replaces the catalog value; id null clears the slot', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'rusted-dagger', durability: 3 }] });
        expect(combat.snapshot().state.entities[0].equipment).toEqual([{ gearId: 'rusted-dagger', slot: 'weapon-1', durability: 3 }]);
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: null }] });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[0].equipment).toEqual([]);
        // the LATEST edit event carries the clear (the earlier equip event persists)
        const edited = combat.snapshot().events.filter((event) => event.type === 'combatant:edited').at(-1)!;
        expect((edited.payload as Record<string, unknown>).gear).toEqual([{ slot: 'weapon-1', id: null }]);
        // unarmed again: 1 blunt
        combat.step();
        const damage = combat.events().filter((event) => event.type === 'damage').at(-1)!;
        expect((damage.payload as { damageType: string }).damageType).toBe('blunt');
    });

    it('validates kind/slot agreement and durability bounds with exact messages', () => {
        const combat = combatOf();
        try {
            combat.editCombatant({
                entityId: 'a',
                gear: [
                    { slot: 'shield', id: 'rusted-dagger' },        // weapon into armour slot
                    { slot: 'head', id: 'buckler' },                // armour into a foreign slot
                    { slot: 'weapon-2', id: 'iron-mace', durability: 0 },
                    { slot: 'weapon-1', id: null },                 // clearing an empty slot
                    { slot: 'body', id: 'padded-vest', durability: 2001 },
                ],
            });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.gear[0].slot: gear 'rusted-dagger' is a weapon and must go in 'weapon-1' or 'weapon-2'",
                "edit.gear[1].slot: gear 'buckler' occupies slot 'shield', not 'head'",
                'edit.gear[2].durability: must be an integer between 1 and 2000',
                "edit.gear[3]: slot 'weapon-1' is already empty",
                'edit.gear[4].durability: must be an integer between 1 and 2000',
            ]);
        }
    });

    it('judges the PROJECTED loadout: hands budget and two-handed conflicts across edits', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'rusted-dagger' }] });
        // dagger (1h, untouched) + great-axe (2h) in weapon-2 ⇒ hands 3 > 2
        // (the axe IS the weapon-2 occupant, so no two-handed conflict fires)
        try {
            combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-2', id: 'great-axe' }] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual(['edit.gear: hands budget exceeded in the projected loadout (3 > 2)']);
        }
        // one edit replacing the dagger with the axe AND adding a shield:
        // hands 2 + 1 = 3 AND the two-handed axe forbids the shield occupant
        try {
            combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'great-axe' }, { slot: 'shield', id: 'buckler' }] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                'edit.gear: hands budget exceeded in the projected loadout (3 > 2)',
                "edit.gear: two-handed gear 'great-axe' forbids 'weapon-2' and 'shield' occupants",
            ]);
        }
        // the axe alone (replacing the dagger) is a legal loadout
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'great-axe' }] });
        expect(combat.snapshot().state.entities[0].equipment).toEqual([{ gearId: 'great-axe', slot: 'weapon-1', durability: 10 }]);
    });

    it('anatomy coherence runs on the PROJECTED injuries — even for injuries-only edits (R2)', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'great-axe' }] }); // 2h, both arms present
        // one projected arm missing while the untouched 2h axe stays equipped
        try {
            combat.editCombatant({ entityId: 'a', injuries: { add: ['right-arm'] } });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.gear: two-handed gear 'great-axe' requires two available arms (one is missing)",
            ]);
        }
        // an UNRELATED one-handed weapon with one arm is fine
        combat.editCombatant({ entityId: 'a', gear: [{ slot: 'weapon-1', id: 'rusted-dagger' }] });
        combat.editCombatant({ entityId: 'a', injuries: { add: ['right-arm'] } });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[0].injuries).toEqual(['right-arm']);
        // 0 projected arms ⇒ every hand-held piece is rejected
        try {
            combat.editCombatant({ entityId: 'a', injuries: { add: ['left-arm'] } });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.gear: 'rusted-dagger' in slot 'weapon-1' requires an arm but both arms are missing",
            ]);
        }
    });
});

// ----------------------------------------------------------------------------
// Status edits — direct admin set (no resistance/accumulation), definitions
// ----------------------------------------------------------------------------

describe('editCombatant statuses (direct admin set)', () => {
    it('set replaces the instance wholesale; the canonical stunned gates the next own turn', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'stunned', op: 'set', duration: 2 }] });
        const snapshot = combat.snapshot();
        // admin set: exact instance, default stacks 1 / potency 1
        expect(snapshot.state.entities[1].statuses).toEqual([{ id: 'stunned', stacks: 1, potency: 1, duration: 2 }]);
        // b's own turn (step 3, tie at 1M goes to a first at step 2): the
        // seed definition's skipChancePerStack 1 ⇒ skip with the status id
        combat.step(); // step 2 — a's turn
        combat.step(); // step 3 — b's turn: SKIP (one draw, always under 1)
        const actions = combat.events().filter((event) => event.type === 'action');
        expect(actions.map((event) => event.payload)).toEqual([
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'skip', reason: 'stunned' },
        ]);
        // duration decay at b's own turn end: 2 → 1
        expect(combat.snapshot().state.entities[1].statuses).toEqual([{ id: 'stunned', stacks: 1, potency: 1, duration: 1 }]);
    });

    it('set bypasses resistance and never accumulates (direct admin semantics)', () => {
        const combat = combatOf({
            entities: [
                { id: 'a', stats: { health: 50, strength: 0, speed: 2 } },
                { id: 'b', stats: { health: 50, strength: 0, speed: 1 }, statusResistances: { stunned: 1 } },
            ],
        });
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'stunned', op: 'set', stacks: 4, duration: 3 }] });
        // resistance 1 would fully resist an apply-status effect; the admin
        // set ignores it entirely
        expect(combat.snapshot().state.entities[1].statuses).toEqual([{ id: 'stunned', stacks: 4, potency: 1, duration: 3 }]);
        // a second set REPLACES the instance (no stack accumulation, no
        // duration max-refresh — exactly the fields provided)
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'stunned', op: 'set' }] });
        expect(combat.snapshot().state.entities[1].statuses).toEqual([{ id: 'stunned', stacks: 1, potency: 1 }]);
    });

    it('a registered definition materializes its per-stack modifiers; unregistered ids stay inert', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'blinded', op: 'set', duration: 2 }] });
        const snapshot = combat.snapshot();
        // seed blinded: duration decay, precision −2 per stack (materialized)
        expect(snapshot.state.entities[1].statuses).toEqual([
            { id: 'blinded', stacks: 1, potency: 1, duration: 2, modifiers: { precision: -2 } },
        ]);
        expect(snapshot.state.entities[1].stats.precision).toBe(-2);
        // unregistered custom id: stored as data, NO modifiers, NO behavior
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'cursed', op: 'set', stacks: 4 }] });
        const after = combat.snapshot();
        expect(after.state.entities[1].statuses).toEqual([
            { id: 'blinded', stacks: 1, potency: 1, duration: 2, modifiers: { precision: -2 } },
            { id: 'cursed', stacks: 4, potency: 1 },
        ]);
        expect(after.state.entities[1].statuses[1].modifiers).toBeUndefined();
        // b's own turn is step 3 (a takes the 1M tie at step 2): no skip, no
        // tick, no decay for 'cursed'; blinded's duration decays at b's turn end
        combat.step(); // a (step 2)
        combat.step(); // a again (the 1M tie goes to the faster a)
        combat.step(); // b (step 3) — turn end decays blinded 2→1
        expect(combat.snapshot().state.entities[1].statuses).toEqual([
            { id: 'blinded', stacks: 1, potency: 1, duration: 1, modifiers: { precision: -2 } },
            { id: 'cursed', stacks: 4, potency: 1 },
        ]);
        // a hit b on both of its own turns (steps 1 and 2): 50 − 1 − 1
        expect(combat.snapshot().state.entities[1].health).toBe(48);
    });

    it('remove deletes the instance; removing an absent id is a validation error', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'bleeding', op: 'set', stacks: 3, duration: 2 }] });
        expect(combat.snapshot().state.entities[1].statuses.map((status) => status.id)).toEqual(['bleeding']);
        combat.editCombatant({ entityId: 'b', statuses: [{ id: 'bleeding', op: 'remove' }] });
        expect(combat.snapshot().state.entities[1].statuses).toEqual([]);
        try {
            combat.editCombatant({ entityId: 'b', statuses: [{ id: 'bleeding', op: 'remove' }] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual(["edit.statuses[0]: status 'bleeding' is not present"]);
        }
    });

    it('validates op fields and instance bounds with exact messages', () => {
        const combat = combatOf();
        try {
            combat.editCombatant({
                entityId: 'b',
                statuses: [
                    { id: 'bleeding', op: 'remove', stacks: 2 },
                    { id: 'burned', op: 'set', stacks: 10 },
                    { id: 'blinded', op: 'set', duration: 0, potency: 0 },
                ],
            });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.statuses[0].stacks: must not be present on op 'remove'",
                "edit.statuses[0]: status 'bleeding' is not present",
                'edit.statuses[1].stacks: must be an integer between 1 and 9',
                'edit.statuses[2].duration: must be an integer >= 1',
                'edit.statuses[2].potency: must be an integer >= 1',
            ]);
        }
    });

    it('every canonical seed id is a valid admin-set target (fearful/poisoned/stunned)', () => {
        expect(defaultStatusSeed.map((definition) => definition.id)).toEqual([
            'fearful', 'poisoned', 'stunned', 'bleeding', 'burned', 'blinded', 'blessed', 'hasted',
        ]);
        const combat = combatOf();
        combat.editCombatant({ entityId: 'b', statuses: [
            { id: 'fearful', op: 'set', stacks: 2 },
            { id: 'poisoned', op: 'set', duration: 3 },
            { id: 'stunned', op: 'set', duration: 1 },
        ] });
        const statuses = combat.snapshot().state.entities[1].statuses;
        expect(statuses.map((status) => status.id)).toEqual(['fearful', 'poisoned', 'stunned']);
        // each definition materialized its behavior data
        expect(statuses[0].modifiers).toBeUndefined(); // fearful: no modifiers (skip gating only)
        expect(statuses[1].modifiers).toBeUndefined(); // poisoned: tick only
    });
});

// ----------------------------------------------------------------------------
// Injury edits — strict coherence + derived speed reschedule
// ----------------------------------------------------------------------------

describe('editCombatant injuries', () => {
    it('add/remove update the closed-set list; a missing leg reschedules pending readiness (exact µs)', () => {
        const combat = combatOf();
        stepOne(combat); // a re-armed at 1M with pick-time speed 2
        combat.editCombatant({ entityId: 'a', injuries: { add: ['left-leg'] } });
        const snapshot = combat.snapshot();
        expect(snapshot.state.entities[0].injuries).toEqual(['left-leg']);
        // speed 2 × 0.75 = 1.5: remaining 1 cost unit ⇒ interval(1, 1.5)
        // = round(666 666.67) = 666 667 ⇒ readyAt 500k + 666 667
        expect(snapshot.state.schedule).toEqual([
            { entityId: 'a', readyAt: 1_166_667 },
            { entityId: 'b', readyAt: 1_000_000 },
        ]);
        expect(snapshot.state.entities[0].stats.speed).toBe(1.5);
        // healing restores the part and the readiness (back to speed 2)
        combat.editCombatant({ entityId: 'a', injuries: { remove: ['left-leg'] } });
        const healed = combat.snapshot();
        expect(healed.state.entities[0].injuries).toBeUndefined();
        // remaining at 1.5 eff = (1 166 667 − 500 000) × 1.5 / 1e6 ≈ 1.0000005
        // ⇒ interval ≈ 666 667 × ... — exact algebra: round((1 166 667 − 500 000) × 1.5 / 2) = 500 000
        expect(healed.state.schedule).toEqual([
            { entityId: 'a', readyAt: 1_000_000 },
            { entityId: 'b', readyAt: 1_000_000 },
        ]);
    });

    it('validates strict add/remove coherence with exact messages', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'a', injuries: { add: ['nose'] } });
        try {
            combat.editCombatant({
                entityId: 'a',
                injuries: { add: ['nose', 'nose'], remove: ['left-leg'] },
            });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.injuries.add[0]: 'nose' is already missing",
                "edit.injuries.add[1]: duplicate body part 'nose'",
                "edit.injuries.remove[0]: 'left-leg' is not missing",
            ]);
        }
    });
});

// ----------------------------------------------------------------------------
// Resource edits — stamina/mana exact replace/remove, alias rejection
// ----------------------------------------------------------------------------

describe('editCombatant resources', () => {
    it('exactly replaces a pool; null removes it (empty object gone, additive-optional)', () => {
        const combat = combatOf();
        combat.editCombatant({ entityId: 'b', resources: { mana: { current: 3, max: 3 } } });
        expect(combat.snapshot().state.entities[1].resources).toEqual({ mana: { current: 3, max: 3 } });
        combat.editCombatant({ entityId: 'b', resources: { mana: { current: 1, max: 9 } } });
        expect(combat.snapshot().state.entities[1].resources).toEqual({ mana: { current: 1, max: 9 } });
        combat.editCombatant({ entityId: 'b', resources: { mana: null } });
        expect(combat.snapshot().state.entities[1].resources).toBeUndefined();
    });

    it('rejects the energy alias, unknown pools, out-of-range values and current > max', () => {
        const combat = combatOf();
        try {
            combat.editCombatant({
                entityId: 'b',
                resources: {
                    energy: { current: 1, max: 1 },
                    spirit: { current: 0, max: 0 },
                    stamina: { current: 5, max: 4 },
                    mana: { current: -1, max: 1_000_001 },
                },
            } as unknown as CombatantEdit);
            throw new Error('expected throw');
        } catch (error) {
            expect((error as CombatValidationError).errors).toEqual([
                "edit.resources['energy']: the energy alias is initial-input only — edit 'stamina' directly",
                "edit.resources['spirit']: unknown resource pool (expected stamina or mana)",
                'edit.resources[\'stamina\'].current: must not exceed max (5 > 4)',
                'edit.resources[\'mana\'].current: must be an integer between 0 and 1000000',
                'edit.resources[\'mana\'].max: must be an integer between 0 and 1000000',
            ]);
        }
    });

    it('a fresh pool makes a priced ability affordable on the next own turn', () => {
        const cut = { id: 'cut', cost: 1, cooldown: 1, costs: { mana: 2 }, effects: [{ type: 'emit', message: 'cut' }] };
        // casts only when the mana pool can pay (mirrors the default
        // selector's affordability gate; a PLUGIN forcing an unaffordable
        // pick would be a contract fault, not a graceful fallback)
        const caster: CombatPlugin = {
            id: 'test/caster',
            overrides: ['action:select'],
            hooks: {
                'action:select': (_view, _ctx, args) => {
                    const actor = (args as { actor: { id: string; cooldowns: Record<string, number>; resources?: { mana?: { current: number } } } }).actor;
                    if (actor.id !== 'a') return { kind: 'attack' };
                    if ((actor.cooldowns['cut'] ?? 0) > 0) return { kind: 'attack' };
                    if ((actor.resources?.mana?.current ?? 0) < 2) return { kind: 'attack' };
                    return { kind: 'ability', abilityId: 'cut' };
                },
            },
        };
        const combat = combatOf(
            { catalogs: { abilities: [cut] }, entities: [
                { id: 'a', stats: { health: 50, strength: 0, speed: 2 }, abilities: ['cut'] },
                { id: 'b', stats: { health: 50, strength: 0, speed: 1 } },
            ] },
            [deterministic, caster],
        );
        combat.step(); // a attacks — no pool, the cast is unaffordable
        expect(combat.events().filter((event) => event.type === 'resource:spent')).toEqual([]);
        // grant the pool; the VERY NEXT own turn pays it
        combat.editCombatant({ entityId: 'a', resources: { mana: { current: 2, max: 2 } } });
        combat.step(); // a casts cut — mana 2 − 2 = 0
        const spent = combat.events().filter((event) => event.type === 'resource:spent');
        expect(spent).toHaveLength(1);
        expect(spent[0].payload).toEqual({ costs: { mana: 2 } });
        expect(combat.snapshot().state.entities[0].resources).toEqual({ mana: { current: 0, max: 2 } });
    });
});

// ----------------------------------------------------------------------------
// Preservation + atomic rollback (R2: step/time/RNG/log exact)
// ----------------------------------------------------------------------------

describe('editCombatant preservation and rollback (R2)', () => {
    it('a multi-domain edit emits ONE event with the full domain summary (no step increment)', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({
            entityId: 'b',
            health: 40,
            baseStats: { strength: 5 },
            gear: [{ slot: 'body', id: 'padded-vest' }],
            statuses: [{ id: 'blinded', op: 'set', duration: 2 }],
            injuries: { add: ['nose'] },
            resources: { stamina: { current: 4, max: 4 } },
        });
        const snapshot = combat.snapshot();
        expect(snapshot.state.step).toBe(1);
        expect(snapshot.state.virtualTime).toBe(500_000);
        expect(editPayload(snapshot)!).toEqual({
            entityId: 'b',
            domains: ['health', 'baseStats', 'statuses', 'injuries', 'resources', 'gear'],
            health: { from: 49, to: 40, max: 50, living: true },
            baseStats: { health: 50, strength: 5, speed: 1, defense: 0, precision: 0, evasion: 0 },
            statuses: [{ id: 'blinded', op: 'set', stacks: 1, duration: 2, potency: 1 }],
            injuries: { added: ['nose'], removed: [], missing: ['nose'] },
            resources: { stamina: { current: 4, max: 4 } },
            gear: [{ slot: 'body', id: 'padded-vest', durability: 10 }],
        });
    });

    it('a plugin-hook throw inside the edit rolls back state, RNG and log EXACTLY', () => {
        // the replaced scheduler:interval hook faults when the edit's speed
        // reschedule calls it — the CombatFault is converted to the declared
        // CombatValidationError contract and the whole patch is undone.
        const gate = { armed: false };
        const brittle: CombatPlugin = {
            id: 't/brittle',
            overrides: ['scheduler:interval'],
            hooks: {
                'scheduler:interval': (_view, _ctx, args) => {
                    if (gate.armed) throw new Error('boom');
                    return defaultInterval(args);
                },
            },
        };
        const combat = combatOf({}, [deterministic, brittle]);
        const before = stepOne(combat); // a re-armed at 1M (hook disarmed)
        gate.armed = true;
        try {
            combat.editCombatant({ entityId: 'a', baseStats: { speed: 4 } });
            throw new Error('expected throw');
        } catch (error) {
            expect(error).toBeInstanceOf(CombatValidationError);
            expect((error as CombatValidationError).errors).toEqual(['edit: boom']);
        }
        const after = combat.snapshot();
        // exact rollback: identical snapshot (nothing applied, nothing logged)
        expect(after).toEqual(before);
        gate.armed = false;
        // the next edit succeeds cleanly
        combat.editCombatant({ entityId: 'a', baseStats: { speed: 4 } });
        expect(combat.snapshot().state.entities[0].stats.speed).toBe(4);
        expect(editPayload(combat.snapshot())!.entityId).toBe('a');
    });

    it('the edit event survives a later faulting step (it was emitted outside the step transaction)', () => {
        const boom: CombatPlugin = {
            id: 'boom/post',
            hooks: { 'damage:post': () => { throw new Error('post-boom'); } },
        };
        const combat = combatOf({}, [deterministic, boom]);
        combat.editCombatant({ entityId: 'a', health: 45 });
        combat.step(); // faults (step 1 attempt)
        const types = combat.events().map((event) => event.type);
        expect(types).toEqual(['battle:start', 'combatant:edited', 'fault', 'outcome']);
        // the rollback restored pre-step state; the edit itself persists
        expect(combat.snapshot().state.entities[0].health).toBe(45);
    });
});

// ----------------------------------------------------------------------------
// ALL-dead empty schedule — the next simulate() decides (hole closed)
// ----------------------------------------------------------------------------

describe('editCombatant ALL-dead empty schedule', () => {
    it('editing every combatant to 0 health lets the next simulate() decide (mutual-destruction draw)', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', health: 0 });
        combat.editCombatant({ entityId: 'b', health: 0 });
        const snapshot = combat.snapshot();
        expect(snapshot.state.schedule).toEqual([]);
        expect(combat.isTerminal()).toBe(false);
        // the next simulate does NOT hang/no-progress: outcome:decide runs
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'draw', reason: 'mutual-destruction', step: 1 });
        expect(combat.isTerminal()).toBe(true);
        expect(combat.events().at(-1)!.type).toBe('outcome');
        // run() terminates instead of spinning
        expect(combat.run().state.terminal).toEqual({ outcome: 'draw', reason: 'mutual-destruction', step: 1 });
    });

    it('a survivor after a lethal edit wins at the next simulate (ffa last-man-standing)', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'a', health: 0 });
        combat.step();
        expect(combat.outcome()).toEqual({ outcome: 'victory', winner: 'b', step: 2 });
    });
});

// ----------------------------------------------------------------------------
// Reset discards edits; restore retains them (R4)
// ----------------------------------------------------------------------------

describe('editCombatant lifecycle (R4: reset discards, restore retains)', () => {
    it('reset rewinds to the ORIGINAL definition state: edits are state, not configuration', () => {
        const combat = combatOf();
        const initial = combat.snapshot();
        combat.editCombatant({ entityId: 'b', health: 7, statuses: [{ id: 'stunned', op: 'set', duration: 2 }] });
        expect(combat.snapshot().state.entities[1].health).toBe(7);
        const afterReset = combat.reset();
        expect(afterReset).toEqual(initial);
        expect(combat.snapshot().events.map((event) => event.type)).toEqual(['battle:start']);
    });

    it('a JSON snapshot restore keeps the edits and continues bit-identically (D10)', () => {
        const combat = combatOf();
        stepOne(combat);
        combat.editCombatant({ entityId: 'b', health: 33, statuses: [{ id: 'stunned', op: 'set', duration: 2 }] });
        const snapshot = JSON.parse(JSON.stringify(combat.snapshot())) as SimulationSnapshot;
        const resumed = createSimulation(duel(), { plugins: [deterministic], restore: snapshot });
        const original = combatOf();
        // drive both one step past the edit point for bit-identity
        original.step();
        original.editCombatant({ entityId: 'b', health: 33, statuses: [{ id: 'stunned', op: 'set', duration: 2 }] });
        resumed.step();
        original.step();
        expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(original.snapshot()));
        // the survivor's attack after the restore consumed the edited health
        expect(resumed.snapshot().state.entities[1].health).toBe(32);
        expect(resumed.snapshot().events.some((event) => event.type === 'combatant:edited')).toBe(true);
    });
});
