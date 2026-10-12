// ============================================================================
// @userfiction/combat — src/behavior/plugins.test.ts — T4 plugin registry tests
// ============================================================================
// Pins the D6/D7 load contract with exact evidence:
//   - registration order builtin → code plugins → synthetic '@definition/rules'
//   - single-mode resolution: declared override (last-wins across correct
//     duplicate claims — legal, never an error) else builtin default
//   - chain-mode: ALL handlers in registration order, JSON rules LAST
//   - fail-fast rejection with the FULL collected error list (exact messages):
//     duplicate ids, reserved synthetic id, unknown hook ids, non-function
//     handlers, arrays on single-mode hooks, undeclared single-mode handlers
//     (builtin EXEMPT), bad overrides, bad vocab shapes, the 32-handler chain
//     bound, rules without a runtime, malformed rules.
//   - namespaced vocab merge (ids.ts namespaced()) resolvable by the
//     interpreter (effects.ts).
// ============================================================================

import { createPluginRegistry, DEFINITION_RULES_PLUGIN_ID } from './plugins';
import type { PluginRegistryRuntime } from './plugins';
import { CombatPluginError } from '../contract/types';
import type {
    ChainHookId,
    CombatPlugin,
    DeclarativeRule,
    EntityView,
    HookHandler,
    StateView,
    StepContext,
    VocabConditionHandler,
    VocabEffectHandler,
} from '../contract/types';
import type { EffectAdapter } from './effects';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const actor: EntityView = {
    id: 'a', name: 'a', order: 0, living: true, health: 10, maxHealth: 30,
    stats: { health: 30, strength: 1, speed: 1, defense: 0, precision: 0, evasion: 0 },
    statuses: [], equipment: [], cooldowns: {},
};

// viewA: actor at 10 hp; viewB: same entity at 20 hp — the pair pins the
// "fresh view per rule" contract (later rules observe earlier effects).
const viewA: StateView = { mode: 'ffa', step: 1, time: 1000, entities: [actor] };
const viewB: StateView = {
    mode: 'ffa', step: 1, time: 1000,
    entities: [{ ...actor, health: 20 }],
};
const view: StateView = viewA;

const ctx: StepContext = {
    rng: { next: () => 0.5, int: () => 0, pick: () => undefined },
    emit: () => undefined,
    step: 1,
    time: 1000,
    hook: 'damage:post',
    depth: 0,
    refs: { actor },
};

// Recording chain handler factory — order assertions use the label list.
const h = (label: string, calls: string[]): HookHandler => () => {
    calls.push(label);
};

interface AdapterFixture {
    adapter: EffectAdapter;
    calls: Record<string, unknown>[];
}

const makeAdapter = (): AdapterFixture => {
    const calls: Record<string, unknown>[] = [];
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
    return { adapter, calls };
};

const noopRuntime = (): PluginRegistryRuntime => ({ adapter: makeAdapter().adapter, view: () => viewA });

