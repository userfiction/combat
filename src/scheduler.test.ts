// ============================================================================
// @userfiction/combat — src/scheduler.test.ts — T3 scheduler tests (D4)
// ============================================================================
// Exact integer-µs assertions (task §10 "µs table 250k/500k/750k/1M; tie
// rule; hook-routed reschedule math (incl. replaced interval honored)").
// All expected values derive from the D4b formula
//   interval = max(1, round-half-up(actionCost × 1e6 / effectiveSpeed))
// and the D4e remaining-work rule — computed by hand/probe (Temp/c3/probe.mjs),
// never read back from implementation output.
//
// Coverage: defaultInterval (worked example, half-up rounding, 1 µs floor,
// 0.001 clamp), effectiveSpeed clamp, defaultOrder tie semantics (speed →
// definition order), initial entries (first readiness never 0), upsert/
// remove/minReadyAt/buildCandidates, the R6 4× acceptance simulation (fast
// attacks exactly four times before slow's first attack, exact times),
// hook routing for advance/reschedule including a REPLACED interval honored
// under its own rounding curve, and the mid-flight + death guards.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
    advanceEntry,
    buildCandidates,
    buildInitialEntries,
    defaultInterval,
    defaultOrder,
    effectiveSpeed,
    minReadyAt,
    pickNext,
    removeEntry,
    rescheduleEntry,
    upsertEntry,
} from './scheduler';
import type { CandidateLookup, IntervalFn } from './scheduler';
import type { ScheduleEntry, SchedulerIntervalArgs } from './types';

// The D4c acceptance pair: fast speed 4 (definition order 0), slow speed 1
// (order 1), both basic attacks (cost 1). Lookup supplies candidate info
// exactly as the engine would from entity state.
const FAST_SLOW_LOOKUP: CandidateLookup = (entityId) =>
    entityId === 'fast' ? { effectiveSpeed: 4, order: 0 } : { effectiveSpeed: 1, order: 1 };

describe('defaultInterval — D4b formula', () => {
    it('worked example: cost 1 at speed 4 ⇒ 250000 µs, speed 1 ⇒ 1000000 µs', () => {
        expect(defaultInterval({ entityId: 'fast', actionCost: 1, effectiveSpeed: 4 })).toBe(250_000);
        expect(defaultInterval({ entityId: 'slow', actionCost: 1, effectiveSpeed: 1 })).toBe(1_000_000);
        expect(defaultInterval({ entityId: 'mid', actionCost: 1, effectiveSpeed: 2 })).toBe(500_000);
        expect(defaultInterval({ entityId: 'slow2', actionCost: 1, effectiveSpeed: 0.5 })).toBe(2_000_000);
    });

    it('rounds half-UP to integer microseconds (7812.5 ⇒ 7813)', () => {
        // 1 × 1e6 / 128 = 7812.5 exactly — the half-up rule is THE rule (D4b)
        expect(defaultInterval({ entityId: 'a', actionCost: 1, effectiveSpeed: 128 })).toBe(7_813);
        // 1 × 1e6 / 3 = 333333.33… ⇒ 333333 (ordinary nearest, no banker's rounding)
        expect(defaultInterval({ entityId: 'a', actionCost: 1, effectiveSpeed: 3 })).toBe(333_333);
    });

    it('floors at 1 µs (max(1, …))', () => {
        expect(defaultInterval({ entityId: 'a', actionCost: 0.25, effectiveSpeed: 100 })).toBe(2_500);
        expect(defaultInterval({ entityId: 'a', actionCost: 0, effectiveSpeed: 1 })).toBe(1);
        expect(defaultInterval({ entityId: 'a', actionCost: 0.25, effectiveSpeed: 1_000_000_000 })).toBe(1);
    });

    it('clamps effectiveSpeed at the 0.001 floor (D4b runtime clamp)', () => {
        expect(defaultInterval({ entityId: 'a', actionCost: 1, effectiveSpeed: 0.001 })).toBe(1_000_000_000);
        // below-floor and zero inputs clamp to 0.001 ⇒ finite 1e9 µs, never Infinity
        expect(defaultInterval({ entityId: 'a', actionCost: 1, effectiveSpeed: 0.0005 })).toBe(1_000_000_000);
        expect(defaultInterval({ entityId: 'a', actionCost: 1, effectiveSpeed: 0 })).toBe(1_000_000_000);
    });
});

describe('effectiveSpeed — D4b clamp helper', () => {
    it('passes through unmodified and boosted speeds', () => {
        expect(effectiveSpeed(1, 0)).toBe(1);
        expect(effectiveSpeed(1, 2)).toBe(3);
        expect(effectiveSpeed(1, -0.5)).toBe(0.5);
    });

    it('clamps hostile modifier sums to the 0.001 floor', () => {
        expect(effectiveSpeed(1, -2)).toBe(0.001);
        expect(effectiveSpeed(0.5, -100)).toBe(0.001);
    });
});

