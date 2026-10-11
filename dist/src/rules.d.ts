import type { VocabLookup } from './effects';
import type { DamageResult, GearDamageResult } from './state';
import type { AbilityDefinition, CombatPlugin, EquipmentEntry, EquipmentPostArgs, EntityView, EventDraft, GearDefinition, Slot, StatModifier, StateView, StatusTurnEndArgs } from './types';
export declare const BUILTIN_RULES_PLUGIN_ID = "@userfiction/combat/rules";
export declare const isDefaultRulesPlugin: (plugin: unknown) => boolean;
export interface DefaultRulesOptions {
    gear?: readonly GearDefinition[];
    abilities?: readonly AbilityDefinition[];
    vocab?: VocabLookup;
}
export declare const enemiesOf: (view: StateView, entity: EntityView) => EntityView[];
export declare const defaultRules: (options?: DefaultRulesOptions) => CombatPlugin;
export interface PhaseDefaultApi {
    damageGear(entityId: string, slot: Slot, amount?: number): GearDamageResult | null;
    removeGear(entityId: string, slot: Slot): EquipmentEntry | null;
    damageEntity(entityId: string, amount: number): DamageResult;
    removeStatus(entityId: string, statusId: string): boolean;
    patchStatus(entityId: string, statusId: string, patch: {
        stacks?: number;
        duration?: number;
    }): void;
    decrementStatModifiers(entityId: string): StatModifier[];
    dropScheduleEntries(entityId: string): void;
    emit(draft: EventDraft): void;
}
export declare const applyEquipmentPostDefault: (api: PhaseDefaultApi, args: EquipmentPostArgs) => void;
export declare const applyStatusTurnEndDefault: (api: PhaseDefaultApi, args: StatusTurnEndArgs) => void;
