// ============================================================================
// @userfiction/combat — src/catalogs.test.ts — T2 gear catalog tests
// ============================================================================
// Pins the D9 catalog contract with exact values: the builtin seed list,
// patch-by-id semantics (undefined never erases — item-registry L103–124
// precedent), copy-on-read isolation, deterministic listing order, and
// resolveBattleDefinition's catalog merge (D10 "resolved copy (catalogs
// merged)"). Deterministic per the shared test standards: toEqual on full
// outputs, no range checks on known values.
// ============================================================================

import {
    createGearCatalog,
    defaultGearSeed,
    mergeGearCatalog,
    resolveBattleDefinition,
} from './catalogs';
import type { BattleDefinition, GearDefinition } from './types';

// The canonical seed, hardcoded independently of the module so a drift in
// catalogs.ts is a FAILURE, not a tautology (D9: "exact seed fixed in
// catalogs.ts and pinned by test").
const CANONICAL_SEED: GearDefinition[] = [
    { id: 'rusted-dagger', name: 'Rusted Dagger', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 3, blunt: 0, sharp: 0, durability: 8 },
    { id: 'iron-mace', name: 'Iron Mace', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'blunt', damage: 5, blunt: 0, sharp: 0, durability: 10 },
    { id: 'great-axe', name: 'Great Axe', kind: 'weapon', slot: 'weapon-1', handedness: 2, type: 'sharp', damage: 8, blunt: 0, sharp: 0, durability: 10 },
    { id: 'buckler', name: 'Buckler', kind: 'armour', slot: 'shield', handedness: 1, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.1, durability: 6 },
    { id: 'padded-vest', name: 'Padded Vest', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.2, sharp: 0.1, durability: 10 },
    { id: 'iron-helm', name: 'Iron Helm', kind: 'armour', slot: 'head', handedness: 0, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.2, durability: 8 },
];

describe('defaultGearSeed (D9 builtin seed)', () => {
    it('is exactly the six pinned entries with the full shared field set (R4)', () => {
        expect([...defaultGearSeed]).toEqual(CANONICAL_SEED);
    });

    it('carries the D9 example parameters: dagger sharp 3, mace blunt 5 1h, axe sharp 8 2h, buckler shield 1h', () => {
        const byId = new Map(defaultGearSeed.map((g) => [g.id, g]));
        expect(byId.get('rusted-dagger')).toMatchObject({ kind: 'weapon', type: 'sharp', damage: 3, handedness: 1 });
        expect(byId.get('iron-mace')).toMatchObject({ kind: 'weapon', type: 'blunt', damage: 5, handedness: 1 });
        expect(byId.get('great-axe')).toMatchObject({ kind: 'weapon', type: 'sharp', damage: 8, handedness: 2 });
        // Shield = armour kind, slot shield, handedness 1 (D5e)
        expect(byId.get('buckler')).toMatchObject({ kind: 'armour', slot: 'shield', handedness: 1 });
    });
});

