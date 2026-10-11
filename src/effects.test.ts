// ============================================================================
// @userfiction/combat — src/effects.test.ts — T4 bounded interpreter tests
// ============================================================================
// Pins the D8 vocabulary: EVERY builtin condition op and EVERY builtin
// effect type with exact outcomes, the D5e/D5c resistance+cap pass-through
// contract (adapter receives the descriptor numbers verbatim), namespaced
// code-vocab resolution with the flat-params-excluding-type convention (task
// brief / types.ts CustomCondition), D4g chance RNG consumption (including
// short-circuit draw counts), and the D13 interpreter bounds (depth 16 /
// list 32) as deterministic fault throws. The engine side is a RECORDING
// fake adapter — assertions are the exact call sequence.
// ============================================================================

import { applyEffects, evaluateCondition } from './effects';
import type { EffectAdapter, InterpreterDeps, VocabLookup } from './effects';
import type {
    Condition,
    EffectDescriptor,
    EntityView,
    RngStream,
    StateView,
    StepContext,
    StepContextRefs,
    VocabConditionHandler,
    VocabEffectHandler,
} from './types';

// ----------------------------------------------------------------------------
// Fixtures — knight (attacker/refs.actor) vs brute (target), teams mode.
// knight.health = 23 (current) while knight.stats.health = 30 (effective
// max) — the pair pins the "stat health reads CURRENT hp" decision.
// ----------------------------------------------------------------------------

const knight: EntityView = {
    id: 'knight', name: 'Ser Gallant', team: 'crown', order: 0,
    living: true, health: 23, maxHealth: 30,
    stats: { health: 30, strength: 8, speed: 1, defense: 3, precision: 0, evasion: 0 },
    statuses: [{ id: 'fear', stacks: 2, potency: 1 }],
    equipment: [
        { gearId: 'longsword', slot: 'weapon-1', durability: 12 },
        { gearId: 'warden-mail', slot: 'body', durability: 8 },
    ],
    cooldowns: { 'venom-strike': 1 },
};

const brute: EntityView = {
    id: 'brute', name: 'Fang Brute', team: 'fang', order: 2,
    living: true, health: 40, maxHealth: 40,
    stats: { health: 40, strength: 10, speed: 1, defense: 0, precision: 0, evasion: 0 },
    statuses: [],
    equipment: [{ gearId: 'great-mace', slot: 'weapon-1', durability: 10 }],
    cooldowns: {},
};

const view: StateView = { mode: 'teams', step: 3, time: 1500000, entities: [knight, brute] };

const emptyVocab: VocabLookup = { condition: () => undefined, effect: () => undefined };

const makeVocab = (handlers: {
    conditions?: Record<string, VocabConditionHandler>;
    effects?: Record<string, VocabEffectHandler>;
}): VocabLookup => ({
    condition: (id) => handlers.conditions?.[id],
    effect: (id) => handlers.effects?.[id],
});

interface DepsFixture {
    deps: InterpreterDeps;
    calls: Record<string, unknown>[];   // exact adapter call sequence
    drawCount: () => number;            // chance-condition RNG consumption
}

// rngValues cycle deterministically; every next() is counted so short-circuit
// semantics are observable (D4g).
function makeDeps(rngValues: number[] = [0.5], refs: StepContextRefs = { actor: knight, target: brute }, vocab: VocabLookup = emptyVocab): DepsFixture {
    const calls: Record<string, unknown>[] = [];
    let draws = 0;
    const rng: RngStream = {
        next: () => {
            const value = rngValues[draws % rngValues.length];
            draws += 1;
            return value;
        },
        int: () => 0,
        pick: () => undefined,
    };
    const ctx: StepContext = {
        rng,
        emit: () => undefined,
        step: 3,
        time: 1500000,
        hook: 'damage:post',
        depth: 0,
        refs,
    };
    const adapter: EffectAdapter = {
        strike: () => calls.push({ op: 'strike' }),
        damageFlat: (entityId, amount, damageType) => calls.push({ op: 'damage-flat', entityId, amount, damageType }),
        heal: (entityId, amount) => calls.push({ op: 'heal', entityId, amount }),
        applyStatus: (entityId, status, stacks, duration, potency) => calls.push({ op: 'apply-status', entityId, status, stacks, duration, potency }),
        removeStatus: (entityId, status) => calls.push({ op: 'remove-status', entityId, status }),
        breakEquipment: (entityId, slot) => calls.push({ op: 'break-equipment', entityId, slot }),
        modifyStat: (entityId, stat, amount, duration) => calls.push({ op: 'modify-stat', entityId, stat, amount, duration }),
        emitMessage: (message) => calls.push({ op: 'emit', message }),
    };
    return { deps: { view, ctx, vocab, adapter }, calls, drawCount: () => draws };
}

