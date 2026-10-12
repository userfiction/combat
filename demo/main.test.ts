// ============================================================================
// demo/main.test.ts — full-app integration tests for the live Combatants flow
// (T3)
// ============================================================================
// Boots the REAL demo app (demo/main.ts) inside jsdom against a mirror of
// demo/index.html's shell, then drives it the way a user would: fixture
// dropdown, live combatant controls, editor textarea, Apply & restart,
// controls and the Space hotkey. Assertions pin exact outcomes against the
// ENGINE (validateBattleDefinition/createSimulation/editCombatant run for
// real — no mocks).
//
// T3 covered acceptance rows:
//   - ONE live Combatants panel (no duplicate setup/entities lists), cards
//     render snapshot.state (health/derived stats/readiness/resources/gear/
//     statuses/injuries) — R3
//   - live health/max-health/gear/status/resource/injury edits apply between
//     turns: step/time preserved, log only APPENDS, no restart, next
//     simulate continues from the edited state — R4
//   - main catches CombatValidationError → inline error list, snapshot
//     unchanged; success keeps autoplay running and never touches the
//     timeline reset or the editor draft
//   - the JSON editor is the Advanced battle definition / Apply & restart
//     new-battle path; malformed drafts are harmless to the live panel
//   - canonical status presets only (fearful/poisoned/stunned + registry),
//     valid custom statuses settable, NO legacy fear/poison/stun fallbacks
//   - autoplay/typing/focus stability across step-driven re-renders
//   - terminal read-only guidance; Reset discards live edits
//   - accessibility labels/roles and textContent-safe dynamic text (D12)
// ----------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBattleDefinition } from '../index';
import exampleSkirmish from './fixtures/example-skirmish.json';
import quadrupleSpeed from './fixtures/quadruple-speed.json';
import statusTrials from './fixtures/status-trials.json';
import teamWipe from './fixtures/team-wipe.json';
import unarmedDuel from './fixtures/unarmed-duel.json';

// ---------------------------------------------------------------------------
// Shell: mirrors demo/index.html (the static skeleton main.ts mounts into)
// ---------------------------------------------------------------------------

const SHELL_HTML = `
<main class="layout">
  <div class="col col-left">
    <section class="panel" aria-label="Battle controls">
      <h2>Battle</h2>
      <div class="fixture-row"><label for="fixture-select">Fixture</label><select id="fixture-select"></select></div>
      <div id="controls-mount"></div>
      <div id="banner" class="banner running" role="status"></div>
    </section>
    <div id="editor-mount"></div>
  </div>
  <div class="col col-right">
    <section class="panel" aria-label="Combatants"><h2>Combatants</h2><div id="combatants-mount"></div></section>
    <section class="panel" aria-label="Battle timeline"><h2>Timeline</h2><div id="timeline-mount" class="timeline" aria-live="polite"></div></section>
    <div id="snapshot-mount"></div>
  </div>
</main>`;

// Fixture dropdown order (main.ts FIXTURES array)
const FIXTURE_EXAMPLE = '0';
const FIXTURE_STATUS_TRIALS = '1';
const FIXTURE_TEAM_WIPE = '3';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const q = <T extends Element>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`missing element: ${selector}`);
    return node;
};

const qOrNull = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);

const textarea = (): HTMLTextAreaElement => q<HTMLTextAreaElement>('#combat-editor');

const banner = (): HTMLElement => q<HTMLElement>('#banner');

const fixtureSelect = (): HTMLSelectElement => q<HTMLSelectElement>('#fixture-select');

const selectFixture = (value: string): void => {
    fixtureSelect().value = value;
    fixtureSelect().dispatchEvent(new Event('change'));
};

// data-focus-key finder that matches by attribute VALUE (never selector
// interpolation — hostile definition ids must not break test lookups, the
// same rule the panel itself follows).
const byKey = (key: string): HTMLElement => {
    const node = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).find(
        (candidate) => candidate.getAttribute('data-focus-key') === key
    );
    if (!node) throw new Error(`no element with data-focus-key ${key}`);
    return node;
};