describe('createGearCatalog (D9 registry, item-registry L92–148 precedent)', () => {
    it('starts empty with an explicit empty seed', () => {
        const catalog = createGearCatalog({ seed: [] });
        expect(catalog.count()).toBe(0);
        expect(catalog.has('rusted-dagger')).toBe(false);
        expect(catalog.definitionOf('rusted-dagger')).toBeUndefined();
        expect(catalog.all()).toEqual([]);
    });

    it('copies an injected seed list in — caller array/entry mutation is inert', () => {
        const seed: GearDefinition[] = [
            { id: 'wooden-staff', name: 'Wooden Staff', kind: 'weapon', slot: 'weapon-1', handedness: 2, type: 'blunt', damage: 4, blunt: 0, sharp: 0, durability: 5 },
        ];
        const catalog = createGearCatalog({ seed });
        // Mutating the caller's entry AFTER seeding must not leak into storage
        seed[0].damage = 999;
        expect(catalog.definitionOf('wooden-staff')).toEqual({
            id: 'wooden-staff', name: 'Wooden Staff', kind: 'weapon', slot: 'weapon-1',
            handedness: 2, type: 'blunt', damage: 4, blunt: 0, sharp: 0, durability: 5,
        });
    });

    it('patches a known id keeping every unlisted field (define = patch, D9)', () => {
        const catalog = createGearCatalog();
        expect(catalog.define({ id: 'rusted-dagger', damage: 9 })).toEqual({
            id: 'rusted-dagger', name: 'Rusted Dagger', kind: 'weapon', slot: 'weapon-1',
            handedness: 1, type: 'sharp', damage: 9, blunt: 0, sharp: 0, durability: 8,
        });
    });

    it('never erases with an explicit undefined patch value (D9 "undefined never erases")', () => {
        const catalog = createGearCatalog();
        catalog.define({ id: 'iron-mace', damage: undefined, name: undefined });
        expect(catalog.definitionOf('iron-mace')).toEqual({
            id: 'iron-mace', name: 'Iron Mace', kind: 'weapon', slot: 'weapon-1',
            handedness: 1, type: 'blunt', damage: 5, blunt: 0, sharp: 0, durability: 10,
        });
    });

    it('stores an unknown id as given (no default-filling — validation owns completeness, see catalogs.ts header)', () => {
        const catalog = createGearCatalog({ seed: [] });
        expect(catalog.define({ id: 'glass-shiv', kind: 'weapon', slot: 'weapon-2', handedness: 1, type: 'sharp', damage: 2, blunt: 0, sharp: 0, durability: 1 })).toEqual({
            id: 'glass-shiv', kind: 'weapon', slot: 'weapon-2', handedness: 1, type: 'sharp', damage: 2, blunt: 0, sharp: 0, durability: 1,
        });
        // name was not provided ⇒ the key is simply absent (no fallback exists for gear)
        expect(catalog.definitionOf('glass-shiv')!.name).toBeUndefined();
    });

    it('copies on read — definitionOf/all/define results never alias live storage', () => {
        const catalog = createGearCatalog();
        const a = catalog.definitionOf('great-axe')!;
        const b = catalog.definitionOf('great-axe')!;
        expect(a).not.toBe(b);
        a.damage = 0;
        expect(b.damage).toBe(8);
        expect(catalog.all()[2].damage).toBe(8);
        // define's return value is a copy too
        const returned = catalog.define({ id: 'buckler', blunt: 0.5 });
        returned.blunt = 0;
        expect(catalog.definitionOf('buckler')!.blunt).toBe(0.5);
    });

    it('lists in deterministic order: seed order first, new ids appended in first-listing order', () => {
        const catalog = createGearCatalog();
        catalog.define({ id: 'zephyr-blade', kind: 'weapon', slot: 'weapon-1' });
        catalog.define({ id: 'asp-head', kind: 'weapon', slot: 'weapon-1' });
        expect(catalog.all().map((g) => g.id)).toEqual([
            'rusted-dagger', 'iron-mace', 'great-axe', 'buckler', 'padded-vest', 'iron-helm',
            'zephyr-blade', 'asp-head',
        ]);
        // Re-patching an existing id keeps its original position
        catalog.define({ id: 'rusted-dagger', damage: 4 });
        expect(catalog.all()[0].id).toBe('rusted-dagger');
        expect(catalog.count()).toBe(8);
    });

    it('remove/clear report and mutate exactly', () => {
        const catalog = createGearCatalog();
        expect(catalog.remove('iron-helm')).toBe(true);
        expect(catalog.remove('iron-helm')).toBe(false);
        expect(catalog.has('iron-helm')).toBe(false);
        expect(catalog.count()).toBe(5);
        catalog.clear();
        expect(catalog.count()).toBe(0);
        expect(catalog.all()).toEqual([]);
    });
});

