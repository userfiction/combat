// ============================================================================
// @userfiction/combat — src/engine/engine.test.ts — T5 integration matrix (task §10
// rows: Team/FFA, custom plugin replacement, no input mutation, limits,
// JSON roundtrip, R6 quadruple-speed acceptance, §7 canonical battle)
// ============================================================================
// End-to-end through the PUBLIC surface (createSimulation + defaultRules).
// Every expected value is derived from the task's own math (D4c table, §7
// sanity math, D5 formulas, D13 bounds) or captured ONCE from a run whose
// key values were verified against those derivations before hardcoding
// (deterministic standard). The §7 full log uses toMatchSnapshot — the
// baseline was reviewed against the §7 sanity math on first capture.
// ============================================================================

import { createSimulation } from './engine';
import { defaultRules } from '../behavior/rules';
import { validateBattleDefinition } from '../data/validation';
import { deepCopy } from '../runtime/state';
import type { BattleDefinition, CombatPlugin, SimulationSnapshot, StateView, StepContext } from '../contract/types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// §7 example-skirmish.json verbatim (the canonical battle).
const example: BattleDefinition = {
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
                id: 'venom-strike',
                name: 'Venom Strike',
                cost: 1,
                cooldown: 2,
                effects: [{ type: 'strike' }, { type: 'apply-status', target: 'target', status: 'poisoned', stacks: 2, duration: 3, potency: 2 }],
            },
        ],
        // T2 (R1) canonical statuses: the engine has NO hardcoded per-id
        // branches, so the §7 battle's statuses are the canonical seed ids.
        // The 'poisoned' patch overrides the seed tick to 2 — tick damage
        // 2 × stacks 2 = 4/turn preserves the §7 math exactly (potency on
        // the instance is bookkeeping only); 'fearful' needs NO definition —
        // the builtin seed already ships decay 'stacks' with
        // skipChancePerStack 0.25, so the brute's starting instance and the
        // terror-edges contribution reference the seed id directly.
        statuses: [
            { id: 'poisoned', name: 'Poisoned', decay: 'duration', tick: { damage: 2 } },
        ],
    },
    entities: [
        { id: 'knight', name: 'Ser Gallant', team: 'crown', stats: { health: 30, strength: 8, speed: 1, defense: 3 }, equipment: { weapons: [{ id: 'longsword', slot: 'weapon-1' }], armour: [{ id: 'warden-mail', slot: 'body' }] } },
        { id: 'rogue', name: 'Whisper', team: 'crown', stats: { health: 20, strength: 5, speed: 2, precision: 2, evasion: 4 }, equipment: { weapons: [{ id: 'cult-dagger', slot: 'weapon-1' }] }, abilities: ['venom-strike'] },
        { id: 'brute', name: 'Fang Brute', team: 'fang', stats: { health: 40, strength: 10, speed: 1 }, statuses: [{ id: 'fearful', stacks: 1 }], equipment: { weapons: [{ id: 'great-mace', slot: 'weapon-1' }], armour: [{ id: 'cult-mask', slot: 'head' }] } },
    ],
    startingConditions: { seed: 7, config: { maxSteps: 5000 } },
    rules: {
        contributions: [
            {
                id: 'terror-edges',
                hook: 'damage:post',
                when: { type: 'all', of: [{ type: 'stat', ref: 'target', stat: 'health', op: 'lte', value: 12 }, { type: 'chance', p: 0.3 }] },
                effects: [{ type: 'apply-status', target: 'target', status: 'fearful', stacks: 1 }],
            },
        ],
    },
};

// D12 quadruple-speed fixture shape: speed 4 vs 1, HP 200, precision 10
// both, weapons damage 2 / durability 100, seed 7. Dodge chance is exactly
// 0.05 + (0 − 10) × 0.005 = 0 ⇒ never dodged; the basic attack is the only
// usable action ⇒ the wait fallback can never fire (R6 structure).
const quad = (seed = 7): BattleDefinition => ({
    schemaVersion: 1,
    name: 'Quadruple Speed',
    mode: 'ffa',
    catalogs: {
        gear: [{ id: 'practice-sword', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 2, blunt: 0, sharp: 0, durability: 100 }],
    },
    entities: [
        { id: 'fast', stats: { health: 200, strength: 0, speed: 4, precision: 10 }, equipment: { weapons: [{ id: 'practice-sword', slot: 'weapon-1' }] } },
        { id: 'slow', stats: { health: 200, strength: 0, speed: 1, precision: 10 }, equipment: { weapons: [{ id: 'practice-sword', slot: 'weapon-1' }] } },
    ],
    startingConditions: { seed },
});

const duel = (over: Partial<BattleDefinition> = {}, aStats = { health: 5, strength: 100, speed: 1 }, bStats = { health: 5, strength: 100, speed: 1 }, seed = 3): BattleDefinition => ({
    schemaVersion: 1,
    mode: 'ffa',
    entities: [
        { id: 'a', stats: aStats },
        { id: 'b', stats: bStats },
    ],
    startingConditions: { seed },
    ...over,
});

// Compact event shape for exact sequence assertions.
const shape = (snapshot: SimulationSnapshot | { type: string; actor?: string; target?: string; payload?: Record<string, unknown> }[]) => {
    const events = Array.isArray(snapshot) ? snapshot : snapshot.events;
    return events.map((event) => ({ type: event.type, actor: event.actor, target: event.target, payload: event.payload }));
};
const at = (sim: ReturnType<typeof createSimulation>, step: number) => shape(sim.events().filter((event) => event.step === step));

