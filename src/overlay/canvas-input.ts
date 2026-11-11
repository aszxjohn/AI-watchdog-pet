/**
 * overlay/canvas-input (AD-14): the canvas's mouse handling, with the
 * preload API and the drawing passed in: no DOM and no PixiJS types here,
 * so it is unit-tested under Node. main.ts forwards the DOM events (their
 * client coordinates are world coordinates) and draws.
 *
 * - Each StageView state gives the demo square (demo-square.ts). Once the
 *   canvas can draw, a changed square is drawn, and only then do the areas
 *   that take the mouse follow it. Until the canvas has initialised, or if
 *   it never does, nothing takes the mouse: no invisible region blocks
 *   clicks or opens a menu.
 * - Mouse moves and the cursor leaving the window go to pointer.ts, and
 *   each request it gives goes to main on `canvas:set-hover`. So does the
 *   `over: false` when the areas change under a still cursor that is no
 *   longer over one (the square went away or moved with the world).
 * - A right-click on the square asks main for its menu on
 *   `canvas:context-menu`, then counts as the cursor leaving: the native
 *   menu takes the mouse, and once it closes, click-through must not stay
 *   off where the menu was until the next move. The next move decides
 *   again. onContextMenu says whether the DOM event is to be
 *   preventDefault-ed: only such a right-click is.
 */
import type { SessionKey } from '../shared/detection-events';
import type { IpcError, IpcResult } from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
import type { StageView } from '../shared/stage-view';
import { demoSquare, demoSquareAreas, type DemoSquare } from './demo-square';
import {
  areasChanged,
  hitTest,
  POINTER_START,
  pointerLeft,
  pointerMoved,
  type HitArea,
  type Point,
  type PointerStep,
} from './pointer';

export interface CanvasInputOptions {
  /** `window.awp`; undefined when the preload did not load. */
  readonly api: Pick<OverlayApi, 'canvas'> | undefined;
  /**
   * Draws `square` (null: nothing) and renders. Called only after
   * onCanvasReady().
   */
  readonly draw: (square: DemoSquare | null) => void;
  readonly logError?: (message: string) => void;
}

export interface CanvasInput {
  /** Hears each StageView state. */
  onView(view: Pick<StageView, 'canvas' | 'sessions'>): void;
  /** The canvas has initialised and can draw: the latest square is drawn. */
  onCanvasReady(): void;
  /** The cursor moved to `point` (client coordinates). */
  onMouseMove(point: Point): void;
  /** The cursor left the window. */
  onMouseLeave(): void;
  /**
   * A right-click at `point`. Returns whether it was on what takes the
   * mouse, which is then to be preventDefault-ed.
   */
  onContextMenu(point: Point): boolean;
}

export function createCanvasInput({
  api,
  draw,
  logError = console.error,
}: CanvasInputOptions): CanvasInput {
  let canDraw = false;
  /** What the latest StageView says to draw; null for nothing. */
  let square: DemoSquare | null = null;
  /** What takes the mouse: the square last drawn, if any. */
  let areas: readonly HitArea<SessionKey>[] = [];
  let pointer = POINTER_START;

  function logFailure(channel: string, result: IpcResult<null>): void {
    if (!result.ok) {
      const error: IpcError = result.error;
      logError(`[overlay] ${channel}: ${error.code}: ${error.message}`);
    }
  }

  /** Keeps a pointer step's state and sends main its request, if any. */
  function apply(step: PointerStep): void {
    pointer = step.state;
    if (step.request === null || api === undefined) {
      return;
    }
    void api.canvas.setHover(step.request).then((result) => {
      logFailure('canvas:set-hover', result);
    });
  }

  /** Draws the latest square, then lets what was drawn take the mouse. */
  function show(): void {
    if (!canDraw) {
      return;
    }
    draw(square);
    areas = demoSquareAreas(square);
    apply(areasChanged(pointer, areas));
  }

  return {
    onView(view) {
      const next = demoSquare(view);
      if (JSON.stringify(next) === JSON.stringify(square)) {
        return;
      }
      square = next;
      show();
    },

    onCanvasReady() {
      canDraw = true;
      show();
    },

    onMouseMove(point) {
      apply(pointerMoved(pointer, point, areas));
    },

    onMouseLeave() {
      apply(pointerLeft(pointer));
    },

    onContextMenu(point) {
      const hit = hitTest(point, areas);
      if (hit === undefined) {
        return false;
      }
      if (api !== undefined) {
        void api.canvas.contextMenu(hit.key).then((result) => {
          logFailure('canvas:context-menu', result);
        });
      }
      apply(pointerLeft(pointer));
      return true;
    },
  };
}
