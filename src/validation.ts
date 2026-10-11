// ============================================================================
// @userfiction/combat — src/validation.ts — T2 battle-definition validation
// ============================================================================
// D3 validation, reader precedent (@userfiction/reader/plugin/registry.ts
// L331–344): collect ALL errors, report them together, never fail-fast,
// never throw, never mutate the input. `validateBattleDefinition` returns the
// soft `CombatValidation { valid, errors }` for UI pre-checks (D2); the
// engine (T5) throws CombatValidationError with the same list (D2/D7).
//
// Coverage (D3 §Validation + task §10 "Invalid input" row):
//   - unknown hostile inputs: anything that is not a plain object, missing /
//     wrong-typed fields, Dates / class instances / functions in data
//     positions — every schema SITE enforces its declared JSON type, so
//     "strict JSON" holds without a separate global walk (single clean error
//     per problem, deterministic order);
//   - finite/ranged numbers: every number field must be finite (NaN/Infinity
//     rejected, D3) and inside the D13 bounds table (constants imported from
//     types.ts so messages can never drift);
//   - team agreement in BOTH directions (D3: entity.id ∈ members ⇔
//     entity.team === that team.id), ffa separation;
//   - slots/hands (D5e/D9): refs resolve to the merged catalog, slot matches
//     kind, armour occupies its declared slot, no double occupancy, hands
//     budget ≤ 2, two-handed forbids weapon-2 + shield;
//   - catalogs/abilities/rules: gear shared-field ranges (D9), ability
//     cost/cooldown/effects, declarative rules against the D8 vocabulary;
//   - interpreter bounds: condition nesting ≤ MAX_RULE_DEPTH (16), all/any/
//     not + effects lists ≤ MAX_RULE_LIST (32) (D8).
//
// Vocab registration (D8 "unknown type ⇒ validation error" vs. plugin
// `vocab` extension): the PUBLIC single-input call has no plugin knowledge,
// so namespaced 'pluginId/name' types are accepted as shape-valid data —
// honest handling of missing registration (registration is enforced at
// engine load). The engine passes `options.vocab.{conditions,effects}` —
// the exact registered namespaced ids — and unregistered namespaced types
// then become validation errors. This optional second parameter keeps the
// `ValidateBattleDefinition` contract in types.ts (extra param is optional,
// so the signature stays assignable); shared types are NOT edited.
//
// Error message format is STABLE — "the UI prints them verbatim" (T2 spec):
// `<path>: <problem>`, paths like `entities[0].stats.health`,
// `teams[1].members[0]`, `rules.contributions[0].when.of[1].p`.
//
// Zero dependencies (D14); synchronous, no timers, no DOM (D1/§3).
// ============================================================================

import {
    CHAIN_HOOK_IDS,
    COMBAT_SCHEMA_VERSION,
    DAMAGE_TYPES,
    GEAR_KINDS,
    MAX_ABILITY_COST,
    MAX_DEFENSE,
    MAX_EVASION,
    MAX_GEAR_DAMAGE,
    MAX_GEAR_DURABILITY,
    MAX_HEALTH,
    MAX_MAX_CASCADE,
    MAX_MAX_LOG_EVENTS,
    MAX_MAX_STEPS,
    MAX_PRECISION,
    MAX_RESISTANCE,
    MAX_RULE_DEPTH,
    MAX_RULE_LIST,
    MAX_SEED,
    MAX_SPEED,
    MAX_STATUS_STACKS,
    MAX_STRENGTH,
    MIN_ABILITY_COST,
    MIN_DEFENSE,
    MIN_EVASION,
    MIN_GEAR_DAMAGE,
    MIN_GEAR_DURABILITY,
    MIN_HEALTH,
    MIN_MAX_CASCADE,
    MIN_MAX_LOG_EVENTS,
    MIN_MAX_STEPS,
    MIN_PRECISION,
    MIN_RESISTANCE,
    MIN_SEED,
    MIN_SPEED,
    MIN_STATUS_DURATION,
    MIN_STATUS_POTENCY,
    MIN_STATUS_STACKS,
    MIN_STRENGTH,
    SLOTS,
    STAT_KEYS,
} from './types';
import type { CombatValidation, GearDefinition } from './types';
import { isValidId } from './ids';
import { defaultGearSeed, mergeGearCatalog } from './catalogs';

// ----------------------------------------------------------------------------
// Local closed vocabularies that types.ts carries only as TYPES (no runtime
// const arrays): Ref, StatCompareOp, EffectDamageType, BattleMode. Listed
// once here; validation messages and tests share these exact orders.
// ----------------------------------------------------------------------------

const REF_VALUES = ['attacker', 'target', 'self'] as const;
const STAT_OP_VALUES = ['lt', 'lte', 'gt', 'gte', 'eq'] as const;
const MODE_VALUES = ['ffa', 'teams'] as const;
const EFFECT_DAMAGE_TYPES = ['blunt', 'sharp', 'true'] as const;
const WEAPON_SLOTS = ['weapon-1', 'weapon-2'] as const;
const ARMOUR_SLOTS = ['head', 'body', 'hands', 'feet', 'shield'] as const;
const HAND_SLOTS = ['weapon-1', 'weapon-2', 'shield'] as const; // hands budget (D5e)
const HANDS_BUDGET = 2;                                          // D5e
const TWO_HANDED = 2;                                            // D5e handedness value