// ----------------------------------------------------------------------------
// §7 canonical battle — full-run outcome + pinned key events
// ----------------------------------------------------------------------------

describe('§7 canonical battle (R1/R5)', () => {
    it('validates clean and runs to teams victory crown at step 10', () => {
        expect(validateBattleDefinition(deepCopy(example))).toEqual({ valid: true, errors: [] });
        const sim = createSimulation(example);
        sim.run();
        expect(sim.isTerminal()).toBe(true);
        expect(sim.outcome()).toEqual({ outcome: 'victory', winner: 'crown', step: 10 });
        expect(sim.events()).toHaveLength(65);
        // full typed log — baseline reviewed against §7 sanity math
        expect(sim.events()).toMatchSnapshot();
    });

    it('pins the §7 sanity-math damage values', () => {
        const sim = createSimulation(example);
        sim.run();
        const events = sim.events();
        const find = (step: number, type: string) => events.find((event) => event.step === step && event.type === type)!;
        // knight → brute: longsword 6 × 1.4 = 8.4, mask ×0.8, defense 0 ⇒ 7
        expect(find(3, 'damage').payload).toEqual({ amount: 7, damageType: 'sharp', source: 'weapon', weaponId: 'longsword', crit: false, mitigations: { blocked: false, armourFactor: 0.8, defenseFactor: 1 } });
        // brute → knight: great-mace 8 × 1.5 = 12, mail ×0.85, defense 3 ⇒ 10
        const bruteHit = find(8, 'damage');
        expect(bruteHit.actor).toBe('brute');
        expect(bruteHit.target).toBe('knight');
        expect((bruteHit.payload as Record<string, unknown>).amount).toBe(10);
        const mitigations = (bruteHit.payload as { mitigations: Record<string, unknown> }).mitigations;
        expect(mitigations.blocked).toBe(false);
        expect(Number(mitigations.armourFactor)).toBeCloseTo(0.85, 10);
        expect(Number(mitigations.defenseFactor)).toBeCloseTo(100 / 103, 10);
    });

    it('fearful rolls at the brute turn start, skips, and decays at turn end (definition-driven D5a.2/D5c)', () => {
        // the brute's 'fearful' instance rides the builtin seed definition
        // (skipChancePerStack 0.25, stacks decay) — the generic
        // definition-driven path is the ONLY skip gate; the roll, draw and
        // expiry order are the seeded §7 timeline exactly.
        const sim = createSimulation(example);
        sim.run();
        expect(at(sim, 4)).toEqual([
            { type: 'turn:start', actor: 'brute', target: undefined, payload: undefined },
            { type: 'action', actor: 'brute', target: undefined, payload: { kind: 'skip', reason: 'fearful' } },
            { type: 'status:expired', actor: 'brute', target: undefined, payload: { statusId: 'fearful' } },
            { type: 'status:tick', actor: 'brute', target: undefined, payload: { statusId: 'poisoned', damage: 4 } },
            { type: 'damage', actor: 'brute', target: 'brute', payload: { amount: 4, damageType: 'true', source: 'poisoned', mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 4, time: 1_000_000 } },
        ]);
    });

    it('durability: −1 per landed hit per contributor; cult-mask breaks at 0 (D5b)', () => {
        const sim = createSimulation(example);
        sim.run();
        const events = sim.events();
        // step 1: dagger 10→9 (rogue) and mask 5→4 (contributor) — the
        // breaking piece still contributed this hit, removal follows
        expect(events.filter((event) => event.type === 'gear:damaged' && event.step === 1)).toEqual([
            expect.objectContaining({ actor: 'rogue', payload: { gearId: 'cult-dagger', slot: 'weapon-1', durability: 9 } }),
            expect.objectContaining({ actor: 'brute', payload: { gearId: 'cult-mask', slot: 'head', durability: 4 } }),
        ]);
        expect(events.find((event) => event.type === 'gear:broken')).toEqual(
            expect.objectContaining({ step: 6, actor: 'brute', payload: { gearId: 'cult-mask', slot: 'head' } }),
        );
        // after the mask is gone it stops contributing: step 7 knight hit
        // lands with armourFactor 1
        const step7 = events.find((event) => event.step === 7 && event.type === 'damage')!;
        expect((step7.payload as { amount: number; mitigations: { armourFactor: number } }).amount).toBe(8);
        expect((step7.payload as { mitigations: { armourFactor: number } }).mitigations.armourFactor).toBe(1);
    });

    it('venom-strike cooldown 2 gates the rogue until its third own turn (D9)', () => {
        const sim = createSimulation(example);
        sim.run();
        const actions = sim.events().filter((event) => event.type === 'action' && event.actor === 'rogue');
        // rogue own turns: steps 1,2,5,6,9,10 — ability used at 2 (cost 1
        // turn exempt from decay), then unavailable at 5 and 6 (forced
        // single-pool attack), ready again from 9
        expect(actions.map((event) => event.payload)).toEqual([
            { kind: 'attack' },
            { kind: 'ability', abilityId: 'venom-strike' },
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'ability', abilityId: 'venom-strike' },
        ]);
    });

    it('death + terminal outcome event carry the killer and winner (D11)', () => {
        const sim = createSimulation(example);
        sim.run();
        const events = sim.events();
        expect(events[60]).toEqual(expect.objectContaining({ step: 10, type: 'death', actor: 'brute', payload: { killerId: 'rogue' } }));
        expect(events[64]).toEqual(expect.objectContaining({ step: 10, type: 'outcome', payload: { outcome: 'victory', winner: 'crown' } }));
    });
});

