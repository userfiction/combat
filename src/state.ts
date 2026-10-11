// ============================================================================
// @userfiction/combat — src/state.ts — T4 mutable state + views + snapshots
// ============================================================================
// The engine's single mutable-state module (task §9 T4, D10). Everything here
// is plain data (D14: zero deps; D10: JSON-safe — no classes, no functions,
// no Dates), so the D7 transaction boundary can snapshot it with `deepCopy`
// and snapshots round-trip through JSON.parse(JSON.stringify(…)) unchanged.
//
// Copy-safety contract (D7 "no live references", task brief "no mutable
// references escape"): every exported getter (entityViewOf / stateViewOf /
// snapshotOf / snapshotStateOf / restoreFrom / createCombatState /
// createEntityState) deep-copies on the way in AND out — mutating any
// returned value can never touch engine state, and handing live caller data
// in never keeps a live reference. Mutation helpers are the ONLY sanctioned
// writers and they return result *copies*, never live references.
//
// Effective stats (D7/D5c): EntityView.stats = base + Σ modifiers with speed
// clamped to EFFECTIVE_SPEED_FLOOR (D4b); recomputed at every view build
// ("effective stats are recomputed at each use") — never cached in state.
//
// Integration surface for T5 (engine/pipeline/rules):
//   - CombatState is the live mutable state; the pipeline opens a transaction
//     per turn with snapshotStateOf() and restores with restoreFrom() (D7).
//   - Views feed hook handlers (D7); snapshots feed Simulation.snapshot() and
//     the D10 restore path.
//   - Mutation helpers implement exactly the bookkeeping D5/D8 need (damage,
//     heal, status stacking/resistance/caps, stat modifiers, gear durability/
//     breakage, schedule drops) — no mechanics beyond that live here.
// ============================================================================

import {
    COMBAT_SCHEMA_VERSION,
    EFFECTIVE_SPEED_FLOOR,
    MAX_STATUS_STACKS,
} from './types';
import type {
    BattleDefinition,
    BattleEvent,
    BattleMode,
    EntitySnapshot,
    EntityView,
    EquipmentEntry,
    Outcome,
    RngState,
    ScheduleEntry,
    SimulationSnapshot,
    SnapshotState,
    StatBlock,
    StatInput,
    StatKey,
    StatModifier,
    StateView,
    StatusInstance,
    Slot,
} from './types';

// ----------------------------------------------------------------------------
// Slot ↔ gear-kind mapping (D9): weapon → weapon-1|weapon-2; armour →
// shield|head|body|hands|feet. The runtime view carries slots but NOT the
// catalog (D7), so kind checks anywhere in the engine go through this map.
// Used by state.ts break-equipment and effects.ts has-gear.
// ----------------------------------------------------------------------------
export const WEAPON_SLOTS: readonly Slot[] = ['weapon-1', 'weapon-2'];
export const ARMOUR_SLOTS: readonly Slot[] = ['shield', 'head', 'body', 'hands', 'feet'];

// ----------------------------------------------------------------------------
// Plain-data deep copy (task §9 T4 "15-line recursive, JSON-safe"). Handles
// primitives, arrays and plain objects — the only shapes the state contract
// allows. Non-plain objects pass through by reference (contract violation if
// any ever appears in state; nothing in this package puts them there).
// ----------------------------------------------------------------------------
export function deepCopy<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) copy[key] = deepCopy(source[key]);
    return copy as unknown as T;
}

// ----------------------------------------------------------------------------
// State shapes. EntityState is literally EntitySnapshot (D10: "the public
// view plus the hidden bookkeeping") — so snapshotting entities is a pure
// deep copy and restore needs no field translation. CombatState is
// SnapshotState plus `mode` (mode is immutable battle data, not snapshot
// state per D10, but the views need it, so the live state carries it).
// ----------------------------------------------------------------------------
export type EntityState = EntitySnapshot;

export interface CombatState extends SnapshotState {
    mode: BattleMode;
}

// ----------------------------------------------------------------------------
// Construction
// ----------------------------------------------------------------------------

// One entity's initial data. `equipment` arrives PRE-RESOLVED (catalog
// durability already applied) — catalog resolution is T2/T5 territory, so
// state.ts never imports catalogs and never guesses durability defaults.
export interface EntitySeed {
    id: string;
    name?: string;                       // defaults to id (D3)
    team?: string;                       // absent in ffa (D3)
    order: number;                       // definition index (D4d tie-break)
    stats: StatInput;                    // resolved to StatBlock (optionals → 0, D3)
    statuses?: StatusInstance[];         // normalized: stacks/potency default 1 (D3/D5c)
    equipment?: EquipmentEntry[];
    cooldowns?: Record<string, number>;  // abilityId → remaining own-turns (D9)
}

