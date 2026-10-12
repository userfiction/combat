// ============================================================================
// demo/ui/combatants.ts — the single LIVE combatants panel (T3 UI task)
// ============================================================================
// One panel replaces BOTH earlier panels: the draft-driven "Combatant setup"
// (ui/setup.ts — deleted) and the read-only "Entities" list (ui/entities.ts —
// deleted). Every card renders the CURRENT SNAPSHOT (snapshot.state — the
// engine's live truth, D10) and every edit goes straight through the main
// host into Simulation.editCombatant (frozen T3 contract: synchronous,
// throws CombatValidationError carrying the full error list, returns the
// fresh SimulationSnapshot). There is NO draft, NO "unapplied" marker and
// NO restart involved:
//   - main catches CombatValidationError → the error list is shown INLINE on
//     the offending card (role=status region) and the snapshot is unchanged;
//   - a successful edit re-renders every panel from the returned snapshot
//     WITHOUT stopping autoplay, WITHOUT timeline.reset and WITHOUT touching
//     the JSON editor draft (that editor remains the "Advanced battle
//     definition" / Apply & restart new-battle path).
//
// Canonical statuses (T3): the registry is the RESOLVED definition's status
// catalog folded over defaultStatusSeed. The canonical default ids are
// fearful/poisoned/stunned — all generic registry definitions. There are NO
// legacy fear/poison/stun fallback presets, no id-based polarity guesses and
// no legacy duration defaults: an unknown id renders neutral and takes no
// default duration (statusPolarity / defaultDurationFor below).
//
// Hand-slot normalization (R1, live edition): gear select changes build ONE
// atomic edit patch covering every displaced hand slot (a two-handed pick
// clears the other weapon slot + shield in the SAME patch), each removal
// announced in a visible note. An injury edit that would leave hand gear
// unwieldable (no arms at all; a two-handed piece with one arm) rides the
// SAME atomic patch's `id: null` clears for exactly those pieces, each clear
// announced in a visible note — the engine validates the PROJECTED
// loadout × projected anatomy and would reject the injuries-only patch
// (see injuryGearPlan); unrelated valid gear is preserved. Anything else the
// engine rejects surfaces verbatim inline.
//
// Broken-gear history: the engine REMOVES a broken piece from live equipment
// (D5b), so the card shows CURRENT equipment only. Broken history lives in
// the timeline log ('gear:broken' events). The old entities panel's
// definition-diff "struck through" heuristic is GONE: a piece the user
// removed manually via a live edit must never render as "broken".
//
// Focus/typing preservation (R3): the panel rebuilds on every render pass
// (autoplay steps render too). Before clearing, the ACTIVE control inside
// the cards is captured (data-focus-key + value) and restored after the
// rebuild, so half-typed input and keyboard focus survive steps and
// edit-driven re-renders without clobbering typing. Non-focused controls
// always mirror engine state. Known tradeoff (documented, accepted):
// restoring .value resets the caret to the end and an open <select> popup
// closes on rebuild — value and focus are preserved, which is the contracted
// behavior; the engine is synchronous (D1) so a step can never interleave
// mid-event either way.
//
// Safety: every dynamic string is written via textContent — definition
// content can never inject markup (D12). Focus keys are looked up by
// attribute VALUE (never selector interpolation) so hostile entity ids with
// quotes/brackets cannot break restores (T3 review probe B1 precedent from
// ui/setup.ts).
// ----------------------------------------------------------------------------

import {
    BODY_PARTS,
    defaultGearSeed,
    defaultStatusSeed,
    MAX_RESOURCE_VALUE,
    MIN_RESOURCE_VALUE,
    RESOURCE_KEYS
} from '../../index';
import type {
    BattleDefinition,
    BodyPart,
    CombatantEdit,
    EntitySnapshot,
    EntityView,
    GearDefinition,
    GearRef,
    ResourceKey,
    SimulationSnapshot,
    Slot,
    StatBlock,
    StatKey,
    StatusDefinition
} from '../../index';

// ----------------------------------------------------------------------------
// Host contract (implemented by demo/main.ts; one-directional data flow, D12)
// ----------------------------------------------------------------------------

export interface CombatantsHost {
    /**
     * Apply one CombatantEdit to the LIVE simulation
     * (main.ts → sim.editCombatant, catching CombatValidationError).
     * Returns the error list — empty ⇒ applied and every panel already
     * re-rendered from the returned snapshot; non-empty ⇒ snapshot
     * unchanged and the panel shows the errors inline.
     */
    editCombatant(edit: CombatantEdit): string[];
}

export interface CombatantsPanel {
    /** Rebuild the cards from the current snapshot (called by main per render pass). */
    render(snapshot: SimulationSnapshot): void;
    /** Clear the normalization notes (new battle via Apply/fixture/Reset). */
    clearNotes(): void;
}

// ----------------------------------------------------------------------------
// Live equipment entry type — DERIVED from the public EntityView (barrel) so
// no structural duplicate can drift from the contract. EquipmentEntry is not
// exported by the barrel; EntityView['equipment'][number] is the same shape.
// ----------------------------------------------------------------------------

type EquipmentEntry = EntityView['equipment'][number];

// One gear entry of the frozen CombatantEdit patch — derived from the barrel
// export so the demo can never drift from the engine contract.
export type GearEditEntry = NonNullable<CombatantEdit['gear']>[number];

// ----------------------------------------------------------------------------
// D13 bounds the demo enforces inline BEFORE calling the engine (mirrors
// src/contract/types.ts + src/data/validation.ts — keep in step). The engine
// re-validates authoritatively; its CombatValidationError messages surface
// inline verbatim for anything this panel does not pre-check. Resource bounds
// come from the barrel (MIN/MAX_RESOURCE_VALUE are public constants).
// ----------------------------------------------------------------------------

const MIN_HEALTH = 1; // baseStats.health: integer 1..100_000
const MAX_HEALTH = 100_000;
const MAX_STAT = 1_000; // strength/defense/precision/evasion: integer 0..1_000
const MIN_SPEED = 0.1; // speed: number 0.1..100 (floats allowed, D3)
const MAX_SPEED = 100;
const MIN_STACKS = 1; // status stacks: integer 1..9 (D13 stack cap)
const MAX_STACKS = 9;
const MIN_DURATION = 1; // status duration: integer >= 1

// Sensible default duration for duration-mode statuses (R2 "reasonable
// defaults"); 3 turns reads well in the demo. CANONICAL-ONLY: no legacy
// fear/poison/stun special cases — unknown ids take no default.
const DEFAULT_DURATION = 3;

// Editable stat fields (baseStats). health is edited separately as "Max
// health" next to the current-health field (see vitals section below).
interface StatFieldSpec {
    key: Exclude<StatKey, 'health'>;
    label: string;
    integer: boolean;
}

