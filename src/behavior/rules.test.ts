// ============================================================================
// @userfiction/combat — src/behavior/rules.test.ts — T5 default-rule tests (task §10
// rows: default rules exact numbers, dodge 7% §7 case, unarmed floor+blunt,
// mitigation chain incl. blocked-crit ×0.75, durability/breakage timing,
// fear/poison/stun timing, resistance, wait-fallback selection, default
// outcome:decide invariants incl. step-limit and step-0 no-enemies draw)
// ============================================================================
// Handlers are invoked DIRECTLY with hand-built views and a scripted
// RngStream, so every draw consumption is asserted exactly (D4g). The chain
// defaults (D5b/D5c) run through their PhaseDefaultApi backed by REAL
// state.ts state, pinning the exact mutation + event sequence.
// ============================================================================

import { defaultRules, applyEquipmentPostDefault, applyStatusTurnEndDefault, enemiesOf } from './rules';
import type { PhaseDefaultApi } from './rules';
import {
    addStatModifier,
    applyStatus,
    createCombatState,
    createEntityState,
    damageEntity,
    damageGear,
    decrementStatModifiers,
    dropScheduleEntries,
    findEntity,
    removeGear,
    removeStatus,
} from '../runtime/state';
import type { CombatState } from '../runtime/state';
import type {
    ActionSelection,
    CombatPlugin,
    EntityView,
    EventDraft,
    GearDefinition,
    HookHandler,
    RngStream,
    StateView,
    StatusTurnEndArgs,
    StepContext,
    EquipmentPostArgs,
} from '../contract/types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Scripted RNG: exact values, exact draw count (D4g discipline check).
const scriptedRng = (values: number[]): RngStream & { draws(): number } => {
    let drawn = 0;
    const next = () => {
        drawn += 1;
        const value = values.shift();
        if (value === undefined) throw new Error('scripted rng exhausted');
        return value;
    };
    return {
        next,
        int: (maxExclusive) => Math.floor(next() * maxExclusive),
        pick: (array) => array[Math.floor(next() * array.length)],
        draws: () => drawn,
    };
};

const mkView = (entity: Partial<EntityView> & { id: string }): EntityView => ({
    name: entity.id,
    order: 0,
    living: true,
    health: 20,
    maxHealth: 20,
    stats: { health: 20, strength: 0, speed: 1, defense: 0, precision: 0, evasion: 0 },
    statuses: [],
    equipment: [],
    cooldowns: {},
    ...entity,
});

const mkStateView = (entities: EntityView[], mode: 'ffa' | 'teams' = 'teams'): StateView => ({
    mode,
    step: 1,
    time: 1_000_000,
    entities,
});

const mkCtx = (rng: RngStream, emitted: EventDraft[], hook: string = 'action:select'): StepContext => ({
    rng,
    emit: (draft) => emitted.push(draft),
    step: 1,
    time: 1_000_000,
    hook: hook as StepContext['hook'],
    depth: 0,
    refs: { actor: mkView({ id: 'a' }) },
});

// Test gear: the §7 pieces plus a shield and heavy-resist armour for the
// mitigation-chain cases.
const gear: GearDefinition[] = [
    { id: 'longsword', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 6, blunt: 0, sharp: 0, durability: 12 },
    { id: 'cult-mask', kind: 'armour', slot: 'head', handedness: 0, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.2, durability: 5 },
    { id: 'warden-mail', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.15, sharp: 0.25, durability: 8 },
    { id: 'buckler', kind: 'armour', slot: 'shield', handedness: 1, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.1, durability: 6 },
    { id: 'tower-shield', kind: 'armour', slot: 'shield', handedness: 1, type: 'sharp', damage: 0, blunt: 0, sharp: 0, durability: 20 },
    { id: 'plate-a', kind: 'armour', slot: 'body', handedness: 0, type: 'sharp', damage: 0, blunt: 0.5, sharp: 0.5, durability: 10 },
    { id: 'plate-b', kind: 'armour', slot: 'hands', handedness: 0, type: 'sharp', damage: 0, blunt: 0.5, sharp: 0.5, durability: 10 },
    { id: 'plate-c', kind: 'armour', slot: 'feet', handedness: 0, type: 'sharp', damage: 0, blunt: 0.5, sharp: 0.5, durability: 10 },
    { id: 'plate-d', kind: 'armour', slot: 'head', handedness: 0, type: 'sharp', damage: 0, blunt: 0.5, sharp: 0.5, durability: 10 },
];