// Assert a config throws CombatPluginError with EXACTLY the expected list.
const expectPluginErrors = (config: Parameters<typeof createPluginRegistry>[0], expected: string[]): void => {
    let thrown: unknown;
    try {
        createPluginRegistry(config);
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(CombatPluginError);
    expect((thrown as CombatPluginError).name).toBe('CombatPluginError');
    expect((thrown as CombatPluginError).errors).toEqual(expected);
};

// ----------------------------------------------------------------------------
// Single-mode resolution (D6: one handler; declared override last-wins;
// else builtin default; else undefined)
// ----------------------------------------------------------------------------

describe('single-mode hook resolution', () => {
    const builtin: CombatPlugin = {
        id: '@userfiction/combat/rules',
        // Builtin ships single-mode handlers WITHOUT overrides — exempt (D6:
        // defaultRules "claims nothing").
        hooks: {
            'attack:dodge': () => ({ dodged: false }),
            'damage:base': () => ({ amount: 7, damageType: 'blunt' as const }),
        },
    };

    it('should fall back to the builtin default when nothing overrides', () => {
        const registry = createPluginRegistry({ builtin });
        expect(registry.single('attack:dodge')!(view, ctx, {})).toEqual({ dodged: false });
        expect(registry.single('damage:base')!(view, ctx, {})).toEqual({ amount: 7, damageType: 'blunt' });
        expect(registry.single('action:select')).toBeUndefined();
    });

    it('should run the declared override instead of the builtin', () => {
        const override: CombatPlugin = {
            id: 'mishap/rules',
            overrides: ['attack:dodge'],
            hooks: { 'attack:dodge': () => ({ dodged: true }) },
        };
        const registry = createPluginRegistry({ builtin, plugins: [override] });
        expect(registry.single('attack:dodge')!(view, ctx, {})).toEqual({ dodged: true });
        // Untouched hooks keep the builtin default.
        expect(registry.single('damage:base')!(view, ctx, {})).toEqual({ amount: 7, damageType: 'blunt' });
    });

    it('should resolve correct duplicate claims by deterministic last-wins (D6)', () => {
        const first: CombatPlugin = { id: 'a/x', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ who: 'a' }) } };
        const second: CombatPlugin = { id: 'b/y', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ who: 'b' }) } };
        const registry = createPluginRegistry({ plugins: [first, second] });
        expect(registry.single('attack:dodge')!(view, ctx, {})).toEqual({ who: 'b' });
        // Reversing registration order reverses the winner — proof it is
        // registration order, not id sort or luck.
        const reversed = createPluginRegistry({ plugins: [second, first] });
        expect(reversed.single('attack:dodge')!(view, ctx, {})).toEqual({ who: 'a' });
    });

    it('should skip a declared override that ships no handler (legal no-op)', () => {
        const first: CombatPlugin = { id: 'a/x', overrides: ['attack:dodge'], hooks: { 'attack:dodge': () => ({ who: 'a' }) } };
        const declareOnly: CombatPlugin = { id: 'b/y', overrides: ['attack:dodge'] };
        const registry = createPluginRegistry({ plugins: [first, declareOnly] });
        expect(registry.single('attack:dodge')!(view, ctx, {})).toEqual({ who: 'a' });
    });

    it('should return undefined with no builtin and no override (builtinRules:false, D5g)', () => {
        const registry = createPluginRegistry({});
        expect(registry.single('attack:dodge')).toBeUndefined();
        expect(registry.single('outcome:decide')).toBeUndefined();
    });
});

// ----------------------------------------------------------------------------
// Chain-mode ordering (D6: builtin → code → JSON rules, all handlers run)
// ----------------------------------------------------------------------------

describe('chain-mode ordering and JSON rule compilation', () => {
    it('should run builtin, then code plugins in order, then JSON rules last', () => {
        const calls: string[] = [];
        const { adapter, calls: adapterCalls } = makeAdapter();
        const builtin: CombatPlugin = { id: '@userfiction/combat/rules', hooks: { 'damage:post': h('builtin', calls) } };
        const p1: CombatPlugin = { id: 'p/one', hooks: { 'damage:post': [h('p1a', calls), h('p1b', calls)] } };
        const p2: CombatPlugin = { id: 'p/two', hooks: { 'damage:post': h('p2', calls) } };
        const rules: DeclarativeRule[] = [
            { id: 'r1', hook: 'damage:post', effects: [{ type: 'emit', message: 'rule fired' }] },
        ];
        const registry = createPluginRegistry({
            builtin,
            plugins: [p1, p2],
            rules,
            runtime: () => ({ adapter, view: () => viewA }),
        });

        const chain = registry.chain('damage:post');
        // builtin(1) + p1(2) + p2(1) + synthetic rules plugin(ONE handler that
        // runs all rules for this hook, in listed order) = 5.
        expect(chain.length).toBe(5);
        for (const handler of chain) handler(view, ctx, {});
        expect(calls).toEqual(['builtin', 'p1a', 'p1b', 'p2']);
        // The synthetic rules handler ran LAST and applied its effect through
        // the engine adapter (mutation ownership, D7/D8).
        expect(adapterCalls).toEqual([{ op: 'emit', message: 'rule fired' }]);
        expect(registry.chain('step:end')).toEqual([]);
        expect(registry.pluginIds()).toEqual(['@userfiction/combat/rules', 'p/one', 'p/two', DEFINITION_RULES_PLUGIN_ID]);
    });

    it('should evaluate each rule against a FRESH view (later rules see earlier effects, D8)', () => {
        const { adapter, calls } = makeAdapter();
        let viewCalls = 0;
        const rules: DeclarativeRule[] = [
            { id: 'r1', hook: 'step:end', effects: [{ type: 'emit', message: 'r1' }] },
            {
                id: 'r2',
                hook: 'step:end',
                when: { type: 'stat', ref: 'attacker', stat: 'health', op: 'gte', value: 20 },
                effects: [{ type: 'emit', message: 'r2' }],
            },
        ];
        const registry = createPluginRegistry({
            rules,
            runtime: () => ({ adapter, view: () => (viewCalls++ === 0 ? viewA : viewB) }),
        });
        for (const handler of registry.chain('step:end')) handler(view, ctx, {});
        // r1 saw viewA (10 hp); r2's condition saw viewB (20 hp) ⇒ fired.
        expect(calls).toEqual([{ op: 'emit', message: 'r1' }, { op: 'emit', message: 'r2' }]);
        expect(viewCalls).toBe(2);
    });

    it('should no-op rules whose condition is false and run listed rules in order', () => {
        const { adapter, calls } = makeAdapter();
        const rules: DeclarativeRule[] = [
            { id: 'r1', hook: 'step:end', when: { type: 'never' }, effects: [{ type: 'emit', message: 'skipped' }] },
            { id: 'r2', hook: 'step:end', when: { type: 'always' }, effects: [{ type: 'heal', target: 'self', amount: 3 }] },
        ];
        const registry = createPluginRegistry({ rules, runtime: () => ({ adapter, view: () => viewA }) });
        for (const handler of registry.chain('step:end')) handler(view, ctx, {});
        // r1's `never` condition no-ops; only r2's effect reaches the adapter.
        expect(calls).toEqual([{ op: 'heal', entityId: 'a', amount: 3 }]);
    });

    it('should resolve rule conditions/effects through ctx refs (attacker → actor)', () => {
        const { adapter, calls } = makeAdapter();
        const rules: DeclarativeRule[] = [
            {
                id: 'terror',
                hook: 'damage:post',
                when: { type: 'stat', ref: 'target', stat: 'health', op: 'lte', value: 12 },
                effects: [{ type: 'apply-status', target: 'target', status: 'fearful', stacks: 1 }],
            },
        ];
        // ctx.refs.target = the 10-hp entity (≤ 12) ⇒ rule fires and its
        // effect resolves the same 'target' ref to that entity's id.
        const attackCtx: StepContext = { ...ctx, refs: { actor, target: actor } };
        const registry = createPluginRegistry({ rules, runtime: () => ({ adapter, view: () => viewA }) });
        for (const handler of registry.chain('damage:post')) handler(view, attackCtx, {});
        expect(calls).toEqual([{ op: 'apply-status', entityId: 'a', status: 'fearful', stacks: 1 }]);
    });
});

