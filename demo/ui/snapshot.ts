// ============================================================================
// demo/ui/snapshot.ts — collapsible snapshot JSON view (D12)
// ============================================================================
// A <details> panel showing the current SimulationSnapshot (D10) as pretty
// JSON — the same exact text the editor's "Export snapshot" downloads, so the
// panel doubles as a preview of the replayable state (plain JSON, no
// functions). Collapsed by default to keep the battle view uncluttered.
//
// Safety: JSON text goes into a <pre> via textContent — never innerHTML.
// ----------------------------------------------------------------------------

import type { SimulationSnapshot } from '../../index';

export interface SnapshotPanel {
    render(snapshot: SimulationSnapshot): void;
}

export function createSnapshotPanel(mount: HTMLElement): SnapshotPanel {
    const details = document.createElement('details');
    details.className = 'panel snapshot-panel';

    const summary = document.createElement('summary');
    summary.textContent = 'Snapshot (JSON)';
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.textContent = '—';
    details.appendChild(pre);

    mount.appendChild(details);

    return {
        render(snapshot: SimulationSnapshot): void {
            // 2-space pretty print; stringifying a plain-JSON snapshot cannot throw (D10)
            pre.textContent = JSON.stringify(snapshot, null, 2);
        },
    };
}
