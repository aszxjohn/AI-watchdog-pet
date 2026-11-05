// Overlay preload: exposes the overlay's minimal API as `window.awp` (AD-24).
// Empty until the overlay needs IPC (Story 1.6). Sandboxed: only electron's
// renderer API and src/shared, no Node globals.
import { contextBridge } from 'electron';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { OverlayApi } from '../shared/preload-api';

const api: OverlayApi = Object.freeze({});

contextBridge.exposeInMainWorld(PRELOAD_API_KEY, api);