const clickKey = (key: string): void => (byKey(key) as HTMLButtonElement).click();

const changeSelectKey = (key: string, value: string): void => {
    const select = byKey(key) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
};

const setInput = (input: HTMLInputElement, value: string): void => {
    input.value = value;
    input.dispatchEvent(new Event('change'));
};

const toggleCheckbox = (key: string, checked: boolean): void => {
    const box = byKey(key) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
};

const stepOnce = (): void => {
    q<HTMLButtonElement>('#controls-mount button').click();
};

const controlButton = (label: string): HTMLButtonElement => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#controls-mount button')).find(
        (candidate) => candidate.textContent === label
    );
    if (!button) throw new Error(`no ${label} control`);
    return button;
};

const editorApplyButton = (): HTMLButtonElement => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#editor-mount button')).find(
        (candidate) => candidate.textContent === 'Apply & restart'
    );
    if (!button) throw new Error('editor Apply & restart button not found');
    return button;
};

// --- snapshot/card readers (the snapshot panel mirrors sim.snapshot()) ------

const snapshotJSON = (): {
    state: { step: number; virtualTime: number; entities: Array<Record<string, any>> };
    events: Array<Record<string, any>>;
} => {
    const text = q<HTMLPreElement>('#snapshot-mount pre').textContent;
    if (!text) throw new Error('snapshot panel is empty');
    return JSON.parse(text);
};

const entityOf = (id: string): Record<string, any> => {
    const entity = snapshotJSON().state.entities.find((candidate) => candidate.id === id);
    if (!entity) throw new Error(`no entity ${id} in snapshot`);
    return entity;
};

const pieceOf = (entityId: string, slot: string): Record<string, any> | undefined =>
    (entityOf(entityId).equipment as Array<Record<string, any>>).find((piece) => piece.slot === slot);

const statusListOf = (entityId: string): Array<Record<string, any>> =>
    (entityOf(entityId).statuses ?? []) as Array<Record<string, any>>;

const cardOf = (entityId: string): HTMLElement => {
    const card = qOrNull<HTMLElement>(`#combatants-mount [data-entity-id="${entityId}"]`);
    if (!card) throw new Error(`no combatant card for ${entityId}`);
    return card;
};

const meterValue = (card: HTMLElement, label: string): string => {
    const row = Array.from(card.querySelectorAll<HTMLElement>('.bar-row')).find(
        (candidate) => (candidate.querySelector('.bar-label')?.textContent ?? '') === label
    );
    if (!row) throw new Error(`no ${label} meter on card`);
    return row.querySelector('.value')?.textContent ?? '';
};

const timelineGroups = (): number => document.querySelectorAll('#timeline-mount .tl-group').length;

// ---------------------------------------------------------------------------
// Boot the real app per test (vi.resetModules → fresh module execution)
// ---------------------------------------------------------------------------

beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = SHELL_HTML;
    await import('./main');
});

// ---------------------------------------------------------------------------
// Bootstrap: one live panel, no duplicates
// ---------------------------------------------------------------------------

