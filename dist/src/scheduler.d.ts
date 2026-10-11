import type { ScheduleCandidate, ScheduleEntry, SchedulerIntervalArgs, SchedulerOrderArgs } from './types';
export type IntervalFn = (args: SchedulerIntervalArgs) => number;
export type OrderFn = (args: SchedulerOrderArgs) => string;
export type CandidateLookup = (entityId: string) => {
    effectiveSpeed: number;
    order: number;
};
export interface InitialScheduleEntity {
    entityId: string;
    actionCost: number;
    effectiveSpeed: number;
}
export declare const effectiveSpeed: (baseSpeed: number, modifierTotal: number) => number;
export declare const defaultInterval: (args: SchedulerIntervalArgs) => number;
export declare const defaultOrder: (args: SchedulerOrderArgs) => string;
export declare const buildInitialEntries: (entities: readonly InitialScheduleEntity[], interval?: IntervalFn) => ScheduleEntry[];
export declare const upsertEntry: (entries: ScheduleEntry[], entityId: string, readyAt: number) => void;
export declare const removeEntry: (entries: ScheduleEntry[], entityId: string) => boolean;
export declare const minReadyAt: (entries: readonly ScheduleEntry[]) => number | null;
export declare const buildCandidates: (entries: readonly ScheduleEntry[], lookup: CandidateLookup) => ScheduleCandidate[];
export declare const pickNext: (entries: readonly ScheduleEntry[], lookup: CandidateLookup, order?: OrderFn) => {
    entry: ScheduleEntry;
    time: number;
} | null;
export declare const advanceEntry: (entries: ScheduleEntry[], entityId: string, now: number, actionCost: number, effSpeed: number, interval?: IntervalFn) => void;
export declare const rescheduleEntry: (entries: ScheduleEntry[], entityId: string, now: number, oldEff: number, newEff: number, interval?: IntervalFn) => boolean;
