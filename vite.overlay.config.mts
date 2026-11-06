import path from 'node:path';
import { defineConfig, type ConfigEnv } from 'vite';

// https://vitejs.dev/config
export default defineConfig((env) => {
  // Forge passes the project directory as `root`; renderer entries carry `name`.
  const { root, forgeConfigSelf } = env as ConfigEnv<'renderer'>;
  return {
    // Keep the overlay renderer's Vite root inside src/overlay so the dev
    // server never watches or scans other top-level folders. No React plugin:
    // the canvas does not use React (AD-9).
    root: path.join(root, 'src/overlay'),
    // Its own dependency-optimizer cache: the panels dev server uses the
    // default node_modules/.vite, and two dev servers re-optimizing into one
    // folder replace each other's prebundled deps, so PixiJS imports fail
    // with 504 Outdated Optimize Dep under `npm start`.
    cacheDir: path.join(root, 'node_modules/.vite-overlay'),
    build: {
      // Forge's default outDir is relative to `root`; pin it back to
      // .vite/renderer/<name>, which main serves as app://<name>/.
      outDir: path.join(root, '.vite/renderer', forgeConfigSelf.name),
      emptyOutDir: true,
      // PixiJS makes one large chunk; it loads from app://, not a network.
      chunkSizeWarningLimit: 4096,
    },
  };
});