const STAT_FIELDS: readonly StatFieldSpec[] = [
    { key: 'strength', label: 'Strength', integer: true },
    { key: 'speed', label: 'Speed', integer: false },
    { key: 'defense', label: 'Defense', integer: true },
    { key: 'precision', label: 'Precision', integer: true },
    { key: 'evasion', label: 'Evasion', integer: true }
];

// Arms are the parts a two-handed weapon depends on (it occupies BOTH hands —
// the same rule the hand-slot normalizer enforces, and state.ts
// availableArmsOf counts exactly these parts).
const ARM_PARTS: readonly BodyPart[] = ['left-arm', 'right-arm'];

// ----------------------------------------------------------------------------
// Catalog folds — mirrors of src/data/catalogs.ts mergeGearCatalog /
// mergeStatusCatalog patch semantics (port of the deleted ui/setup.ts
// helpers; the demo — barrel-only imports per D12 — keeps the exact
// contract: known id keeps fields, `undefined` never erases, first-listing
// order preserved, non-object/id-less patches skipped).
// ----------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const foldById = <T extends { id: string }>(seed: readonly T[], patches?: readonly unknown[]): T[] => {
    const byId = new Map<string, T>();
    seed.forEach((definition) => byId.set(definition.id, { ...definition }));
    if (Array.isArray(patches)) {
        patches.forEach((patch) => {
            if (!isPlainObject(patch) || typeof patch.id !== 'string') return;
            const id = patch.id;
            const current = byId.get(id);
            const merged: Record<string, unknown> = current
                ? { ...(current as unknown as Record<string, unknown>) }
                : {};
            Object.entries(patch).forEach(([key, value]) => {
                if (value !== undefined) merged[key] = value;
            });
            byId.set(id, merged as unknown as T);
        });
    }
    return Array.from(byId.values());
};

/** Effective gear catalog for a resolved definition: builtin seed folded with its patches. */
export const effectiveGearCatalog = (definition: BattleDefinition): GearDefinition[] =>
    foldById(defaultGearSeed, definition.catalogs?.gear);

/** Effective status registry for a resolved definition: builtin seed folded with its overrides. */
export const effectiveStatusCatalog = (definition: BattleDefinition): StatusDefinition[] =>
    foldById(defaultStatusSeed, definition.catalogs?.statuses);

// ----------------------------------------------------------------------------
// Status polarity (R4) — derived from the DEFINITION CONTENT, never from the
// id (a client may redefine any id). CANONICAL-ONLY (T3): an id without a
// registry entry is NEUTRAL — the legacy fear/poison/stun hardcoded-fallback
// paths are gone because those ids no longer have engine-side default
// semantics. Negative signals (damage tick, negative modifier, skip chance)
// win over positive ones so a mixed definition reads as harmful.
// ----------------------------------------------------------------------------

export const statusPolarity = (
    statusId: string,
    registry: Map<string, StatusDefinition>
): 'positive' | 'negative' | 'neutral' => {
    const definition = registry.get(statusId);
    if (!definition) return 'neutral'; // no id-based fallback (T3 canonical statuses)
    let negative = false;
    let positive = false;
    if (definition.skipChancePerStack !== undefined && definition.skipChancePerStack > 0) negative = true;
    if (definition.tick?.damage !== undefined && definition.tick.damage > 0) negative = true;
    if (definition.tick?.heal !== undefined && definition.tick.heal > 0) positive = true;
    Object.values(definition.modifiers ?? {}).forEach((amount) => {
        if (typeof amount === 'number' && amount < 0) negative = true;
        if (typeof amount === 'number' && amount > 0) positive = true;
    });
    // negative beats positive: safety-first coloring for mixed definitions
    if (negative) return 'negative';
    if (positive) return 'positive';
    return 'neutral';
};

// Sensible default duration (R2): a duration-mode status counts down per own
// turn and gets the 3-turn default; stacks-mode and permanent ('none')
// statuses take no duration. Unknown ids (open set) take no default.
export const defaultDurationFor = (definition: StatusDefinition | undefined): number | undefined => {
    if (!definition) return undefined;
    if (definition.decay === 'duration') return DEFAULT_DURATION;
    return undefined;
};

// ----------------------------------------------------------------------------
// Gear-edit planning (R1, live) — pure helpers over the LIVE equipment list.
// buildGearEdit turns one select change into the atomic CombatantEdit.gear
// patch: every displaced hand slot rides the SAME edit (id null = clear the
// slot), and every normalization is described in a visible note.
// ----------------------------------------------------------------------------

const gearName = (gear: Map<string, GearDefinition>, id: string): string => gear.get(id)?.name ?? id;

const weaponLabel = (slot: Slot): string => (slot === 'weapon-2' ? 'off-hand weapon' : 'weapon');

// Human label for a hand slot in normalization notes (shield reads as itself)
const handSlotLabel = (slot: Slot): string => (slot === 'shield' ? 'shield' : weaponLabel(slot));

export interface GearEditPlan {
    entries: GearEditEntry[];
    notes: string[];
}

// Handedness lookup: unknown ids count 1 hand (conservative) and stay in
// place — the engine validates ids and its error surfaces inline.
const handednessOf = (gear: Map<string, GearDefinition>, ref: GearRef | undefined): number => {
    const definition = ref !== undefined ? gear.get(ref.id) : undefined;
    return definition && typeof definition.handedness === 'number' ? definition.handedness : 1;
};