// StatInput → StatBlock: the D3 "optionals default 0" resolution.
export function resolveStatBlock(input: StatInput): StatBlock {
    return {
        health: input.health,
        strength: input.strength,
        speed: input.speed,
        defense: input.defense ?? 0,
        precision: input.precision ?? 0,
        evasion: input.evasion ?? 0,
    };
}

// Status instances get their D3/D5c defaults filled at the state boundary so
// every downstream consumer (views, rules, interpreter) sees concrete values:
// stacks 1, potency 1; duration stays optional (fear is stack-based, D5c).
function normalizeStatus(status: StatusInstance): StatusInstance {
    const out: StatusInstance = { id: status.id, stacks: status.stacks ?? 1, potency: status.potency ?? 1 };
    if (status.duration !== undefined) out.duration = status.duration;
    return out;
}

export function createEntityState(seed: EntitySeed): EntityState {
    if (typeof seed.id !== 'string' || seed.id === '') {
        throw new Error('entity seed requires a non-empty string id');
    }
    const baseStats = resolveStatBlock(seed.stats);
    const entity: EntityState = {
        id: seed.id,
        name: seed.name ?? seed.id,
        order: seed.order,
        living: baseStats.health > 0,
        health: baseStats.health,
        // EntityState aliases EntitySnapshot, which carries the EFFECTIVE
        // stats block (D10). It is DERIVED bookkeeping: snapshotStateOf /
        // restoreFrom / entityViewOf recompute it from base + modifiers at
        // every boundary, so mutation helpers never need to update it.
        stats: effectiveStatsOf(baseStats, []),
        // maxHealth = RESOLVED BASE health (types.ts EntityView comment):
        // current health and effective stats.health are tracked separately;
        // modify-stat on 'health' moves stats.health (the effective block),
        // damage/heal move `health` only.
        maxHealth: baseStats.health,
        baseStats,
        statModifiers: [],
        statuses: (seed.statuses ?? []).map(normalizeStatus),
        equipment: deepCopy(seed.equipment ?? []),
        cooldowns: deepCopy(seed.cooldowns ?? {}),
    };
    if (seed.team !== undefined) entity.team = seed.team;
    return entity;
}

// Initial-state seed. step/virtualTime default 0, schedule defaults empty
// (the scheduler T3 fills entries), terminal defaults null.
export interface CombatStateSeed {
    mode: BattleMode;
    entities: EntityState[];
    rng: RngState;                       // { seed, state, draws } — built by rng.ts (T3)
    schedule?: ScheduleEntry[];
    step?: number;
    virtualTime?: number;
    terminal?: Outcome | null;
}

export function createCombatState(seed: CombatStateSeed): CombatState {
    if (seed.mode !== 'ffa' && seed.mode !== 'teams') {
        throw new Error('combat state seed mode must be "ffa" or "teams"');
    }
    return {
        mode: seed.mode,
        step: seed.step ?? 0,
        virtualTime: seed.virtualTime ?? 0,
        rng: deepCopy(seed.rng),
        entities: deepCopy(seed.entities),
        schedule: deepCopy(seed.schedule ?? []),
        terminal: deepCopy(seed.terminal ?? null),
    };
}

// ----------------------------------------------------------------------------
// Effective stats + read-only views (D7)
// ----------------------------------------------------------------------------

// base + Σ modifiers, speed clamped to the D4b floor. Other stats are NOT
// clamped (D4b names only speed; negative effective strength/precision etc.
// are legal intermediate math the D5 formulas consume as-is).
export function effectiveStatsOf(base: StatBlock, modifiers: readonly StatModifier[]): StatBlock {
    const stats: StatBlock = { ...base };
    for (const modifier of modifiers) stats[modifier.stat] += modifier.amount;
    stats.speed = Math.max(EFFECTIVE_SPEED_FLOOR, stats.speed);
    return stats;
}

// Fresh deep-copied EntityView (D7): handlers may mutate views freely.
export function entityViewOf(entity: EntityState): EntityView {
    const view: EntityView = {
        id: entity.id,
        name: entity.name,
        order: entity.order,
        living: entity.living,
        health: entity.health,
        maxHealth: entity.maxHealth,
        stats: effectiveStatsOf(entity.baseStats, entity.statModifiers),
        statuses: deepCopy(entity.statuses),
        equipment: deepCopy(entity.equipment),
        cooldowns: deepCopy(entity.cooldowns),
    };
    if (entity.team !== undefined) view.team = entity.team;
    return view;
}

