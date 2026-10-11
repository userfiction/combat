export declare const COMBAT_SCHEMA_VERSION = 1;
export declare const STAT_KEYS: readonly ["health", "strength", "speed", "defense", "precision", "evasion"];
export type StatKey = (typeof STAT_KEYS)[number];
export declare const HOOK_IDS: readonly ["scheduler:interval", "scheduler:order", "action:select", "target:select", "attack:dodge", "attack:crit", "damage:base", "damage:mitigate", "ability:execute", "attack:pre", "damage:post", "equipment:post", "status:turn-end", "step:end", "outcome:decide"];
export type HookId = (typeof HOOK_IDS)[number];
export declare const SINGLE_HOOK_IDS: readonly ["scheduler:interval", "scheduler:order", "action:select", "target:select", "attack:dodge", "attack:crit", "damage:base", "damage:mitigate", "ability:execute", "outcome:decide"];
export type SingleHookId = (typeof SINGLE_HOOK_IDS)[number];
export declare const CHAIN_HOOK_IDS: readonly ["attack:pre", "damage:post", "equipment:post", "status:turn-end", "step:end"];
export type ChainHookId = (typeof CHAIN_HOOK_IDS)[number];
export declare const DAMAGE_TYPES: readonly ["blunt", "sharp"];
export type DamageType = (typeof DAMAGE_TYPES)[number];
export type EffectDamageType = DamageType | 'true';
export declare const GEAR_KINDS: readonly ["weapon", "armour"];
export type GearKind = (typeof GEAR_KINDS)[number];
export declare const SLOTS: readonly ["weapon-1", "weapon-2", "shield", "head", "body", "hands", "feet"];
export type Slot = (typeof SLOTS)[number];
export type BattleMode = 'ffa' | 'teams';
export type StatCompareOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
export interface StatInput {
    health: number;
    strength: number;
    speed: number;
    defense?: number;
    precision?: number;
    evasion?: number;
}
export type StatBlock = Required<StatInput>;
export interface StatusInstance {
    id: string;
    stacks?: number;
    duration?: number;
    potency?: number;
}
export interface GearRef {
    id: string;
    slot: Slot;
    durability?: number;
}
export interface EquipmentLoadout {
    weapons?: GearRef[];
    armour?: GearRef[];
}
export interface EntityDefinition {
    id: string;
    name?: string;
    team?: string;
    stats: StatInput;
    statuses?: StatusInstance[];
    equipment?: EquipmentLoadout;
    abilities?: string[];
    statusResistances?: Record<string, number>;
}
export interface TeamDefinition {
    id: string;
    name?: string;
    members: string[];
}
export interface SimulationConfig {
    maxSteps?: number;
    maxCascade?: number;
    maxLogEvents?: number;
}
export type ResolvedSimulationConfig = Required<SimulationConfig>;
export interface GearDefinition {
    id: string;
    name?: string;
    kind: GearKind;
    slot: Slot;
    handedness: 0 | 1 | 2;
    type: DamageType;
    damage: number;
    blunt: number;
    sharp: number;
    durability: number;
}
export interface AbilityDefinition {
    id: string;
    name?: string;
    cost?: number;
    cooldown?: number;
    conditions?: Condition;
    effects: EffectDescriptor[];
}
export interface GearCatalogSection {
    gear?: GearDefinition[];
    abilities?: AbilityDefinition[];
}
export interface StartingConditions {
    seed?: number;
    config?: SimulationConfig;
}
export interface BattleRules {
    contributions?: DeclarativeRule[];
}
export interface BattleDefinition {
    schemaVersion: typeof COMBAT_SCHEMA_VERSION;
    name?: string;
    mode: BattleMode;
    teams?: TeamDefinition[];
    entities: EntityDefinition[];
    catalogs?: GearCatalogSection;
    startingConditions?: StartingConditions;
    rules?: BattleRules;
}
export type Ref = 'attacker' | 'target' | 'self';
export type CustomTypeId = `${string}/${string}`;
export interface CustomCondition {
    type: CustomTypeId;
    [param: string]: unknown;
}
export interface CustomEffect {
    type: CustomTypeId;
    [param: string]: unknown;
}
export type Condition = {
    type: 'always';
} | {
    type: 'never';
} | {
    type: 'stat';
    ref: Ref;
    stat: StatKey;
    op: StatCompareOp;
    value: number;
} | {
    type: 'has-status';
    ref: Ref;
    status: string;
} | {
    type: 'has-gear';
    ref: Ref;
    kind?: GearKind;
    slot?: Slot;
} | {
    type: 'mode';
    is: BattleMode;
} | {
    type: 'chance';
    p: number;
} | {
    type: 'all';
    of: Condition[];
} | {
    type: 'any';
    of: Condition[];
} | {
    type: 'not';
    of: Condition;
} | CustomCondition;
export type EffectDescriptor = {
    type: 'strike';
} | {
    type: 'damage-flat';
    target: Ref;
    amount: number;
    damageType?: EffectDamageType;
} | {
    type: 'heal';
    target: Ref;
    amount: number;
} | {
    type: 'apply-status';
    target: Ref;
    status: string;
    stacks?: number;
    duration?: number;
    potency?: number;
} | {
    type: 'remove-status';
    target: Ref;
    status: string;
} | {
    type: 'break-equipment';
    target: Ref;
    slot?: Slot;
} | {
    type: 'modify-stat';
    target: Ref;
    stat: StatKey;
    amount: number;
    duration?: number;
} | {
    type: 'emit';
    message: string;
} | CustomEffect;
export interface DeclarativeRule {
    id: string;
    hook: ChainHookId;
    when?: Condition;
    effects: EffectDescriptor[];
}
export type KnownEventType = 'battle:start' | 'turn:start' | 'action' | 'dodge' | 'crit' | 'block' | 'damage' | 'heal' | 'status:applied' | 'status:resisted' | 'status:tick' | 'status:expired' | 'stat:modified' | 'stat:expired' | 'gear:damaged' | 'gear:broken' | 'death' | 'log-trimmed' | 'step:end' | 'outcome' | 'fault';
export interface EventDraft {
    type: string;
    actor?: string;
    target?: string;
    message?: string;
    payload?: Record<string, unknown>;
}
export interface BattleEvent extends EventDraft {
    id: number;
    step: number;
    time: number;
}
export interface RngStream {
    next(): number;
    int(maxExclusive: number): number;
    pick<T>(array: readonly T[]): T | undefined;
}
export interface RngState {
    seed: number;
    state: number;
    draws: number;
}
export interface EquipmentEntry {
    gearId: string;
    slot: Slot;
    durability: number;
}
export interface EntityView {
    id: string;
    name: string;
    team?: string;
    order: number;
    living: boolean;
    health: number;
    maxHealth: number;
    stats: StatBlock;
    statuses: StatusInstance[];
    equipment: EquipmentEntry[];
    cooldowns: Record<string, number>;
}
export interface StateView {
    mode: BattleMode;
    step: number;
    time: number;
    entities: EntityView[];
}
export interface SchedulerIntervalArgs {
    entityId: string;
    actionCost: number;
    effectiveSpeed: number;
}
export interface ScheduleCandidate {
    entityId: string;
    readyAt: number;
    effectiveSpeed: number;
    order: number;
}
export interface SchedulerOrderArgs {
    candidates: ScheduleCandidate[];
}
export type ActionKind = 'attack' | 'ability' | 'wait' | 'skip';
export interface ActionSelection {
    kind: ActionKind;
    abilityId?: string;
    reason?: string;
}
export interface ActionSelectArgs {
    actor: EntityView;
}
export interface TargetSelectArgs {
    actor: EntityView;
    action: ActionSelection;
}
export interface AttackRollArgs {
    attacker: EntityView;
    target: EntityView;
    weapon?: EquipmentEntry;
}
export interface DodgeResult {
    dodged: boolean;
}
export interface CritResult {
    crit: boolean;
}
export interface BaseDamageResult {
    amount: number;
    damageType: DamageType;
}
export interface DamageMitigateArgs {
    attacker: EntityView;
    target: EntityView;
    amount: number;
    damageType: DamageType;
}
export interface MitigationResult {
    amount: number;
    blocked: boolean;
    armourFactor: number;
    defenseFactor: number;
}
export interface AbilityExecuteArgs {
    actor: EntityView;
    target?: EntityView;
    ability: AbilityDefinition;
}
export interface AttackPreArgs {
    actor: EntityView;
    target?: EntityView;
    weapon?: EquipmentEntry;
}
export interface DamagePostArgs {
    amount: number;
    killed: boolean;
    attacker?: EntityView;
    target?: EntityView;
    damageType?: DamageType;
}
export interface EquipmentPostArgs {
    attacker?: EntityView;
    target?: EntityView;
    weapon?: EquipmentEntry;
    damageType?: DamageType;
    contributedArmour?: EquipmentEntry[];
}
export interface StatusTurnEndArgs {
    entity: EntityView;
}
export interface StepEndArgs {
    step: number;
    time: number;
}
export interface OutcomeDecideContext {
    step: number;
    time: number;
    config: ResolvedSimulationConfig;
}
export type ChainResult = void | EffectDescriptor[];
export interface HookContracts {
    'scheduler:interval': {
        args: SchedulerIntervalArgs;
        result: number;
    };
    'scheduler:order': {
        args: SchedulerOrderArgs;
        result: string;
    };
    'action:select': {
        args: ActionSelectArgs;
        result: ActionSelection;
    };
    'target:select': {
        args: TargetSelectArgs;
        result: string | null;
    };
    'attack:dodge': {
        args: AttackRollArgs;
        result: DodgeResult;
    };
    'attack:crit': {
        args: AttackRollArgs;
        result: CritResult;
    };
    'damage:base': {
        args: AttackRollArgs;
        result: BaseDamageResult;
    };
    'damage:mitigate': {
        args: DamageMitigateArgs;
        result: MitigationResult;
    };
    'ability:execute': {
        args: AbilityExecuteArgs;
        result: EffectDescriptor[];
    };
    'attack:pre': {
        args: AttackPreArgs;
        result: ChainResult;
    };
    'damage:post': {
        args: DamagePostArgs;
        result: ChainResult;
    };
    'equipment:post': {
        args: EquipmentPostArgs;
        result: ChainResult;
    };
    'status:turn-end': {
        args: StatusTurnEndArgs;
        result: ChainResult;
    };
    'step:end': {
        args: StepEndArgs;
        result: ChainResult;
    };
    'outcome:decide': {
        args: OutcomeDecideContext;
        result: OutcomeVerdict | null;
    };
}
export type HookArgsOf<K extends HookId> = HookContracts[K]['args'];
export type HookResultOf<K extends HookId> = HookContracts[K]['result'];
export interface StepContextRefs {
    actor: EntityView;
    target?: EntityView;
    self?: EntityView;
}
export interface StepContext {
    rng: RngStream;
    emit(draft: EventDraft): void;
    step: number;
    time: number;
    hook: HookId;
    depth: number;
    refs: StepContextRefs;
}
export type HookHandler = (view: StateView, ctx: StepContext, args: any) => unknown;
export type VocabConditionHandler = (view: StateView, ctx: StepContext, params: any) => boolean;
export type VocabEffectHandler = (view: StateView, ctx: StepContext, params: any) => EffectDescriptor[];
export interface CombatVocab {
    conditions?: Record<string, VocabConditionHandler>;
    effects?: Record<string, VocabEffectHandler>;
}
export interface CombatPlugin {
    id: string;
    overrides?: string[];
    hooks?: Partial<Record<HookId, HookHandler | HookHandler[]>>;
    vocab?: CombatVocab;
}
export interface OutcomeVerdict {
    outcome: 'victory' | 'draw' | 'undecided' | 'fault';
    winner?: string;
    reason?: string;
    error?: string;
}
export type Outcome = OutcomeVerdict & {
    step: number;
};
export interface StatModifier {
    stat: StatKey;
    amount: number;
    remainingTurns: number;
}
export interface ScheduleEntry {
    entityId: string;
    readyAt: number;
}
export interface EntitySnapshot extends EntityView {
    baseStats: StatBlock;
    statModifiers: StatModifier[];
}
export interface SnapshotState {
    step: number;
    virtualTime: number;
    rng: RngState;
    entities: EntitySnapshot[];
    schedule: ScheduleEntry[];
    terminal: Outcome | null;
}
export interface SimulationSnapshot {
    schemaVersion: typeof COMBAT_SCHEMA_VERSION;
    definition: BattleDefinition;
    state: SnapshotState;
    events: BattleEvent[];
}
export interface Simulation {
    definition: BattleDefinition;
    snapshot(): SimulationSnapshot;
    events(): BattleEvent[];
    step(): SimulationSnapshot;
    run(limit?: number): SimulationSnapshot;
    reset(): SimulationSnapshot;
    isTerminal(): boolean;
    outcome(): Outcome | null;
}
export interface SimulationOptions {
    plugins?: CombatPlugin[];
    builtinRules?: boolean;
    restore?: SimulationSnapshot;
}
export interface CombatValidation {
    valid: boolean;
    errors: string[];
}
export declare class CombatValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
export declare class CombatPluginError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
export type CreateSimulation = (input: BattleDefinition, options?: SimulationOptions) => Simulation;
export type ValidateBattleDefinition = (input: unknown) => CombatValidation;
export declare const SCHEDULER_SCALE_US = 1000000;
export declare const MIN_INTERVAL_US = 1;
export declare const EFFECTIVE_SPEED_FLOOR = 0.001;
export declare const DEFAULT_ACTION_COST = 1;
export declare const DEFAULT_SEED = 1;
export declare const MIN_SEED = 0;
export declare const MAX_SEED = 4294967295;
export declare const DEFAULT_MAX_STEPS = 10000;
export declare const MIN_MAX_STEPS = 1;
export declare const MAX_MAX_STEPS = 1000000;
export declare const DEFAULT_MAX_CASCADE = 1000;
export declare const MIN_MAX_CASCADE = 1;
export declare const MAX_MAX_CASCADE = 100000;
export declare const DEFAULT_MAX_LOG_EVENTS = 100000;
export declare const MIN_MAX_LOG_EVENTS = 1;
export declare const MAX_MAX_LOG_EVENTS = 1000000;
export declare const MIN_HEALTH = 1;
export declare const MAX_HEALTH = 100000;
export declare const MIN_STRENGTH = 0;
export declare const MAX_STRENGTH = 1000;
export declare const MIN_SPEED = 0.1;
export declare const MAX_SPEED = 100;
export declare const MIN_DEFENSE = 0;
export declare const MAX_DEFENSE = 1000;
export declare const MIN_PRECISION = 0;
export declare const MAX_PRECISION = 1000;
export declare const MIN_EVASION = 0;
export declare const MAX_EVASION = 1000;
export declare const MIN_STATUS_STACKS = 1;
export declare const MAX_STATUS_STACKS = 9;
export declare const MIN_STATUS_DURATION = 1;
export declare const MIN_STATUS_POTENCY = 1;
export declare const MIN_ABILITY_COST = 0.25;
export declare const MAX_ABILITY_COST = 10;
export declare const DEFAULT_ABILITY_COST = 1;
export declare const MIN_ABILITY_COOLDOWN = 0;
export declare const DEFAULT_ABILITY_COOLDOWN = 0;
export declare const MIN_GEAR_DAMAGE = 0;
export declare const MAX_GEAR_DAMAGE = 1000;
export declare const MIN_GEAR_DURABILITY = 1;
export declare const MAX_GEAR_DURABILITY = 2000;
export declare const MIN_RESISTANCE = 0;
export declare const MAX_RESISTANCE = 1;
export declare const UNARMED_BASE_DAMAGE = 1;
export declare const STRENGTH_FACTOR_PER_POINT = 0.05;
export declare const BASE_DODGE_CHANCE = 0.05;
export declare const DODGE_CHANCE_PER_POINT = 0.005;
export declare const DODGE_CHANCE_CAP = 0.75;
export declare const CRIT_CHANCE = 0.05;
export declare const CRIT_MULTIPLIER = 1.5;
export declare const SHIELD_BLOCK_CHANCE = 0.15;
export declare const BLOCK_MULTIPLIER = 0.5;
export declare const ARMOUR_MITIGATION_FLOOR = 0.1;
export declare const DEFENSE_DIVISOR_BASE = 100;
export declare const MIN_LANDED_DAMAGE = 1;
export declare const DURABILITY_LOSS_PER_HIT = 1;
export declare const FEAR_SKIP_CHANCE_PER_STACK = 0.25;
export declare const MAX_RULE_DEPTH = 16;
export declare const MAX_RULE_LIST = 32;
export declare const MAX_STRIKE_DEPTH = 2;
export declare const MAX_HOOK_HANDLERS = 32;
