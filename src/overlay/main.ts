import 'pixi.js/unsafe-eval';
// Overlay renderer entry: the canvas (AD-9, AD-24). The import above must
// stay the first line (a test checks it): the CSP has no 'unsafe-eval', so
// PixiJS needs its polyfill in place before anything else of it loads.
// Sandboxed with context isolation; it reaches main only through
// `window.awp` (src/preload/overlay.ts). No React here.
//
// It hosts the character packs' sandboxes (Story 3.5) and draws their
// characters (Story 3.6):
// - looks.ts gets what each pack is drawn with (its manifest and
//   spritesheets, from main) once it has an actor on stage;
// - pack-host follows StageView's actors, packs and characters, keeps one
//   sandbox iframe per pack with an actor, sends each its stage messages
//   at every world tick and keeps its latest valid draw;
// - world/world.ts ticks TICK_HZ times a second while there is an actor
//   and the system is neither asleep nor locked;
// - each display frame, while there is an actor and nothing is paused (at
//   most TICK_HZ a second, renderer/display.ts), renderer/scene.ts works
//   out what to draw from StageView, the looks and the latest draws,
//   renderer/pixi-stage.ts draws it with textures from
//   renderer/textures.ts (images loaded here from `pack://`), and
//   canvas-input.ts lets the characters on screen take the mouse (AD-14).
//   With no actor, or paused, the render loop stops after one last frame;
// - PixiJS's resolution follows the canvas's display (`canvas.scaleFactor`,
//   renderer/display.ts).
// The body's data attributes say what was last drawn and how many areas
// take the mouse, for DevTools.
import './index.css';
import { Application, Assets, Container } from 'pixi.js';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { OverlayApi, PreloadHost } from '../shared/preload-api';
import type { StageView } from '../shared/stage-view';
import { createCanvasInput } from './canvas-input';
import { createLooks, type PackLook } from './looks';
import { createDomSandboxFrames } from './pack-host/dom';
import { createPackHost } from './pack-host/host';
import { createPackLog } from './pack-host/log';
import { createMissingLog } from './renderer/missing-log';
import { capFrameRate, followResolution } from './renderer/display';
import {
  createPixiStage,
  pixiTextures,
  type PixiStage,
} from './renderer/pixi-stage';
import { buildScene } from './renderer/scene';
import { createTextureStore } from './renderer/textures';
import { startOverlay, type InitialisedCanvas } from './start';
import { createWorld, isPaused } from './world/world';

// Before any texture loads: the default loader decodes in a blob Worker,
// which the CSP blocks, and then never settles and never reports an error
// (Story 1.2 prototype). The textures here come from Image elements
// (renderer/pixi-stage.ts), which work under the CSP.
Assets.setPreferences({ preferCreateImageBitmap: false });

const app = new Application();

// Undefined when the preload failed to load; startOverlay logs that.
const api = (window as Window & PreloadHost<OverlayApi>)[PRELOAD_API_KEY];

const clock = {
  now: () => performance.now(),
  setTimer: (run: () => void, delayMs: number) =>
    window.setTimeout(run, delayMs),
  clearTimer: (handle: unknown) => {
    window.clearTimeout(handle as number);
  },
};

const input = createCanvasInput({ api });

const log = api === undefined ? () => {} : createPackLog(api.packs);

// What each pack is drawn with; none without the preload API.
const looks =
  api === undefined ? undefined : createLooks({ api: api.packs, log });

// The packs' sandboxes; none without the preload API (startOverlay logs that).
const packHost =
  api === undefined
    ? undefined
    : createPackHost({
        api: api.packs,
        frames: createDomSandboxFrames({
          createIframe: () => document.createElement('iframe'),
          attach: (iframe) => {
            document.body.append(iframe);
          },
          window,
          createChannel: () => new MessageChannel(),
        }),
        clock,
        looks,
      });

const world = createWorld({
  clock,
  onTick: (tick) => {
    packHost?.tick(tick);
  },
});

/** Loads a pack's image from `pack://`, readable by WebGL (crossorigin). */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener(
      'error',
      () => reject(new Error('the image could not be loaded')),
      { once: true },
    );
    image.src = url;
  });
}

const textures = createTextureStore({
  backend: pixiTextures(loadImage),
  onFailed: (packId, asset) => {
    log({ kind: 'not-drawn', packId, reason: 'asset-failed', asset });
  },
});

const reportMissing = createMissingLog(log);

/** The latest StageView. */
let view: StageView | undefined;

/** The drawing, once the canvas has initialised. */
let stage: PixiStage | undefined;

/** Sets a data attribute of the body, for DevTools, when it changes. */
function show(key: string, value: string): void {
  if (document.body.dataset[key] !== value) {
    document.body.dataset[key] = value;
  }
}

/** The looks of the packs installed now, each at its installed version. */
function installedLooks(current: StageView): PackLook[] {
  if (looks === undefined) {
    return [];
  }
  return current.packs.installed.flatMap((pack) => {
    const look = looks.get(pack.id);
    return look?.version === pack.version ? [look] : [];
  });
}

/** One display frame: what to draw, drawn; what takes the mouse. */
function drawFrame(): void {
  if (stage === undefined || view === undefined || packHost === undefined) {
    return;
  }
  textures.sync(installedLooks(view));
  const scene = buildScene({
    view,
    look: (packId) => looks?.get(packId),
    draw: (packId) => packHost.drawOf(packId),
    ready: (packId, version, asset, frame) =>
      textures.get(packId, version, asset, frame) !== undefined,
  });
  reportMissing(scene.missing);
  const counts = stage.draw(scene);
  input.setAreas(scene.areas);
  show('drawnActors', String(counts.actors));
  show('drawnSprites', String(counts.sprites));
  show('hitAreas', String(scene.areas.length));
}

/** Follows StageView with the canvas: its resolution and render loop. */
function followView(current: StageView): void {
  if (stage === undefined) {
    return;
  }
  show(
    'resolution',
    String(followResolution(app.renderer, current.canvas, app.screen)),
  );
  if (current.actors.length > 0 && !isPaused(current.power)) {
    if (!app.ticker.started) {
      app.start();
    }
    return;
  }
  if (app.ticker.started) {
    app.stop();
  }
  // One last frame: the actors that left are gone from the screen.
  drawFrame();
  app.render();
}

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
    // Until StageView places the canvas; then its display's scaleFactor.
    resolution: window.devicePixelRatio,
    // The render loop runs only while there is an actor (followView).
    autoStart: false,
  });
  document.body.append(app.canvas);
  const layer = new Container();
  app.stage.addChild(layer);
  stage = createPixiStage(layer, (packId, version, asset, frame) =>
    textures.get(packId, version, asset, frame),
  );
  // Before the render the Application adds itself (a lower priority).
  app.ticker.add(drawFrame);
  capFrameRate(app.ticker);
  if (view !== undefined) {
    followView(view);
  }
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
    view = snapshot.view;
    looks?.onView(view);
    packHost?.onView(view);
    world.onView(view);
    followView(view);
  },
});
