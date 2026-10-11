// ============================================================================
// @userfiction/combat — src/plugins.ts — T4 plugin registry (task §5 D6/D7,
// ordering + override semantics per reader precedent registry.ts L331–344 /
// L526–578 / L603–617)
// ============================================================================
// Builds the hook registry createSimulation consumes (T5 wiring):
//
//   registration order = [builtin?, ...options.plugins, synthetic-rules?]
//   (D6: "builtin first, then code plugins in options.plugins order, then
//   the definition's JSON contributions as a synthetic '@definition/rules'
//   plugin last — JSON content reacts after code rules").
//
//   - SINGLE hooks (SINGLE_HOOK_IDS): exactly ONE handler runs — the LAST
//     registered plugin that lists the hook in `overrides` AND ships a
//     handler (explicit deterministic last-wins, D6: "two or more plugins
//     correctly declaring the same override is legal… never an error");
//     otherwise the builtin default handler; otherwise undefined (engine
//     decides — with builtinRules:false an unclaimed hook is legal, D5g).
//   - CHAIN hooks (CHAIN_HOOK_IDS): ALL handlers run in registration order;
//     merged list bounded by MAX_HOOK_HANDLERS (D7 "≤ 32 per hook").
//   - vocab: every plugin's short names are merged under
//     namespaced(pluginId, name) (D8, ids.ts); duplicate plugin ids are
//     rejected, so namespaced ids can never collide.
//
// Fail-fast load validation (D7, deliberate divergence from reader
// quarantine — see D2 rationale): collects ALL errors, then throws ONE
// CombatPluginError carrying the list. Rejected: duplicate plugin id,
// reserved '@definition/rules' id used by code, unknown hook id,
// non-function handler, array shipped for a single-mode hook, undeclared
// single-mode handler (builtin EXEMPT — D6: defaultRules "claims nothing"),
// overrides entries that are not single-mode hook ids, bad vocab shape,
// over-long chain lists, rules without a runtime provider, malformed rules.
//
// Composition seam for T5 (task brief: "accept resolved … callbacks rather
// than coupled dependencies"): the synthetic rules plugin needs the engine's
// mutation adapter and a FRESH StateView per rule (later rules must observe
// earlier rules' effects, D8 "run in listed order"). Both arrive through the
// deferred `runtime` provider — the registry closes over it but only calls
// it at handler-run time, so the engine can build the adapter (which needs
// the registry for strike) after construction without a cycle.
// ============================================================================

import { CombatPluginError } from './types';
import type {
    ChainHookId,
    CombatPlugin,
    DeclarativeRule,
    HookHandler,
    HookId,
    SingleHookId,
    StateView,
    StepContext,
    VocabConditionHandler,
    VocabEffectHandler,
} from './types';
import { CHAIN_HOOK_IDS, HOOK_IDS, MAX_HOOK_HANDLERS, SINGLE_HOOK_IDS } from './types';
import { namespaced } from './ids';
import { applyEffects, evaluateCondition } from './effects';
import type { EffectAdapter, InterpreterDeps, VocabLookup } from './effects';

// Synthetic plugin carrying definition.rules.contributions (D6). Reserved:
// code plugins may not take this id (duplicate/reserved ⇒ load error).
export const DEFINITION_RULES_PLUGIN_ID = '@definition/rules';

// Engine-owned runtime the JSON rules execute against (see header seam).
// `view()` is called PER RULE so each rule sees the state after the previous
// rule's effects were applied; `adapter` is the effects.ts mutation surface.
export interface PluginRegistryRuntime {
    adapter: EffectAdapter;
    view: () => StateView;
}

export interface PluginRegistryConfig {
    // defaultRules() plugin (D5) or undefined when builtinRules === false.
    builtin?: CombatPlugin;
    // options.plugins, registration order preserved (D6/D7).
    plugins?: CombatPlugin[];
    // definition.rules?.contributions — compiled into the synthetic plugin.
    rules?: DeclarativeRule[];
    // Deferred engine runtime; REQUIRED when rules are non-empty.
    runtime?: () => PluginRegistryRuntime;
}

