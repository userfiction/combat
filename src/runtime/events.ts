// ============================================================================
// @userfiction/combat — src/runtime/events.ts — T5 event log + text renderer
// (task §9 T5, D11 event shapes, D10 id rules, D4f log cap)
// ============================================================================
// Two responsibilities, both engine-side (D7 "only the engine mutates"):
//
//   createEventLog — the single append point for the battle log. Stamps
//     { id, step, time } on every event (D11: id is a monotonic integer
//     restarting at 1 per log; trim keeps ids monotonic; restore continues
//     from max(id)+1, D10). Owns the deterministic maxLogEvents trim (D3/D4f:
//     oldest events DROPPED with a 'log-trimmed' notice) and the D7
//     transaction marker/rollback pair the pipeline uses to remove every
//     event emitted inside a faulting step.
//
//   renderEventText — the default English formatter (D11): one formatter per
//     known type + the fallback `[type] message ?? ''`. Deterministic; the
//     UI and clients may swap/extend the map. Optional snapshot argument
//     resolves entity ids to display names (D3 name defaults to id).
//
// Trim timing decision (documented, deterministic): the cap is enforced at
// END of successful steps and after construction/fault appends — never
// mid-step. Mid-step trimming would splice events BELOW the transaction
// marker and break the D7 "state == pre-step" rollback invariant (a later
// truncate could not restore front-dropped events). End-of-step trimming
// keeps every in-step log purely append-only, so marker/rollback stays exact.
//
// Damage-event payload note (D11 vs D11 renderer pin): the pinned renderer
// variants "(crit!)" / "(blocked)" require the damage event to carry the
// crit flag; D11's payload list has `mitigations.blocked` but no crit field.
// Conservative resolution: the pipeline adds `crit: boolean` to the damage
// payload (plugins may carry arbitrary payloads anyway, D11). Blocked rides
// in mitigations.blocked exactly as specced.
//
// Zero dependencies (D14); synchronous, no timers, no DOM (D1/§3).
// ============================================================================

import type { BattleEvent, BattleEvent as Event, EventDraft, SimulationSnapshot } from '../contract/types';

// ----------------------------------------------------------------------------
// Event log (engine-owned)
// ----------------------------------------------------------------------------

// Transaction marker for the D7 fault rollback: log length + next id at the
// moment the marker was taken. rollback() restores BOTH so ids stay
// monotonic and never skip after a fault (the fault event reuses the id the
// first rolled-back event would have had).
export interface EventLogMarker {
    length: number;
    nextId: number;
}

export interface EventLog {
    // Append one event: stamps id/step/time, deep-copies the draft's payload
    // so later handler mutation of a returned/passed object cannot rewrite
    // history. Returns the stored event (live entry — engine-internal).
    emit(draft: EventDraft, step: number, time: number): BattleEvent;
    // Live internal array — engine-owned readers (snapshotOf deep-copies).
    all(): BattleEvent[];
    count(): number;
    nextEventId(): number;
    marker(): EventLogMarker;
    rollback(marker: EventLogMarker): void;
    // D10 restore: adopt a stored log; next id continues from max(id)+1.
    restore(events: readonly BattleEvent[]): void;
    // Fresh-log rewind (Simulation.reset): empty log, ids restart at 1.
    clear(): void;
    // Enforce maxLogEvents: drop the oldest events so the final length is
    // exactly the cap (one slot reserved for the 'log-trimmed' notice).
    // Returns the dropped count (0 when under cap).
    trim(step: number, time: number): number;
}

