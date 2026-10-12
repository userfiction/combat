// ============================================================================
// @userfiction/combat — src/data/validation.test.ts — T2 validation tests
// ============================================================================
// D3 §Validation + task §10 "Unit (validation)" / "Invalid input" rows:
// exact error ARRAYS (collect-all, never fail-fast — reader precedent
// registry.ts L331–344), the §7 canonical example ⇒ { valid: true,
// errors: [] }, team agreement in BOTH directions, ffa separation,
// slots/hands (D5e), catalog patch rules (D9), D8 vocabulary + interpreter
// bounds (depth 16 / lists 32), vocab-registration honesty with and without
// options, and no input mutation (R9). Every assertion is an exact value.
// ============================================================================

import { validateBattleDefinition } from './validation';
import type { BattleDefinition } from '../contract/types';

// ----------------------------------------------------------------------------
// Fixtures — the §7 canonical battle pinned verbatim (task §7), plus a
// minimal valid ffa definition used as the baseline for single-error probes.
// ----------------------------------------------------------------------------

const exampleSkirmish: BattleDefinition = {
    schemaVersion: 1,
    name: 'Crossroads Skirmish',
    mode: 'teams',
    teams: [
        { id: 'crown', name: 'Crown Wardens', members: ['knight', 'rogue'] },
        { id: 'fang', name: 'Fang Cult', members: ['brute'] },
    ],
    catalogs: {
        gear: [
            { id: 'longsword', name: 'Longsword', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 6, blunt: 0, sharp: 0, durability: 12 },
            { id: 'cult-dagger', name: 'Cult Dagger', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 3, blunt: 0, sharp: 0, durability: 10 },
            { id: 'great-mace', name: 'Great Mace', kind: 'weapon', slot: 'weapon-1', handedness: 2, type: 'blunt', damage: 8, blunt: 0, sharp: 0, durability: 10 },
            { id: 'warden-mail', name: 'Warden Mail', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.15, sharp: 0.25, durability: 8 },
            { id: 'cult-mask', name: 'Cult Mask', kind: 'armour', slot: 'head', handedness: 0, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.2, durability: 5 },
        ],
        abilities: [
            {
                id: 'venom-strike', name: 'Venom Strike', cost: 1, cooldown: 2,
                effects: [
                    { type: 'strike' },
                    { type: 'apply-status', target: 'target', status: 'poison', stacks: 2, duration: 3, potency: 2 },
                ],
            },
        ],
    },
    entities: [
        {
            id: 'knight', name: 'Ser Gallant', team: 'crown',
            stats: { health: 30, strength: 8, speed: 1, defense: 3 },
            equipment: {
                weapons: [{ id: 'longsword', slot: 'weapon-1' }],
                armour: [{ id: 'warden-mail', slot: 'body' }],
            },
        },
        {
            id: 'rogue', name: 'Whisper', team: 'crown',
            stats: { health: 20, strength: 5, speed: 2, precision: 2, evasion: 4 },
            equipment: { weapons: [{ id: 'cult-dagger', slot: 'weapon-1' }] },
            abilities: ['venom-strike'],
        },
        {
            id: 'brute', name: 'Fang Brute', team: 'fang',
            stats: { health: 40, strength: 10, speed: 1 },
            statuses: [{ id: 'fear', stacks: 1 }],
            equipment: {
                weapons: [{ id: 'great-mace', slot: 'weapon-1' }],
                armour: [{ id: 'cult-mask', slot: 'head' }],
            },
        },
    ],
    startingConditions: { seed: 7, config: { maxSteps: 5000 } },
    rules: {
        contributions: [
            {
                id: 'terror-edges', hook: 'damage:post',
                when: {
                    type: 'all',
                    of: [
                        { type: 'stat', ref: 'target', stat: 'health', op: 'lte', value: 12 },
                        { type: 'chance', p: 0.3 },
                    ],
                },
                effects: [{ type: 'apply-status', target: 'target', status: 'fear', stacks: 1 }],
            },
        ],
    },
};

// Two bare ffa entities — the smallest valid definition (baseline).
const minimalFfa = (): BattleDefinition => ({
    schemaVersion: 1,
    mode: 'ffa',
    entities: [
        { id: 'a', stats: { health: 10, strength: 1, speed: 1 } },
        { id: 'b', stats: { health: 10, strength: 1, speed: 1 } },
    ],
});

