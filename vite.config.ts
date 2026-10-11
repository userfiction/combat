// Vite config for @userfiction/combat (npm-publishable library build).
// - Library mode, ESM-only output `dist/userfiction-combat.mjs` — matches the
//   `exports.import` condition in package.json (consumed by external npm users;
//   workspace dev keeps resolving TS source via the `development` condition).
// - Workspace dependencies listed in package.json stay EXTERNAL (vite
//   auto-externalizes them); the explicit pattern below is a guard so a
//   manifest edit can never silently bundle sibling workspace packages.
// - TEST: this file also shadows the root vitest config when vitest runs with
//   this package as cwd (package.json "test": "vitest run"), so the root's
//   test settings (jsdom + globals) are mirrored here.
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        // Mirrors root vitest.config.ts so `vitest run` from this package dir
        // behaves exactly as before this config existed
        environment: 'jsdom',
        globals: true,
        include: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
        passWithNoTests: true,
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            name: 'userfiction-combat',
            formats: ['es'],
            fileName: () => 'userfiction-combat.mjs',
        },
        rollupOptions: {
            external: [/^node:/, /^@presource\//, /^@userfiction\//],
            output: {
                globals: {},
            },
        },
        sourcemap: true,
        emptyOutDir: true,
    },
});