// ----------------------------------------------------------------------------
// Vocab merge (D8 namespaced 'pluginId/name')
// ----------------------------------------------------------------------------

describe('vocab namespacing', () => {
    it('should register short names under namespaced ids and miss cleanly', () => {
        const condFn: VocabConditionHandler = () => true;
        const effFn: VocabEffectHandler = () => [];
        const builtinCond: VocabConditionHandler = () => false;
        const builtin: CombatPlugin = { id: '@userfiction/combat/rules', vocab: { conditions: { 'builtin-cond': builtinCond } } };
        const plugin: CombatPlugin = {
            id: 'mishap/vocab',
            vocab: { conditions: { low: condFn }, effects: { 'gravity-flip': effFn } },
        };
        const registry = createPluginRegistry({ builtin, plugins: [plugin] });
        expect(registry.vocab.condition('mishap/vocab/low')).toBe(condFn);
        expect(registry.vocab.effect('mishap/vocab/gravity-flip')).toBe(effFn);
        expect(registry.vocab.condition('@userfiction/combat/rules/builtin-cond')).toBe(builtinCond);
        expect(registry.vocab.effect('mishap/vocab/missing')).toBeUndefined();
        expect(registry.vocab.condition('nobody/low')).toBeUndefined();
    });
});

// ----------------------------------------------------------------------------
// Fail-fast rejection — exact collected error lists (D7)
// ----------------------------------------------------------------------------