// The built registry (passive — the pipeline runs handlers; fault handling,
// result validation and event emission stay engine-side, D7).
export interface PluginRegistry {
    // Registration order, for diagnostics/UI display.
    pluginIds(): string[];
    // Resolved single-mode handler (override → builtin default → undefined).
    single(hook: SingleHookId): HookHandler | undefined;
    // Owning plugin id of the resolved single handler (undefined when the
    // hook is unclaimed). T5 fault attribution: the D7 fault event carries
    // { pluginId?, hook?, error }, so the engine must know WHICH plugin
    // supplied the handler that threw or returned an invalid result.
    singleOwner(hook: SingleHookId): string | undefined;
    // Ordered chain handlers (builtin → code → JSON rules); frozen array,
    // empty (not undefined) when nothing is registered.
    chain(hook: ChainHookId): readonly HookHandler[];
    // Owner id of chain handler #index (same order as chain()); T5 fault
    // attribution, same rationale as singleOwner.
    chainOwner(hook: ChainHookId, index: number): string | undefined;
    // Merged namespaced vocabulary for the interpreter (effects.ts).
    vocab: VocabLookup;
}

// ----------------------------------------------------------------------------
// Shape helpers
// ----------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const includesStr = (list: readonly string[], value: unknown): boolean => list.includes(value as string);

// ----------------------------------------------------------------------------
// Per-plugin validation (collects into `errors`, never throws early — reader
// precedent L331–334 "validate once at load collecting ALL errors").
// `exemptUndeclared` is true ONLY for the builtin plugin (D6: it ships the
// baseline single-mode handlers without claiming any override).
// ----------------------------------------------------------------------------
function validatePlugin(plugin: unknown, label: string, exemptUndeclared: boolean, errors: string[]): void {
    if (!isPlainObject(plugin)) {
        errors.push(`plugin ${label} must be an object`);
        return;
    }
    const id = plugin.id;
    if (typeof id !== 'string' || id === '') {
        errors.push(`plugin ${label} requires a non-empty string id`);
        return;
    }
    const pid = `'${id}'`;

    // --- overrides: strings naming SINGLE-mode hooks only (D6/D7) ---
    const overrides = plugin.overrides;
    const declared: string[] = [];
    if (overrides !== undefined) {
        if (!Array.isArray(overrides)) {
            errors.push(`plugin ${pid} overrides must be an array`);
        } else {
            for (const entry of overrides) {
                if (typeof entry !== 'string') {
                    errors.push(`plugin ${pid} overrides entries must be strings`);
                    continue;
                }
                if (includesStr(SINGLE_HOOK_IDS, entry)) {
                    declared.push(entry);
                    continue;
                }
                if (includesStr(HOOK_IDS, entry)) {
                    errors.push(`plugin ${pid} lists chain-mode hook in overrides: '${entry}'`);
                } else {
                    errors.push(`plugin ${pid} lists unknown hook id in overrides: '${entry}'`);
                }
            }
        }
    }

    // --- hooks: known ids; single ⇒ one fn; chain ⇒ fn or fn[] (D7) ---
    const hooks = plugin.hooks;
    if (hooks !== undefined) {
        if (!isPlainObject(hooks)) {
            errors.push(`plugin ${pid} hooks must be an object`);
        } else {
            for (const hook of Object.keys(hooks)) {
                if (!includesStr(HOOK_IDS, hook)) {
                    errors.push(`plugin ${pid} uses unknown hook id: '${hook}'`);
                    continue;
                }
                const value = hooks[hook];
                const isSingle = includesStr(SINGLE_HOOK_IDS, hook);
                if (isSingle) {
                    if (typeof value === 'function') {
                        // ok
                    } else if (Array.isArray(value)) {
                        errors.push(`plugin ${pid} ships an array for single-mode hook '${hook}'`);
                    } else {
                        errors.push(`plugin ${pid} ships a non-function handler for hook '${hook}'`);
                    }
                    // D7: shipping a single-mode handler without declaring
                    // it in overrides is rejected (builtin exempt, D6).
                    if (!exemptUndeclared && !declared.includes(hook)) {
                        errors.push(`plugin ${pid} ships single-mode handler '${hook}' without declaring it in overrides`);
                    }
                } else if (typeof value === 'function') {
                    // ok — single chain contribution
                } else if (Array.isArray(value)) {
                    for (const item of value) {
                        if (typeof item !== 'function') {
                            errors.push(`plugin ${pid} ships a non-function handler for hook '${hook}'`);
                            break; // one message per hook keeps error lists stable
                        }
                    }
                } else {
                    errors.push(`plugin ${pid} ships a non-function handler for hook '${hook}'`);
                }
            }
        }
    }

    // --- vocab: records of functions keyed by SHORT names (D7/D8) ---
    // Keys containing '/' would produce two-level namespaced ids and break
    // the one-level namespaced(pluginId, name) convention — rejected.
    const vocab = plugin.vocab;
    if (vocab !== undefined) {
        if (!isPlainObject(vocab)) {
            errors.push(`plugin ${pid} vocab must be an object`);
        } else {
            for (const section of ['conditions', 'effects'] as const) {
                const record = vocab[section];
                if (record === undefined) continue;
                if (!isPlainObject(record)) {
                    errors.push(`plugin ${pid} vocab ${section} must be an object`);
                    continue;
                }
                for (const key of Object.keys(record)) {
                    if (key === '' || key.includes('/')) {
                        errors.push(`plugin ${pid} vocab ${section} key must be a short name without '/': '${key}'`);
                    }
                    if (typeof record[key] !== 'function') {
                        errors.push(`plugin ${pid} vocab ${section} handler for '${key}' is not a function`);
                    }
                }
            }
        }
    }
}