export function stateViewOf(state: CombatState): StateView {
    return {
        mode: state.mode,
        step: state.step,
        time: state.virtualTime,
        entities: state.entities.map(entityViewOf),
    };
}

// ----------------------------------------------------------------------------
// Snapshots / restore (D10)
// ----------------------------------------------------------------------------

// Deep-copied SnapshotState (the D7 transaction-boundary primitive: the
// pipeline stores this before each turn and restores it on fault). The
// per-entity `stats` block is RECOMPUTED from base + modifiers (never
// trusted from the live object) so a snapshot can never carry stale
// effective stats.
export function snapshotStateOf(state: CombatState): SnapshotState {
    return {
        step: state.step,
        virtualTime: state.virtualTime,
        rng: deepCopy(state.rng),
        entities: state.entities.map((entity) => ({
            ...deepCopy(entity),
            stats: effectiveStatsOf(entity.baseStats, entity.statModifiers),
        })),
        schedule: deepCopy(state.schedule),
        terminal: deepCopy(state.terminal),
    };
}

// Full SimulationSnapshot (D10). definition/events are copied in as given —
// the engine passes its stored resolved copies.
export function snapshotOf(
    state: CombatState,
    definition: BattleDefinition,
    events: readonly BattleEvent[],
): SimulationSnapshot {
    return {
        schemaVersion: COMBAT_SCHEMA_VERSION,
        definition: deepCopy(definition),
        state: snapshotStateOf(state),
        events: deepCopy(events as BattleEvent[]),
    };
}

// Rebuild live state from a snapshot (D10 restore). Guards are minimal and
// throw (restore input is UI-supplied JSON; a corrupt snapshot is a hard
// construction error, matching createSimulation's fail-fast stance, D2).
export function restoreFrom(snapshot: SimulationSnapshot): CombatState {
    if (snapshot === null || typeof snapshot !== 'object') {
        throw new Error('restore: snapshot must be an object');
    }
    if (snapshot.schemaVersion !== COMBAT_SCHEMA_VERSION) {
        throw new Error(`restore: unsupported schemaVersion: ${String(snapshot.schemaVersion)}`);
    }
    const definition = snapshot.definition;
    if (definition === null || typeof definition !== 'object' || (definition.mode !== 'ffa' && definition.mode !== 'teams')) {
        throw new Error('restore: definition.mode must be "ffa" or "teams"');
    }
    const state = snapshot.state;
    if (state === null || typeof state !== 'object' || !Array.isArray(state.entities)) {
        throw new Error('restore: snapshot.state.entities must be an array');
    }
    return {
        mode: definition.mode,
        step: state.step,
        virtualTime: state.virtualTime,
        rng: deepCopy(state.rng),
        // Recompute derived stats on restore too (same no-stale-values rule
        // as snapshotStateOf — a UI-supplied snapshot may be hand-edited).
        entities: deepCopy(state.entities).map((entity) => ({
            ...entity,
            stats: effectiveStatsOf(entity.baseStats, entity.statModifiers),
        })),
        schedule: deepCopy(state.schedule ?? []),
        terminal: deepCopy(state.terminal ?? null),
    };
}

// ----------------------------------------------------------------------------
// Mutation helpers (engine-owned writers). All take the live CombatState,
// locate the entity by id (unknown id ⇒ throw: ids always come from views,
// so an unknown id is a programming fault, and a loud deterministic throw
// beats silent divergence), and return plain result copies.
// ----------------------------------------------------------------------------

export function findEntity(state: CombatState, entityId: string): EntityState {
    const entity = state.entities.find((candidate) => candidate.id === entityId);
    if (!entity) throw new Error(`unknown entity id: '${entityId}'`);
    return entity;
}

export interface DamageResult {
    entityId: string;
    applied: number;                     // 0 when the entity was already dead
    health: number;                      // post-hit current health
    killed: boolean;                     // true only on the living→dead transition
}

// Health subtraction (D5a.9): clamp at 0, flip `living` on the transition.
// Dead entities absorb no further damage — there is no overkill/revive
// mechanic (task brief: no extra mechanics).
export function damageEntity(state: CombatState, entityId: string, amount: number): DamageResult {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new Error('damage amount must be a finite number >= 0');
    }
    const entity = findEntity(state, entityId);
    if (!entity.living) return { entityId, applied: 0, health: entity.health, killed: false };
    const health = Math.max(0, entity.health - amount);
    const applied = entity.health - health;
    const killed = health === 0;
    entity.health = health;
    entity.living = health > 0;
    return { entityId, applied, health, killed };
}

