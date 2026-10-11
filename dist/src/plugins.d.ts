import type { ChainHookId, CombatPlugin, DeclarativeRule, HookHandler, SingleHookId, StateView } from './types';
import type { EffectAdapter, VocabLookup } from './effects';
export declare const DEFINITION_RULES_PLUGIN_ID = "@definition/rules";
export interface PluginRegistryRuntime {
    adapter: EffectAdapter;
    view: () => StateView;
}
export interface PluginRegistryConfig {
    builtin?: CombatPlugin;
    plugins?: CombatPlugin[];
    rules?: DeclarativeRule[];
    runtime?: () => PluginRegistryRuntime;
}
export interface PluginRegistry {
    pluginIds(): string[];
    single(hook: SingleHookId): HookHandler | undefined;
    singleOwner(hook: SingleHookId): string | undefined;
    chain(hook: ChainHookId): readonly HookHandler[];
    chainOwner(hook: ChainHookId, index: number): string | undefined;
    vocab: VocabLookup;
}
export declare function createPluginRegistry(config: PluginRegistryConfig): PluginRegistry;