let plugin: CombatPlugin;
beforeEach(() => {
    // ability catalog for the selector's availability gate (D9)
    plugin = defaultRules({
        gear,
        abilities: [
            { id: 'venom-strike', effects: [{ type: 'strike' }] },
            { id: 'checked-strike', conditions: { type: 'never' }, effects: [{ type: 'strike' }] },
            { id: 'strike', effects: [{ type: 'strike' }] },
        ],
    });
});

// Typed accessor for a single-mode default handler.
const handler = (hook: string): HookHandler => (plugin.hooks as Record<string, HookHandler>)[hook];

// ----------------------------------------------------------------------------
// scheduler defaults (D4b/D4d)
// ----------------------------------------------------------------------------

describe('defaultRules scheduler hooks', () => {
    it('interval: speed 4 ⇒ 250000 µs, speed 1 ⇒ 1000000 µs (D4c table)', () => {
        const view = mkStateView([]);
        const ctx = mkCtx(scriptedRng([]), []);
        expect(handler('scheduler:interval')(view, ctx, { entityId: 'a', actionCost: 1, effectiveSpeed: 4 })).toBe(250_000);
        expect(handler('scheduler:interval')(view, ctx, { entityId: 'a', actionCost: 1, effectiveSpeed: 1 })).toBe(1_000_000);
        // ability cost 0.25 at speed 1 ⇒ 250000; degenerate cost floors at 1 µs
        expect(handler('scheduler:interval')(view, ctx, { entityId: 'a', actionCost: 0.25, effectiveSpeed: 1 })).toBe(250_000);
        expect(handler('scheduler:interval')(view, ctx, { entityId: 'a', actionCost: 0.000001, effectiveSpeed: 100 })).toBe(1);
    });

    it('order: higher effective speed first, then lower definition order (D4d)', () => {
        const ctx = mkCtx(scriptedRng([]), []);
        const view = mkStateView([]);
        expect(
            handler('scheduler:order')(view, ctx, {
                candidates: [
                    { entityId: 'slow', readyAt: 1_000_000, effectiveSpeed: 1, order: 0 },
                    { entityId: 'fast', readyAt: 1_000_000, effectiveSpeed: 4, order: 1 },
                ],
            }),
        ).toBe('fast');
        expect(
            handler('scheduler:order')(view, ctx, {
                candidates: [
                    { entityId: 'second', readyAt: 1_000_000, effectiveSpeed: 1, order: 1 },
                    { entityId: 'first', readyAt: 1_000_000, effectiveSpeed: 1, order: 0 },
                ],
            }),
        ).toBe('first');
    });
});

// ----------------------------------------------------------------------------
// action:select (D5a.2) — wait ONLY as the empty-pool fallback
// ----------------------------------------------------------------------------