describe('defaultOrder — D4d tie semantics', () => {
    it('tied minimal readyAt ⇒ higher effective speed first', () => {
        expect(
            defaultOrder({
                candidates: [
                    { entityId: 'fast', readyAt: 1_000_000, effectiveSpeed: 4, order: 0 },
                    { entityId: 'slow', readyAt: 1_000_000, effectiveSpeed: 1, order: 1 },
                ],
            }),
        ).toBe('fast');
    });

    it('effective speed outranks definition order (later-listed faster entity wins)', () => {
        expect(
            defaultOrder({
                candidates: [
                    { entityId: 'slow', readyAt: 1_000_000, effectiveSpeed: 1, order: 0 },
                    { entityId: 'fast', readyAt: 1_000_000, effectiveSpeed: 4, order: 1 },
                ],
            }),
        ).toBe('fast');
    });

    it('equal effective speed ⇒ lower definition order wins (deterministic)', () => {
        expect(
            defaultOrder({
                candidates: [
                    { entityId: 'third', readyAt: 500_000, effectiveSpeed: 2, order: 3 },
                    { entityId: 'first', readyAt: 500_000, effectiveSpeed: 2, order: 1 },
                ],
            }),
        ).toBe('first');
    });

    it('defensively selects the minimal readyAt even from a mixed candidate set', () => {
        expect(
            defaultOrder({
                candidates: [
                    { entityId: 'later', readyAt: 500_000, effectiveSpeed: 1, order: 0 },
                    { entityId: 'sooner', readyAt: 250_000, effectiveSpeed: 4, order: 1 },
                ],
            }),
        ).toBe('sooner');
    });
});

describe('buildInitialEntries — D4a first readiness from time 0', () => {
    it('speed 4 vs speed 1 ⇒ entries exactly [250000, 1000000] µs', () => {
        expect(
            buildInitialEntries([
                { entityId: 'fast', actionCost: 1, effectiveSpeed: 4 },
                { entityId: 'slow', actionCost: 1, effectiveSpeed: 1 },
            ]),
        ).toEqual([
            { entityId: 'fast', readyAt: 250_000 },
            { entityId: 'slow', readyAt: 1_000_000 },
        ]);
    });

    it('first readiness is never 0, even at max input speed (D4a)', () => {
        const entries = buildInitialEntries([{ entityId: 'blitz', actionCost: 1, effectiveSpeed: 100 }]);
        expect(entries).toEqual([{ entityId: 'blitz', readyAt: 10_000 }]);
        expect(entries[0].readyAt).not.toBe(0);
    });

    it('routes through the ACTIVE interval hook (replaced curve honored at battle start)', () => {
        const entries = buildInitialEntries(
            [
                { entityId: 'a', actionCost: 1, effectiveSpeed: 4 },
                { entityId: 'b', actionCost: 2, effectiveSpeed: 1 },
            ],
            () => 42,
        );
        expect(entries).toEqual([
            { entityId: 'a', readyAt: 42 },
            { entityId: 'b', readyAt: 42 },
        ]);
    });
});

describe('entry set operations — upsert / remove / minReadyAt / buildCandidates', () => {
    it('upsertEntry keeps ONE pending entry per entity (D4a), replacing in place', () => {
        const entries: ScheduleEntry[] = [];
        upsertEntry(entries, 'a', 100);
        upsertEntry(entries, 'b', 200);
        upsertEntry(entries, 'a', 50);
        expect(entries).toEqual([
            { entityId: 'a', readyAt: 50 },
            { entityId: 'b', readyAt: 200 },
        ]);
    });

    it('removeEntry drops death entries immediately and is idempotent (D4e)', () => {
        const entries: ScheduleEntry[] = [
            { entityId: 'a', readyAt: 100 },
            { entityId: 'b', readyAt: 200 },
        ];
        expect(removeEntry(entries, 'a')).toBe(true);
        expect(entries).toEqual([{ entityId: 'b', readyAt: 200 }]);
        expect(removeEntry(entries, 'a')).toBe(false);
    });

    it('minReadyAt returns the smallest readyAt, null when empty', () => {
        expect(minReadyAt([])).toBeNull();
        expect(
            minReadyAt([
                { entityId: 'a', readyAt: 300 },
                { entityId: 'b', readyAt: 100 },
                { entityId: 'c', readyAt: 200 },
            ]),
        ).toBe(100);
    });

    it('buildCandidates returns ONLY the minimal-readyAt set, enriched via lookup', () => {
        const candidates = buildCandidates(
            [
                { entityId: 'x', readyAt: 100 },
                { entityId: 'y', readyAt: 100 },
                { entityId: 'z', readyAt: 50 },
            ],
            (id) => ({ effectiveSpeed: id === 'z' ? 4 : 1, order: id.charCodeAt(0) }),
        );
        expect(candidates).toEqual([
            { entityId: 'z', readyAt: 50, effectiveSpeed: 4, order: 122 },
        ]);
    });

    it('buildCandidates on empty entries ⇒ empty set', () => {
        expect(buildCandidates([], () => ({ effectiveSpeed: 1, order: 0 }))).toEqual([]);
    });
});

