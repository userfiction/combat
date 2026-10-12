// ============================================================================
// @userfiction/combat — src/runtime/scheduler.ts — T3 virtual-time scheduler (D4)
// ============================================================================
// Pure integer-microsecond next-ready scheduler (D4a): virtual time is an
// integer count of microseconds (SCHEDULER_SCALE_US = 1e6 µs = 1s); each
// living entity holds exactly ONE pending entry { entityId, readyAt }. No
// real timers, no async, no I/O, no RNG of its own (task §8 ownership note)
// — time only moves through the integer-µs computations below (D1/D4e).
//
// Hook routing (D4b/D4d/D4e/D6): the two single-mode scheduler hooks are
// represented here as injectable callbacks —
//   IntervalFn ≙ `scheduler:interval` — { entityId, actionCost,
//     effectiveSpeed } → µs interval
//   OrderFn    ≙ `scheduler:order`    — minimal-readyAt candidates → id
// defaultInterval / defaultOrder implement the builtin defaults (D4b / D4d)
// and are the floor a plugin override replaces (D6 last-wins). EVERY entry
// computation — initial readiness, post-turn advance, and the mid-cascade
// speed-change reschedule — routes through the ACTIVE interval callback the
// battle currently runs, "never a secretly hardcoded base-speed rule"
// (D4e). The engine (T5 pipeline) passes its resolved hook; the parameter
// defaults to the builtin so these helpers are usable standalone.
//
// Exact semantics pinned by scheduler.test.ts (task §10):
//   - interval = max(1, round-half-up(actionCost × 1e6 / effectiveSpeed)),
//     effectiveSpeed clamped ≥ 0.001 (D4b; Math.round is half-up for the
//     positive operands produced here).
//   - first readiness = interval(cost, eff) from time 0 — NEVER 0 (D4a;
//     the max(1, …) floor guarantees it even for degenerate inputs).
//   - 4× acceptance: speed 4 vs speed 1 ⇒ fast ready at 250000/500000/
//     750000/1000000 µs, slow at 1000000; the t=1.0 tie resolves to the
//     higher effective speed (D4c/D4d) ⇒ four fast attacks before slow's
//     first.
//   - reschedule (D4e): remaining cost-units `remaining = (readyAt − now) ×
//     oldEff / 1e6` (plain JS number), then `readyAt = now + max(1,
//     round-half-up(interval({ actionCost: remaining, effectiveSpeed:
//     newEff })))` — under the default formula this reduces algebraically
//     to round((readyAt − now) × oldEff / newEff) (300000 µs remaining at
//     oldEff 2 → newEff 4 ⇒ 150000), and a replaced hook is honored with
//     proportional-remaining-work semantics under ITS OWN rounding curve.
//   - an entry already picked for the current step (readyAt ≤ now) is never
//     rescheduled mid-flight (D4e); deaths drop entries immediately (D4e).
//
// Entry arrays are plain ScheduleEntry[] (types.ts D10) mutated in place —
// they ARE the snapshot-serializable schedule; state.ts (T4) deep-copies
// them for transactions. One entry per entity is enforced by upsertEntry.
// ============================================================================

import {
    EFFECTIVE_SPEED_FLOOR,
    MIN_INTERVAL_US,
    SCHEDULER_SCALE_US,
} from '../contract/types';
import type { ScheduleCandidate, ScheduleEntry, SchedulerIntervalArgs, SchedulerOrderArgs } from '../contract/types';

// The `scheduler:interval` hook shape (D6): args/result exactly per the D6
// contract row. Callers pass the ACTIVE handler (plugin override or default).
export type IntervalFn = (args: SchedulerIntervalArgs) => number;

// The `scheduler:order` hook shape (D6): candidates → chosen entityId.
export type OrderFn = (args: SchedulerOrderArgs) => string;

// Per-entity info needed to enrich raw entries into D4d candidates
// (effectiveSpeed + definition order live in entity state, not in schedule
// entries — the scheduler stays pure scheduling structure).
export type CandidateLookup = (entityId: string) => { effectiveSpeed: number; order: number };

// One entity's initial-schedule input (D4a): the engine supplies the basic
// action cost (DEFAULT_ACTION_COST = 1 at battle start, D13) and the entity's
// base effective speed.
export interface InitialScheduleEntity {
    entityId: string;
    actionCost: number;
    effectiveSpeed: number;
}

