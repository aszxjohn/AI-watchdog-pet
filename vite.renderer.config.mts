import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type ConfigEnv } from 'vite';

// https://vitejs.dev/config
export default defineConfig((env) => {
  // Forge passes the project directory as `root`; renderer entries carry `name`.
  const { root, forgeConfigSelf } = env as ConfigEnv<'renderer'>;
  return {
    // Keep the panels renderer's Vite root inside src/panels so the dev server
    // never watches or scans other top-level folders.
    root: path.join(root, 'src/panels'),
    // React 19 for the panels (JSX and Fast Refresh). The dev-only refresh
    // preamble is an inline script; main/windows/csp.ts allows inline
    // scripts for the dev server only.
    plugins: [react()],
    build: {
      // Forge's default outDir is relative to `root`; pin it back to
      // .vite/renderer/<name>, which main serves as app://<name>/.
      outDir: path.join(root, '.vite/renderer', forgeConfigSelf.name),
      emptyOutDir: true,
    },
  };
});