// Shallow-merge a patch over a fresh minimal ffa baseline (single-error probes).
const ffaWith = (patch: Record<string, unknown>): unknown => ({ ...minimalFfa(), ...patch });

// ----------------------------------------------------------------------------
// Happy paths
// ----------------------------------------------------------------------------

describe('valid definitions', () => {
    it('accepts the §7 canonical example with zero errors (R1)', () => {
        expect(validateBattleDefinition(exampleSkirmish)).toEqual({ valid: true, errors: [] });
    });

    it('accepts the minimal two-entity ffa definition', () => {
        expect(validateBattleDefinition(minimalFfa())).toEqual({ valid: true, errors: [] });
    });

    it('accepts ffa with an explicitly empty teams list (D3 "absent/empty")', () => {
        expect(validateBattleDefinition(ffaWith({ teams: [] }))).toEqual({ valid: true, errors: [] });
    });

    it('accepts teams mode with an empty second team — valid data, no-enemies is a RUNTIME outcome (D3/D5g)', () => {
        const definition: BattleDefinition = {
            schemaVersion: 1,
            mode: 'teams',
            teams: [
                { id: 'x', members: ['a', 'b'] },
                { id: 'y', members: [] },
            ],
            entities: [
                { id: 'a', team: 'x', stats: { health: 10, strength: 1, speed: 1 } },
                { id: 'b', team: 'x', stats: { health: 10, strength: 1, speed: 1 } },
            ],
        };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });

    it('accepts a partial catalog patch over a builtin seed id (D9 patch-by-id)', () => {
        const definition = minimalFfa();
        definition.catalogs = { gear: [{ id: 'rusted-dagger', damage: 9 } as never] };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });

    it('accepts seed-boundary values: seed 0 and 2^32-1, speed 0.1 and 100, health 1 and 100000 (D13)', () => {
        const definition = minimalFfa();
        definition.startingConditions = { seed: 0 };
        definition.entities[0].stats = { health: 1, strength: 0, speed: 0.1 };
        definition.entities[1].stats = { health: 100000, strength: 1000, speed: 100, defense: 1000, precision: 1000, evasion: 1000 };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
        definition.startingConditions = { seed: 4294967295 };
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});

// ----------------------------------------------------------------------------
// Hostile top-level inputs — one clean error each, never a throw (D3)
// ----------------------------------------------------------------------------

describe('hostile inputs (strict JSON, collect-all)', () => {
    it('rejects every non-plain-object top-level input with the single definition error', () => {
        const hostiles: unknown[] = [null, undefined, 'battle', 42, true, [], () => ({})];
        hostiles.forEach((hostile) => {
            expect(validateBattleDefinition(hostile)).toEqual({
                valid: false,
                errors: ['definition: expected a plain object'],
            });
        });
    });

    it('rejects a Date in an object position (class instance is not JSON data)', () => {
        const definition = minimalFfa();
        (definition.entities[0] as unknown as Record<string, unknown>).stats = new Date();
        expect(validateBattleDefinition(definition)).toEqual({
            valid: false,
            errors: ['entities[0].stats: expected a plain object'],
        });
    });

    it('rejects a function in a string position', () => {
        expect(validateBattleDefinition(ffaWith({ name: () => 'x' }))).toEqual({
            valid: false,
            errors: ['name: must be a string'],
        });
    });

    it('collects ALL independent errors in one pass, in field order (never fail-fast)', () => {
        expect(validateBattleDefinition({ schemaVersion: 2, mode: 'solo' })).toEqual({
            valid: false,
            errors: [
                'schemaVersion: must be 1',
                "mode: must be one of 'ffa', 'teams'",
                'entities: must be an array of at least 2 entities',
            ],
        });
    });
});

// ----------------------------------------------------------------------------
// Entities + stats (D3: ids unique + pattern, ≥2, stats finite/ranged)
// ----------------------------------------------------------------------------

describe('entities and stats', () => {
    it('rejects a one-entity battle', () => {
        const definition: BattleDefinition = { schemaVersion: 1, mode: 'ffa', entities: [minimalFfa().entities[0]] };
        expect(validateBattleDefinition(definition)).toEqual({
            valid: false,
            errors: ['entities: must be an array of at least 2 entities'],
        });
    });

    it('rejects duplicate entity ids and bad id patterns', () => {
        const definition = minimalFfa();
        definition.entities[1].id = 'a';
        expect(validateBattleDefinition(definition).errors).toEqual(["entities[1].id: duplicate entity id 'a'"]);
        const bad = minimalFfa();
        bad.entities[1].id = 'Knight';
        expect(validateBattleDefinition(bad).errors).toEqual([
            'entities[1].id: must match /^[a-z0-9][a-z0-9-]*$/',
        ]);
    });

    it('rejects out-of-range / non-finite / non-integer stats with exact messages', () => {
        const definition = minimalFfa();
        (definition.entities[0] as { stats: unknown }).stats = {
            health: 0, strength: 'x', speed: Infinity, defense: 1001,
        };
        (definition.entities[1] as { stats: unknown }).stats = {
            health: 10.5, strength: 1, speed: NaN, evasion: -1,
        };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].stats.health: must be an integer between 1 and 100000',
            'entities[0].stats.strength: must be a finite number between 0 and 1000',
            'entities[0].stats.speed: must be a finite number between 0.1 and 100',
            'entities[0].stats.defense: must be a finite number between 0 and 1000',
            'entities[1].stats.health: must be an integer between 1 and 100000',
            'entities[1].stats.speed: must be a finite number between 0.1 and 100',
            'entities[1].stats.evasion: must be a finite number between 0 and 1000',
        ]);
    });

    it('reports missing required stats as range violations on the exact path', () => {
        const definition = minimalFfa();
        (definition.entities[0] as { stats: unknown }).stats = { strength: 1, speed: 1 };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].stats.health: must be an integer between 1 and 100000',
        ]);
    });
});