describe('R6 acceptance — speed 4 attacks four times before speed 1 attacks once (D4c/D4d)', () => {
    // Simulate the engine loop exactly as pipeline.ts (T5) will drive it:
    // pick (order hook) → record (actor, time) → advance (interval hook).
    const runFiveSteps = (interval: IntervalFn = defaultInterval) => {
        const entries = buildInitialEntries([
            { entityId: 'fast', actionCost: 1, effectiveSpeed: 4 },
            { entityId: 'slow', actionCost: 1, effectiveSpeed: 1 },
        ]);
        const log: { actor: string; time: number }[] = [];
        for (let step = 0; step < 5; step++) {
            const picked = pickNext(entries, FAST_SLOW_LOOKUP);
            if (!picked) throw new Error('scheduler emptied mid-battle');
            log.push({ actor: picked.entry.entityId, time: picked.time });
            advanceEntry(entries, picked.entry.entityId, picked.time, 1, FAST_SLOW_LOOKUP(picked.entry.entityId).effectiveSpeed, interval);
        }
        return { entries, log };
    };

    it('steps 1–4 are fast at 250000/500000/750000/1000000 µs, step 5 is slow at 1000000 µs', () => {
        const { log } = runFiveSteps();
        expect(log).toEqual([
            { actor: 'fast', time: 250_000 },
            { actor: 'fast', time: 500_000 },
            { actor: 'fast', time: 750_000 },
            { actor: 'fast', time: 1_000_000 },
            { actor: 'slow', time: 1_000_000 },
        ]);
    });

    it('the t=1.0 tie set contains BOTH entries and resolves to fast by rule, not luck', () => {
        const entries = buildInitialEntries([
            { entityId: 'fast', actionCost: 1, effectiveSpeed: 4 },
            { entityId: 'slow', actionCost: 1, effectiveSpeed: 1 },
        ]);
        // burn steps 1–3
        for (let step = 0; step < 3; step++) {
            const picked = pickNext(entries, FAST_SLOW_LOOKUP)!;
            advanceEntry(entries, picked.entry.entityId, picked.time, 1, FAST_SLOW_LOOKUP(picked.entry.entityId).effectiveSpeed);
        }
        // step 4: both ready at 1000000 — the candidate set proves the tie
        expect(buildCandidates(entries, FAST_SLOW_LOOKUP)).toEqual([
            { entityId: 'fast', readyAt: 1_000_000, effectiveSpeed: 4, order: 0 },
            { entityId: 'slow', readyAt: 1_000_000, effectiveSpeed: 1, order: 1 },
        ]);
        expect(pickNext(entries, FAST_SLOW_LOOKUP)!.entry.entityId).toBe('fast');
    });

    it('after five steps the pending schedule is fast@1250000, slow@2000000', () => {
        const { entries } = runFiveSteps(defaultInterval);
        expect(entries).toEqual([
            { entityId: 'fast', readyAt: 1_250_000 },
            { entityId: 'slow', readyAt: 2_000_000 },
        ]);
    });

    it('a replaced order hook decides the tie (plugin contract, D4d/D6)', () => {
        const entries = buildInitialEntries([
            { entityId: 'fast', actionCost: 1, effectiveSpeed: 4 },
            { entityId: 'slow', actionCost: 1, effectiveSpeed: 1 },
        ]);
        // burn steps 1–3 with the default order
        for (let step = 0; step < 3; step++) {
            const picked = pickNext(entries, FAST_SLOW_LOOKUP)!;
            advanceEntry(entries, picked.entry.entityId, picked.time, 1, FAST_SLOW_LOOKUP(picked.entry.entityId).effectiveSpeed);
        }
        // step 4 tie: a custom hook (e.g. round-robin fairness) picks slow instead
        const picked = pickNext(entries, FAST_SLOW_LOOKUP, () => 'slow')!;
        expect(picked).toEqual({ entry: { entityId: 'slow', readyAt: 1_000_000 }, time: 1_000_000 });
    });

    it('a replaced interval hook drives initial readiness AND every advance (hook-routed)', () => {
        // replaced curve: cost × 10 µs — fast initial 10, advances +10 each
        const entries = buildInitialEntries(
            [
                { entityId: 'fast', actionCost: 1, effectiveSpeed: 4 },
                { entityId: 'slow', actionCost: 1, effectiveSpeed: 1 },
            ],
            (args) => Math.round(args.actionCost * 10),
        );
        expect(entries).toEqual([
            { entityId: 'fast', readyAt: 10 },
            { entityId: 'slow', readyAt: 10 },
        ]);
        const picked = pickNext(entries, FAST_SLOW_LOOKUP)!;
        advanceEntry(entries, picked.entry.entityId, picked.time, 1, 4, (args) => Math.round(args.actionCost * 10));
        expect(entries).toEqual([
            { entityId: 'fast', readyAt: 20 },
            { entityId: 'slow', readyAt: 10 },
        ]);
    });

    it('pickNext returns null when nothing is pending (all dead)', () => {
        expect(pickNext([], FAST_SLOW_LOOKUP)).toBeNull();
    });
});

