// ============================================================================
// demo/ui/combatants.test.ts — pure-helper unit tests for the live Combatants
// panel (T3)
// ============================================================================
// Pins the EXACT behavior of the helpers behind the single live panel:
// catalog folds (patch-by-id semantics), canonical status registry (NO legacy
// fear/poison/stun fallbacks anywhere), content-based polarity, sensible
// duration defaults, the atomic gear-edit planner (hand normalization with
// its note protocol over LIVE equipment) and the injury→gear coherence
// planner (same-atomic-patch gear clears with visible notes). Every
// assertion uses exact expected values (no ranges/loose checks).
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { defaultGearSeed, defaultStatusSeed } from '../../index';
import type { BodyPart, EntityView, GearDefinition, Slot, StatusDefinition } from '../../index';
import {
    buildGearEdit,
    defaultDurationFor,
    effectiveGearCatalog,
    effectiveStatusCatalog,
    foldById,
    injuryGearPlan,
    statusPolarity
} from './combatants';

// --- shared fixtures ---------------------------------------------------------

type EquipmentEntry = EntityView['equipment'][number];

const gearById = (list: readonly GearDefinition[]): Map<string, GearDefinition> =>
    new Map(list.map((definition) => [definition.id, definition]));

// The builtin seed as a lookup (Great Axe is the only two-handed preset)
const builtinGear = gearById(defaultGearSeed);

const entry = (gearId: string, slot: Slot, durability: number): EquipmentEntry => ({ gearId, slot, durability });

// Fixture-level gear (Crossroads Skirmish) used where the tests reference
// names that only resolve through the passed catalog — mirrors how the real
// panel folds fixture gear over the builtin seed.
const longsword: GearDefinition = {
    id: 'longsword',
    name: 'Longsword',
    kind: 'weapon',
    slot: 'weapon-1',
    handedness: 1,
    type: 'sharp',
    damage: 6,
    blunt: 0,
    sharp: 0,
    durability: 12
};
const skirmishGear = gearById([...defaultGearSeed, longsword]);

const registryOf = (definitions: readonly StatusDefinition[]): Map<string, StatusDefinition> =>
    new Map(definitions.map((definition) => [definition.id, definition]));

// --- catalog folds (mirrors of src/data/catalogs.ts patch semantics) ---------

describe('foldById', () => {
    it('merges patches over the seed by id, undefined never erases, order preserved', () => {
        const merged = foldById<GearDefinition>(
            [
                {
                    id: 'a',
                    kind: 'weapon',
                    slot: 'weapon-1',
                    handedness: 1,
                    type: 'sharp',
                    damage: 3,
                    blunt: 0,
                    sharp: 0,
                    durability: 8
                },
                {
                    id: 'b',
                    kind: 'weapon',
                    slot: 'weapon-1',
                    handedness: 1,
                    type: 'blunt',
                    damage: 5,
                    blunt: 0,
                    sharp: 0,
                    durability: 10
                }
            ],
            [
                { id: 'a', damage: 7 },
                { id: 'a', name: 'Patched A' },
                {
                    id: 'c',
                    kind: 'weapon',
                    slot: 'weapon-2',
                    handedness: 1,
                    type: 'sharp',
                    damage: 1,
                    blunt: 0,
                    sharp: 0,
                    durability: 4
                }
            ]
        );
        expect(merged).toEqual([
            // known id: only provided fields overwritten (undefined never erases);
            // later patch of the same id wins; listing order stays seed-first
            {
                id: 'a',
                name: 'Patched A',
                kind: 'weapon',
                slot: 'weapon-1',
                handedness: 1,
                type: 'sharp',
                damage: 7,
                blunt: 0,
                sharp: 0,
                durability: 8
            },
            {
                id: 'b',
                kind: 'weapon',
                slot: 'weapon-1',
                handedness: 1,
                type: 'blunt',
                damage: 5,
                blunt: 0,
                sharp: 0,
                durability: 10
            },
            {
                id: 'c',
                kind: 'weapon',
                slot: 'weapon-2',
                handedness: 1,
                type: 'sharp',
                damage: 1,
                blunt: 0,
                sharp: 0,
                durability: 4
            }
        ]);
    });

    it('skips non-object and id-less patches', () => {
        const merged = foldById<GearDefinition>(
            [
                {
                    id: 'a',
                    kind: 'weapon',
                    slot: 'weapon-1',
                    handedness: 1,
                    type: 'sharp',
                    damage: 3,
                    blunt: 0,
                    sharp: 0,
                    durability: 8
                }
            ],
            [null, 'nope', 7, { damage: 9 } as Record<string, unknown>]
        );
        expect(merged).toEqual([
            {
                id: 'a',
                kind: 'weapon',
                slot: 'weapon-1',
                handedness: 1,
                type: 'sharp',
                damage: 3,
                blunt: 0,
                sharp: 0,
                durability: 8
            }
        ]);
    });
});