// ----------------------------------------------------------------------------
// R6 — the 4× speed acceptance through the engine
// ----------------------------------------------------------------------------

describe('quadruple-speed acceptance (R6/D4c)', () => {
    it('steps 1–4 are fast ATTACKS at 250k/500k/750k/1M µs, step 5 is slow at 1M', () => {
        const sim = createSimulation(quad());
        for (let i = 0; i < 5; i++) sim.step();
        const turns = sim.events().filter((event) => event.type === 'turn:start');
        expect(turns.map((event) => [event.step, event.time, event.actor])).toEqual([
            [1, 250_000, 'fast'],
            [2, 500_000, 'fast'],
            [3, 750_000, 'fast'],
            [4, 1_000_000, 'fast'],
            [5, 1_000_000, 'slow'],
        ]);
        // every fast action is a real attack — the wait fallback never fires
        const actions = sim.events().filter((event) => event.type === 'action');
        expect(actions.map((event) => event.payload)).toEqual([
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'attack' },
            { kind: 'attack' },
        ]);
        // damage values captured once (weapon 2 × strength 0 ⇒ 2, no mitigation)
        const damages = sim.events().filter((event) => event.type === 'damage');
        expect(damages.map((event) => (event.payload as { amount: number }).amount)).toEqual([2, 2, 2, 2, 2]);
        expect(sim.snapshot().state.entities.map((entity) => entity.health)).toEqual([198, 192]);
    });
});

// ----------------------------------------------------------------------------
// Outcomes — FFA / teams / draws / limits (D5g)
// ----------------------------------------------------------------------------

describe('outcomes (D5g)', () => {
    it('ffa last-man-standing victory', () => {
        const sim = createSimulation(duel({}, { health: 5, strength: 100, speed: 1 }, { health: 5, strength: 0, speed: 1 }, 3));
        sim.run();
        expect(sim.outcome()).toEqual({ outcome: 'victory', winner: 'a', step: 3 });
    });

    it('mutual destruction draw: the last attacker dies to its own poison the same turn', () => {
        // canonical 'poisoned' seed (tick 1 × stacks): stacks 5 ⇒ a 5-damage
        // final tick kills the 5-hp attacker right after its own lethal hit.
        const definition: BattleDefinition = {
            schemaVersion: 1,
            mode: 'ffa',
            entities: [
                { id: 'a', stats: { health: 5, strength: 100, speed: 1 }, statuses: [{ id: 'poisoned', stacks: 5, duration: 1 }] },
                { id: 'b', stats: { health: 1, strength: 0, speed: 1 } },
            ],
            startingConditions: { seed: 2 },
        };
        const sim = createSimulation(definition);
        sim.run();
        expect(sim.outcome()).toEqual({ outcome: 'draw', reason: 'mutual-destruction', step: 1 });
        expect(sim.events().map((event) => event.type)).toEqual([
            'battle:start',
            'turn:start',
            'action',
            'damage',
            'death',
            'status:tick',
            'damage',
            'death',
            'status:expired',
            'step:end',
            'outcome',
        ]);
    });

    it('no-enemies: all entities on one team ⇒ immediate step-0 draw', () => {
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
        const sim = createSimulation(definition);
        expect(sim.isTerminal()).toBe(true);
        expect(sim.outcome()).toEqual({ outcome: 'draw', reason: 'no-enemies', step: 0 });
        expect(shape(sim.snapshot())).toEqual([
            { type: 'battle:start', actor: undefined, target: undefined, payload: { seed: 1, mode: 'teams' } },
            { type: 'outcome', actor: undefined, target: undefined, payload: { outcome: 'draw', reason: 'no-enemies' } },
        ]);
        // terminal idempotence at construction
        expect(sim.step().events).toHaveLength(2);
    });

    it('step-limit ⇒ undecided through the default decide handler (D4f)', () => {
        const definition = duel({ startingConditions: { seed: 1, config: { maxSteps: 3 } } }, { health: 100_000, strength: 0, speed: 1 }, { health: 100_000, strength: 0, speed: 1 }, 1);
        const sim = createSimulation(definition);
        sim.run();
        expect(sim.outcome()).toEqual({ outcome: 'undecided', reason: 'step-limit', step: 3 });
    });

    it('terminal states are idempotent: step/run return the snapshot unchanged, emit nothing', () => {
        const sim = createSimulation(duel({}, { health: 5, strength: 100, speed: 1 }, { health: 1, strength: 0, speed: 1 }, 2));
        sim.run();
        const before = sim.snapshot();
        expect(sim.step()).toEqual(before);
        expect(sim.run()).toEqual(before);
        expect(sim.step().events).toHaveLength(before.events.length);
    });
});

// ----------------------------------------------------------------------------
// Limits (D4f) — maxLogEvents trim
// ----------------------------------------------------------------------------

