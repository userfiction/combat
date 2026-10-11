// ============================================================================
// @userfiction/combat — src/effects.ts — T4 bounded condition/effect
// interpreter (task §5 D8, bounds D13, mutation ownership D7)
// ============================================================================
// The closed-vocabulary interpreter for declarative JSON rules
// (definition.rules.contributions) and ability effects. Two halves:
//
//   evaluateCondition — pure READ against a StateView + ctx.rng (chance is
//     the only RNG consumer; D4g shared stream). Returns a boolean.
//   applyEffects      — translates EffectDescriptor[] into EffectAdapter
//     calls. The interpreter NEVER mutates: the adapter is engine-owned
//     (D7 "only the engine mutates state"), implemented in T5 on top of
//     state.ts mutation helpers.
//
// Bounded (D8/D13): condition/effect recursion depth ≤ MAX_RULE_DEPTH (16)
// and every list ≤ MAX_RULE_LIST (32). T2 validates the same bounds at load
// (⇒ validation error); the interpreter enforces them again at runtime
// (⇒ throw, which the pipeline's transaction boundary turns into a fault,
// D7/D8 "runtime depth violations ⇒ fault"). Every throw here is therefore a
// deterministic fault signal, never swallowed.
//
// Code-vocab support (D8 vocabulary extension): any descriptor `type`
// containing '/' is a namespaced 'pluginId/name' id (ids.ts namespaced(),
// reader precedent registry.ts L110–111) resolved against the plugin
// registry's VocabLookup. Convention (task brief + types.ts CustomCondition):
// ALL descriptor fields except `type` are passed to the handler as flat
// `params`; effect handlers return EffectDescriptor[] which this interpreter
// applies recursively (custom effects expand into builtin ones — novel
// mechanics still mutate only through the adapter).
//
// RNG determinism note (D4g): all/any SHORT-CIRCUIT (all stops at the first
// false, any at the first true), so chance-condition draw consumption
// depends on evaluation order — deterministic for a fixed rule order, and
// documented here because it is observable in replay.
// ============================================================================

import { GEAR_KINDS, MAX_RULE_DEPTH, MAX_RULE_LIST, SLOTS, STAT_KEYS } from './types';
import type {
    Condition,
    EffectDamageType,
    EffectDescriptor,
    Ref,
    Slot,
    StatKey,
    StateView,
    StepContext,
    VocabConditionHandler,
    VocabEffectHandler,
} from './types';
import { ARMOUR_SLOTS, WEAPON_SLOTS } from './state';

// ----------------------------------------------------------------------------
// VocabLookup — read access to the merged plugin vocabulary (built by
// plugins.ts from every plugin's `vocab` block, namespaced per D8).
// ----------------------------------------------------------------------------
export interface VocabLookup {
    condition(fullId: string): VocabConditionHandler | undefined;
    effect(fullId: string): VocabEffectHandler | undefined;
}

// ----------------------------------------------------------------------------
// EffectAdapter — THE engine-owned mutation surface (task brief: "effects
// mutate only via engine-owned adapter/callback interfaces"). T5 implements
// each operation on live state via state.ts helpers and emits the matching
// D11 events; the interpreter only ever calls these methods with resolved
// entity ids. Expected engine semantics are documented per method so
// integration composes without guessing.
// ----------------------------------------------------------------------------
export interface EffectAdapter {
    // Full attack pipeline (D5a phases 5–11) for the current ctx refs. The
    // PIPELINE enforces MAX_STRIKE_DEPTH (D5a.12) — the interpreter just
    // delegates, since strike execution is pipeline machinery.
    strike(): void;
    // D8 damage-flat: direct health subtraction, bypasses mitigation, can
    // kill; damageType 'true' bypasses armour entirely (engine-side).
    // Engine emits a `damage` event with source 'effect' (D11).
    damageFlat(entityId: string, amount: number, damageType?: EffectDamageType): void;
    // D8 heal: engine clamps at maxHealth (state.ts healEntity); dead
    // entities are not revived. Emits `heal {amount}`.
    heal(entityId: string, amount: number): void;
    // D8 apply-status: engine honors statusResistances + stack cap +
    // duration refresh (state.ts applyStatus, D5c/D5e) and emits
    // status:applied / status:resisted.
    applyStatus(entityId: string, statusId: string, stacks?: number, duration?: number, potency?: number): void;
    // D8 remove-status: engine removes the instance if present.
    removeStatus(entityId: string, statusId: string): void;
    // D8 break-equipment: instant break; slot omitted ⇒ weapon slots
    // (state.ts breakGear decision). Engine emits gear:broken per removed piece.
    breakEquipment(entityId: string, slot?: Slot): void;
    // D8 modify-stat: temporary modifier counted in the TARGET's scheduled
    // turns (D5c/D10). duration omitted ⇒ PERMANENT — the engine maps it to
    // the state.ts remainingTurns === 0 sentinel. Engine emits stat:modified.
    modifyStat(entityId: string, stat: StatKey, amount: number, duration?: number): void;
    // D8 emit: engine appends a custom event carrying `message` (D11).
    emitMessage(message: string): void;
}