export interface HealResult {
    entityId: string;
    applied: number;                     // clamped to the maxHealth headroom
    health: number;
}

// Heal clamps at maxHealth (declared adapter semantics for D8 'heal'; D8
// itself is silent, the clamp is the conservative reading of maxHealth).
// Dead entities are NOT revived (no revive mechanic).
export function healEntity(state: CombatState, entityId: string, amount: number): HealResult {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new Error('heal amount must be a finite number >= 0');
    }
    const entity = findEntity(state, entityId);
    if (!entity.living) return { entityId, applied: 0, health: entity.health };
    const applied = Math.min(amount, entity.maxHealth - entity.health);
    entity.health += applied;
    return { entityId, applied, health: entity.health };
}

// ----------------------------------------------------------------------------
// Status application (D5c generic re-application + D5e resistance). The
// stacking/resistance/cap math lives HERE (task §9 T4 "status-modifier
// bookkeeping"); the engine adapter (effects.ts EffectAdapter) calls it and
// turns the result into status:applied / status:resisted events (D11).
// ----------------------------------------------------------------------------

export interface StatusApplyOptions {
    stacks?: number;                     // incoming stacks, default 1 (D3)
    duration?: number;                   // optional; refresh uses max(current, new) (D5c)
    potency?: number;                    // optional; existing potency is KEPT (D5c only
                                         // defines stacks/duration refresh — declared decision)
    resistance?: number;                 // entity.statusResistances[statusId], 0..1 (D5e)
}

export type StatusApplyResult =
    | { kind: 'resisted' }
    | { kind: 'applied'; status: StatusInstance }
    | { kind: 'refreshed'; status: StatusInstance };

export function applyStatus(
    state: CombatState,
    entityId: string,
    statusId: string,
    options: StatusApplyOptions = {},
): StatusApplyResult {
    const entity = findEntity(state, entityId);
    const stacks = options.stacks ?? 1;
    if (typeof stacks !== 'number' || !Number.isFinite(stacks) || stacks < 0) {
        throw new Error('status stacks must be a finite number >= 0');
    }
    // Resistance clamped defensively (validation guarantees 0..1 upstream).
    const resistance = Math.min(1, Math.max(0, options.resistance ?? 0));
    // D5e: resist ≥ 1 ⇒ full resist, status not applied, no event beyond resisted.
    if (resistance >= 1) return { kind: 'resisted' };
    // D5e: added = floor(added × (1 − resist)).
    const added = Math.floor(stacks * (1 - resistance));

    const existing = entity.statuses.find((status) => status.id === statusId);
    if (!existing) {
        // Edge (declared): partial resistance can floor incoming stacks to 0 —
        // a brand-new status with zero stacks is resisted rather than applied
        // with an invalid 0 (D3 stacks range is 1..9).
        if (added <= 0) return { kind: 'resisted' };
        const status: StatusInstance = { id: statusId, stacks: Math.min(added, MAX_STATUS_STACKS), potency: options.potency ?? 1 };
        if (options.duration !== undefined) status.duration = options.duration;
        entity.statuses.push(status);
        return { kind: 'applied', status: deepCopy(status) };
    }

    // D5c re-application: stacks = min(stacks + added, 9);
    // duration = max(current, new) — undefined treated as 0 for the max, and
    // a status with no duration on either side (fear) stays duration-less.
    // (`?? 1`: the type allows an absent stacks; createEntityState/applyStatus
    // always fill it, the fallback keeps the arithmetic total.)
    existing.stacks = Math.min((existing.stacks ?? 1) + added, MAX_STATUS_STACKS);
    const duration = Math.max(existing.duration ?? 0, options.duration ?? 0);
    if (duration > 0) existing.duration = duration;
    existing.potency = existing.potency ?? options.potency ?? 1;
    return { kind: 'refreshed', status: deepCopy(existing) };
}

export function removeStatus(state: CombatState, entityId: string, statusId: string): boolean {
    const entity = findEntity(state, entityId);
    const index = entity.statuses.findIndex((status) => status.id === statusId);
    if (index < 0) return false;
    entity.statuses.splice(index, 1);
    return true;
}

