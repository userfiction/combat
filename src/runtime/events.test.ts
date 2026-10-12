// ============================================================================
// @userfiction/combat — src/runtime/events.test.ts — T5 event log + renderer tests
// (task §10: D11 pinned renderer outputs; D10 id rules; D4f trim notice;
// D7 transaction marker/rollback)
// ============================================================================
// Exact-value assertions throughout (deterministic test standard): full
// toEqual on log arrays, exact rendered strings, exact payload objects.
// ============================================================================

import { createEventLog, renderEventText, eventFormatters } from './events';
import type { EventLog } from './events';
import type { BattleEvent, SimulationSnapshot } from '../contract/types';

// ----------------------------------------------------------------------------
// createEventLog
// ----------------------------------------------------------------------------

describe('createEventLog', () => {
    let log: EventLog;
    beforeEach(() => {
        log = createEventLog(100_000);
    });

    it('stamps monotonic ids from 1 plus step/time (D11/D10)', () => {
        const a = log.emit({ type: 'battle:start', payload: { seed: 7, mode: 'teams' } }, 0, 0);
        const b = log.emit({ type: 'turn:start', actor: 'knight' }, 1, 500_000);
        expect(a).toEqual({ id: 1, step: 0, time: 0, type: 'battle:start', payload: { seed: 7, mode: 'teams' } });
        expect(b).toEqual({ id: 2, step: 1, time: 500_000, type: 'turn:start', actor: 'knight' });
        expect(log.nextEventId()).toBe(3);
    });

    it('omits absent optional fields instead of writing undefined', () => {
        const event = log.emit({ type: 'step:end', payload: { step: 1, time: 5 } }, 1, 5);
        expect(Object.keys(event)).toEqual(['id', 'step', 'time', 'type', 'payload']);
    });

    it('deep-copies the payload so later mutation cannot rewrite history', () => {
        const payload = { amount: 4, nested: { x: 1 } };
        const event = log.emit({ type: 'damage', payload }, 1, 0);
        payload.amount = 99;
        payload.nested.x = 99;
        expect(event.payload).toEqual({ amount: 4, nested: { x: 1 } });
    });

    it('marker/rollback removes in-step events AND rewinds the id counter (D7)', () => {
        log.emit({ type: 'battle:start' }, 0, 0);
        const marker = log.marker();
        log.emit({ type: 'turn:start', actor: 'a' }, 1, 1_000_000);
        log.emit({ type: 'action', actor: 'a', payload: { kind: 'attack' } }, 1, 1_000_000);
        expect(log.count()).toBe(3);
        log.rollback(marker);
        // the faulting step's events are gone and the NEXT id reuses theirs
        expect(log.all().map((event) => event.id)).toEqual([1]);
        expect(log.nextEventId()).toBe(2);
        const fault = log.emit({ type: 'fault', payload: { error: 'x' } }, 1, 1_000_000);
        expect(fault.id).toBe(2);
    });

    it('restore continues ids from max(id)+1 and copies the stored log (D10)', () => {
        const stored: BattleEvent[] = [
            { id: 4, step: 2, time: 2_000_000, type: 'step:end', payload: { step: 2, time: 2_000_000 } },
            { id: 7, step: 3, time: 3_000_000, type: 'turn:start', actor: 'b' },
        ];
        log.restore(stored);
        expect(log.all()).toEqual(stored);
        expect(log.nextEventId()).toBe(8);
        // restoring a detached copy: mutating the source array is inert
        stored[0].type = 'mutated';
        expect(log.all()[0].type).toBe('step:end');
    });

    it('restore of an empty log restarts ids at 1', () => {
        log.emit({ type: 'battle:start' }, 0, 0);
        log.restore([]);
        expect(log.count()).toBe(0);
        expect(log.nextEventId()).toBe(1);
    });

    it('clear rewinds to a fresh log (reset, D10)', () => {
        log.emit({ type: 'battle:start' }, 0, 0);
        log.clear();
        expect(log.count()).toBe(0);
        expect(log.nextEventId()).toBe(1);
    });

    it('trim drops the oldest events and appends the log-trimmed notice at the cap (D3/D4f)', () => {
        const capped = createEventLog(5);
        for (let i = 1; i <= 6; i++) capped.emit({ type: `e${i}` }, 1, 1_000_000);
        const dropped = capped.trim(1, 1_000_000);
        // dropped = 6 − 5 + 1 = 2 (one slot reserved for the notice)
        expect(dropped).toBe(2);
        expect(capped.all().map((event) => event.id)).toEqual([3, 4, 5, 6, 7]);
        expect(capped.all().map((event) => event.type)).toEqual(['e3', 'e4', 'e5', 'e6', 'log-trimmed']);
        expect(capped.all()[4].payload).toEqual({ dropped: 2 });
        expect(capped.all()[4].step).toBe(1);
        expect(capped.all()[4].time).toBe(1_000_000);
    });

    it('trim is a no-op at or below the cap and ids stay monotonic', () => {
        for (let i = 1; i <= 5; i++) log.emit({ type: `e${i}` }, 0, 0);
        expect(log.trim(0, 0)).toBe(0);
        expect(log.count()).toBe(5);
        const ids = log.all().map((event) => event.id);
        expect(ids).toEqual([1, 2, 3, 4, 5]);
    });

    it('trim with cap 1 keeps only the notice', () => {
        const tiny = createEventLog(1);
        tiny.emit({ type: 'battle:start' }, 0, 0);
        tiny.emit({ type: 'turn:start', actor: 'a' }, 1, 0);
        expect(tiny.trim(1, 0)).toBe(2);
        expect(tiny.all()).toEqual([{ id: 3, step: 1, time: 0, type: 'log-trimmed', payload: { dropped: 2 } }]);
    });
});

