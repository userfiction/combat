// ============================================================================
// @userfiction/combat — src/contract/types.ts — T1 interface gate
// ============================================================================
// ALL shared public types and constants for the combat engine (task §5 D2–D10,
// bounds table D13). This file is the single source of truth: T2 (validation/
// catalogs), T3 (rng/scheduler), T4 (state/effects/plugins) and T5 (rules/
// pipeline/engine/events) code against these shapes and must NOT fork private
// duplicates of them. Downstream owners may add helpers in their own modules;
// the shared vocabulary here stays stable.
//
// Design constraints honored (task §3/§5):
//   - Plain TypeScript only, zero dependencies (D14), synchronous (D1),
//     framework-free, no DOM/React/async anywhere in these contracts.
//   - JSON battle definitions are strictly data — no functions in any input
//     or snapshot type (D1/D3/D10).
//   - Scheduler time is integer microseconds (D4a); combat math is ordinary
//     JS numbers with rounding defined at the D5 points only.
//
// Textual-tension resolutions baked into these contracts (conservative):
//   1. createSimulation options are OPTIONAL (D1 wording `input, options?`
//      wins over D2's `options: SimulationOptions`); see CreateSimulation.
//   2. Hook payload: D7 fixes the handler signature to (view, ctx) but the
//      D6 contract column gives every hook an input payload (e.g.
//      damage:mitigate `{ amount, damageType }`) that StepContext does not
//      carry. Resolution: HookHandler gains a third `args` parameter typed
//      per-hook by HookContracts; 2-parameter handlers (all §7 examples)
//      remain assignable. See HookHandler.
//   3. Status lifecycles are DEFINITION-DRIVEN only (R1 canonical): tick →
//      decay → expiry run in the status:turn-end phase; skip gating rolls at
//      action:select. There are NO hardcoded per-id status branches — every
//      id's semantics come from its StatusDefinition (or nothing at all for
//      unregistered open-set ids, which stay inert bookkeeping data).
// ============================================================================

// ----------------------------------------------------------------------------
// Schema version (D3) — the one literal every definition/snapshot carries.
// Typed as `typeof COMBAT_SCHEMA_VERSION` below so the constant and the type
// can never drift apart.
// ----------------------------------------------------------------------------

export const COMBAT_SCHEMA_VERSION = 1;

// ----------------------------------------------------------------------------
// Closed vocabularies (D2 barrel constants; D6 hook table; D9 kinds/slots).
// `as const` gives both the runtime array (validation + UI iteration) and the
// exact literal union via `typeof X[number]`.
// ----------------------------------------------------------------------------