describe('defaultRules action:select', () => {
    const knight = mkView({ id: 'knight', team: 'crown' });
    const brute = mkView({ id: 'brute', team: 'fang' });

    it('stunned entity skips without any RNG draw (stun gates the turn)', () => {
        const actor = mkView({ id: 'a', statuses: [{ id: 'stun', stacks: 1, duration: 2, potency: 1 }] });
        const rng = scriptedRng([]);
        const result = handler('action:select')(mkStateView([actor, brute]), mkCtx(rng, []), { actor }) as ActionSelection;
        expect(result).toEqual({ kind: 'skip', reason: 'stunned' });
        expect(rng.draws()).toBe(0);
    });

    it('fear roll: rng < 0.25 × stacks ⇒ skip feared (one draw)', () => {
        const actor = mkView({ id: 'a', statuses: [{ id: 'fear', stacks: 2, potency: 1 }] });
        const rng = scriptedRng([0.4]); // 0.4 < 0.5 ⇒ feared
        const result = handler('action:select')(mkStateView([actor, brute]), mkCtx(rng, []), { actor }) as ActionSelection;
        expect(result).toEqual({ kind: 'skip', reason: 'feared' });
        expect(rng.draws()).toBe(1);
    });

    it('fear roll failure proceeds to the pool; stacks 1 threshold is exactly 0.25', () => {
        const actor = mkView({ id: 'a', statuses: [{ id: 'fear', stacks: 1, potency: 1 }] });
        const rng = scriptedRng([0.25]); // 0.25 < 0.25 is false ⇒ NOT feared
        const result = handler('action:select')(mkStateView([actor, brute]), mkCtx(rng, []), { actor }) as ActionSelection;
        expect(result).toEqual({ kind: 'attack' });
        expect(rng.draws()).toBe(1); // the fear roll only — single pool adds none
    });

    it('single usable action selects directly WITHOUT consuming a draw (R6 guarantee)', () => {
        const actor = mkView({ id: 'knight' });
        const rng = scriptedRng([]);
        const result = handler('action:select')(mkStateView([actor, brute]), mkCtx(rng, []), { actor }) as ActionSelection;
        expect(result).toEqual({ kind: 'attack' });
        expect(rng.draws()).toBe(0);
    });

    it('wait fires ONLY when the usable set is empty — no enemies, no draw', () => {
        const solo = mkView({ id: 'a', team: 'x' });
        const mate = mkView({ id: 'b', team: 'x' });
        const rng = scriptedRng([]);
        const result = handler('action:select')(mkStateView([solo, mate]), mkCtx(rng, []), { actor: solo }) as ActionSelection;
        expect(result).toEqual({ kind: 'wait' });
        expect(rng.draws()).toBe(0);
    });

    it('multi-pool uses rng.pick; abilities on cooldown or condition-gated are excluded', () => {
        const actor = mkView({
            id: 'rogue',
            team: 'crown',
            cooldowns: { 'venom-strike': 0, 'checked-strike': 2 },
        });
        const rng = scriptedRng([0.9]); // pick over 3 candidates ⇒ index 2
        const view = mkStateView([actor, brute]);
        const result = handler('action:select')(view, mkCtx(rng, []), { actor }) as ActionSelection;
        // pool order: [attack, venom-strike, checked-strike-excluded…] ⇒ with
        // only one ready ability the pool is [attack, venom-strike]; index
        // floor(0.9×2)=1 ⇒ venom-strike
        expect(result).toEqual({ kind: 'ability', abilityId: 'venom-strike' });
        expect(rng.draws()).toBe(1);
    });

    it('ability availability requires an enemy (hostile-action usability, D5a.2)', () => {
        const actor = mkView({ id: 'a', team: 'x', cooldowns: { strike: 0 } });
        const mate = mkView({ id: 'b', team: 'x' });
        const rng = scriptedRng([]);
        const result = handler('action:select')(mkStateView([actor, mate]), mkCtx(rng, []), { actor }) as ActionSelection;
        expect(result).toEqual({ kind: 'wait' });
        expect(rng.draws()).toBe(0);
    });
});

// ----------------------------------------------------------------------------
// target:select (D5a.3)
// ----------------------------------------------------------------------------

describe('defaultRules target:select', () => {
    it('picks uniformly among living enemies via rng.pick (one draw)', () => {
        const actor = mkView({ id: 'knight', team: 'crown' });
        const brute = mkView({ id: 'brute', team: 'fang' });
        const rng = scriptedRng([0.0]);
        expect(handler('target:select')(mkStateView([actor, brute]), mkCtx(rng, []), { actor, action: { kind: 'attack' } })).toBe('brute');
        expect(rng.draws()).toBe(1);
    });

    it('returns null with no living enemies and consumes no draw', () => {
        const actor = mkView({ id: 'a', team: 'x' });
        const mate = mkView({ id: 'b', team: 'x' });
        const dead = mkView({ id: 'c', team: 'y', living: false });
        const rng = scriptedRng([]);
        expect(handler('target:select')(mkStateView([actor, mate, dead]), mkCtx(rng, []), { actor, action: { kind: 'attack' } })).toBeNull();
        expect(rng.draws()).toBe(0);
    });

    it('enemiesOf: ffa = every other living; teams = other teams only', () => {
        const a = mkView({ id: 'a' });
        const b = mkView({ id: 'b' });
        const dead = mkView({ id: 'c', living: false });
        expect(enemiesOf(mkStateView([a, b, dead], 'ffa'), a).map((e) => e.id)).toEqual(['b']);
        const x = mkView({ id: 'x', team: 'x' });
        const y = mkView({ id: 'y', team: 'y' });
        const x2 = mkView({ id: 'x2', team: 'x' });
        expect(enemiesOf(mkStateView([x, x2, y], 'teams'), x).map((e) => e.id)).toEqual(['y']);
    });
});

// ----------------------------------------------------------------------------
// attack:dodge / attack:crit (D5a.5/D5a.6)
// ----------------------------------------------------------------------------

