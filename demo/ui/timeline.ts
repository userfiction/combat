// ============================================================================
// demo/ui/timeline.ts — per-step battle log (D12)
// ============================================================================
// Groups events by STEP (D4f: "log grouping in the UI is per step" — there is
// no round concept) and renders each line through the engine's public
// renderEventText (D11) — the demo never re-implements formatters. Group
// headers carry the step index and virtual time in ms with 3 decimals (D12;
// exact because scheduler time is integer µs, D4a).
//
// The mount element carries aria-live="polite" (set in index.html per D12);
// INCREMENTAL appends mean screen readers announce only new lines instead of
// re-reading the whole log on every step.
//
// Incremental strategy: remember the highest rendered event id; append events
// with a greater id. If the incoming log's last id is LOWER (sim.reset() or a
// definition replace restarts ids at 1, D10) the view clears and re-renders.
// main.ts also calls reset() explicitly on replace/reset for the equal-length
// edge (fresh battle with exactly the same id count). A maxLogEvents TRIM
// (D3) drops old events from the log; already-rendered groups stay in the DOM
// (display history, harmless at demo scale — disclosed in comment).
//
// Safety: renderEventText output is plain text written via textContent —
// names/messages from JSON definitions cannot inject markup.
// ----------------------------------------------------------------------------

import { renderEventText } from '../../index';
import type { BattleEvent, SimulationSnapshot } from '../../index';

export interface Timeline {
    render(snapshot: SimulationSnapshot): void;
    /** Drop all groups (definition replace / reset — event ids restart at 1). */
    reset(): void;
}

// µs → ms with 3 decimals (D12 display rule)
const msText = (micros: number): string => `${(micros / 1000).toFixed(3)} ms`;

export function createTimeline(mount: HTMLElement): Timeline {
    let lastRenderedId = 0;
    let currentGroup: HTMLElement | null = null;
    let currentGroupStep = -1;

    const clear = (): void => {
        mount.textContent = '';
        lastRenderedId = 0;
        currentGroup = null;
        currentGroupStep = -1;
    };

    // One group per step: header "step N · t ms", then one line per event
    const appendGroupHeader = (event: BattleEvent): void => {
        currentGroup = document.createElement('div');
        currentGroup.className = 'tl-group';
        currentGroupStep = event.step;
        const header = document.createElement('div');
        header.className = 'tl-head';
        header.textContent = `step ${event.step} · ${msText(event.time)}`;
        currentGroup.appendChild(header);
        mount.appendChild(currentGroup);
    };

    const appendEvent = (event: BattleEvent): void => {
        if (event.step !== currentGroupStep || currentGroup === null) appendGroupHeader(event);
        const line = document.createElement('div');
        // type-classed for death/outcome/fault emphasis (styles.css)
        line.className = `tl-line ${event.type}`;
        const time = document.createElement('span');
        time.className = 'tl-time';
        time.textContent = `${msText(event.time)}`;
        line.appendChild(time);
        const text = document.createElement('span');
        text.textContent = renderEventText(event); // engine formatter (D11)
        line.appendChild(text);
        (currentGroup as HTMLElement).appendChild(line);
        lastRenderedId = event.id;
    };

    return {
        render(snapshot: SimulationSnapshot): void {
            const events = snapshot.events;
            const lastId = events.length > 0 ? events[events.length - 1].id : 0;
            // log shrank ⇒ reset/replace restarted the id sequence (D10)
            if (lastId < lastRenderedId) clear();
            events.forEach((event) => {
                if (event.id > lastRenderedId) appendEvent(event);
            });
        },
        reset(): void {
            clear();
        },
    };
}
