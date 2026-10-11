// ============================================================================
// @userfiction/combat â€” src/pipeline.test.ts â€” T5 turn-skeleton tests
// (task Â§10: phase order via event sequence â€” outcome:decide runs AFTER the
// step:end chain and BEFORE the terminal outcome event; fault rollback:
// state == pre-step, fault events removed, terminal)
// ============================================================================
// The runner is built DIRECTLY (registry + state + log + rng) so the event
// sequences below pin the pipeline's own machinery, not the engine wrapper.
// All assertions are exact arrays/objects (deterministic standard).
// ============================================================================

import { createTurnRunner } from './pipeline';
import type { TurnRunner } from './pipeline';
import { createPluginRegistry } from './plugins';
import { defaultRules } from './rules';
import { createCombatState, createEntityState, deepCopy, snapshotStateOf } from './state';
import type { CombatState } from './state';
import { createEventLog } from './events';
import { createRng } from './rng';
import type { AbilityDefinition, CombatPlugin, DeclarativeRule, EventDraft, HookHandler, ScheduleEntry, StateView, StepContext } from './types';

interface HarnessOptions {
    plugins?: CombatPlugin[];
    rules?: DeclarativeRule[];
    builtinRules?: boolean;
    maxCascade?: number;
    maxSteps?: number;
    abilities?: Map<string, AbilityDefinition>;
    entities?: ReturnType<typeof createEntityState>[];
    seed?: number;
}

// Two unarmed ffa fighters (50 hp each) â€” no equipment events, no shield
// rolls; seed 2 makes the default dodge roll land (0.325 â‰¥ 0.05).
const mkHarness = (options: HarnessOptions = {}) => {
    const seed = options.seed ?? 2;
    const entities = options.entities ?? [
        createEntityState({ id: 'a', order: 0, stats: { health: 50, strength: 0, speed: 1 } }),
        createEntityState({ id: 'b', order: 1, stats: { health: 50, strength: 0, speed: 1 } }),
    ];
    const state: CombatState = createCombatState({
        mode: 'ffa',
        entities,
        rng: { seed, state: seed, draws: 0 },
        schedule: [],
    });
    const rng = createRng(seed);
    const log = createEventLog(100_000);
    const builtin = options.builtinRules === false ? undefined : defaultRules({ gear: [] });
    let runner: TurnRunner;
    const registry = createPluginRegistry({
        builtin,
        plugins: options.plugins ?? [],
        rules: options.rules ?? [],
        runtime: () => runner.runtime(),
    });
    runner = createTurnRunner({
        state,
        registry,
        rng,
        log,
        config: { maxSteps: options.maxSteps ?? 10_000, maxCascade: options.maxCascade ?? 1_000, maxLogEvents: 100_000 },
        gear: () => undefined,
        ability: (id) => options.abilities?.get(id),
        resistances: {},
        builtinRules: options.builtinRules !== false,
    });
    runner.armInitialSchedule();
    log.emit({ type: 'battle:start', payload: { seed, mode: 'ffa' } }, 0, 0);
    return { runner, log, rng, registry };
};

// Compact event shape for exact sequence assertions.
const shape = (events: EventDraft[] | { type: string; actor?: string; target?: string; payload?: Record<string, unknown> }[]) =>
    (events as { type: string; actor?: string; target?: string; payload?: Record<string, unknown> }[]).map((event) => ({
        type: event.type,
        actor: event.actor,
        target: event.target,
        payload: event.payload,
    }));

