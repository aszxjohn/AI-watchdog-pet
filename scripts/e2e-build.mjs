// @ts-check
/**
 * The build step of `npm run e2e` (Story 3.5), on macOS and Windows alike.
 *
 * It packages the app with Electron Forge's API into a temporary folder.
 * Packaging removes `.vite/` at the repo root and writes the production
 * Vite build there (main and its sandbox document, the preloads, the
 * renderers), which is what `electron .` runs and what the Playwright
 * tests launch: do not run it while `npm start` runs, which uses the same
 * folder. Packaging takes Electron from Electron's download cache, as
 * `npm run package` does. The packaged app itself is deleted right away:
 * its fuses (no Node inspector) keep Playwright from attaching to it.
 * Nothing is written to `out/`.
 */
import { api } from '@electron-forge/core';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the tests need from the build, relative to the repo root. */
const EXPECTED = [
  '.vite/build/main.cjs',
  '.vite/build/panels.cjs',
  '.vite/build/overlay.cjs',
  '.vite/build/sandbox.html',
  '.vite/build/sandbox-csp.json',
  '.vite/renderer/panels/index.html',
  '.vite/renderer/overlay/index.html',
];

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awp-e2e-package-'));
/** @type {unknown} */
let packageError;
try {
  await api.package({ dir: ROOT, outDir, interactive: false });
} catch (error) {
  packageError = error;
}
// On Windows the packaged executable can stay locked for a moment. A
// folder that still cannot be removed is reported, and never hides how
// packaging went.
try {
  await fs.rm(outDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
} catch (error) {
  console.warn(`[e2e-build] could not remove ${outDir}:`, error);
}
if (packageError !== undefined) {
  throw packageError;
}

const missing = EXPECTED.filter((file) => !existsSync(path.join(ROOT, file)));
if (missing.length > 0) {
  console.error(`[e2e-build] the build left out: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.info('[e2e-build] production build ready in .vite/');
}