describe('defaultRules attack rolls', () => {
    it('dodge §7 case: evasion 4 vs precision 0 ⇒ 7% chance, roll 0.06 dodges', () => {
        const attacker = mkView({ id: 'brute', stats: { health: 40, strength: 10, speed: 1, defense: 0, precision: 0, evasion: 0 } });
        const target = mkView({ id: 'rogue', stats: { health: 20, strength: 5, speed: 2, defense: 0, precision: 2, evasion: 4 } });
        const rng = scriptedRng([0.06]);
        expect(handler('attack:dodge')(mkStateView([]), mkCtx(rng, []), { attacker, target })).toEqual({ dodged: true });
        // 0.07 is NOT < 0.07 ⇒ no dodge at the exact boundary
        const rng2 = scriptedRng([0.07]);
        expect(handler('attack:dodge')(mkStateView([]), mkCtx(rng2, []), { attacker, target })).toEqual({ dodged: false });
    });

    it('dodge clamps to [0, 0.75] and always consumes exactly one draw', () => {
        const evasive = mkView({ id: 'e', stats: { health: 1, strength: 0, speed: 1, defense: 0, precision: 0, evasion: 1000 } });
        const accurate = mkView({ id: 'r', stats: { health: 1, strength: 0, speed: 1, defense: 0, precision: 1000, evasion: 0 } });
        const rng = scriptedRng([0.8, 0.0]);
        const ctx = mkCtx(rng, []);
        // cap 0.75: evasive defends itself ⇒ 0.05 + 1000×0.005 = 5.05 → 0.75;
        // 0.8 fails. floor 0: accurate attacks itself ⇒ 0.05 − 5 → 0; even
        // 0.0 cannot dodge (0.0 < 0 is false)
        expect(handler('attack:dodge')(mkStateView([]), ctx, { attacker: evasive, target: evasive })).toEqual({ dodged: false });
        expect(handler('attack:dodge')(mkStateView([]), ctx, { attacker: accurate, target: accurate })).toEqual({ dodged: false });
        expect(rng.draws()).toBe(2);
    });

    it('crit: flat 5%, strict less-than, always one draw', () => {
        const rng = scriptedRng([0.049, 0.05]);
        const ctx = mkCtx(rng, []);
        const args = { attacker: mkView({ id: 'a' }), target: mkView({ id: 'b' }) };
        expect(handler('attack:crit')(mkStateView([]), ctx, args)).toEqual({ crit: true });
        expect(handler('attack:crit')(mkStateView([]), ctx, args)).toEqual({ crit: false });
    });
});

// ----------------------------------------------------------------------------
// damage:base / damage:mitigate (D5a.7/D5a.8) — §7 sanity math pinned
// ----------------------------------------------------------------------------