// ----------------------------------------------------------------------------
// Status instances (D3: pattern, stacks 1..9 int, duration ≥1 int, potency ≥1 int)
// ----------------------------------------------------------------------------

describe('starting status instances', () => {
    it('rejects bad id, stacks, duration and potency with exact messages', () => {
        const definition = minimalFfa();
        definition.entities[0].statuses = [
            { id: 'Fear', stacks: 10, duration: 0, potency: 2.5 } as never,
        ];
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].statuses[0].id: must match /^[a-z0-9][a-z0-9-]*$/',
            'entities[0].statuses[0].stacks: must be an integer between 1 and 9',
            'entities[0].statuses[0].duration: must be an integer >= 1',
            'entities[0].statuses[0].potency: must be an integer >= 1',
        ]);
    });

    it('accepts an open-set custom status id (D5f: semantics need a plugin, data is valid)', () => {
        const definition = minimalFfa();
        definition.entities[0].statuses = [{ id: 'bleeding', stacks: 3, duration: 4, potency: 1 }];
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });
});

// ----------------------------------------------------------------------------
// Team agreement — BOTH directions (D3) + ffa separation
// ----------------------------------------------------------------------------

describe('team agreement (bidirectional, D3)', () => {
    const teamsBase = (): BattleDefinition => ({
        schemaVersion: 1,
        mode: 'teams',
        teams: [
            { id: 'x', members: ['a'] },
            { id: 'y', members: ['b'] },
        ],
        entities: [
            { id: 'a', team: 'x', stats: { health: 10, strength: 1, speed: 1 } },
            { id: 'b', team: 'y', stats: { health: 10, strength: 1, speed: 1 } },
        ],
    });

    it('accepts the agreed baseline', () => {
        expect(validateBattleDefinition(teamsBase())).toEqual({ valid: true, errors: [] });
    });

    it('rejects fewer than two teams', () => {
        const definition = teamsBase();
        definition.teams = [{ id: 'x', members: ['a', 'b'] }];
        definition.entities[1].team = 'x'; // keep agreement valid so ONLY the count error surfaces
        expect(validateBattleDefinition(definition).errors).toEqual([
            'teams: teams mode requires at least 2 teams',
        ]);
    });

    it('rejects an entity that omits its team', () => {
        const definition = teamsBase();
        delete (definition.entities[0] as { team?: string }).team;
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].team: teams mode requires entity 'a' to declare a team",
        ]);
    });

    it('rejects an entity naming a team that omits it (direction entity→team)', () => {
        const definition = teamsBase();
        definition.entities[0].team = 'y'; // y.members = [b], does not list a
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].team: team 'y' does not list entity 'a' in members",
            "teams[0].members[0]: entity 'a' declares team 'y' not 'x'",
        ]);
    });

    it('rejects a member list containing an entity whose team points elsewhere (direction team→members)', () => {
        const definition = teamsBase();
        definition.teams![1].members = ['b', 'a']; // a declares x, not y
        expect(validateBattleDefinition(definition).errors).toEqual([
            "teams[1].members[1]: entity 'a' declares team 'x' not 'y'",
        ]);
    });

    it('rejects unknown team ids, unknown member ids, duplicate teams and duplicate members', () => {
        const definition = teamsBase();
        definition.entities[0].team = 'z';
        definition.teams![0].members = ['a', 'ghost'];
        definition.teams!.push({ id: 'x', members: [] });
        definition.teams![1].members = ['b', 'b'];
        // Order: team declarations (members, then duplicate ids) → entity
        // side → reverse member side (implementation pass order)
        expect(validateBattleDefinition(definition).errors).toEqual([
            "teams[0].members[1]: unknown entity id 'ghost'",
            "teams[1].members[1]: duplicate member id 'b'",
            "teams[2].id: duplicate team id 'x'",
            "entities[0].team: unknown team id 'z'",
            "teams[0].members[0]: entity 'a' declares team 'z' not 'x'",
        ]);
    });

    it('rejects teams declared in ffa mode and entity.team set in ffa mode', () => {
        expect(validateBattleDefinition(ffaWith({ teams: [{ id: 'x', members: [] }] })).errors).toEqual([
            'teams: ffa mode must not declare teams',
        ]);
        const definition = minimalFfa();
        definition.entities[0].team = 'x';
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].team: ffa mode forbids entity.team',
        ]);
    });
});