describe('demo bootstrap and fixtures', () => {
    it('renders ONE live Combatants panel — the duplicate setup/entities lists are gone', () => {
        expect(document.getElementById('setup-mount')).toBeNull();
        expect(document.getElementById('entities-mount')).toBeNull();
        expect(document.querySelectorAll('#combatants-mount .combatant-card').length).toBe(3);
        expect(document.querySelector('.unapplied')).toBeNull(); // no unapplied marker exists at all
        // cards render live snapshot state: knight health + effective stats + gear
        expect(meterValue(cardOf('knight'), 'health')).toBe('30/30');
        expect(cardOf('knight').textContent).toContain('speed (eff)');
        expect(cardOf('knight').textContent).toContain('weapon-1 · Longsword');
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms');
        expect(timelineGroups()).toBe(1); // battle:start group only
    });

    it('every shipped fixture passes engine validation', () => {
        [exampleSkirmish, statusTrials, quadrupleSpeed, teamWipe, unarmedDuel].forEach((fixture) => {
            const validation = validateBattleDefinition(fixture);
            expect(validation).toEqual({ valid: true, errors: [] });
        });
    });

    it('switching fixtures starts a new battle and clears the edit notes', () => {
        selectFixture(FIXTURE_TEAM_WIPE);
        changeSelectKey('weapon:shieldbearer', 'great-axe'); // produces a normalization note
        expect(q<HTMLElement>('.edit-notes').hidden).toBe(false);
        selectFixture(FIXTURE_STATUS_TRIALS);
        expect(JSON.parse(textarea().value).name).toBe('Status Trials');
        expect(q<HTMLElement>('.edit-notes').hidden).toBe(true);
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms');
    });
});

// ---------------------------------------------------------------------------
// R4 — live edits land between turns; next simulate continues from them
// ---------------------------------------------------------------------------

describe('live health edits preserve step/time/log and the next simulate uses them', () => {
    it('a current-health edit keeps the step, virtual time and log; stepping continues (no restart)', () => {
        stepOnce();
        const bannerBefore = banner().textContent;
        const groupsBefore = timelineGroups();
        const snapshotBefore = snapshotJSON();
        setInput(byKey('health:knight') as HTMLInputElement, '10');
        // no restart: step, virtual time, log and schedule all untouched
        expect(banner().textContent).toBe(bannerBefore);
        expect(snapshotJSON().state.step).toBe(1);
        expect(snapshotJSON().state.virtualTime).toBe(snapshotBefore.state.virtualTime);
        expect(timelineGroups()).toBe(groupsBefore);
        expect(textarea().value).toContain('"Crossroads Skirmish"'); // editor draft untouched
        // the edit landed in live state
        expect(entityOf('knight').health).toBe(10);
        expect(meterValue(cardOf('knight'), 'health')).toBe('10/30');
        // the next simulate runs AFTER the edit and continues the same battle
        stepOnce();
        expect(banner().textContent).toContain('step 2');
        expect(timelineGroups()).toBe(groupsBefore + 1);
        expect(snapshotJSON().state.virtualTime).toBeGreaterThan(snapshotBefore.state.virtualTime);
    });

    it('a max-health edit (baseStats.health) recomputes the meter ceiling in live state', () => {
        setInput(byKey('max-health:knight') as HTMLInputElement, '99');
        expect(entityOf('knight').baseStats.health).toBe(99);
        expect(entityOf('knight').maxHealth).toBe(99);
        expect(meterValue(cardOf('knight'), 'health')).toBe('30/99');
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms'); // no restart
    });
});

describe('live gear edits normalize hands atomically with visible notes', () => {
    it('a two-handed pick clears the held shield in the SAME patch and keeps unrelated armour', () => {
        selectFixture(FIXTURE_TEAM_WIPE);
        expect(pieceOf('shieldbearer', 'weapon-1')).toEqual({
            gearId: 'rusted-dagger',
            slot: 'weapon-1',
            durability: 8
        });
        expect(pieceOf('shieldbearer', 'shield')).toEqual({ gearId: 'buckler', slot: 'shield', durability: 6 });
        changeSelectKey('weapon:shieldbearer', 'great-axe');
        // same atomic patch: weapon replaced, shield cleared, body armour untouched
        expect(entityOf('shieldbearer').equipment.length).toBe(2);
        expect(pieceOf('shieldbearer', 'weapon-1')).toEqual({ gearId: 'great-axe', slot: 'weapon-1', durability: 10 });
        expect(pieceOf('shieldbearer', 'shield')).toBeUndefined();
        expect(pieceOf('shieldbearer', 'body')).toEqual({ gearId: 'padded-vest', slot: 'body', durability: 10 });
        // normalization is announced, never silent
        expect(q<HTMLElement>('.edit-notes').textContent).toContain('removed shield Buckler.');
        // no restart — the battle keeps running from step 0
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms');
    });

    it('unarmed selection keeps armour and reports the weapon removal', () => {
        changeSelectKey('weapon:knight', '');
        expect(pieceOf('knight', 'weapon-1')).toBeUndefined();
        expect(pieceOf('knight', 'body')).toEqual({ gearId: 'warden-mail', slot: 'body', durability: 8 });
        expect(q<HTMLElement>('.edit-notes').textContent).toContain('Unarmed selected — weapon Longsword removed.');
    });
});