// ----------------------------------------------------------------------------
// renderEventText — D11 pinned outputs + one formatter per typed event
// ----------------------------------------------------------------------------

// Minimal snapshot for id→name resolution (D3: names default to ids).
const snapshot = {
    schemaVersion: 1,
    definition: { schemaVersion: 1, mode: 'teams', entities: [] },
    state: {
        step: 1,
        virtualTime: 500_000,
        rng: { seed: 7, state: 7, draws: 0 },
        entities: [
            { id: 'rogue', name: 'Whisper', order: 1, living: true, health: 20, maxHealth: 20, stats: { health: 20, strength: 5, speed: 2, defense: 0, precision: 2, evasion: 4 }, statuses: [], equipment: [], cooldowns: {}, baseStats: { health: 20, strength: 5, speed: 2, defense: 0, precision: 2, evasion: 4 }, statModifiers: [], team: 'crown' },
            { id: 'brute', name: 'Fang Brute', order: 2, living: true, health: 40, maxHealth: 40, stats: { health: 40, strength: 10, speed: 1, defense: 0, precision: 0, evasion: 0 }, statuses: [], equipment: [], cooldowns: {}, baseStats: { health: 40, strength: 10, speed: 1, defense: 0, precision: 0, evasion: 0 }, statModifiers: [], team: 'fang' },
        ],
        schedule: [],
        terminal: null,
    },
    events: [],
} as unknown as SimulationSnapshot;

const ev = (fields: Partial<BattleEvent>): BattleEvent => ({ id: 1, step: 1, time: 500_000, type: 'damage', ...fields });