// The six stats (D3 StatInput/StatBlock). First three required on input,
// last three optional with default 0.
export const STAT_KEYS = ['health', 'strength', 'speed', 'defense', 'precision', 'evasion'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

// Full closed hook vocabulary — exactly the D6 table rows, in table order.
// Unknown hook ids are rejected at plugin load (D6/D7).
export const HOOK_IDS = [
    'scheduler:interval',
    'scheduler:order',
    'action:select',
    'target:select',
    'attack:dodge',
    'attack:crit',
    'damage:base',
    'damage:mitigate',
    'ability:execute',
    'attack:pre',
    'damage:post',
    'equipment:post',
    'status:turn-end',
    'step:end',
    'outcome:decide',
] as const;
export type HookId = (typeof HOOK_IDS)[number];

// Single-mode hooks: exactly ONE handler runs (last declared override wins,
// else builtin default) — D6.
export const SINGLE_HOOK_IDS = [
    'scheduler:interval',
    'scheduler:order',
    'action:select',
    'target:select',
    'attack:dodge',
    'attack:crit',
    'damage:base',
    'damage:mitigate',
    'ability:execute',
    'outcome:decide',
] as const;
export type SingleHookId = (typeof SINGLE_HOOK_IDS)[number];

// Chain-mode hooks: ALL handlers run in registration order (builtin → code
// plugins → JSON contributions) — D6. DeclarativeRule.hook must be one of
// these (D3: "rule hook ids must be chain-mode hooks").
export const CHAIN_HOOK_IDS = [
    'attack:pre',
    'damage:post',
    'equipment:post',
    'status:turn-end',
    'step:end',
] as const;
export type ChainHookId = (typeof CHAIN_HOOK_IDS)[number];

// Weapon/armour damage types (D9 GearDefinition.type; D5a.7 unarmed ⇒ blunt).
// NOTE: 'true' damage exists ONLY on the damage-flat effect (D8) and is not a
// gear damage type — see EffectDamageType.
export const DAMAGE_TYPES = ['blunt', 'sharp'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

// Damage types accepted by the damage-flat effect (D8): the two gear types
// plus 'true', which bypasses armour entirely.
export type EffectDamageType = DamageType | 'true';

// Gear kinds (D9).
export const GEAR_KINDS = ['weapon', 'armour'] as const;
export type GearKind = (typeof GEAR_KINDS)[number];

// Equipment slots (D5e/D9). Hands budget = 2 across weapon-1 + weapon-2 +
// shield; handedness 2 forbids weapon-2 and shield occupants.
export const SLOTS = ['weapon-1', 'weapon-2', 'shield', 'head', 'body', 'hands', 'feet'] as const;
export type Slot = (typeof SLOTS)[number];

// Battle modes (D3). ffa ⇒ no teams and no entity.team; teams ⇒ bidirectional
// membership agreement (validated by T2).
export type BattleMode = 'ffa' | 'teams';

// Comparison operators for the declarative `stat` condition (D8).
export type StatCompareOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';

// ----------------------------------------------------------------------------
// T2 — body anatomy (closed vocabulary). Explicit KNOWN parts only: the
// engine derives real combat effects from exactly these, so arbitrary strings
// would be ornamental data. head/torso are deliberately NOT parts: no
// coherent v1 effect exists for them (no invented penalties).
// ----------------------------------------------------------------------------
export const BODY_PARTS = [
    'left-arm', 'right-arm',
    'left-leg', 'right-leg',
    'left-eye', 'right-eye',
    'left-ear', 'right-ear',
    'nose',
] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

// ----------------------------------------------------------------------------
// T2 — resource pools (R3). Exactly two NON-health pools: stamina and mana.
// Health is the existing `stats.health`/current-health pair — a separate
// health pool would be a duplicated, desynchronizable copy and is rejected by
// design. `energy` is an ACCEPTED INPUT ALIAS for stamina (normalized at
// resolution; both present at once is a validation conflict) so callers may
// use the intuitive word without creating a second pool.
// ----------------------------------------------------------------------------
export const RESOURCE_KEYS = ['stamina', 'mana'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

// One pool as carried by actor input AND snapshots: current spends/clamps at
// max. Integers ≥ 0 (D13 bounds), current ≤ max (validated).
export interface ResourcePool {
    current: number;
    max: number;
}

// Actor input form: `energy` aliases stamina. Snapshots/resolved definitions
// never carry `energy` (normalized away at resolve time).
export interface EntityResourcesInput {
    stamina?: ResourcePool;
    mana?: ResourcePool;
    energy?: ResourcePool;               // alias of stamina (conflict-checked)
}

// Normalized/snapshot form — the only shape runtime code reads.
export interface EntityResources {
    stamina?: ResourcePool;
    mana?: ResourcePool;
}

// Skill cost input form (R3): health spends the EXISTING health value (never
// a duplicated pool); stamina/mana spend their pools. `energy` aliases
// stamina (same conflict rule as the actor seed). All values finite ≥ 0,
// bounded by MAX_RESOURCE_VALUE (D13).
export interface ResourceCostInput {
    health?: number;
    stamina?: number;
    mana?: number;
    energy?: number;                     // alias of stamina (conflict-checked)
}

// Normalized/snapshot form of the same cost.
export type ResourceCost = {
    health?: number;
    stamina?: number;
    mana?: number;
};

// ----------------------------------------------------------------------------
// D3 — battle input model (plain JSON; no functions anywhere)
// ----------------------------------------------------------------------------

// Input stat form as written in definitions. StatBlock is the RESOLVED
// six-stat block (optionals default 0) used at runtime, in views, and in
// snapshots (D3 comment).
export interface StatInput {
    health: number;                          // required; validated integer 1..100_000
    strength: number;                        // required; 0..1_000
    speed: number;                           // required; 0.1..100 (zero/negative/NaN ⇒ error)
    defense?: number;                        // optional, default 0; 0..1_000
    precision?: number;                      // optional, default 0; 0..1_000
    evasion?: number;                        // optional, default 0; 0..1_000
}
export type StatBlock = Required<StatInput>;

// Starting/running status instance (D3/D5c). Any id is valid data (open set,
// D5f): its semantics come ENTIRELY from a registered StatusDefinition (T2
// status catalog) or a code plugin — the engine ships no hardcoded id
// branches, so an unregistered id is inert bookkeeping data.
//
// `modifiers` is ENGINE-MATERIALIZED bookkeeping (T2 R1): when a definition
// with `modifiers` is applied/refreshed, the engine writes the per-stack
// scaled contribution here and the central stat derivation (state.ts
// entityEffectiveStats) adds it while the instance lives. Input instances
// that carry this field have it overwritten — it is never trusted from data.
export interface StatusInstance {
    id: string;                              // ENTITY_ID pattern (ids.ts), open set
    stacks?: number;                         // integer 1..9, default 1 (D13 cap 9)
    duration?: number;                       // integer ≥ 1 when present
    potency?: number;                        // integer ≥ 1, default 1
    modifiers?: Partial<Record<StatKey, number>>;  // engine-materialized, per-stack scaled
}

// ----------------------------------------------------------------------------
// T2 — status definitions (R1). ailments(...)/buff(...) and
// catalogs.statuses REGISTER these; actor statuses stay StatusInstance
// references that effects apply/remove. The builtin turn-end/select floor
// CONSULTS the resolved registry: a status whose id has a definition here is
// driven by it (tick → decay → expiry); an unregistered id has NO engine
// semantics (inert data) — the canonical seed (fearful/poisoned/stunned)
// covers the shipped defaults.
// ----------------------------------------------------------------------------

// Lifetime semantics at the afflicted entity's own turn end (status:turn-end):
//   'stacks'   — lose 1 stack per own turn (fearful-style); expire at 0
//   'duration' — countdown per own turn (poisoned-style); tick fires BEFORE the
//                decrement so the final tick precedes expiry (D5c order)
//   'none'     — permanent until explicitly removed (dispel effect / heal)
export const STATUS_DECAY_MODES = ['stacks', 'duration', 'none'] as const;
export type StatusDecayMode = (typeof STATUS_DECAY_MODES)[number];

// Per-own-turn tick values, scaled by the instance's stacks (e.g. tick
// damage 2 with 3 stacks ticks for 6). `potency` does NOT scale definition
// ticks (it is instance bookkeeping carried for effects/events) — documented
// divergence, kept so the StatusInstance shape stays shared.
export interface StatusTickEffect {
    damage?: number;                     // true-damage tick (bypasses mitigation, can kill)
    heal?: number;                       // self-heal tick (clamped at maxHealth, no revive)
}

export interface StatusDefinition {
    id: string;                              // ENTITY_ID pattern (ids.ts)
    name?: string;
    // Stat modifiers PER STACK, active while the instance lives. Applied on
    // application, re-scaled on refresh/stack-decay, gone on removal/expiry —
    // derived centrally from the instance (state.ts), so re-application can
    // never accumulate duplicates (R1 no-modifier-accumulation rule).
    modifiers?: Partial<Record<StatKey, number>>;
    tick?: StatusTickEffect;                 // runs each own turn before decay
    decay?: StatusDecayMode;                 // default 'none' (permanent)
    // action:select skip chance per stack (fearful-style gating): roll
    // rng < skipChancePerStack × stacks ⇒ the turn is skipped with reason
    // statusId. Default 0 (no gating). THE only skip mechanism — the engine
    // has no hardcoded per-id gate, so stunned's canonical definition carries
    // skipChancePerStack 1 (the roll always skips; it consumes one draw).
    skipChancePerStack?: number;
}

// Equipment reference into the gear catalog (D3). `slot` must match the
// gear's kind/slot rules (D9); `durability` optionally overrides the catalog
// value for this instance.
export interface GearRef {
    id: string;
    slot: Slot;
    durability?: number;
}

// Entity equipment loadout (D3 `equipment?` field shape).
export interface EquipmentLoadout {
    weapons?: GearRef[];
    armour?: GearRef[];
}

// One combatant (D3). id pattern /^[a-z0-9][a-z0-9-]*$/ (reader convention,
// ids.ts); name defaults to id; team forbidden in ffa, required + agreed in
// teams mode (bidirectional check, D3).
//
// T2 additions:
//   injuries  — initially missing body parts (R2). Permanent unless an
//               explicit heal-injury effect restores them; validated against
//               the BODY_PARTS closed set, duplicates rejected.
//   resources — non-health pools (R3, EntityResourcesInput). `energy` is
//               normalized to stamina at resolution; legacy actors omit the
//               field entirely (defaults: no pools, all resource costs
//               unpayable).
//   skills    — INTUITIVE ALIAS of `abilities` (R4, conservative): both are
//               validated identically, but presenting BOTH at once is a
//               validation error so the effective list is never ambiguous.
export interface EntityDefinition {
    id: string;
    name?: string;
    team?: string;
    stats: StatInput;
    statuses?: StatusInstance[];             // starting afflictions
    injuries?: BodyPart[];                   // initially missing parts (R2)
    resources?: EntityResourcesInput;        // stamina/mana pools (R3)
    equipment?: EquipmentLoadout;
    abilities?: string[];                    // ability catalog ids
    skills?: string[];                       // alias of abilities (R4; both ⇒ error)
    statusResistances?: Record<string, number>;  // statusId → 0..1 fraction (D5e)
}

// Team declaration (D3). members = entity ids; agreement with entity.team is
// validated in BOTH directions by T2. Empty member lists are valid data
// (⇒ the no-enemies outcome, D5g).
export interface TeamDefinition {
    id: string;
    name?: string;
    members: string[];
}

// Run limits (D3/D13). All optional; defaults and ranges are the constants
// block at the bottom of this file. maxSteps cap → outcome 'undecided';
// maxCascade exceeded within one step ⇒ fault (D4f/D7); maxLogEvents drops
// oldest events with a 'log-trimmed' notice.
export interface SimulationConfig {
    maxSteps?: number;
    maxCascade?: number;
    maxLogEvents?: number;
}

// Config after defaults are applied — what the engine runs with and what the
// outcome:decide context exposes (D7: minimal `{ step, time, config }`).
export type ResolvedSimulationConfig = Required<SimulationConfig>;

// D9 gear definition — ONE shared field set for weapons AND armour (the
// client's explicit requirement, R4). Which fields are semantically live per
// kind (D9): weapons use type/damage; armour uses blunt/sharp; handedness is
// live on both; type/damage on armour and blunt/sharp on weapons are inert in
// v1 defaults but remain in the data for the shared contract + future plugins.
export interface GearDefinition {
    id: string;
    name?: string;
    kind: GearKind;
    slot: Slot;                              // weapon → weapon-1|weapon-2; armour → head|body|hands|feet|shield
    handedness: 0 | 1 | 2;                   // 0 non-hand gear; 1 one-handed/shield; 2 two-handed
    type: DamageType;                        // weapons: damage dealt; armour: inert v1
    damage: number;                          // weapons: attack power 0..1_000; armour: inert (0)
    blunt: number;                           // 0..1 resistance fraction vs blunt — meaningful on armour
    sharp: number;                           // 0..1 resistance fraction vs sharp — meaningful on armour
    durability: number;                      // integer 1..2_000
}

// Ability definition (D9). cost default 1, validated 0.25..10 (D4b);
// cooldown default 0, counted in the actor's OWN scheduled turns (D9);
// `conditions` gates availability at action:select (D5a.2 usable-rule);
// effects run via ability:execute (D5a.12/D8).
//
// T2 addition — `costs` (R3): SCHEDULER TIME stays in `cost` (D4b — do NOT
// move it); `costs` is the separate RESOURCE price paid inside the step
// transaction when the ability actually executes. `energy` aliases stamina
// (normalized at resolution; both present ⇒ validation error).
export interface AbilityDefinition {
    id: string;
    name?: string;
    cost?: number;
    cooldown?: number;
    costs?: ResourceCostInput;               // resource price (R3), distinct from time `cost`
    conditions?: Condition;
    effects: EffectDescriptor[];
}

// Client catalog section (D3): PATCHes over the builtin seed by id (D9 —
// patch semantics live in catalogs.ts, T2). T2 adds `statuses`: status
// definitions patch over defaultStatusSeed by id (same fold semantics), so
// custom ailment/buff definitions override the registered defaults
// predictably, and arbitrary new ids (open vocabulary) may be defined the
// same way.
export interface GearCatalogSection {
    gear?: GearDefinition[];
    abilities?: AbilityDefinition[];
    statuses?: StatusDefinition[];
}

// startingConditions (D3): seed default 1 (integer 0..2^32−1, D4g); config
// carries the run limits.
export interface StartingConditions {
    seed?: number;
    config?: SimulationConfig;
}

// rules section (D3/D8): the ONLY way JSON contributes behavior — declarative
// rules compiled into chain hooks. No eval, no embedded code (D1/D7 trust
// boundary).
export interface BattleRules {
    contributions?: DeclarativeRule[];
}

// The complete battle definition (D3). schemaVersion must be 1.
export interface BattleDefinition {
    schemaVersion: typeof COMBAT_SCHEMA_VERSION;
    name?: string;
    mode: BattleMode;
    teams?: TeamDefinition[];
    entities: EntityDefinition[];            // ≥ 2 required
    catalogs?: GearCatalogSection;
    // status instances live on entities (EntityDefinition.statuses) — never here (D3)
    startingConditions?: StartingConditions;
    rules?: BattleRules;
}

// ----------------------------------------------------------------------------
// D8 — bounded declarative condition/effect vocabulary (extension-friendly)
// ----------------------------------------------------------------------------

// Ref names resolve against StepContext.refs: attacker→actor, target→target,
// self→self ?? actor (D7).
export type Ref = 'attacker' | 'target' | 'self';

// Namespaced type id for plugin-extended vocabulary (D8): the full id is
// `pluginId/name` (ids.ts namespaced(), reader precedent registry.ts
// L110–111). Built-in type strings never contain '/', so the template-literal
// discriminant stays disjoint from every builtin member below and TS
// narrowing on `type` keeps working.
export type CustomTypeId = `${string}/${string}`;

// Extension-friendly condition: any namespaced type not in the builtin set is
// valid data IF some plugin's vocab.conditions registers it (D8 vocabulary
// extension). Convention: every field besides `type` is passed to the vocab
// handler as `params` (same flat convention as builtin descriptors).
export interface CustomCondition {
    type: CustomTypeId;
    [param: string]: unknown;
}

// Extension-friendly effect — same convention as CustomCondition; the vocab
// handler returns EffectDescriptor[] which the engine applies (D7/D8).
export interface CustomEffect {
    type: CustomTypeId;
    [param: string]: unknown;
}

// Closed builtin condition set (D8) + namespaced extension. Depth ≤ 16 and
// lists ≤ 32 are validated at load (MAX_RULE_DEPTH / MAX_RULE_LIST).
// T2 addition — 'has-injury' (R2): true when the named body part is MISSING
// on the ref; lets skills/declarative rules gate on anatomy (e.g. a
// two-handed skill requires both arms) without plugins.
export type Condition =
    | { type: 'always' }
    | { type: 'never' }
    | { type: 'stat'; ref: Ref; stat: StatKey; op: StatCompareOp; value: number }
    | { type: 'has-status'; ref: Ref; status: string }
    | { type: 'has-injury'; ref: Ref; part: BodyPart }
    | { type: 'has-gear'; ref: Ref; kind?: GearKind; slot?: Slot }
    | { type: 'mode'; is: BattleMode }
    | { type: 'chance'; p: number }          // consumes the shared RNG stream (D4g)
    | { type: 'all'; of: Condition[] }
    | { type: 'any'; of: Condition[] }
    | { type: 'not'; of: Condition }
    | CustomCondition;

// Closed builtin effect set (D8) + namespaced extension. Effects are applied
// by the ENGINE (mutation ownership, D7); apply-status honors resistances and
// the stack cap (D5c); damage-flat bypasses mitigation and can kill; 'true'
// damageType bypasses armour entirely; strike runs the full attack pipeline
// (recursion depth ≤ 2, D5a.12).
//
// T2 additions (R2/R3):
//   apply-injury    — remove a body part (idempotent; no event when already
//                     missing). NOT wired into ordinary attacks: injuries
//                     happen only where a skill/effect declares them.
//   heal-injury     — the ONLY restore path (coherent restore: the named
//                     part must actually be missing; the generic 'heal'
//                     effect NEVER regrows parts).
//   modify-resource — signed pool change (positive restores clamped at max,
//                     negative drains floored at 0); the explicit
//                     restore/spend path — pools never regenerate on their
//                     own (R3 no-arbitrary-regeneration rule).
export type EffectDescriptor =
    | { type: 'strike' }
    | { type: 'damage-flat'; target: Ref; amount: number; damageType?: EffectDamageType }
    | { type: 'heal'; target: Ref; amount: number }
    | { type: 'apply-status'; target: Ref; status: string; stacks?: number; duration?: number; potency?: number }
    | { type: 'remove-status'; target: Ref; status: string }
    | { type: 'apply-injury'; target: Ref; part: BodyPart }
    | { type: 'heal-injury'; target: Ref; part: BodyPart }
    | { type: 'modify-resource'; target: Ref; resource: ResourceKey; amount: number }
    | { type: 'break-equipment'; target: Ref; slot?: Slot }
    | { type: 'modify-stat'; target: Ref; stat: StatKey; amount: number; duration?: number }
    | { type: 'emit'; message: string }
    | CustomEffect;

// One declarative JSON rule (D8): runs at a CHAIN hook, in listed order,
// after code-plugin contributions (registration order, D6). `when` false ⇒
// rule no-ops.
export interface DeclarativeRule {
    id: string;
    hook: ChainHookId;
    when?: Condition;
    effects: EffectDescriptor[];
}

// ----------------------------------------------------------------------------
// D11 — events (typed, renderable, plain JSON)
// ----------------------------------------------------------------------------

// The typed default event set (D11). Plugins may emit ANY string type with
// arbitrary payloads; renderEventText has a fallback formatter.
export type KnownEventType =
    | 'battle:start' | 'turn:start' | 'action' | 'dodge' | 'crit' | 'block'
    | 'damage' | 'heal' | 'status:applied' | 'status:resisted' | 'status:tick'
    | 'status:expired' | 'stat:modified' | 'stat:expired' | 'gear:damaged'
    | 'gear:broken' | 'injury:applied' | 'injury:healed' | 'resource:spent'
    | 'resource:modified' | 'death' | 'log-trimmed' | 'step:end' | 'outcome' | 'fault'
    // T3 live edit (engine-emitted outside any step, no step increment)
    | 'combatant:edited';

// What ctx.emit accepts — the engine stamps id/step/time (D7/D11).
export interface EventDraft {
    type: string;                            // KnownEventType for builtins, arbitrary for plugins
    actor?: string;
    target?: string;
    message?: string;
    payload?: Record<string, unknown>;
}

// A logged event (D11). id is a monotonic integer restarting at 1 per log;
// trim keeps ids monotonic; restore continues from max(id)+1 (D10).
export interface BattleEvent extends EventDraft {
    id: number;
    step: number;
    time: number;                            // integer µs (D4a)
}

// ----------------------------------------------------------------------------
// D4g — RNG stream contract (single shared deterministic Mulberry32)
// ----------------------------------------------------------------------------

// The only randomness source handlers get (D4g): plugins must never create
// their own. pick uses int(length). Generator state is one uint32; snapshots
// persist RngState so replay restores the exact stream position (D10).
export interface RngStream {
    next(): number;                          // float in [0, 1)
    int(maxExclusive: number): number;       // integer in [0, maxExclusive)
    pick<T>(array: readonly T[]): T | undefined;  // undefined for empty arrays
}

// Serialized RNG position (D10 snapshot `state.rng`).
export interface RngState {
    seed: number;
    state: number;
    draws: number;
}

// ----------------------------------------------------------------------------
// D7 — read-only projections (views) — handlers NEVER receive live state
// ----------------------------------------------------------------------------

// One equipped piece as seen by handlers (D7: equipment entries are
// `{ gearId, slot, durability }` copies).
export interface EquipmentEntry {
    gearId: string;
    slot: Slot;
    durability: number;
}

// Read-only entity projection (D7). `stats` is the EFFECTIVE block (base +
// modifiers + status-borne modifiers + injury derivation, speed clamped to
// EFFECTIVE_SPEED_FLOOR per D4b); effective stats are recomputed at each use
// (D5c). All nested data is deep-copied — mutating a view never affects the
// engine.
//
// T2 view additions (additive, absent when empty so legacy shapes are
// unchanged): `injuries` lists missing parts (R2); `resources` carries the
// normalized non-health pools (R3, absent for legacy actors).
export interface EntityView {
    id: string;
    name: string;                            // defaults to id (D3)
    team?: string;                           // absent in ffa
    order: number;                           // definition index — scheduler tie-break (D4d)
    living: boolean;
    health: number;
    maxHealth: number;                       // resolved base health (D5a/D10)
    stats: StatBlock;                        // EFFECTIVE stats
    statuses: StatusInstance[];              // copies
    injuries?: BodyPart[];                   // missing parts (R2), absent when none
    resources?: EntityResources;             // stamina/mana pools (R3), absent for legacy actors
    equipment: EquipmentEntry[];             // copies; slot identity carried per D7
    cooldowns: Record<string, number>;       // abilityId → remaining turns (D9, actor's own turns)
}

// Read-only world projection handed to every hook handler (D7).
export interface StateView {
    mode: BattleMode;
    step: number;
    time: number;                            // integer µs
    entities: EntityView[];                  // definition order preserved (D4d tie-break)
}

// ----------------------------------------------------------------------------
// D5/D6 — per-hook payload and result contracts (transcribed from the D6
// table's Contract column; named here so rules.ts, plugins.ts and pipeline.ts
// never invent divergent shapes)
// ----------------------------------------------------------------------------

// scheduler:interval — `{ entityId, actionCost, effectiveSpeed }` → µs (D4b).
export interface SchedulerIntervalArgs {
    entityId: string;
    actionCost: number;                      // 1 for basic attack/wait; ability cost otherwise
    effectiveSpeed: number;                  // already clamped ≥ EFFECTIVE_SPEED_FLOOR
}

// scheduler:order candidate (D4d): order = original entity index.
export interface ScheduleCandidate {
    entityId: string;
    readyAt: number;                         // integer µs
    effectiveSpeed: number;
    order: number;
}

// scheduler:order — minimal-readyAt candidates → chosen entityId (D4d).
export interface SchedulerOrderArgs {
    candidates: ScheduleCandidate[];
}

// Action kinds (D5a.2). skip = status-gated (definition skip roll) or
// no-target turn (reason carried).
export type ActionKind = 'attack' | 'ability' | 'wait' | 'skip';

// action:select result (D6): `{ kind, abilityId?, reason? }`.
export interface ActionSelection {
    kind: ActionKind;
    abilityId?: string;                      // required in practice when kind === 'ability'
    reason?: string;                         // e.g. 'stunned' | 'no-target' (open set — the
                                             // default selector reports the STATUS id whose
                                             // skip roll fired, or 'no-target')
}

// action:select args — `{ actor }` (D6).
export interface ActionSelectArgs {
    actor: EntityView;
}

// target:select args — `{ actor, action }` → entityId or null (D6/D5a.3).
export interface TargetSelectArgs {
    actor: EntityView;
    action: ActionSelection;
}

// Shared args for attack:dodge / attack:crit / damage:base —
// `{ attacker, target, weapon? }` (D6); weapon absent ⇒ unarmed (D5d).
export interface AttackRollArgs {
    attacker: EntityView;
    target: EntityView;
    weapon?: EquipmentEntry;
}

// attack:dodge result (D6).
export interface DodgeResult {
    dodged: boolean;
}

// attack:crit result (D6).
export interface CritResult {
    crit: boolean;
}

// damage:base result (D6): `{ amount, damageType }` — unarmed ⇒ blunt (D5a.7/D5d).
export interface BaseDamageResult {
    amount: number;
    damageType: DamageType;
}

// damage:mitigate args (D6): `{ attacker, target, amount, damageType }`.
export interface DamageMitigateArgs {
    attacker: EntityView;
    target: EntityView;
    amount: number;                          // raw amount from damage:base
    damageType: DamageType;
}

// damage:mitigate result (D6): `{ amount, blocked, armourFactor, defenseFactor }`
// — amount is the FINAL integer (≥ 1 on a hit, D5a.8); the two factors and
// the blocked flag ride along for the damage event payload (D11).
export interface MitigationResult {
    amount: number;
    blocked: boolean;
    armourFactor: number;
    defenseFactor: number;
}

// ability:execute args (D6): `{ actor, target, ability }`. target is optional
// at the type level because each effect carries its own Ref (D8) — a self
// buff needs no targeted selection.
export interface AbilityExecuteArgs {
    actor: EntityView;
    target?: EntityView;
    ability: AbilityDefinition;
}

// attack:pre chain context (D6): `{ actor, target, weapon? }`.
export interface AttackPreArgs {
    actor: EntityView;
    target?: EntityView;
    weapon?: EquipmentEntry;
}

// damage:post chain context (D6): `{ amount, killed, … }` — the ellipsis is
// explicit in D6, so attacker/target/damageType ride along as optional
// context for terror-style rules (the §7 example reads target via refs).
export interface DamagePostArgs {
    amount: number;
    killed: boolean;
    attacker?: EntityView;
    target?: EntityView;
    damageType?: DamageType;
}

// equipment:post chain context (D5b/D6): the default durability rule needs
// the landed hit's participants and which armour pieces CONTRIBUTED
// resistance (> 0) for the incoming type — the engine computes contributors
// so handlers never need the catalog.
export interface EquipmentPostArgs {
    attacker?: EntityView;
    target?: EntityView;
    weapon?: EquipmentEntry;                 // attacker's weapon (undefined ⇒ unarmed, no bookkeeping)
    damageType?: DamageType;
    contributedArmour?: EquipmentEntry[];    // defender pieces that resisted this hit (D5b)
}

// status:turn-end chain context (D5c/D6): the entity whose scheduled turn
// just ended — definition-driven status processing (tick → decay → expiry)
// and temp-modifier decrement key off this entity.
export interface StatusTurnEndArgs {
    entity: EntityView;
}

// step:end chain context (D6): `{ step, time }` — observer only, no terminal
// decision here (D5a.14).
export interface StepEndArgs {
    step: number;
    time: number;
}

// outcome:decide context (D5g/D7 exception): minimal PURE-OBSERVATION context
// — NO rng and NO emit (removes event-mutating override ambiguity). config is
// the resolved (defaults-applied) run config.
export interface OutcomeDecideContext {
    step: number;
    time: number;
    config: ResolvedSimulationConfig;
}

// What chain-mode handlers may return (D6): nothing (void) or EffectDescriptor[]
// applied by the engine in order.
export type ChainResult = void | EffectDescriptor[];

// Per-hook { args, result } map — the precise D6 contract table. Downstream
// helpers (e.g. a typed hook builder in rules.ts) derive from HookArgsOf /
// HookResultOf; the loose HookHandler stays the registration/storage type so
// §7-style plugin literals compile unchanged.
export interface HookContracts {
    'scheduler:interval': { args: SchedulerIntervalArgs; result: number };
    'scheduler:order': { args: SchedulerOrderArgs; result: string };
    'action:select': { args: ActionSelectArgs; result: ActionSelection };
    'target:select': { args: TargetSelectArgs; result: string | null };
    'attack:dodge': { args: AttackRollArgs; result: DodgeResult };
    'attack:crit': { args: AttackRollArgs; result: CritResult };
    'damage:base': { args: AttackRollArgs; result: BaseDamageResult };
    'damage:mitigate': { args: DamageMitigateArgs; result: MitigationResult };
    'ability:execute': { args: AbilityExecuteArgs; result: EffectDescriptor[] };
    'attack:pre': { args: AttackPreArgs; result: ChainResult };
    'damage:post': { args: DamagePostArgs; result: ChainResult };
    'equipment:post': { args: EquipmentPostArgs; result: ChainResult };
    'status:turn-end': { args: StatusTurnEndArgs; result: ChainResult };
    'step:end': { args: StepEndArgs; result: ChainResult };
    'outcome:decide': { args: OutcomeDecideContext; result: OutcomeVerdict | null };
}
export type HookArgsOf<K extends HookId> = HookContracts[K]['args'];
export type HookResultOf<K extends HookId> = HookContracts[K]['result'];

// ----------------------------------------------------------------------------
// D7 — StepContext and the plugin contract
// ----------------------------------------------------------------------------

// Ref resolution targets for JSON rules (D7): attacker→actor, target→target,
// self→self ?? actor.
export interface StepContextRefs {
    actor: EntityView;
    target?: EntityView;
    self?: EntityView;
}

// Handler context (D7). `depth` is the interpreter/cascade nesting counter
// used for the strike-depth guard (D5a.12) and the maxCascade runaway cap
// (D4f). outcome:decide is the one hook that does NOT receive this context —
// it receives OutcomeDecideContext instead (D5g); handlers there must not use
// rng/emit (engine-enforced, D7).
export interface StepContext {
    rng: RngStream;
    emit(draft: EventDraft): void;
    step: number;
    time: number;                            // integer µs
    hook: HookId;
    depth: number;
    refs: StepContextRefs;
}

// The D7 handler signature. Third `args` parameter carries the per-hook D6
// payload (see header tension note 2); two-parameter handlers remain
// assignable, so every §7 example compiles unchanged. `any` matches the D7
// vocab `params: any` house style; HookArgsOf<K> gives the exact shape.
export type HookHandler = (view: StateView, ctx: StepContext, args: any) => unknown;

// Vocab extension handlers (D7/D8): keys are SHORT names registered under a
// plugin; the JSON-visible type is namespaced(pluginId, name). params = the
// descriptor's fields except `type` (flat convention, see CustomCondition).
export type VocabConditionHandler = (view: StateView, ctx: StepContext, params: any) => boolean;
export type VocabEffectHandler = (view: StateView, ctx: StepContext, params: any) => EffectDescriptor[];

// Plugin vocab block (D7 `vocab?`). Unknown vocab shape ⇒ CombatPluginError
// at load (D7).
export interface CombatVocab {
    conditions?: Record<string, VocabConditionHandler>;
    effects?: Record<string, VocabEffectHandler>;
}

// The plugin contract (D7). Trusted same-bundle code; registered in
// options.plugins order. `overrides` lists the SINGLE-mode hook ids this
// plugin REPLACES — declaring is REQUIRED to ship a single-mode handler
// (undeclared ⇒ load throw); duplicate declared claims are legal and resolve
// last-wins (D6). Chain handlers need no declaration. Kept as string[] per
// the D7 literal so JSON-ish plugin objects compile; T4 validates membership
// in SINGLE_HOOK_IDS at load.
export interface CombatPlugin {
    id: string;                              // unique across the session; '@vendor/name' allowed
    overrides?: string[];
    hooks?: Partial<Record<HookId, HookHandler | HookHandler[]>>;
    vocab?: CombatVocab;
}

// ----------------------------------------------------------------------------
// D5g/D10 — outcomes
// ----------------------------------------------------------------------------

// Verdict returned by outcome:decide (D5g/D10): the engine stamps `step` and
// emits exactly one 'outcome' event. 'fault' is engine-set (D7), not a
// handler verdict in practice.
export interface OutcomeVerdict {
    outcome: 'victory' | 'draw' | 'undecided' | 'fault';
    winner?: string;                         // teamId (teams) or entityId (ffa) on victory
    reason?: string;                         // e.g. 'mutual-destruction' | 'no-enemies' | 'step-limit' (open set)
    error?: string;
}

// Terminal record stored in snapshots (D10): verdict + stamped step.
export type Outcome = OutcomeVerdict & { step: number };

// ----------------------------------------------------------------------------
// D10 — snapshots (plain JSON; no functions, no class instances)
// ----------------------------------------------------------------------------

// Temp stat modifier bookkeeping (D10). remainingTurns counts the TARGET's
// scheduled turns and decrements in status:turn-end (D5c).
export interface StatModifier {
    stat: StatKey;
    amount: number;
    remainingTurns: number;
}

// Pending scheduler entry (D4a/D10): one per living entity, integer µs.
export interface ScheduleEntry {
    entityId: string;
    readyAt: number;
}

// Serialized per-entity state = the public view PLUS the hidden bookkeeping
// (baseStats + modifiers let a restored simulation keep applying/removing
// modifiers; D10). T2: `injuries`/`resources` ride the same additive
// absent-when-empty rule as EntityView; status instances carry their
// materialized `modifiers` so a restore re-derives stats identically without
// a registry lookup (D10 JSON roundtrip holds).
export interface EntitySnapshot extends EntityView {
    baseStats: StatBlock;
    statModifiers: StatModifier[];
}

// The mutable-state half of a snapshot (D10 `state` block).
export interface SnapshotState {
    step: number;
    virtualTime: number;                     // µs (integer)
    rng: RngState;                           // { seed, state, draws } — exact stream position
    entities: EntitySnapshot[];
    schedule: ScheduleEntry[];
    terminal: Outcome | null;                // null while running
}

// Full plain-JSON snapshot (D10). definition is the RESOLVED copy (catalogs
// merged); plugins are NOT serialized — restore requires the same plugin set
// (declared behavior, D10/D4g). JSON roundtrip holds.
export interface SimulationSnapshot {
    schemaVersion: typeof COMBAT_SCHEMA_VERSION;
    definition: BattleDefinition;
    state: SnapshotState;
    events: BattleEvent[];
}

// ----------------------------------------------------------------------------
// D2 — Simulation object, options, validation, errors
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// T3 live-edit contract (CombatantEdit) — a VALIDATED ATOMIC PATCH of one
// combatant applied to the RUNNING battle between turns (Simulation.editCombatant).
// Plain JSON, synchronous, engine-validated with collect-all errors thrown as
// CombatValidationError. On success step/virtualTime/RNG/log are preserved
// (only one `combatant:edited` event is appended); on ANY failure (including
// a plugin-hook throw during scheduler math) the exact prior state/log/RNG
// are rolled back. Terminal and reentrant (inside an executing hook) edits
// are rejected.
// ----------------------------------------------------------------------------

// One gear slot of a gear edit: `id: null` CLEARS the slot; a non-null id
// must resolve to a catalog definition whose kind/slot rules accept the slot,
// with `durability` defaulting to the catalog value (bounded 1..2000).
export interface CombatantGearEdit {
    slot: Slot;
    id: string | null;
    durability?: number;
}

// One status op of a status edit. op 'set' is a DIRECT ADMIN SET: the
// instance is replaced wholesale (stacks default 1, potency default 1,
// duration absent unless provided) — no resistance, no stack-cap refresh
// math, and the definition's per-stack modifiers are materialized when the
// id is registered (unregistered ids stay allowable custom data). op
// 'remove' deletes the instance and carries no extra fields.
export interface CombatantStatusEdit {
    id: string;
    op: 'set' | 'remove';
    stacks?: number;
    duration?: number;
    potency?: number;
}

// Injuries add/remove of a live combatant. Both lists are closed-set
// BodyParts; adding an already-missing part or removing a present part is a
// validation error, so the projected anatomy is always explicit.
export interface CombatantInjuriesEdit {
    add?: BodyPart[];
    remove?: BodyPart[];
}

// One non-health resource pool of a resource edit: EXACT REPLACE of the
// pool, or `null` to REMOVE it. Keys are stamina/mana ONLY — the `energy`
// alias exists for initial battle input only, never in the edit contract.
export interface CombatantResourceEdit {
    current: number;
    max: number;
}

// The full edit shape (frozen shared API with the demo UI worker):
export interface CombatantEdit {
    entityId: string;
    health?: number;                         // clamped into [0, maxHealth]; 0 kills, > 0 revives
    baseStats?: Partial<StatBlock>;           // provided keys replace; baseStats.health IS maxHealth
    gear?: CombatantGearEdit[];
    statuses?: CombatantStatusEdit[];
    injuries?: CombatantInjuriesEdit;
    resources?: Partial<Record<ResourceKey, CombatantResourceEdit | null>>;
}

// The public simulation (D2). Every returned object is a deep copy —
// mutating results never affects engine state. Terminal states are
// idempotent: step/run after terminal return the current snapshot unchanged
// and emit nothing (D5g).
export interface Simulation {
    definition: BattleDefinition;            // resolved deep copy of the input (UI inspection)
    snapshot(): SimulationSnapshot;
    events(): BattleEvent[];                 // log so far (deep copies)
    step(): SimulationSnapshot;              // one scheduled turn + cascade; no-op at terminal
    run(limit?: number): SimulationSnapshot; // steps until terminal or `limit` extra steps
    reset(): SimulationSnapshot;             // rewind to initial state from the stored input copy
    // Live edit (T3): validate + atomically patch one combatant of the
    // RUNNING battle, preserving step/time/RNG/log; returns the post-edit
    // snapshot. Throws CombatValidationError on any rejected field, a
    // terminal battle, a reentrant call, or a plugin-hook throw (rolled back).
    editCombatant(edit: CombatantEdit): SimulationSnapshot;
    isTerminal(): boolean;
    outcome(): Outcome | null;               // null while running
}

// Construction options (D2) — all optional (header tension note 1).
// builtinRules === false drops the default floor (D5); restore rebuilds exact
// state including the RNG position (D10).
export interface SimulationOptions {
    plugins?: CombatPlugin[];
    builtinRules?: boolean;
    restore?: SimulationSnapshot;
}

// Soft validation result for UI pre-checks (D2): all errors collected, never
// throws. createSimulation throws CombatValidationError with the same list.
export interface CombatValidation {
    valid: boolean;
    errors: string[];
}

// Fail-fast construction errors (D2/D7): both carry the full collected error
// list. Defined here (not in validation.ts/plugins.ts) so every module and
// the barrel share ONE class identity. Exported type-only from the barrel per
// D2; still runtime-throwable from any module via this file.
export class CombatValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]) {
        super(`combat validation failed: ${errors.join('; ')}`);
        this.name = 'CombatValidationError';
        this.errors = errors;
    }
}