// D4b builtin effective-speed clamp: max(0.001, speed + speedModifiers).
// Input validation already forbids speed ≤ 0 (MIN_SPEED 0.1, D3); the floor
// exists for hostile runtime modify-stat effects and keeps interval math
// finite and deterministic (D4b/D13).
export const effectiveSpeed = (baseSpeed: number, modifierTotal: number): number =>
    Math.max(EFFECTIVE_SPEED_FLOOR, baseSpeed + modifierTotal);

// D4b — default `scheduler:interval`. THE rounding rule: half-up to integer
// microseconds (Math.round on the positive operand = half-up), floored at
// MIN_INTERVAL_US = 1 µs. effectiveSpeed is defensively re-clamped (the
// types.ts contract says callers pass it already clamped; re-clamping costs
// nothing and keeps the floor total, e.g. eff 0 ⇒ 1e9 µs not Infinity).
export const defaultInterval = (args: SchedulerIntervalArgs): number => {
    const eff = Math.max(EFFECTIVE_SPEED_FLOOR, args.effectiveSpeed);
    const rawMicroseconds = (args.actionCost * SCHEDULER_SCALE_US) / eff;
    return Math.max(MIN_INTERVAL_US, Math.round(rawMicroseconds));
};

// D4d — default `scheduler:order`. Among entries with MINIMAL readyAt:
// (1) higher current effective speed first, then (2) lower original entity
// index (definition order). The min-readyAt filter is defensive: the engine
// passes only the tied minimal set (pickNext builds it), but standalone
// callers passing a mixed set still get the D4d semantics. Deterministic
// total order — ties favor earlier-listed entities (declared fairness
// caveat, D4d). Precondition: candidates non-empty (engine only calls this
// with pending entries; an empty set is a caller/engine error, not a
// silent default).
export const defaultOrder = (args: SchedulerOrderArgs): string => {
    let min = Infinity;
    for (const candidate of args.candidates) {
        if (candidate.readyAt < min) min = candidate.readyAt;
    }
    const tied = args.candidates.filter((candidate) => candidate.readyAt === min);
    // sort is over the tiny tied-minimal set; comparator encodes D4d:
    // descending effectiveSpeed, then ascending definition order
    tied.sort(
        (a, b) => b.effectiveSpeed - a.effectiveSpeed || a.order - b.order,
    );
    return tied[0].entityId;
};

// D4a — initial schedule from time 0: one entry per entity,
// readyAt = interval(actionCost, effectiveSpeed) — first readiness is never
// 0 (the interval floor guarantees it). Routes through the ACTIVE interval
// hook so a replaced `scheduler:interval` governs battle start too (D6).
export const buildInitialEntries = (
    entities: readonly InitialScheduleEntity[],
    interval: IntervalFn = defaultInterval,
): ScheduleEntry[] =>
    entities.map((entity) => ({
        entityId: entity.entityId,
        readyAt: interval({
            entityId: entity.entityId,
            actionCost: entity.actionCost,
            effectiveSpeed: entity.effectiveSpeed,
        }),
    }));

// One pending entry per entity (D4a): insert REPLACES any existing entry
// for the same id (re-arming an actor must never stack entries). Mutates
// the array in place — it is the snapshot-serializable schedule.
export const upsertEntry = (entries: ScheduleEntry[], entityId: string, readyAt: number): void => {
    const existing = entries.find((entry) => entry.entityId === entityId);
    if (existing) {
        existing.readyAt = readyAt;
    } else {
        entries.push({ entityId, readyAt });
    }
};

// Death removal (D4e "deaths drop the dead entity's pending entries
// immediately"). Returns whether an entry was removed (idempotent: a second
// removal for the same id is a no-op returning false).
export const removeEntry = (entries: ScheduleEntry[], entityId: string): boolean => {
    const index = entries.findIndex((entry) => entry.entityId === entityId);
    if (index === -1) return false;
    entries.splice(index, 1);
    return true;
};

// Smallest readyAt across pending entries, or null when nothing is pending
// (all dead ⇒ the engine's outcome:decide handles the terminal, D5g).
export const minReadyAt = (entries: readonly ScheduleEntry[]): number | null => {
    let min: number | null = null;
    for (const entry of entries) {
        if (min === null || entry.readyAt < min) min = entry.readyAt;
    }
    return min;
};