// ----------------------------------------------------------------------------
// Conditions
// ----------------------------------------------------------------------------

describe('evaluateCondition — builtin vocabulary (D8)', () => {
    it('should resolve always/never', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'always' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'never' }, deps)).toBe(false);
    });

    it('should compare effective stats with every op', () => {
        const { deps } = makeDeps();
        const stat = (op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq', value: number): Condition =>
            ({ type: 'stat', ref: 'attacker', stat: 'strength', op, value });
        expect(evaluateCondition(stat('lt', 9), deps)).toBe(true);
        expect(evaluateCondition(stat('lte', 8), deps)).toBe(true);
        expect(evaluateCondition(stat('gt', 7), deps)).toBe(true);
        expect(evaluateCondition(stat('gte', 8), deps)).toBe(true);
        expect(evaluateCondition(stat('eq', 8), deps)).toBe(true);
        expect(evaluateCondition(stat('eq', 7), deps)).toBe(false);
    });

    it('should read CURRENT hp for stat "health", not the effective max (D7/§7 terror semantics)', () => {
        const { deps } = makeDeps();
        // knight.health = 23 (current), knight.stats.health = 30 (effective).
        expect(evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'health', op: 'lte', value: 23 }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'health', op: 'gt', value: 23 }, deps)).toBe(false);
        expect(evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'health', op: 'eq', value: 30 }, deps)).toBe(false);
    });

    it('should resolve all three refs (attacker/target/self→actor fallback, D7)', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'stat', ref: 'target', stat: 'strength', op: 'eq', value: 10 }, deps)).toBe(true);
        // self with no explicit self ref falls back to actor.
        const selfOnly = makeDeps([0.5], { actor: knight });
        expect(evaluateCondition({ type: 'stat', ref: 'self', stat: 'defense', op: 'gte', value: 3 }, selfOnly.deps)).toBe(true);
        const explicitSelf = makeDeps([0.5], { actor: knight, target: brute, self: brute });
        expect(evaluateCondition({ type: 'stat', ref: 'self', stat: 'strength', op: 'eq', value: 10 }, explicitSelf.deps)).toBe(true);
    });

    it('should evaluate has-status', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'has-status', ref: 'attacker', status: 'fear' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'has-status', ref: 'attacker', status: 'poison' }, deps)).toBe(false);
        expect(evaluateCondition({ type: 'has-status', ref: 'target', status: 'fear' }, deps)).toBe(false);
    });

    it('should evaluate has-gear through the slot↔kind map (D9)', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'has-gear', ref: 'attacker' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'has-gear', ref: 'attacker', kind: 'weapon' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'has-gear', ref: 'attacker', kind: 'armour' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'has-gear', ref: 'target', kind: 'armour' }, deps)).toBe(false);
        expect(evaluateCondition({ type: 'has-gear', ref: 'attacker', slot: 'body' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'has-gear', ref: 'attacker', slot: 'shield' }, deps)).toBe(false);
    });

    it('should evaluate mode', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'mode', is: 'teams' }, deps)).toBe(true);
        expect(evaluateCondition({ type: 'mode', is: 'ffa' }, deps)).toBe(false);
    });

    it('should consume exactly one shared-RNG draw per chance evaluation (D4g)', () => {
        const { deps, drawCount } = makeDeps([0.2, 0.6]);
        expect(evaluateCondition({ type: 'chance', p: 0.5 }, deps)).toBe(true);   // 0.2 < 0.5
        expect(evaluateCondition({ type: 'chance', p: 0.5 }, deps)).toBe(false);  // 0.6 < 0.5 fails
        expect(drawCount()).toBe(2);
    });

    it('should short-circuit all/any and bound RNG consumption accordingly (D4g)', () => {
        const all = makeDeps([0.5]);
        expect(evaluateCondition({
            type: 'all',
            of: [{ type: 'chance', p: 0.1 }, { type: 'chance', p: 0.9 }],
        }, all.deps)).toBe(false);
        expect(all.drawCount()).toBe(1); // second chance never evaluated

        const any = makeDeps([0.5]);
        expect(evaluateCondition({
            type: 'any',
            of: [{ type: 'chance', p: 0.9 }, { type: 'chance', p: 0.1 }],
        }, any.deps)).toBe(true);
        expect(any.drawCount()).toBe(1);

        // Empty lists: standard logic (all ⇒ true, any ⇒ false).
        expect(evaluateCondition({ type: 'all', of: [] }, all.deps)).toBe(true);
        expect(evaluateCondition({ type: 'any', of: [] }, any.deps)).toBe(false);
    });

    it('should negate with not and compose nested trees exactly', () => {
        const { deps } = makeDeps();
        expect(evaluateCondition({ type: 'not', of: { type: 'stat', ref: 'attacker', stat: 'strength', op: 'eq', value: 8 } }, deps)).toBe(false);
        expect(evaluateCondition({
            type: 'all',
            of: [
                { type: 'any', of: [{ type: 'never' }, { type: 'mode', is: 'teams' }] },
                { type: 'not', of: { type: 'has-status', ref: 'target', status: 'poison' } },
            ],
        }, deps)).toBe(true);
    });
});

