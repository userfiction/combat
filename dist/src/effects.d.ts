import type { Condition, EffectDamageType, EffectDescriptor, Slot, StatKey, StateView, StepContext, VocabConditionHandler, VocabEffectHandler } from './types';
export interface VocabLookup {
    condition(fullId: string): VocabConditionHandler | undefined;
    effect(fullId: string): VocabEffectHandler | undefined;
}
export interface EffectAdapter {
    strike(): void;
    damageFlat(entityId: string, amount: number, damageType?: EffectDamageType): void;
    heal(entityId: string, amount: number): void;
    applyStatus(entityId: string, statusId: string, stacks?: number, duration?: number, potency?: number): void;
    removeStatus(entityId: string, statusId: string): void;
    breakEquipment(entityId: string, slot?: Slot): void;
    modifyStat(entityId: string, stat: StatKey, amount: number, duration?: number): void;
    emitMessage(message: string): void;
}
export interface InterpreterDeps {
    view: StateView;
    ctx: StepContext;
    vocab: VocabLookup;
    adapter: EffectAdapter;
}
export declare function evaluateCondition(condition: Condition, deps: InterpreterDeps): boolean;
export declare function applyEffects(effects: EffectDescriptor[], deps: InterpreterDeps): void;