describe('rescheduleEntry — D4e proportional remaining-work rule', () => {
    // Pending entry 300000 µs in the future at oldEff 2 (the D4e worked example).
    const pending = (): ScheduleEntry[] => [{ entityId: 'walker', readyAt: 1_000_000 }];
    const NOW = 700_000;

    it('faster ⇒ sooner: 300000 µs remaining at oldEff 2 → newEff 4 ⇒ readyAt 850000', () => {
        const entries = pending();
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 4)).toBe(true);
        expect(entries).toEqual([{ entityId: 'walker', readyAt: 850_000 }]);
    });

    it('slower ⇒ later: 300000 µs remaining at oldEff 4 → newEff 2 ⇒ readyAt 1300000', () => {
        const entries = [{ entityId: 'walker', readyAt: 1_000_000 }];
        expect(rescheduleEntry(entries, 'walker', NOW, 4, 2)).toBe(true);
        expect(entries).toEqual([{ entityId: 'walker', readyAt: 1_300_000 }]);
    });

    it('passes remaining cost-units to the ACTIVE interval hook and honors its own curve', () => {
        const seen: SchedulerIntervalArgs[] = [];
        const entries = pending();
        // replaced curve: default rounding + 7 µs — proves the hook (not a
        // hidden base-speed rule) computes the delta, under its own rounding
        const hook = (args: SchedulerIntervalArgs) => {
            seen.push(args);
            return Math.round((args.actionCost * 1_000_000) / args.effectiveSpeed) + 7;
        };
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 4, hook)).toBe(true);
        // remaining = (1000000 − 700000) × 2 / 1e6 = 0.6 cost-units, exact double
        expect(seen).toEqual([{ entityId: 'walker', actionCost: 0.6, effectiveSpeed: 4 }]);
        expect(entries).toEqual([{ entityId: 'walker', readyAt: 850_007 }]);
    });

    it('re-applies the integer-µs + 1 µs floor to whatever the hook returns', () => {
        const entries = pending();
        // fractional curve: 150000.4 ⇒ round-half-up ⇒ 150000
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 4, () => 150_000.4)).toBe(true);
        expect(entries).toEqual([{ entityId: 'walker', readyAt: 850_000 }]);
        const degenerate = pending();
        // degenerate curve: 0 ⇒ max(1, …) floor keeps time strictly advancing
        expect(rescheduleEntry(degenerate, 'walker', NOW, 2, 4, () => 0)).toBe(true);
        expect(degenerate).toEqual([{ entityId: 'walker', readyAt: 700_001 }]);
    });

    it('newEff below the floor clamps through the default hook (0.0005 ⇒ 0.001)', () => {
        const entries = pending();
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 0.0005)).toBe(true);
        // remaining 0.6 at clamped 0.001 ⇒ 600000000 µs delta
        expect(entries).toEqual([{ entityId: 'walker', readyAt: 600_700_000 }]);
    });

    it('an entry already picked for the current step (readyAt === now) is never rescheduled', () => {
        const entries: ScheduleEntry[] = [{ entityId: 'walker', readyAt: NOW }];
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 8)).toBe(false);
        expect(entries).toEqual([{ entityId: 'walker', readyAt: NOW }]);
    });

    it('a missing entry (dead — dropped per D4e) is a no-op returning false', () => {
        expect(rescheduleEntry([], 'walker', NOW, 2, 4)).toBe(false);
    });

    it('death + reschedule interplay: removed entities are never rescheduled', () => {
        const entries = pending();
        removeEntry(entries, 'walker');
        expect(rescheduleEntry(entries, 'walker', NOW, 2, 4)).toBe(false);
        expect(entries).toEqual([]);
    });
});
