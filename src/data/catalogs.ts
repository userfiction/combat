// ============================================================================
// @userfiction/combat — src/data/catalogs.ts — T2 gear catalog + definition resolve
// ============================================================================
// D9: ONE shared GearDefinition field set for weapons AND armour (R4). The
// catalog follows the @userfiction/core/item/item-registry.ts L92–148
// precedent exactly:
//   - createGearCatalog({ seed }) COPIES the seed list in — the caller's
//     array and entries are never the live storage (item-registry L96–99);
//   - define() PATCHes by id: a known id keeps its existing fields and only
//     PROVIDED (non-undefined) fields overwrite — `undefined` never erases
//     (item-registry L103–124); an unknown id is stored as given. Gear has no
//     sensible per-field defaults to fill (contrast ItemSpec), so completeness
//     for NEW ids is enforced by validation.ts instead of default-filling —
//     a documented, deliberate divergence from the item registry;
//   - every read (definitionOf / all / define result) returns a COPY —
//     GearDefinition is flat plain data, so a shallow spread IS a deep copy;
//   - Map insertion order keeps all() listing deterministic: seed order
//     first, then new ids in first-listed order (Map.set overwrites in place).
//
// resolveBattleDefinition (integration helper for T5/engine): produces the
// D10 "resolved copy (catalogs merged)" that snapshots and Simulation
// .definition must carry. Stat defaults (StatBlock resolution) are NOT done
// here — the engine's state builder (T4/T5) owns that; this module only
// merges the gear catalog over defaultGearSeed by id (D9 patch semantics).
//
// Zero dependencies (D14); synchronous, no timers, no DOM (D1/§3).
// ============================================================================

import type {
    BattleDefinition,
    BodyPart,
    EntityResourcesInput,
    GearDefinition,
    ResourceCostInput,
    StatusDefinition,
} from '../contract/types';
import { BODY_PARTS } from '../contract/types';

// ----------------------------------------------------------------------------
// Builtin status-definition seed (T2 R1). Registered defaults the turn
// engine consults (rules.ts select/turn-end consult the resolved registry).
// The LEGACY trio ids (fear/poison/stun) are deliberately ABSENT: their
// hardcoded D5c semantics stay exact while no client definition overrides
// them; defining one of those ids in catalogs.statuses deliberately replaces
// the legacy behavior with the generic definition path. Aliases
// (fearful/poisoned) mirror the legacy behavior under NEW ids through the
// generic path. All entries mirror legacy formulas where aliases exist:
//   fearful  ≙ fear (stacks decay, 0.25 skip per stack)
//   poisoned ≙ poison at default potency (1 damage × stacks per turn)
// ----------------------------------------------------------------------------
export const defaultStatusSeed: readonly StatusDefinition[] = [
    { id: 'fearful', name: 'Fearful', decay: 'stacks', skipChancePerStack: 0.25 },
    { id: 'poisoned', name: 'Poisoned', decay: 'duration', tick: { damage: 1 } },
    { id: 'bleeding', name: 'Bleeding', decay: 'duration', tick: { damage: 2 } },
    { id: 'burned', name: 'Burned', decay: 'duration', tick: { damage: 3 } },
    { id: 'blinded', name: 'Blinded', decay: 'duration', modifiers: { precision: -2 } },
    // Beneficial defaults (buffs): positive per-stack modifiers that vanish
    // on removal/expiry — the demonstration pairs for the negative set.
    { id: 'blessed', name: 'Blessed', decay: 'duration', modifiers: { defense: 2, evasion: 1 } },
    { id: 'hasted', name: 'Hasted', decay: 'duration', modifiers: { speed: 1 } },
];

// ----------------------------------------------------------------------------
// Builtin gear seed (D9: "exact seed fixed in catalogs.ts and pinned by
// test"). Entries mirror the D9 example list: rusted-dagger sharp 3,
// iron-mace blunt 5 1h, great-axe sharp 8 2h, buckler shield 1h,
// padded-vest, iron-helm. All six shared fields are present on every entry
// (D9 shared-field contract); `type`/`damage` on armour are inert in v1
// defaults but carried for the shared contract and future plugins (D9).
// ----------------------------------------------------------------------------

