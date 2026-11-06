import 'pixi.js/unsafe-eval';
// Overlay renderer entry: the canvas (AD-9, AD-24). The import above must
// stay the first line (a test checks it): the CSP has no 'unsafe-eval', so
// PixiJS needs its polyfill in place before anything else of it loads.
// Sandboxed with context isolation; it reaches main only through
// `window.awp` (src/preload/overlay.ts). No React here.
import './index.css';
import { Application, Assets } from 'pixi.js';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { OverlayApi, PreloadHost } from '../shared/preload-api';
import { startOverlay, type InitialisedCanvas } from './start';

// Before any texture loads: the default loader decodes in a blob Worker,
// which the CSP blocks, and then never settles and never reports an error
// (Story 1.2 prototype). Image elements work under the CSP.
Assets.setPreferences({ preferCreateImageBitmap: false });

const app = new Application();

async function initCanvas(): Promise<InitialisedCanvas> {
  await app.init({
    preference: 'webgl',
    backgroundAlpha: 0,
    resizeTo: window,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    // Nothing moves yet (no characters, no world tick until Story 3.x), so
    // there is no render loop: one render clears the canvas, and a resize
    // leaves it cleared.
    autoStart: false,
  });
  document.body.append(app.canvas);
  app.render();
  return {
    renderer: app.renderer.name,
    width: app.screen.width,
    height: app.screen.height,
  };
}

void startOverlay({
  // Undefined when the preload failed to load; startOverlay logs that.
  api: (window as Window & PreloadHost<OverlayApi>)[PRELOAD_API_KEY],
  initCanvas,
  onView: (snapshot) => {
    // For DevTools: the StageView rev and world size this page last saw.
    const { canvas } = snapshot.view;
    document.body.dataset.stageViewRev = String(snapshot.rev);
    document.body.dataset.world =
      canvas === null
        ? 'none'
        : `${canvas.bounds.width}x${canvas.bounds.height}`;
  },
});
