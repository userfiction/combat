// ============================================================================
// demo/main.ts — bootstrap: fixtures → createSimulation → panels (D12, T3)
// ============================================================================
// The demo consumes ONLY the public barrel API via a RELATIVE import
// ('../index', mandated by D12 so demo:build never depends on a prior library
// build) — createSimulation / validateBattleDefinition / CombatValidationError
// / renderEventText (timeline.ts) + types. No plugins are passed: the demo
// runs on the builtin defaultRules floor (builtinRules defaults to true, D2),
// and JSON contributions come from the definitions themselves (D8).
//
// Ownership: main.ts owns the Simulation instance, the autoplay setInterval
// (UI-only pacing — the engine is synchronous, D1/D12), and the render loop.
// ui/* modules receive narrow host callbacks (see controls.ts header).
//
// T3 UI: ONE live "Combatants" panel (ui/combatants.ts) replaces the earlier
// draft-driven setup panel and the read-only Entities list. Panel edits call
// sim.editCombatant (frozen T3 contract: synchronous, throws
// CombatValidationError, returns the fresh snapshot) through the single
// editCombatantHost path below:
//   - success → renderAll from the RETURNED snapshot; autoplay keeps running,
//     the timeline is NOT reset (ids continue), the editor draft is untouched;
//   - failure (CombatValidationError) → the error list is returned for the
//     panel to show INLINE; the snapshot is unchanged (the contract guarantees
//     no mutation on rejection).
// The JSON editor remains the ORIGINAL-DEFINITION / new-battle path ("Advanced
// battle definition / Apply & restart"): fixtures, imports and Apply always
// start a NEW battle; Reset rewinds the live battle to its initial state and
// thereby DISCARDS live panel edits (engine reset semantics, D10).
//
// Keyboard (D12): Space = Step OUTSIDE form controls. Focus in the textarea
// (typing spaces), an input, a select, or a button (native Space activation)
// suppresses the shortcut so nothing double-fires.
// ----------------------------------------------------------------------------

import { CombatValidationError, createSimulation, validateBattleDefinition } from '../index';
import type { BattleDefinition, CombatantEdit, Simulation, SimulationSnapshot } from '../index';

// Fixtures (D12): plain JSON data — schemaVersion widens to number through the
// JSON import, so values cross into the engine as `unknown` and are validated
// at runtime (validateBattleDefinition) before the type cast below.
import exampleSkirmish from './fixtures/example-skirmish.json';
import quadrupleSpeed from './fixtures/quadruple-speed.json';
import statusTrials from './fixtures/status-trials.json';
import teamWipe from './fixtures/team-wipe.json';
import unarmedDuel from './fixtures/unarmed-duel.json';

import { createCombatantsPanel } from './ui/combatants';
import type { CombatantsHost } from './ui/combatants';
import { createControls } from './ui/controls';
import type { ControlsHost } from './ui/controls';
import { createEditor } from './ui/editor';
import type { EditorHost } from './ui/editor';
import { createSnapshotPanel } from './ui/snapshot';
import { createTimeline } from './ui/timeline';

// ----------------------------------------------------------------------------
// Shell wiring
// ----------------------------------------------------------------------------

// The static shell (index.html) must provide these mounts; a missing id is a
// build/shell bug, so fail loudly at startup rather than degrade silently.
function mustGet(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`demo shell is missing #${id}`);
    return element;
}

const banner = mustGet('banner');
const fixtureSelect = mustGet('fixture-select') as HTMLSelectElement;

const timeline = createTimeline(mustGet('timeline-mount'));
const snapshotPanel = createSnapshotPanel(mustGet('snapshot-mount'));
// The host callback routes into applyCombatantEdit (hoisted function
// declaration below); the panel only invokes it from user events, by which
// time `sim` is initialized.
const combatants = createCombatantsPanel(mustGet('combatants-mount'), {
    editCombatant: (edit: CombatantEdit): string[] => applyCombatantEdit(edit)
});