export class CombatPluginError extends Error {
    readonly errors: string[];
    constructor(errors: string[]) {
        super(`combat plugin error: ${errors.join('; ')}`);
        this.name = 'CombatPluginError';
        this.errors = errors;
    }
}

// Function-type contracts for the two public entrypoints (implementations
// land in engine.ts T5 and validation.ts T2; pinned here so the barrel and
// interactive consumers (e.g. the mock-battle UI) share one signature).
// createSimulation options are optional (D1).
export type CreateSimulation = (input: BattleDefinition, options?: SimulationOptions) => Simulation;
export type ValidateBattleDefinition = (input: unknown) => CombatValidation;

// ----------------------------------------------------------------------------
// D13 — defaults and bounds (single source of truth; pinned by tests).
// Every number below is copied verbatim from the D13 table / D3 validation
// ranges / D5 formulas so validation (T2), scheduler (T3) and rules (T5)
// cannot drift.
// ----------------------------------------------------------------------------

// --- scheduler (D4a/D4b) ---
export const SCHEDULER_SCALE_US = 1_000_000;      // virtual time scale: 1s = 1e6 µs
export const MIN_INTERVAL_US = 1;                 // interval floor (D4b max(1, …))
export const EFFECTIVE_SPEED_FLOOR = 0.001;       // runtime clamp (D4b)
export const DEFAULT_ACTION_COST = 1;             // basic attack / wait (D4b/D13)

