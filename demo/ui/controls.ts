// ============================================================================
// demo/ui/controls.ts — playback controls (D12)
// ============================================================================
// Step / Run-Pause autoplay / Run-to-terminal / Reset + steps-per-second
// select (1/2/4/8). AUTOPLAY PACING LIVES HERE, NOT IN THE ENGINE (D12):
// the engine is synchronous (D1); the UI drives it one step() per setInterval
// tick. The interval handle itself is owned by main.ts (it also has to stop
// autoplay on terminal/editor-apply), this module only reports clicks and
// reflects state.
//
// Terminal idempotence is reflected (D12): Step / Run / Run-to-terminal are
// disabled once the battle is terminal; Reset stays enabled (reset() rewinds
// to the initial state, D10).
//
// Accessibility (D12): real <button> elements with text labels; the Run/Pause
// toggle carries aria-pressed. All labels are static strings — safe by
// construction.
// ----------------------------------------------------------------------------

// Host callbacks implemented by main.ts — the module never touches the
// Simulation directly (one-directional data flow: click → host → re-render).
export interface ControlsHost {
    /** Advance exactly one step (engine step(); terminal no-op handled by main). */
    step(): void;
    /** Start/stop UI-paced autoplay (setInterval lives in main.ts — D12). */
    toggleAutoplay(): void;
    /** sim.run() to terminal in one synchronous call, then render. */
    runToEnd(): void;
    /** sim.reset() — rewinds the LIVE simulation; editor draft is irrelevant. */
    reset(): void;
    /** Autoplay rate changed (main restarts the interval if currently playing). */
    rateChanged(ratePerSecond: number): void;
}

// Autoplay rate options (D12: steps/sec select 1/2/4/8)
const RATES_PER_SEC = [1, 2, 4, 8];

export interface Controls {
    /** Reflect autoplay state on the toggle button. */
    setPlaying(playing: boolean): void;
    /** Reflect terminal state: disables Step/Run/Run-to-terminal (D12). */
    setTerminal(terminal: boolean): void;
}

// Tiny DOM helper: element with a text label (textContent — never innerHTML)
function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

export function createControls(mount: HTMLElement, host: ControlsHost): Controls {
    const root = document.createElement('div');
    root.className = 'controls';

    const stepButton = makeButton('Step', () => host.step());
    const runButton = makeButton('Run', () => host.toggleAutoplay());
    runButton.setAttribute('aria-pressed', 'false');
    const runToEndButton = makeButton('Run to terminal', () => host.runToEnd());
    const resetButton = makeButton('Reset', () => host.reset());

    // Rate selector: main.ts restarts the interval when playing (host callback)
    const rateWrap = document.createElement('label');
    rateWrap.className = 'rate-label';
    rateWrap.htmlFor = 'rate-select';
    rateWrap.textContent = 'steps/sec ';
    const rateSelect = document.createElement('select');
    rateSelect.id = 'rate-select';
    RATES_PER_SEC.forEach((rate) => {
        const option = document.createElement('option');
        option.value = String(rate);
        option.textContent = `${rate}/s`;
        if (rate === 2) option.selected = true; // default pacing 2/s
        rateSelect.appendChild(option);
    });
    rateSelect.addEventListener('change', () => {
        host.rateChanged(Number(rateSelect.value));
    });
    rateWrap.appendChild(rateSelect);

    root.appendChild(stepButton);
    root.appendChild(runButton);
    root.appendChild(runToEndButton);
    root.appendChild(resetButton);
    root.appendChild(rateWrap);
    mount.appendChild(root);

    return {
        setPlaying(playing: boolean): void {
            runButton.textContent = playing ? 'Pause' : 'Run';
            runButton.setAttribute('aria-pressed', String(playing));
        },
        setTerminal(terminal: boolean): void {
            stepButton.disabled = terminal;
            runToEndButton.disabled = terminal;
            if (terminal) {
                // autoplay must not linger on a terminal battle (idempotent
                // step() would no-op forever); main also stops the timer, this
                // just keeps the button label honest
                runButton.textContent = 'Run';
                runButton.setAttribute('aria-pressed', 'false');
            }
            runButton.disabled = terminal;
            // Reset intentionally stays enabled at terminal (D12/D10)
        },
    };
}
