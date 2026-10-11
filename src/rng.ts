// ============================================================================
// @userfiction/combat — src/rng.ts — T3 Mulberry32 shared RNG stream (D4g)
// ============================================================================
// THE single deterministic randomness source for a battle (D4g): every draw
// (dodge, crit, block, targeting, action selection, fear rolls, declarative
// `chance` conditions) consumes from this one stream in strict pipeline
// order. Plugins receive it only as `ctx.rng` (RngStream in types.ts) and
// must never create their own randomness.
//
// Exact algorithm (D4g "Mulberry32 32-bit PRNG"): one uint32 of generator
// state, advanced per draw by the canonical bryc formulation:
//
//     a  = (a + 0x6D2B79F5) >>> 0                       // uint32 step
//     t  = Math.imul(a ^ (a >>> 15), 1 | a)
//     t  = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
//     out = ((t ^ (t >>> 14)) >>> 0) / 2^32             // float in [0, 1)
//
// All intermediate values are exact in IEEE-754 doubles (every bitwise op
// coerces through ToInt32/ToUint32, Math.imul returns int32, the one `+`
// stays under 2^33), so the stream is bit-identical across runs and
// machines (D1 determinism contract). `>>> 0` keeps the stored state a
// plain uint32 — the same bit pattern the canonical `| 0` form carries.
//
// Snapshot position (D4g/D10): exportState() yields { seed, state, draws };
// `state` is the uint32 AFTER the last consumed draw, so restoring it makes
// the NEXT draw continue exactly where the run stopped. `seed` is carried
// for provenance/re-seeding and `draws` counts consumed next() advances
// (int() and pick() each consume exactly one draw).
//
// Zero dependencies (D14); no timers/I/O (D1). Seed range validation
// (integer 0..2^32−1, D3/D13) is validation.ts's job (T2); createRng only
// normalizes via `>>> 0` so any numeric input still yields a deterministic
// uint32 state.
// ============================================================================

import { DEFAULT_SEED } from './types';
import type { RngState, RngStream } from './types';

// 2^32 — the divisor turning a uint32 draw into a float in [0, 1).
const UINT32_RANGE = 4_294_967_296;

// Mulberry32 step constant (canonical 0x6D2B79F5 = golden-ratio-derived).
const MULBERRY32_STEP = 0x6D2B79F5;

// The full RNG surface the engine wires into ctx.rng and state.ts snapshots:
// the public RngStream contract (types.ts D4g) plus the persistence pair
// used by snapshot/restore (D10). exportState/restoreState are additive —
// anything holding just RngStream cannot perturb the position by hand.
export interface RngController extends RngStream {
    // Plain-JSON position copy { seed, state, draws } (D10 state.rng).
    exportState(): RngState;
    // Replace the position wholesale (D10 replay): the next draw continues
    // exactly where exportState was taken. Also records `seed` so a later
    // export round-trips identically even after a cross-seed restore.
    restoreState(snapshot: RngState): void;
}

// One draw's uint32 output + advanced state, kept as a module-level helper
// so next() stays a single expression and the algorithm appears exactly once.
// `state` in / out is always a uint32 (>>> 0 normalized).
const draw = (state: number): { state: number; out: number } => {
    // advance the single uint32 of state (canonical mulberry32 step)
    const a = (state + MULBERRY32_STEP) >>> 0;
    // avalanche mixing — verbatim bryc mulberry32; every operator coerces to
    // 32-bit ints, so results are exact and platform-independent
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { state: a, out: (t ^ (t >>> 14)) >>> 0 };
};

// Create the shared deterministic stream (D4g). `seed` defaults to
// DEFAULT_SEED (1, D13); normalized to uint32 via `>>> 0` (range errors are
// reported by validation.ts, not here — see header).
export const createRng = (seed: number = DEFAULT_SEED): RngController => {
    // generator state: exactly one uint32 + the provenance seed + draw count
    let state = seed >>> 0;
    let originSeed = seed >>> 0;
    let draws = 0;

    // next(): advance state, emit float in [0, 1). THE primitive — every
    // other accessor routes through it so `draws` counts all randomness.
    const next = (): number => {
        const stepped = draw(state);
        state = stepped.state;
        draws += 1;
        return stepped.out / UINT32_RANGE;
    };

    // int(maxExclusive): integer in [0, maxExclusive) (D4g). One draw per
    // call, always — including maxExclusive <= 0, where the result is
    // clamped to 0 (engine never passes non-positive lengths; pick([])
    // consumes one draw by the literal "`pick` uses `int(length)`" rule).
    const int = (maxExclusive: number): number => {
        const value = Math.floor(next() * maxExclusive);
        // clamp guards maxExclusive <= 0 (floor of a negative product could
        // otherwise go negative); positive inputs are already in range
        return value < 0 ? 0 : value;
    };

    // pick(array): uniform element choice via int(length) (D4g verbatim).
    // Empty array ⇒ undefined AND one consumed draw (documented above).
    const pick = <T>(array: readonly T[]): T | undefined => array[int(array.length)];

    // exportState(): fresh plain object — mutating the copy never moves the
    // live stream (D2 "all returned objects are copies" spirit).
    const exportState = (): RngState => ({ seed: originSeed, state, draws });

    // restoreState(): wholesale position replace (D10 replay). No validation
    // here: the caller restores a state this module exported (or an exact
    // JSON roundtrip of one), so { seed, state, draws } are trusted ints.
    const restoreState = (snapshot: RngState): void => {
        originSeed = snapshot.seed >>> 0;
        state = snapshot.state >>> 0;
        draws = snapshot.draws;
    };

    return { next, int, pick, exportState, restoreState };
};