describe('effectiveGearCatalog / effectiveStatusCatalog', () => {
    it('folds the definition gear patches over the builtin seed', () => {
        const definition = {
            catalogs: {
                gear: [
                    // patch an existing preset
                    { id: 'rusted-dagger', damage: 9 },
                    // add a new weapon
                    {
                        id: 'grove-staff',
                        name: 'Grove Staff',
                        kind: 'weapon',
                        slot: 'weapon-1',
                        handedness: 2,
                        type: 'blunt',
                        damage: 6,
                        blunt: 0,
                        sharp: 0,
                        durability: 9
                    }
                ]
            }
        } as unknown as import('../../index').BattleDefinition;
        const catalog = effectiveGearCatalog(definition);
        const dagger = catalog.find((gear) => gear.id === 'rusted-dagger') as GearDefinition;
        expect(dagger.damage).toBe(9);
        expect(dagger.durability).toBe(8); // seed field kept (patch semantics)
        expect(catalog.find((gear) => gear.id === 'grove-staff')).toEqual({
            id: 'grove-staff',
            name: 'Grove Staff',
            kind: 'weapon',
            slot: 'weapon-1',
            handedness: 2,
            type: 'blunt',
            damage: 6,
            blunt: 0,
            sharp: 0,
            durability: 9
        });
        // the full builtin seed stays present for preset discovery
        expect(catalog.map((gear) => gear.id)).toEqual([
            'rusted-dagger',
            'iron-mace',
            'great-axe',
            'buckler',
            'padded-vest',
            'iron-helm',
            'grove-staff'
        ]);
    });

    it('the canonical status registry is the seed: fearful/poisoned/stunned + the rest, NO legacy trio ids', () => {
        // T3 canonical pin (src/data/catalogs.ts): the seed itself carries the
        // canonical ids as generic registry definitions; fear/poison/stun are
        // unregistered custom data with no built-in semantics anywhere.
        expect(defaultStatusSeed.map((definition) => definition.id)).toEqual([
            'fearful',
            'poisoned',
            'stunned',
            'bleeding',
            'burned',
            'blinded',
            'blessed',
            'hasted'
        ]);
        const registry = effectiveStatusCatalog({} as import('../../index').BattleDefinition);
        expect(registry.map((definition) => definition.id)).toEqual([
            'fearful',
            'poisoned',
            'stunned',
            'bleeding',
            'burned',
            'blinded',
            'blessed',
            'hasted'
        ]);
    });

    it('folds definition status overrides over the seed (custom ids appended in first-listed order)', () => {
        const definition = {
            catalogs: {
                statuses: [
                    { id: 'regenerating', name: 'Regenerating', decay: 'duration', tick: { heal: 1 } },
                    { id: 'poisoned', tick: { damage: 4 } }
                ]
            }
        } as unknown as import('../../index').BattleDefinition;
        const registry = effectiveStatusCatalog(definition);
        expect(registry.map((definition) => definition.id)).toEqual([
            'fearful',
            'poisoned',
            'stunned',
            'bleeding',
            'burned',
            'blinded',
            'blessed',
            'hasted',
            'regenerating'
        ]);
        const poisoned = registry.find((definition) => definition.id === 'poisoned') as StatusDefinition;
        expect(poisoned).toEqual({ id: 'poisoned', name: 'Poisoned', decay: 'duration', tick: { damage: 4 } });
    });
});