// Builtin D8 condition/effect type names (closed sets; anything else must be
// a namespaced 'pluginId/name' type — see header vocab note).
const BUILTIN_CONDITION_TYPES: readonly string[] = [
    'always', 'never', 'stat', 'has-status', 'has-gear', 'mode', 'chance', 'all', 'any', 'not',
];
const BUILTIN_EFFECT_TYPES: readonly string[] = [
    'strike', 'damage-flat', 'heal', 'apply-status', 'remove-status',
    'break-equipment', 'modify-stat', 'emit',
];

// ----------------------------------------------------------------------------
// Options (internal integration surface — see header).
// ----------------------------------------------------------------------------

export interface BattleValidationOptions {
    // Registered namespaced vocab type ids ('pluginId/name', ids.ts
    // namespaced()) from loaded plugins. When provided, namespaced types not
    // in these lists are errors; when absent (public single-input call)
    // namespaced types are accepted as shape-valid data.
    vocab?: {
        conditions?: readonly string[];
        effects?: readonly string[];
    };
}

// ----------------------------------------------------------------------------
// Primitive guards (strict-JSON stance at every site).
// ----------------------------------------------------------------------------

// Plain object = prototype Object.prototype or null; rejects arrays, Dates,
// class instances, regexes, functions — the "strict data" rule (D1/D3).
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value);

// Namespaced custom type discriminator (D8/types.ts CustomTypeId): built-in
// type strings never contain '/', so one slash ⇒ plugin vocab territory.
const isNamespacedType = (type: string): boolean => type.includes('/');

// ----------------------------------------------------------------------------
// Message builders — the stable formats pinned by validation.test.ts.
// ----------------------------------------------------------------------------

const ID_MESSAGE = (path: string): string => `${path}: must match /^[a-z0-9][a-z0-9-]*$/`;

const enumMessage = (path: string, values: readonly (string | number)[]): string =>
    `${path}: must be one of ${values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(', ')}`;

const objectMessage = (path: string): string => `${path}: expected a plain object`;

const requiredMessage = (path: string): string => `${path}: required`;

// Finite-number range: both bounds, or a single-sided floor.
const numberMessage = (path: string, min: number, max?: number): string =>
    max === undefined
        ? `${path}: must be a finite number >= ${min}`
        : `${path}: must be a finite number between ${min} and ${max}`;

// Integer range: both bounds, or a single-sided floor.
const integerMessage = (path: string, min: number, max?: number): string =>
    max === undefined
        ? `${path}: must be an integer >= ${min}`
        : `${path}: must be an integer between ${min} and ${max}`;

// ----------------------------------------------------------------------------
// Field check helpers — each pushes zero or one error (collect-all, never
// throw). `optional` fields skip when the key is absent or undefined.
// ----------------------------------------------------------------------------

const checkString = (errors: string[], path: string, value: unknown, optional = false): void => {
    if (optional && value === undefined) {
        return;
    }
    if (!isString(value)) {
        errors.push(`${path}: must be a string`);
    }
};

// max === undefined ⇒ one-sided floor (message "must be a finite number >= min")
const checkNumber = (
    errors: string[],
    path: string,
    value: unknown,
    min: number,
    max: number | undefined,
    optional = false,
): void => {
    if (optional && value === undefined) {
        return;
    }
    const upper = max === undefined ? Number.POSITIVE_INFINITY : max;
    if (!isFiniteNumber(value) || value < min || value > upper) {
        errors.push(numberMessage(path, min, max));
    }
};

const checkInteger = (
    errors: string[],
    path: string,
    value: unknown,
    min: number,
    max: number | undefined,
    optional = false,
): void => {
    if (optional && value === undefined) {
        return;
    }
    const upper = max === undefined ? Number.POSITIVE_INFINITY : max;
    if (!isInteger(value) || value < min || value > upper) {
        errors.push(integerMessage(path, min, max));
    }
};

const checkEnum = (
    errors: string[],
    path: string,
    value: unknown,
    values: readonly (string | number)[],
    optional = false,
): void => {
    if (optional && value === undefined) {
        return;
    }
    if (!values.includes(value as string | number)) {
        errors.push(enumMessage(path, values));
    }
};

const checkId = (errors: string[], path: string, value: unknown): void => {
    if (!isValidId(value)) {
        errors.push(ID_MESSAGE(path));
    }
};

// ----------------------------------------------------------------------------
// D8 condition validator (recursive, depth-bounded).
// ----------------------------------------------------------------------------