export const createEventLog = (maxLogEvents: number): EventLog => {
    const events: BattleEvent[] = [];
    let nextId = 1;

    return {
        emit: (draft, step, time) => {
            // payload deep-copied via structured spread of plain JSON data;
            // drafts are engine/plugin built, payload is the only nested
            // field (D11), so a one-level JSON copy suffices and stays
            // dependency-free (D14).
            const event: BattleEvent = {
                id: nextId++,
                step,
                time,
                type: draft.type,
                ...(draft.actor !== undefined ? { actor: draft.actor } : {}),
                ...(draft.target !== undefined ? { target: draft.target } : {}),
                ...(draft.message !== undefined ? { message: draft.message } : {}),
                ...(draft.payload !== undefined ? { payload: JSON.parse(JSON.stringify(draft.payload)) as Record<string, unknown> } : {}),
            };
            events.push(event);
            return event;
        },
        all: () => events,
        count: () => events.length,
        nextEventId: () => nextId,
        marker: () => ({ length: events.length, nextId }),
        rollback: (marker) => {
            // D7: every event emitted within the faulting step is removed;
            // the id counter rewinds so the fault event reuses the id.
            events.length = marker.length;
            nextId = marker.nextId;
        },
        restore: (stored) => {
            events.length = 0;
            events.push(...JSON.parse(JSON.stringify(stored)) as BattleEvent[]);
            // D10: restore continues from max(id)+1 (empty log ⇒ 1).
            let max = 0;
            for (const event of events) if (event.id > max) max = event.id;
            nextId = max + 1;
        },
        clear: () => {
            events.length = 0;
            nextId = 1;
        },
        trim: (step, time) => {
            if (events.length <= maxLogEvents) return 0;
            // +1 slot reserved for the notice so the final length == cap.
            const dropped = events.length - maxLogEvents + 1;
            events.splice(0, dropped);
            // The notice rides through emit (ids stay monotonic: the oldest
            // REMAINING id is always below the fresh id).
            const notice: EventDraft = { type: 'log-trimmed', payload: { dropped } };
            // Inline stamp (not this.emit) to avoid recursion if the cap is
            // ever 0-guarded upstream; MIN_MAX_LOG_EVENTS = 1 (D13) keeps
            // the notice inside the cap by construction.
            const event: BattleEvent = { id: nextId++, step, time, ...notice };
            events.push(event);
            return dropped;
        },
    };
};

// ----------------------------------------------------------------------------
// renderEventText (D11)
// ----------------------------------------------------------------------------

// Resolve an entity id to its display name via the snapshot (names default
// to ids, D3); unknown/absent ids render as the raw id.
const nameOf = (id: string | undefined, snapshot?: SimulationSnapshot): string | undefined => {
    if (id === undefined) return undefined;
    const entity = snapshot?.state.entities.find((candidate) => candidate.id === id);
    return entity ? entity.name : id;
};

// Payload field readers — events are plain JSON (D11); casts are localized
// and every formatter has a deterministic fallback so a malformed or custom
// payload never throws.
const num = (payload: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = payload?.[key];
    return typeof value === 'number' ? value : undefined;
};
const str = (payload: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = payload?.[key];
    return typeof value === 'string' ? value : undefined;
};
const bool = (payload: Record<string, unknown> | undefined, key: string): boolean => payload?.[key] === true;
const mitigations = (payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    const value = payload?.['mitigations'];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
};

