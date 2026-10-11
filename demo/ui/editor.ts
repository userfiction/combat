// ============================================================================
// demo/ui/editor.ts — JSON definition editor (D12)
// ============================================================================
// Textarea + Apply + Import (file input) + Export definition + Export current
// snapshot (Blob download). Apply flow (D12 "UI behavior"):
//   text → JSON.parse (parse failure ⇒ single numbered error)
//        → host.apply(parsed) → validateBattleDefinition inside main.ts
//        → invalid ⇒ numbered <ol> error list printed VERBATIM (validation.ts
//          message strings are stable by contract, T2); valid ⇒ simulation
//          replaced.
// RESET vs INVALID EDITOR (task semantics): Reset belongs to the live
// simulation (controls.ts) and NEVER reads this textarea — an invalid draft
// stays visible with its error list while Reset rewinds the last successfully
// applied battle. The draft only takes effect through Apply.
//
// Safety: every dynamic string (errors, file names, JSON text) goes through
// textContent / Blob — no innerHTML, so definition content can never inject
// markup (D12 safe rendering).
// ----------------------------------------------------------------------------

// Host callbacks implemented by main.ts (see controls.ts header for the
// one-directional data-flow rationale).
export interface EditorHost {
    /**
     * Attempt to load a parsed JSON value as the battle: validate via
     * validateBattleDefinition, replace the simulation when valid. Returns the
     * error list (empty ⇒ accepted) for this module to print.
     */
    apply(raw: unknown): string[];
    /** Current RESOLVED definition as pretty JSON (sim.definition, D2). */
    definitionJson(): string;
    /** Current snapshot as pretty JSON (sim.snapshot(), D10). */
    snapshotJson(): string;
}

export interface Editor {
    /** Replace textarea content (fixture selection / import). */
    setText(text: string): void;
    /** Print a numbered error list (empty array clears and hides it). */
    showErrors(errors: string[]): void;
}

// Blob download (D12: Export via Blob download) — no backend, purely client-side.
// NO timer here: §12.5 makes the autoplay setInterval the demo's only permitted
// timer use, so the object URL is left to be reclaimed at page unload (one
// leaked URL per export click — harmless at demo scale).
function downloadJson(filename: string, json: string): void {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
}

// File-name slug from the definition name (ids.ts pattern is entity-only;
// names are free text, so strip to [a-z0-9-] and fall back to 'battle')
function definitionSlug(name: string | undefined): string {
    const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'battle' : slug;
}

export function createEditor(mount: HTMLElement, host: EditorHost): Editor {
    const root = document.createElement('section');
    root.className = 'panel editor';
    root.setAttribute('aria-label', 'Definition editor');

    const heading = document.createElement('h2');
    heading.textContent = 'Definition editor';
    root.appendChild(heading);

    const textarea = document.createElement('textarea');
    textarea.id = 'combat-editor';
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'Battle definition JSON');
    root.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'editor-actions';

    const makeAction = (label: string, onClick: () => void): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    };

    // Numbered error list — <ol> gives the "numbered error list" for free (D12)
    const errorList = document.createElement('ol');
    errorList.className = 'errors';
    errorList.setAttribute('aria-label', 'Validation errors');
    errorList.hidden = true;

    const showErrors = (errors: string[]): void => {
        errorList.textContent = '';
        errors.forEach((message) => {
            const item = document.createElement('li');
            item.textContent = message; // verbatim, textContent-safe
            errorList.appendChild(item);
        });
        errorList.hidden = errors.length === 0;
    };

    // Apply: parse first (parse errors are reported like validation errors),
    // then hand the parsed value to main.ts for validate-or-replace
    const applyText = (): void => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(textarea.value);
        } catch (error) {
            showErrors([`JSON parse error: ${error instanceof Error ? error.message : String(error)}`]);
            return;
        }
        showErrors(host.apply(parsed));
    };
    actions.appendChild(makeAction('Apply', applyText));

    // Import: file input → load text into the editor AND attempt Apply
    // (checklist "Import/Export produce valid JSON": an invalid import keeps
    // its text in the editor with the error list shown, live battle untouched)
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.setAttribute('aria-label', 'Import battle definition JSON file');
    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            textarea.value = String(reader.result ?? '');
            applyText();
        };
        reader.readAsText(file);
        fileInput.value = ''; // allow re-importing the same file back-to-back
    });
    actions.appendChild(fileInput);

    // Export definition — the RESOLVED definition (catalogs merged, D10)
    actions.appendChild(
        makeAction('Export definition', () => {
            const json = host.definitionJson();
            let slug = 'battle';
            try {
                const parsed = JSON.parse(json) as { name?: string };
                slug = definitionSlug(parsed.name);
            } catch {
                // resolved definition is engine JSON — unreachable in practice;
                // fall back to the 'battle' slug rather than fail the download
            }
            downloadJson(`${slug}-definition.json`, json);
        }),
    );

    // Export current snapshot — plain JSON, replayable with the same plugin
    // set (D10; the demo ships no plugins, so any snapshot round-trips)
    actions.appendChild(
        makeAction('Export snapshot', () => {
            const json = host.snapshotJson();
            let slug = 'battle';
            try {
                const parsed = JSON.parse(json) as { definition?: { name?: string } };
                slug = definitionSlug(parsed.definition && parsed.definition.name);
            } catch {
                // same unreachable-fallback reasoning as above
            }
            downloadJson(`${slug}-snapshot.json`, json);
        }),
    );

    root.appendChild(actions);
    root.appendChild(errorList);
    mount.appendChild(root);

    return {
        setText(text: string): void {
            textarea.value = text;
        },
        showErrors,
    };
}