// ----------------------------------------------------------------------------
// Equipment: refs, slots, hands budget, two-handed (D5e/D9)
// ----------------------------------------------------------------------------

describe('equipment refs and slot/handedness rules (D5e)', () => {
    const armed = (weapons: unknown[], armour?: unknown[]): BattleDefinition => {
        const definition = minimalFfa();
        (definition.entities[0] as { equipment?: unknown }).equipment = { weapons, armour };
        return definition;
    };

    it('resolves refs against the MERGED catalog — builtin seed ids are valid targets (D9)', () => {
        expect(validateBattleDefinition(armed([{ id: 'rusted-dagger', slot: 'weapon-1' }]))).toEqual({
            valid: true,
            errors: [],
        });
    });

    it('rejects unknown gear ids', () => {
        expect(validateBattleDefinition(armed([{ id: 'excalibur', slot: 'weapon-1' }])).errors).toEqual([
            "entities[0].equipment.weapons[0].id: unknown gear id 'excalibur'",
        ]);
    });

    it('rejects a weapon placed outside the weapon slots', () => {
        expect(validateBattleDefinition(armed([{ id: 'rusted-dagger', slot: 'head' }])).errors).toEqual([
            "entities[0].equipment.weapons[0].slot: gear 'rusted-dagger' is a weapon and must go in 'weapon-1' or 'weapon-2'",
        ]);
    });

    it('rejects armour placed on a slot other than its declared slot', () => {
        const definition = armed([], [{ id: 'iron-helm', slot: 'body' }]);
        expect(validateBattleDefinition(definition).errors).toEqual([
            "entities[0].equipment.armour[0].slot: gear 'iron-helm' occupies slot 'head', not 'body'",
        ]);
    });

    it('rejects double occupancy of one slot', () => {
        expect(validateBattleDefinition(armed([
            { id: 'rusted-dagger', slot: 'weapon-1' },
            { id: 'iron-mace', slot: 'weapon-1' },
        ])).errors).toEqual([
            "entities[0].equipment: slot 'weapon-1' occupied by both 'rusted-dagger' and 'iron-mace'",
        ]);
    });

    it('rejects a hands budget over 2 (1h + 1h + shield = 3, D5e)', () => {
        const definition = armed(
            [{ id: 'rusted-dagger', slot: 'weapon-1' }, { id: 'iron-mace', slot: 'weapon-2' }],
            [{ id: 'buckler', slot: 'shield' }],
        );
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].equipment: hands budget exceeded (3 > 2)',
        ]);
    });

    it('rejects occupants beside a two-handed weapon AND the resulting budget breach', () => {
        const definition = armed(
            [{ id: 'great-axe', slot: 'weapon-1' }],
            [{ id: 'buckler', slot: 'shield' }],
        );
        expect(validateBattleDefinition(definition).errors).toEqual([
            'entities[0].equipment: hands budget exceeded (3 > 2)',
            "entities[0].equipment: two-handed gear 'great-axe' forbids 'weapon-2' and 'shield' occupants",
        ]);
    });

    it('accepts a two-handed weapon alone (hands 2, no weapon-2/shield)', () => {
        const definition = armed([{ id: 'great-axe', slot: 'weapon-1' }]);
        expect(validateBattleDefinition(definition)).toEqual({ valid: true, errors: [] });
    });

    it('validates the per-instance durability override range and slot enum', () => {
        expect(validateBattleDefinition(armed([{ id: 'rusted-dagger', slot: 'weapon-1', durability: 0 }])).errors).toEqual([
            'entities[0].equipment.weapons[0].durability: must be an integer between 1 and 2000',
        ]);
        expect(validateBattleDefinition(armed([{ id: 'rusted-dagger', slot: 'wing' }])).errors).toEqual([
            "entities[0].equipment.weapons[0].slot: must be one of 'weapon-1', 'weapon-2', 'shield', 'head', 'body', 'hands', 'feet'",
            "entities[0].equipment.weapons[0].slot: gear 'rusted-dagger' is a weapon and must go in 'weapon-1' or 'weapon-2'",
        ]);
    });
});