describe('limits (D4f)', () => {
    it('maxLogEvents drops the oldest events with a log-trimmed notice', () => {
        const definition = duel({ startingConditions: { seed: 1, config: { maxSteps: 4, maxLogEvents: 5 } } }, { health: 100_000, strength: 0, speed: 1 }, { health: 100_000, strength: 0, speed: 1 }, 1);
        const sim = createSimulation(definition);
        sim.run();
        const events = sim.events();
        // the cap is enforced at every step end: 21 events emitted total, the
        // final trim drops the 6 oldest and appends the notice ⇒ the log sits
        // exactly at the cap with monotonic ids
        expect(events).toHaveLength(5);
        expect(events.map((event) => event.id)).toEqual([17, 18, 19, 20, 21]);
        expect(events.map((event) => event.type)).toEqual(['action', 'damage', 'step:end', 'outcome', 'log-trimmed']);
        expect(events[4].payload).toEqual({ dropped: 6 });
    });

    it('run(limit) caps extra steps without a terminal state', () => {
        const sim = createSimulation(quad());
        const snapshot = sim.run(2);
        expect(snapshot.state.step).toBe(2);
        expect(sim.outcome()).toBeNull();
        sim.run(3);
        expect(sim.snapshot().state.step).toBe(5);
    });
});

// ----------------------------------------------------------------------------
// Plugin replacement (R3/R8) — every single-mode hook injectable
// ----------------------------------------------------------------------------

describe('plugin replacement (D6/D7)', () => {
    it('dodge replacement: every attack dodges, no damage, no durability loss', () => {
        const alwaysMiss: CombatPlugin = {
            id: 'mishap/rules',
            overrides: ['attack:dodge'],
            hooks: { 'attack:dodge': () => ({ dodged: true }) },
        };
        const sim = createSimulation(quad(), { plugins: [alwaysMiss] });
        sim.run(3);
        // dodges change nothing about scheduling: fast still acts at
        // 250k/500k/750k µs
        expect(shape(sim.snapshot()).filter((event) => event.type !== 'battle:start')).toEqual([
            { type: 'turn:start', actor: 'fast', target: undefined, payload: undefined },
            { type: 'action', actor: 'fast', target: undefined, payload: { kind: 'attack' } },
            { type: 'dodge', actor: 'slow', target: 'fast', payload: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 250_000 } },
            { type: 'turn:start', actor: 'fast', target: undefined, payload: undefined },
            { type: 'action', actor: 'fast', target: undefined, payload: { kind: 'attack' } },
            { type: 'dodge', actor: 'slow', target: 'fast', payload: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 2, time: 500_000 } },
            { type: 'turn:start', actor: 'fast', target: undefined, payload: undefined },
            { type: 'action', actor: 'fast', target: undefined, payload: { kind: 'attack' } },
            { type: 'dodge', actor: 'slow', target: 'fast', payload: undefined },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 3, time: 750_000 } },
        ]);
    });

    it('targeting replacement: a fixed-enemy selector drives every attack', () => {
        const pickFirst: CombatPlugin = {
            id: 't/targets',
            overrides: ['target:select'],
            hooks: {
                'target:select': (_view, _ctx, args: { actor: { id: string } }) => (args.actor.id === 'a' ? 'b' : 'a'),
            },
        };
        const sim = createSimulation(duel({}, { health: 50, strength: 10, speed: 1 }, { health: 50, strength: 0, speed: 1 }, 2), { plugins: [pickFirst] });
        sim.step();
        const damage = sim.events().find((event) => event.type === 'damage')!;
        expect([damage.actor, damage.target]).toEqual(['a', 'b']);
    });

    it('scheduler:interval replacement governs ALL readiness (D4e hook routing)', () => {
        const metronome: CombatPlugin = {
            id: 't/metronome',
            overrides: ['scheduler:interval'],
            hooks: { 'scheduler:interval': () => 1_000_000 },
        };
        const sim = createSimulation(quad(), { plugins: [metronome] });
        // speed no longer matters: both entities ready at 1e6 µs
        expect(sim.snapshot().state.schedule).toEqual([
            { entityId: 'fast', readyAt: 1_000_000 },
            { entityId: 'slow', readyAt: 1_000_000 },
        ]);
        sim.step();
        // tie at 1e6 still resolves by effective speed (default order intact)
        expect(sim.events().find((event) => event.type === 'turn:start')!.actor).toBe('fast');
        expect(sim.snapshot().state.schedule).toEqual([
            { entityId: 'fast', readyAt: 2_000_000 },
            { entityId: 'slow', readyAt: 1_000_000 },
        ]);
    });

    it('scheduler:order replacement breaks ties by client policy (round-robin fairness)', () => {
        const pickSecond: CombatPlugin = {
            id: 't/order',
            overrides: ['scheduler:order'],
            hooks: { 'scheduler:order': (_view, _ctx, args: { candidates: { entityId: string }[] }) => args.candidates[args.candidates.length - 1].entityId },
        };
        const sim = createSimulation(duel({}, { health: 50, strength: 0, speed: 1 }, { health: 50, strength: 0, speed: 1 }, 1), { plugins: [pickSecond] });
        sim.step();
        // equal readyAt 1e6 — the LAST candidate (definition order 'b') wins
        expect(sim.events().find((event) => event.type === 'turn:start')!.actor).toBe('b');
    });

    it('outcome:decide replacement: suddenEnd draws a truce at ≤1 living (7 usage)', () => {
        const suddenEnd: CombatPlugin = {
            id: 'mishap/outcome',
            overrides: ['outcome:decide'],
            hooks: {
                'outcome:decide': (view) => (view.entities.filter((entity) => entity.living).length <= 1 ? { outcome: 'draw', reason: 'truce' } : null),
            },
        };
        const sim = createSimulation(duel({}, { health: 5, strength: 100, speed: 1 }, { health: 5, strength: 100, speed: 1 }, 3), { plugins: [suddenEnd] });
        sim.run();
        expect(sim.outcome()).toEqual({ outcome: 'draw', reason: 'truce', step: 2 });
        const last = sim.events()[sim.events().length - 1];
        expect(last).toEqual(expect.objectContaining({ type: 'outcome', payload: { outcome: 'draw', reason: 'truce' } }));
    });

    it('duplicate declared overrides resolve by deterministic last-wins (D6)', () => {
        const dodgeA: CombatPlugin = { id: 'd/a', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ dodged: true }) } };
        const dodgeB: CombatPlugin = { id: 'd/b', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ dodged: false }) } };
        const first = createSimulation(duel({}, { health: 50, strength: 10, speed: 1 }, { health: 50, strength: 0, speed: 1 }, 2), { plugins: [dodgeA, dodgeB] });
        first.step();
        // d/b registered last ⇒ no dodge, damage lands
        expect(first.events().map((event) => event.type)).toContain('damage');
        expect(first.events().map((event) => event.type)).not.toContain('dodge');
        const second = createSimulation(duel({}, { health: 50, strength: 10, speed: 1 }, { health: 50, strength: 0, speed: 1 }, 2), { plugins: [dodgeB, dodgeA] });
        second.step();
        // d/a now last ⇒ every attack dodges, no damage
        expect(second.events().map((event) => event.type)).toContain('dodge');
        expect(second.events().map((event) => event.type)).not.toContain('damage');
    });

    it('builtinRules:false: waits forever, decides nothing, run(limit) is the only exit (D5g)', () => {
        const sim = createSimulation(quad(), { builtinRules: false });
        const snapshot = sim.run(2);
        expect(sim.outcome()).toBeNull();
        expect(snapshot.state.step).toBe(2);
        expect(shape(snapshot).filter((event) => event.type === 'action').map((event) => event.payload)).toEqual([{ kind: 'wait' }, { kind: 'wait' }]);
    });

    it('target:select returning a TEAMMATE in teams mode is a contract fault (D6 valid enemy)', () => {
        // closed targeting contract: teams ⇒ living members of OTHER teams.
        // A friendly-fire return is an invalid single-mode result ⇒ fault +
        // full rollback, not a silent ally hit.
        const teams: BattleDefinition = {
            schemaVersion: 1,
            mode: 'teams',
            teams: [
                { id: 'red', members: ['r1', 'r2'] },
                { id: 'blue', members: ['b1'] },
            ],
            entities: [
                { id: 'r1', team: 'red', stats: { health: 50, strength: 10, speed: 1 } },
                { id: 'r2', team: 'red', stats: { health: 50, strength: 0, speed: 1 } },
                { id: 'b1', team: 'blue', stats: { health: 50, strength: 0, speed: 1 } },
            ],
            startingConditions: { seed: 2 },
        };
        const friendly: CombatPlugin = { id: 'p/friendly', overrides: ['target:select'], hooks: { 'target:select': () => 'r2' } };
        const sim = createSimulation(teams, { plugins: [friendly] });
        sim.step();
        expect(sim.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: "invalid target:select result: 'r2' is not a living enemy" });
        expect(sim.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect(sim.events()[1].payload).toEqual({
            error: "invalid target:select result: 'r2' is not a living enemy",
            pluginId: 'p/friendly',
            hook: 'target:select',
        });
        // rollback: nothing happened to the battle
        const snapshot = sim.snapshot();
        expect(snapshot.state.step).toBe(0);
        expect(snapshot.state.entities.map((entity) => entity.health)).toEqual([50, 50, 50]);
    });
});

