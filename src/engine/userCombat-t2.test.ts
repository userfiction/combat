// ============================================================================
// @userfiction/combat — src/engine/userCombat-t2.test.ts — T2 R4 facade
// additions (skills / ailments / buff / gears) + root export surface
// ============================================================================
// Pins the R4 facade contract through the PUBLIC ROOT BARREL ONLY (the same
// import convention as userCombat.test.ts):
//   - skills() registers the ability/skill catalog (identical to abilities());
//   - gears() is the preferred gear setter; equipments() is a DEPRECATED
//     identical alias (bit-identical outcomes);
//   - ailments()/buff() REGISTER status definitions (accumulate into one
//     registry; re-registering an id replaces it) and never apply anything;
//   - actors reference skills via `abilities` or the intuitive `skills`
//     alias (both present ⇒ validation error);
//   - every new public type/constant resolves from the root.
// ============================================================================

import {
    BODY_PARTS,
    CombatValidationError,
    INJURY_EAR_EVASION_PENALTY,
    INJURY_EYE_PRECISION_PENALTY,
    INJURY_LEG_SPEED_FACTOR,
    MAX_RESOURCE_VALUE,
    MIN_STATUS_MODIFIER,
    RESOURCE_KEYS,
    STATUS_DECAY_MODES,
    STATUS_DECAY_MODES as DECAY_MODES_ALIAS,
    StatusTickEffect,
    createUserCombat,
    defaultStatusSeed,
    userCombat as _unusedSingletonRef,
} from '../../index';
import type {
    BattleDefinition,
    BodyPart,
    EntityDefinition,
    EntityResources,
    EntityResourcesInput,
    ResourceCost,
    ResourceCostInput,
    ResourceKey,
    ResourcePool,
    StatusDefinition,
    StatusDecayMode,
    UserCombat,
} from '../../index';

