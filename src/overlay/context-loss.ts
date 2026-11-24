/**
 * The canvas's WebGL context (Story 3.6), with what it stops and starts
 * and the preload API passed in: no DOM and no PixiJS here, so it is
 * unit-tested under Node. main.ts forwards the canvas's
 * `webglcontextlost` and `webglcontextrestored`; PixiJS preventDefaults
 * the first itself, so the context can come back.
 *
 * - Lost: drawing stops (`halt`: the render loop stops, the world pauses
 *   as it does while the system sleeps, so no pack gets a `frame` and
 *   stage time stands still, and nothing takes the mouse), and main hears
 *   `context-lost` on `canvas:gpu`.
 * - Restored: drawing starts again (`resume`) from StageView as it is now
 *   and each pack's last draw, and main hears `context-restored`. PixiJS
 *   uploads the textures again from the images it kept: nothing is loaded
 *   again.
 * - Only changes count: `lost` while lost, or `restored` while not lost,
 *   does nothing, and main hears nothing.
 * - A failed report is logged on the console; drawing goes on as it is.
 *   main reloads the page when the context is not back in time, and a new
 *   page starts with a new context, not lost.
 *
 * createContextStage() is the overlay's wiring of it, with the world, the
 * mouse handling, the render loop, PixiJS's resizing and the body's data
 * attributes passed in:
 * - Lost: the world pauses (worldView), and stays paused through StageView
 *   changes (onView); the render loop stops; PixiJS stops following the
 *   window's size (its ResizePlugin would render on a resize); nothing
 *   takes the mouse (no hit areas, so a cursor over a character gets
 *   click-through back); the data attributes say `context=lost` and
 *   nothing drawn, no sprite, no bitmap, no placeholder (its opacity
 *   `none`), no name tag and no particle.
 *   The packs' bitmaps stay as they are (none closed): PixiJS uploads them
 *   again from their ImageBitmaps once the context is back.
 * - Restored: PixiJS follows the window's size again, the world follows
 *   StageView again, and the canvas follows the view (follow: the render
 *   loop and the next draw).
 * - attach() hears the canvas's events and then checks the context once:
 *   one already lost while the canvas was initialising is handled as lost.
 */
import type { CanvasGpuState } from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
import type { StageView } from '../shared/stage-view';
import type { CanvasInput } from './canvas-input';
import type { World } from './world/world';

export interface ContextWatchOptions {
  /** `window.awp`; undefined when the preload did not load. */
  readonly api: Pick<OverlayApi, 'canvas'> | undefined;
  /** Stops drawing: the context is gone. */
  readonly halt: () => void;
  /** Draws again: the context is back. */
  readonly resume: () => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

export interface ContextWatch {
  /** The canvas's `webglcontextlost`. */
  lost(): void;
  /** The canvas's `webglcontextrestored`. */
  restored(): void;
  /** Whether the context is lost now. */
  isLost(): boolean;
}

/** What overlay/world follows: StageView's actors and power. */
export type WorldView = Pick<StageView, 'actors' | 'power'>;

/**
 * What the world follows while the context is lost or not: `view` as it
 * is, or with its power read as asleep, so the world pauses exactly as it
 * does then (no tick, so no `frame`; stage time stands still) and goes on
 * once the context is back, with the actors that came or left meanwhile.
 */
export function worldView(view: WorldView, lost: boolean): WorldView {
  return lost
    ? { actors: view.actors, power: { ...view.power, suspended: true } }
    : view;
}

export function createContextWatch({
  api,
  halt,
  resume,
  logError = console.error,
}: ContextWatchOptions): ContextWatch {
  let lost = false;

  function report(state: CanvasGpuState): void {
    if (api === undefined) {
      return;
    }
    void api.canvas.gpu(state).then(
      (result) => {
        if (!result.ok) {
          logError(
            `[overlay] canvas:gpu: ${result.error.code}: ${result.error.message}`,
          );
        }
      },
      (error: unknown) => {
        logError('[overlay] canvas:gpu failed', error);
      },
    );
  }

  /** Runs `step`; a throw is logged, and the report still goes. */
  function run(step: () => void, what: string): void {
    try {
      step();
    } catch (error) {
      logError(`[overlay] ${what} failed`, error);
    }
  }

  return {
    lost() {
      if (lost) {
        return;
      }
      lost = true;
      run(halt, 'stopping the drawing');
      report('context-lost');
    },

    restored() {
      if (!lost) {
        return;
      }
      lost = false;
      run(resume, 'drawing again');
      report('context-restored');
    },

    isLost: () => lost,
  };
}

/** The canvas's context: its events and whether it is lost now. */
export interface ContextSource {
  on(
    event: 'webglcontextlost' | 'webglcontextrestored',
    listener: () => void,
  ): void;
  isContextLost(): boolean;
}

export interface ContextStageOptions<V extends WorldView> {
  /** `window.awp`; undefined when the preload did not load. */
  readonly api: Pick<OverlayApi, 'canvas'> | undefined;
  readonly world: Pick<World, 'onView'>;
  readonly input: Pick<CanvasInput, 'setAreas'>;
  /** The render loop (PixiJS's ticker). */
  readonly ticker: {
    started(): boolean;
    stop(): void;
  };
  /** PixiJS following the window's size (its `resizeTo`). */
  readonly resize: {
    pause(): void;
    resume(): void;
  };
  /** Sets one of the body's data attributes. */
  readonly show: (key: string, value: string) => void;
  /** The latest StageView, if any. */
  readonly view: () => V | undefined;
  /** The canvas follows `view` again: its render loop and next draw. */
  readonly follow: (view: V) => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

export interface ContextStage<V extends WorldView> extends ContextWatch {
  /** Hears `source`'s events, then checks it once. */
  attach(source: ContextSource): void;
  /** A StageView state: the world follows it, paused while lost. */
  onView(view: V): void;
}

export function createContextStage<V extends WorldView>({
  api,
  world,
  input,
  ticker,
  resize,
  show,
  view,
  follow,
  logError,
}: ContextStageOptions<V>): ContextStage<V> {
  const watch = createContextWatch({
    api,
    halt: () => {
      show('context', 'lost');
      const current = view();
      if (current !== undefined) {
        world.onView(worldView(current, true));
      }
      if (ticker.started()) {
        ticker.stop();
      }
      resize.pause();
      // Nothing on screen: nothing takes the mouse.
      input.setAreas([]);
      show('drawnActors', '0');
      show('drawnSprites', '0');
      show('drawnBitmaps', '0');
      show('drawnPlaceholders', '0');
      show('placeholderAlpha', 'none');
      show('drawnBadges', '0');
      show('particleEmitters', '0');
      show('liveParticles', '0');
      show('drawnEmitters', '0');
      show('drawnParticles', '0');
      show('hitAreas', '0');
    },
    resume: () => {
      show('context', 'ok');
      resize.resume();
      const current = view();
      if (current !== undefined) {
        world.onView(current);
        follow(current);
      }
    },
    logError,
  });

  return {
    ...watch,

    attach(source) {
      source.on('webglcontextlost', () => {
        watch.lost();
      });
      source.on('webglcontextrestored', () => {
        watch.restored();
      });
      show('context', 'ok');
      if (source.isContextLost()) {
        watch.lost();
      }
    },

    onView(current) {
      world.onView(worldView(current, watch.isLost()));
    },
  };
}