// ----------------------------------------------------------------------------
// Canonical §7 plugin usage — defaultRules() re-passed as a client plugin
// (D5 preamble "the same contract clients use"; V1 review fix 1)
// ----------------------------------------------------------------------------

describe('defaultRules() explicit floor normalization (7 usage)', () => {
    const alwaysMiss: CombatPlugin = { id: 'mishap/rules', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ dodged: true }) } };
    const gravityFlip: CombatPlugin = {
        id: 'mishap/vocab',
        vocab: {
            effects: {
                'gravity-flip': () => [{ type: 'modify-stat', target: 'target', stat: 'speed', amount: -1, duration: 2 }, { type: 'emit', message: 'gravity flips!' }],
            },
        },
    };
    const suddenEnd: CombatPlugin = {
        id: 'mishap/outcome',
        overrides: ['outcome:decide'],
        hooks: { 'outcome:decide': (view) => (view.entities.filter((entity) => entity.living).length <= 1 ? { outcome: 'draw', reason: 'truce' } : null) },
    };

    it('the literal §7 plugin list constructs and progresses with the auto floor active', () => {
        const sim = createSimulation(quad(), { plugins: [defaultRules(), alwaysMiss, gravityFlip, suddenEnd] });
        sim.run(3);
        expect(sim.events().filter((event) => event.type === 'turn:start')).toHaveLength(3);
        expect(sim.outcome()).toBeNull();
        expect(sim.events().some((event) => event.type === 'fault')).toBe(false);
    });

    it('literal §7 usage on the §7 battle: floor resolves the BATTLE catalog, attacks all miss, poisoned kills', () => {
        // bounded run: the replaced decide handler drops the step-limit
        // invariant (D5g puts it in the DEFAULT handler) and with
        // alwaysMiss + a full friendly roster the survivors just wait —
        // documented "ends only via run(limit) or a deciding plugin".
        const sim = createSimulation(example, { plugins: [defaultRules(), alwaysMiss, gravityFlip, suddenEnd] });
        sim.run(50);
        expect(sim.events().some((event) => event.type === 'fault')).toBe(false);
        // every damage event is a poisoned tick — zero weapon damage anywhere
        const damages = sim.events().filter((event) => event.type === 'damage');
        expect(damages.map((event) => (event.payload as { source: string }).source)).toEqual(damages.map(() => 'poisoned'));
        expect(damages.map((event) => (event.payload as { amount: number }).amount)).toEqual([4, 4, 8, 8, 12, 4]);
        // the brute dies to poisoned alone (killerId absent), crown waits on
        expect(sim.events().find((event) => event.type === 'death')).toEqual(
            expect.objectContaining({ step: 24, actor: 'brute', payload: {} }),
        );
        expect(sim.snapshot().state.entities.map((entity) => [entity.id, entity.living])).toEqual([
            ['knight', true],
            ['rogue', true],
            ['brute', false],
        ]);
        expect(sim.outcome()).toBeNull();
        expect(sim.snapshot().state.step).toBe(50);
    });

    it('builtinRules:false + explicit defaultRules() is bit-identical to the auto floor', () => {
        const auto = createSimulation(quad());
        auto.run();
        const manual = createSimulation(quad(), { builtinRules: false, plugins: [defaultRules()] });
        manual.run();
        expect(manual.outcome()).toEqual({ outcome: 'victory', winner: 'fast', step: 122 });
        expect(JSON.stringify(manual.snapshot().events)).toBe(JSON.stringify(auto.snapshot().events));
        expect(JSON.stringify(manual.snapshot().state)).toBe(JSON.stringify(auto.snapshot().state));
    });

    it('two explicit defaultRules() instances normalize to a single floor', () => {
        const sim = createSimulation(quad(), { plugins: [defaultRules(), defaultRules()] });
        sim.run(2);
        expect(sim.snapshot().state.step).toBe(2);
        expect(sim.events().filter((event) => event.type === 'action').map((event) => event.payload)).toEqual([{ kind: 'attack' }, { kind: 'attack' }]);
        expect(sim.events().some((event) => event.type === 'fault')).toBe(false);
    });

    it('an unbranded IMPOSTOR reusing the floor id stays an ordinary plugin: duplicate + undeclared rejections (D7)', () => {
        const impostor: CombatPlugin = { id: '@userfiction/combat/rules', hooks: { 'attack:dodge': () => ({ dodged: false }) } } as CombatPlugin;
        try {
            createSimulation(quad(), { plugins: [impostor] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as Error).name).toBe('CombatPluginError');
            expect((error as { errors: string[] }).errors).toEqual([
                "plugin '@userfiction/combat/rules' ships single-mode handler 'attack:dodge' without declaring it in overrides",
                "duplicate plugin id: '@userfiction/combat/rules'",
            ]);
        }
    });

    it('arbitrary duplicate plugin ids remain rejected (normalization is identity-branded, not id-based)', () => {
        const first: CombatPlugin = { id: 'dup/x', hooks: { 'step:end': () => undefined } };
        const second: CombatPlugin = { id: 'dup/x', hooks: {} };
        try {
            createSimulation(quad(), { plugins: [first, second] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as Error).name).toBe('CombatPluginError');
            expect((error as { errors: string[] }).errors).toEqual(["duplicate plugin id: 'dup/x'"]);
        }
    });
});

