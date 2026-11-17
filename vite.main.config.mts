import { defineConfig } from 'vite';
import { sandboxDocumentPlugin } from './scripts/sandbox-plugin';

// https://vitejs.dev/config
// The main build also writes the sandbox document (sandbox.html and its
// CSP) next to main.cjs (Story 3.5); main serves it as
// pack://_stage/sandbox.html.
export default defineConfig({
  plugins: [sandboxDocumentPlugin()],
});
