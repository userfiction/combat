// ============================================================================
// @userfiction/combat — src/data/status-catalog.test.ts — T2 R1 status
// registry + definition resolution + validation of the T2 surface
// ============================================================================
// Pins the status-definition registry plumbing (catalogs.statuses patch
// semantics over defaultStatusSeed, mirroring the D9 gear fold), the
// resolveBattleDefinition T2 normalization (energy alias fold, injuries
// dedupe) and the exact validation error messages for every new T2 data
// site. All assertions are exact values derived from the contract in
// contract/types.ts (D13 bounds included verbatim).
// ============================================================================

import {
    BODY_PARTS,
    COMBAT_SCHEMA_VERSION,
    RESOURCE_KEYS,
    STATUS_DECAY_MODES,
    defaultGearSeed,
    defaultStatusSeed,
    validateBattleDefinition,
} from '../../index';
import type { BattleDefinition } from '../../index';
// mergeStatusCatalog / resolveBattleDefinition are internal integration
// helpers (src/index.ts exports the public surface only) — sibling import,
// same convention as catalogs.test.ts.
import { mergeStatusCatalog, resolveBattleDefinition } from './catalogs';

// Minimal valid ffa definition every fixture mutates (D3: ≥2 entities).
const minimalFfa = (): BattleDefinition => ({
    schemaVersion: COMBAT_SCHEMA_VERSION,
    mode: 'ffa',
    entities: [
        { id: 'a', stats: { health: 10, strength: 0, speed: 1 } },
        { id: 'b', stats: { health: 10, strength: 0, speed: 1 } },
    ],
});

// ----------------------------------------------------------------------------
// Registered defaults (R1) — the seed is a CONTRACT (fixed list, pinned).
// ----------------------------------------------------------------------------

describe('defaultStatusSeed (R1 registered defaults)', () => {
    it('is the exact builtin ailment/buff set: aliases + bleeding/burned/blinded + beneficial buffs', () => {
        expect(defaultStatusSeed.map((definition) => definition.id)).toEqual([
            'fearful', 'poisoned', 'bleeding', 'burned', 'blinded', 'blessed', 'hasted',
        ]);
        expect(defaultStatusSeed[0]).toEqual({ id: 'fearful', name: 'Fearful', decay: 'stacks', skipChancePerStack: 0.25 });
        expect(defaultStatusSeed[1]).toEqual({ id: 'poisoned', name: 'Poisoned', decay: 'duration', tick: { damage: 1 } });
        expect(defaultStatusSeed[2]).toEqual({ id: 'bleeding', name: 'Bleeding', decay: 'duration', tick: { damage: 2 } });
        expect(defaultStatusSeed[3]).toEqual({ id: 'burned', name: 'Burned', decay: 'duration', tick: { damage: 3 } });
        expect(defaultStatusSeed[4]).toEqual({ id: 'blinded', name: 'Blinded', decay: 'duration', modifiers: { precision: -2 } });
        expect(defaultStatusSeed[5]).toEqual({ id: 'blessed', name: 'Blessed', decay: 'duration', modifiers: { defense: 2, evasion: 1 } });
        expect(defaultStatusSeed[6]).toEqual({ id: 'hasted', name: 'Hasted', decay: 'duration', modifiers: { speed: 1 } });
    });

    it('exposes the closed T2 vocabularies verbatim (legacy trio ids are NOT registered defaults)', () => {
        expect(BODY_PARTS).toEqual([
            'left-arm', 'right-arm', 'left-leg', 'right-leg',
            'left-eye', 'right-eye', 'left-ear', 'right-ear', 'nose',
        ]);
        expect(RESOURCE_KEYS).toEqual(['stamina', 'mana']);
        expect(STATUS_DECAY_MODES).toEqual(['stacks', 'duration', 'none']);
        expect(defaultStatusSeed.some((definition) => ['fear', 'poison', 'stun'].includes(definition.id))).toBe(false);
    });
});

// ----------------------------------------------------------------------------
// mergeStatusCatalog — patch semantics identical to the D9 gear fold.
// ----------------------------------------------------------------------------