const validateCondition = (
    errors: string[],
    path: string,
    condition: unknown,
    depth: number,
    options?: BattleValidationOptions,
): void => {
    // Interpreter bound (D8): nesting ≤ MAX_RULE_DEPTH; stop descending so a
    // runaway tree yields ONE error, not one per level (collect-all noise
    // control).
    if (depth > MAX_RULE_DEPTH) {
        errors.push(`${path}: condition nesting exceeds depth ${MAX_RULE_DEPTH}`);
        return;
    }
    if (!isPlainObject(condition)) {
        errors.push(objectMessage(path));
        return;
    }
    const type = condition.type;
    if (!isString(type)) {
        errors.push(`${path}.type: must be a string`);
        return;
    }

    // Namespaced custom condition (D8 vocabulary extension): opaque params
    // (flat convention, types.ts CustomCondition); registration honesty per
    // header.
    if (!BUILTIN_CONDITION_TYPES.includes(type)) {
        if (isNamespacedType(type)) {
            const registered = options?.vocab?.conditions;
            if (registered && !registered.includes(type)) {
                errors.push(`${path}.type: unknown condition type '${type}' (no loaded plugin registers it)`);
            }
            return;
        }
        errors.push(`${path}.type: unknown condition type '${type}'`);
        return;
    }

    switch (type) {
        case 'always':
        case 'never':
            break;
        case 'stat':
            checkEnum(errors, `${path}.ref`, condition.ref, REF_VALUES);
            checkEnum(errors, `${path}.stat`, condition.stat, STAT_KEYS);
            checkEnum(errors, `${path}.op`, condition.op, STAT_OP_VALUES);
            if (!isFiniteNumber(condition.value)) {
                errors.push(`${path}.value: must be a finite number`);
            }
            break;
        case 'has-status':
            checkEnum(errors, `${path}.ref`, condition.ref, REF_VALUES);
            checkId(errors, `${path}.status`, condition.status);
            break;
        case 'has-gear':
            checkEnum(errors, `${path}.ref`, condition.ref, REF_VALUES);
            checkEnum(errors, `${path}.kind`, condition.kind, GEAR_KINDS, true);
            checkEnum(errors, `${path}.slot`, condition.slot, SLOTS, true);
            break;
        case 'mode':
            checkEnum(errors, `${path}.is`, condition.is, MODE_VALUES);
            break;
        case 'chance':
            // p is a probability — 0..1 finite (D8; consumes shared RNG, D4g)
            checkNumber(errors, `${path}.p`, condition.p, MIN_RESISTANCE, MAX_RESISTANCE);
            break;
        case 'all':
        case 'any':
            validateConditionList(errors, `${path}.of`, condition.of, depth, options);
            break;
        case 'not':
            validateCondition(errors, `${path}.of`, condition.of, depth + 1, options);
            break;
        default:
            // unreachable: BUILTIN_CONDITION_TYPES is the switch domain
            break;
    }
};

// all/any `of` list — bounded by MAX_RULE_LIST (D8 lists ≤ 32).
const validateConditionList = (
    errors: string[],
    path: string,
    list: unknown,
    depth: number,
    options?: BattleValidationOptions,
): void => {
    if (!Array.isArray(list)) {
        errors.push(`${path}: must be an array of at most ${MAX_RULE_LIST} conditions`);
        return;
    }
    if (list.length > MAX_RULE_LIST) {
        errors.push(`${path}: must be an array of at most ${MAX_RULE_LIST} conditions`);
        return; // one cap error, not one per element
    }
    list.forEach((item, index) => {
        validateCondition(errors, `${path}[${index}]`, item, depth + 1, options);
    });
};

// ----------------------------------------------------------------------------
// D8 effect validator.
// ----------------------------------------------------------------------------

const validateEffect = (
    errors: string[],
    path: string,
    effect: unknown,
    options?: BattleValidationOptions,
): void => {
    if (!isPlainObject(effect)) {
        errors.push(objectMessage(path));
        return;
    }
    const type = effect.type;
    if (!isString(type)) {
        errors.push(`${path}.type: must be a string`);
        return;
    }

    // Namespaced custom effect (D8) — same registration honesty as conditions
    if (!BUILTIN_EFFECT_TYPES.includes(type)) {
        if (isNamespacedType(type)) {
            const registered = options?.vocab?.effects;
            if (registered && !registered.includes(type)) {
                errors.push(`${path}.type: unknown effect type '${type}' (no loaded plugin registers it)`);
            }
            return;
        }
        errors.push(`${path}.type: unknown effect type '${type}'`);
        return;
    }

    switch (type) {
        case 'strike':
            // full pipeline attack; recursion depth is a RUNTIME guard (D5a.12)
            break;
        case 'damage-flat':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            // amount ≥ 0: a negative flat damage is data noise, not a heal
            // (heal is its own effect, D8); finite required (D3)
            checkNumber(errors, `${path}.amount`, effect.amount, 0, undefined);
            checkEnum(errors, `${path}.damageType`, effect.damageType, EFFECT_DAMAGE_TYPES, true);
            break;
        case 'heal':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            checkNumber(errors, `${path}.amount`, effect.amount, 0, undefined);
            break;
        case 'apply-status':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            checkId(errors, `${path}.status`, effect.status);
            // ranges mirror the D3 status-instance rules + D13 caps so an
            // effect can never mint an out-of-bounds instance at runtime
            checkInteger(errors, `${path}.stacks`, effect.stacks, MIN_STATUS_STACKS, MAX_STATUS_STACKS, true);
            checkInteger(errors, `${path}.duration`, effect.duration, MIN_STATUS_DURATION, undefined, true);
            checkInteger(errors, `${path}.potency`, effect.potency, MIN_STATUS_POTENCY, undefined, true);
            break;
        case 'remove-status':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            checkId(errors, `${path}.status`, effect.status);
            break;
        case 'break-equipment':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            checkEnum(errors, `${path}.slot`, effect.slot, SLOTS, true);
            break;
        case 'modify-stat':
            checkEnum(errors, `${path}.target`, effect.target, REF_VALUES);
            checkEnum(errors, `${path}.stat`, effect.stat, STAT_KEYS);
            // amount may be negative (debuffs, D8); duration counts the
            // TARGET's scheduled turns (D5c) — 0..∞ integer, ≥ 0 because a
            // negative duration is meaningless bookkeeping
            if (!isFiniteNumber(effect.amount)) {
                errors.push(`${path}.amount: must be a finite number`);
            }
            checkInteger(errors, `${path}.duration`, effect.duration, 0, undefined, true);
            break;
        case 'emit':
            checkString(errors, `${path}.message`, effect.message);
            break;
        default:
            // unreachable: BUILTIN_EFFECT_TYPES is the switch domain
            break;
    }
};