// Everything the interpreter needs for one run at a hook. `view` is the
// CURRENT read-only projection (plugins.ts re-derives it per rule so later
// rules observe earlier effects); `ctx` supplies rng + refs + step/time.
export interface InterpreterDeps {
    view: StateView;
    ctx: StepContext;
    vocab: VocabLookup;
    adapter: EffectAdapter;
}

// ----------------------------------------------------------------------------
// Internal guards/helpers
// ----------------------------------------------------------------------------

const REFS: readonly string[] = ['attacker', 'target', 'self'];
const STAT_OPS: readonly string[] = ['lt', 'lte', 'gt', 'gte', 'eq'];
const EFFECT_DAMAGE_TYPES: readonly string[] = ['blunt', 'sharp', 'true'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Namespaced custom type (D8): builtins never contain '/', so '/' is the
// discriminator (types.ts CustomTypeId comment).
const isNamespacedType = (type: string): boolean => type.includes('/');

// Flat params convention: every own field except `type` (task brief: "custom
// descriptors use namespaced type and flat fields passed as params excluding
// type"). Shallow copy — descriptor data is JSON-plain (D3/D8).
function paramsOf(descriptor: Record<string, unknown>): Record<string, unknown> {
    const { type: _type, ...params } = descriptor;
    return params;
}

function depthFault(): never {
    throw new Error(`interpreter depth exceeded (max ${MAX_RULE_DEPTH})`);
}

function requireNumber(value: unknown, kind: string, label: string, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`malformed '${kind}' ${label}: '${field}' must be a finite number`);
    }
    return value;
}

// Optional numeric field: null/undefined ⇒ absent (JSON authors write null
// for "omitted"; treated as absent rather than faulting — declared leniency
// bounded to optional fields).
function optionalNumber(value: unknown, kind: string, label: string, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return requireNumber(value, kind, label, field);
}

// Validate a Ref name from untrusted JSON.
function requireRef(descriptor: Record<string, unknown>, kind: string, label: string): Ref {
    const ref = descriptor.ref ?? descriptor.target;
    if (!REFS.includes(ref as string)) {
        throw new Error(`malformed '${kind}' ${label}: invalid ref '${String(ref)}'`);
    }
    return ref as Ref;
}

// Ref name → entity id (D7: attacker→actor, target→target, self→self ??
// actor). A missing ref (e.g. 'target' with no target in context) is a
// deterministic fault.
function refEntityId(ref: Ref, ctx: StepContext): string {
    if (ref === 'attacker') return ctx.refs.actor.id;
    if (ref === 'target') {
        if (!ctx.refs.target) throw new Error(`unresolvable ref: 'target'`);
        return ctx.refs.target.id;
    }
    return (ctx.refs.self ?? ctx.refs.actor).id;
}

// Ref name → EntityView in the CURRENT deps.view. Ids come from ctx.refs
// (stable across mutations); the entity is looked up fresh so conditions
// observe state changes earlier rules made. Missing ⇒ fault.
function refView(ref: Ref, deps: InterpreterDeps): NonNullable<StateView['entities'][number]> {
    const id = refEntityId(ref, deps.ctx);
    const entity = deps.view.entities.find((candidate) => candidate.id === id);
    if (!entity) throw new Error(`ref '${ref}' not present in view`);
    return entity;
}

// ----------------------------------------------------------------------------
// Condition evaluation (D8 closed set + namespaced extension)
// ----------------------------------------------------------------------------

export function evaluateCondition(condition: Condition, deps: InterpreterDeps): boolean {
    return evaluateConditionInternal(condition as unknown, deps, 1);
}

