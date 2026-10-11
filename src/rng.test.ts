// ============================================================================
// @userfiction/combat — src/rng.test.ts — T3 Mulberry32 stream tests (D4g)
// ============================================================================
// Deterministic exact-value tests (task §10 "known-seed draw sequences
// (hardcoded)"). Every expected float below was captured from the exact
// canonical Mulberry32 implementation in rng.ts (probe run 2026-10-11,
// Temp/c3/probe.mjs + probe2.mjs + probe3.mjs) and hardcoded — the tests
// pin the algorithm itself, so any deviation in the step constant, mixing
// order, or uint32 normalization breaks them loudly.
//
// Coverage: seed defaults + normalization, next() streams for seeds
// 0/1/7/2^32−1, [0,1) range property, int()/pick() exact sequences and
// one-draw-per-call accounting, exportState/restoreState roundtrip with
// continuation equality (D10 replay position), and the documented
// pick([]) draw-consumption edge (literal D4g "pick uses int(length)").
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createRng } from './rng';

// Captured reference streams (verbatim from the probe capture).
const SEED_1_FIRST_10 = [
    0.6270739405881613,
    0.002735721180215478,
    0.5274470399599522,
    0.9810509674716741,
    0.9683778982143849,
    0.281103502959013,
    0.6128388606011868,
    0.7207431411370635,
    0.425796952098608,
    0.9948229456786066,
];
const SEED_7_FIRST_5 = [
    0.011704753153026104,
    0.06195825757458806,
    0.97690763277933,
    0.6990287057124078,
    0.5214452685322613,
];
const SEED_0_FIRST = 0.26642920868471265;
const SEED_MAX_FIRST = 0.8964226141106337; // seed 2^32 − 1 = 4294967295

describe('createRng — Mulberry32 next() streams (D4g)', () => {
    it('produces the captured exact stream for the default seed 1 (D13 DEFAULT_SEED)', () => {
        const rng = createRng();
        const values: number[] = [];
        for (let i = 0; i < 10; i++) values.push(rng.next());
        expect(values).toEqual(SEED_1_FIRST_10);
    });

    it('explicit seed 1 matches the default-seed stream exactly', () => {
        const explicit = createRng(1);
        const fallback = createRng();
        for (let i = 0; i < 10; i++) expect(explicit.next()).toBe(fallback.next());
    });

    it('produces the captured exact stream for seed 7 (the §7 fixture seed)', () => {
        const rng = createRng(7);
        const values: number[] = [];
        for (let i = 0; i < 5; i++) values.push(rng.next());
        expect(values).toEqual(SEED_7_FIRST_5);
    });

    it('seed 0 and seed 2^32−1 produce their captured first draws', () => {
        expect(createRng(0).next()).toBe(SEED_0_FIRST);
        expect(createRng(4_294_967_295).next()).toBe(SEED_MAX_FIRST);
    });

    it('normalizes out-of-range seeds via >>> 0 (range validation is T2\'s job)', () => {
        // 2^32 wraps to uint32 0 ⇒ identical to seed 0's stream
        expect(createRng(2 ** 32).next()).toBe(SEED_0_FIRST);
    });

    it('every draw lies in [0, 1) across a 1000-draw run (range property)', () => {
        const rng = createRng(12345);
        for (let i = 0; i < 1000; i++) {
            const value = rng.next();
            expect(value >= 0).toBe(true);
            expect(value < 1).toBe(true);
        }
    });
});

describe('createRng — int() and pick() (D4g)', () => {
    it('int(6) produces the captured exact sequence for seed 1', () => {
        const rng = createRng(1);
        const values: number[] = [];
        for (let i = 0; i < 10; i++) values.push(rng.int(6));
        expect(values).toEqual([3, 0, 3, 5, 5, 1, 3, 4, 2, 5]);
    });

    it('int(1) is always 0 and int(0) is 0, each consuming exactly one draw', () => {
        const rng = createRng(1);
        for (let i = 0; i < 5; i++) expect(rng.int(1)).toBe(0);
        expect(rng.int(0)).toBe(0);
        expect(rng.exportState().draws).toBe(6);
    });

    it('pick() produces the captured exact sequence for seed 1 over [a..f]', () => {
        const rng = createRng(1);
        const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
        const picked: (string | undefined)[] = [];
        for (let i = 0; i < 10; i++) picked.push(rng.pick(letters));
        expect(picked).toEqual(['d', 'a', 'd', 'f', 'f', 'b', 'd', 'e', 'c', 'f']);
        // pick uses int(length) ⇒ exactly one draw per call (D4g verbatim)
        expect(rng.exportState().draws).toBe(10);
    });

    it('pick([]) returns undefined and still consumes one draw (documented edge)', () => {
        const rng = createRng(1);
        expect(rng.pick([])).toBeUndefined();
        expect(rng.exportState().draws).toBe(1);
    });

    it('int()/pick() advance the same single stream as next() (shared-source rule)', () => {
        // interleaving accessors must equal the uninterrupted next() stream:
        // draws 1..10 of seed 1 regardless of which accessor produced them
        const mixed = createRng(1);
        mixed.next(); // draw 1
        mixed.int(6); // draw 2
        mixed.pick(['x', 'y']); // draw 3
        const continuation: number[] = [];
        for (let i = 0; i < 7; i++) continuation.push(mixed.next());
        expect(continuation).toEqual(SEED_1_FIRST_10.slice(3));
    });
});

describe('createRng — exportState/restoreState (D4g/D10 snapshot position)', () => {
    it('fresh stream exports { seed, state: seed, draws: 0 }', () => {
        expect(createRng(1).exportState()).toEqual({ seed: 1, state: 1, draws: 0 });
    });

    it('state after 3 draws is the captured uint32 position', () => {
        const rng = createRng(1);
        rng.next();
        rng.next();
        rng.next();
        expect(rng.exportState()).toEqual({ seed: 1, state: 1_199_730_144, draws: 3 });
    });

    it('restoreState replays the exact continuation from a mid-stream position', () => {
        const original = createRng(1);
        original.next();
        original.next();
        original.next();
        const position = original.exportState();
        const expected: number[] = [];
        for (let i = 0; i < 7; i++) expected.push(original.next());
        // the captured 4th draw anchors the continuation (probe2 value)
        expect(expected[0]).toBe(0.9810509674716741);

        // restore into a DIFFERENT seed — position must be replaced wholesale
        const resumed = createRng(9);
        resumed.restoreState(position);
        const actual: number[] = [];
        for (let i = 0; i < 7; i++) actual.push(resumed.next());
        expect(actual).toEqual(expected);
        // and the restored stream's own export matches the uninterrupted run
        expect(resumed.exportState()).toEqual({ seed: 1, state: 1_135_788_947, draws: 10 });
    });

    it('exportState returns a fresh copy — mutating it never moves the stream', () => {
        const rng = createRng(1);
        rng.next();
        const copy = rng.exportState();
        copy.state = 999;
        copy.draws = 999;
        expect(rng.exportState()).toEqual({ seed: 1, state: 1_831_565_814, draws: 1 });
        expect(rng.next()).toBe(SEED_1_FIRST_10[1]);
    });

    it('JSON roundtrip of the position restores equivalently (D10)', () => {
        const rng = createRng(7);
        rng.next();
        rng.int(10);
        const serialized = JSON.parse(JSON.stringify(rng.exportState()));
        const resumed = createRng(0);
        resumed.restoreState(serialized);
        expect(resumed.next()).toBe(SEED_7_FIRST_5[2]);
        expect(resumed.exportState()).toEqual({ seed: 7, state: 1_199_730_150, draws: 3 });
    });
});
