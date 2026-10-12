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

import type { BattleDefinition, SimulationSnapshot, StatusDefinition, BodyPart, ResourceCost, CombatantEdit } from '@userfiction/combat';
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
5. **Live edits** — `editCombatant(edit)` is the one synchronous mutator
   that is NOT a setter: it patches the current battle in place without
   invalidating it (see the "Live combatant edits" section below).

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

**Status definitions (R1, canonical).** `ailments(...)`/`buff(...)` and
`catalogs.statuses` REGISTER `StatusDefinition`s that patch over a builtin
seed (`defaultStatusSeed`: the canonical `fearful`, `poisoned`, `stunned`,
plus `bleeding`, `burned`, `blinded` and the beneficial `blessed`/`hasted`).
Actor statuses stay `StatusInstance` references that effects apply/remove —
registration is inert by itself. The turn engine consults the resolved
registry and is STRICTLY definition-driven — there are NO hardcoded
per-id status branches:

```ts
// per own turn, in order: tick (× stacks) → decay → expiry
{ id: 'poisoned', decay: 'duration', tick: { damage: 1 } }
// per-stack modifiers derived centrally: re-application re-scales, removal
// reverses — never accumulates
{ id: 'blinded', decay: 'duration', modifiers: { precision: -2 } }
// skip gating at action:select (roll rng < chance × stacks, one draw)
{ id: 'fearful', decay: 'stacks', skipChancePerStack: 0.25 }
// canonical stun: the roll ALWAYS skips while it lasts (the draw is
// accepted) and duration decay expires it
{ id: 'stunned', decay: 'duration', skipChancePerStack: 1 }
```

The id vocabulary is OPEN: any other id remains allowable custom data with
NO built-in semantics — inert bookkeeping until a definition (or plugin)
gives it behavior. Damage-over-time events render generically by their own
source id (`… suffers <statusId> for N true damage`).

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

## Live combatant edits (`editCombatant`, T3)

While a battle is RUNNING (and not terminal), you can patch one combatant
atomically BETWEEN turns — synchronously, with step/virtualTime/RNG/log
fully preserved:

```ts
sim.editCombatant({
    entityId: 'brute',
    health: 30,                                          // clamped into [0, maxHealth]
    baseStats: { speed: 4 },                             // provided keys replace; baseStats.health IS maxHealth
    gear: [{ slot: 'weapon-1', id: 'longsword', durability: 12 },
           { slot: 'shield', id: null }],                // id null clears the slot
    statuses: [{ id: 'stunned', op: 'set', duration: 2 },   // DIRECT admin set (no resistance,
              { id: 'bleeding', op: 'remove' }],          //   no accumulation; definition modifiers
                                                          //   materialize; unregistered ids stay custom data)
    injuries: { add: ['left-leg'], remove: ['nose'] },   // strict add/remove coherence
    resources: { mana: { current: 3, max: 9 }, stamina: null }, // exact replace / remove
});                                                      // → SimulationSnapshot
```

Semantics pinned by `src/engine/editCombatant.test.ts`:

- **Validated atomic patch** — every field is validated first (bounds,
  catalogs, the PROJECTED equipment × injuries for hands/two-handed/anatomy
  rules) and ALL errors are collected into one `CombatValidationError`
  (thrown synchronously; the UI prints `error.errors` verbatim). A failed
  edit changes NOTHING — not even the log.
- **Scheduler-consistent** — a speed change (base stats, status modifiers,
  missing legs) reschedules the entity's pending entry with the D4e
  proportional-remaining-work rule through the ACTIVE `scheduler:interval`
  hook; an unchanged speed never recomputes the entry. Health 0 drops the
  schedule entry (death); health > 0 on a dead combatant revives it with the
  next entry at `now + default interval`. The outcome is recomputed by the
  existing `outcome:decide` at the next step — including the ALL-dead
  empty-schedule case (the next `simulate()`/`step()` decides instead of
  returning no-progress).
- **Preservation** — step, virtualTime, RNG position and existing event ids
  are untouched; success appends exactly ONE `combatant:edited` event whose
  payload names every touched domain. No step increment. A plugin-hook throw
  inside the edit (e.g. a replaced `scheduler:interval` faulting during
  revival/reschedule math) rolls state/log/RNG back exactly and surfaces as
  `CombatValidationError`.
- **Rejections** — terminal battles and reentrant calls (an edit attempted
  from inside an executing plugin hook) are rejected outright.
- **Lifecycle (R4)** — `reset()` discards edits (they are battle STATE, the
  stored definition is untouched); a facade setter rebuild discards them;
  a JSON snapshot `restore` RETAINS them (the snapshot carries the edited
  state).
- **Facade** — `userCombat.editCombatant(edit)` has the same synchronous
  signature as the engine's and, unlike every setter, does NOT mark the
  builder stale: the next `simulate()` continues the SAME battle with the
  adjustments applied.

**UI distinction:** the demo's Advanced definition editor (and any
`actors()`-style reconfiguration) builds a NEW battle — that is the
"restart" path. The live edit is the "between turns, without restarting"
path: it mutates the running battle in place and the next step uses the
adjustments.

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

## Interactive demo (`demo/`)

A vanilla TS/HTML/CSS single-page demo lives in `demo/` (no frameworks, no
backend — the demo imports the package barrel relatively, so `demo:build`
never needs a prior library build):

```sh
npm run dev          # demo dev server on port 8300 (strictPort)
npm run demo:build   # static build → demo/dist
npm run demo:preview # serve the built demo
```

Page flow (live edits between turns — no draft, no restart):

- **Combatants** (live panel): one card per combatant rendering the CURRENT
  snapshot — health/max-health meters, resource pools, effective stats with
  next-ready time, current gear with durability bars, registry-derived status
  chips (green buff / red ailment / neutral) and missing-body-part
  checkboxes. Every control edits the RUNNING battle between turns through
  `editCombatant`: gear selects, status add/update/remove (canonical
  seed + your `catalogs.statuses` overrides only), stacks/duration with
  validated bounds and sensible defaults, stamina/mana pools, health/base
  stats. An injury edit that would leave hand gear unwieldable (no arms, or
  a two-handed piece with one arm) includes the SAME atomic patch's gear
  clears with a visible note — unrelated valid gear is preserved. A
  rejected edit shows the engine's error list inline and changes nothing.
- **Battle**: fixture dropdown (the shipped JSON fixtures, incl. the
  `Status Trials` fixture showcasing statuses, injuries and resource pools),
  Step / Run / Run-to-terminal / Reset, steps-per-second, and the outcome
  banner.
- **Advanced battle definition** (JSON editor): the new-battle path.
  Fixtures, imports and **"Apply & restart"** validate
  (`validateBattleDefinition`) and replace the live simulation; Reset
  rewinds the live battle (and discards its live edits) instead. Invalid or
  malformed JSON prints a numbered error list and leaves the draft and the
  running battle untouched. Import/Export round-trip JSON files; the
  snapshot export is replayable.
- **Timeline**: per-step events, including `combatant:edited`; the
  collapsible snapshot view shows the full replayable state. Broken gear
  history lives in the timeline log (`gear:broken`) — the cards show
  current equipment only.

Keyboard: `Space` steps the battle outside form controls. The demo runs
entirely client-side — definitions are validated data, never executed.

