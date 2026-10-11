import type { BattleDefinition, BattleEvent, BattleMode, EntitySnapshot, EntityView, EquipmentEntry, Outcome, RngState, ScheduleEntry, SimulationSnapshot, SnapshotState, StatBlock, StatInput, StatKey, StatModifier, StateView, StatusInstance, Slot } from './types';
export declare const WEAPON_SLOTS: readonly Slot[];
export declare const ARMOUR_SLOTS: readonly Slot[];
export declare function deepCopy<T>(value: T): T;
export type EntityState = EntitySnapshot;
export interface CombatState extends SnapshotState {
    mode: BattleMode;
}
export interface EntitySeed {
    id: string;
    name?: string;
    team?: string;
    order: number;
    stats: StatInput;
    statuses?: StatusInstance[];
    equipment?: EquipmentEntry[];
    cooldowns?: Record<string, number>;
}
export declare function resolveStatBlock(input: StatInput): StatBlock;
export declare function createEntityState(seed: EntitySeed): EntityState;
export interface CombatStateSeed {
    mode: BattleMode;
    entities: EntityState[];
    rng: RngState;
    schedule?: ScheduleEntry[];
    step?: number;
    virtualTime?: number;
    terminal?: Outcome | null;
}
export declare function createCombatState(seed: CombatStateSeed): CombatState;
export declare function effectiveStatsOf(base: StatBlock, modifiers: readonly StatModifier[]): StatBlock;
export declare function entityViewOf(entity: EntityState): EntityView;
export declare function stateViewOf(state: CombatState): StateView;
export declare function snapshotStateOf(state: CombatState): SnapshotState;
export declare function snapshotOf(state: CombatState, definition: BattleDefinition, events: readonly BattleEvent[]): SimulationSnapshot;
export declare function restoreFrom(snapshot: SimulationSnapshot): CombatState;
export declare function findEntity(state: CombatState, entityId: string): EntityState;
export interface DamageResult {
    entityId: string;
    applied: number;
    health: number;
    killed: boolean;
}
export declare function damageEntity(state: CombatState, entityId: string, amount: number): DamageResult;
export interface HealResult {
    entityId: string;
    applied: number;
    health: number;
}
export declare function healEntity(state: CombatState, entityId: string, amount: number): HealResult;
export interface StatusApplyOptions {
    stacks?: number;
    duration?: number;
    potency?: number;
    resistance?: number;
}
export type StatusApplyResult = {
    kind: 'resisted';
} | {
    kind: 'applied';
    status: StatusInstance;
} | {
    kind: 'refreshed';
    status: StatusInstance;
};
export declare function applyStatus(state: CombatState, entityId: string, statusId: string, options?: StatusApplyOptions): StatusApplyResult;
export declare function removeStatus(state: CombatState, entityId: string, statusId: string): boolean;
export declare function addStatModifier(state: CombatState, entityId: string, stat: StatKey, amount: number, remainingTurns: number): StatModifier;
export declare function decrementStatModifiers(state: CombatState, entityId: string): StatModifier[];
export interface GearDamageResult {
    gearId: string;
    slot: Slot;
    durability: number;
    broken: boolean;
}
export declare function damageGear(state: CombatState, entityId: string, slot: Slot, amount?: number): GearDamageResult | null;
export declare function removeGear(state: CombatState, entityId: string, slot: Slot): EquipmentEntry | null;
export declare function breakGear(state: CombatState, entityId: string, slot?: Slot): EquipmentEntry[];
export declare function dropScheduleEntries(state: CombatState, entityId: string): number;
