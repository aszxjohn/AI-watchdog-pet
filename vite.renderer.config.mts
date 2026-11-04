import path from 'node:path';
import { defineConfig, type ConfigEnv } from 'vite';

// https://vitejs.dev/config
export default defineConfig((env) => {
  // Forge passes the project directory as `root`; renderer entries carry `name`.
  const { root, forgeConfigSelf } = env as ConfigEnv<'renderer'>;
  return {
    // Keep the panels renderer's Vite root inside src/panels so the dev server
    // never watches or scans other top-level folders.
    root: path.join(root, 'src/panels'),
    build: {
      // Forge's default outDir is relative to `root`; pin it back to
      // .vite/renderer/<name> so main can load ../renderer/<name>/index.html.
      outDir: path.join(root, '.vite/renderer', forgeConfigSelf.name),
      emptyOutDir: true,
    },
  };
});