// Count a plugin's chain-handler registrations toward the per-hook bound
// (D7 ≤ 32). Unknown/single hooks are ignored here — validatePlugin reported
// them already.
function countChainHandlers(plugin: CombatPlugin, counts: Map<string, number>): void {
    const hooks = plugin.hooks;
    if (!isPlainObject(hooks)) return;
    for (const hook of Object.keys(hooks)) {
        if (!includesStr(CHAIN_HOOK_IDS, hook)) continue;
        const value = (hooks as Record<string, unknown>)[hook];
        const n = typeof value === 'function' ? 1 : Array.isArray(value) ? value.length : 0;
        counts.set(hook, (counts.get(hook) ?? 0) + n);
    }
}

// Light structural rule validation (D3/D8): full condition/effect vocab
// validation is T2's job at definition load; the registry must still be
// able to ROUTE rules to chain hooks without exploding, so hook ids and
// basic shapes are checked here too (defense in depth for direct callers).
function validateRules(rules: readonly DeclarativeRule[], errors: string[]): Set<ChainHookId> {
    const hooks = new Set<ChainHookId>();
    for (const rule of rules) {
        if (!isPlainObject(rule)) {
            errors.push('each declarative rule must be an object');
            continue;
        }
        const rid = typeof rule.id === 'string' && rule.id !== '' ? rule.id : undefined;
        if (rid === undefined) {
            errors.push('each declarative rule requires a non-empty string id');
        }
        const hook = rule.hook;
        if (typeof hook !== 'string' || !includesStr(CHAIN_HOOK_IDS, hook)) {
            errors.push(`rule '${rid ?? '?'}' hook must be a chain-mode hook: ${typeof hook === 'string' ? `'${hook}'` : String(hook)}`);
        } else {
            hooks.add(hook as ChainHookId);
        }
        if (!Array.isArray(rule.effects)) {
            errors.push(`rule '${rid ?? '?'}' effects must be an array`);
        }
        if (rule.when !== undefined && !isPlainObject(rule.when)) {
            errors.push(`rule '${rid ?? '?'}' when must be a condition object`);
        }
    }
    return hooks;
}

