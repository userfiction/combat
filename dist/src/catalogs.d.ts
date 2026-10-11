import type { BattleDefinition, GearDefinition } from './types';
export declare const defaultGearSeed: readonly GearDefinition[];
export type GearPatch = {
    id: string;
} & Partial<Omit<GearDefinition, 'id'>>;
export interface GearCatalog {
    /** Patch by id (known id keeps existing fields; undefined never erases). Returns a copy. */
    define(spec: GearPatch): GearDefinition;
    /** Copy of the definition, or undefined when unknown. */
    definitionOf(id: string): GearDefinition | undefined;
    has(id: string): boolean;
    /** All definitions as copies, in deterministic listing order (D9). */
    all(): GearDefinition[];
    count(): number;
    remove(id: string): boolean;
    clear(): void;
}
export declare const createGearCatalog: (options?: {
    seed?: readonly GearDefinition[];
}) => GearCatalog;
export declare const mergeGearCatalog: (seed: readonly GearDefinition[], patches?: readonly unknown[]) => GearDefinition[];
export declare const resolveBattleDefinition: (input: BattleDefinition) => BattleDefinition;