function evaluateConditionInternal(condition: unknown, deps: InterpreterDeps, depth: number): boolean {
    if (depth > MAX_RULE_DEPTH) depthFault();
    if (!isPlainObject(condition) || typeof condition.type !== 'string') {
        throw new Error(`malformed condition: ${JSON.stringify(condition)}`);
    }
    const type = condition.type;

    switch (type) {
        case 'always':
            return true;
        case 'never':
            return false;

        case 'stat': {
            const ref = requireRef(condition, 'stat', 'condition');
            const stat = condition.stat;
            if (!STAT_KEYS.includes(stat as StatKey)) {
                throw new Error(`malformed 'stat' condition: invalid stat '${String(stat)}'`);
            }
            const op = condition.op;
            if (!STAT_OPS.includes(op as string)) {
                throw new Error(`malformed 'stat' condition: invalid op '${String(op)}'`);
            }
            const value = requireNumber(condition.value, 'stat', 'condition', 'value');
            const entity = refView(ref, deps);
            // 'health' reads CURRENT hp (view.health), not stats.health: the
            // §7 terror rule ("target health ≤ 12") means live vitals —
            // stats.health is the effective-max bookkeeping (state.ts). All
            // other StatKeys read the EFFECTIVE block (D7).
            const actual = stat === 'health' ? entity.health : entity.stats[stat as StatKey];
            switch (op) {
                case 'lt': return actual < value;
                case 'lte': return actual <= value;
                case 'gt': return actual > value;
                case 'gte': return actual >= value;
                case 'eq': return actual === value;
                default: return false; // unreachable — STAT_OPS gate above
            }
        }

        case 'has-status': {
            const ref = requireRef(condition, 'has-status', 'condition');
            const status = condition.status;
            if (typeof status !== 'string' || status === '') {
                throw new Error(`malformed 'has-status' condition: 'status' must be a non-empty string`);
            }
            return refView(ref, deps).statuses.some((instance) => instance.id === status);
        }

        case 'has-gear': {
            const ref = requireRef(condition, 'has-gear', 'condition');
            const kind = condition.kind;
            if (kind !== undefined && kind !== null && !GEAR_KINDS.includes(kind as never)) {
                throw new Error(`malformed 'has-gear' condition: invalid kind '${String(kind)}'`);
            }
            const slot = condition.slot;
            if (slot !== undefined && slot !== null && !SLOTS.includes(slot as Slot)) {
                throw new Error(`malformed 'has-gear' condition: invalid slot '${String(slot)}'`);
            }
            // Kind check goes through the slot↔kind map (D9) — the view
            // carries no catalog (D7).
            return refView(ref, deps).equipment.some(
                (entry) =>
                    (slot === undefined || slot === null || entry.slot === slot) &&
                    (kind === undefined ||
                        kind === null ||
                        (kind === 'weapon' ? WEAPON_SLOTS.includes(entry.slot) : ARMOUR_SLOTS.includes(entry.slot))),
            );
        }

        case 'mode': {
            const is = condition.is;
            if (is !== 'ffa' && is !== 'teams') {
                throw new Error(`malformed 'mode' condition: invalid is '${String(is)}'`);
            }
            return deps.view.mode === is;
        }

        case 'chance': {
            // D4g: consumes exactly one draw from the shared stream, at
            // evaluation time (short-circuit callers may skip it — see header).
            const p = requireNumber(condition.p, 'chance', 'condition', 'p');
            return deps.ctx.rng.next() < p;
        }

        case 'all':
        case 'any': {
            const of = condition.of;
            if (!Array.isArray(of)) {
                throw new Error(`malformed '${type}' condition: 'of' must be an array`);
            }
            if (of.length > MAX_RULE_LIST) {
                throw new Error(`condition list exceeds the ${MAX_RULE_LIST}-item bound`);
            }
            // Short-circuit semantics (documented RNG consequence above);
            // empty lists: all ⇒ true, any ⇒ false (standard logic).
            for (const child of of) {
                const result = evaluateConditionInternal(child, deps, depth + 1);
                if (type === 'all' && !result) return false;
                if (type === 'any' && result) return true;
            }
            return type === 'all';
        }

        case 'not': {
            return !evaluateConditionInternal(condition.of, deps, depth + 1);
        }

        default: {
            // Namespaced custom condition (D8): resolved against plugin vocab.
            if (isNamespacedType(type)) {
                const handler = deps.vocab.condition(type);
                if (!handler) throw new Error(`unknown condition type: '${type}'`);
                const result = handler(deps.view, deps.ctx, paramsOf(condition));
                if (typeof result !== 'boolean') {
                    throw new Error(`vocab condition '${type}' must return a boolean`);
                }
                return result;
            }
            throw new Error(`unknown condition type: '${type}'`);
        }
    }
}

// ----------------------------------------------------------------------------
// Effect application (D8 closed set + namespaced extension)
// ----------------------------------------------------------------------------

export function applyEffects(effects: EffectDescriptor[], deps: InterpreterDeps): void {
    applyEffectsInternal(effects as unknown, deps, 1);
}