// ---------------------------------------------------------------------------
// Canonical statuses: presets, custom ids, no legacy fallbacks
// ---------------------------------------------------------------------------

describe('live status edits with canonical presets only', () => {
    it('the add row starts with the canonical seed and adds ONLY registry-defined ids — no UI fallbacks', () => {
        const options = Array.from((byKey('status-add:knight') as HTMLSelectElement).options).map(
            (option) => option.value
        );
        // the canonical seed order comes first (the fold preserves the
        // builtin seed: fearful/poisoned/stunned + the rest)
        expect(options.slice(0, 8)).toEqual([
            'fearful',
            'poisoned',
            'stunned',
            'bleeding',
            'burned',
            'blinded',
            'blessed',
            'hasted'
        ]);
        // anything beyond the seed can ONLY come from the definition's own
        // registry (fixture-provided ids in first-listed order) — the panel
        // has NO hardcoded legacy fear/poison/stun fallback options
        const seedIds = options.slice(0, 8);
        const fixtureStatusIds = (
            (exampleSkirmish as { catalogs?: { statuses?: Array<{ id: string }> } }).catalogs?.statuses ?? []
        ).map((entry) => entry.id);
        expect(options.slice(8)).toEqual(fixtureStatusIds.filter((id) => !seedIds.includes(id)));
    });

    it('set applies a canonical status with the registry default duration; the chip removes it', () => {
        const stacks = byKey('status-stacks:knight') as HTMLInputElement;
        stacks.value = '2';
        changeSelectKey('status-add:knight', 'poisoned');
        clickKey('status-set:knight');
        const instance = statusListOf('knight').find((candidate) => candidate.id === 'poisoned');
        if (!instance) throw new Error('poisoned instance missing after live set');
        // exact field pins (the engine's own optional bookkeeping — potency
        // default 1, materialized modifiers — is engine-test territory)
        expect(instance.id).toBe('poisoned');
        expect(instance.stacks).toBe(2);
        expect(instance.duration).toBe(3); // blank duration → duration-mode default 3
        const chip = Array.from(cardOf('knight').querySelectorAll('.chip')).find((candidate) =>
            (candidate.textContent ?? '').startsWith('poisoned')
        );
        if (!chip) throw new Error('poisoned chip missing');
        // the chip's LABEL span carries the exact status text; the trailing ×
        // button is a sibling inside the chip (its own textContent)
        const chipLabel = chip.querySelector('span');
        if (!chipLabel) throw new Error('poisoned chip label missing');
        expect(chipLabel.textContent).toBe('poisoned ×2 · d3');
        expect(chip.className).toContain('negative');
        // removing from the chip button deletes exactly that instance
        const untouched = statusListOf('knight').filter((candidate) => candidate.id !== 'poisoned');
        clickKey('status-remove-poisoned:knight');
        expect(statusListOf('knight')).toEqual(untouched);
    });

    it('valid custom statuses from the definition registry are settable live', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        const option = Array.from((byKey('status-add:warden') as HTMLSelectElement).options).find(
            (candidate) => candidate.value === 'regenerating'
        );
        expect(option?.textContent).toBe('Regenerating (regenerating)');
        changeSelectKey('status-add:warden', 'regenerating');
        clickKey('status-set:warden');
        const instance = statusListOf('warden').find((candidate) => candidate.id === 'regenerating');
        if (!instance) throw new Error('regenerating instance missing after live set');
        expect(instance.id).toBe('regenerating');
        expect(instance.stacks).toBe(1);
        expect(instance.duration).toBe(3);
        // the warden's pre-existing instance is untouched by the per-id set
        const bleeding = statusListOf('warden').find((candidate) => candidate.id === 'bleeding');
        if (!bleeding) throw new Error('bleeding instance missing');
        expect(bleeding.id).toBe('bleeding');
        expect(bleeding.stacks).toBe(2);
        expect(bleeding.duration).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Live resource pool edits (stamina/mana only — energy is engine-normalized)
// ---------------------------------------------------------------------------

describe('live resource pool edits', () => {
    it('sets a pool with an explicit pair and updates the meter', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        expect(entityOf('acolyte').resources).toEqual({ mana: { current: 10, max: 10 } });
        setInput(byKey('res-mana-current:acolyte') as HTMLInputElement, '4'); // commits {4, 10}
        expect(entityOf('acolyte').resources).toEqual({ mana: { current: 4, max: 10 } });
        setInput(byKey('res-mana-max:acolyte') as HTMLInputElement, '9');
        expect(entityOf('acolyte').resources).toEqual({ mana: { current: 4, max: 9 } });
        expect(meterValue(cardOf('acolyte'), 'mana')).toBe('4/9');
    });

    it('removes a pool when both fields are cleared before the commit', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        // one commit reads the WHOLE pool pair: clear both fields first, then
        // commit once (a half-cleared intermediate state is a rejection)
        const current = byKey('res-mana-current:acolyte') as HTMLInputElement;
        const max = byKey('res-mana-max:acolyte') as HTMLInputElement;
        current.value = '';
        max.value = '';
        current.dispatchEvent(new Event('change'));
        expect(entityOf('acolyte').resources ?? undefined).toBeUndefined();
        // the acolyte card no longer renders a mana meter (the healer's
        // hands-slot gear durability meter stays — gear is untouched)
        const labels = Array.from(cardOf('acolyte').querySelectorAll('.bar-label')).map((node) => node.textContent);
        expect(labels).toEqual(['health', 'dur']);
    });

    it('a half-filled pool on a pool-less combatant is rejected inline without mutation', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        const bannerBefore = banner().textContent;
        setInput(byKey('res-stamina-current:tracker') as HTMLInputElement, '5');
        expect(cardOf('tracker').querySelector('.card-errors')?.textContent).toContain(
            'stamina needs both current and max (leave both blank to remove the pool)'
        );
        expect(entityOf('tracker').resources ?? undefined).toBeUndefined();
        expect(banner().textContent).toBe(bannerBefore);
    });
});