describe('mergeStatusCatalog (R1 patch semantics)', () => {
    it('patches a known id keeping unspecified fields, appends new ids in first-listed order', () => {
        const merged = mergeStatusCatalog(defaultStatusSeed, [
            { id: 'bleeding', tick: { damage: 7 } },          // patch: tick only
            { id: 'screaming', decay: 'stacks', skipChancePerStack: 1 },  // new id
        ]);
        expect(merged.map((definition) => definition.id)).toEqual([
            'fearful', 'poisoned', 'bleeding', 'burned', 'blinded', 'blessed', 'hasted', 'screaming',
        ]);
        // patched bleeding keeps the seed's decay, overrides the tick
        expect(merged[2]).toEqual({ id: 'bleeding', name: 'Bleeding', decay: 'duration', tick: { damage: 7 } });
        expect(merged[7]).toEqual({ id: 'screaming', decay: 'stacks', skipChancePerStack: 1 });
    });

    it('later patches override earlier ones for the same id; undefined never erases', () => {
        const merged = mergeStatusCatalog(defaultStatusSeed, [
            { id: 'burned', tick: { damage: 9 } },
            { id: 'burned', tick: { damage: 4 } },
        ]);
        expect(merged.find((definition) => definition.id === 'burned')).toEqual({
            id: 'burned', name: 'Burned', decay: 'duration', tick: { damage: 4 },
        });
    });

    it('returns a copy of the seed when no patches are given (caller mutations never leak in)', () => {
        const merged = mergeStatusCatalog(defaultStatusSeed, undefined);
        expect(merged).toEqual(defaultStatusSeed.map((definition) => ({ ...definition })));
        merged[0].skipChancePerStack = 9;
        expect(defaultStatusSeed[0].skipChancePerStack).toBe(0.25);
    });
});

// ----------------------------------------------------------------------------
// resolveBattleDefinition — T2 normalization (statuses fold, energy alias,
// injuries dedupe) inside the D10 "resolved copy (catalogs merged)".
// ----------------------------------------------------------------------------

describe('resolveBattleDefinition T2 normalization', () => {
    it('folds catalogs.statuses over defaultStatusSeed and keeps gear/abilities behavior unchanged', () => {
        const definition = minimalFfa();
        definition.catalogs = { statuses: [{ id: 'bleeding', tick: { damage: 7 } }] };
        const resolved = resolveBattleDefinition(definition);
        expect(resolved.catalogs!.statuses!.map((entry) => entry.id)).toEqual(defaultStatusSeed.map((entry) => entry.id));
        expect(resolved.catalogs!.statuses!.find((entry) => entry.id === 'bleeding')).toEqual({
            id: 'bleeding', name: 'Bleeding', decay: 'duration', tick: { damage: 7 },
        });
        // gear merge unchanged (D9 pin rides along — the effective catalog is the builtin seed)
        expect(resolved.catalogs!.gear!.map((entry) => entry.id)).toEqual(defaultGearSeed.map((entry) => entry.id));
    });

    it('normalizes the energy alias into stamina for actor resources and ability costs (no section ⇒ untouched)', () => {
        const definition = minimalFfa();
        definition.entities[0].resources = { energy: { current: 4, max: 4 } };
        definition.entities[1].resources = { mana: { current: 2, max: 2 } };
        definition.catalogs = { abilities: [{ id: 'drain', effects: [], costs: { energy: 2, mana: 1 } }] };
        const resolved = resolveBattleDefinition(definition);
        // energy never survives resolution; mana pools/costs pass through
        expect(resolved.entities[0].resources).toEqual({ stamina: { current: 4, max: 4 } });
        expect(resolved.entities[1].resources).toEqual({ mana: { current: 2, max: 2 } });
        expect(resolved.catalogs!.abilities![0].costs).toEqual({ stamina: 2, mana: 1 });
    });

    it('both-present energy conflicts keep stamina (validation rejects the battle; normalization stays crash-safe)', () => {
        const definition = minimalFfa();
        definition.entities[0].resources = { stamina: { current: 1, max: 1 }, energy: { current: 9, max: 9 } };
        const resolved = resolveBattleDefinition(definition);
        expect(resolved.entities[0].resources).toEqual({ stamina: { current: 1, max: 1 } });
    });

    it('dedupes and filters injuries in listed order; the input is never mutated', () => {
        const definition = minimalFfa();
        definition.entities[0].injuries = ['left-leg', 'left-leg', 'ghost-limb', 'nose'];
        const before = JSON.parse(JSON.stringify(definition));
        const resolved = resolveBattleDefinition(definition);
        expect(resolved.entities[0].injuries).toEqual(['left-leg', 'nose']);
        expect(JSON.parse(JSON.stringify(definition))).toEqual(before);
    });

    it('a catalogs section without statuses gains the full merged seed (registry is inspectable on the definition)', () => {
        const definition = minimalFfa();
        definition.catalogs = { gear: [] };
        const resolved = resolveBattleDefinition(definition);
        expect(resolved.catalogs!.statuses!.map((entry) => entry.id)).toEqual(defaultStatusSeed.map((entry) => entry.id));
    });
});

