/**
 * Boot sequence and DOM wiring.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * TWO-PHASE BOOT (docs/ARCHITECTURE.md §W5, risk R13)
 * ────────────────────────────────────────────────────────────────────────────────
 * Phase A — render an interactive, *animated* loading screen using only the DOM and CSS.
 *   No Three.js, no WASM, nothing to download before the player sees something that is
 *   alive. This exists because the biggest cause of quitting is a black rectangle, and
 *   because it costs nothing.
 * Phase B — dynamically import Three.js and Rapier, build the level, prime physics,
 *   start the loop, then fade the loading screen out.
 *
 * Importing physics lazily is deliberate: it downloads in parallel with everything else
 * and its absence is invisible during Phase A. Rapier's WASM is the single largest
 * asset in the game (~1.4 MB), so hiding it behind a screen the player is already
 * reading converts a blocking wait into a hidden one.
 */

/**
 * Update the loading screen's status text and progress bar.
 *
 * @param statusElement - The element holding the status message.
 * @param progressElement - The element whose width represents progress.
 * @param message - The status message to display.
 * @param progress - Completion fraction in [0, 1].
 */
function setLoadingStatus(
  statusElement: HTMLElement,
  progressElement: HTMLElement,
  message: string,
  progress: number,
): void {
  statusElement.textContent = message;
  progressElement.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/**
 * Format a level summary for the boot log.
 *
 * @param summary - The level summary.
 * @returns A single-line human-readable description.
 */
function describeLevel(summary: {
  treeCount: number;
  rockCount: number;
  pillarCount: number;
  statueCount: number;
  wallCount: number;
  staticColliderCount: number;
  drawCallEstimate: number;
  triangleCount: number;
}): string {
  return (
    `${summary.treeCount} trees, ${summary.rockCount} rocks, ` +
    `${summary.pillarCount} pillars, ${summary.statueCount} statues, ${summary.wallCount} walls | ` +
    `${summary.staticColliderCount} colliders | ~${summary.drawCallEstimate} draw calls | ` +
    `~${Math.round(summary.triangleCount).toLocaleString()} triangles`
  );
}

/**
 * Report a fatal boot error to the player.
 *
 * A boot failure that only reaches the console is indistinguishable from a hang. The
 * player gets a message they can act on (retry, or a note about WebGL support) rather
 * than an infinite progress bar.
 *
 * @param root - The element to replace the loading screen with.
 * @param error - The error that occurred.
 */
function showBootFailure(root: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'boot-failure';

  const heading = document.createElement('h1');
  heading.textContent = 'Jungle Relic could not start';

  const detail = document.createElement('p');
  detail.className = 'boot-failure__detail';
  detail.textContent = message;

  const hint = document.createElement('p');
  hint.className = 'boot-failure__hint';
  hint.textContent =
    'This game needs WebGL 2. Try a recent version of Chrome, Firefox, Edge or Safari, ' +
    'and make sure hardware acceleration is enabled in your browser settings.';

  panel.append(heading, detail, hint);
  root.append(panel);

  // Still log it: a developer reading the console needs the stack, not the summary.
  console.error('[JungleRelic] boot failed:', error);
}

/**
 * Run the boot sequence.
 *
 * @param canvas - The canvas the game renders into.
 * @param overlays - Handles to the loading-screen elements.
 */
async function boot(
  canvas: HTMLCanvasElement,
  overlays: {
    loadingRoot: HTMLElement;
    status: HTMLElement;
    progress: HTMLElement;
  },
): Promise<void> {
  const { loadingRoot, status, progress } = overlays;

  setLoadingStatus(status, progress, 'Waking the jungle…', 0.05);

  // Yield once so the browser paints the loading screen before we block on module
  // loading. Without this the first paint can be delayed until after the imports
  // resolve, which defeats the entire point of a loading screen.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // ---- Phase B: load the engine ----
  setLoadingStatus(status, progress, 'Summoning the renderer…', 0.2);
  const [{ Game }, { PhysicsWorld }] = await Promise.all([
    import('./Game'),
    import('../physics/PhysicsWorld'),
  ]);

  setLoadingStatus(status, progress, 'Compiling physics…', 0.5);
  await PhysicsWorld.initialise();

  setLoadingStatus(status, progress, 'Building Zone 1…', 0.72);
  const game = new Game(canvas);
  const physics = new PhysicsWorld();

  const summary = game.loadLevel(physics);

  setLoadingStatus(status, progress, 'Lighting the torches…', 0.92);
  console.info(
    `[JungleRelic] Zone 1 built: ${describeLevel(summary)}\n` +
      'Controls: WASD to move, Shift to run, Space to jump, Ctrl or C to crouch, E to interact.\n' +
      'F1 toggles the developer overlay; [ and ] tune affine warping; - and = tune the vertex snap grid.',
  );

  game.start();

  // Expose the game for the browser console and for automated smoke tests. Prefixed to
  // avoid colliding with anything else on the page.
  (window as unknown as Record<string, unknown>).__jungleRelic = { game, physics, summary };

  // Fade the loading screen out. Removing it after the transition (rather than
  // immediately) keeps the first few frames from showing an unstyled flash.
  loadingRoot.classList.add('loading--hidden');
  window.setTimeout(() => loadingRoot.remove(), 420);

  // Tear down cleanly if the page is unloaded or (during development) hot-reloaded.
  window.addEventListener('beforeunload', () => game.dispose(), { once: true });
}

/**
 * Entry point. Wires DOM elements, starts the boot, and reports failures.
 */
function main(): void {
  const canvas = document.getElementById('game-canvas');
  const loadingRoot = document.getElementById('loading');
  const status = document.getElementById('loading-status');
  const progress = document.getElementById('loading-progress');

  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Boot failed: #game-canvas is missing or is not a canvas element.');
  }
  if (!loadingRoot || !status || !progress) {
    throw new Error('Boot failed: loading-screen elements are missing from index.html.');
  }

  // Reserve the WebGL context early so a device without WebGL 2 fails with a clear
  // message rather than an exception somewhere deep inside Three.js.
  const probe = canvas.getContext('webgl2');
  if (!probe) {
    showBootFailure(loadingRoot, new Error('WebGL 2 is not available in this browser.'));
    return;
  }

  boot(canvas, { loadingRoot, status, progress }).catch((error: unknown) => {
    showBootFailure(loadingRoot, error);
  });
}

main();
