// ============================================================================
// demo/vite.config.ts — standalone Vite config for the vanilla demo app (D12)
// ============================================================================
// - `root: __dirname` keeps the demo fully isolated from the library config
//   (packages/userfiction/combat/vite.config.ts is untouched — D12). The
//   __dirname usage mirrors the package's own vite.config.ts L25 (task V3:
//   verified working in this repo against Vite 8 + "type": "module").
// - Port policy (D12): default 8300, strictPort (fail fast instead of
//   silently shifting). Override via env COMBAT_DEMO_PORT=8400 or Vite CLI
//   `-- --port 8400` — the CLI wins because Vite CLI args override config.
// - Build lands in demo/dist (permitted package path), sourcemapped, mirroring
//   the library build's sourcemap/emptyOutDir choices.
// - No backend, no fetch, no storage (D12): this is a pure static app.
// ----------------------------------------------------------------------------
import { defineConfig } from 'vite';

// Strict env parsing: a present-but-malformed COMBAT_DEMO_PORT fails loudly
// (strictPort philosophy applied to the override itself); empty string = unset.
const rawPort = process.env.COMBAT_DEMO_PORT;
if (rawPort) {
    if (!/^\d+$/.test(rawPort)) {
        throw new Error(`COMBAT_DEMO_PORT must be a plain integer port, got: '${rawPort}'`);
    }
}
const port = rawPort ? Number(rawPort) : 8300;

export default defineConfig({
    root: __dirname,
    server: {
        port,
        strictPort: true, // occupied port must fail loudly (T6 completion criterion)
    },
    preview: {
        // demo:preview uses the same env/default (D12)
        port,
        strictPort: true,
    },
    build: {
        outDir: 'dist', // -> demo/dist
        emptyOutDir: true,
        sourcemap: true,
    },
});