describe('defaultRules damage formulas', () => {
    it('base: weapon damage × strength factor, weapon type (knight 6×1.4 = 8.4 sharp)', () => {
        const knight = mkView({ id: 'knight', stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 } });
        const result = handler('damage:base')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: knight,
            target: mkView({ id: 'brute' }),
            weapon: { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
        }) as { amount: number; damageType: string };
        expect(result.amount).toBeCloseTo(8.4, 10);
        expect(result.damageType).toBe('sharp');
    });

    it('base: unarmed floor 1 × strength factor with blunt type (D5d)', () => {
        const strong = mkView({ id: 'a', stats: { health: 1, strength: 100, speed: 1, defense: 0, precision: 0, evasion: 0 } });
        const result = handler('damage:base')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: strong,
            target: mkView({ id: 'b' }),
        }) as { amount: number; damageType: string };
        expect(result).toEqual({ amount: 6, damageType: 'blunt' });
    });

    it('mitigate §7: knight→brute 8.4 × mask 0.8 × defense 1 ⇒ 7', () => {
        const brute = mkView({
            id: 'brute',
            equipment: [{ gearId: 'cult-mask', slot: 'head', durability: 5 }],
        });
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: mkView({ id: 'knight' }),
            target: brute,
            amount: 8.4,
            damageType: 'sharp',
        });
        expect(result).toEqual({ amount: 7, blocked: false, armourFactor: 0.8, defenseFactor: 1 });
    });

    it('mitigate §7: brute→knight 12 × mail 0.85 × 100/103 ⇒ 10', () => {
        const knight = mkView({
            id: 'knight',
            stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
            equipment: [{ gearId: 'warden-mail', slot: 'body', durability: 8 }],
        });
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: mkView({ id: 'brute' }),
            target: knight,
            amount: 12,
            damageType: 'blunt',
        }) as { amount: number; blocked: boolean; armourFactor: number; defenseFactor: number };
        expect(result.amount).toBe(10);
        expect(result.blocked).toBe(false);
        expect(result.armourFactor).toBeCloseTo(0.85, 10);
        expect(result.defenseFactor).toBeCloseTo(100 / 103, 10);
    });

    it('mitigate blocked-crit nets exactly ×0.75 (engine pre-multiplied 1.5, block ×0.5)', () => {
        // raw 8 × 1.5 (crit, applied engine-side) = 12 entering mitigate;
        // block roll 0.1 < 0.15 ⇒ ×0.5 ⇒ 6 — net 8 × 0.75 exactly (the
        // tower shield carries zero resistance, so armour stays ×1)
        const defender = mkView({ id: 'd', equipment: [{ gearId: 'tower-shield', slot: 'shield', durability: 20 }] });
        const rng = scriptedRng([0.1]);
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(rng, []), {
            attacker: mkView({ id: 'a' }),
            target: defender,
            amount: 12,
            damageType: 'sharp',
        });
        expect(result).toEqual({ amount: 6, blocked: true, armourFactor: 1, defenseFactor: 1 });
        expect(rng.draws()).toBe(1);
    });

    it('mitigate: a shield with resistance ALSO contributes armour mitigation', () => {
        // same 12 blocked ⇒ ×0.5, buckler sharp 0.1 ⇒ ×0.9 ⇒ 5.4 ⇒ round 5
        const defender = mkView({ id: 'd', equipment: [{ gearId: 'buckler', slot: 'shield', durability: 6 }] });
        const rng = scriptedRng([0.1]);
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(rng, []), {
            attacker: mkView({ id: 'a' }),
            target: defender,
            amount: 12,
            damageType: 'sharp',
        });
        expect(result).toEqual({ amount: 5, blocked: true, armourFactor: 0.9, defenseFactor: 1 });
    });

    it('mitigate: no shield ⇒ NO block roll consumed (zero draws)', () => {
        const rng = scriptedRng([]);
        handler('damage:mitigate')(mkStateView([]), mkCtx(rng, []), {
            attacker: mkView({ id: 'a' }),
            target: mkView({ id: 'b' }),
            amount: 5,
            damageType: 'sharp',
        });
        expect(rng.draws()).toBe(0);
    });

    it('mitigate: armour product floors at ×0.1 (90% cap)', () => {
        const tank = mkView({
            id: 'tank',
            equipment: [
                { gearId: 'plate-a', slot: 'body', durability: 10 },
                { gearId: 'plate-b', slot: 'hands', durability: 10 },
                { gearId: 'plate-c', slot: 'feet', durability: 10 },
                { gearId: 'plate-d', slot: 'head', durability: 10 },
            ],
        });
        // 0.5^4 = 0.0625 ⇒ floored to 0.1 ⇒ 100 × 0.1 = 10
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: mkView({ id: 'a' }),
            target: tank,
            amount: 100,
            damageType: 'sharp',
        }) as { amount: number; armourFactor: number };
        expect(result.armourFactor).toBe(0.1);
        expect(result.amount).toBe(10);
    });

    it('mitigate: landed hits always deal ≥ 1 (0-damage weapon still deals 1)', () => {
        const result = handler('damage:mitigate')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            attacker: mkView({ id: 'a' }),
            target: mkView({ id: 'b' }),
            amount: 0,
            damageType: 'blunt',
        }) as { amount: number };
        expect(result.amount).toBe(1);
    });
});

// ----------------------------------------------------------------------------
// ability:execute (D5a.12) — returns a COPY of the catalog effects
// ----------------------------------------------------------------------------

describe('defaultRules ability:execute', () => {
    it('returns the ability effects, defensively copied', () => {
        const ability = { id: 'venom-strike', effects: [{ type: 'strike' as const }] };
        const result = handler('ability:execute')(mkStateView([]), mkCtx(scriptedRng([]), []), {
            actor: mkView({ id: 'a' }),
            target: mkView({ id: 'b' }),
            ability,
        }) as unknown[];
        expect(result).toEqual([{ type: 'strike' }]);
        (result[0] as { type: string }).type = 'mutated';
        expect(ability.effects[0].type).toBe('strike');
    });
});

// ----------------------------------------------------------------------------
// outcome:decide (D5g invariants)
// ----------------------------------------------------------------------------