// --- status polarity (R4: content-based, canonical-only) ---------------------

describe('statusPolarity', () => {
    const builtin = registryOf(defaultStatusSeed);

    it('classifies the canonical ailments negative and the buffs positive', () => {
        expect(statusPolarity('fearful', builtin)).toBe('negative'); // skip chance per stack
        expect(statusPolarity('poisoned', builtin)).toBe('negative'); // damage tick
        expect(statusPolarity('stunned', builtin)).toBe('negative'); // skipChancePerStack 1
        expect(statusPolarity('bleeding', builtin)).toBe('negative');
        expect(statusPolarity('burned', builtin)).toBe('negative');
        expect(statusPolarity('blinded', builtin)).toBe('negative'); // negative modifier
        expect(statusPolarity('blessed', builtin)).toBe('positive');
        expect(statusPolarity('hasted', builtin)).toBe('positive');
    });

    it('treats unknown AND legacy trio ids as neutral — no id-based fallback (T3)', () => {
        expect(statusPolarity('mystery-mark', builtin)).toBe('neutral');
        expect(statusPolarity('fear', builtin)).toBe('neutral');
        expect(statusPolarity('poison', builtin)).toBe('neutral');
        expect(statusPolarity('stun', builtin)).toBe('neutral');
    });

    it('follows a client OVERRIDE of any id, never the id itself', () => {
        // 'courage' — the legitimate custom status the Status Trials fixture
        // registers (positive modifiers); polarity is definition-derived
        const overridden = registryOf([{ id: 'courage', name: 'Courage', decay: 'stacks', modifiers: { strength: 2 } }]);
        expect(statusPolarity('courage', overridden)).toBe('positive');
    });

    it('reads mixed definitions as negative (safety-first)', () => {
        const mixed = registryOf([{ id: 'trial', modifiers: { strength: 2, defense: -1 } }]);
        expect(statusPolarity('trial', mixed)).toBe('negative');
    });
});

// --- sensible defaults (R2, canonical-only) ----------------------------------

describe('defaultDurationFor', () => {
    it('defaults duration-mode statuses to 3 turns and leaves others without', () => {
        expect(defaultDurationFor({ id: 'poisoned', decay: 'duration' })).toBe(3);
        expect(defaultDurationFor({ id: 'stunned', decay: 'duration', skipChancePerStack: 1 })).toBe(3);
        expect(defaultDurationFor({ id: 'fearful', decay: 'stacks', skipChancePerStack: 0.25 })).toBeUndefined();
        expect(defaultDurationFor({ id: 'marked', decay: 'none' })).toBeUndefined();
        expect(defaultDurationFor(undefined)).toBeUndefined();
    });
});

// --- atomic gear-edit planning (R1, live) ------------------------------------