// µs → ms with 3 decimals (D12; exact for integer-µs scheduler time, D4a)
const msText = (micros: number): string => `${(micros / 1000).toFixed(3)} ms`;

// ----------------------------------------------------------------------------
// Fixtures (seeded dropdown, D12)
// ----------------------------------------------------------------------------

const FIXTURES: ReadonlyArray<{ label: string; raw: unknown }> = [
    { label: 'Crossroads Skirmish (§7 canonical)', raw: exampleSkirmish },
    { label: 'Status Trials (statuses · injuries · resources)', raw: statusTrials },
    { label: 'Quadruple Speed (R6 4× demo)', raw: quadrupleSpeed },
    { label: 'Team Wipe (teams elimination)', raw: teamWipe },
    { label: 'Unarmed Duel (durability/breakage)', raw: unarmedDuel }
];

// ----------------------------------------------------------------------------
// Simulation + autoplay state
// ----------------------------------------------------------------------------

let sim: Simulation;
let ratePerSecond = 2; // matches the controls.ts default select value
// ReturnType<typeof setInterval> sidesteps the DOM-number vs node-timeout
// global ambiguity; clearInterval accepts whatever this is.
let timer: ReturnType<typeof setInterval> | undefined;

function stopAutoplay(): void {
    if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
    controls.setPlaying(false);
}