// ----------------------------------------------------------------------------
// Registry construction
// ----------------------------------------------------------------------------
export function createPluginRegistry(config: PluginRegistryConfig): PluginRegistry {
    const errors: string[] = [];

    const builtin = config.builtin;
    const codePlugins = config.plugins ?? [];
    const rules = config.rules ?? [];

    // 1. Validate every plugin shape (builtin exempt from undeclared-single).
    if (builtin !== undefined) validatePlugin(builtin, 'builtin', true, errors);
    codePlugins.forEach((plugin, index) => validatePlugin(plugin, `at index ${index}`, false, errors));

    // 2. Reserved synthetic id can never be taken by code (D6).
    if (builtin !== undefined && isPlainObject(builtin) && builtin.id === DEFINITION_RULES_PLUGIN_ID) {
        errors.push(`plugin id reserved for JSON contributions: '${DEFINITION_RULES_PLUGIN_ID}'`);
    }
    for (const plugin of codePlugins) {
        if (isPlainObject(plugin) && plugin.id === DEFINITION_RULES_PLUGIN_ID) {
            errors.push(`plugin id reserved for JSON contributions: '${DEFINITION_RULES_PLUGIN_ID}'`);
        }
    }

    // 3. Duplicate plugin ids across the session (D7).
    const seenIds = new Set<string>();
    for (const plugin of [builtin, ...codePlugins]) {
        if (plugin === undefined || !isPlainObject(plugin) || typeof plugin.id !== 'string' || plugin.id === '') continue;
        if (seenIds.has(plugin.id)) errors.push(`duplicate plugin id: '${plugin.id}'`);
        else seenIds.add(plugin.id);
    }

    // 4. Rules: structural checks + runtime requirement + chain bound.
    const ruleHooks = validateRules(rules, errors);
    if (rules.length > 0 && config.runtime === undefined) {
        errors.push('JSON rules require an effect runtime provider');
    }

    // 5. Merged chain-handler bound (D7 ≤ 32 per hook). The synthetic rules
    //    plugin contributes exactly one handler per distinct rule hook.
    const chainCounts = new Map<string, number>();
    if (builtin !== undefined && isPlainObject(builtin)) countChainHandlers(builtin, chainCounts);
    for (const plugin of codePlugins) {
        if (isPlainObject(plugin)) countChainHandlers(plugin, chainCounts);
    }
    for (const hook of ruleHooks) {
        chainCounts.set(hook, (chainCounts.get(hook) ?? 0) + 1);
    }
    for (const hook of CHAIN_HOOK_IDS) {
        const count = chainCounts.get(hook) ?? 0;
        if (count > MAX_HOOK_HANDLERS) {
            errors.push(`chain hook '${hook}' exceeds the ${MAX_HOOK_HANDLERS}-handler bound`);
        }
    }

    // 6. Fail fast with the FULL collected list (D2/D7).
    if (errors.length > 0) throw new CombatPluginError(errors);

    // ---- post-validation construction (all inputs known good) ----

    // 7. Merge vocabulary under namespaced ids (D8). Registration order so
    //    diagnostics read consistently; collisions are structurally
    //    impossible (unique plugin ids + '/'-free short keys).
    const conditionMap = new Map<string, VocabConditionHandler>();
    const effectMap = new Map<string, VocabEffectHandler>();
    for (const plugin of [builtin, ...codePlugins]) {
        if (plugin === undefined) continue;
        const vocab = plugin.vocab;
        if (!vocab) continue;
        if (vocab.conditions) {
            for (const [shortName, handler] of Object.entries(vocab.conditions)) {
                conditionMap.set(namespaced(plugin.id, shortName), handler);
            }
        }
        if (vocab.effects) {
            for (const [shortName, handler] of Object.entries(vocab.effects)) {
                effectMap.set(namespaced(plugin.id, shortName), handler);
            }
        }
    }
    const vocab: VocabLookup = {
        condition: (fullId: string) => conditionMap.get(fullId),
        effect: (fullId: string) => effectMap.get(fullId),
    };

    // 8. Compile the synthetic '@definition/rules' plugin (D6 last). One
    //    handler per distinct hook; inside, rules run in LISTED order:
    //    evaluate `when` against a FRESH view (runtime.view()), skip on
    //    false, apply effects through the engine adapter (D8 semantics).
    let rulesPlugin: CombatPlugin | undefined;
    if (rules.length > 0) {
        const rulesByHook = new Map<ChainHookId, DeclarativeRule[]>();
        for (const rule of rules) {
            const list = rulesByHook.get(rule.hook) ?? [];
            list.push(rule);
            rulesByHook.set(rule.hook, list);
        }
        const syntheticHooks: Partial<Record<HookId, HookHandler>> = {};
        for (const [hook, hookRules] of rulesByHook) {
            syntheticHooks[hook] = (_view: StateView, ctx: StepContext) => {
                const runtime = (config.runtime as () => PluginRegistryRuntime)();
                for (const rule of hookRules) {
                    // Fresh view per rule ⇒ later rules observe earlier
                    // effects (D8 "run in listed order").
                    const deps: InterpreterDeps = { view: runtime.view(), ctx, vocab, adapter: runtime.adapter };
                    if (rule.when !== undefined && !evaluateCondition(rule.when, deps)) continue;
                    applyEffects(rule.effects, deps);
                }
            };
        }
        rulesPlugin = { id: DEFINITION_RULES_PLUGIN_ID, hooks: syntheticHooks };
    }

    // 9. Ordered registration list: builtin → code → synthetic (D6).
    const ordered: CombatPlugin[] = [];
    if (builtin !== undefined) ordered.push(builtin);
    ordered.push(...codePlugins);
    if (rulesPlugin !== undefined) ordered.push(rulesPlugin);

    // 10. Chain map: every handler for each chain hook, registration order,
    // plus the PARALLEL owner-id list (T5 fault attribution, D7 fault event
    // pluginId field).
    const chainMap = new Map<ChainHookId, readonly HookHandler[]>();
    const chainOwnerMap = new Map<ChainHookId, readonly string[]>();
    for (const hook of CHAIN_HOOK_IDS) {
        const handlers: HookHandler[] = [];
        const owners: string[] = [];
        for (const plugin of ordered) {
            const value = plugin.hooks?.[hook];
            if (value === undefined) continue;
            if (typeof value === 'function') {
                handlers.push(value);
                owners.push(plugin.id);
            } else if (Array.isArray(value)) {
                handlers.push(...value);
                // one owner entry per handler keeps the arrays index-aligned
                for (let i = 0; i < value.length; i += 1) owners.push(plugin.id);
            }
        }
        chainMap.set(hook, Object.freeze(handlers));
        chainOwnerMap.set(hook, Object.freeze(owners));
    }

    // 11. Single map: last plugin that DECLARES the hook in overrides AND
    // ships a handler wins (D6 last-wins); a declaration without a handler
    // is a legal no-op that does NOT win (declared decision — D7's rejection
    // list covers the reverse case only). Else builtin default; else
    // undefined (engine decides, D5g builtinRules:false semantics). Owner id
    // recorded alongside for singleOwner (fault attribution).
    const singleMap = new Map<SingleHookId, { handler: HookHandler; owner: string }>();
    for (const hook of SINGLE_HOOK_IDS) {
        let chosen: { handler: HookHandler; owner: string } | undefined;
        for (let i = ordered.length - 1; i >= 0; i -= 1) {
            const plugin = ordered[i];
            if (plugin.overrides?.includes(hook) && typeof plugin.hooks?.[hook] === 'function') {
                chosen = { handler: plugin.hooks[hook] as HookHandler, owner: plugin.id };
                break;
            }
        }
        if (chosen === undefined && typeof builtin?.hooks?.[hook] === 'function') {
            chosen = { handler: builtin.hooks[hook] as HookHandler, owner: builtin.id };
        }
        if (chosen !== undefined) singleMap.set(hook, chosen);
    }

    const emptyChain: readonly HookHandler[] = Object.freeze([] as HookHandler[]);
    const emptyOwners: readonly string[] = Object.freeze([] as string[]);
    return {
        pluginIds: () => ordered.map((plugin) => plugin.id),
        single: (hook: SingleHookId) => singleMap.get(hook)?.handler,
        singleOwner: (hook: SingleHookId) => singleMap.get(hook)?.owner,
        chain: (hook: ChainHookId) => chainMap.get(hook) ?? emptyChain,
        chainOwner: (hook: ChainHookId, index: number) => chainOwnerMap.get(hook)?.[index],
        vocab,
    };
}