// ----------------------------------------------------------------------------
// Validation — exact collected error lists for every new T2 data site.
// ----------------------------------------------------------------------------

describe('validation: status-definition catalog (R1)', () => {
    it('collects id/decay/modifier/tick/skip errors with exact messages and bounds', () => {
        const definition = minimalFfa();
        definition.catalogs = {
            statuses: [
                {
                    id: 'bad status!',
                    decay: 'forever',
                    skipChancePerStack: 2,
                    modifiers: { spirit: 1, precision: 1001 },
                    tick: { damage: -1, heal: 100_001 },
                },
            ],
        };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'catalogs.statuses[0].id: must match /^[a-z0-9][a-z0-9-]*$/',
            "catalogs.statuses[0].decay: must be one of 'stacks', 'duration', 'none'",
            'catalogs.statuses[0].skipChancePerStack: must be a finite number between 0 and 1',
            "catalogs.statuses[0].modifiers['spirit']: unknown stat key",
            "catalogs.statuses[0].modifiers['precision']: must be a finite number between -1000 and 1000",
            'catalogs.statuses[0].tick.damage: must be a finite number between 0 and 100000',
            'catalogs.statuses[0].tick.heal: must be a finite number between 0 and 100000',
        ]);
    });

    it('accepts a minimal new definition (id only — every other field defaults) and full well-formed entries', () => {
        const definition = minimalFfa();
        definition.catalogs = {
            statuses: [
                { id: 'weightless', name: 'Weightless', decay: 'duration', modifiers: { speed: 1 }, tick: { heal: 2 }, skipChancePerStack: 0.5 },
                { id: 'brand-new' },
            ],
        };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});

describe('validation: injuries (R2)', () => {
    it('rejects unknown parts, non-arrays and duplicates with exact messages', () => {
        const definition = minimalFfa();
        definition.entities[0].injuries = ['left-leg', 'tail', 'left-leg'];
        expect(validateBattleDefinition(definition).errors).toEqual([
            `entities[0].injuries[1]: must be one of ${BODY_PARTS.map((part) => `'${part}'`).join(', ')}`,
            'entities[0].injuries[2]: duplicate body part \'left-leg\'',
        ]);
        const notArray = minimalFfa();
        (notArray.entities[0] as { injuries?: unknown }).injuries = 'left-leg';
        expect(validateBattleDefinition(notArray).errors).toEqual(['entities[0].injuries: must be an array']);
    });
});

describe('validation: resource pools (R3)', () => {
    it('rejects alias conflicts, unknown pools, fractional/negative/out-of-range values and current > max', () => {
        const definition = minimalFfa();
        definition.entities[0].resources = {
            stamina: { current: 5, max: 4 },
            energy: { current: 0, max: 0 },
            spirit: { current: 0, max: 0 },
        };
        definition.entities[1].resources = { mana: { current: -1, max: 1_000_001 } };
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].resources: 'stamina' and alias 'energy' must not both be present",
            'entities[0].resources.stamina.current: must not exceed max (5 > 4)',
            "entities[0].resources['spirit']: unknown resource pool (expected stamina, mana or the energy alias)",
            'entities[1].resources.mana.current: must be an integer between 0 and 1000000',
            'entities[1].resources.mana.max: must be an integer between 0 and 1000000',
        ]);
    });

    it('accepts the energy alias alone and well-formed pools', () => {
        const definition = minimalFfa();
        definition.entities[0].resources = { energy: { current: 4, max: 4 }, mana: { current: 0, max: 9 } };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});

