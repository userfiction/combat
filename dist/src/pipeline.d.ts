import type { CombatState } from './state';
import type { EventLog } from './events';
import type { PluginRegistry, PluginRegistryRuntime } from './plugins';
import type { AbilityDefinition, GearDefinition, ResolvedSimulationConfig } from './types';
import type { RngController } from './rng';
export interface TurnRunnerConfig {
    state: CombatState;
    registry: PluginRegistry;
    rng: RngController;
    log: EventLog;
    config: ResolvedSimulationConfig;
    gear: (gearId: string) => GearDefinition | undefined;
    ability: (abilityId: string) => AbilityDefinition | undefined;
    resistances: Record<string, Record<string, number>>;
    builtinRules: boolean;
}
export interface TurnRunner {
    state(): CombatState;
    setState(next: CombatState): void;
    armInitialSchedule(): void;
    decideAtStepZero(): void;
    step(): boolean;
    runtime(): PluginRegistryRuntime;
}
export declare const createTurnRunner: (cfg: TurnRunnerConfig) => TurnRunner;