describe('evaluateCondition — namespaced code vocab (D8)', () => {
    it('should pass flat params excluding type and require a boolean result', () => {
        const seen: { params: unknown; sameView: boolean; sameCtx: boolean }[] = [];
        let expectedCtx: unknown;
        const vocab = makeVocab({
            conditions: {
                'acme/low-hp': (v, c, params) => {
                    seen.push({ params, sameView: v === view, sameCtx: c === expectedCtx });
                    return (params as { threshold: number }).threshold < 10;
                },
            },
        });
        const fixture = makeDeps([0.5], { actor: knight, target: brute }, vocab);
        expectedCtx = fixture.deps.ctx;
        expect(evaluateCondition({ type: 'acme/low-hp', threshold: 5, note: 'x' }, fixture.deps)).toBe(true);
        expect(seen[0].params).toEqual({ threshold: 5, note: 'x' }); // `type` excluded (flat convention)
        expect(seen[0].sameView).toBe(true);
        expect(seen[0].sameCtx).toBe(true); // the exact StepContext object is passed through
    });

    it('should fault on unregistered, unknown-builtin and non-boolean vocab results', () => {
        const { deps } = makeDeps();
        expect(() => evaluateCondition({ type: 'acme/missing' }, deps)).toThrow("unknown condition type: 'acme/missing'");
        expect(() => evaluateCondition({ type: 'bogus' } as never, deps)).toThrow("unknown condition type: 'bogus'");
        const numVocab = makeVocab({ conditions: { 'acme/num': () => 7 as unknown as boolean } });
        const numDeps = makeDeps([0.5], { actor: knight, target: brute }, numVocab);
        expect(() => evaluateCondition({ type: 'acme/num' }, numDeps.deps)).toThrow("vocab condition 'acme/num' must return a boolean");
    });
});

describe('evaluateCondition — bounds and malformed input (D8/D13)', () => {
    const nest = (levels: number): Condition => {
        let condition: Condition = { type: 'always' };
        for (let i = 0; i < levels; i += 1) condition = { type: 'all', of: [condition] };
        return condition;
    };

    it('should accept depth 16 nodes and fault beyond the 16-level bound', () => {
        const { deps } = makeDeps();
        // 15 wrappers ⇒ innermost leaf sits at depth 16 (legal).
        expect(evaluateCondition(nest(15), deps)).toBe(true);
        // 16 wrappers ⇒ leaf at depth 17 ⇒ deterministic fault (⇒ engine rollback, D7).
        expect(() => evaluateCondition(nest(16), deps)).toThrow('interpreter depth exceeded (max 16)');
    });

    it('should fault on lists longer than 32', () => {
        const { deps } = makeDeps();
        const of = Array.from({ length: 33 }, () => ({ type: 'always' } as Condition));
        expect(() => evaluateCondition({ type: 'all', of }, deps)).toThrow('condition list exceeds the 32-item bound');
    });

    it('should fault with exact malformed messages', () => {
        const { deps } = makeDeps();
        expect(() => evaluateCondition({ type: 'stat', ref: 'nobody', stat: 'strength', op: 'eq', value: 1 } as never, deps))
            .toThrow("malformed 'stat' condition: invalid ref 'nobody'");
        expect(() => evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'magic', op: 'eq', value: 1 } as never, deps))
            .toThrow("malformed 'stat' condition: invalid stat 'magic'");
        expect(() => evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'strength', op: 'between', value: 1 } as never, deps))
            .toThrow("malformed 'stat' condition: invalid op 'between'");
        expect(() => evaluateCondition({ type: 'stat', ref: 'attacker', stat: 'strength', op: 'eq', value: 'x' } as never, deps))
            .toThrow("malformed 'stat' condition: 'value' must be a finite number");
        expect(() => evaluateCondition({ type: 'chance', p: 'half' } as never, deps))
            .toThrow("malformed 'chance' condition: 'p' must be a finite number");
        expect(() => evaluateCondition({ type: 'all', of: 'nope' } as never, deps))
            .toThrow("malformed 'all' condition: 'of' must be an array");
        expect(() => evaluateCondition('stat-string' as never, deps))
            .toThrow('malformed condition: "stat-string"');
    });

    it('should fault on unresolvable target refs', () => {
        const { deps } = makeDeps([0.5], { actor: knight });
        expect(() => evaluateCondition({ type: 'stat', ref: 'target', stat: 'strength', op: 'eq', value: 10 }, deps))
            .toThrow("unresolvable ref: 'target'");
    });
});

