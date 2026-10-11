// ============================================================================
// demo/ui/entities.ts — combatant cards (D12)
// ============================================================================
// One card per entity from the snapshot state (EntitySnapshot extends
// EntityView, D10): health bar, stats (EFFECTIVE per D7), effective speed,
// next-ready time, status chips with stacks+duration, equipment with
// durability bars, BROKEN PIECES STRUCK THROUGH.
//
// Broken-piece detection: the engine REMOVES a broken piece from the entity's
// equipment at runtime (D5b "piece removed from slot"), so "broken" is derived
// by diffing the definition's initial loadout (snapshot.definition.entities
// [order].equipment — order is the definition index, D7) against the current
// equipment list. A piece present initially but absent now was broken (or
// removed by a break-equipment effect) and renders struck through.
//
// Gear metadata (name/durability max) resolves against the RESOLVED catalog in
// the snapshot definition; when a definition ships no catalogs the engine ran
// on defaultGearSeed (engine.ts L132), so the demo falls back to the same
// builtin seed — both are public barrel exports (D2), no src deep-imports.
//
// Safety: every dynamic string (names, gear ids, status ids) is written via
// textContent — JSON content can never inject markup.
// ----------------------------------------------------------------------------

import { defaultGearSeed } from '../../index';
import type {
    EntitySnapshot,
    GearDefinition,
    SimulationSnapshot,
} from '../../index';

export interface EntitiesPanel {
    render(snapshot: SimulationSnapshot): void;
}

// gearId → definition lookup: resolved catalog entries win, builtin seed fills gaps
const gearLookup = (snapshot: SimulationSnapshot): Map<string, GearDefinition> => {
    const map = new Map<string, GearDefinition>();
    defaultGearSeed.forEach((gear) => map.set(gear.id, gear));
    (snapshot.definition.catalogs?.gear ?? []).forEach((gear) => map.set(gear.id, gear));
    return map;
};

// µs → ms with 3 decimals (D12 timeline/scheduler display; toFixed is exact
// here because every scheduler time is an integer µs, D4a)
const msText = (micros: number): string => `${(micros / 1000).toFixed(3)} ms`;

// Labelled meter row shared by health and durability bars
function makeMeter(labelText: string, value: number, max: number, kind: 'hp' | 'dur'): HTMLElement {
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

function makeCard(entity: EntitySnapshot, snapshot: SimulationSnapshot, gear: Map<string, GearDefinition>): HTMLElement {
    const card = document.createElement('div');
    card.className = `card${entity.living ? '' : ' dead'}`;

    // --- header: name, id/team tags, dead marker ---------------------------
    const head = document.createElement('div');
    head.className = 'card-head';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entity.name; // name defaults to id engine-side (D3)
    head.appendChild(name);
    const idTag = document.createElement('span');
    idTag.className = 'tag';
    idTag.textContent = entity.team ? `#${entity.id} · ${entity.team}` : `#${entity.id}`;
    head.appendChild(idTag);
    if (!entity.living) {
        const dead = document.createElement('span');
        dead.className = 'state-dead';
        dead.textContent = 'dead';
        head.appendChild(dead);
    }
    card.appendChild(head);

    // --- health bar (health / resolved max health, D7 EntityView) -----------
    card.appendChild(makeMeter('health', entity.health, entity.maxHealth, 'hp'));

    // --- stats grid: effective stats (D7) + next-ready from the schedule ----
    const scheduleEntry = snapshot.state.schedule.find((entry) => entry.entityId === entity.id);
    const stats = document.createElement('div');
    stats.className = 'stats';
    const statCells: Array<[string, string]> = [
        ['str', String(entity.stats.strength)],
        // stats.speed is the EFFECTIVE speed (base + modifiers, clamped ≥ 0.001, D4b/D7)
        ['speed (eff)', String(entity.stats.speed)],
        ['def', String(entity.stats.defense)],
        ['precision', String(entity.stats.precision)],
        ['evasion', String(entity.stats.evasion)],
        // next-ready: pending schedule entry (µs → ms, D4a); dead ⇒ dropped (D4e)
        ['next ready', entity.living && scheduleEntry ? msText(scheduleEntry.readyAt) : '—'],
    ];
    statCells.forEach(([labelText, valueText]) => {
        const cell = document.createElement('span');
        cell.textContent = `${labelText} `;
        const strong = document.createElement('b');
        strong.textContent = valueText;
        cell.appendChild(strong);
        stats.appendChild(cell);
    });
    card.appendChild(stats);

    // --- status chips: id ×stacks (+ duration / potency when present, D5c) --
    if (entity.statuses.length > 0) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        entity.statuses.forEach((status) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            let text = `${status.id} ×${status.stacks ?? 1}`;
            if (status.duration !== undefined) text += ` · d${status.duration}`;
            if (status.potency !== undefined && status.potency !== 1) text += ` · p${status.potency}`;
            chip.textContent = text;
            chips.appendChild(chip);
        });
        card.appendChild(chips);
    }

    // --- equipment: current pieces with durability bars + broken struck-through
    const gearSection = document.createElement('div');
    gearSection.className = 'gear';
    const definitionEntity = snapshot.definition.entities[entity.order];
    const initialRefs = [...(definitionEntity.equipment?.weapons ?? []), ...(definitionEntity.equipment?.armour ?? [])];
    if (initialRefs.length === 0) {
        const none = document.createElement('div');
        none.className = 'none';
        none.textContent = 'unarmed, no armour';
        gearSection.appendChild(none);
    }
    initialRefs.forEach((ref) => {
        const current = entity.equipment.find((piece) => piece.gearId === ref.id && piece.slot === ref.slot);
        const definition = gear.get(ref.id);
        const line = document.createElement('div');
        // slot+gearId identity matches the D7 EquipmentEntry contract
        const label = `${ref.slot} · ${definition && definition.name ? definition.name : ref.id}`;
        if (!current) {
            // broken: removed from equipment by the engine (D5b) — struck through
            line.className = 'gear-line broken';
            const brokenName = document.createElement('span');
            brokenName.className = 'gear-name';
            brokenName.textContent = label;
            const brokenTag = document.createElement('span');
            brokenTag.textContent = 'broken';
            line.appendChild(brokenName);
            line.appendChild(brokenTag);
            gearSection.appendChild(line);
            return;
        }
        line.className = 'gear-line';
        const gearName = document.createElement('span');
        gearName.className = 'gear-name';
        gearName.textContent = label;
        line.appendChild(gearName);
        // bar max: explicit GearRef.durability override wins, else catalog value (D3/D9)
        const maxDurability = ref.durability ?? (definition ? definition.durability : current.durability);
        line.appendChild(makeMeter('dur', current.durability, maxDurability, 'dur'));
        gearSection.appendChild(line);
    });
    card.appendChild(gearSection);

    return card;
}

export function createEntitiesPanel(mount: HTMLElement): EntitiesPanel {
    return {
        render(snapshot: SimulationSnapshot): void {
            mount.textContent = ''; // clear previous cards (no innerHTML anywhere)
            const gear = gearLookup(snapshot);
            snapshot.state.entities.forEach((entity) => {
                mount.appendChild(makeCard(entity, snapshot, gear));
            });
        },
    };
}