// ----------------------------------------------------------------------------
// Catalogs (D9 shared fields + patch semantics at the definition level)
// ----------------------------------------------------------------------------

describe('catalog gear entries (D9)', () => {
    const withGear = (gear: unknown[]): BattleDefinition => {
        const definition = minimalFfa();
        (definition as { catalogs?: unknown }).catalogs = { gear };
        return definition;
    };

    it('requires every shared field on a NEW id — exact eight-error list', () => {
        expect(validateBattleDefinition(withGear([{ id: 'ghost-blade' }])).errors).toEqual([
            'catalogs.gear[0].kind: required',
            'catalogs.gear[0].slot: required',
            'catalogs.gear[0].handedness: required',
            'catalogs.gear[0].type: required',
            'catalogs.gear[0].damage: required',
            'catalogs.gear[0].blunt: required',
            'catalogs.gear[0].sharp: required',
            'catalogs.gear[0].durability: required',
        ]);
    });

    it('validates the shared-field ranges: damage, durability, blunt/sharp, handedness, kind, type', () => {
        expect(validateBattleDefinition(withGear([{
            id: 'doom-hammer', kind: 'weapon', slot: 'weapon-1', handedness: 3,
            type: 'poison', damage: 1001, blunt: 1.5, sharp: -0.2, durability: 2.5,
        }])).errors).toEqual([
            "catalogs.gear[0].handedness: must be one of 0, 1, 2",
            "catalogs.gear[0].type: must be one of 'blunt', 'sharp'",
            'catalogs.gear[0].damage: must be a finite number between 0 and 1000',
            'catalogs.gear[0].blunt: must be a finite number between 0 and 1',
            'catalogs.gear[0].sharp: must be a finite number between 0 and 1',
            'catalogs.gear[0].durability: must be an integer between 1 and 2000',
        ]);
    });

    it('enforces kind→slot mapping on definitions', () => {
        expect(validateBattleDefinition(withGear([{
            id: 'face-veil', kind: 'armour', slot: 'weapon-2', handedness: 0,
            type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.1, durability: 4,
        }])).errors).toEqual([
            "catalogs.gear[0].slot: armour gear must use 'head', 'body', 'hands', 'feet' or 'shield'",
        ]);
        expect(validateBattleDefinition(withGear([{
            id: 'war-lance', kind: 'weapon', slot: 'body', handedness: 2,
            type: 'sharp', damage: 7, blunt: 0, sharp: 0, durability: 9,
        }])).errors).toEqual([
            "catalogs.gear[0].slot: weapon gear must use 'weapon-1' or 'weapon-2'",
        ]);
    });

    it('enforces shield handedness 1 and body-part armour handedness 0 (D5e)', () => {
        expect(validateBattleDefinition(withGear([{
            id: 'tower-shield', kind: 'armour', slot: 'shield', handedness: 0,
            type: 'blunt', damage: 0, blunt: 0.3, sharp: 0.3, durability: 20,
        }])).errors).toEqual([
            "catalogs.gear[0].handedness: shield gear must have handedness 1",
        ]);
        expect(validateBattleDefinition(withGear([{
            id: 'plate-gauntlets', kind: 'armour', slot: 'hands', handedness: 1,
            type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.1, durability: 6,
        }])).errors).toEqual([
            "catalogs.gear[0].handedness: armour gear in slot 'hands' must have handedness 0",
        ]);
    });

    it('catches a PATCH that breaks an invariant on the folded effective entry (buckler moved to body keeps handedness 1)', () => {
        expect(validateBattleDefinition(withGear([{ id: 'buckler', slot: 'body' }])).errors).toEqual([
            "catalogs.gear[0].handedness: armour gear in slot 'body' must have handedness 0",
        ]);
    });
});