export const buildGearEdit = (
    equipment: readonly EquipmentEntry[],
    slot: Slot,
    id: string | null,
    gear: Map<string, GearDefinition>
): GearEditPlan => {
    // Non-hand slots never displace anything: a single direct entry, plus a
    // removal note when a piece is cleared (visible feedback, R1).
    if (slot !== 'weapon-1' && slot !== 'shield') {
        const removed = equipment.find((piece) => piece.slot === slot);
        const notes =
            id === null && removed !== undefined
                ? [`Armour ${gearName(gear, removed.gearId)} removed from ${slot}.`]
                : [];
        return { entries: [{ slot, id }], notes };
    }

    const bySlot = (wanted: Slot): EquipmentEntry | undefined => equipment.find((piece) => piece.slot === wanted);
    const currentPrimary = bySlot('weapon-1');
    const currentOffHand = bySlot('weapon-2');
    const currentShield = bySlot('shield');

    // Intended post-edit hand state (GearRef shape for the normalizer).
    let primary: GearRef | undefined = currentPrimary ? { id: currentPrimary.gearId, slot: 'weapon-1' } : undefined;
    let offHand: GearRef | undefined = currentOffHand ? { id: currentOffHand.gearId, slot: 'weapon-2' } : undefined;
    let shield: GearRef | undefined = currentShield ? { id: currentShield.gearId, slot: 'shield' } : undefined;

    const notes: string[] = [];
    if (slot === 'weapon-1') {
        if (id === null) {
            if (currentPrimary !== undefined) {
                notes.push(`Unarmed selected — weapon ${gearName(gear, currentPrimary.gearId)} removed.`);
            }
            primary = undefined;
        } else {
            primary = { id, slot: 'weapon-1' };
        }
    } else {
        if (id === null) {
            if (currentShield !== undefined) {
                notes.push(`Shield ${gearName(gear, currentShield.gearId)} removed.`);
            }
            shield = undefined;
        } else {
            shield = { id, slot: 'shield' };
        }
    }

    // Normalization pass (same rules the draft panel enforced, phrased for
    // LIVE edits): 1) a two-handed weapon occupies both hands — the other
    // weapon slot and the shield are cleared; 2) the hands budget is 2 — the
    // shield drops first, then the off-hand weapon. Rule notes describe
    // PRE-EXISTING displaced pieces ("removed"); a piece the user JUST
    // requested that normalization drops is reported once, after the pass,
    // as "not equipped" (it never reached the live loadout).
    const isRequested = (clearedSlot: Slot, clearedId: string): boolean =>
        slot === clearedSlot && id !== null && id === clearedId;
    const twoHanded = [primary, offHand].find((ref) => ref !== undefined && handednessOf(gear, ref) === 2);
    if (twoHanded !== undefined) {
        const other = twoHanded === primary ? offHand : primary;
        if (other !== undefined && !isRequested(other.slot, other.id)) {
            notes.push(
                `Two-handed ${gearName(gear, twoHanded.id)} occupies both hands — removed ${weaponLabel(other.slot)} ${gearName(gear, other.id)}.`
            );
        }
        if (shield !== undefined && !isRequested('shield', shield.id)) {
            notes.push(
                `Two-handed ${gearName(gear, twoHanded.id)} occupies both hands — removed shield ${gearName(gear, shield.id)}.`
            );
        }
        // keep the two-handed weapon in ITS slot; clear the other hand + shield
        if (twoHanded === primary) offHand = undefined;
        else primary = twoHanded;
        shield = undefined;
    } else {
        const handsOf = (ref: GearRef | undefined): number => (ref !== undefined ? handednessOf(gear, ref) : 0);
        let hands = handsOf(primary) + handsOf(offHand) + handsOf(shield);
        if (hands > 2 && shield !== undefined) {
            if (!isRequested('shield', shield.id)) {
                notes.push(`Hands budget is 2 — shield ${gearName(gear, shield.id)} removed.`);
            }
            hands -= handednessOf(gear, shield);
            shield = undefined;
        }
        if (hands > 2 && offHand !== undefined) {
            // the requested slot is never 'weapon-2' (no off-hand select) —
            // an off-hand drop is always a pre-existing piece
            notes.push(`Hands budget is 2 — off-hand weapon ${gearName(gear, offHand.id)} removed.`);
            hands -= handednessOf(gear, offHand);
            offHand = undefined;
        }
    }

    // Post-normalization honesty checks (nothing silent, R1):
    //   - the requested piece did not survive in its slot ⇒ "not equipped";
    //   - the user cleared the primary weapon but a two-handed off-hand
    //     weapon was moved into it (it occupies both hands) ⇒ "kept".
    // slot is narrowed to 'weapon-1' | 'shield' here by the non-hand early
    // return above (weapon-2 has no select and never reaches this planner),
    // so the survivor check only needs those two arms of the ternary.
    if (id !== null) {
        const survivor = slot === 'weapon-1' ? primary : shield;
        if (survivor === undefined || survivor.id !== id) {
            const reason =
                twoHanded !== undefined
                    ? `Two-handed ${gearName(gear, twoHanded.id)} occupies both hands`
                    : 'Hands budget is 2';
            notes.push(`${reason} — ${handSlotLabel(slot)} ${gearName(gear, id)} not equipped.`);
        }
    } else if (slot === 'weapon-1' && primary !== undefined) {
        notes.push(`Two-handed ${gearName(gear, primary.id)} occupies both hands — kept from the off-hand slot.`);
    }

    // Diff the normalized hand state against the CURRENT equipment: one entry
    // per CHANGED slot (id null = clear) keeps the patch minimal — the engine
    // merges it into the live loadout. Instance durability of untouched slots
    // is preserved by not touching them at all.
    const afterBySlot: Partial<Record<Slot, GearRef>> = { 'weapon-1': primary, 'weapon-2': offHand, shield };
    const entries: GearEditEntry[] = [];
    (['weapon-1', 'weapon-2', 'shield'] as const).forEach((handSlot) => {
        const beforeId = bySlot(handSlot)?.gearId ?? null;
        const afterId = afterBySlot[handSlot]?.id ?? null;
        if (beforeId !== afterId) entries.push({ slot: handSlot, id: afterId });
    });
    return { entries, notes };
};

// ----------------------------------------------------------------------------
// Injury→gear coherence (T3, admin-edit edition) — pure helper over the LIVE
// equipment list. The engine's editCombatant validates the PROJECTED loadout
// × PROJECTED anatomy (src/engine/pipeline.ts) and REJECTS an edit whose
// projected hand gear cannot be wielded: every hand-held piece (weapon-1,
// weapon-2, shield) needs ≥ 1 available arm, two-handed pieces need both.
// (The RUNTIME battle keeps ineligible gear equipped-but-inert —
// pipeline.ts weaponUsable — but an ADMIN edit must produce a coherent end
// state, so the panel plans that state itself.) An injury edit that loses an
// arm therefore rides `id: null` clears for exactly the now-incompatible
// weapon/shield pieces in the SAME atomic CombatantEdit, announces every
// clear in a visible note, and preserves all unrelated valid gear. No
// invalid injuries-only edit is ever sent to the engine.
// ----------------------------------------------------------------------------

export interface InjuryGearPlan {
    /** `id: null` clears for each incompatible hand slot (same atomic patch). */
    entries: GearEditEntry[];
    /** Visible per-clear notes (rendered in the shared edit-notes area). */
    notes: string[];
}

export const injuryGearPlan = (
    injuriesAfter: readonly BodyPart[],
    equipment: readonly EquipmentEntry[],
    gear: Map<string, GearDefinition>
): InjuryGearPlan => {
    const missingArms = ARM_PARTS.filter((part) => injuriesAfter.includes(part));
    if (missingArms.length === 0) return { entries: [], notes: [] };
    const arms = 2 - missingArms.length; // availableArmsOf (state.ts) semantics
    const entries: GearEditEntry[] = [];
    const notes: string[] = [];
    equipment.forEach((piece) => {
        // only hand-held slots can become unwieldable; body/head/hands/feet
        // armour is never arm-dependent and is always preserved
        if (piece.slot !== 'weapon-1' && piece.slot !== 'weapon-2' && piece.slot !== 'shield') return;
        // conservative handedness (unknown ids count 1 hand) — the exact
        // lookup the engine's projected-loadout validation performs
        const handedness = handednessOf(gear, { id: piece.gearId, slot: piece.slot });
        const incompatible = arms === 0 || (arms === 1 && handedness === 2);
        if (!incompatible) return;
        entries.push({ slot: piece.slot, id: null });
        const subject = missingArms.length === 1 ? `${missingArms[0]} is missing` : `${missingArms.join(' and ')} are missing`;
        const reason = arms === 0 ? 'no arms remain to hold it' : 'it is two-handed and one arm is missing';
        notes.push(
            `${subject} — cleared ${handSlotLabel(piece.slot)} ${gearName(gear, piece.gearId)}: ${reason}. A healed injury cannot restore cleared gear.`
        );
    });
    return { entries, notes };
};

