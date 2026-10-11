import type { CombatValidation } from './types';
export interface BattleValidationOptions {
    vocab?: {
        conditions?: readonly string[];
        effects?: readonly string[];
    };
}
export declare const validateBattleDefinition: (input: unknown, options?: BattleValidationOptions) => CombatValidation;
export type ValidateBattleDefinitionWithOptions = (input: unknown, options?: BattleValidationOptions) => CombatValidation;