describe('catalog ability entries (D9)', () => {
    const withAbility = (abilities: unknown[], entityAbilities?: string[]): BattleDefinition => {
        const definition = minimalFfa();
        (definition as { catalogs?: unknown }).catalogs = { abilities };
        if (entityAbilities) {
            definition.entities[0].abilities = entityAbilities;
        }
        return definition;
    };

    it('requires effects on a new ability and validates cost/cooldown ranges', () => {
        expect(validateBattleDefinition(withAbility([{ id: 'bash', cost: 0.1, cooldown: -1 }])).errors).toEqual([
            'catalogs.abilities[0].cost: must be a finite number between 0.25 and 10',
            'catalogs.abilities[0].cooldown: must be an integer >= 0',
            'catalogs.abilities[0].effects: required',
        ]);
    });

    it('validates the availability gate condition against the D8 vocabulary', () => {
        expect(validateBattleDefinition(withAbility([{
            id: 'lunge',
            conditions: { type: 'stat', ref: 'foe', stat: 'moxie', op: 'ne', value: 'x' },
            effects: [],
        }])).errors).toEqual([
            "catalogs.abilities[0].conditions.ref: must be one of 'attacker', 'target', 'self'",
            "catalogs.abilities[0].conditions.stat: must be one of 'health', 'strength', 'speed', 'defense', 'precision', 'evasion'",
            "catalogs.abilities[0].conditions.op: must be one of 'lt', 'lte', 'gt', 'gte', 'eq'",
            'catalogs.abilities[0].conditions.value: must be a finite number',
        ]);
    });

    it('rejects entity ability ids that do not resolve', () => {
        expect(validateBattleDefinition(withAbility([{ id: 'sweep', effects: [{ type: 'strike' }] }], ['sweep', 'fly'])).errors).toEqual([
            "entities[0].abilities[1]: unknown ability id 'fly'",
        ]);
    });
});

// ----------------------------------------------------------------------------
// startingConditions (D3/D13)
// ----------------------------------------------------------------------------

describe('startingConditions and config bounds', () => {
    it('rejects out-of-range seed and every config limit with exact messages', () => {
        const definition = minimalFfa();
        (definition as { startingConditions?: unknown }).startingConditions = {
            seed: 4294967296,
            config: { maxSteps: 0, maxCascade: 100001, maxLogEvents: 1e6 + 1 },
        };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'startingConditions.seed: must be an integer between 0 and 4294967295',
            'startingConditions.config.maxSteps: must be an integer between 1 and 1000000',
            'startingConditions.config.maxCascade: must be an integer between 1 and 100000',
            'startingConditions.config.maxLogEvents: must be an integer between 1 and 1000000',
        ]);
    });

    it('rejects a non-integer seed', () => {
        const definition = minimalFfa();
        (definition as { startingConditions?: unknown }).startingConditions = { seed: 1.5 };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'startingConditions.seed: must be an integer between 0 and 4294967295',
        ]);
    });
});

// ----------------------------------------------------------------------------
// Declarative rules — D8 vocabulary + interpreter bounds + chain-only hooks
// ----------------------------------------------------------------------------

// Build a not-of-not chain: n wrappers ⇒ innermost node depth n + 1.
const nestNot = (wrappers: number): { type: string; of: unknown } => {
    let condition: unknown = { type: 'always' };
    for (let index = 0; index < wrappers; index += 1) {
        condition = { type: 'not', of: condition };
    }
    return condition as { type: string; of: unknown };
};

const withRule = (rule: unknown): BattleDefinition => {
    const definition = minimalFfa();
    (definition as { rules?: unknown }).rules = { contributions: [rule] };
    return definition;
};