export const defaultGearSeed: readonly GearDefinition[] = [
    {
        id: 'rusted-dagger', name: 'Rusted Dagger', kind: 'weapon', slot: 'weapon-1',
        handedness: 1, type: 'sharp', damage: 3, blunt: 0, sharp: 0, durability: 8,
    },
    {
        id: 'iron-mace', name: 'Iron Mace', kind: 'weapon', slot: 'weapon-1',
        handedness: 1, type: 'blunt', damage: 5, blunt: 0, sharp: 0, durability: 10,
    },
    {
        id: 'great-axe', name: 'Great Axe', kind: 'weapon', slot: 'weapon-1',
        handedness: 2, type: 'sharp', damage: 8, blunt: 0, sharp: 0, durability: 10,
    },
    // Shield = armour kind in slot 'shield' with handedness 1 (D5e).
    {
        id: 'buckler', name: 'Buckler', kind: 'armour', slot: 'shield',
        handedness: 1, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.1, durability: 6,
    },
    {
        id: 'padded-vest', name: 'Padded Vest', kind: 'armour', slot: 'body',
        handedness: 0, type: 'sharp', damage: 0, blunt: 0.2, sharp: 0.1, durability: 10,
    },
    {
        id: 'iron-helm', name: 'Iron Helm', kind: 'armour', slot: 'head',
        handedness: 0, type: 'sharp', damage: 0, blunt: 0.1, sharp: 0.2, durability: 8,
    },
];

// ----------------------------------------------------------------------------
// Registry surface (D9: define / definitionOf / has / all / count / remove /
// clear — the item-registry method set, framework-free plain data).
// ----------------------------------------------------------------------------

// Patch spec for define(): id required, every other field optional. A known
// id merges; an unknown id is stored as given (see header divergence note —
// validation.ts enforces completeness for new ids at the definition level).
export type GearPatch = { id: string } & Partial<Omit<GearDefinition, 'id'>>;

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

// Plain-object guard (strict-JSON stance): prototype must be Object.prototype
// or null so Dates / class instances / regexes are NOT treated as data.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// ----------------------------------------------------------------------------
// createGearCatalog — seed/patch/copy-on-read factory (D9, item-registry
// L92–148 precedent).
// ----------------------------------------------------------------------------

export const createGearCatalog = (options: { seed?: readonly GearDefinition[] } = {}): GearCatalog => {
    // Definitions by id — Map keeps listing order for all() stability
    const definitions = new Map<string, GearDefinition>();

    // Seed copied in: the caller's array and entry objects are never stored
    // (item-registry L96–99 — "the seed list is copied in"). Omitting `seed`
    // defaults to the BUILTIN seed (D9: client catalogs patch the builtin
    // seed by id — the factory IS the builtin-catalog surface); an explicit
    // empty array yields an empty catalog.
    const seed = options.seed === undefined ? defaultGearSeed : options.seed;
    seed.forEach((definition) => definitions.set(definition.id, { ...definition }));

    return {
        define: (spec) => {
            // Known id: merge ONLY the provided (non-undefined) fields onto
            // the stored definition — define({ id, damage: undefined }) keeps
            // the listed damage (D9 "undefined never erases"). Unknown id:
            // store the provided fields as given (no defaults to fill; see
            // header). Map.set overwrites in place, preserving first-listing
            // order. The returned object is a copy, never the live storage.
            const current = definitions.get(spec.id);
            const merged: Record<string, unknown> = current ? { ...current } : {};
            Object.entries(spec).forEach(([key, value]) => {
                if (value !== undefined) {
                    merged[key] = value;
                }
            });
            const definition = merged as unknown as GearDefinition;
            definitions.set(definition.id, definition);
            return { ...definition };
        },

        definitionOf: (id) => {
            const definition = definitions.get(id);
            // Copy on read — mutating the result never touches the catalog
            return definition ? { ...definition } : undefined;
        },

        has: (id) => definitions.has(id),

        all: () => Array.from(definitions.values()).map((definition) => ({ ...definition })),

        count: () => definitions.size,

        remove: (id) => definitions.delete(id),

        clear: () => {
            definitions.clear();
        },
    };
};