// effects list — required array bounded by MAX_RULE_LIST (D8 lists ≤ 32).
const validateEffectList = (
    errors: string[],
    path: string,
    list: unknown,
    options?: BattleValidationOptions,
    required = true,
): void => {
    if (list === undefined) {
        if (required) {
            errors.push(requiredMessage(path));
        }
        return;
    }
    if (!Array.isArray(list) || list.length > MAX_RULE_LIST) {
        errors.push(`${path}: must be an array of at most ${MAX_RULE_LIST} effects`);
        return;
    }
    list.forEach((item, index) => {
        validateEffect(errors, `${path}[${index}]`, item, options);
    });
};

// ----------------------------------------------------------------------------
// Catalog validation (D9) — gear entries PATCH over defaultGearSeed by id
// (D9/D3 "PATCH over the builtin seed by id"): a known id may be a partial
// patch (only provided fields validated); a NEW id must be a complete
// definition (no defaults exist for gear — see catalogs.ts header). Cross-
// field slot/kind/handedness rules run against the FOLDED effective entry so
// a patch that breaks an invariant is caught at the patching entry.
// ----------------------------------------------------------------------------

const validateGearCatalog = (
    errors: string[],
    gear: unknown,
): void => {
    if (gear === undefined) {
        return;
    }
    if (!Array.isArray(gear)) {
        errors.push('catalogs.gear: must be an array');
        return;
    }

    // Running fold for known-id detection + effective cross-field checks
    const fold = new Map<string, Record<string, unknown>>();
    defaultGearSeed.forEach((definition) => fold.set(definition.id, { ...definition }));

    gear.forEach((entry, index) => {
        const path = `catalogs.gear[${index}]`;
        if (!isPlainObject(entry)) {
            errors.push(objectMessage(path));
            return;
        }

        checkId(errors, `${path}.id`, entry.id);
        const id = isString(entry.id) ? entry.id : undefined;
        const known = id !== undefined && fold.has(id);

        // Field presence: required only for NEW ids (patches may omit fields)
        const provided = (key: string): boolean => entry[key] !== undefined;
        (['kind', 'slot', 'handedness', 'type', 'damage', 'blunt', 'sharp', 'durability'] as const).forEach((key) => {
            if (!known && !provided(key)) {
                errors.push(requiredMessage(`${path}.${key}`));
            }
        });

        // Field ranges on PROVIDED values (D3/D9/D13)
        checkEnum(errors, `${path}.kind`, entry.kind, GEAR_KINDS, true);
        checkEnum(errors, `${path}.slot`, entry.slot, SLOTS, true);
        checkEnum(errors, `${path}.handedness`, entry.handedness, [0, 1, 2], true);
        checkEnum(errors, `${path}.type`, entry.type, DAMAGE_TYPES, true);
        checkNumber(errors, `${path}.damage`, entry.damage, MIN_GEAR_DAMAGE, MAX_GEAR_DAMAGE, true);
        checkNumber(errors, `${path}.blunt`, entry.blunt, MIN_RESISTANCE, MAX_RESISTANCE, true);
        checkNumber(errors, `${path}.sharp`, entry.sharp, MIN_RESISTANCE, MAX_RESISTANCE, true);
        checkInteger(errors, `${path}.durability`, entry.durability, MIN_GEAR_DURABILITY, MAX_GEAR_DURABILITY, true);

        // Fold this patch (undefined never erases — catalogs.ts semantics)
        if (id !== undefined) {
            const current = fold.get(id) ?? {};
            const merged: Record<string, unknown> = { ...current };
            Object.entries(entry).forEach(([key, value]) => {
                if (value !== undefined) {
                    merged[key] = value;
                }
            });
            fold.set(id, merged);

            // Cross-field rules on the EFFECTIVE entry (D9 kind→slot mapping,
            // D5e shield/armour handedness). Only when kind+slot are known.
            const kind = merged.kind;
            const slot = merged.slot;
            const handedness = merged.handedness;
            if (kind === 'weapon' && isString(slot) && !WEAPON_SLOTS.includes(slot as (typeof WEAPON_SLOTS)[number])) {
                errors.push(`${path}.slot: weapon gear must use 'weapon-1' or 'weapon-2'`);
            }
            if (kind === 'armour' && isString(slot) && !ARMOUR_SLOTS.includes(slot as (typeof ARMOUR_SLOTS)[number])) {
                errors.push(`${path}.slot: armour gear must use 'head', 'body', 'hands', 'feet' or 'shield'`);
            }
            if (kind === 'armour' && slot === 'shield' && handedness !== 1) {
                errors.push(`${path}.handedness: shield gear must have handedness 1`);
            }
            if (
                kind === 'armour' &&
                isString(slot) &&
                (slot === 'head' || slot === 'body' || slot === 'hands' || slot === 'feet') &&
                handedness !== 0
            ) {
                errors.push(`${path}.handedness: armour gear in slot '${slot}' must have handedness 0`);
            }
        }
    });
};