describe('load validation rejections', () => {
    it('should reject duplicate plugin ids', () => {
        expectPluginErrors({ plugins: [{ id: 'dup/a' }, { id: 'dup/a' }] }, ["duplicate plugin id: 'dup/a'"]);
    });

    it('should reject the reserved synthetic id in code', () => {
        expectPluginErrors({ plugins: [{ id: DEFINITION_RULES_PLUGIN_ID }] }, [
            `plugin id reserved for JSON contributions: '${DEFINITION_RULES_PLUGIN_ID}'`,
        ]);
    });

    it('should reject unknown hook ids', () => {
        expectPluginErrors(
            { plugins: [{ id: 'x/y', hooks: { 'bogus:hook': () => undefined } as never }] },
            ["plugin 'x/y' uses unknown hook id: 'bogus:hook'"],
        );
    });

    it('should reject non-function handlers', () => {
        expectPluginErrors(
            { plugins: [{ id: 'x/y', hooks: { 'damage:post': 42 as never } }] },
            ["plugin 'x/y' ships a non-function handler for hook 'damage:post'"],
        );
    });

    it('should reject arrays shipped for single-mode hooks', () => {
        expectPluginErrors(
            { plugins: [{ id: 'x/y', overrides: ['attack:dodge'], hooks: { 'attack:dodge': [() => undefined] as never } }] },
            ["plugin 'x/y' ships an array for single-mode hook 'attack:dodge'"],
        );
    });

    it('should reject undeclared single-mode handlers but exempt the builtin', () => {
        expectPluginErrors(
            { plugins: [{ id: 'x/y', hooks: { 'attack:dodge': () => undefined } }] },
            ["plugin 'x/y' ships single-mode handler 'attack:dodge' without declaring it in overrides"],
        );
        // Builtin ships the same handler with no overrides — legal (D6).
        expect(() => createPluginRegistry({ builtin: { id: '@userfiction/combat/rules', hooks: { 'attack:dodge': () => ({ dodged: false }) } } })).not.toThrow();
    });

    it('should reject overrides that are chain-mode or unknown hook ids', () => {
        expectPluginErrors({ plugins: [{ id: 'x/y', overrides: ['step:end'] }] }, [
            "plugin 'x/y' lists chain-mode hook in overrides: 'step:end'",
        ]);
        expectPluginErrors({ plugins: [{ id: 'x/y', overrides: ['nope'] }] }, [
            "plugin 'x/y' lists unknown hook id in overrides: 'nope'",
        ]);
    });

    it('should reject bad vocab shapes: non-function handlers and "/"-bearing keys', () => {
        expectPluginErrors(
            { plugins: [{ id: 'p', vocab: { effects: { x: 'nope' as never } } }] },
            ["plugin 'p' vocab effects handler for 'x' is not a function"],
        );
        expectPluginErrors(
            { plugins: [{ id: 'p', vocab: { conditions: { 'a/b': () => true } } }] },
            ["plugin 'p' vocab conditions key must be a short name without '/': 'a/b'"],
        );
    });

    it('should collect ALL errors in one CombatPluginError (reader precedent L331–334)', () => {
        expectPluginErrors(
            {
                plugins: [{
                    id: 'bad/p',
                    overrides: ['step:end'],
                    hooks: { 'bogus:hook': () => undefined, 'attack:dodge': [() => undefined] } as never,
                    vocab: { effects: { x: 'nope' as never } },
                }],
            },
            [
                "plugin 'bad/p' lists chain-mode hook in overrides: 'step:end'",
                "plugin 'bad/p' uses unknown hook id: 'bogus:hook'",
                "plugin 'bad/p' ships an array for single-mode hook 'attack:dodge'",
                "plugin 'bad/p' ships single-mode handler 'attack:dodge' without declaring it in overrides",
                "plugin 'bad/p' vocab effects handler for 'x' is not a function",
            ],
        );
    });

    it('should enforce the 32-handler chain bound (D7)', () => {
        const many = (n: number): CombatPlugin[] =>
            Array.from({ length: n }, (_unused, i) => ({ id: `bound/p${i}`, hooks: { 'step:end': () => undefined } }));
        expectPluginErrors({ plugins: many(33) }, ["chain hook 'step:end' exceeds the 32-handler bound"]);
        expect(() => createPluginRegistry({ plugins: many(32) })).not.toThrow();
        expect(createPluginRegistry({ plugins: many(32) }).chain('step:end').length).toBe(32);
    });

    it('should require a runtime provider when rules are present', () => {
        expectPluginErrors(
            { rules: [{ id: 'r1', hook: 'step:end', effects: [] }] },
            ['JSON rules require an effect runtime provider'],
        );
    });

    it('should reject malformed rules: non-chain hook and missing effects', () => {
        expectPluginErrors(
            { rules: [{ id: 'r1', hook: 'attack:dodge' as unknown as ChainHookId, effects: [] }], runtime: noopRuntime },
            ["rule 'r1' hook must be a chain-mode hook: 'attack:dodge'"],
        );
        expectPluginErrors(
            { rules: [{ id: 'r1', hook: 'step:end' } as never], runtime: noopRuntime },
            ["rule 'r1' effects must be an array"],
        );
    });
});
