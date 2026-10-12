# @userfiction/combat

Deterministic, synchronous combat engine for User Fiction. Plain TypeScript,
zero dependencies: integer-microsecond virtual-time scheduling (D4), a single
shared Mulberry32 RNG stream (D4g), hook-based plugin overrides (D6/D7) and
plain-JSON snapshots that restore bit-identically (D10).

## Import

Everything is exported from the package root (`src/index.ts` owns the list;
the root `index.ts` forwards to it):

```ts
import {
    // facade
    userCombat, createUserCombat,
    // direct engine
    createSimulation,
    // factories + helpers
    validateBattleDefinition, defaultRules, createGearCatalog, defaultGearSeed,
    defaultStatusSeed,
    renderEventText,
    // T2 vocabularies
    BODY_PARTS, RESOURCE_KEYS, STATUS_DECAY_MODES,
    INJURY_LEG_SPEED_FACTOR, INJURY_EYE_PRECISION_PENALTY, INJURY_EAR_EVASION_PENALTY,
    // errors (values — catch with instanceof)
    CombatValidationError, CombatPluginError,
} from '@userfiction/combat';

import type { BattleDefinition, SimulationSnapshot, StatusDefinition, BodyPart, ResourceCost } from '@userfiction/combat';
```

## The `userCombat` facade

`userCombat` is a ready-to-configure chainable builder; `createUserCombat()`
returns an isolated builder with the same API for battles that must not share
state.

```ts
// Root entry, shared singleton — configuration accumulates on it.
import { userCombat } from '@userfiction/combat';

const snapshot = await userCombat
    .actors([
        { id: 'knight', stats: { health: 30, strength: 8, speed: 1, defense: 3 } },
        { id: 'brute', stats: { health: 40, strength: 10, speed: 1 } },
    ])
    .gears([  // equipments() is the deprecated identical alias
        { id: 'longsword', kind: 'weapon', slot: 'weapon-1', handedness: 1, type: 'sharp', damage: 6, blunt: 0, sharp: 0, durability: 12 },
    ])
    .skills([  // identical to abilities()
        { id: 'shove', effects: [{ type: 'emit', message: 'shoved' }], costs: { stamina: 2 } },
    ])
    .ailments([{ id: 'bleeding', tick: { damage: 2 } }])   // register — never applies anything
    .buff([{ id: 'blessed', decay: 'duration', modifiers: { defense: 2 } }])
    .config({ maxSteps: 5_000 })   // merges; unset keys keep engine defaults
    .seed(7)
    .simulate();                    // resolves with ONE engine step's snapshot
```

```ts
// Isolated factory — fresh builder, engine defaults, zero shared state.
import { createUserCombat } from '@userfiction/combat';

const battle = createUserCombat()
    .actors([
        { id: 'a', stats: { health: 5, strength: 100, speed: 1 } },
        { id: 'b', stats: { health: 5, strength: 0, speed: 1 } },
    ])
    .seed(3);

while (!battle.isTerminal()) {
    await battle.simulate();        // each await advances exactly one step
}
console.log(battle.outcome());      // { outcome: 'victory', winner: 'a', step: 3 }
```

### Lifecycle

1. **Lazy engine** — no `Simulation` exists until the first access
   (`simulate`/`snapshot`/`events`/`reset`/`isTerminal`/`outcome`). Creation
   runs the engine's own fail-fast validation, so configuration errors are
   `CombatValidationError`s (catch with `instanceof`).
2. **Deterministic invalidation** — every setter marks the built battle
   stale; the next access rebuilds from scratch. Same accumulated
   configuration + seed ⇒ a bit-identical fresh battle; prior progress is
   discarded.
3. **One step per await** — `simulate()` is one synchronous
   `Simulation.step()` (one scheduled turn + cascade) wrapped in a promise.
   At terminal it is idempotent: it returns the current snapshot unchanged
   and emits nothing.
4. **Failure split** — observation methods throw synchronously;
   `simulate()` rejects with the same error class.

### Configuration semantics

| Setter | Semantics |
| --- | --- |
| `actors` / `gears` (alias `equipments`) / `abilities` (alias `skills`) / `teams` / `plugins` | REPLACES the list (last call wins); stored as a copy |
| `ailments` / `buff` | REGISTER status definitions — they ACCUMULATE into one status registry (two doors, one catalog); re-registering an id replaces it. They never apply statuses to actors |
| `config` | MERGES keys into the accumulated config; keys never set stay absent so engine defaults apply (`maxSteps` 10 000, `maxCascade` 1 000, `maxLogEvents` 100 000) |
| `seed` / `mode` / `builtinRules` | scalar replace; `mode` defaults `'ffa'`, `builtinRules` stays unset (engine default `true`) |