const validateAbilityCatalog = (
    errors: string[],
    abilities: unknown,
    options?: BattleValidationOptions,
): void => {
    if (abilities === undefined) {
        return;
    }
    if (!Array.isArray(abilities)) {
        errors.push('catalogs.abilities: must be an array');
        return;
    }

    // No builtin ability seed exists (D9) — patch semantics apply only among
    // listed entries (later patches earlier by id).
    const known = new Set<string>();

    abilities.forEach((entry, index) => {
        const path = `catalogs.abilities[${index}]`;
        if (!isPlainObject(entry)) {
            errors.push(objectMessage(path));
            return;
        }
        checkId(errors, `${path}.id`, entry.id);
        const id = isString(entry.id) ? entry.id : undefined;
        const isNew = id !== undefined && !known.has(id);
        if (id !== undefined) {
            known.add(id);
        }

        checkString(errors, `${path}.name`, entry.name, true);
        // cost default 1, validated 0.25..10 (D4b/D13); cooldown default 0,
        // integer turns in the actor's own schedule (D9)
        checkNumber(errors, `${path}.cost`, entry.cost, MIN_ABILITY_COST, MAX_ABILITY_COST, true);
        checkInteger(errors, `${path}.cooldown`, entry.cooldown, 0, undefined, true);
        if (entry.conditions !== undefined) {
            validateCondition(errors, `${path}.conditions`, entry.conditions, 1, options);
        }
        // effects required for new ids; a patch may omit them (stored
        // effects carry over)
        validateEffectList(errors, `${path}.effects`, entry.effects, options, isNew);
    });
};

// ----------------------------------------------------------------------------
// Entity validation (D3) — stats, statuses, equipment, abilities,
// resistances. Team agreement runs separately (needs both sides).
// ----------------------------------------------------------------------------

const validateStats = (errors: string[], path: string, stats: unknown): void => {
    if (!isPlainObject(stats)) {
        errors.push(objectMessage(path));
        return;
    }
    // health integer 1..100 000; strength/speed finite ranges; optionals
    // default 0 but validated when present (D3/D13)
    checkInteger(errors, `${path}.health`, stats.health, MIN_HEALTH, MAX_HEALTH);
    checkNumber(errors, `${path}.strength`, stats.strength, MIN_STRENGTH, MAX_STRENGTH);
    checkNumber(errors, `${path}.speed`, stats.speed, MIN_SPEED, MAX_SPEED);
    checkNumber(errors, `${path}.defense`, stats.defense, MIN_DEFENSE, MAX_DEFENSE, true);
    checkNumber(errors, `${path}.precision`, stats.precision, MIN_PRECISION, MAX_PRECISION, true);
    checkNumber(errors, `${path}.evasion`, stats.evasion, MIN_EVASION, MAX_EVASION, true);
};

const validateStatusInstances = (errors: string[], path: string, statuses: unknown): void => {
    if (statuses === undefined) {
        return;
    }
    if (!Array.isArray(statuses)) {
        errors.push(`${path}: must be an array`);
        return;
    }
    statuses.forEach((entry, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isPlainObject(entry)) {
            errors.push(objectMessage(itemPath));
            return;
        }
        // status ids are an OPEN set validated by pattern only (D5f)
        checkId(errors, `${itemPath}.id`, entry.id);
        // stacks integer 1..9 (default 1), duration integer ≥ 1, potency
        // integer ≥ 1 (default 1) — D3 + D13 caps
        checkInteger(errors, `${itemPath}.stacks`, entry.stacks, MIN_STATUS_STACKS, MAX_STATUS_STACKS, true);
        checkInteger(errors, `${itemPath}.duration`, entry.duration, MIN_STATUS_DURATION, undefined, true);
        checkInteger(errors, `${itemPath}.potency`, entry.potency, MIN_STATUS_POTENCY, undefined, true);
    });
};