describe('defaultRules outcome:decide', () => {
    const decideArgs = (step: number, maxSteps = 10_000) => ({ step, time: step * 1_000_000, config: { maxSteps, maxCascade: 1000, maxLogEvents: 100_000 } });
    const ctx = mkCtx(scriptedRng([]), [], 'outcome:decide');

    it('teams: last team standing wins with the teamId', () => {
        const crown = mkView({ id: 'k', team: 'crown' });
        const fallen = mkView({ id: 'b', team: 'fang', living: false });
        expect(handler('outcome:decide')(mkStateView([crown, fallen]), ctx, decideArgs(9))).toEqual({ outcome: 'victory', winner: 'crown' });
    });

    it('ffa: last living entity wins with its id', () => {
        const a = mkView({ id: 'a' });
        const b = mkView({ id: 'b', living: false });
        expect(handler('outcome:decide')(mkStateView([a, b], 'ffa'), ctx, decideArgs(4))).toEqual({ outcome: 'victory', winner: 'a' });
    });

    it('0 living ⇒ draw mutual-destruction (both modes)', () => {
        const a = mkView({ id: 'a', living: false });
        const b = mkView({ id: 'b', living: false });
        expect(handler('outcome:decide')(mkStateView([a, b], 'ffa'), ctx, decideArgs(2))).toEqual({ outcome: 'draw', reason: 'mutual-destruction' });
        expect(handler('outcome:decide')(mkStateView([a, b]), ctx, decideArgs(2))).toEqual({ outcome: 'draw', reason: 'mutual-destruction' });
    });

    it('step-0 no-enemies draw: all entities on one team (empty team is valid data)', () => {
        const a = mkView({ id: 'a', team: 'x' });
        const b = mkView({ id: 'b', team: 'x' });
        expect(handler('outcome:decide')(mkStateView([a, b]), ctx, decideArgs(0))).toEqual({ outcome: 'draw', reason: 'no-enemies' });
    });

    it('step-0 with enemies ⇒ null (battle continues)', () => {
        const a = mkView({ id: 'a', team: 'x' });
        const b = mkView({ id: 'b', team: 'y' });
        expect(handler('outcome:decide')(mkStateView([a, b]), ctx, decideArgs(0))).toBeNull();
    });

    it('step ≥ maxSteps ⇒ undecided step-limit; a resolved battle on that step still wins', () => {
        const a = mkView({ id: 'a', team: 'x' });
        const b = mkView({ id: 'b', team: 'y' });
        expect(handler('outcome:decide')(mkStateView([a, b]), ctx, decideArgs(10, 10))).toEqual({ outcome: 'undecided', reason: 'step-limit' });
        const fallen = mkView({ id: 'b', team: 'y', living: false });
        expect(handler('outcome:decide')(mkStateView([a, fallen]), ctx, decideArgs(10, 10))).toEqual({ outcome: 'victory', winner: 'x' });
    });

    it('mid-battle with both sides alive ⇒ null', () => {
        const a = mkView({ id: 'a', team: 'x' });
        const b = mkView({ id: 'b', team: 'y' });
        expect(handler('outcome:decide')(mkStateView([a, b]), ctx, decideArgs(5))).toBeNull();
    });
});

// ----------------------------------------------------------------------------
// D5b durability default — real state.ts backing, exact events
// ----------------------------------------------------------------------------

const mkDurabilityState = (): CombatState =>
    createCombatState({
        mode: 'ffa',
        entities: [
            createEntityState({
                id: 'a',
                order: 0,
                stats: { health: 50, strength: 0, speed: 1 },
                equipment: [
                    { gearId: 'longsword', slot: 'weapon-1', durability: 2 },
                    { gearId: 'cult-mask', slot: 'head', durability: 1 },
                    { gearId: 'buckler', slot: 'shield', durability: 5 },
                ],
            }),
            createEntityState({
                id: 'b',
                order: 1,
                stats: { health: 50, strength: 0, speed: 1 },
                equipment: [{ gearId: 'warden-mail', slot: 'body', durability: 3 }],
            }),
        ],
        rng: { seed: 1, state: 1, draws: 0 },
    });

const mkPhaseApi = (state: CombatState, emitted: EventDraft[]): PhaseDefaultApi => ({
    damageGear: (id, slot, amount) => damageGear(state, id, slot, amount),
    removeGear: (id, slot) => removeGear(state, id, slot),
    damageEntity: (id, amount) => damageEntity(state, id, amount),
    removeStatus: (id, statusId) => removeStatus(state, id, statusId),
    patchStatus: (id, statusId, patch) => {
        const instance = findEntity(state, id).statuses.find((status) => status.id === statusId);
        if (!instance) return;
        if (patch.stacks !== undefined) instance.stacks = patch.stacks;
        if (patch.duration !== undefined) instance.duration = patch.duration;
    },
    decrementStatModifiers: (id) => decrementStatModifiers(state, id),
    dropScheduleEntries: (id) => {
        dropScheduleEntries(state, id);
    },
    emit: (draft) => emitted.push(draft),
});