// ----------------------------------------------------------------------------
// Effects
// ----------------------------------------------------------------------------

describe('applyEffects — builtin vocabulary (D8)', () => {
    it('should delegate strike to the engine pipeline (depth guard lives there, D5a.12)', () => {
        const { deps, calls } = makeDeps();
        applyEffects([{ type: 'strike' }], deps);
        expect(calls).toEqual([{ op: 'strike' }]);
    });

    it('should translate every builtin effect to exact adapter calls', () => {
        const { deps, calls } = makeDeps();
        const effects: EffectDescriptor[] = [
            { type: 'damage-flat', target: 'target', amount: 6, damageType: 'sharp' },
            { type: 'damage-flat', target: 'self', amount: 4 },
            { type: 'damage-flat', target: 'attacker', amount: 1, damageType: 'true' },
            { type: 'heal', target: 'self', amount: 5 },
            { type: 'apply-status', target: 'target', status: 'poison', stacks: 2, duration: 3, potency: 2 },
            { type: 'apply-status', target: 'target', status: 'fear' },
            { type: 'remove-status', target: 'target', status: 'poison' },
            { type: 'break-equipment', target: 'target', slot: 'weapon-1' },
            { type: 'break-equipment', target: 'attacker' },
            { type: 'modify-stat', target: 'target', stat: 'speed', amount: -1, duration: 2 },
            { type: 'modify-stat', target: 'attacker', stat: 'strength', amount: 3 },
            { type: 'emit', message: 'gravity flips!' },
        ];
        applyEffects(effects, deps);
        // toEqual ignores undefined-valued keys, so omitted optional args are
        // pinned as "not passed through as data" exactly.
        expect(calls).toEqual([
            { op: 'damage-flat', entityId: 'brute', amount: 6, damageType: 'sharp' },
            { op: 'damage-flat', entityId: 'knight', amount: 4 },
            { op: 'damage-flat', entityId: 'knight', amount: 1, damageType: 'true' },
            { op: 'heal', entityId: 'knight', amount: 5 },
            { op: 'apply-status', entityId: 'brute', status: 'poison', stacks: 2, duration: 3, potency: 2 },
            { op: 'apply-status', entityId: 'brute', status: 'fear' },
            { op: 'remove-status', entityId: 'brute', status: 'poison' },
            { op: 'break-equipment', entityId: 'brute', slot: 'weapon-1' },
            { op: 'break-equipment', entityId: 'knight' },
            { op: 'modify-stat', entityId: 'brute', stat: 'speed', amount: -1, duration: 2 },
            { op: 'modify-stat', entityId: 'knight', stat: 'strength', amount: 3 },
            { op: 'emit', message: 'gravity flips!' },
        ]);
    });

    it('should apply effects strictly in listed order', () => {
        const { deps, calls } = makeDeps();
        applyEffects([
            { type: 'emit', message: 'first' },
            { type: 'heal', target: 'self', amount: 1 },
            { type: 'strike' },
            { type: 'emit', message: 'last' },
        ], deps);
        expect(calls.map((call) => call.op)).toEqual(['emit', 'heal', 'strike', 'emit']);
    });
});