`gears()`/`skills()` fill `definition.catalogs` — actor
`equipment`/`abilities` loadout fields stay on the actors exactly as in a
hand-written `BattleDefinition` (the intuitive actor `skills` alias of
`abilities` is accepted; presenting both is a validation error).

The **singleton accumulates configuration across battles** — re-set only what
you change, and pass every key a battle depends on (a previous `config()`
merge persists until overridden). For isolated battles use
`createUserCombat()`.

Not exposed by the facade: restore snapshots, declarative JSON rule
contributions, definition `name` — use `createSimulation(input, options)`
directly for the full `BattleDefinition` surface.

## Ailments, buffs, resources and injuries (T2)

**Status definitions (R1).** `ailments(...)`/`buff(...)` and
`catalogs.statuses` REGISTER `StatusDefinition`s that patch over a builtin
seed (`defaultStatusSeed`: `fearful`, `poisoned`, `bleeding`, `burned`,
`blinded` + the beneficial `blessed`/`hasted`). Actor statuses stay
`StatusInstance` references that effects apply/remove — registration is inert
by itself. The turn engine consults the resolved registry:

```ts
// per own turn, in order: tick (× stacks) → decay → expiry
{ id: 'bleeding', decay: 'duration', tick: { damage: 2 } }
// per-stack modifiers derived centrally: re-application re-scales, removal
// reverses — never accumulates
{ id: 'sharpened', decay: 'duration', modifiers: { precision: 3 } }
// fear-style gating at action:select (roll rng < chance × stacks)
{ id: 'screaming', decay: 'stacks', skipChancePerStack: 0.25 }
```

Legacy `fear`/`poison`/`stun` keep their exact hardcoded semantics while no
client definition overrides those ids; defining one deliberately replaces the
legacy behavior. All effects stay declarative/JSON-safe, bounded by
validation, with the plugin `vocab` escape path unchanged.

**Resource pools and skill costs (R3).** Actors carry
`resources: { stamina?: { current, max }, mana?: { current, max }, energy? }`
(`energy` is an input alias of stamina; both at once is a validation error).
Skills price themselves with `costs: { health?, stamina?, mana?, energy? }` —
scheduler TIME stays in `cost`. Health costs spend the EXISTING health and
can never self-kill (`health > cost` enforced at the gate and at payment);
payment happens once, inside the step transaction, with a recheck for
plugin-selected skills (unaffordable ⇒ fault + rollback). The default
selector excludes unaffordable abilities (fallback ladder). Pools never
regenerate — `{ type: 'modify-resource' }` is the explicit restore/spend.

**Body injuries (R2).** Actors may start with `injuries` (closed set:
left/right arms, legs, eyes, ears, nose). The declarative
`{ type: 'apply-injury' }` effect removes parts (idempotent, event-visible);
`{ type: 'heal-injury' }` is the only restore path — the vague `heal` effect
never regrows. Ordinary attacks NEVER amputate: injuries happen only where a
skill/effect declares them. Derivation is central: each missing leg
multiplies speed by `0.75`, each missing eye −2 precision, each missing ear
−1 evasion; two-handed gear requires both arms, any weapon or shield at
least one (runtime losses make gear inert, never dropped; incoherent initial
loadouts are validation errors).

## Direct engine API

```ts
import { createSimulation, defaultRules } from '@userfiction/combat';

const sim = createSimulation(definition, {
    plugins: [defaultRules(), myPlugin], // explicit floor usage is normalized
    builtinRules: true,                  // false drops the default rules floor
});
const afterOneTurn = sim.step();          // synchronous core
const final = sim.run();                  // steps until terminal
const restored = createSimulation(definition, { restore: JSON.parse(JSON.stringify(sim.snapshot())) });
```

The core is synchronous by design (D1); only the facade's `simulate()` adds
an async step boundary. See `src/engine/engine.ts` (construction), `src/engine/pipeline.ts`
(one turn = one scheduled entry + cascade, fault rollback), `src/contract/types.ts`
(every contract, D2–D13) for the full engine documentation.