// --- rng (D3/D4g) ---
export const DEFAULT_SEED = 1;                    // startingConditions.seed default
export const MIN_SEED = 0;
export const MAX_SEED = 4_294_967_295;            // 2^32 − 1

// --- simulation config (D3/D13) ---
export const DEFAULT_MAX_STEPS = 10_000;
export const MIN_MAX_STEPS = 1;
export const MAX_MAX_STEPS = 1_000_000;
export const DEFAULT_MAX_CASCADE = 1_000;
export const MIN_MAX_CASCADE = 1;
export const MAX_MAX_CASCADE = 100_000;
export const DEFAULT_MAX_LOG_EVENTS = 100_000;
export const MIN_MAX_LOG_EVENTS = 1;
export const MAX_MAX_LOG_EVENTS = 1_000_000;

// --- entity stat bounds (D3 validation) ---
export const MIN_HEALTH = 1;                      // integer
export const MAX_HEALTH = 100_000;
export const MIN_STRENGTH = 0;
export const MAX_STRENGTH = 1_000;
export const MIN_SPEED = 0.1;                     // zero/negative/NaN ⇒ error
export const MAX_SPEED = 100;
export const MIN_DEFENSE = 0;
export const MAX_DEFENSE = 1_000;
export const MIN_PRECISION = 0;
export const MAX_PRECISION = 1_000;
export const MIN_EVASION = 0;
export const MAX_EVASION = 1_000;