describe('buildGearEdit', () => {
    it('swaps a one-handed weapon with no normalization (minimal single-entry patch)', () => {
        const plan = buildGearEdit([entry('rusted-dagger', 'weapon-1', 8)], 'weapon-1', 'iron-mace', builtinGear);
        expect(plan).toEqual({ entries: [{ slot: 'weapon-1', id: 'iron-mace' }], notes: [] });
    });

    it('unarmed selection clears the weapon slot and reports the removal', () => {
        const plan = buildGearEdit(
            [entry('longsword', 'weapon-1', 12), entry('warden-mail', 'body', 8)],
            'weapon-1',
            null,
            skirmishGear
        );
        // unrelated armour is untouched — no entry for it, so its live
        // durability is preserved by the engine
        expect(plan).toEqual({
            entries: [{ slot: 'weapon-1', id: null }],
            notes: ['Unarmed selected — weapon Longsword removed.']
        });
    });

    it('a two-handed pick clears a held shield in the SAME atomic patch, with a note', () => {
        const plan = buildGearEdit(
            [entry('rusted-dagger', 'weapon-1', 8), entry('buckler', 'shield', 6), entry('padded-vest', 'body', 10)],
            'weapon-1',
            'great-axe',
            builtinGear
        );
        expect(plan).toEqual({
            entries: [
                { slot: 'weapon-1', id: 'great-axe' },
                { slot: 'shield', id: null }
            ],
            notes: ['Two-handed Great Axe occupies both hands — removed shield Buckler.']
        });
    });

    it('a two-handed pick clears BOTH the off-hand weapon and the shield, in order', () => {
        const plan = buildGearEdit(
            [entry('rusted-dagger', 'weapon-1', 8), entry('iron-mace', 'weapon-2', 10), entry('buckler', 'shield', 6)],
            'weapon-1',
            'great-axe',
            builtinGear
        );
        expect(plan).toEqual({
            entries: [
                { slot: 'weapon-1', id: 'great-axe' },
                { slot: 'weapon-2', id: null },
                { slot: 'shield', id: null }
            ],
            notes: [
                'Two-handed Great Axe occupies both hands — removed off-hand weapon Iron Mace.',
                'Two-handed Great Axe occupies both hands — removed shield Buckler.'
            ]
        });
    });

    it('a shield pick beside weapon + off-hand exceeds the hands budget: refused with a "not equipped" note', () => {
        const plan = buildGearEdit(
            [entry('rusted-dagger', 'weapon-1', 8), entry('iron-mace', 'weapon-2', 10)],
            'shield',
            'buckler',
            builtinGear
        );
        // the requested piece never reached the live loadout — nothing changed
        expect(plan).toEqual({
            entries: [],
            notes: ['Hands budget is 2 — shield Buckler not equipped.']
        });
    });

    it('a shield pick beside a single one-handed weapon fits the budget', () => {
        const plan = buildGearEdit([entry('rusted-dagger', 'weapon-1', 8)], 'shield', 'buckler', builtinGear);
        expect(plan).toEqual({ entries: [{ slot: 'shield', id: 'buckler' }], notes: [] });
    });

    it('shield removal clears the slot and reports the removal (budget stays intact)', () => {
        const plan = buildGearEdit(
            [entry('rusted-dagger', 'weapon-1', 8), entry('buckler', 'shield', 6)],
            'shield',
            null,
            builtinGear
        );
        expect(plan).toEqual({
            entries: [{ slot: 'shield', id: null }],
            notes: ['Shield Buckler removed.']
        });
    });

    it('a shield pick against an already two-handed weapon is refused by the two-handed rule', () => {
        const plan = buildGearEdit([entry('great-axe', 'weapon-1', 10)], 'shield', 'buckler', builtinGear);
        expect(plan).toEqual({
            entries: [],
            notes: ['Two-handed Great Axe occupies both hands — shield Buckler not equipped.']
        });
    });

    it('unknown weapon ids stay in place (conservative one-handed) — the engine validates the id', () => {
        const plan = buildGearEdit([entry('buckler', 'shield', 6)], 'weapon-1', 'mystery-blade', builtinGear);
        expect(plan).toEqual({ entries: [{ slot: 'weapon-1', id: 'mystery-blade' }], notes: [] });
    });

    it('non-hand slots are direct single-entry patches with a removal note on clear', () => {
        const add = buildGearEdit([entry('rusted-dagger', 'weapon-1', 8)], 'head', 'iron-helm', builtinGear);
        expect(add).toEqual({ entries: [{ slot: 'head', id: 'iron-helm' }], notes: [] });
        const clear = buildGearEdit(
            [entry('rusted-dagger', 'weapon-1', 8), entry('iron-helm', 'head', 8)],
            'head',
            null,
            builtinGear
        );
        expect(clear).toEqual({
            entries: [{ slot: 'head', id: null }],
            notes: ['Armour Iron Helm removed from head.']
        });
    });

    it('clearing a piece that is not equipped emits the entry but no note', () => {
        const plan = buildGearEdit([entry('rusted-dagger', 'weapon-1', 8)], 'head', null, builtinGear);
        expect(plan).toEqual({ entries: [{ slot: 'head', id: null }], notes: [] });
    });
});