function startAutoplay(): void {
    // UI-paced only (D12): one synchronous sim.step() per interval tick;
    // the engine itself never sees a timer (D1/§3).
    if (timer !== undefined || sim.isTerminal()) return;
    timer = setInterval(() => {
        if (sim.isTerminal()) {
            stopAutoplay();
            return;
        }
        sim.step();
        renderAll();
        if (sim.isTerminal()) stopAutoplay(); // halt exactly at the terminal step
    }, 1000 / ratePerSecond);
    controls.setPlaying(true);
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

// Resolve a winner id (teamId in teams mode, entityId in ffa — D5g) to its
// display name for the banner; falls back to the raw id.
function winnerName(definition: BattleDefinition, winner: string): string {
    const team = (definition.teams ?? []).find((candidate) => candidate.id === winner);
    if (team) return team.name ?? team.id;
    const entity = definition.entities.find((candidate) => candidate.id === winner);
    return entity ? (entity.name ?? entity.id) : winner;
}

// Outcome banner (D12): running line, then victory / draw / undecided / fault.
// Fault shows plugin id + error — the verdict carries `error` (D10) and the
// fault EVENT payload carries pluginId/hook (D11), so both are read here.
function renderBanner(snapshot: SimulationSnapshot): void {
    const outcome = snapshot.state.terminal;
    if (!outcome) {
        banner.className = 'banner running';
        banner.textContent = `Running — step ${snapshot.state.step} · ${msText(snapshot.state.virtualTime)}`;
        return;
    }
    banner.className = `banner ${outcome.outcome}`; // victory|draw|undecided|fault → styles.css
    if (outcome.outcome === 'victory' && outcome.winner) {
        banner.textContent = `Victory — ${winnerName(snapshot.definition, outcome.winner)} wins (step ${outcome.step})`;
        return;
    }
    if (outcome.outcome === 'fault') {
        const faultEvent = snapshot.events
            .slice()
            .reverse()
            .find((event) => event.type === 'fault');
        // D11 fault payload: { pluginId?, hook?, error } — unknown-shaped by contract
        const payload: Record<string, unknown> = (faultEvent && faultEvent.payload) ?? {};
        const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : undefined;
        const hook = typeof payload.hook === 'string' ? payload.hook : undefined;
        const error = outcome.error ?? (typeof payload.error === 'string' ? payload.error : 'unknown error');
        banner.textContent = `Fault — ${error}${pluginId ? `\nplugin: ${pluginId}${hook ? ` · hook: ${hook}` : ''}` : ''}`;
        return;
    }
    // draw / undecided: reason is an open-set string (D5g) — rendered verbatim
    const label = outcome.outcome === 'draw' ? 'Draw' : 'Undecided';
    banner.textContent = `${label}${outcome.reason ? ` — ${outcome.reason}` : ''} (step ${outcome.step})`;
}

// One render pass over every panel. `prebuilt` lets a caller share the exact
// snapshot object it already holds (editCombatant's return) instead of paying
// for a second sim.snapshot() deep copy.
function renderAll(prebuilt?: SimulationSnapshot): void {
    const snapshot = prebuilt ?? sim.snapshot(); // one deep copy per render pass, shared by all panels
    renderBanner(snapshot);
    combatants.render(snapshot);
    timeline.render(snapshot);
    snapshotPanel.render(snapshot);
    controls.setTerminal(sim.isTerminal()); // terminal idempotence reflected (D12)
}

// ----------------------------------------------------------------------------
// Live combatant editing (T3) — the ONE edit path for the Combatants panel
// ----------------------------------------------------------------------------

// Frozen T3 contract: Simulation.editCombatant is SYNCHRONOUS, throws
// CombatValidationError (full error list) and returns the fresh snapshot.
// Success: render everything from the returned snapshot — autoplay is NOT
// stopped, timeline.reset is NOT called (event ids continue; the timeline's
// incremental append simply picks up new events), and the editor draft is
// NOT touched (live edits are state-level, the draft stays the original
// definition). Failure: return the error list; the snapshot is unchanged
// (contract: no mutation on rejection) so nothing is re-rendered and the
// panel shows the errors inline.
function applyCombatantEdit(edit: CombatantEdit): string[] {
    try {
        const snapshot = sim.editCombatant(edit);
        renderAll(snapshot);
        return [];
    } catch (error) {
        if (error instanceof CombatValidationError) return error.errors;
        // Defensive: non-validation throwables (engine contract bugs) surface
        // as a single message instead of crashing the demo.
        return [error instanceof Error ? error.message : String(error)];
    }
}

// ----------------------------------------------------------------------------
// Definition loading (fixtures + editor share this path)
// ----------------------------------------------------------------------------

// Validate-then-replace (D12 editor spec): invalid input returns the error
// list for the editor to print and leaves the live battle untouched; valid
// input replaces the simulation and stops autoplay. The cast below is a
// type-boundary formality only — validateBattleDefinition has already proven
// the shape at runtime.
//
// T3: this is STILL the only "start a new battle" path — the Advanced
// editor's "Apply & restart", fixture loading and file import all route
// through it. Live Combatants edits NEVER come through here (they are
// editCombatant calls, no restart). A successful replace clears the
// combatants panel's normalization notes (they described the previous
// battle's edits).
function applyDefinition(raw: unknown): string[] {
    const validation = validateBattleDefinition(raw);
    if (!validation.valid) return validation.errors;
    try {
        stopAutoplay();
        sim = createSimulation(raw as BattleDefinition);
    } catch (error) {
        // Defensive: createSimulation re-validates and throws the same list
        // (D2 fail-fast); surface it instead of crashing the demo.
        if (error instanceof CombatValidationError) return error.errors;
        return [`createSimulation failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    timeline.reset(); // new battle ⇒ event ids restart at 1 (D10)
    combatants.clearNotes();
    renderAll();
    return [];
}

const editorHost: EditorHost = {
    apply: applyDefinition,
    definitionJson: () => JSON.stringify(sim.definition, null, 2),
    snapshotJson: () => JSON.stringify(sim.snapshot(), null, 2)
    // NOTE (T3): no onDraftEdited hook — the textarea is decoupled from the
    // live panel. Malformed mid-edit JSON is harmless: the Combatants panel
    // reads the snapshot, never this text.
};
const editor = createEditor(mustGet('editor-mount'), editorHost);

const controlsHost: ControlsHost = {
    step(): void {
        if (sim.isTerminal()) return; // terminal step() is idempotent anyway (D5g)
        sim.step();
        renderAll();
    },
    toggleAutoplay(): void {
        if (timer !== undefined) stopAutoplay();
        else startAutoplay();
    },
    runToEnd(): void {
        stopAutoplay();
        sim.run(); // synchronous to terminal (D1); bounded by maxSteps (D4f)
        renderAll();
    },
    reset(): void {
        // RESET semantics (D10 + T3): rewinds the LIVE simulation to its
        // initial state from the stored definition — which DISCARDS every
        // live Combatants edit (they are state-level, reset re-derives from
        // the definition). The editor draft — valid or not — is untouched
        // and only takes effect via Apply & restart.
        stopAutoplay();
        sim.reset();
        timeline.reset();
        combatants.clearNotes();
        renderAll();
    },
    rateChanged(ratePerSecondValue: number): void {
        ratePerSecond = ratePerSecondValue > 0 ? ratePerSecondValue : 1;
        // restart the interval immediately so the new pace applies at once
        if (timer !== undefined) {
            stopAutoplay();
            startAutoplay();
        }
    }
};
const controls = createControls(mustGet('controls-mount'), controlsHost);

// ----------------------------------------------------------------------------
// Fixture dropdown
// ----------------------------------------------------------------------------

FIXTURES.forEach((fixture, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = fixture.label;
    fixtureSelect.appendChild(option);
});

function loadFixture(index: number): void {
    const fixture = FIXTURES[index] ?? FIXTURES[0];
    // editor shows the fixture re-serialized (4-space) — byte-identical JSON
    // semantics to the file, deterministic display
    editor.setText(JSON.stringify(fixture.raw, null, 4));
    const errors = applyDefinition(fixture.raw);
    editor.showErrors(errors); // empty for the shipped fixtures (validated at startup below)
}

fixtureSelect.addEventListener('change', () => {
    loadFixture(Number(fixtureSelect.value));
});

// ----------------------------------------------------------------------------
// Keyboard shortcut: Space = Step outside form controls (D12)
// ----------------------------------------------------------------------------
// Re-bootstrap safety: Vite HMR (dev) and test harnesses re-execute this
// module, which would stack duplicate document-level keydown listeners whose
// closures step STALE simulations. The current handler is stored on the
// document and the previous one is removed first, so only the newest module
// instance ever steps the live battle.
const keydownDocument = document as Document & { __combatStepKeydown?: (event: KeyboardEvent) => void };
if (keydownDocument.__combatStepKeydown) {
    document.removeEventListener('keydown', keydownDocument.__combatStepKeydown);
}
const stepKeydown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return;
    const target = event.target as HTMLElement | null;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    // textarea/input/select keep native Space behavior; buttons activate on
    // Space natively — stepping here too would double-fire. The Combatants
    // panel is built entirely from form controls, so it is covered by this
    // guard (checkbox inputs included via the 'input' tag check).
    if (tag === 'textarea' || tag === 'input' || tag === 'select' || tag === 'button') return;
    event.preventDefault(); // stop page scroll
    controlsHost.step();
};
keydownDocument.__combatStepKeydown = stepKeydown;
document.addEventListener('keydown', stepKeydown);

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------

// Self-check the shipped fixtures at load (cheap, synchronous): a fixture that
// fails validation is a demo bug and gets one console.error — the browser
// checklist (§10) expects a clean console, so this only fires on regressions.
FIXTURES.forEach((fixture) => {
    const validation = validateBattleDefinition(fixture.raw);
    if (!validation.valid) {
        console.error(`demo fixture invalid: ${fixture.label}`, validation.errors);
    }
});

fixtureSelect.value = '0';
loadFixture(0); // default view: the §7 canonical skirmish