describe('renderEventText (D11)', () => {
    it('pins the damage example verbatim', () => {
        expect(
            renderEventText(
                ev({
                    type: 'damage',
                    actor: 'rogue',
                    target: 'brute',
                    payload: { amount: 4, damageType: 'sharp', source: 'weapon', weaponId: 'cult-dagger', crit: false, mitigations: { blocked: false, armourFactor: 0.8, defenseFactor: 1 } },
                }),
                snapshot,
            ),
        ).toBe('Whisper hits Fang Brute with cult-dagger for 4 sharp damage');
    });

    it('pins the crit and blocked variants', () => {
        const base = { amount: 4, damageType: 'sharp', source: 'weapon', weaponId: 'cult-dagger', mitigations: { blocked: false, armourFactor: 0.8, defenseFactor: 1 } };
        expect(renderEventText(ev({ type: 'damage', actor: 'rogue', target: 'brute', payload: { ...base, crit: true } }), snapshot)).toBe(
            'Whisper hits Fang Brute with cult-dagger for 4 sharp damage (crit!)',
        );
        expect(
            renderEventText(ev({ type: 'damage', actor: 'rogue', target: 'brute', payload: { ...base, crit: false, mitigations: { blocked: true, armourFactor: 0.8, defenseFactor: 1 } } }), snapshot),
        ).toBe('Whisper hits Fang Brute with cult-dagger for 4 sharp damage (blocked)');
    });

    it('pins the dodge example verbatim (actor = dodger)', () => {
        expect(renderEventText(ev({ type: 'dodge', actor: 'brute', target: 'rogue' }), snapshot)).toBe("Fang Brute dodges Whisper's attack");
    });

    it('renders unarmed / damage-over-time / effect damage sources (generic DOT naming)', () => {
        expect(
            renderEventText(ev({ type: 'damage', actor: 'rogue', target: 'brute', payload: { amount: 1, damageType: 'blunt', source: 'unarmed', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } }), snapshot),
        ).toBe('Whisper hits Fang Brute bare-handed for 1 blunt damage');
        // DOT sources render by the STATUS id that emitted them (generic —
        // the canonical 'poisoned' seed and any custom id share the path)
        expect(
            renderEventText(ev({ type: 'damage', actor: 'brute', target: 'brute', payload: { amount: 4, damageType: 'true', source: 'poisoned', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } }), snapshot),
        ).toBe('Fang Brute suffers poisoned for 4 true damage');
        expect(
            renderEventText(ev({ type: 'damage', actor: 'brute', target: 'brute', payload: { amount: 2, damageType: 'true', source: 'burned', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } }), snapshot),
        ).toBe('Fang Brute suffers burned for 2 true damage');
        expect(
            renderEventText(ev({ type: 'damage', target: 'brute', payload: { amount: 3, damageType: 'true', source: 'effect', crit: false, mitigations: { blocked: false, armourFactor: 1, defenseFactor: 1 } } }), snapshot),
        ).toBe('Fang Brute takes 3 true damage');
    });

    it('falls back to [type] message for unknown types (D11)', () => {
        expect(renderEventText(ev({ type: 'custom:thing', message: 'hello' }))).toBe('[custom:thing] hello');
        expect(renderEventText(ev({ type: 'custom:thing' }))).toBe('[custom:thing] ');
    });

    it('renders every remaining typed event exactly', () => {
        const cases: [BattleEvent, string][] = [
            [ev({ type: 'battle:start', step: 0, time: 0, payload: { seed: 7, mode: 'teams' } }), 'Battle begins (teams mode, seed 7)'],
            [ev({ type: 'turn:start', actor: 'rogue' }), "Whisper's turn"],
            [ev({ type: 'action', actor: 'rogue', payload: { kind: 'attack' } }), 'Whisper attacks'],
            [ev({ type: 'action', actor: 'rogue', payload: { kind: 'ability', abilityId: 'venom-strike' } }), 'Whisper uses venom-strike'],
            [ev({ type: 'action', actor: 'rogue', payload: { kind: 'wait' } }), 'Whisper waits'],
            [ev({ type: 'action', actor: 'brute', payload: { kind: 'skip', reason: 'feared' } }), 'Fang Brute skips (feared)'],
            [ev({ type: 'crit', actor: 'rogue', target: 'brute' }), 'Whisper lands a critical hit!'],
            [ev({ type: 'block', actor: 'brute', target: 'rogue' }), 'Fang Brute blocks the attack!'],
            [ev({ type: 'heal', actor: 'rogue', target: 'brute', payload: { amount: 5 } }), 'Whisper heals Fang Brute for 5'],
            [ev({ type: 'heal', actor: 'rogue', target: 'rogue', payload: { amount: 5 } }), 'Whisper heals for 5'],
            [ev({ type: 'status:applied', actor: 'brute', payload: { statusId: 'bleeding', stacks: 2, potency: 2, duration: 3 } }), 'Fang Brute gains bleeding (stacks 2, duration 3, potency 2)'],
            [ev({ type: 'status:resisted', actor: 'brute', payload: { statusId: 'stunned' } }), 'Fang Brute resists stunned'],
            [ev({ type: 'status:tick', actor: 'brute', payload: { statusId: 'poisoned', damage: 4 } }), 'Fang Brute suffers poisoned for 4 damage'],
            [ev({ type: 'status:expired', actor: 'brute', payload: { statusId: 'fearful' } }), "Fang Brute's fearful fades"],
            [ev({ type: 'stat:modified', actor: 'rogue', target: 'brute', payload: { stat: 'speed', amount: -1, remainingTurns: 2 } }), "Fang Brute's speed changes by -1"],
            [ev({ type: 'stat:expired', actor: 'brute', payload: { stat: 'speed', amount: -1 } }), "Fang Brute's speed modifier fades"],
            [ev({ type: 'gear:damaged', actor: 'rogue', payload: { gearId: 'cult-dagger', slot: 'weapon-1', durability: 9 } }), "Whisper's cult-dagger wears (9 durability left)"],
            [ev({ type: 'gear:broken', actor: 'brute', payload: { gearId: 'cult-mask', slot: 'head' } }), "Fang Brute's cult-mask breaks!"],
            [ev({ type: 'death', actor: 'brute', payload: { killerId: 'rogue' } }), 'Fang Brute falls, slain by Whisper'],
            [ev({ type: 'death', actor: 'brute', payload: {} }), 'Fang Brute falls'],
            [ev({ type: 'log-trimmed', payload: { dropped: 16 } }), 'Log trimmed (16 events dropped)'],
            [ev({ type: 'step:end', payload: { step: 3, time: 1_500_000 } }), 'End of step 3'],
            [ev({ type: 'outcome', payload: { outcome: 'victory', winner: 'crown' } }), 'Victory: crown'],
            [ev({ type: 'outcome', payload: { outcome: 'draw', reason: 'mutual-destruction' } }), 'Draw (mutual-destruction)'],
            [ev({ type: 'outcome', payload: { outcome: 'undecided', reason: 'step-limit' } }), 'Undecided (step-limit)'],
            [ev({ type: 'fault', payload: { pluginId: 'boom', hook: 'step:end', error: 'kaboom' } }), 'Fault in boom at step:end: kaboom'],
            [ev({ type: 'fault', payload: { error: 'runaway' } }), 'Fault: runaway'],
            [ev({ type: 'message', message: 'gravity flips!' }), 'gravity flips!'],
        ];
        for (const [event, expected] of cases) expect(renderEventText(event, snapshot)).toBe(expected);
    });

    it('falls back to raw ids without a snapshot and for unknown ids', () => {
        expect(renderEventText(ev({ type: 'turn:start', actor: 'rogue' }))).toBe("rogue's turn");
        expect(renderEventText(ev({ type: 'turn:start', actor: 'unknown-id' }), snapshot)).toBe("unknown-id's turn");
    });

    it('renders the T3 edit event with its domain list (combatant:edited)', () => {
        expect(
            renderEventText(ev({ type: 'combatant:edited', actor: 'brute', payload: { domains: ['health', 'statuses'] } }), snapshot),
        ).toBe('Fang Brute edited (health, statuses)');
        expect(
            renderEventText(ev({ type: 'combatant:edited', actor: 'brute', payload: {} }), snapshot),
        ).toBe('Fang Brute edited');
    });

    it('exposes the formatter map for client extension (D11)', () => {
        expect(typeof eventFormatters['damage']).toBe('function');
        expect(eventFormatters['not-a-real-type']).toBeUndefined();
    });
});