describe('declarative rules (D8/D6)', () => {
    it('rejects single-mode hook ids — contributions are chain-only (D3/D6)', () => {
        expect(validateBattleDefinition(withRule({ id: 'r', hook: 'damage:base', effects: [] })).errors).toEqual([
            "rules.contributions[0].hook: must be one of 'attack:pre', 'damage:post', 'equipment:post', 'status:turn-end', 'step:end'",
        ]);
    });

    it('requires effects and unique rule ids', () => {
        const definition = minimalFfa();
        (definition as { rules?: unknown }).rules = {
            contributions: [
                { id: 'dup', hook: 'step:end' },
                { id: 'dup', hook: 'step:end', effects: [] },
            ],
        };
        expect(validateBattleDefinition(definition).errors).toEqual([
            'rules.contributions[0].effects: required',
            "rules.contributions[1].id: duplicate rule id 'dup'",
        ]);
    });

    it('rejects unknown builtin-shaped condition and effect types', () => {
        expect(validateBattleDefinition(withRule({ id: 'r', hook: 'step:end', when: { type: 'near-death' }, effects: [{ type: 'zap' }] })).errors).toEqual([
            "rules.contributions[0].when.type: unknown condition type 'near-death'",
            "rules.contributions[0].effects[0].type: unknown effect type 'zap'",
        ]);
    });

    it('validates condition fields: ref/stat/op/value, chance p, status id, mode is', () => {
        expect(validateBattleDefinition(withRule({
            id: 'r', hook: 'step:end',
            when: { type: 'any', of: [
                { type: 'stat', ref: 'other', stat: 'luck', op: 'between', value: Number.NaN },
                { type: 'chance', p: 1.5 },
                { type: 'has-status', ref: 'self', status: 'Burning' },
                { type: 'mode', is: 'duel' },
            ] },
            effects: [],
        })).errors).toEqual([
            "rules.contributions[0].when.of[0].ref: must be one of 'attacker', 'target', 'self'",
            "rules.contributions[0].when.of[0].stat: must be one of 'health', 'strength', 'speed', 'defense', 'precision', 'evasion'",
            "rules.contributions[0].when.of[0].op: must be one of 'lt', 'lte', 'gt', 'gte', 'eq'",
            'rules.contributions[0].when.of[0].value: must be a finite number',
            'rules.contributions[0].when.of[1].p: must be a finite number between 0 and 1',
            'rules.contributions[0].when.of[2].status: must match /^[a-z0-9][a-z0-9-]*$/',
            "rules.contributions[0].when.of[3].is: must be one of 'ffa', 'teams'",
        ]);
    });

    it('validates effect fields: target, amount floors, damageType, stat, message, status ranges', () => {
        expect(validateBattleDefinition(withRule({
            id: 'r', hook: 'step:end',
            effects: [
                { type: 'damage-flat', target: 'foe', amount: -3, damageType: 'fire' },
                { type: 'heal', target: 'target' },
                { type: 'apply-status', target: 'self', status: 'fear', stacks: 10, duration: 0, potency: 0 },
                { type: 'modify-stat', target: 'self', stat: 'morale', amount: Number.NaN, duration: -1 },
                { type: 'emit' },
            ],
        })).errors).toEqual([
            "rules.contributions[0].effects[0].target: must be one of 'attacker', 'target', 'self'",
            'rules.contributions[0].effects[0].amount: must be a finite number >= 0',
            "rules.contributions[0].effects[0].damageType: must be one of 'blunt', 'sharp', 'true'",
            'rules.contributions[0].effects[1].amount: must be a finite number >= 0',
            'rules.contributions[0].effects[2].stacks: must be an integer between 1 and 9',
            'rules.contributions[0].effects[2].duration: must be an integer >= 1',
            'rules.contributions[0].effects[2].potency: must be an integer >= 1',
            "rules.contributions[0].effects[3].stat: must be one of 'health', 'strength', 'speed', 'defense', 'precision', 'evasion'",
            'rules.contributions[0].effects[3].amount: must be a finite number',
            'rules.contributions[0].effects[3].duration: must be an integer >= 0',
            'rules.contributions[0].effects[4].message: must be a string',
        ]);
    });

    it('bounds interpreter nesting at depth 16 — 15 wrappers valid, 16 exceeds (D8)', () => {
        expect(validateBattleDefinition(withRule({ id: 'r', hook: 'step:end', when: nestNot(15), effects: [] }))).toEqual({
            valid: true,
            errors: [],
        });
        expect(validateBattleDefinition(withRule({ id: 'r', hook: 'step:end', when: nestNot(16), effects: [] })).errors).toEqual([
            `rules.contributions[0].when${'.of'.repeat(16)}: condition nesting exceeds depth 16`,
        ]);
    });

    it('bounds condition and effect lists at 32 (D8)', () => {
        const wide = { type: 'all', of: Array.from({ length: 33 }, () => ({ type: 'always' })) };
        expect(validateBattleDefinition(withRule({ id: 'r', hook: 'step:end', when: wide, effects: [] })).errors).toEqual([
            'rules.contributions[0].when.of: must be an array of at most 32 conditions',
        ]);
        expect(validateBattleDefinition(withRule({
            id: 'r', hook: 'step:end',
            effects: Array.from({ length: 33 }, () => ({ type: 'strike' })),
        })).errors).toEqual([
            'rules.contributions[0].effects: must be an array of at most 32 effects',
        ]);
    });

    it('accepts has-gear conditions with optional kind/slot and rejects bad ones', () => {
        expect(validateBattleDefinition(withRule({
            id: 'r', hook: 'step:end',
            when: { type: 'has-gear', ref: 'target', kind: 'armour', slot: 'shield' },
            effects: [{ type: 'break-equipment', target: 'target', slot: 'shield' }],
        }))).toEqual({ valid: true, errors: [] });
        expect(validateBattleDefinition(withRule({
            id: 'r', hook: 'step:end',
            when: { type: 'has-gear', ref: 'target', kind: 'ring', slot: 'finger' },
            effects: [{ type: 'break-equipment', target: 'target', slot: 'finger' }],
        })).errors).toEqual([
            "rules.contributions[0].when.kind: must be one of 'weapon', 'armour'",
            "rules.contributions[0].when.slot: must be one of 'weapon-1', 'weapon-2', 'shield', 'head', 'body', 'hands', 'feet'",
            "rules.contributions[0].effects[0].slot: must be one of 'weapon-1', 'weapon-2', 'shield', 'head', 'body', 'hands', 'feet'",
        ]);
    });
});