describe('validation: skill resource costs (R3)', () => {
    it('rejects alias conflicts, unknown keys and out-of-range values with exact messages', () => {
        const definition = minimalFfa();
        definition.catalogs = {
            abilities: [
                { id: 'bad-costs', effects: [], costs: { stamina: 1, energy: 2, willpower: 3, mana: -0.5 } },
            ],
        };
        expect(validateBattleDefinition(definition).errors).toEqual([
            "catalogs.abilities[0].costs: 'stamina' and alias 'energy' must not both be present",
            'catalogs.abilities[0].costs.mana: must be a finite number between 0 and 1000000',
            "catalogs.abilities[0].costs.['willpower']: unknown resource cost key (expected health, stamina, mana or the energy alias)",
        ]);
    });

    it('accepts the energy alias and health costs within bounds', () => {
        const definition = minimalFfa();
        definition.catalogs = { abilities: [{ id: 'priced', effects: [], costs: { health: 3, energy: 2 } }] };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});

describe('validation: skills alias (R4)', () => {
    it('resolves skills against the ability catalog and rejects presenting both aliases', () => {
        const definition = minimalFfa();
        definition.catalogs = { abilities: [{ id: 'sweep', effects: [{ type: 'strike' }] }] };
        definition.entities[0].abilities = ['sweep'];
        definition.entities[0].skills = ['sweep'];
        definition.entities[1].skills = ['missing'];
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].abilities: 'abilities' and alias 'skills' must not both be present",
            "entities[1].skills[0]: unknown skill id 'missing'",
        ]);
    });

    it('skills alone validate exactly like abilities (ids resolve, pattern enforced)', () => {
        const definition = minimalFfa();
        definition.catalogs = { abilities: [{ id: 'sweep', effects: [{ type: 'strike' }] }] };
        definition.entities[0].skills = ['sweep', 'fly'];
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].skills[1]: unknown skill id 'fly'",
        ]);
    });
});

describe('validation: equipment × anatomy coherence (R2)', () => {
    const greatAxe = { id: 'great-axe', kind: 'weapon' as const, slot: 'weapon-1' as const, handedness: 2 as const, type: 'sharp' as const, damage: 8, blunt: 0, sharp: 0, durability: 10 };
    const dagger = { id: 'dagger', kind: 'weapon' as const, slot: 'weapon-1' as const, handedness: 1 as const, type: 'sharp' as const, damage: 3, blunt: 0, sharp: 0, durability: 8 };
    const buckler = { id: 'buckler', kind: 'armour' as const, slot: 'shield' as const, handedness: 1 as const, type: 'sharp' as const, damage: 0, blunt: 0.1, sharp: 0.1, durability: 6 };

    it('two-handed gear needs BOTH arms; any weapon or shield needs ≥ 1; with no arms everything hand-held is rejected', () => {
        const oneArm = minimalFfa();
        oneArm.entities[0].injuries = ['right-arm'];
        oneArm.catalogs = { gear: [greatAxe, dagger, buckler] };
        oneArm.entities[0].equipment = { weapons: [{ id: 'great-axe', slot: 'weapon-1' }] };
        expect(validateBattleDefinition(oneArm).errors).toEqual([
            "entities[0].equipment: two-handed gear 'great-axe' requires two available arms (one is missing)",
        ]);

        const noArms = minimalFfa();
        noArms.entities[0].injuries = ['left-arm', 'right-arm'];
        noArms.catalogs = { gear: [greatAxe, dagger, buckler] };
        noArms.entities[0].equipment = { weapons: [{ id: 'dagger', slot: 'weapon-1' }], armour: [{ id: 'buckler', slot: 'shield' }] };
        expect(validateBattleDefinition(noArms).errors).toEqual([
            "entities[0].equipment: 'dagger' in slot 'weapon-1' requires an arm but both arms are missing",
            "entities[0].equipment: 'buckler' in slot 'shield' requires an arm but both arms are missing",
        ]);
    });

    it('a one-armed warrior with a one-handed weapon and no shield is valid', () => {
        const definition = minimalFfa();
        definition.entities[0].injuries = ['right-arm'];
        definition.catalogs = { gear: [dagger] };
        definition.entities[0].equipment = { weapons: [{ id: 'dagger', slot: 'weapon-1' }] };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});