function applyEffectsInternal(effects: unknown, deps: InterpreterDeps, depth: number): void {
    if (depth > MAX_RULE_DEPTH) depthFault();
    if (!Array.isArray(effects)) throw new Error('effects must be an array');
    if (effects.length > MAX_RULE_LIST) {
        throw new Error(`effect list exceeds the ${MAX_RULE_LIST}-item bound`);
    }

    for (const effect of effects) {
        if (!isPlainObject(effect) || typeof effect.type !== 'string') {
            throw new Error(`malformed effect: ${JSON.stringify(effect)}`);
        }
        const type = effect.type;

        switch (type) {
            case 'strike':
                // Full attack pipeline — delegated to the engine (depth
                // guard MAX_STRIKE_DEPTH lives in the pipeline, D5a.12).
                deps.adapter.strike();
                break;

            case 'damage-flat': {
                const id = refEntityId(requireRef(effect, 'damage-flat', 'effect'), deps.ctx);
                const amount = requireNumber(effect.amount, 'damage-flat', 'effect', 'amount');
                const damageType = effect.damageType;
                if (damageType !== undefined && damageType !== null && !EFFECT_DAMAGE_TYPES.includes(damageType as string)) {
                    throw new Error(`malformed 'damage-flat' effect: invalid damageType '${String(damageType)}'`);
                }
                deps.adapter.damageFlat(id, amount, damageType as EffectDamageType | undefined);
                break;
            }

            case 'heal': {
                const id = refEntityId(requireRef(effect, 'heal', 'effect'), deps.ctx);
                const amount = requireNumber(effect.amount, 'heal', 'effect', 'amount');
                deps.adapter.heal(id, amount);
                break;
            }

            case 'apply-status': {
                const id = refEntityId(requireRef(effect, 'apply-status', 'effect'), deps.ctx);
                const status = effect.status;
                if (typeof status !== 'string' || status === '') {
                    throw new Error(`malformed 'apply-status' effect: 'status' must be a non-empty string`);
                }
                // Resistance/caps are engine-side (adapter contract) — the
                // interpreter forwards the descriptor's declared numbers.
                deps.adapter.applyStatus(
                    id,
                    status,
                    optionalNumber(effect.stacks, 'apply-status', 'effect', 'stacks'),
                    optionalNumber(effect.duration, 'apply-status', 'effect', 'duration'),
                    optionalNumber(effect.potency, 'apply-status', 'effect', 'potency'),
                );
                break;
            }

            case 'remove-status': {
                const id = refEntityId(requireRef(effect, 'remove-status', 'effect'), deps.ctx);
                const status = effect.status;
                if (typeof status !== 'string' || status === '') {
                    throw new Error(`malformed 'remove-status' effect: 'status' must be a non-empty string`);
                }
                deps.adapter.removeStatus(id, status);
                break;
            }

            case 'break-equipment': {
                const id = refEntityId(requireRef(effect, 'break-equipment', 'effect'), deps.ctx);
                const slot = effect.slot;
                if (slot !== undefined && slot !== null && !SLOTS.includes(slot as Slot)) {
                    throw new Error(`malformed 'break-equipment' effect: invalid slot '${String(slot)}'`);
                }
                deps.adapter.breakEquipment(id, (slot ?? undefined) as Slot | undefined);
                break;
            }

            case 'modify-stat': {
                const id = refEntityId(requireRef(effect, 'modify-stat', 'effect'), deps.ctx);
                const stat = effect.stat;
                if (!STAT_KEYS.includes(stat as StatKey)) {
                    throw new Error(`malformed 'modify-stat' effect: invalid stat '${String(stat)}'`);
                }
                const amount = requireNumber(effect.amount, 'modify-stat', 'effect', 'amount');
                const duration = optionalNumber(effect.duration, 'modify-stat', 'effect', 'duration');
                deps.adapter.modifyStat(id, stat as StatKey, amount, duration);
                break;
            }

            case 'emit': {
                const message = effect.message;
                if (typeof message !== 'string') {
                    throw new Error(`malformed 'emit' effect: 'message' must be a string`);
                }
                deps.adapter.emitMessage(message);
                break;
            }

            default: {
                // Namespaced custom effect (D8): handler returns descriptors
                // which are applied through THIS interpreter (recursively,
                // depth-guarded) — custom code never mutates directly.
                if (isNamespacedType(type)) {
                    const handler: VocabEffectHandler | undefined = deps.vocab.effect(type);
                    if (!handler) throw new Error(`unknown effect type: '${type}'`);
                    const expanded = handler(deps.view, deps.ctx, paramsOf(effect));
                    if (!Array.isArray(expanded)) {
                        throw new Error(`vocab effect '${type}' must return an EffectDescriptor[]`);
                    }
                    applyEffectsInternal(expanded, deps, depth + 1);
                    break;
                }
                throw new Error(`unknown effect type: '${type}'`);
            }
        }
    }
}