// D4d candidate set: every entry sharing the minimal readyAt, enriched via
// the lookup with effectiveSpeed + definition order. Empty input ⇒ empty
// set (callers guard via minReadyAt/pickNext).
export const buildCandidates = (entries: readonly ScheduleEntry[], lookup: CandidateLookup): ScheduleCandidate[] => {
    const min = minReadyAt(entries);
    if (min === null) return [];
    return entries
        .filter((entry) => entry.readyAt === min)
        .map((entry) => ({
            entityId: entry.entityId,
            readyAt: entry.readyAt,
            effectiveSpeed: lookup(entry.entityId).effectiveSpeed,
            order: lookup(entry.entityId).order,
        }));
};

// D4a + D4d — one step's pick: virtual time advances to the minimal
// readyAt; the tie set routes through the ACTIVE order hook (always, even
// for a single candidate — a replaced hook may implement its own fairness,
// D4d note). Returns the LIVE entry (the engine advances it in place) plus
// the new virtual time, or null when nothing is pending.
export const pickNext = (
    entries: readonly ScheduleEntry[],
    lookup: CandidateLookup,
    order: OrderFn = defaultOrder,
): { entry: ScheduleEntry; time: number } | null => {
    const candidates = buildCandidates(entries, lookup);
    if (candidates.length === 0) return null;
    const chosenId = order({ candidates });
    // chosenId comes from the candidate set, so the find always hits; a
    // misbehaving hook returning an unknown id is the engine's fault case
    // (D7 invalid single-mode return), not this helper's problem.
    const entry = entries.find((candidate) => candidate.entityId === chosenId);
    if (!entry) return null;
    return { entry, time: entry.readyAt };
};

// D4e — post-turn re-arm: readyAt = now + interval({ entityId, actionCost,
// effectiveSpeed }) through the ACTIVE interval hook (the speed is the one
// snapshotted at pick time, D5a.1). actionCost is 1 for basic attack/wait,
// the ability's own cost otherwise (D4b). Upserts the single pending entry.
export const advanceEntry = (
    entries: ScheduleEntry[],
    entityId: string,
    now: number,
    actionCost: number,
    effSpeed: number,
    interval: IntervalFn = defaultInterval,
): void => {
    const delta = interval({ entityId, actionCost, effectiveSpeed: effSpeed });
    upsertEntry(entries, entityId, now + delta);
};

// D4e — proportional remaining-work reschedule when a speed modifier lands
// mid-cascade on an entity OTHER than the one being processed:
//   remaining = (readyAt − now) × oldEff / SCALE      (plain JS number)
//   readyAt   = now + max(1, round-half-up(interval({ actionCost:
//               remaining, effectiveSpeed: newEff })))
// The SAME active interval hook is used — faster ⇒ sooner, slower ⇒ later,
// and a replaced hook is honored under its own rounding curve (worked
// example: 300000 µs remaining at oldEff 2 → newEff 4 ⇒ 150000 µs). The
// outer max(1, Math.round(…)) re-applies the D4b integer-µs contract to
// whatever the hook returns, so a fractional replaced curve still yields
// integer µs time. Guards (D4e): an entry already picked for the current
// step (readyAt ≤ now) is never rescheduled mid-flight; a missing entry
// (dead) is a no-op. Returns whether the entry was rescheduled.
export const rescheduleEntry = (
    entries: ScheduleEntry[],
    entityId: string,
    now: number,
    oldEff: number,
    newEff: number,
    interval: IntervalFn = defaultInterval,
): boolean => {
    const entry = entries.find((candidate) => candidate.entityId === entityId);
    if (!entry) return false;
    // mid-flight guard: the picked entry (readyAt === now) and any already
    // due entry are never moved (D4e)
    if (entry.readyAt <= now) return false;
    // remaining work in cost-units at the OLD effective speed — plain JS
    // number arithmetic by design (D4e); the hook re-derives µs at the new
    // speed, so no intermediate rounding happens here
    const remaining = ((entry.readyAt - now) * oldEff) / SCHEDULER_SCALE_US;
    const delta = interval({ entityId, actionCost: remaining, effectiveSpeed: newEff });
    entry.readyAt = now + Math.max(MIN_INTERVAL_US, Math.round(delta));
    return true;
};