describe('applyEffects — namespaced code vocab (D8)', () => {
    it('should expand custom effects into builtin descriptors, applied in order', () => {
        const seen: { params: unknown }[] = [];
        const vocab = makeVocab({
            effects: {
                'acme/boost': (_v, _c, params) => {
                    seen.push({ params });
                    return [
                        { type: 'modify-stat', target: 'target', stat: 'speed', amount: -1, duration: 2 },
                        { type: 'emit', message: 'gravity flips!' },
                    ];
                },
            },
        });
        const { deps, calls } = makeDeps([0.5], { actor: knight, target: brute }, vocab);
        applyEffects([{ type: 'acme/boost', amount: 2 }], deps);
        expect(seen).toEqual([{ params: { amount: 2 } }]); // flat params, type excluded
        expect(calls).toEqual([
            { op: 'modify-stat', entityId: 'brute', stat: 'speed', amount: -1, duration: 2 },
            { op: 'emit', message: 'gravity flips!' },
        ]);
    });

    it('should fault on unregistered and malformed vocab effect results', () => {
        const { deps } = makeDeps();
        expect(() => applyEffects([{ type: 'acme/missing' }], deps)).toThrow("unknown effect type: 'acme/missing'");
        expect(() => applyEffects([{ type: 'bogus' }] as never, deps)).toThrow("unknown effect type: 'bogus'");
        const badVocab = makeVocab({ effects: { 'acme/bad': () => 'nope' as unknown as EffectDescriptor[] } });
        const badDeps = makeDeps([0.5], { actor: knight, target: brute }, badVocab);
        expect(() => applyEffects([{ type: 'acme/bad' }], badDeps.deps)).toThrow("vocab effect 'acme/bad' must return an EffectDescriptor[]");
    });
});

describe('applyEffects — bounds and malformed input (D8/D13)', () => {
    it('should fault on effect lists longer than 32', () => {
        const { deps } = makeDeps();
        const effects = Array.from({ length: 33 }, () => ({ type: 'emit', message: 'x' } as EffectDescriptor));
        expect(() => applyEffects(effects, deps)).toThrow('effect list exceeds the 32-item bound');
    });

    it('should fault on custom expansion beyond the depth bound', () => {
        // Each custom effect re-enters the interpreter one level deeper.
        const vocab = makeVocab({
            effects: { 'acme/loop': () => [{ type: 'acme/loop' }] },
        });
        const { deps } = makeDeps([0.5], { actor: knight, target: brute }, vocab);
        expect(() => applyEffects([{ type: 'acme/loop' }], deps)).toThrow('interpreter depth exceeded (max 16)');
    });

    it('should fault with exact malformed messages', () => {
        const { deps, calls } = makeDeps();
        expect(() => applyEffects([{ type: 'damage-flat', target: 'target', amount: 'x' } as never], deps))
            .toThrow("malformed 'damage-flat' effect: 'amount' must be a finite number");
        expect(() => applyEffects([{ type: 'damage-flat', target: 'target', amount: 1, damageType: 'fire' } as never], deps))
            .toThrow("malformed 'damage-flat' effect: invalid damageType 'fire'");
        expect(() => applyEffects([{ type: 'heal', target: 'nobody', amount: 1 } as never], deps))
            .toThrow("malformed 'heal' effect: invalid ref 'nobody'");
        expect(() => applyEffects([{ type: 'emit' } as never], deps))
            .toThrow("malformed 'emit' effect: 'message' must be a string");
        expect(() => applyEffects([{ type: 'modify-stat', target: 'target', stat: 'magic', amount: 1 } as never], deps))
            .toThrow("malformed 'modify-stat' effect: invalid stat 'magic'");
        expect(() => applyEffects([{ type: 'break-equipment', target: 'target', slot: 'back' } as never], deps))
            .toThrow("malformed 'break-equipment' effect: invalid slot 'back'");
        expect(() => applyEffects('nope' as never, deps)).toThrow('effects must be an array');
        expect(calls).toEqual([]); // every fault happened before any mutation
    });

    it('should fault on unresolvable target refs before calling the adapter', () => {
        const { deps, calls } = makeDeps([0.5], { actor: knight });
        expect(() => applyEffects([{ type: 'heal', target: 'target', amount: 1 }], deps))
            .toThrow("unresolvable ref: 'target'");
        expect(calls).toEqual([]);
    });
});