// The default formatter map (D11: "one formatter per type + fallback").
// Exported so clients can extend/override individual entries without forking
// the whole renderer.
export const eventFormatters: Record<string, (event: Event, snapshot?: SimulationSnapshot) => string> = {
    'battle:start': (event) => {
        const mode = str(event.payload, 'mode') ?? '?';
        const seed = num(event.payload, 'seed');
        return `Battle begins (${mode} mode${seed !== undefined ? `, seed ${seed}` : ''})`;
    },
    'turn:start': (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'}'s turn`,
    action: (event, snapshot) => {
        const actor = nameOf(event.actor, snapshot) ?? '?';
        const kind = str(event.payload, 'kind') ?? '?';
        if (kind === 'attack') return `${actor} attacks`;
        if (kind === 'ability') return `${actor} uses ${str(event.payload, 'abilityId') ?? '?'}`;
        if (kind === 'wait') return `${actor} waits`;
        const reason = str(event.payload, 'reason');
        return reason ? `${actor} skips (${reason})` : `${actor} skips`;
    },
    // Pinned (D11): "Fang Brute dodges Whisper's attack" — actor = dodger.
    dodge: (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'} dodges ${nameOf(event.target, snapshot) ?? '?'}'s attack`,
    crit: (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'} lands a critical hit!`,
    block: (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'} blocks the attack!`,
    damage: (event, snapshot) => {
        const amount = num(event.payload, 'amount') ?? 0;
        const damageType = str(event.payload, 'damageType') ?? 'damage';
        const source = str(event.payload, 'source') ?? 'effect';
        const attacker = nameOf(event.actor, snapshot);
        const target = nameOf(event.target, snapshot) ?? '?';
        const weaponId = str(event.payload, 'weaponId');
        let text: string;
        if (source === 'effect') {
            text = `${target} takes ${amount} ${damageType} damage`;
        } else if (weaponId !== undefined) {
            // Pinned (D11): "Whisper hits Fang Brute with cult-dagger for 4 sharp damage"
            text = `${attacker ?? '?'} hits ${target} with ${weaponId} for ${amount} ${damageType} damage`;
        } else if (source === 'unarmed') {
            text = `${attacker ?? '?'} hits ${target} bare-handed for ${amount} ${damageType} damage`;
        } else {
            // Generic damage-over-time naming: the source IS the status id
            // (the definition turn-end tick emits source: statusId), so any
            // custom DOT renders by its own name — no hardcoded per-id cases.
            text = `${target} suffers ${source} for ${amount} ${damageType} damage`;
        }
        // Pinned variants (D11): crit/block suffixes. crit rides in payload
        // (see header note); blocked rides in mitigations.blocked (D11).
        if (bool(event.payload, 'crit')) text += ' (crit!)';
        if (mitigations(event.payload)?.['blocked'] === true) text += ' (blocked)';
        return text;
    },
    heal: (event, snapshot) => {
        const amount = num(event.payload, 'amount') ?? 0;
        const actor = nameOf(event.actor, snapshot);
        const target = nameOf(event.target, snapshot);
        if (target !== undefined && target !== actor) return `${actor ?? '?'} heals ${target} for ${amount}`;
        return `${actor ?? '?'} heals for ${amount}`;
    },
    'status:applied': (event, snapshot) => {
        const statusId = str(event.payload, 'statusId') ?? '?';
        const stacks = num(event.payload, 'stacks') ?? 1;
        const duration = num(event.payload, 'duration');
        const potency = num(event.payload, 'potency');
        const parts = [`stacks ${stacks}`];
        if (duration !== undefined) parts.push(`duration ${duration}`);
        if (potency !== undefined) parts.push(`potency ${potency}`);
        return `${nameOf(event.actor, snapshot) ?? '?'} gains ${statusId} (${parts.join(', ')})`;
    },
    'status:resisted': (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'} resists ${str(event.payload, 'statusId') ?? '?'}`,
    'status:tick': (event, snapshot) => {
        const statusId = str(event.payload, 'statusId') ?? '?';
        const damage = num(event.payload, 'damage');
        return damage !== undefined
            ? `${nameOf(event.actor, snapshot) ?? '?'} suffers ${statusId} for ${damage} damage`
            : `${nameOf(event.actor, snapshot) ?? '?'} suffers ${statusId}`;
    },
    'status:expired': (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'}'s ${str(event.payload, 'statusId') ?? '?'} fades`,
    // the SUBJECT of stat events is the modified entity: the pipeline emits
    // actor = source, target = subject, so the renderer prefers target
    'stat:modified': (event, snapshot) =>
        `${nameOf(event.target ?? event.actor, snapshot) ?? '?'}'s ${str(event.payload, 'stat') ?? '?'} changes by ${num(event.payload, 'amount') ?? 0}`,
    'stat:expired': (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'}'s ${str(event.payload, 'stat') ?? '?'} modifier fades`,
    'gear:damaged': (event, snapshot) =>
        `${nameOf(event.actor, snapshot) ?? '?'}'s ${str(event.payload, 'gearId') ?? '?'} wears (${num(event.payload, 'durability') ?? 0} durability left)`,
    'gear:broken': (event, snapshot) => `${nameOf(event.actor, snapshot) ?? '?'}'s ${str(event.payload, 'gearId') ?? '?'} breaks!`,
    // T2 (R2) injury events: the SUBJECT rides target (apply) / actor
    // (heal, emitted with actor=subject by the engine adapter)
    'injury:applied': (event, snapshot) =>
        `${nameOf(event.target ?? event.actor, snapshot) ?? '?'} loses ${str(event.payload, 'part') ?? '?'}`,
    'injury:healed': (event, snapshot) =>
        `${nameOf(event.target ?? event.actor, snapshot) ?? '?'} recovers ${str(event.payload, 'part') ?? '?'}`,
    // T2 (R3) resource events
    'resource:spent': (event, snapshot) => {
        const costs = event.payload?.['costs'];
        const parts: string[] = [];
        if (costs && typeof costs === 'object') {
            const record = costs as Record<string, unknown>;
            for (const key of ['health', 'stamina', 'mana']) {
                if (typeof record[key] === 'number') parts.push(`${record[key]} ${key}`);
            }
        }
        return `${nameOf(event.actor, snapshot) ?? '?'} spends ${parts.length > 0 ? parts.join(', ') : 'resources'}`;
    },
    'resource:modified': (event, snapshot) => {
        const resource = str(event.payload, 'resource') ?? '?';
        const amount = num(event.payload, 'amount') ?? 0;
        const current = num(event.payload, 'current') ?? 0;
        const verb = amount >= 0 ? 'restores' : 'drains';
        return `${nameOf(event.target ?? event.actor, snapshot) ?? '?'} ${verb} ${Math.abs(amount)} ${resource} (${current} left)`;
    },
    death: (event, snapshot) => {
        const killer = nameOf(str(event.payload, 'killerId'), snapshot);
        const victim = nameOf(event.actor, snapshot) ?? '?';
        return killer ? `${victim} falls, slain by ${killer}` : `${victim} falls`;
    },
    'log-trimmed': (event) => `Log trimmed (${num(event.payload, 'dropped') ?? 0} events dropped)`,
    'step:end': (event) => `End of step ${num(event.payload, 'step') ?? event.step}`,
    outcome: (event, snapshot) => {
        const kind = str(event.payload, 'outcome') ?? '?';
        const winner = nameOf(str(event.payload, 'winner'), snapshot);
        const reason = str(event.payload, 'reason');
        if (kind === 'victory') return `Victory: ${winner ?? '?'}`;
        if (kind === 'draw') return `Draw${reason ? ` (${reason})` : ''}`;
        if (kind === 'undecided') return `Undecided${reason ? ` (${reason})` : ''}`;
        return `Fault${reason ? ` (${reason})` : ''}`;
    },
    fault: (event) => {
        const pluginId = str(event.payload, 'pluginId');
        const hook = str(event.payload, 'hook');
        const error = str(event.payload, 'error') ?? event.message ?? 'unknown error';
        const where = [pluginId, hook].filter(Boolean).join(' at ');
        return where ? `Fault in ${where}: ${error}` : `Fault: ${error}`;
    },
    // D8 'emit' effect custom event (pipeline type 'message'): the message
    // IS the text.
    message: (event) => event.message ?? '',
    // T3 live edit: the subject rides actor; the payload carries the touched
    // domain list (see pipeline.ts editCombatant payload builder).
    'combatant:edited': (event, snapshot) => {
        const domains = event.payload?.['domains'];
        const list = Array.isArray(domains) ? (domains as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
        return `${nameOf(event.actor, snapshot) ?? '?'} edited${list.length > 0 ? ` (${list.join(', ')})` : ''}`;
    },
};

// D11 renderer: one formatter per type + fallback `[${type}] ${message ?? ''}`.
export const renderEventText = (event: BattleEvent, snapshot?: SimulationSnapshot): string => {
    const formatter = eventFormatters[event.type];
    if (formatter) return formatter(event, snapshot);
    return `[${event.type}] ${event.message ?? ''}`;
};