describe('applyEquipmentPostDefault (D5b)', () => {
    it('−1 weapon durability and −1 per CONTRIBUTING piece; non-contributors untouched', () => {
        const state = mkDurabilityState();
        const emitted: EventDraft[] = [];
        const api = mkPhaseApi(state, emitted);
        const attacker = mkView({ id: 'a', equipment: [{ gearId: 'longsword', slot: 'weapon-1', durability: 2 }] });
        const target = mkView({ id: 'b', equipment: [{ gearId: 'warden-mail', slot: 'body', durability: 3 }] });
        const args: EquipmentPostArgs = {
            attacker,
            target,
            weapon: { gearId: 'longsword', slot: 'weapon-1', durability: 2 },
            damageType: 'sharp',
            contributedArmour: [{ gearId: 'warden-mail', slot: 'body', durability: 3 }],
        };
        applyEquipmentPostDefault(api, args);
        expect(state.entities[0].equipment.map((piece) => piece.durability)).toEqual([1, 1, 5]);
        expect(state.entities[1].equipment.map((piece) => piece.durability)).toEqual([2]);
        expect(emitted).toEqual([
            { type: 'gear:damaged', actor: 'a', payload: { gearId: 'longsword', slot: 'weapon-1', durability: 1 } },
            { type: 'gear:damaged', actor: 'b', payload: { gearId: 'warden-mail', slot: 'body', durability: 2 } },
        ]);
    });

    it('durability 0 ⇒ gear:broken + piece removed (breaking piece still contributed)', () => {
        // fresh state with the weapon at 1 durability: this hit lands the
        // final point of wear and the piece is removed afterwards (D5b)
        const state = createCombatState({
            mode: 'ffa',
            entities: [
                createEntityState({
                    id: 'a',
                    order: 0,
                    stats: { health: 50, strength: 0, speed: 1 },
                    equipment: [
                        { gearId: 'longsword', slot: 'weapon-1', durability: 1 },
                        { gearId: 'cult-mask', slot: 'head', durability: 1 },
                        { gearId: 'buckler', slot: 'shield', durability: 5 },
                    ],
                }),
            ],
            rng: { seed: 1, state: 1, draws: 0 },
        });
        const emitted: EventDraft[] = [];
        const api = mkPhaseApi(state, emitted);
        const attacker = mkView({ id: 'a', equipment: [{ gearId: 'longsword', slot: 'weapon-1', durability: 1 }] });
        applyEquipmentPostDefault(api, {
            attacker,
            weapon: { gearId: 'longsword', slot: 'weapon-1', durability: 1 },
            damageType: 'sharp',
        });
        // weapon gone; untouched armour remains
        expect(state.entities[0].equipment.map((piece) => piece.gearId)).toEqual(['cult-mask', 'buckler']);
        expect(emitted).toEqual([
            { type: 'gear:damaged', actor: 'a', payload: { gearId: 'longsword', slot: 'weapon-1', durability: 0 } },
            { type: 'gear:broken', actor: 'a', payload: { gearId: 'longsword', slot: 'weapon-1' } },
        ]);
    });

    it('unarmed attack ⇒ no durability bookkeeping at all', () => {
        const state = mkDurabilityState();
        const emitted: EventDraft[] = [];
        applyEquipmentPostDefault(mkPhaseApi(state, emitted), {
            attacker: mkView({ id: 'a' }),
            target: mkView({ id: 'b' }),
            damageType: 'blunt',
            contributedArmour: [],
        });
        expect(emitted).toEqual([]);
        expect(state.entities[0].equipment.map((piece) => piece.durability)).toEqual([2, 1, 5]);
    });
});

// ----------------------------------------------------------------------------
// D5c affliction defaults — exact timing + events
// ----------------------------------------------------------------------------

const mkStatusState = (statuses: { id: string; stacks?: number; duration?: number; potency?: number }[], health = 50): CombatState =>
    createCombatState({
        mode: 'ffa',
        entities: [createEntityState({ id: 'v', order: 0, stats: { health, strength: 0, speed: 1 }, statuses })],
        rng: { seed: 1, state: 1, draws: 0 },
        schedule: [{ entityId: 'v', readyAt: 1_000_000 }],
    });