// One entity's equipment loadout against the merged gear catalog (D3/D5e/D9).
const validateEquipment = (
    errors: string[],
    path: string,
    equipment: unknown,
    gearById: Map<string, GearDefinition>,
): void => {
    if (equipment === undefined) {
        return;
    }
    if (!isPlainObject(equipment)) {
        errors.push(objectMessage(path));
        return;
    }

    // Collect resolved refs first: slot occupancy + handedness need BOTH
    // arrays together (weapons and armour share the slot space, D5e).
    const placements: { slot?: string; gearId?: string; handedness?: number }[] = [];

    (['weapons', 'armour'] as const).forEach((group) => {
        const list = equipment[group];
        if (list === undefined) {
            return;
        }
        const groupPath = `${path}.${group}`;
        if (!Array.isArray(list)) {
            errors.push(`${groupPath}: must be an array`);
            return;
        }
        list.forEach((ref, index) => {
            const refPath = `${groupPath}[${index}]`;
            if (!isPlainObject(ref)) {
                errors.push(objectMessage(refPath));
                return;
            }
            checkString(errors, `${refPath}.id`, ref.id);
            checkEnum(errors, `${refPath}.slot`, ref.slot, SLOTS);
            // GearRef.durability overrides the catalog value for this
            // instance — same integer range as catalog durability (D9)
            checkInteger(errors, `${refPath}.durability`, ref.durability, MIN_GEAR_DURABILITY, MAX_GEAR_DURABILITY, true);

            const gearId = isString(ref.id) ? ref.id : undefined;
            const slot = isString(ref.slot) ? ref.slot : undefined;
            const gear = gearId !== undefined ? gearById.get(gearId) : undefined;
            if (gearId !== undefined && !gear) {
                errors.push(`${refPath}.id: unknown gear id '${gearId}'`);
            }

            let handedness: number | undefined;
            if (gear) {
                // slot/kind agreement (D9 "slot must match the gear's
                // kind/slot rules"): weapons may sit in either weapon slot
                // (handedness budget governs, D5e); armour must occupy the
                // slot its definition declares (a helm goes on the head).
                if (gear.kind === 'weapon' && slot !== undefined && !WEAPON_SLOTS.includes(slot as (typeof WEAPON_SLOTS)[number])) {
                    errors.push(`${refPath}.slot: gear '${gearId}' is a weapon and must go in 'weapon-1' or 'weapon-2'`);
                }
                if (gear.kind === 'armour' && slot !== undefined && slot !== gear.slot) {
                    errors.push(`${refPath}.slot: gear '${gearId}' occupies slot '${gear.slot}', not '${slot}'`);
                }
                handedness = typeof gear.handedness === 'number' ? gear.handedness : undefined;
            }
            placements.push({ slot, gearId, handedness });
        });
    });

    // Slot occupancy: one piece per slot (D5e slot space)
    const bySlot = new Map<string, string[]>();
    placements.forEach((placement) => {
        if (placement.slot === undefined) {
            return;
        }
        const occupants = bySlot.get(placement.slot) ?? [];
        occupants.push(placement.gearId ?? '?');
        bySlot.set(placement.slot, occupants);
    });
    bySlot.forEach((occupants, slot) => {
        if (occupants.length > 1) {
            errors.push(`${path}: slot '${slot}' occupied by both '${occupants[0]}' and '${occupants[1]}'`);
        }
    });

    // Hands budget (D5e): handedness of weapon-1 + weapon-2 + shield ≤ 2
    let handsUsed = 0;
    placements.forEach((placement) => {
        if (placement.slot !== undefined && HAND_SLOTS.includes(placement.slot as (typeof HAND_SLOTS)[number])) {
            handsUsed += placement.handedness ?? 0;
        }
    });
    if (handsUsed > HANDS_BUDGET) {
        errors.push(`${path}: hands budget exceeded (${handsUsed} > ${HANDS_BUDGET})`);
    }

    // Two-handed rule (D5e): a handedness-2 item in a weapon slot forbids
    // occupants in weapon-2 and shield
    const twoHanded = placements.find(
        (placement) =>
            placement.handedness === TWO_HANDED &&
            (placement.slot === 'weapon-1' || placement.slot === 'weapon-2'),
    );
    if (twoHanded !== undefined && twoHanded.gearId !== undefined) {
        const conflict = placements.some(
            (placement) =>
                placement !== twoHanded &&
                (placement.slot === 'weapon-2' || placement.slot === 'shield'),
        );
        if (conflict) {
            errors.push(`${path}: two-handed gear '${twoHanded.gearId}' forbids 'weapon-2' and 'shield' occupants`);
        }
    }
};

const validateEntity = (
    errors: string[],
    path: string,
    entity: unknown,
    gearById: Map<string, GearDefinition>,
    abilityIds: Set<string>,
): void => {
    if (!isPlainObject(entity)) {
        errors.push(objectMessage(path));
        return;
    }
    checkId(errors, `${path}.id`, entity.id);
    checkString(errors, `${path}.name`, entity.name, true);
    validateStats(errors, `${path}.stats`, entity.stats);
    validateStatusInstances(errors, `${path}.statuses`, entity.statuses);
    validateEquipment(errors, `${path}.equipment`, entity.equipment, gearById);

    // abilities: strings resolving to the (client-only) ability catalog (D9)
    if (entity.abilities !== undefined) {
        if (!Array.isArray(entity.abilities)) {
            errors.push(`${path}.abilities: must be an array`);
        } else {
            entity.abilities.forEach((abilityId, index) => {
                const itemPath = `${path}.abilities[${index}]`;
                checkId(errors, itemPath, abilityId);
                if (isString(abilityId) && !abilityIds.has(abilityId)) {
                    errors.push(`${itemPath}: unknown ability id '${abilityId}'`);
                }
            });
        }
    }

    // statusResistances: statusId → 0..1 fraction (D5e); keys follow the
    // open-set id pattern (D5f)
    if (entity.statusResistances !== undefined) {
        if (!isPlainObject(entity.statusResistances)) {
            errors.push(objectMessage(`${path}.statusResistances`));
        } else {
            Object.entries(entity.statusResistances).forEach(([key, value]) => {
                if (!isValidId(key)) {
                    errors.push(`${path}.statusResistances['${key}']: key must match /^[a-z0-9][a-z0-9-]*$/`);
                }
                checkNumber(errors, `${path}.statusResistances['${key}']`, value, MIN_RESISTANCE, MAX_RESISTANCE);
            });
        }
    }
};

// ----------------------------------------------------------------------------
// Team agreement (D3) — run AFTER entities so both sides are known. Checks
// in BOTH directions: entity→team and team→members.
// ----------------------------------------------------------------------------

