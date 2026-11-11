import 'pixi.js/unsafe-eval';
// Overlay renderer entry: the canvas (AD-9, AD-24). The import above must
// stay the first line (a test checks it): the CSP has no 'unsafe-eval', so
// PixiJS needs its polyfill in place before anything else of it loads.
// Sandboxed with context isolation; it reaches main only through
// `window.awp` (src/preload/overlay.ts). No React here.
//
// For Epic 2's acceptance it draws the demo session's square
// (demo-square.ts, removed in Epic 3) and lets it take the mouse (AD-14):
// canvas-input.ts decides what to draw and what to ask main; this file
// only forwards the DOM events to it and draws with PixiJS.
import './index.css';
import { Application, Assets, Graphics, Text } from 'pixi.js';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { OverlayApi, PreloadHost } from '../shared/preload-api';
import { createCanvasInput } from './canvas-input';
import { DEMO_SQUARE_LIGHT_TEXT, type DemoSquare } from './demo-square';
import { startOverlay, type InitialisedCanvas } from './start';

// Before any texture loads: the default loader decodes in a blob Worker,
// which the CSP blocks, and then never settles and never reports an error
// (Story 1.2 prototype). Image elements work under the CSP.
Assets.setPreferences({ preferCreateImageBitmap: false });

const app = new Application();

// Undefined when the preload failed to load; startOverlay logs that.
const api = (window as Window & PreloadHost<OverlayApi>)[PRELOAD_API_KEY];

/** The demo square's shape and label, once the canvas has initialised. */
let drawing: { readonly shape: Graphics; readonly label: Text } | undefined;

/** Draws `square` (null: nothing) and renders once: there is no render loop. */
function draw(square: DemoSquare | null): void {
  if (drawing === undefined) {
    return;
  }
  const { shape, label } = drawing;
  shape.clear();
  if (square === null) {
    label.visible = false;
  } else {
    shape.rect(square.x, square.y, square.size, square.size).fill(square.fill);
    label.text = square.label;
    label.style.fill = square.textColor;
    label.position.set(square.x + square.size / 2, square.y + square.size / 2);
    label.visible = true;
  }
  app.render();
}

const input = createCanvasInput({ api, draw });

// While click-through, macOS and Windows still forward mouse moves here
// (AD-14); Linux forwards nothing, so none of these fire there.
window.addEventListener('mousemove', (event) => {
  input.onMouseMove({ x: event.clientX, y: event.clientY });
});
document.documentElement.addEventListener('mouseleave', () => {
  input.onMouseLeave();
});
window.addEventListener('contextmenu', (event) => {
  if (input.onContextMenu({ x: event.clientX, y: event.clientY })) {
    event.preventDefault();
  }
});

async function initCanvas(): Promise<InitialisedCanvas> {
  await app.init({
    preference: 'webgl',
    backgroundAlpha: 0,
    resizeTo: window,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    // Nothing moves yet (no characters, no world tick until Story 3.x), so
    // there is no render loop: each change to the demo square draws it and
    // renders once, and PixiJS renders again after a resize.
    autoStart: false,
  });
  document.body.append(app.canvas);
  const shape = new Graphics();
  const label = new Text({
    text: '',
    style: {
      fontFamily: 'sans-serif',
      fontSize: 22,
      fontWeight: 'bold',
      fill: DEMO_SQUARE_LIGHT_TEXT,
    },
    anchor: 0.5,
  });
  label.visible = false;
  app.stage.addChild(shape, label);
  drawing = { shape, label };
  // Draws (and renders) the latest square; only now does it take the mouse.
  input.onCanvasReady();
  return {
    renderer: app.renderer.name,
    width: app.screen.width,
    height: app.screen.height,
  };
}

void startOverlay({
  api,
  initCanvas,
  onView: (snapshot) => {
    // For DevTools: the StageView rev and world size this page last saw.
    const { canvas } = snapshot.view;
    document.body.dataset.stageViewRev = String(snapshot.rev);
    document.body.dataset.world =
      canvas === null
        ? 'none'
        : `${canvas.bounds.width}x${canvas.bounds.height}`;
    input.onView(snapshot.view);
  },
});