// ----------------------------------------------------------------------------
// Panel implementation
// ----------------------------------------------------------------------------

// Human-readable gear option label
const gearOptionText = (definition: GearDefinition): string => {
    const name = definition.name ?? definition.id;
    if (definition.kind === 'weapon') {
        const hands = definition.handedness === 2 ? 'two-handed' : 'one-handed';
        return `${name} — ${definition.type} ${definition.damage}, ${hands}`;
    }
    return `${name} — ${definition.slot}`;
};

const statusOptionText = (definition: StatusDefinition): string =>
    definition.name ? `${definition.name} (${definition.id})` : definition.id;

// µs → ms with 3 decimals (D12; exact for integer-µs scheduler time, D4a)
const msText = (micros: number): string => `${(micros / 1000).toFixed(3)} ms`;

// Tiny DOM helpers (textContent only — never innerHTML, D12)
const element = (tag: string, className?: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const labelled = (labelText: string, input: HTMLElement, forId: string): HTMLElement => {
    const label = document.createElement('label');
    label.textContent = labelText;
    label.htmlFor = forId;
    input.id = forId;
    label.appendChild(input);
    return label;
};

// Module-level counters: unique ids across rebuilds (label htmlFor targets
// must never collide, and the error region id must be stable per build).
let fieldCounter = 0;
const nextFieldId = (prefix: string): string => `${prefix}-${fieldCounter++}`;
let regionCounter = 0;

// Labelled meter row shared by health, durability and resource bars
// (port of the deleted ui/entities.ts widget).
function makeMeter(labelText: string, value: number, max: number, kind: 'hp' | 'dur' | 'res'): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = labelText;
    const meter = document.createElement('div');
    meter.className = `meter ${kind}`;
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    // low-health emphasis (purely visual)
    if (kind === 'hp' && ratio <= 0.25) meter.classList.add('low');
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(ratio * 100).toFixed(1)}%`; // dynamic width — the one accepted inline style
    meter.appendChild(fill);
    const valueText = document.createElement('span');
    valueText.className = 'value';
    valueText.textContent = `${value}/${max}`;
    row.appendChild(label);
    row.appendChild(meter);
    row.appendChild(valueText);
    return row;
}

export function createCombatantsPanel(mount: HTMLElement, host: CombatantsHost): CombatantsPanel {
    // --- persistent chrome (built once; card content rebuilds per render) ----
    const root = element('div', 'combatants');
    mount.appendChild(root);

    // What this panel is (and is not): live edits vs the Advanced definition
    // editor's new-battle path.
    const help = element(
        'p',
        'combatants-help',
        'Live battle state — edits apply to the running battle between turns, no restart needed. New battles come from the Advanced definition editor (Apply & restart).'
    );
    root.appendChild(help);

    // Terminal guidance (R3): the panel switches to read-only with an
    // explicit Reset instruction once the battle is finished.
    const terminalGuidance = element(
        'p',
        'terminal-guidance',
        'Battle finished — combatants are read-only. Press Reset to restart this battle from its original definition, or load a fixture / Apply & restart for a new battle.'
    );
    terminalGuidance.setAttribute('role', 'status');
    terminalGuidance.hidden = true;
    root.appendChild(terminalGuidance);

    // Normalization notes (R1 "clear indication"): one shared area above the
    // cards describing the LAST successful edit's atomic normalizations.
    // Survives step-driven renders; main clears it on new battles/reset.
    const notesArea = element('div', 'edit-notes');
    notesArea.setAttribute('role', 'status');
    notesArea.setAttribute('aria-label', 'Edit notes');
    notesArea.hidden = true;
    root.appendChild(notesArea);

    // Per-combatant card grid — rebuilt on every render pass
    const cards = element('div', 'combatant-cards');
    root.appendChild(cards);

    // --- panel state ---------------------------------------------------------
    // The last snapshot rendered (failed edits re-render from it: the
    // snapshot is UNCHANGED after a rejected patch — frozen T3 contract).
    let current: SimulationSnapshot | undefined;
    // Per-entity inline error state: { messages, fieldKey? }. Survives
    // step-driven renders (a rejected edit's error must not be wiped by the
    // next autoplay tick); cleared for an entity on its next edit attempt.
    const cardErrors = new Map<string, { messages: string[]; fieldKey?: string }>();

    const setNotes = (notes: readonly string[]): void => {
        notesArea.textContent = '';
        notes.forEach((note) => notesArea.appendChild(element('p', undefined, note)));
        notesArea.hidden = notes.length === 0;
    };

    // Focus-key lookup by attribute VALUE — injection-proof for hostile ids
    // (quotes/brackets would break a selector-interpolated query).
    const findByFocusKey = (key: string): HTMLElement | undefined => {
        let found: HTMLElement | undefined;
        cards.querySelectorAll<HTMLElement>('[data-focus-key]').forEach((node) => {
            if (found === undefined && node.getAttribute('data-focus-key') === key) found = node;
        });
        return found;
    };

    // The ACTIVE control inside the cards is the only one that can hold
    // uncommitted typing (leaving a field fires change → commit in real
    // browsers). Capture its key + value before the rebuild so typing and
    // focus survive every render pass (R3).
    const captureActiveControl = (): { key: string; value: string } | undefined => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !cards.contains(active)) return undefined;
        const key = active.getAttribute('data-focus-key');
        if (!key) return undefined;
        if (active instanceof HTMLInputElement && active.type === 'checkbox') {
            return { key, value: String(active.checked) };
        }
        return { key, value: (active as HTMLInputElement | HTMLSelectElement).value };
    };

    const restoreActiveControl = (captured: { key: string; value: string } | undefined): void => {
        if (captured === undefined) return;
        const target = findByFocusKey(captured.key);
        if (!target) return;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') {
            target.checked = captured.value === 'true';
        } else if (target instanceof HTMLSelectElement) {
            // only restore when the option still exists in the rebuilt list
            const exists = Array.from(target.options).some((option) => option.value === captured.value);
            if (exists) target.value = captured.value;
        } else {
            (target as HTMLInputElement).value = captured.value;
        }
        target.focus();
    };

    const rerender = (): void => {
        // renderFrom is declared later in this factory; every call site runs
        // after initialization (event handlers only), so the closure is safe.
        if (current !== undefined) renderFrom(current);
    };

    // Inline failure: show the messages on the card (role=status region),
    // keep the snapshot untouched, keep the typed value/focus via the
    // render-time capture. The engine's CombatValidationError list flows
    // through the exact same path as panel-side validation messages.
    const fail = (entityId: string, messages: string[], fieldKey?: string): void => {
        cardErrors.set(entityId, { messages, fieldKey });
        rerender();
    };

    // One validated edit attempt for a card. Protocol: any previous error for
    // the entity is superseded; on success main's host has ALREADY
    // re-rendered every panel from the returned snapshot (autoplay keeps
    // running, timeline untouched, draft untouched — T3 contract); on failure
    // the error list shows inline and the snapshot is unchanged.
    const applyCardEdit = (
        entityId: string,
        edit: CombatantEdit,
        notes?: readonly string[],
        fieldKey?: string
    ): void => {
        cardErrors.delete(entityId);
        const errors = host.editCombatant(edit);
        if (errors.length > 0) {
            cardErrors.set(entityId, { messages: errors, fieldKey });
            rerender();
            return;
        }
        if (notes !== undefined && notes.length > 0) setNotes(notes);
    };

    // Explicit per-field number commit ('change' = blur / Enter). Blank
    // reverts the field to the rendered state value (dataset.committed) with
    // NO mutation and NO error — clearing a field is not an edit request.
    const commitNumber = (
        entity: EntitySnapshot,
        input: HTMLInputElement,
        label: string,
        validate: (value: number) => string | undefined,
        build: (value: number) => CombatantEdit
    ): void => {
        const text = input.value.trim();
        if (text === '') {
            input.value = input.dataset.committed ?? '';
            return;
        }
        const value = Number(text);
        if (!Number.isFinite(value)) {
            fail(entity.id, [`${label} must be a number`], input.getAttribute('data-focus-key') ?? undefined);
            return;
        }
        const boundError = validate(value);
        if (boundError !== undefined) {
            fail(entity.id, [boundError], input.getAttribute('data-focus-key') ?? undefined);
            return;
        }
        applyCardEdit(entity.id, build(value), undefined, input.getAttribute('data-focus-key') ?? undefined);
    };

    // validators — message strings are pinned by demo/main.test.ts
    const integerBetween =
        (label: string, min: number, max: number) =>
        (value: number): string | undefined =>
            Number.isInteger(value) && value >= min && value <= max
                ? undefined
                : `${label} must be an integer between ${min} and ${max}`;
    const numberBetween =
        (label: string, min: number, max: number) =>
        (value: number): string | undefined =>
            value >= min && value <= max ? undefined : `${label} must be a number between ${min} and ${max}`;

    // --- one combatant card ----------------------------------------------------
    const buildCard = (
        entity: EntitySnapshot,
        snapshot: SimulationSnapshot,
        gearById: Map<string, GearDefinition>,
        statusById: Map<string, StatusDefinition>,
        terminal: boolean
    ): HTMLElement => {
        const card = element('article', `combatant-card${entity.living ? '' : ' dead'}`);
        card.setAttribute('data-entity-id', entity.id);
        const displayName = entity.name;
        const focusKeyFor = (key: string): string => `${key}:${entity.id}`;

        // Inline error region (role=status announces politely; id is shared
        // with every field's aria-describedby so errors are associated with
        // the fields they came from).
        const errorEntry = cardErrors.get(entity.id);
        const errorRegion = element('div', 'card-errors');
        errorRegion.id = `card-errors-${regionCounter++}`;
        errorRegion.setAttribute('role', 'status');
        errorRegion.setAttribute('aria-label', `Edit errors — ${displayName}`);
        errorRegion.hidden = true;
        if (errorEntry !== undefined) {
            errorEntry.messages.forEach((message) => errorRegion.appendChild(element('p', undefined, message)));
            errorRegion.hidden = false;
        }

        // --- header: display name + id/team tag + dead marker -----------------
        const head = element('div', 'card-head');
        head.appendChild(element('span', 'name', displayName));
        head.appendChild(element('span', 'tag', entity.team ? `#${entity.id} · ${entity.team}` : `#${entity.id}`));
        if (!entity.living) head.appendChild(element('span', 'state-dead', 'dead'));
        card.appendChild(head);

        // --- meters: health + resource pools (R3/R4 display) -------------------
        card.appendChild(makeMeter('health', entity.health, entity.maxHealth, 'hp'));
        RESOURCE_KEYS.forEach((pool: ResourceKey) => {
            const value = entity.resources?.[pool];
            if (value !== undefined) card.appendChild(makeMeter(pool, value.current, value.max, 'res'));
        });

        // --- effective stats + readiness (D7 display) ---------------------------
        const scheduleEntry = snapshot.state.schedule.find((entry) => entry.entityId === entity.id);
        const stats = element('div', 'stats');
        const statCells: Array<[string, string]> = [
            ['str', String(entity.stats.strength)],
            // stats.speed is the EFFECTIVE speed (base + modifiers + injury factor, D4b/D7)
            ['speed (eff)', String(entity.stats.speed)],
            ['def', String(entity.stats.defense)],
            ['precision', String(entity.stats.precision)],
            ['evasion', String(entity.stats.evasion)],
            // next-ready: pending schedule entry (µs → ms, D4a); dead ⇒ dropped (D4e)
            ['next ready', entity.living && scheduleEntry ? msText(scheduleEntry.readyAt) : '—']
        ];
        statCells.forEach(([labelText, valueText]) => {
            const cell = element('span', undefined, `${labelText} `);
            const strong = document.createElement('b');
            strong.textContent = valueText;
            cell.appendChild(strong);
            stats.appendChild(cell);
        });
        card.appendChild(stats);

        // --- vitals edit: current health + max health (baseStats.health) -------
        const vitals = element('div', 'field-section');
        vitals.appendChild(element('span', 'section-label', 'Vitals'));
        const vitalsGrid = element('div', 'field-grid');
        const numberField = (
            key: string,
            label: string,
            ariaLabel: string,
            value: number | undefined,
            step: string,
            min: string | undefined,
            max: string | undefined,
            validate: (value: number) => string | undefined,
            build: (value: number) => CombatantEdit
        ): void => {
            const input = document.createElement('input');
            input.type = 'number';
            if (step !== undefined) input.step = step;
            if (min !== undefined) input.min = min;
            if (max !== undefined) input.max = max;
            input.value = value === undefined ? '' : String(value);
            input.dataset.committed = String(value ?? '');
            input.setAttribute('data-focus-key', focusKeyFor(key));
            input.setAttribute('aria-label', ariaLabel);
            input.setAttribute('aria-describedby', errorRegion.id);
            if (terminal) input.disabled = true;
            if (errorEntry !== undefined && errorEntry.fieldKey === focusKeyFor(key)) {
                input.setAttribute('aria-invalid', 'true');
            }
            input.addEventListener('change', () => commitNumber(entity, input, label, validate, build));
            vitalsGrid.appendChild(labelled(label, input, nextFieldId('combatant-field')));
        };
        numberField(
            'health',
            'Health',
            `Current health — ${displayName}`,
            entity.health,
            '1',
            undefined,
            undefined,
            // current health has NO local range bound: 0 may be a legitimate
            // engine-opinion (kill) or an error — the engine decides, its
            // message surfaces inline verbatim (frozen T3 contract)
            (value) => (Number.isInteger(value) ? undefined : 'Health must be an integer'),
            (value) => ({ entityId: entity.id, health: value })
        );
        numberField(
            'max-health',
            'Max health',
            `Max health — ${displayName}`,
            entity.baseStats.health,
            '1',
            String(MIN_HEALTH),
            String(MAX_HEALTH),
            integerBetween('Max health', MIN_HEALTH, MAX_HEALTH),
            (value) => ({ entityId: entity.id, baseStats: { health: value } })
        );
        vitals.appendChild(vitalsGrid);
        card.appendChild(vitals);

        // --- base stats edit (derived/effective stats shown above) --------------
        const statSection = element('div', 'field-section');
        statSection.appendChild(element('span', 'section-label', 'Base stats'));
        const statGrid = element('div', 'field-grid');
        STAT_FIELDS.forEach((field) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = field.integer ? '1' : '0.1';
            input.min = field.integer ? '0' : String(MIN_SPEED);
            input.max = String(field.integer ? MAX_STAT : MAX_SPEED);
            input.value = String(entity.baseStats[field.key]);
            input.dataset.committed = String(entity.baseStats[field.key]);
            input.setAttribute('data-focus-key', focusKeyFor(`stat-${field.key}`));
            input.setAttribute('aria-label', `${field.label} — ${displayName}`);
            input.setAttribute('aria-describedby', errorRegion.id);
            if (terminal) input.disabled = true;
            if (errorEntry !== undefined && errorEntry.fieldKey === focusKeyFor(`stat-${field.key}`)) {
                input.setAttribute('aria-invalid', 'true');
            }
            input.addEventListener('change', () =>
                commitNumber(
                    entity,
                    input,
                    field.label,
                    field.integer
                        ? integerBetween(field.label, 0, MAX_STAT)
                        : numberBetween(field.label, MIN_SPEED, MAX_SPEED),
                    (value) => {
                        // Partial<StatBlock> index assignment — the engine merges
                        // the provided stat keys into the entity's base stats.
                        const baseStats: Partial<StatBlock> = {};
                        baseStats[field.key] = value;
                        return { entityId: entity.id, baseStats };
                    }
                )
            );
            statGrid.appendChild(labelled(field.label, input, nextFieldId('combatant-field')));
        });
        statSection.appendChild(statGrid);
        card.appendChild(statSection);

        // --- gear: preset selects + current equipment with durability ----------
        const gearSection = element('div', 'gear');
        gearSection.appendChild(element('span', 'section-label', 'Gear'));
        const loadout = element('div', 'loadout-grid');

        const makeSelect = (
            labelText: string,
            options: Array<{ value: string; text: string }>,
            currentValue: string,
            key: string,
            slot: Slot
        ): void => {
            const id = nextFieldId('combatant-field');
            const select = document.createElement('select');
            select.id = id;
            select.setAttribute('data-focus-key', focusKeyFor(key));
            select.setAttribute('aria-label', `${labelText} — ${displayName}`);
            select.setAttribute('aria-describedby', errorRegion.id);
            if (terminal) select.disabled = true;
            if (errorEntry !== undefined && errorEntry.fieldKey === focusKeyFor(key)) {
                select.setAttribute('aria-invalid', 'true');
            }
            options.forEach((option) => {
                const node = document.createElement('option');
                node.value = option.value;
                node.textContent = option.text;
                if (option.value === currentValue) node.selected = true;
                select.appendChild(node);
            });
            select.addEventListener('change', () => {
                // '' ⇒ clear the slot (id null); the atomic patch builder
                // normalizes hands and reports every displacement.
                const value = select.value;
                const plan = buildGearEdit(entity.equipment, slot, value === '' ? null : value, gearById);
                if (plan.entries.length === 0) {
                    // normalization refused the pick entirely (e.g. hands
                    // budget): nothing changed live — snap the select back to
                    // the state value and explain via the notes area instead
                    // of sending the engine a no-op edit
                    cardErrors.delete(entity.id);
                    select.value = currentValue;
                    if (plan.notes.length > 0) setNotes(plan.notes);
                    return;
                }
                applyCardEdit(entity.id, { entityId: entity.id, gear: plan.entries }, plan.notes, focusKeyFor(key));
            });
            loadout.appendChild(labelled(labelText, select, id));
        };

        const weaponOptions = (): Array<{ value: string; text: string }> => [
            { value: '', text: 'Unarmed (no weapon)' },
            ...Array.from(gearById.values())
                .filter((definition) => definition.kind === 'weapon')
                .map((definition) => ({ value: definition.id, text: gearOptionText(definition) }))
        ];
        const armourOptionsFor = (slot: Slot): Array<{ value: string; text: string }> => [
            { value: '', text: 'None' },
            ...Array.from(gearById.values())
                .filter((definition) => definition.kind === 'armour' && definition.slot === slot)
                .map((definition) => ({ value: definition.id, text: gearOptionText(definition) }))
        ];

        const bySlot = (wanted: Slot): EquipmentEntry | undefined =>
            entity.equipment.find((piece) => piece.slot === wanted);
        makeSelect('Weapon', weaponOptions(), bySlot('weapon-1')?.gearId ?? '', 'weapon', 'weapon-1');
        // Off-hand (weapon-2) refs are preserved but not select-driven — shown
        // read-only so nothing silently disappears from the loadout (same
        // policy the draft panel had; normalization may still clear the slot).
        const offHandEntry = bySlot('weapon-2');
        if (offHandEntry !== undefined) {
            loadout.appendChild(
                element(
                    'span',
                    'loadout-note',
                    `Off-hand (weapon-2): ${gearName(gearById, offHandEntry.gearId)} — shown read-only; a two-handed weapon pick clears it.`
                )
            );
        }
        makeSelect('Shield', armourOptionsFor('shield'), bySlot('shield')?.gearId ?? '', 'shield', 'shield');
        (['head', 'body', 'hands', 'feet'] as const).forEach((slot) => {
            const capitalized = slot.charAt(0).toUpperCase() + slot.slice(1);
            makeSelect(capitalized, armourOptionsFor(slot), bySlot(slot)?.gearId ?? '', `armour-${slot}`, slot);
        });
        gearSection.appendChild(loadout);

        // CURRENT equipment lines with durability meters (broken history lives
        // in the timeline log — no definition-diff "broken" heuristic).
        if (entity.equipment.length === 0) {
            gearSection.appendChild(element('div', 'none', 'unarmed, no armour'));
        }
        entity.equipment.forEach((piece) => {
            const line = element('div', 'gear-line');
            const name = element('span', 'gear-name', `${piece.slot} · ${gearName(gearById, piece.gearId)}`);
            line.appendChild(name);
            // bar max: the catalog durability is the piece's max (the live
            // entry's durability is the DECAYED current value, D5b)
            const maxDurability = gearById.get(piece.gearId)?.durability ?? piece.durability;
            line.appendChild(makeMeter('dur', piece.durability, maxDurability, 'dur'));
            gearSection.appendChild(line);
        });
        card.appendChild(gearSection);

        // --- statuses: chips + add/set row (R2, canonical registry only) --------
        const statusSection = element('div', 'status-section');
        statusSection.appendChild(element('span', 'section-label', 'Statuses'));

        const chips = element('div', 'chips');
        entity.statuses.forEach((instance) => {
            const chip = element('span', `chip ${statusPolarity(instance.id, statusById)}`);
            let text = `${instance.id} ×${instance.stacks ?? 1}`;
            if (instance.duration !== undefined) text += ` · d${instance.duration}`;
            if (instance.potency !== undefined && instance.potency !== 1) text += ` · p${instance.potency}`;
            chip.appendChild(element('span', undefined, text));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'chip-remove';
            remove.textContent = '×';
            remove.setAttribute('data-focus-key', focusKeyFor(`status-remove-${instance.id}`));
            remove.setAttribute('aria-label', `Remove status ${instance.id} from ${displayName}`);
            if (terminal) remove.disabled = true;
            remove.addEventListener('click', () => {
                applyCardEdit(
                    entity.id,
                    { entityId: entity.id, statuses: [{ id: instance.id, op: 'remove' }] },
                    [],
                    focusKeyFor(`status-remove-${instance.id}`)
                );
            });
            chip.appendChild(remove);
            chips.appendChild(chip);
        });
        if (entity.statuses.length === 0) chips.appendChild(element('span', 'none', 'None'));
        statusSection.appendChild(chips);

        // Add/set row: the EFFECTIVE registry (seed + resolved definition
        // overrides) is the only source of options — canonical ids
        // (fearful/poisoned/stunned) arrive through the registry like any
        // custom id; there are NO legacy fallback options (T3).
        const statusRow = element('div', 'status-row');
        const statusSelect = document.createElement('select');
        statusSelect.setAttribute('data-focus-key', focusKeyFor('status-add'));
        statusSelect.setAttribute('aria-label', `Add or update status — ${displayName}`);
        statusSelect.setAttribute('aria-describedby', errorRegion.id);
        if (terminal) statusSelect.disabled = true;
        Array.from(statusById.values()).forEach((definition) => {
            const option = document.createElement('option');
            option.value = definition.id;
            option.textContent = statusOptionText(definition);
            statusSelect.appendChild(option);
        });
        statusRow.appendChild(statusSelect);

        const stacksInput = document.createElement('input');
        stacksInput.type = 'number';
        stacksInput.min = String(MIN_STACKS);
        stacksInput.max = String(MAX_STACKS);
        stacksInput.value = '1';
        stacksInput.setAttribute('data-focus-key', focusKeyFor('status-stacks'));
        stacksInput.setAttribute('aria-label', `Status stacks — ${displayName}`);
        stacksInput.setAttribute('aria-describedby', errorRegion.id);
        if (terminal) stacksInput.disabled = true;
        statusRow.appendChild(labelled('stacks', stacksInput, nextFieldId('combatant-stacks')));

        const durationInput = document.createElement('input');
        durationInput.type = 'number';
        durationInput.min = String(MIN_DURATION);
        durationInput.placeholder = 'auto';
        durationInput.setAttribute('data-focus-key', focusKeyFor('status-duration'));
        durationInput.setAttribute('aria-label', `Status duration in turns — ${displayName}`);
        durationInput.setAttribute('aria-describedby', errorRegion.id);
        if (terminal) durationInput.disabled = true;
        statusRow.appendChild(labelled('turns', durationInput, nextFieldId('combatant-duration')));

        const setStatusButton = document.createElement('button');
        setStatusButton.type = 'button';
        setStatusButton.textContent = 'Set';
        setStatusButton.setAttribute('data-focus-key', focusKeyFor('status-set'));
        setStatusButton.setAttribute('aria-label', `Set status on ${displayName}`);
        if (terminal) setStatusButton.disabled = true;
        setStatusButton.addEventListener('click', () => {
            const statusId = statusSelect.value;
            if (statusId === '') {
                // defensive: a registry-less select can only be a demo bug —
                // refuse instead of minting an invalid instance
                fail(entity.id, ['a status must be selected'], focusKeyFor('status-set'));
                return;
            }
            const stacksText = stacksInput.value.trim();
            const durationText = durationInput.value.trim();
            const stacks = stacksText === '' ? 1 : Number(stacksText);
            if (!Number.isInteger(stacks) || stacks < MIN_STACKS || stacks > MAX_STACKS) {
                fail(entity.id, ['stacks must be an integer between 1 and 9'], focusKeyFor('status-set'));
                return;
            }
            const definition = statusById.get(statusId);
            // Sensible defaults (R2): duration-mode statuses default to 3
            // turns; stacks/permanent statuses take no duration when left
            // blank. CANONICAL-ONLY: no legacy duration defaults.
            const duration = durationText === '' ? defaultDurationFor(definition) : Number(durationText);
            if (duration !== undefined && (!Number.isInteger(duration) || duration < MIN_DURATION)) {
                fail(entity.id, ['duration must be an integer >= 1'], focusKeyFor('status-set'));
                return;
            }
            applyCardEdit(
                entity.id,
                {
                    entityId: entity.id,
                    statuses: [
                        // op 'set' adds or updates the instance by id; unknown
                        // fields (potency, engine-materialized modifiers) are
                        // the engine's business — the patch carries only what
                        // the user edited.
                        { id: statusId, op: 'set', stacks, ...(duration !== undefined ? { duration } : {}) }
                    ]
                },
                [],
                focusKeyFor('status-set')
            );
        });
        statusRow.appendChild(setStatusButton);
        statusSection.appendChild(statusRow);
        card.appendChild(statusSection);

        // --- resource pools (R3): stamina/mana ONLY (energy is an input alias
        // the engine normalizes at resolution — live snapshots never carry it)
        const resourceSection = element('div', 'res-section');
        resourceSection.appendChild(element('span', 'section-label', 'Resources'));
        RESOURCE_KEYS.forEach((pool: ResourceKey) => {
            const value = entity.resources?.[pool];
            const row = element('div', 'res-row');
            row.appendChild(element('span', 'res-label', pool));
            const inputs: Partial<Record<'current' | 'max', HTMLInputElement>> = {};
            (['current', 'max'] as const).forEach((fieldKey) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.value = value && value[fieldKey] !== undefined ? String(value[fieldKey]) : '';
                input.placeholder = '—';
                input.setAttribute('data-focus-key', focusKeyFor(`res-${pool}-${fieldKey}`));
                input.setAttribute('aria-label', `${pool} ${fieldKey} — ${displayName}`);
                input.setAttribute('aria-describedby', errorRegion.id);
                if (terminal) input.disabled = true;
                if (errorEntry !== undefined && errorEntry.fieldKey === focusKeyFor(`res-${pool}-${fieldKey}`)) {
                    input.setAttribute('aria-invalid', 'true');
                }
                inputs[fieldKey] = input;
                row.appendChild(input);
            });
            // One shared commit reads BOTH fields of the pool (source of truth
            // is the DOM pair at commit time, not the individual event).
            const commitPool = (focusKey: string): void => {
                const currentText = inputs.current?.value.trim() ?? '';
                const maxText = inputs.max?.value.trim() ?? '';
                // both cleared ⇒ remove the pool (null in the frozen edit
                // contract); a pool the entity never had is a no-op
                if (currentText === '' && maxText === '') {
                    if (entity.resources?.[pool] === undefined) return;
                    const removal: NonNullable<CombatantEdit['resources']> =
                        pool === 'stamina' ? { stamina: null } : { mana: null };
                    applyCardEdit(entity.id, { entityId: entity.id, resources: removal }, [], focusKey);
                    return;
                }
                if (currentText === '' || maxText === '') {
                    fail(
                        entity.id,
                        [`${pool} needs both current and max (leave both blank to remove the pool)`],
                        focusKey
                    );
                    return;
                }
                const current = Number(currentText);
                const max = Number(maxText);
                if (
                    !Number.isInteger(current) ||
                    !Number.isInteger(max) ||
                    current < MIN_RESOURCE_VALUE ||
                    max < MIN_RESOURCE_VALUE ||
                    current > MAX_RESOURCE_VALUE ||
                    max > MAX_RESOURCE_VALUE
                ) {
                    fail(
                        entity.id,
                        [
                            `${pool}.current/max must be integers between ${MIN_RESOURCE_VALUE} and ${MAX_RESOURCE_VALUE}`
                        ],
                        focusKey
                    );
                    return;
                }
                if (current > max) {
                    fail(entity.id, [`${pool}.current: must not exceed max (${current} > ${max})`], focusKey);
                    return;
                }
                // computed-key construction per pool keeps the frozen
                // Partial<Record<ResourceKey, …>> shape without a cast
                const resources: NonNullable<CombatantEdit['resources']> =
                    pool === 'stamina' ? { stamina: { current, max } } : { mana: { current, max } };
                applyCardEdit(entity.id, { entityId: entity.id, resources }, [], focusKey);
            };
            inputs.current?.addEventListener('change', () => commitPool(focusKeyFor(`res-${pool}-current`)));
            inputs.max?.addEventListener('change', () => commitPool(focusKeyFor(`res-${pool}-max`)));
            resourceSection.appendChild(row);
        });
        card.appendChild(resourceSection);

        // --- missing body parts (R2): checkboxes commit the add/remove diff ----
        const partsSection = element('div', 'parts-section');
        partsSection.setAttribute('role', 'group');
        partsSection.setAttribute('aria-label', `Missing body parts — ${displayName}`);
        partsSection.appendChild(element('span', 'section-label', 'Missing parts'));
        const partsGrid = element('div', 'parts-grid');
        const checkedParts = new Set<string>(entity.injuries ?? []);
        BODY_PARTS.forEach((part) => {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = checkedParts.has(part);
            input.setAttribute('data-focus-key', focusKeyFor(`injury-${part}`));
            input.setAttribute('data-part', part);
            input.setAttribute('aria-label', `${part} missing — ${displayName}`);
            input.setAttribute('aria-describedby', errorRegion.id);
            if (terminal) input.disabled = true;
            const boxLabel = document.createElement('label');
            boxLabel.className = 'part-box';
            boxLabel.appendChild(input);
            boxLabel.appendChild(document.createTextNode(part));
            partsGrid.appendChild(boxLabel);
        });
        // One shared change handler reads the whole group; the diff against
        // the entity's current injuries becomes { add, remove } (the engine
        // rejects adding an already-missing / removing a present part, so the
        // projected anatomy stays explicit). Hand gear the projected anatomy
        // could not wield rides the SAME atomic patch as `id: null` gear
        // clears with visible notes (see injuryGearPlan — the engine would
        // reject the injuries-only patch otherwise); unrelated valid gear is
        // preserved.
        partsGrid.addEventListener('change', () => {
            const selected = Array.from(partsGrid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
                .filter((box) => box.checked)
                .map((box) => box.getAttribute('data-part'))
                .filter((part): part is BodyPart => part !== null && (BODY_PARTS as readonly string[]).includes(part));
            const activePart = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-part') ?? '';
            const focusKey = focusKeyFor(`injury-${activePart}`);
            const currentParts = entity.injuries ?? [];
            const add = BODY_PARTS.filter((part) => selected.includes(part) && !currentParts.includes(part));
            const remove = BODY_PARTS.filter((part) => !selected.includes(part) && currentParts.includes(part));
            if (add.length === 0 && remove.length === 0) return; // no-op change (programmatic dispatch)
            const after = BODY_PARTS.filter(
                (part) => (currentParts.includes(part) || add.includes(part)) && !remove.includes(part)
            );
            const plan = injuryGearPlan(after, entity.equipment, gearById);
            const injuries: NonNullable<CombatantEdit['injuries']> = {};
            if (add.length > 0) injuries.add = [...add];
            if (remove.length > 0) injuries.remove = [...remove];
            // one atomic patch: injuries + the coherent gear clears together
            const edit: CombatantEdit = { entityId: entity.id, injuries };
            if (plan.entries.length > 0) edit.gear = plan.entries;
            applyCardEdit(entity.id, edit, plan.notes, focusKey);
        });
        partsSection.appendChild(partsGrid);
        card.appendChild(partsSection);

        card.appendChild(errorRegion);
        return card;
    };

    // ---------------------------------------------------------------------------
    // Render pass: rebuild every card from a snapshot. Declared as a local
    // binding (renderFrom) so failed-edit re-renders and the public render
    // entry share ONE implementation without self-reference pitfalls.
    // ---------------------------------------------------------------------------
    const renderFrom = (snapshot: SimulationSnapshot): void => {
        current = snapshot;
        const terminal = snapshot.state.terminal !== null;
        terminalGuidance.hidden = !terminal;
        // capture the active control BEFORE clearing so typing + focus
        // survive the rebuild (R3: autoplay renders must not clobber)
        const captured = captureActiveControl();
        cards.textContent = '';
        // Effective catalogs resolve against the RESOLVED definition in the
        // snapshot (catalogs merged engine-side, D10) folded over the
        // builtin seeds — same resolution the engine ran with.
        const gearById = new Map(
            effectiveGearCatalog(snapshot.definition).map((definition) => [definition.id, definition])
        );
        const statusById = new Map(
            effectiveStatusCatalog(snapshot.definition).map((definition) => [definition.id, definition])
        );
        snapshot.state.entities.forEach((entity) => {
            cards.appendChild(buildCard(entity, snapshot, gearById, statusById, terminal));
        });
        restoreActiveControl(captured);
    };

    // ---------------------------------------------------------------------------
    // Public surface
    // ---------------------------------------------------------------------------
    return {
        render: renderFrom,
        clearNotes(): void {
            setNotes([]);
        }
    };
}