describe('pipeline phase order (D5a)', () => {
    it('one basic-attack step emits turn:start â†’ action â†’ damage â†’ step:end in order', () => {
        const { runner, log } = mkHarness({
            plugins: [{ id: 't/crit-off', overrides: ['attack:crit'], hooks: { 'attack:crit': () => ({ crit: false }) } as Record<string, HookHandler> }],
        });
        expect(runner.step()).toBe(true);
        expect(shape(log.all().slice(1))).toEqual([
            { type: 'turn:start', actor: 'a', target: undefined, payload: undefined },
            { type: 'action', actor: 'a', target: undefined, payload: { kind: 'attack' } },
            {
                type: 'damage',
                actor: 'a',
                target: 'b',
                payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } },
            },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 1_000_000 } },
        ]);
        expect(runner.state().terminal).toBeNull();
        expect(runner.state().entities[1].health).toBe(49);
    });

    it('outcome:decide runs AFTER the step:end chain and BEFORE the outcome event (D5a.14/15)', () => {
        const { runner, log } = mkHarness({
            plugins: [
                {
                    id: 't/observer',
                    hooks: { 'step:end': (_view: StateView, ctx: StepContext) => ctx.emit({ type: 'custom-obs' }) } as Record<string, HookHandler>,
                },
                {
                    id: 't/decider',
                    overrides: ['outcome:decide'],
                    hooks: { 'outcome:decide': (_view: StateView, _ctx: StepContext, args: { step: number }) => (args.step >= 1 ? { outcome: 'draw', reason: 'test-end' } : null) } as unknown as Record<string, HookHandler>,
                },
            ],
        });
        runner.step();
        expect(shape(log.all().slice(1))).toEqual([
            { type: 'turn:start', actor: 'a', target: undefined, payload: undefined },
            { type: 'action', actor: 'a', target: undefined, payload: { kind: 'attack' } },
            { type: 'damage', actor: 'a', target: 'b', payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 1_000_000 } },
            { type: 'custom-obs', actor: undefined, target: undefined, payload: undefined },
            { type: 'outcome', actor: undefined, target: undefined, payload: { outcome: 'draw', reason: 'test-end' } },
        ]);
        // engine stamped the step into the verdict (D5g/D10)
        expect(runner.state().terminal).toEqual({ outcome: 'draw', reason: 'test-end', step: 1 });
    });

    it('a skipped (stunned) turn is still a consumed step: turn:start â†’ action skip â†’ step:end', () => {
        const entities = [
            createEntityState({ id: 'a', order: 0, stats: { health: 50, strength: 0, speed: 1 }, statuses: [{ id: 'stun', duration: 2 }] }),
            createEntityState({ id: 'b', order: 1, stats: { health: 50, strength: 0, speed: 1 } }),
        ];
        const { runner, log } = mkHarness({ entities });
        runner.step();
        expect(shape(log.all().slice(1)).map((event) => event.type)).toEqual(['turn:start', 'action', 'step:end']);
        expect(log.all()[2].payload).toEqual({ kind: 'skip', reason: 'stunned' });
        // stun decayed 2 â†’ 1 at own turn end (D5c)
        expect(runner.state().entities[0].statuses).toEqual([{ id: 'stun', stacks: 1, duration: 1, potency: 1 }]);
    });
});