// --- status instances (D3/D5c/D13) ---
export const MIN_STATUS_STACKS = 1;
export const MAX_STATUS_STACKS = 9;               // stack cap (D5c min(stacks+added, 9))
export const MIN_STATUS_DURATION = 1;
export const MIN_STATUS_POTENCY = 1;

// --- abilities (D4b/D9) ---
export const MIN_ABILITY_COST = 0.25;
export const MAX_ABILITY_COST = 10;
export const DEFAULT_ABILITY_COST = 1;
export const MIN_ABILITY_COOLDOWN = 0;
export const DEFAULT_ABILITY_COOLDOWN = 0;

// --- gear (D3/D9) ---
export const MIN_GEAR_DAMAGE = 0;
export const MAX_GEAR_DAMAGE = 1_000;
export const MIN_GEAR_DURABILITY = 1;             // integer
export const MAX_GEAR_DURABILITY = 2_000;
export const MIN_RESISTANCE = 0;                  // blunt/sharp fractions
export const MAX_RESISTANCE = 1;

// --- default rule formulas (D5a/D5b/D5c — verbatim constants) ---
export const UNARMED_BASE_DAMAGE = 1;             // D5a.7/D5d
export const STRENGTH_FACTOR_PER_POINT = 0.05;    // raw × (1 + 0.05 × strength)
export const BASE_DODGE_CHANCE = 0.05;            // D5a.5
export const DODGE_CHANCE_PER_POINT = 0.005;      // × (evasion − precision)
export const DODGE_CHANCE_CAP = 0.75;
export const CRIT_CHANCE = 0.05;                  // D5a.6
export const CRIT_MULTIPLIER = 1.5;
export const SHIELD_BLOCK_CHANCE = 0.15;          // D5a.8
export const BLOCK_MULTIPLIER = 0.5;              // blocked ⇒ ×0.5 (crit+block ⇒ ×0.75)
export const ARMOUR_MITIGATION_FLOOR = 0.1;       // Π(1−resist) floored at ×0.1 (90% cap)
export const DEFENSE_DIVISOR_BASE = 100;          // × 100 / (100 + defense)
export const MIN_LANDED_DAMAGE = 1;               // "hits always hurt" (D5a.8)
export const DURABILITY_LOSS_PER_HIT = 1;         // D5b: weapon −1 / each contributing piece −1