// ---------------------------------------------------------------------------
// Live injury edits: derived stats update exactly; incompatible gear is
// cleared in the SAME atomic patch with a visible note
// ---------------------------------------------------------------------------

describe('live injury edits', () => {
    it('adding a second missing eye lowers derived precision by exactly 2 more', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        expect(entityOf('marauder').injuries).toEqual(['left-eye']);
        expect(entityOf('marauder').stats.precision).toBe(-2); // 0 base − 2 (left-eye)
        toggleCheckbox('injury-right-eye:marauder', true);
        expect(entityOf('marauder').injuries).toEqual(['left-eye', 'right-eye']);
        expect(entityOf('marauder').stats.precision).toBe(-4); // −2 per missing eye (exact)
    });

    it('an arm injury clears a two-handed weapon in the SAME atomic patch with a visible note', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        toggleCheckbox('injury-left-arm:warden', true);
        expect(entityOf('warden').injuries).toEqual(['left-arm']);
        // admin-edit coherence: the projected loadout must match the projected
        // anatomy, so the panel rides the gear clear in the SAME patch (an
        // injuries-only patch would be rejected by the engine)
        expect(pieceOf('warden', 'weapon-1')).toBeUndefined();
        // unrelated valid gear is preserved by the same atomic patch
        expect(pieceOf('warden', 'body')).toEqual({ gearId: 'padded-vest', slot: 'body', durability: 10 });
        expect(pieceOf('warden', 'head')).toEqual({ gearId: 'iron-helm', slot: 'head', durability: 8 });
        // the clear is announced in the shared notes area, never silent
        expect(q<HTMLElement>('.edit-notes').textContent).toContain(
            'left-arm is missing — cleared weapon Grove Staff: it is two-handed and one arm is missing.'
        );
    });

    it('unchecking an injury removes it from live state', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        toggleCheckbox('injury-left-eye:marauder', false);
        expect(entityOf('marauder').injuries ?? undefined).toBeUndefined();
        expect(entityOf('marauder').stats.precision).toBe(0); // healed eye restores the penalty
    });
});