// ----------------------------------------------------------------------------
// Step-0 outcome:decide fault policy (D7 — V1 review fix 2)
// ----------------------------------------------------------------------------

describe('step-0 outcome:decide faults (D5g/D7)', () => {
    const zeroFault = (plugin: CombatPlugin) => {
        const sim = createSimulation(quad(), { plugins: [plugin] });
        return sim;
    };

    it('a throwing decide handler at step 0 is a terminal fault, not a construction crash', () => {
        const thrower: CombatPlugin = {
            id: 'p/throw0',
            overrides: ['outcome:decide'],
            hooks: {
                'outcome:decide': () => {
                    throw new Error('zero-boom');
                },
            },
        };
        const sim = zeroFault(thrower);
        expect(sim.isTerminal()).toBe(true);
        expect(sim.outcome()).toEqual({ outcome: 'fault', step: 0, reason: 'fault', error: 'zero-boom' });
        expect(sim.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect(sim.events()[1].payload).toEqual({ error: 'zero-boom', pluginId: 'p/throw0', hook: 'outcome:decide' });
        // initial state + RNG + schedule + log rolled back wholesale
        const snapshot = sim.snapshot();
        expect(snapshot.state.step).toBe(0);
        expect(snapshot.state.virtualTime).toBe(0);
        expect(snapshot.state.entities.map((entity) => entity.health)).toEqual([200, 200]);
        expect(snapshot.state.schedule).toEqual([
            { entityId: 'fast', readyAt: 250_000 },
            { entityId: 'slow', readyAt: 1_000_000 },
        ]);
        // later steps are no-ops; reset re-derives the same fault state
        const before = sim.snapshot();
        expect(sim.step()).toEqual(before);
        const afterReset = sim.reset();
        expect(afterReset.events.map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect(sim.outcome()).toEqual({ outcome: 'fault', step: 0, reason: 'fault', error: 'zero-boom' });
    });

    it('an invalid verdict at step 0 faults with the validation message', () => {
        const invalid: CombatPlugin = { id: 'p/invalid0', overrides: ['outcome:decide'], hooks: { 'outcome:decide': () => ({ outcome: 'huh' }) } as CombatPlugin['hooks'] };
        const sim = zeroFault(invalid);
        expect(sim.outcome()).toEqual({ outcome: 'fault', step: 0, reason: 'fault', error: "invalid outcome:decide result: unknown outcome 'huh'" });
        expect(sim.events()[1].payload).toEqual({
            error: "invalid outcome:decide result: unknown outcome 'huh'",
            pluginId: 'p/invalid0',
            hook: 'outcome:decide',
        });
    });

    it('impure rng/emit access at step 0 faults (engine-enforced purity, D7)', () => {
        const impureRng: CombatPlugin = {
            id: 'p/impure-rng0',
            overrides: ['outcome:decide'],
            hooks: { 'outcome:decide': (_view: StateView, ctx: StepContext) => ctx.rng.next() } as CombatPlugin['hooks'],
        };
        const rngSim = zeroFault(impureRng);
        expect(rngSim.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        expect((rngSim.events()[1].payload as Record<string, unknown>).error).toContain('must not consume rng');

        const impureEmit: CombatPlugin = {
            id: 'p/impure-emit0',
            overrides: ['outcome:decide'],
            hooks: {
                'outcome:decide': (_view: StateView, ctx: StepContext) => {
                    ctx.emit({ type: 'sneaky' });
                    return null;
                },
            } as CombatPlugin['hooks'],
        };
        const emitSim = zeroFault(impureEmit);
        expect((emitSim.events()[1].payload as Record<string, unknown>).error).toContain('must not emit');
        expect(emitSim.outcome()!.outcome).toBe('fault');
    });

    it('a clean step-0 decide leaves the battle running (no spurious fault)', () => {
        const sim = createSimulation(quad());
        expect(sim.isTerminal()).toBe(false);
        expect(sim.events().map((event) => event.type)).toEqual(['battle:start']);
    });
});

// ----------------------------------------------------------------------------
// JSON contributions + vocab (D8)
// ----------------------------------------------------------------------------

describe('declarative JSON rules through the engine (D8)', () => {
    it('contributions fire at their chain hooks in listed order, after code', () => {
        const definition = duel({
            rules: {
                contributions: [
                    { id: 'scare', hook: 'damage:post', effects: [{ type: 'apply-status', target: 'target', status: 'wilt', stacks: 1 }] },
                    { id: 'banner', hook: 'step:end', effects: [{ type: 'emit', message: 'tick' }] },
                ],
            },
        }, { health: 50, strength: 10, speed: 1 }, { health: 50, strength: 0, speed: 1 }, 2);
        const sim = createSimulation(definition);
        sim.step();
        expect(sim.events().map((event) => event.type)).toEqual([
            'battle:start',
            'turn:start',
            'action',
            'damage',
            'status:applied',
            'step:end',
            'message',
        ]);
        expect(sim.events()[4].payload).toEqual({ statusId: 'wilt', stacks: 1, potency: 1 });
        expect(sim.events()[6].message).toBe('tick');
    });

    it('unregistered namespaced vocab types fail construction; a registering plugin fixes it (D8)', () => {
        const withCustom: BattleDefinition = {
            schemaVersion: 1,
            mode: 'ffa',
            entities: [
                { id: 'a', stats: { health: 10, strength: 1, speed: 1 } },
                { id: 'b', stats: { health: 10, strength: 1, speed: 1 } },
            ],
            rules: { contributions: [{ id: 'r', hook: 'step:end', when: { type: 'acme/check', value: 1 }, effects: [{ type: 'emit', message: 'hi' }] }] },
        };
        expect(() => createSimulation(withCustom)).toThrow(/unknown condition type 'acme\/check'/);
        try {
            createSimulation(withCustom);
        } catch (error) {
            expect((error as { errors: string[] }).errors).toEqual(["rules.contributions[0].when.type: unknown condition type 'acme/check' (no loaded plugin registers it)"]);
        }
        const acme: CombatPlugin = { id: 'acme', vocab: { conditions: { check: () => true } } };
        const sim = createSimulation(withCustom, { plugins: [acme] });
        sim.step();
        expect(sim.events().filter((event) => event.type === 'message').map((event) => event.message)).toEqual(['hi']);
    });

    it('modify-stat speed reschedules OTHER entities through the active interval hook (D4e)', () => {
        const definition: BattleDefinition = {
            schemaVersion: 1,
            mode: 'ffa',
            entities: [
                { id: 'a', stats: { health: 100, strength: 0, speed: 1 } },
                { id: 'b', stats: { health: 100, strength: 0, speed: 2 } },
            ],
            startingConditions: { seed: 2 },
            rules: {
                contributions: [
                    { id: 'crawl', hook: 'damage:post', effects: [{ type: 'modify-stat', target: 'target', stat: 'speed', amount: -1, duration: 3 }] },
                ],
            },
        };
        const sim = createSimulation(definition);
        sim.step(); // b (speed 2) acts first at 500000 and lands (seed 2)
        const snapshot = sim.snapshot();
        expect(snapshot.state.virtualTime).toBe(500_000);
        // a slowed 1 → 0.001 clamp: remaining 500000 µs × oldEff 1 / newEff
        // 0.001 ⇒ 500000000 µs ahead of now (D4e worked example algebra)
        expect(snapshot.state.schedule).toEqual([
            { entityId: 'a', readyAt: 500_500_000 },
            { entityId: 'b', readyAt: 1_000_000 },
        ]);
        expect(snapshot.state.entities[0].statModifiers).toEqual([{ stat: 'speed', amount: -1, remainingTurns: 3 }]);
        expect(sim.events().some((event) => event.type === 'stat:modified')).toBe(true);
    });
});

// ----------------------------------------------------------------------------
// Determinism + copy safety (R9)
// ----------------------------------------------------------------------------

describe('determinism and copy safety (R9/D1/D10)', () => {
    it('createSimulation never mutates the caller input (run + reset)', () => {
        const original = deepCopy(example);
        const sim = createSimulation(example);
        sim.run();
        sim.reset();
        expect(example).toEqual(original);
    });

    it('definition and events getters hand out deep copies', () => {
        const sim = createSimulation(quad());
        sim.definition.name = 'mutated';
        sim.definition.entities[0].stats.health = 1;
        expect(sim.definition.name).toBe('Quadruple Speed');
        expect(sim.definition.entities[0].stats.health).toBe(200);
        const events = sim.events();
        events[0].type = 'mutated';
        expect(sim.events()[0].type).toBe('battle:start');
    });

    it('JSON roundtrip restore continues bit-identically (D10)', () => {
        const full = createSimulation(quad());
        full.step();
        full.step();
        const mid = JSON.parse(JSON.stringify(full.snapshot())) as SimulationSnapshot;
        full.run();
        const expected = full.snapshot();
        const resumed = createSimulation(quad(), { restore: mid });
        resumed.run();
        const got = resumed.snapshot();
        expect(got.events).toEqual(expected.events);
        expect(got.state).toEqual(expected.state);
        expect(resumed.outcome()).toEqual(expected.state.terminal);
    });

    it('reset re-derives the initial state; a fresh run reproduces the outcome (D10)', () => {
        const sim = createSimulation(example);
        const initial = sim.snapshot();
        sim.run();
        const firstOutcome = sim.outcome();
        const afterReset = sim.reset();
        expect(afterReset).toEqual(initial);
        sim.run();
        expect(sim.outcome()).toEqual(firstOutcome);
    });

    it('two independent runs of the same input are identical', () => {
        const a = createSimulation(example);
        a.run();
        const b = createSimulation(example);
        b.run();
        expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
    });
});

// ----------------------------------------------------------------------------
// Fail-fast construction + faults (D2/D7)
// ----------------------------------------------------------------------------

describe('fail-fast construction and faults (D2/D7)', () => {
    it('invalid definition throws CombatValidationError with the collected list', () => {
        const bad = duel({}, { health: 0, strength: 1, speed: 1 }, { health: 5, strength: 1, speed: 1 });
        try {
            createSimulation(bad);
            throw new Error('expected throw');
        } catch (error) {
            expect((error as Error).name).toBe('CombatValidationError');
            expect((error as { errors: string[] }).errors).toEqual(['entities[0].stats.health: must be an integer between 1 and 100000']);
        }
    });

    it('undeclared single-mode handler throws CombatPluginError at construction', () => {
        const rogue: CombatPlugin = { id: 'bad', hooks: { 'attack:dodge': () => ({ dodged: false }) } } as CombatPlugin;
        try {
            createSimulation(quad(), { plugins: [rogue] });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as Error).name).toBe('CombatPluginError');
            expect((error as { errors: string[] }).errors).toEqual(["plugin 'bad' ships single-mode handler 'attack:dodge' without declaring it in overrides"]);
        }
    });

    it('runtime handler fault: rollback + terminal fault + idempotence (D7)', () => {
        const boom: CombatPlugin = {
            id: 'boom',
            hooks: {
                'step:end': () => {
                    throw new Error('kaboom');
                },
            },
        };
        const sim = createSimulation(duel({}, { health: 5, strength: 100, speed: 1 }, { health: 5, strength: 100, speed: 1 }, 2), { plugins: [boom] });
        sim.step();
        expect(sim.outcome()).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'kaboom' });
        expect(sim.events().map((event) => event.type)).toEqual(['battle:start', 'fault', 'outcome']);
        const snapshot = sim.snapshot();
        expect(snapshot.state.step).toBe(0);
        expect(snapshot.state.virtualTime).toBe(0);
        expect(snapshot.state.entities.map((entity) => entity.health)).toEqual([5, 5]);
        // further steps are no-ops
        expect(sim.step()).toEqual(snapshot);
    });

    it('restore with a mismatched definition fails fast (D10 compatibility)', () => {
        const sim = createSimulation(quad());
        sim.step();
        const snapshot = JSON.parse(JSON.stringify(sim.snapshot())) as SimulationSnapshot;
        snapshot.definition.entities[0].stats.health = 999;
        try {
            createSimulation(quad(), { restore: snapshot });
            throw new Error('expected throw');
        } catch (error) {
            expect((error as Error).name).toBe('CombatValidationError');
            expect((error as { errors: string[] }).errors).toEqual(['restore: snapshot definition does not match the resolved battle definition']);
        }
    });
});