// --- injury→gear coherence planner (same-atomic-patch clears) ----------------

describe('injuryGearPlan', () => {
    const arms: BodyPart[] = ['left-arm', 'right-arm'];

    it('clears a two-handed weapon in the SAME atomic patch when one arm is lost, with a visible note', () => {
        const plan = injuryGearPlan(
            ['left-arm'],
            [entry('great-axe', 'weapon-1', 10), entry('padded-vest', 'body', 10)],
            builtinGear
        );
        expect(plan).toEqual({
            entries: [{ slot: 'weapon-1', id: null }],
            notes: [
                'left-arm is missing — cleared weapon Great Axe: it is two-handed and one arm is missing. A healed injury cannot restore cleared gear.'
            ]
        });
    });

    it('preserves one-handed gear and unrelated armour when one arm is lost', () => {
        const plan = injuryGearPlan(
            ['right-arm'],
            [entry('rusted-dagger', 'weapon-1', 8), entry('buckler', 'shield', 6), entry('padded-vest', 'body', 10)],
            builtinGear
        );
        expect(plan).toEqual({ entries: [], notes: [] });
    });

    it('one arm left with a two-handed OFF-HAND weapon clears only that piece', () => {
        const plan = injuryGearPlan(
            ['left-arm'],
            [entry('rusted-dagger', 'weapon-1', 8), entry('great-axe', 'weapon-2', 10)],
            builtinGear
        );
        expect(plan).toEqual({
            entries: [{ slot: 'weapon-2', id: null }],
            notes: [
                'left-arm is missing — cleared off-hand weapon Great Axe: it is two-handed and one arm is missing. A healed injury cannot restore cleared gear.'
            ]
        });
    });

    it('both arms lost clears EVERY hand-held piece, each with its own note; armour is preserved', () => {
        const plan = injuryGearPlan(
            arms,
            [
                entry('rusted-dagger', 'weapon-1', 8),
                entry('great-axe', 'weapon-2', 10),
                entry('buckler', 'shield', 6),
                entry('padded-vest', 'body', 10)
            ],
            builtinGear
        );
        expect(plan).toEqual({
            entries: [
                { slot: 'weapon-1', id: null },
                { slot: 'weapon-2', id: null },
                { slot: 'shield', id: null }
            ],
            notes: [
                'left-arm and right-arm are missing — cleared weapon Rusted Dagger: no arms remain to hold it. A healed injury cannot restore cleared gear.',
                'left-arm and right-arm are missing — cleared off-hand weapon Great Axe: no arms remain to hold it. A healed injury cannot restore cleared gear.',
                'left-arm and right-arm are missing — cleared shield Buckler: no arms remain to hold it. A healed injury cannot restore cleared gear.'
            ]
        });
    });

    it('leg/eye/ear injuries never invalidate gear', () => {
        const plan = injuryGearPlan(
            ['left-leg', 'right-eye', 'nose'],
            [entry('great-axe', 'weapon-1', 10), entry('iron-helm', 'head', 8)],
            builtinGear
        );
        expect(plan).toEqual({ entries: [], notes: [] });
    });

    it('no missing arms (fresh or fully healed) plans no clears', () => {
        const plan = injuryGearPlan([], [entry('rusted-dagger', 'weapon-1', 8), entry('buckler', 'shield', 6)], builtinGear);
        expect(plan).toEqual({ entries: [], notes: [] });
    });
});