// ---------------------------------------------------------------------------
// Draft independence: malformed JSON harmless; Apply & restart is the
// new-battle path
// ---------------------------------------------------------------------------

describe('Advanced definition editor is independent of the live panel', () => {
    it('malformed JSON never breaks the live panel — live edits keep working', () => {
        stepOnce();
        const bannerAtStep1 = banner().textContent;
        textarea().value = '{oops';
        textarea().dispatchEvent(new Event('input')); // no draft listeners anymore — harmless
        expect(document.querySelectorAll('.combatant-card').length).toBe(3);
        // live edits work regardless of the broken draft
        setInput(byKey('health:knight') as HTMLInputElement, '15');
        expect(entityOf('knight').health).toBe(15);
        expect(banner().textContent).toBe(bannerAtStep1);
        // editor Apply reports the parse error; live battle untouched
        editorApplyButton().click();
        expect(q<HTMLElement>('#editor-mount .errors').textContent).toContain('JSON parse error');
        expect(banner().textContent).toBe(bannerAtStep1);
    });

    it('Apply & restart starts a NEW battle from the edited draft and no unapplied marker exists', () => {
        const draft = JSON.parse(textarea().value) as { entities: Array<{ stats: { health: number } }> };
        draft.entities[0].stats.health = 99;
        textarea().value = JSON.stringify(draft, null, 4);
        editorApplyButton().click();
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms');
        expect(meterValue(cardOf('knight'), 'health')).toBe('99/99');
        expect(document.querySelector('.unapplied')).toBeNull();
    });

    it('the editor is labelled as the Advanced battle definition path', () => {
        expect(q<HTMLElement>('#editor-mount h2').textContent).toBe('Advanced battle definition');
        expect(editorApplyButton().textContent).toBe('Apply & restart');
        expect(editorApplyButton().getAttribute('aria-label')).toBe('Apply battle definition and restart battle');
    });
});

// ---------------------------------------------------------------------------
// Autoplay, typing and focus stability (R3)
// ---------------------------------------------------------------------------

