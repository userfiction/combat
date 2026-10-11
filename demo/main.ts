// ============================================================================
// demo/main.ts — bootstrap: fixtures → createSimulation → panels (D12)
// ============================================================================
// The demo consumes ONLY the public barrel API via a RELATIVE import
// ('../index', mandated by D12 so demo:build never depends on a prior library
// build) — createSimulation / validateBattleDefinition / CombatValidationError
// / defaultGearSeed (entities.ts) / renderEventText (timeline.ts) + types.
// No plugins are passed: the demo runs on the builtin defaultRules floor
// (builtinRules defaults to true, D2), and JSON contributions come from the
// definitions themselves (D8).
//
// Ownership: main.ts owns the Simulation instance, the autoplay setInterval
// (UI-only pacing — the engine is synchronous, D1/D12), and the render loop.
// ui/* modules receive narrow host callbacks (see controls.ts header).
//
// Keyboard (D12): Space = Step OUTSIDE form controls. Focus in the textarea
// (typing spaces), an input, a select, or a button (native Space activation)
// suppresses the shortcut so nothing double-fires.
// ----------------------------------------------------------------------------

import { CombatValidationError, createSimulation, validateBattleDefinition } from '../index';
import type { BattleDefinition, Simulation, SimulationSnapshot } from '../index';

// Fixtures (D12): plain JSON data — schemaVersion widens to number through the
// JSON import, so values cross into the engine as `unknown` and are validated
// at runtime (validateBattleDefinition) before the type cast below.
import exampleSkirmish from './fixtures/example-skirmish.json';
import quadrupleSpeed from './fixtures/quadruple-speed.json';
import teamWipe from './fixtures/team-wipe.json';
import unarmedDuel from './fixtures/unarmed-duel.json';

import { createControls } from './ui/controls';
import type { ControlsHost } from './ui/controls';
import { createEditor } from './ui/editor';
import type { EditorHost } from './ui/editor';
import { createEntitiesPanel } from './ui/entities';
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

const entitiesPanel = createEntitiesPanel(mustGet('entities-mount'));
const timeline = createTimeline(mustGet('timeline-mount'));
const snapshotPanel = createSnapshotPanel(mustGet('snapshot-mount'));

// µs → ms with 3 decimals (D12; exact for integer-µs scheduler time, D4a)
const msText = (micros: number): string => `${(micros / 1000).toFixed(3)} ms`;

// ----------------------------------------------------------------------------
// Fixtures (seeded dropdown, D12)
// ----------------------------------------------------------------------------

const FIXTURES: ReadonlyArray<{ label: string; raw: unknown }> = [
    { label: 'Crossroads Skirmish (§7 canonical)', raw: exampleSkirmish },
    { label: 'Quadruple Speed (R6 4× demo)', raw: quadrupleSpeed },
    { label: 'Team Wipe (teams elimination)', raw: teamWipe },
    { label: 'Unarmed Duel (durability/breakage)', raw: unarmedDuel },
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
    return entity ? entity.name ?? entity.id : winner;
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
        const faultEvent = snapshot.events.slice().reverse().find((event) => event.type === 'fault');
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

function renderAll(): void {
    const snapshot = sim.snapshot(); // one deep copy per render pass, shared by all panels
    renderBanner(snapshot);
    entitiesPanel.render(snapshot);
    timeline.render(snapshot);
    snapshotPanel.render(snapshot);
    controls.setTerminal(sim.isTerminal()); // terminal idempotence reflected (D12)
}

// ----------------------------------------------------------------------------
// Definition loading (fixtures + editor share this path)
// ----------------------------------------------------------------------------

// Validate-then-replace (D12 editor spec): invalid input returns the error
// list for the editor to print and leaves the live battle untouched; valid
// input replaces the simulation and stops autoplay. The cast below is a
// type-boundary formality only — validateBattleDefinition has already proven
// the shape at runtime.
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
    renderAll();
    return [];
}

const editorHost: EditorHost = {
    apply: applyDefinition,
    definitionJson: () => JSON.stringify(sim.definition, null, 2),
    snapshotJson: () => JSON.stringify(sim.snapshot(), null, 2),
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
        // RESET semantics: rewinds the LIVE simulation (D10); the editor draft
        // — valid or not — is untouched and only takes effect via Apply.
        stopAutoplay();
        sim.reset();
        timeline.reset();
        renderAll();
    },
    rateChanged(ratePerSecondValue: number): void {
        ratePerSecond = ratePerSecondValue > 0 ? ratePerSecondValue : 1;
        // restart the interval immediately so the new pace applies at once
        if (timer !== undefined) {
            stopAutoplay();
            startAutoplay();
        }
    },
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

document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return;
    const target = event.target as HTMLElement | null;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    // textarea/input/select keep native Space behavior; buttons activate on
    // Space natively — stepping here too would double-fire
    if (tag === 'textarea' || tag === 'input' || tag === 'select' || tag === 'button') return;
    event.preventDefault(); // stop page scroll
    controlsHost.step();
});

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