describe('mergeGearCatalog (pure fold used by validation + resolve)', () => {
    it('folds patches over the seed by id with undefined-never-erases semantics', () => {
        const merged = mergeGearCatalog(CANONICAL_SEED, [
            { id: 'rusted-dagger', damage: 7, name: undefined },
            { id: 'new-spear', kind: 'weapon', slot: 'weapon-1', handedness: 2, type: 'sharp', damage: 6, blunt: 0, sharp: 0, durability: 9 },
        ]);
        expect(merged.map((g) => g.id)).toEqual([
            'rusted-dagger', 'iron-mace', 'great-axe', 'buckler', 'padded-vest', 'iron-helm', 'new-spear',
        ]);
        expect(merged[0]).toEqual({ ...CANONICAL_SEED[0], damage: 7 });
        expect(merged[6]).toEqual({
            id: 'new-spear', kind: 'weapon', slot: 'weapon-1', handedness: 2, type: 'sharp', damage: 6, blunt: 0, sharp: 0, durability: 9,
        });
    });

    it('skips non-object and id-less patches without throwing (hostile data, validation reports)', () => {
        expect(mergeGearCatalog(CANONICAL_SEED, [null, 42, 'x', {}, { id: 7 } as never])).toEqual(CANONICAL_SEED);
        expect(mergeGearCatalog(CANONICAL_SEED, undefined)).toEqual(CANONICAL_SEED);
    });
});

describe('resolveBattleDefinition (D10 resolved copy for snapshots/engine)', () => {
    const definition: BattleDefinition = {
        schemaVersion: 1,
        mode: 'ffa',
        entities: [
            { id: 'a', stats: { health: 10, strength: 1, speed: 1 } },
            { id: 'b', stats: { health: 10, strength: 1, speed: 1 } },
        ],
        catalogs: {
            // A PARTIAL patch entry: the shared GearDefinition type models
            // complete entries, but client catalog data arrives as JSON and
            // patches by id (D9) — the cast mirrors that trust boundary.
            gear: [{ id: 'rusted-dagger', damage: 12 } as unknown as GearDefinition],
            abilities: [{ id: 'sweep', effects: [{ type: 'strike' }] }],
        },
    };

    it('merges catalogs.gear over defaultGearSeed by id and keeps abilities unchanged', () => {
        const resolved = resolveBattleDefinition(definition);
        expect(resolved.catalogs!.gear!.map((g) => g.id)).toEqual([
            'rusted-dagger', 'iron-mace', 'great-axe', 'buckler', 'padded-vest', 'iron-helm',
        ]);
        // The client patch landed on the seed entry, other fields kept (D9)
        expect(resolved.catalogs!.gear![0]).toEqual({ ...CANONICAL_SEED[0], damage: 12 });
        expect(resolved.catalogs!.abilities).toEqual([{ id: 'sweep', effects: [{ type: 'strike' }] }]);
    });

    it('never mutates the input and shares no references with it', () => {
        const before = JSON.parse(JSON.stringify(definition));
        const resolved = resolveBattleDefinition(definition);
        resolved.entities[0].stats.health = 999;
        resolved.catalogs!.gear![0].damage = 0;
        (resolved.catalogs!.abilities![0].effects[0] as { type: string }).type = 'heal';
        expect(definition).toEqual(before);
    });

    it('passes a catalog-less definition through as an equal deep copy', () => {
        const bare: BattleDefinition = {
            schemaVersion: 1,
            mode: 'teams',
            teams: [{ id: 'x', members: ['a'] }, { id: 'y', members: ['b'] }],
            entities: [
                { id: 'a', team: 'x', stats: { health: 5, strength: 0, speed: 0.5 } },
                { id: 'b', team: 'y', stats: { health: 5, strength: 0, speed: 0.5 } },
            ],
        };
        const resolved = resolveBattleDefinition(bare);
        expect(resolved).toEqual(bare);
        expect(resolved).not.toBe(bare);
        expect(resolved.entities).not.toBe(bare.entities);
    });
});