describe('autoplay keeps running through live edits and preserves typing/focus', () => {
    it('step-driven re-renders never clobber a half-typed field or drop focus', () => {
        vi.useFakeTimers();
        try {
            // the toggle is persistent chrome whose label flips Run → Pause
            // when playing — hold the NODE so assertions survive the flip
            const runButton = controlButton('Run');
            runButton.click();
            expect(runButton.getAttribute('aria-pressed')).toBe('true');
            vi.advanceTimersByTime(500); // default 2 steps/s → exactly one step
            const input = byKey('health:knight') as HTMLInputElement;
            input.focus();
            input.value = '25'; // half-typed — NOT committed
            vi.advanceTimersByTime(1500); // three more ticks (steps 2–4)
            expect(banner().textContent).toContain('step 4');
            // every tick rebuilt the cards: the ORIGINAL node is detached, the
            // rebuilt field carries the preserved typing and the focus
            const inputAfter = byKey('health:knight') as HTMLInputElement;
            expect(inputAfter).not.toBe(input);
            expect(inputAfter.value).toBe('25'); // typing survived every render pass
            expect(document.activeElement).toBe(inputAfter);
            // committing mid-autoplay applies the edit WITHOUT stopping autoplay
            inputAfter.dispatchEvent(new Event('change'));
            expect(runButton.getAttribute('aria-pressed')).toBe('true'); // still playing (label 'Pause')
            expect(meterValue(cardOf('knight'), 'health')).toBe('25/30');
            vi.advanceTimersByTime(500);
            expect(banner().textContent).toContain('step 5'); // autoplay continued
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// Terminal read-only guidance + Reset semantics
// ---------------------------------------------------------------------------

describe('terminal guidance and Reset', () => {
    it('a terminal battle switches the panel to read-only with explicit Reset guidance', () => {
        controlButton('Run to terminal').click();
        expect(banner().className).toMatch(/victory|draw|undecided/);
        expect(q<HTMLElement>('.terminal-guidance').hidden).toBe(false);
        expect(q<HTMLElement>('.terminal-guidance').textContent).toContain('Press Reset');
        expect((byKey('health:knight') as HTMLInputElement).disabled).toBe(true);
        expect((byKey('weapon:knight') as HTMLSelectElement).disabled).toBe(true);
        expect((byKey('status-set:knight') as HTMLButtonElement).disabled).toBe(true);
        expect((byKey('status-add:knight') as HTMLSelectElement).disabled).toBe(true);
    });

    it('Reset discards live edits and rewinds to the original battle', () => {
        setInput(byKey('health:knight') as HTMLInputElement, '7');
        expect(meterValue(cardOf('knight'), 'health')).toBe('7/30');
        controlButton('Reset').click();
        expect(banner().textContent).toBe('Running — step 0 · 0.000 ms');
        expect(meterValue(cardOf('knight'), 'health')).toBe('30/30');
        expect(entityOf('knight').health).toBe(30);
        expect(timelineGroups()).toBe(1); // fresh log: battle:start only
        // notes from the discarded session are gone
        expect(q<HTMLElement>('.edit-notes').hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Invalid patches: inline errors, no mutation
// ---------------------------------------------------------------------------

describe('invalid live edits show inline errors and never mutate', () => {
    it('non-numeric health is rejected inline with the exact message', () => {
        const bannerBefore = banner().textContent;
        const input = byKey('health:knight') as HTMLInputElement;
        // browsers (and jsdom) refuse non-numeric text in type="number"
        // inputs — the value silently coerces to '' — so this defensive
        // panel guard is driven by switching the field to text, the only
        // state in which 'abc' can reach the commit handler
        input.type = 'text';
        input.value = 'abc';
        input.dispatchEvent(new Event('change'));
        expect(cardOf('knight').querySelector('.card-errors')?.textContent).toContain('Health must be a number');
        expect(entityOf('knight').health).toBe(30);
        expect(banner().textContent).toBe(bannerBefore);
        // a subsequent successful edit clears the inline error region — the
        // field is re-queried because the failed attempt rebuilt the panel
        setInput(byKey('health:knight') as HTMLInputElement, '20');
        expect(cardOf('knight').querySelector('.card-errors')?.hidden).toBe(true);
        expect(entityOf('knight').health).toBe(20);
    });

    it('out-of-bounds status stacks are rejected inline without mutation', () => {
        (byKey('status-stacks:knight') as HTMLInputElement).value = '50';
        changeSelectKey('status-add:knight', 'poisoned');
        clickKey('status-set:knight');
        expect(cardOf('knight').querySelector('.card-errors')?.textContent).toContain(
            'stacks must be an integer between 1 and 9'
        );
        expect(statusListOf('knight').some((candidate) => candidate.id === 'poisoned')).toBe(false);
    });

    it('current > max and non-integer resource values are rejected inline', () => {
        selectFixture(FIXTURE_STATUS_TRIALS);
        const current = byKey('res-stamina-current:tracker') as HTMLInputElement;
        const max = byKey('res-stamina-max:tracker') as HTMLInputElement;
        current.value = '7';
        max.value = '5';
        current.dispatchEvent(new Event('change'));
        expect(cardOf('tracker').querySelector('.card-errors')?.textContent).toContain(
            'stamina.current: must not exceed max (7 > 5)'
        );
        expect(entityOf('tracker').resources ?? undefined).toBeUndefined();
        // the rejected attempt rebuilt the panel — re-query the fresh nodes
        const currentAfter = byKey('res-stamina-current:tracker') as HTMLInputElement;
        const maxAfter = byKey('res-stamina-max:tracker') as HTMLInputElement;
        currentAfter.value = '1.5';
        maxAfter.value = '5';
        currentAfter.dispatchEvent(new Event('change'));
        expect(cardOf('tracker').querySelector('.card-errors')?.textContent).toContain(
            'stamina.current/max must be integers between 0 and 1000000'
        );
    });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut (D12)
// ---------------------------------------------------------------------------

describe('keyboard shortcut', () => {
    it('Space steps outside form controls and is suppressed inside them', () => {
        const pressSpaceOn = (target: Element): void => {
            target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        };
        pressSpaceOn(document.body);
        expect(banner().textContent).toContain('step 1');
        // a select focused: native Space behavior wins, no step
        pressSpaceOn(fixtureSelect());
        expect(banner().textContent).toContain('step 1');
        // a combatant input focused: no step
        pressSpaceOn(byKey('health:knight'));
        expect(banner().textContent).toContain('step 1');
    });
});

// ---------------------------------------------------------------------------
// Accessibility + safe dynamic text
// ---------------------------------------------------------------------------

describe('accessibility and safe dynamic text', () => {
    it('exposes labelled controls and status regions for inline validation', () => {
        expect((byKey('health:knight') as HTMLInputElement).getAttribute('aria-label')).toBe(
            'Current health — Ser Gallant'
        );
        expect((byKey('max-health:knight') as HTMLInputElement).getAttribute('aria-label')).toBe(
            'Max health — Ser Gallant'
        );
        expect((byKey('weapon:knight') as HTMLSelectElement).getAttribute('aria-label')).toBe('Weapon — Ser Gallant');
        expect((byKey('status-add:knight') as HTMLSelectElement).getAttribute('aria-label')).toBe(
            'Add or update status — Ser Gallant'
        );
        expect(q<HTMLElement>('.edit-notes').getAttribute('role')).toBe('status');
        expect(cardOf('knight').querySelector('.card-errors')?.getAttribute('role')).toBe('status');
        expect(cardOf('knight').querySelector('.card-errors')?.getAttribute('aria-label')).toBe(
            'Edit errors — Ser Gallant'
        );
        expect(q<HTMLElement>('.parts-section').getAttribute('role')).toBe('group');
        expect(q<HTMLElement>('.parts-section').getAttribute('aria-label')).toBe('Missing body parts — Ser Gallant');
        expect(q<HTMLElement>('.terminal-guidance').getAttribute('role')).toBe('status');
    });

    it('renders hostile definition strings as inert text (no markup injection)', () => {
        const hostile = '<img src=x onerror=window.__pwned=1>';
        const draft = JSON.parse(textarea().value) as { entities: Array<{ name?: string }> };
        draft.entities[2].name = hostile;
        textarea().value = JSON.stringify(draft, null, 4);
        editorApplyButton().click();
        expect(document.querySelectorAll('img').length).toBe(0);
        expect(cardOf('brute').querySelector('.card-head .name')?.textContent).toBe(hostile);
    });
});
