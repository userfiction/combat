import type { BattleEvent, BattleEvent as Event, EventDraft, SimulationSnapshot } from './types';
export interface EventLogMarker {
    length: number;
    nextId: number;
}
export interface EventLog {
    emit(draft: EventDraft, step: number, time: number): BattleEvent;
    all(): BattleEvent[];
    count(): number;
    nextEventId(): number;
    marker(): EventLogMarker;
    rollback(marker: EventLogMarker): void;
    restore(events: readonly BattleEvent[]): void;
    clear(): void;
    trim(step: number, time: number): number;
}
export declare const createEventLog: (maxLogEvents: number) => EventLog;
export declare const eventFormatters: Record<string, (event: Event, snapshot?: SimulationSnapshot) => string>;
export declare const renderEventText: (event: BattleEvent, snapshot?: SimulationSnapshot) => string;
