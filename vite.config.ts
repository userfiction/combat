// Vite config for @userfiction/combat.
// SOURCE-ONLY LIBRARY (repo policy: AGENTS.md "Runtime / runner policy" (c)):
// this package publishes TypeScript from source — package.json main/module/
// types/exports all point at ./src/index.ts, so there is NO library build here
// and no dist/ output. Consumers are Vite-based and compile/roll up the TS from
// node_modules themselves (workspace deps like @presource/core stay ordinary
// dependencies and are transpiled from their own src by the consumer);
// package.json therefore has no "build"/"prepack" scripts.
// The demo (demo/) is a DEPLOYABLE app surface, NOT a library build: it keeps
// its own Vite config + demo/dist output via "dev" / "demo:build" /
// "demo:preview" -> demo/vite.config.ts (standalone; it does not extend this
// file) and demo/ is excluded from the published "files" list.
// - TEST: this file is the vitest config when vitest runs with this package as
//   cwd (package.json "test": "vitest run"), so the root's test settings
//   (jsdom + globals) are mirrored here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Mirrors root vitest.config.ts so `vitest run` from this package dir
        // behaves exactly as before this config existed
        environment: 'jsdom',
        globals: true,
        include: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
        passWithNoTests: true,
    },
});
