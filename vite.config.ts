import { defineConfig } from 'vitest/config';

/**
 * Vite configuration.
 *
 * Two settings here are load-bearing for the mission rather than boilerplate:
 *
 * 1. `server.allowedHosts: true` and `host: '0.0.0.0'` — the game is developed inside a
 *    sandbox and viewed through a proxied preview host. A default dev server refuses
 *    requests whose Host header it does not recognise, which presents to the user as a
 *    blank preview with no error in the game's own console. Binding to all interfaces
 *    and permitting any host is what makes the live preview work.
 *
 * 2. `build.target: 'es2022'` and top-level await support — Rapier's WASM instantiation
 *    and our dynamic physics import rely on modern module semantics.
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Required for proxied preview hosts: without this the dev server rejects the
    // forwarded Host header and the preview shows nothing.
    allowedHosts: true,
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    // Keep the physics engine in its own chunk so it can be loaded lazily after the
    // first paint (ARCHITECTURE.md §W5) rather than blocking the initial bundle.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge')) return 'rapier';
          return undefined;
        },
      },
    },
    // Rapier's WASM bundle exceeds the default warning threshold; it is deliberately
    // lazy-loaded, so a warning here would be noise rather than signal.
    chunkSizeWarningLimit: 2400,
  },

  test: {
    // Unit and integration tests run in plain Node. Rapier initialises its WASM
    // synchronously inside the test bodies, so no browser environment is required —
    // which is exactly what makes the character controller testable in CI.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Physics characterisation tests run hundreds of simulation ticks; the default
    // 5 s timeout is too tight on a shared machine.
    testTimeout: 20000,
    reporters: ['default'],
  },
});