// --- interpreter + plugin bounds (D7/D8/D5a.12) ---
export const MAX_RULE_DEPTH = 16;                 // condition nesting
export const MAX_RULE_LIST = 32;                  // all/any/of + effects list caps
export const MAX_STRIKE_DEPTH = 2;                // strike recursion, exceeding ⇒ fault
export const MAX_HOOK_HANDLERS = 32;              // handler list bound per hook (D7)

// --- T2: resources + skill costs (R3) ---
export const MIN_RESOURCE_VALUE = 0;              // pools, currents and costs: ≥ 0
export const MAX_RESOURCE_VALUE = 1_000_000;      // pool maxima and single-cost ceiling

// --- T2: status definitions (R1) ---
export const MIN_STATUS_MODIFIER = -1_000;        // per-stack modifier magnitude bounds
export const MAX_STATUS_MODIFIER = 1_000;
export const MIN_STATUS_TICK_VALUE = 0;           // tick damage/heal per stack
export const MAX_STATUS_TICK_VALUE = 100_000;
export const MIN_SKIP_CHANCE = 0;                 // skipChancePerStack fraction
export const MAX_SKIP_CHANCE = 1;

// --- T2: injury derivation constants (R2) ---
// Missing LEGS multiply movement speed (multiplicative so the penalty scales
// with the entity's own speed): each missing leg ×0.75 — two missing legs
// ⇒ ×0.5625. The EFFECTIVE_SPEED_FLOOR still clamps the final result.
export const INJURY_LEG_SPEED_FACTOR = 0.75;
// Missing EYES subtract flat precision per eye (conservative, meaningful at
// the common 0..10 precision scale: −2 per missing eye).
export const INJURY_EYE_PRECISION_PENALTY = 2;
// Missing EARS subtract flat evasion per ear (situational awareness) —
// conservative documented effect. NOSE deliberately has NO derived effect
// (no invented severe penalties; represented only in snapshots/events).
export const INJURY_EAR_EVASION_PENALTY = 1;
