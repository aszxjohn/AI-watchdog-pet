/**
 * Panels renderer entry, loaded by Vite. Runs sandboxed with context
 * isolation: it reaches main only through `window.awp`, which
 * src/preload/panels.ts exposes. React lives in src/panels only.
 */
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { PanelsApi, PreloadHost } from '../shared/preload-api';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('panels: #root is missing from index.html');
}

// Undefined when the preload failed to load; App shows that as an error.
const awp = (window as Window & PreloadHost<PanelsApi>)[PRELOAD_API_KEY];

createRoot(container).render(
  <StrictMode>
    <App awp={awp} />
  </StrictMode>,
);