describe('pipeline fault rollback (D7)', () => {
    it('handler throw mid-step: state == pre-step, in-step events removed, fault+outcome only, terminal', () => {
        const { runner, log } = mkHarness({
            plugins: [
                {
                    id: 'boom/post',
                    hooks: {
                        'damage:post': () => {
                            throw new Error('post-boom');
                        },
                    } as Record<string, HookHandler>,
                },
            ],
        });
        const preSnap = snapshotStateOf(runner.state());
        const preEvents = deepCopy(log.all());
        expect(runner.step()).toBe(true);
        // log: exactly the pre-step events + fault + the single outcome event
        const events = log.all();
        expect(events.slice(0, preEvents.length)).toEqual(preEvents);
        expect(shape(events.slice(preEvents.length))).toEqual([
            { type: 'fault', actor: undefined, target: undefined, payload: { error: 'post-boom', pluginId: 'boom/post', hook: 'damage:post' } },
            { type: 'outcome', actor: undefined, target: undefined, payload: { outcome: 'fault', reason: 'fault', error: 'post-boom' } },
        ]);
        // state + RNG + counters restored bit-for-bit; ONLY the terminal
        // fault stamp differs (it is the new state D7 mandates)
        const post = snapshotStateOf(runner.state());
        expect({ ...post, terminal: null }).toEqual(preSnap);
        expect(post.terminal).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'post-boom' });
        expect(runner.state().terminal).toEqual({ outcome: 'fault', step: 1, reason: 'fault', error: 'post-boom' });
        // further steps are no-ops (terminal, no quarantine-and-continue)
        const after = deepCopy(log.all());
        expect(runner.step()).toBe(true);
        expect(log.all()).toEqual(after);
    });

    it('invalid single-mode return is a fault attributed to the owning plugin + hook', () => {
        const { runner, log } = mkHarness({
            plugins: [
                {
                    id: 'bad/select',
                    overrides: ['action:select'],
                    hooks: { 'action:select': () => ({ kind: 'spin' }) } as Record<string, HookHandler>,
                },
            ],
        });
        runner.step();
        const events = log.all();
        expect(shape(events.slice(1))).toEqual([
            { type: 'fault', actor: undefined, target: undefined, payload: { error: "invalid action:select result: unknown kind 'spin'", pluginId: 'bad/select', hook: 'action:select' } },
            { type: 'outcome', actor: undefined, target: undefined, payload: { outcome: 'fault', reason: 'fault', error: "invalid action:select result: unknown kind 'spin'" } },
        ]);
        expect(runner.state().step).toBe(0); // rolled back before the turn
        expect(runner.state().terminal!.outcome).toBe('fault');
    });

    it('invalid chain return (non-array, non-void) is a fault', () => {
        const { runner, log } = mkHarness({
            plugins: [{ id: 'bad/chain', hooks: { 'step:end': () => 'nope' } as Record<string, HookHandler> }],
        });
        runner.step();
        const fault = log.all().find((event) => event.type === 'fault');
        expect(fault!.payload).toEqual({
            error: "invalid chain result from 'step:end' handler: expected void or EffectDescriptor[]",
            pluginId: 'bad/chain',
            hook: 'step:end',
        });
    });

    it('maxCascade breach faults the step (D4f: runaway rule is an error)', () => {
        // cap 3: turn:start(1) action(2) damage(3) step:end(4) â‡’ fault
        const { runner, log } = mkHarness({
            maxCascade: 3,
            plugins: [{ id: 't/crit-off', overrides: ['attack:crit'], hooks: { 'attack:crit': () => ({ crit: false }) } as Record<string, HookHandler> }],
        });
        runner.step();
        const fault = log.all().find((event) => event.type === 'fault');
        // cap breach at the engine-emitted step:end event: no handler was in
        // flight, so the fault carries only the error (hook/plugin omitted)
        expect(fault!.payload).toEqual({ error: 'maxCascade exceeded: more than 3 events in one step' });
        expect(runner.state().terminal!.outcome).toBe('fault');
        expect(runner.state().step).toBe(0);
    });

    it('strike recursion beyond depth 2 faults (D5a.12/D8)', () => {
        const abilities = new Map<string, AbilityDefinition>([['fury', { id: 'fury', effects: [{ type: 'strike' }] }]]);
        const entities = [
            createEntityState({ id: 'a', order: 0, stats: { health: 100, strength: 0, speed: 1 }, cooldowns: { fury: 0 } }),
            createEntityState({ id: 'b', order: 1, stats: { health: 100, strength: 0, speed: 1 } }),
        ];
        const { runner, log } = mkHarness({
            entities,
            abilities,
            plugins: [
                {
                    id: 't/fury',
                    overrides: ['action:select', 'attack:dodge', 'attack:crit'],
                    hooks: {
                        'action:select': () => ({ kind: 'ability', abilityId: 'fury' }),
                        'attack:dodge': () => ({ dodged: false }),
                        'attack:crit': () => ({ crit: false }),
                    } as Record<string, HookHandler>,
                },
            ],
            // every strike's damage:post fires another strike:
            // ability strike (1) â†’ rule strike (2) â†’ rule strike (3) â‡’ fault
            rules: [{ id: 'echo', hook: 'damage:post', effects: [{ type: 'strike' }] }],
        });
        runner.step();
        const fault = log.all().find((event) => event.type === 'fault');
        // attributed to the synthetic JSON-rules plugin at the hook where the
        // third nested strike was attempted
        expect(fault!.payload).toEqual({ error: 'strike recursion depth exceeded (max 2)', pluginId: '@definition/rules', hook: 'damage:post' });
        expect(runner.state().terminal!.outcome).toBe('fault');
    });

    it('outcome:decide handlers may not emit or consume rng â€” engine-enforced (D5g/D7)', () => {
        const { runner, log } = mkHarness({
            plugins: [
                {
                    id: 't/chatty-decider',
                    overrides: ['outcome:decide'],
                    hooks: {
                        'outcome:decide': (_view: StateView, ctx: StepContext) => {
                            ctx.emit({ type: 'sneaky' });
                            return null;
                        },
                    } as unknown as Record<string, HookHandler>,
                },
            ],
        });
        runner.step();
        const fault = log.all().find((event) => event.type === 'fault');
        expect((fault!.payload as Record<string, unknown>).error).toContain('outcome:decide handlers must not emit');
        expect((fault!.payload as Record<string, unknown>).pluginId).toBe('t/chatty-decider');
    });
});