describe('applyStatusTurnEndDefault (D5c)', () => {
    it('fear decays silently stacks−1; at 0 the status is removed with status:expired', () => {
        const state = mkStatusState([{ id: 'fear', stacks: 2, potency: 1 }]);
        const emitted: EventDraft[] = [];
        applyStatusTurnEndDefault(mkPhaseApi(state, emitted), { entity: state.entities[0] });
        expect(state.entities[0].statuses).toEqual([{ id: 'fear', stacks: 1, potency: 1 }]);
        expect(emitted).toEqual([]);

        applyStatusTurnEndDefault(mkPhaseApi(state, emitted), { entity: state.entities[0] });
        expect(state.entities[0].statuses).toEqual([]);
        expect(emitted).toEqual([{ type: 'status:expired', actor: 'v', payload: { statusId: 'fear' } }]);
    });

    it('poison ticks potency × stacks BEFORE duration decay; events tick→damage; expiry after the final tick', () => {
        const state = mkStatusState([{ id: 'poison', stacks: 3, duration: 2, potency: 2 }]);
        const emitted: EventDraft[] = [];
        const api = mkPhaseApi(state, emitted);
        applyStatusTurnEndDefault(api, { entity: state.entities[0] });
        // 2 × 3 = 6 damage: 50 → 44; duration 2 → 1 (no expiry yet)
        expect(state.entities[0].health).toBe(44);
        expect(state.entities[0].statuses).toEqual([{ id: 'poison', stacks: 3, duration: 1, potency: 2 }]);
        expect(emitted).toEqual([
            { type: 'status:tick', actor: 'v', payload: { statusId: 'poison', damage: 6 } },
            { type: 'damage', actor: 'v', target: 'v', payload: { amount: 6, damageType: 'true', source: 'poison', mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } },
        ]);
        // lethal final tick: potency 99 × stacks 1 kills the 5-hp victim —
        // death event + schedule drop BEFORE the expiry notice (D5c order)
        const dying = mkStatusState([{ id: 'poison', stacks: 1, duration: 1, potency: 99 }], 5);
        const dyingEvents: EventDraft[] = [];
        applyStatusTurnEndDefault(mkPhaseApi(dying, dyingEvents), { entity: dying.entities[0] });
        expect(dying.entities[0].living).toBe(false);
        expect(dying.schedule).toEqual([]); // death drops entries immediately
        expect(dyingEvents).toEqual([
            { type: 'status:tick', actor: 'v', payload: { statusId: 'poison', damage: 5 } },
            { type: 'damage', actor: 'v', target: 'v', payload: { amount: 5, damageType: 'true', source: 'poison', mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } },
            { type: 'death', actor: 'v', payload: {} },
            { type: 'status:expired', actor: 'v', payload: { statusId: 'poison' } },
        ]);
    });

    it('stun decays duration−1; expired at 0 (the skip itself is action:select)', () => {
        const state = mkStatusState([{ id: 'stun', stacks: 1, duration: 2, potency: 1 }]);
        const emitted: EventDraft[] = [];
        const api = mkPhaseApi(state, emitted);
        applyStatusTurnEndDefault(api, { entity: state.entities[0] });
        expect(state.entities[0].statuses).toEqual([{ id: 'stun', stacks: 1, duration: 1, potency: 1 }]);
        applyStatusTurnEndDefault(api, { entity: state.entities[0] });
        expect(state.entities[0].statuses).toEqual([]);
        expect(emitted).toEqual([{ type: 'status:expired', actor: 'v', payload: { statusId: 'stun' } }]);
    });

    it('unknown status ids are bookkeeping-only (D5f): untouched, no events', () => {
        const state = mkStatusState([{ id: 'cursed', stacks: 4, duration: 9, potency: 3 }]);
        const emitted: EventDraft[] = [];
        applyStatusTurnEndDefault(mkPhaseApi(state, emitted), { entity: state.entities[0] });
        expect(state.entities[0].statuses).toEqual([{ id: 'cursed', stacks: 4, duration: 9, potency: 3 }]);
        expect(emitted).toEqual([]);
    });

    it('temporary stat modifiers decrement in the same phase; each expiry fires stat:expired', () => {
        const state = mkStatusState([]);
        addStatModifier(state, 'v', 'speed', -1, 1);
        addStatModifier(state, 'v', 'strength', 3, 0); // permanent sentinel
        const emitted: EventDraft[] = [];
        applyStatusTurnEndDefault(mkPhaseApi(state, emitted), { entity: state.entities[0] });
        expect(state.entities[0].statModifiers).toEqual([{ stat: 'strength', amount: 3, remainingTurns: 0 }]);
        expect(emitted).toEqual([{ type: 'stat:expired', actor: 'v', payload: { stat: 'speed', amount: -1 } }]);
    });

    it('resistance path (D5e, adapter backing via state.applyStatus): 0.5 resist halves added stacks, ≥1 fully resists', () => {
        const state = mkStatusState([]);
        const half = applyStatusShim(state, 2, 0.5);
        expect(half).toEqual({ kind: 'applied', stacks: 1 });
        const full = applyStatusShim(state, 5, 1);
        expect(full).toEqual({ kind: 'resisted' });
    });
});

// state.applyStatus shim mirroring the pipeline adapter call shape.
function applyStatusShim(state: CombatState, stacks: number, resistance: number): { kind: string; stacks?: number } {
    const result = applyStatus(state, 'v', 'fear', { stacks, resistance });
    return result.kind === 'applied' ? { kind: result.kind, stacks: result.status.stacks } : { kind: result.kind };
}