// ----------------------------------------------------------------------------
// Temporary stat modifiers (D8 modify-stat / D10 StatModifier).
// remainingTurns counts the TARGET's scheduled turns (D5c/D10) and is
// decremented by decrementStatModifiers in the status:turn-end phase.
// remainingTurns === 0 is the PERMANENT sentinel — JSON-safe (Infinity is
// not), and validation never produces 0-duration modifiers from D8's
// "duration?" default: the engine adapter maps duration-omitted ⇒ 0.
// ----------------------------------------------------------------------------

export function addStatModifier(
    state: CombatState,
    entityId: string,
    stat: StatKey,
    amount: number,
    remainingTurns: number,
): StatModifier {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new Error('stat modifier amount must be a finite number');
    }
    if (typeof remainingTurns !== 'number' || !Number.isInteger(remainingTurns) || remainingTurns < 0) {
        throw new Error('stat modifier remainingTurns must be an integer >= 0');
    }
    const entity = findEntity(state, entityId);
    const modifier: StatModifier = { stat, amount, remainingTurns };
    entity.statModifiers.push(modifier);
    return deepCopy(modifier);
}

// Decrement every timed modifier by one own-turn; drop (and return) the ones
// that reach 0 so the engine can emit stat:expired events (D11). Permanent
// (remainingTurns === 0) modifiers are untouched.
export function decrementStatModifiers(state: CombatState, entityId: string): StatModifier[] {
    const entity = findEntity(state, entityId);
    const expired: StatModifier[] = [];
    const kept: StatModifier[] = [];
    for (const modifier of entity.statModifiers) {
        if (modifier.remainingTurns <= 0) {
            kept.push(modifier);
            continue;
        }
        modifier.remainingTurns -= 1;
        if (modifier.remainingTurns === 0) expired.push(deepCopy(modifier));
        else kept.push(modifier);
    }
    entity.statModifiers = kept;
    return expired;
}

// ----------------------------------------------------------------------------
// Equipment durability / breakage (D5b/D8 break-equipment).
// damageGear only DECREMENTS and reports — removal timing (the breaking
// piece still contributed this hit) is orchestrated by the engine (D5b),
// which then calls removeGear.
// ----------------------------------------------------------------------------

export interface GearDamageResult {
    gearId: string;
    slot: Slot;
    durability: number;                  // post-damage value, floored at 0
    broken: boolean;                     // durability reached 0
}

// Returns null when the slot is empty (mid-cascade removals make this a
// legal race the engine must tolerate; a throw would fault a valid battle).
export function damageGear(state: CombatState, entityId: string, slot: Slot, amount = 1): GearDamageResult | null {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new Error('gear damage amount must be a finite number >= 0');
    }
    const entity = findEntity(state, entityId);
    const entry = entity.equipment.find((piece) => piece.slot === slot);
    if (!entry) return null;
    entry.durability = Math.max(0, entry.durability - amount);
    return { gearId: entry.gearId, slot: entry.slot, durability: entry.durability, broken: entry.durability === 0 };
}

export function removeGear(state: CombatState, entityId: string, slot: Slot): EquipmentEntry | null {
    const entity = findEntity(state, entityId);
    const index = entity.equipment.findIndex((piece) => piece.slot === slot);
    if (index < 0) return null;
    const [removed] = entity.equipment.splice(index, 1);
    return deepCopy(removed);
}

// Instant break (D8 break-equipment). slot given ⇒ that slot only.
// slot omitted ⇒ every WEAPON slot (weapon-1/weapon-2) — declared decision:
// the weapon is the canonical "equipment" of an attack; armour/shield stay
// (breaking all seven slots on a slot-less descriptor would surprise clients).
// Returns the removed pieces (copies) so the engine emits gear:broken per piece.
export function breakGear(state: CombatState, entityId: string, slot?: Slot): EquipmentEntry[] {
    const entity = findEntity(state, entityId);
    const matches = (piece: EquipmentEntry): boolean =>
        slot !== undefined ? piece.slot === slot : WEAPON_SLOTS.includes(piece.slot);
    const removed: EquipmentEntry[] = [];
    const kept: EquipmentEntry[] = [];
    for (const piece of entity.equipment) (matches(piece) ? removed : kept).push(piece);
    entity.equipment = kept;
    return deepCopy(removed);
}

// ----------------------------------------------------------------------------
// Schedule bookkeeping (D4e: "Deaths drop the dead entity's pending entries
// immediately"). The scheduler itself (T3) owns ordering/interval math;
// state.ts only stores and drops entries.
// ----------------------------------------------------------------------------
export function dropScheduleEntries(state: CombatState, entityId: string): number {
    const before = state.schedule.length;
    state.schedule = state.schedule.filter((entry) => entry.entityId !== entityId);
    return before - state.schedule.length;
}