// ----------------------------------------------------------------------------
// mergeGearCatalog — pure fold of client patches over a seed list (D9:
// "Client entries patch by id"). Exported because validation.ts (same owner)
// folds the effective catalog to resolve equipment refs, and T5/engine may
// reuse it; semantics identical to createGearCatalog.define (undefined never
// erases, first-listing order preserved). Non-object / id-less patches are
// skipped here (validation.ts reports them as data errors).
// ----------------------------------------------------------------------------

export const mergeGearCatalog = (
    seed: readonly GearDefinition[],
    patches?: readonly unknown[],
): GearDefinition[] => {
    const definitions = new Map<string, GearDefinition>();
    seed.forEach((definition) => definitions.set(definition.id, { ...definition }));

    if (Array.isArray(patches)) {
        patches.forEach((patch) => {
            if (!isPlainObject(patch) || typeof patch.id !== 'string') {
                return;
            }
            const current = definitions.get(patch.id);
            const merged: Record<string, unknown> = current ? { ...current } : {};
            Object.entries(patch).forEach(([key, value]) => {
                if (value !== undefined) {
                    merged[key] = value;
                }
            });
            definitions.set(patch.id, merged as unknown as GearDefinition);
        });
    }

    return Array.from(definitions.values());
};

// ----------------------------------------------------------------------------
// mergeStatusCatalog — pure fold of client status definitions over the
// builtin seed by id (T2 R1, same patch semantics as mergeGearCatalog:
// undefined never erases, first-listing order preserved). Status definitions
// have per-field defaults (decay 'none', no modifiers, no tick), so NEW ids
// may be partial — only the id itself is required (validation reports
// malformed entries). Non-object / id-less patches are skipped here
// (validation.ts reports them as data errors).
// ----------------------------------------------------------------------------

export const mergeStatusCatalog = (
    seed: readonly StatusDefinition[],
    patches?: readonly unknown[],
): StatusDefinition[] => {
    const definitions = new Map<string, StatusDefinition>();
    seed.forEach((definition) => definitions.set(definition.id, { ...definition }));

    if (Array.isArray(patches)) {
        patches.forEach((patch) => {
            if (!isPlainObject(patch) || typeof patch.id !== 'string') {
                return;
            }
            const current = definitions.get(patch.id);
            const merged: Record<string, unknown> = current ? { ...current } : {};
            Object.entries(patch).forEach(([key, value]) => {
                if (value !== undefined) {
                    merged[key] = value;
                }
            });
            definitions.set(patch.id, merged as unknown as StatusDefinition);
        });
    }

    return Array.from(definitions.values());
};

// ----------------------------------------------------------------------------
// clonePlain — minimal recursive plain-data deep copy (D14: plain TS, no
// deps). Assumes JSON-safe input (validation guarantees this for definitions);
// functions/symbols are dropped like JSON.stringify does.
// ----------------------------------------------------------------------------

const clonePlain = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value.map((item) => clonePlain(item)) as unknown as T;
    }
    if (isPlainObject(value)) {
        const copy: Record<string, unknown> = {};
        Object.entries(value).forEach(([key, item]) => {
            if (typeof item !== 'function' && typeof item !== 'symbol') {
                copy[key] = clonePlain(item);
            }
        });
        return copy as unknown as T;
    }
    return value;
};

