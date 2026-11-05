import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Story 1.2 sandbox prototype: bundles the overlay page (PixiJS + the test
// pack source) the same way the real overlay will be bundled. Output goes to
// the git-ignored .vite/ folder so lint and format never scan it.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export default defineConfig({
  root: path.join(here, 'web/overlay'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: path.join(repoRoot, '.vite/proto-sandbox/overlay'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