// Determinism: replace the roll-driven single-mode handlers.
const deterministic = {
    id: 'test/deterministic',
    overrides: ['attack:dodge', 'attack:crit'],
    hooks: {
        'attack:dodge': () => ({ dodged: false }),
        'attack:crit': () => ({ crit: false }),
    },
} as const satisfies CombatPluginLike;
interface CombatPluginLike {
    id: string;
    overrides?: string[];
    hooks?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// skills() — the ability-catalog registration alias (R4)
// ----------------------------------------------------------------------------

describe('facade skills() (R4)', () => {
    it('registers the ability catalog exactly like abilities() and actors select known skill ids', async () => {
        const combat = createUserCombat()
            .skills([{ id: 'shove', name: 'Shove', effects: [{ type: 'emit', message: 'shoved' }] }])
            .actors([
                { id: 'pusher', stats: { health: 10, strength: 0, speed: 2 }, abilities: ['shove'] },
                { id: 'victim', stats: { health: 10, strength: 0, speed: 1 } },
            ])
            .plugins([deterministic as never])
            .seed(3);
        // the resolved definition carries the skill catalog under abilities
        expect(combat.snapshot().definition.catalogs!.abilities![0].id).toBe('shove');
    });

    it('actors may declare the intuitive skills alias; both aliases together are rejected', async () => {
        const alias = createUserCombat()
            .skills([{ id: 'shove', effects: [{ type: 'emit', message: 'shoved' }] }])
            .actors([
                { id: 'pusher', stats: { health: 10, strength: 0, speed: 2 }, skills: ['shove'] },
                { id: 'victim', stats: { health: 10, strength: 0, speed: 1 } },
            ])
            .seed(3);
        // cooldowns are seeded from the alias (the skill is known and ready)
        expect(alias.snapshot().state.entities[0].cooldowns).toEqual({ shove: 0 });

        const conflict = createUserCombat()
            .skills([{ id: 'shove', effects: [{ type: 'emit', message: 'shoved' }] }])
            .actors([
                { id: 'pusher', stats: { health: 10, strength: 0, speed: 2 }, abilities: ['shove'], skills: ['shove'] },
                { id: 'victim', stats: { health: 10, strength: 0, speed: 1 } },
            ]);
        let thrown: unknown;
        try {
            conflict.snapshot();
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(CombatValidationError);
        expect((thrown as CombatValidationError).errors).toEqual([
            "entities[0].abilities: 'abilities' and alias 'skills' must not both be present",
        ]);
    });
});

// ----------------------------------------------------------------------------
// gears() + deprecated equipments() alias (R4)
// ----------------------------------------------------------------------------

describe('facade gears() and the deprecated equipments() alias (R4)', () => {
    const warhammer = { id: 'warhammer', kind: 'weapon' as const, slot: 'weapon-1' as const, handedness: 1 as const, type: 'blunt' as const, damage: 9, blunt: 0, sharp: 0, durability: 50 };

    it('gears() fills the gear catalog; equipments() is a bit-identical deprecated alias', async () => {
        const viaGears = createUserCombat()
            .gears([warhammer])
            .actors([
                { id: 'a', stats: { health: 50, strength: 0, speed: 2, precision: 10 }, equipment: { weapons: [{ id: 'warhammer', slot: 'weapon-1' }] } },
                { id: 'b', stats: { health: 50, strength: 0, speed: 1, precision: 10 } },
            ])
            .plugins([deterministic as never])
            .seed(7);
        const viaAlias = createUserCombat()
            .equipments([warhammer])
            .actors([
                { id: 'a', stats: { health: 50, strength: 0, speed: 2, precision: 10 }, equipment: { weapons: [{ id: 'warhammer', slot: 'weapon-1' }] } },
                { id: 'b', stats: { health: 50, strength: 0, speed: 1, precision: 10 } },
            ])
            .plugins([deterministic as never])
            .seed(7);
        const first = await viaGears.simulate();
        const second = await viaAlias.simulate();
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        expect(first.state.entities.map((entity) => entity.health)).toEqual([50, 41]); // 9 blunt × strength 0 ⇒ round(9)
    });

    it('both setters return the same chained instance (R2 chaining preserved)', () => {
        const combat = createUserCombat();
        expect(combat.gears([])).toBe(combat);
        expect(combat.equipments([])).toBe(combat);
        expect(combat.skills([])).toBe(combat);
        expect(combat.abilities([])).toBe(combat);
        expect(combat.ailments([])).toBe(combat);
        expect(combat.buff([])).toBe(combat);
    });
});

// ----------------------------------------------------------------------------
// ailments() / buff() — status-definition registration (R1/R4)
// ----------------------------------------------------------------------------

describe('facade ailments()/buff() register status definitions (R1)', () => {
    it('registrations land in catalogs.statuses and CUSTOM definitions drive battle behavior', async () => {
        const combat = createUserCombat()
            .ailments([{ id: 'screaming', decay: 'stacks', skipChancePerStack: 1 }])
            .buff([{ id: 'sharpened', decay: 'duration', modifiers: { precision: 3 } }])
            .actors([
                { id: 'hero', stats: { health: 20, strength: 0, speed: 1, precision: 10 }, statuses: [{ id: 'sharpened', duration: 1 }] },
                { id: 'golem', stats: { health: 30, strength: 0, speed: 1, precision: 10 } },
            ])
            .seed(7);
        const initial = combat.snapshot();
        // both registrations ride the resolved catalog (merged over the seed)
        const ids = initial.definition.catalogs!.statuses!.map((entry) => entry.id);
        expect(ids).toContain('screaming');
        expect(ids).toContain('sharpened');
        // the buff's materialized modifiers are live: precision 10 + 3
        expect(initial.state.entities[0].stats.precision).toBe(13);
        // the ailment is registered but NOT applied (no instance on any actor)
        expect(initial.state.entities.flatMap((entity) => entity.statuses.map((status) => status.id))).toEqual(['sharpened']);
    });

    it('re-registering an id replaces the registration (later wins, accumulate across calls)', () => {
        const combat = createUserCombat()
            .ailments([{ id: 'bleeding', tick: { damage: 5 } }])
            .buff([{ id: 'bleeding', tick: { damage: 9 } }])
            .actors([
                { id: 'a', stats: { health: 10, strength: 0, speed: 1 } },
                { id: 'b', stats: { health: 10, strength: 0, speed: 1 } },
            ]);
        const definitions = combat.snapshot().definition.catalogs!.statuses!;
        expect(definitions.filter((entry) => entry.id === 'bleeding')).toEqual([
            { id: 'bleeding', name: 'Bleeding', decay: 'duration', tick: { damage: 9 } },
        ]);
    });

    it('registrations compose with gears/abilities/actors in one chain (facade lifecycle intact)', async () => {
        // forced cut selector keeps the timeline deterministic (the default
        // pool would roulette between attack and cut)
        const useCut = {
            id: 'test/use-cut',
            overrides: ['action:select'],
            hooks: { 'action:select': () => ({ kind: 'ability', abilityId: 'cut' }) },
        };
        const combat = createUserCombat()
            .gears([{ id: 'dagger', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 3, blunt: 0, sharp: 0, durability: 8 }])
            .skills([{ id: 'cut', cooldown: 1, effects: [{ type: 'apply-status', target: 'target', status: 'bleeding', duration: 2 }] }])
            .ailments([{ id: 'bleeding', tick: { damage: 2 } }])
            .actors([
                { id: 'hero', stats: { health: 20, strength: 0, speed: 2, precision: 10 }, equipment: { weapons: [{ id: 'dagger', slot: 'weapon-1' }] }, abilities: ['cut'] },
                { id: 'golem', stats: { health: 30, strength: 0, speed: 1, precision: 10 } },
            ])
            .plugins([deterministic as never, useCut as never])
            .seed(7);
        // one full custom chain: hero cuts at t=500000, golem bleeds
        const snapshot = await combat.simulate();
        expect(snapshot.state.step).toBe(1);
        expect(snapshot.state.entities[1].statuses.map((status) => status.id)).toEqual(['bleeding']);
    });
});

// ----------------------------------------------------------------------------
// Root export surface (R4: new types/constants at the package root)
// ----------------------------------------------------------------------------

describe('root export surface (R4)', () => {
    it('the new T2 constants resolve from the package root with contract values', () => {
        expect(BODY_PARTS).toEqual(['left-arm', 'right-arm', 'left-leg', 'right-leg', 'left-eye', 'right-eye', 'left-ear', 'right-ear', 'nose']);
        expect(RESOURCE_KEYS).toEqual(['stamina', 'mana']);
        expect(STATUS_DECAY_MODES).toEqual(['stacks', 'duration', 'none']);
        expect(DECAY_MODES_ALIAS).toBe(STATUS_DECAY_MODES);
        expect(INJURY_LEG_SPEED_FACTOR).toBe(0.75);
        expect(INJURY_EYE_PRECISION_PENALTY).toBe(2);
        expect(INJURY_EAR_EVASION_PENALTY).toBe(1);
        expect(MAX_RESOURCE_VALUE).toBe(1_000_000);
        expect(MIN_STATUS_MODIFIER).toBe(-1_000);
        expect(defaultStatusSeed.map((entry) => entry.id)).toEqual([
            'fearful', 'poisoned', 'bleeding', 'burned', 'blinded', 'blessed', 'hasted',
        ]);
    });

    it('the new T2 TYPES are importable and structurally exact (compile-level pin)', () => {
        const definition: StatusDefinition = { id: 'custom-ail', decay: 'duration', tick: { damage: 2 }, modifiers: { precision: -1 }, skipChancePerStack: 0.5 };
        const decay: StatusDecayMode = 'stacks';
        const tick: StatusTickEffect = { heal: 1 };
        const part: BodyPart = 'nose';
        const pool: ResourcePool = { current: 1, max: 2 };
        const resources: EntityResources = { stamina: pool };
        const seedResources: EntityResourcesInput = { energy: pool };
        const cost: ResourceCost = { health: 1, stamina: 1, mana: 1 };
        const seedCost: ResourceCostInput = { energy: 1 };
        const key: ResourceKey = 'mana';
        const facade: UserCombat = createUserCombat();
        const battle: BattleDefinition = { schemaVersion: 1, mode: 'ffa', entities: [] };
        const actors: EntityDefinition[] = [];
        expect([definition, decay, tick, part, resources, seedResources, cost, seedCost, key, facade, battle, actors]).toBeDefined();
    });
});

// The singleton is re-exported unchanged by R4 (referenced to keep the
// import honest without exercising its accumulating state here).
export type { StatusDefinition };
export { _unusedSingletonRef };