describe('pipeline scheduling integration (D4a/D4e)', () => {
    it('initial entries: speed 4 â‡’ 250000, speed 1 â‡’ 1000000, never 0 (D4a/D4c)', () => {
        const entities = [
            createEntityState({ id: 'fast', order: 0, stats: { health: 50, strength: 0, speed: 4 } }),
            createEntityState({ id: 'slow', order: 1, stats: { health: 50, strength: 0, speed: 1 } }),
        ];
        const { runner } = mkHarness({ entities });
        expect(runner.state().schedule).toEqual([
            { entityId: 'fast', readyAt: 250_000 },
            { entityId: 'slow', readyAt: 1_000_000 },
        ]);
    });

    it('deaths drop the dead entity pending entries immediately (D4e)', () => {
        const entities = [
            createEntityState({ id: 'a', order: 0, stats: { health: 50, strength: 100, speed: 1 } }),
            createEntityState({ id: 'b', order: 1, stats: { health: 1, strength: 0, speed: 1 } }),
        ];
        const { runner } = mkHarness({ entities });
        runner.step();
        const schedule: ScheduleEntry[] = runner.state().schedule;
        expect(schedule.map((entry) => entry.entityId)).toEqual(['a']);
        expect(runner.state().terminal).toEqual({ outcome: 'victory', winner: 'a', step: 1 });
    });

    it('empty schedule + non-terminal â‡’ step makes no progress (decision 9)', () => {
        const { runner, log } = mkHarness();
        runner.state().schedule.length = 0;
        expect(runner.step()).toBe(false);
        expect(log.count()).toBe(1); // only battle:start
    });
});

describe('pipeline builtinRules:false floor removal (D5/D6)', () => {
    it('no action:select â‡’ deliberate wait; no decide â‡’ battle continues', () => {
        const { runner, log } = mkHarness({ builtinRules: false });
        expect(runner.step()).toBe(true);
        expect(shape(log.all().slice(1))).toEqual([
            { type: 'turn:start', actor: 'a', target: undefined, payload: undefined },
            { type: 'action', actor: 'a', target: undefined, payload: { kind: 'wait' } },
            { type: 'step:end', actor: undefined, target: undefined, payload: { step: 1, time: 1_000_000 } },
        ]);
        expect(runner.state().terminal).toBeNull();
    });

    it('no builtin â‡’ no poison/stun decay at turn end (chain defaults gated)', () => {
        const entities = [
            createEntityState({ id: 'a', order: 0, stats: { health: 50, strength: 0, speed: 1 }, statuses: [{ id: 'poison', stacks: 2, duration: 2, potency: 3 }] }),
            createEntityState({ id: 'b', order: 1, stats: { health: 50, strength: 0, speed: 1 } }),
        ];
        const { runner } = mkHarness({ entities, builtinRules: false });
        runner.step();
        expect(runner.state().entities[0].statuses).toEqual([{ id: 'poison', stacks: 2, duration: 2, potency: 3 }]);
        expect(runner.state().entities[0].health).toBe(50);
    });
});