const validateTeamAgreement = (
    errors: string[],
    mode: unknown,
    teams: unknown,
    entities: readonly Record<string, unknown>[],
): void => {
    if (mode === 'ffa') {
        // ffa: teams absent/empty AND no entity.team (D3)
        if (teams !== undefined && (!Array.isArray(teams) || teams.length > 0)) {
            errors.push('teams: ffa mode must not declare teams');
        }
        entities.forEach((entity, index) => {
            if (entity.team !== undefined) {
                errors.push(`entities[${index}].team: ffa mode forbids entity.team`);
            }
        });
        return;
    }
    if (mode !== 'teams') {
        return; // invalid mode already reported; agreement checks are moot
    }

    // teams mode: ≥2 teams (empty member lists are VALID data → no-enemies
    // outcome, D3/D5g)
    if (!Array.isArray(teams)) {
        errors.push('teams: teams mode requires at least 2 teams');
        return;
    }
    if (teams.length < 2) {
        errors.push('teams: teams mode requires at least 2 teams');
    }

    const entityIds = new Set<string>();
    entities.forEach((entity) => {
        if (isValidId(entity.id)) {
            entityIds.add(entity.id as string);
        }
    });

    // Team declarations: id pattern + uniqueness, members well-formed
    const teamIds = new Set<string>();
    const teamMembers = new Map<string, string[]>();
    teams.forEach((team, index) => {
        const path = `teams[${index}]`;
        if (!isPlainObject(team)) {
            errors.push(objectMessage(path));
            return;
        }
        checkId(errors, `${path}.id`, team.id);
        checkString(errors, `${path}.name`, team.name, true);
        const teamId = isString(team.id) ? team.id : undefined;
        if (teamId !== undefined) {
            if (teamIds.has(teamId)) {
                errors.push(`${path}.id: duplicate team id '${teamId}'`);
            }
            teamIds.add(teamId);
        }
        if (team.members === undefined || !Array.isArray(team.members)) {
            errors.push(`${path}.members: must be an array`);
            return;
        }
        const members: string[] = [];
        const seen = new Set<string>();
        team.members.forEach((member, memberIndex) => {
            const memberPath = `${path}.members[${memberIndex}]`;
            if (!isString(member)) {
                errors.push(`${memberPath}: must be a string`);
                return;
            }
            if (!entityIds.has(member)) {
                errors.push(`${memberPath}: unknown entity id '${member}'`);
            }
            if (seen.has(member)) {
                errors.push(`${memberPath}: duplicate member id '${member}'`);
            }
            seen.add(member);
            members.push(member);
        });
        if (teamId !== undefined) {
            teamMembers.set(teamId, members);
        }
    });

    // entity → team direction: set, known, and listed by that team
    entities.forEach((entity, index) => {
        const path = `entities[${index}].team`;
        const entityId = isString(entity.id) ? entity.id : `#${index}`;
        if (entity.team === undefined) {
            errors.push(`${path}: teams mode requires entity '${entityId}' to declare a team`);
            return;
        }
        if (!isString(entity.team)) {
            errors.push(`${path}: must be a string`);
            return;
        }
        if (!teamIds.has(entity.team)) {
            errors.push(`${path}: unknown team id '${entity.team}'`);
            return;
        }
        const members = teamMembers.get(entity.team) ?? [];
        if (isString(entity.id) && !members.includes(entity.id)) {
            errors.push(`${path}: team '${entity.team}' does not list entity '${entityId}' in members`);
        }
    });

    // team → members direction: a listed member must point back at THIS team
    // (only when the entity declared SOME team — an undeclared team already
    // produced the entity-side error above, no double noise)
    teams.forEach((team, index) => {
        if (!isPlainObject(team) || !isString(team.id) || !Array.isArray(team.members)) {
            return;
        }
        team.members.forEach((member, memberIndex) => {
            if (!isString(member)) {
                return;
            }
            const entity = entities.find((candidate) => candidate.id === member);
            if (entity !== undefined && isString(entity.team) && entity.team !== team.id) {
                errors.push(
                    `teams[${index}].members[${memberIndex}]: entity '${member}' declares team '${entity.team}' not '${team.id}'`,
                );
            }
        });
    });
};

// ----------------------------------------------------------------------------
// startingConditions + rules (D3/D8)
// ----------------------------------------------------------------------------

const validateStartingConditions = (errors: string[], startingConditions: unknown): void => {
    if (startingConditions === undefined) {
        return;
    }
    if (!isPlainObject(startingConditions)) {
        errors.push(objectMessage('startingConditions'));
        return;
    }
    // seed integer 0..2^32−1 (D3/D4g/D13)
    checkInteger(errors, 'startingConditions.seed', startingConditions.seed, MIN_SEED, MAX_SEED, true);

    if (startingConditions.config !== undefined) {
        if (!isPlainObject(startingConditions.config)) {
            errors.push(objectMessage('startingConditions.config'));
        } else {
            const config = startingConditions.config;
            // run limits per D3/D13: maxSteps 1..1e6, maxCascade 1..100k,
            // maxLogEvents 1..1e6
            checkInteger(errors, 'startingConditions.config.maxSteps', config.maxSteps, MIN_MAX_STEPS, MAX_MAX_STEPS, true);
            checkInteger(errors, 'startingConditions.config.maxCascade', config.maxCascade, MIN_MAX_CASCADE, MAX_MAX_CASCADE, true);
            checkInteger(errors, 'startingConditions.config.maxLogEvents', config.maxLogEvents, MIN_MAX_LOG_EVENTS, MAX_MAX_LOG_EVENTS, true);
        }
    }
};