// ----------------------------------------------------------------------------
// Vocab registration honesty (D8 + brief): public single-input call accepts
// namespaced types as shape-valid data; the engine passes registered ids and
// unregistered namespaced types then become errors.
// ----------------------------------------------------------------------------

describe('namespaced plugin vocab types (D8)', () => {
    const customRule = withRule({
        id: 'r', hook: 'step:end',
        when: { type: 'seer/omen', ref: 'self' },
        effects: [{ type: 'mishap/gravity-flip', target: 'target' }],
    });

    it('accepts namespaced condition/effect types when no vocab options are supplied (public UI path)', () => {
        expect(validateBattleDefinition(customRule)).toEqual({ valid: true, errors: [] });
    });

    it('rejects namespaced types the loaded plugins do not register (engine path)', () => {
        expect(validateBattleDefinition(customRule, {
            vocab: { conditions: ['seer/omen'], effects: ['other/thing'] },
        }).errors).toEqual([
            "rules.contributions[0].effects[0].type: unknown effect type 'mishap/gravity-flip' (no loaded plugin registers it)",
        ]);
    });

    it('accepts namespaced types once registered (engine path, both vocab kinds)', () => {
        expect(validateBattleDefinition(customRule, {
            vocab: { conditions: ['seer/omen'], effects: ['mishap/gravity-flip'] },
        })).toEqual({ valid: true, errors: [] });
    });

    it('validates ability effects against the same vocab options', () => {
        const definition = minimalFfa();
        (definition as { catalogs?: unknown }).catalogs = {
            abilities: [{ id: 'flip', effects: [{ type: 'mishap/gravity-flip' }] }],
        };
        expect(validateBattleDefinition(definition, { vocab: { effects: [] } }).errors).toEqual([
            "catalogs.abilities[0].effects[0].type: unknown effect type 'mishap/gravity-flip' (no loaded plugin registers it)",
        ]);
    });
});

// ----------------------------------------------------------------------------
// R9 — no input mutation
// ----------------------------------------------------------------------------

describe('purity', () => {
    it('never mutates the input definition (deep-equal before/after, R9)', () => {
        const before = JSON.parse(JSON.stringify(exampleSkirmish));
        const broken = JSON.parse(JSON.stringify(exampleSkirmish));
        (broken.entities[0] as Record<string, unknown>).team = 'nope';
        validateBattleDefinition(exampleSkirmish);
        validateBattleDefinition(broken);
        expect(exampleSkirmish).toEqual(before);
    });
});