// ----------------------------------------------------------------------------
// resolveBattleDefinition — integration helper (documented signature):
//
//   resolveBattleDefinition(input: BattleDefinition): BattleDefinition
//
// Returns a deep copy of `input` whose `catalogs.gear` is the effective
// catalog: client entries folded over `defaultGearSeed` by id with patch
// semantics (D9/D10 "resolved copy (catalogs merged)"). `catalogs.abilities`
// is carried through unchanged (no builtin ability seed exists — D9).
//
// T2 normalization (R2/R3/R4), all DEFENSIVE (validation.ts reports malformed
// shapes; normalization never crashes on hostile data — it only rewrites
// plain-object fields it recognizes):
//   - catalogs.statuses is folded over defaultStatusSeed by id (registered
//     defaults + client overrides, merged into the resolved definition so
//     snapshots/restore compare the exact effective registry);
//   - entity `resources` energy→stamina (both present ⇒ stamina wins; the
//     battle is rejected by validation anyway — normalization only needs to
//     be crash-safe, not ambiguity-proof);
//   - ability `costs` energy→stamina (same rule);
//   - entity `injuries` deduplicated in listed order, unknown entries
//     dropped (reported by validation).
// The input is never mutated; the result shares no references with it. Stat
// defaults (StatBlock) are resolved by the engine's state builder (T4/T5),
// NOT here, so ownership stays disjoint.
// ----------------------------------------------------------------------------

// Energy→stamina fold for one plain object (resources seed / ability costs).
// Returns the SAME object when there is nothing to normalize; a copy with
// the alias folded otherwise. The alias never survives resolution.
const foldEnergyAlias = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!value) return value;
    const hasEnergy = Object.prototype.hasOwnProperty.call(value, 'energy') && value.energy !== undefined;
    if (!hasEnergy) return value;
    // Both present ⇒ stamina wins (validation rejects the battle anyway).
    const folded: Record<string, unknown> = { ...value };
    if (folded.stamina === undefined) {
        folded.stamina = folded.energy;
    }
    delete folded.energy;
    return folded;
};

// Injuries normalization: keep known parts in listed order, first occurrence
// wins (idempotence by construction). Unknown/malformed entries are dropped
// here and reported by validation.
const normalizeInjuries = (value: unknown): BodyPart[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const parts: BodyPart[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !BODY_PARTS.includes(entry as BodyPart)) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);
        parts.push(entry as BodyPart);
    }
    return parts;
};

export const resolveBattleDefinition = (input: BattleDefinition): BattleDefinition => {
    const resolved = clonePlain(input);
    if (resolved.catalogs) {
        // Merge gear over the builtin seed by id (D9 patch semantics)
        resolved.catalogs.gear = mergeGearCatalog(defaultGearSeed, resolved.catalogs.gear);
        // Merge status definitions over the builtin seed by id (T2 R1 patch
        // semantics) — the resolved definition carries the EFFECTIVE registry.
        resolved.catalogs.statuses = mergeStatusCatalog(defaultStatusSeed, resolved.catalogs.statuses);
    }
    // Entity seed normalization (T2): energy alias fold, injuries dedupe.
    if (Array.isArray(resolved.entities)) {
        resolved.entities.forEach((entity) => {
            if (!entity || typeof entity !== 'object') return;
            const record = entity as unknown as Record<string, unknown>;
            if (record.resources !== undefined && typeof record.resources === 'object' && !Array.isArray(record.resources)) {
                record.resources = foldEnergyAlias(record.resources as Record<string, unknown>);
            }
            if (record.injuries !== undefined) {
                const injuries = normalizeInjuries(record.injuries);
                if (injuries !== undefined) record.injuries = injuries;
            }
        });
    }
    // Ability cost normalization (T2): energy alias fold.
    if (resolved.catalogs && Array.isArray(resolved.catalogs.abilities)) {
        resolved.catalogs.abilities.forEach((ability) => {
            if (!ability || typeof ability !== 'object') return;
            const record = ability as unknown as Record<string, unknown>;
            if (record.costs !== undefined && typeof record.costs === 'object' && !Array.isArray(record.costs)) {
                record.costs = foldEnergyAlias(record.costs as Record<string, unknown>) as ResourceCostInput;
            }
        });
    }
    return resolved;
};