const validateRules = (
    errors: string[],
    rules: unknown,
    options?: BattleValidationOptions,
): void => {
    if (rules === undefined) {
        return;
    }
    if (!isPlainObject(rules)) {
        errors.push(objectMessage('rules'));
        return;
    }
    const contributions = rules.contributions;
    if (contributions === undefined) {
        return;
    }
    if (!Array.isArray(contributions)) {
        errors.push('rules.contributions: must be an array');
        return;
    }

    const seenRuleIds = new Set<string>();
    contributions.forEach((rule, index) => {
        const path = `rules.contributions[${index}]`;
        if (!isPlainObject(rule)) {
            errors.push(objectMessage(path));
            return;
        }
        checkId(errors, `${path}.id`, rule.id);
        if (isString(rule.id)) {
            if (seenRuleIds.has(rule.id)) {
                errors.push(`${path}.id: duplicate rule id '${rule.id}'`);
            }
            seenRuleIds.add(rule.id);
        }
        // D3/D6: rule hook ids must be CHAIN-mode hooks — single-mode hooks
        // have exactly one handler, contributions cannot claim them
        checkEnum(errors, `${path}.hook`, rule.hook, CHAIN_HOOK_IDS);
        if (rule.when !== undefined) {
            validateCondition(errors, `${path}.when`, rule.when, 1, options);
        }
        validateEffectList(errors, `${path}.effects`, rule.effects, options, true);
    });
};

// ----------------------------------------------------------------------------
// Public entrypoint (D2). Signature note for T5/engine integration:
//
//   validateBattleDefinition(input: unknown, options?: BattleValidationOptions): CombatValidation
//   BattleValidationOptions { vocab?: { conditions?: readonly string[]; effects?: readonly string[] } }
//
// The single-input public form satisfies ValidateBattleDefinition (types.ts
// L793); the engine passes registered vocab ids so D8's "unknown type ⇒
// validation error" holds with plugins loaded. Never throws, never mutates
// the input, collects ALL errors in deterministic field order.
// ----------------------------------------------------------------------------

export const validateBattleDefinition = (
    input: unknown,
    options?: BattleValidationOptions,
): CombatValidation => {
    const errors: string[] = [];

    // Hostile top-level input: one error, nothing else to check
    if (!isPlainObject(input)) {
        errors.push('definition: expected a plain object');
        return { valid: false, errors };
    }

    // schemaVersion gate (D3; reader schemaVersion-gate precedent)
    if (input.schemaVersion !== COMBAT_SCHEMA_VERSION) {
        errors.push(`schemaVersion: must be ${COMBAT_SCHEMA_VERSION}`);
    }
    checkString(errors, 'name', input.name, true);
    checkEnum(errors, 'mode', input.mode, MODE_VALUES);

    // entities (D3: ≥2, ids unique + pattern) — structural gate first so
    // per-entity checks only run on real objects
    const entities: Record<string, unknown>[] = [];
    if (!Array.isArray(input.entities) || input.entities.length < 2) {
        errors.push('entities: must be an array of at least 2 entities');
        if (Array.isArray(input.entities)) {
            entities.push(...(input.entities as Record<string, unknown>[]));
        }
    } else {
        entities.push(...(input.entities as Record<string, unknown>[]));
    }

    // Effective catalogs BEFORE entity checks: equipment refs resolve against
    // the MERGED gear catalog — the builtin seed is ALWAYS the base, with or
    // without a client catalogs section (D9) — and ability ids against the
    // client ability list. Type errors on the sections are reported once,
    // later, by the catalog validators (no double noise).
    const catalogsObject = input.catalogs !== undefined && isPlainObject(input.catalogs)
        ? input.catalogs
        : undefined;
    if (input.catalogs !== undefined && catalogsObject === undefined) {
        errors.push(objectMessage('catalogs'));
    }
    const merged = mergeGearCatalog(
        defaultGearSeed,
        catalogsObject && Array.isArray(catalogsObject.gear) ? catalogsObject.gear : undefined,
    );
    const gearById = new Map(merged.map((definition) => [definition.id, definition]));
    const abilityIds = new Set(
        catalogsObject && Array.isArray(catalogsObject.abilities)
            ? (catalogsObject.abilities as unknown[])
                .filter(isPlainObject)
                .map((entry) => entry.id)
                .filter(isString)
            : [],
    );

    // Per-entity field checks + duplicate id detection
    const seenEntityIds = new Set<string>();
    entities.forEach((entity, index) => {
        validateEntity(errors, `entities[${index}]`, entity, gearById, abilityIds);
        if (isPlainObject(entity) && isValidId(entity.id)) {
            const id = entity.id as string;
            if (seenEntityIds.has(id)) {
                errors.push(`entities[${index}].id: duplicate entity id '${id}'`);
            }
            seenEntityIds.add(id);
        }
    });

    // Team agreement (both directions) / ffa separation — needs entity data.
    // teams[] field checks (id/name/members) run inside the same pass.
    const cleanEntities = entities.filter(isPlainObject);
    validateTeamAgreement(errors, input.mode, input.teams, cleanEntities);

    // catalogs section content validation (D9 shared fields, patch rules)
    if (isPlainObject(input.catalogs)) {
        validateGearCatalog(errors, input.catalogs.gear);
        validateAbilityCatalog(errors, input.catalogs.abilities, options);
    }

    validateStartingConditions(errors, input.startingConditions);
    validateRules(errors, input.rules, options);

    return { valid: errors.length === 0, errors };
};

// Internal alias so T5 can import the typed function without widening the
// shared ValidateBattleDefinition contract (documented in the report).
export type ValidateBattleDefinitionWithOptions = (
    input: unknown,
    options?: BattleValidationOptions,
) => CombatValidation;
