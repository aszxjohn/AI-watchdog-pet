/**
 * overlay/canvas-input (AD-14): the canvas's mouse handling, with the
 * preload API passed in: no DOM and no PixiJS types here, so it is
 * unit-tested under Node. main.ts forwards the DOM events (their client
 * coordinates are world coordinates) and the areas each drawn frame takes
 * the mouse over.
 *
 * - What takes the mouse is what the renderer last drew (Story 3.6): one
 *   area per drawn actor, its manifest `hitbox` times its 大小 at its
 *   place on screen, named by its session key, the one drawn on top last
 *   (renderer/scene.ts). Nothing takes the mouse before the first drawn
 *   frame, so no invisible region blocks clicks.
 * - Mouse moves and the cursor leaving the window go to pointer.ts, and
 *   each request it gives goes to main on `canvas:set-hover`. So does the
 *   `over: false` when the areas change under a still cursor that is no
 *   longer over one (the actor left, moved or stopped being drawn).
 * - A right-click on an actor goes to main on `canvas:context-menu`, named
 *   by the session key of the actor under the cursor (the one on top);
 *   onContextMenu says whether it was on one, to be preventDefault-ed.
 *   main opens no menu yet (a character's menu is Story 4.3; the demo
 *   session's menu went with the demo square), so nothing takes the mouse
 *   away from the page and click-through stays as it is.
 */
import type { SessionKey } from '../shared/detection-events';
import type { IpcError, IpcResult } from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
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
  readonly logError?: (message: string) => void;
}

export interface CanvasInput {
  /** What takes the mouse now: the actors last drawn, top last. */
  setAreas(areas: readonly HitArea<SessionKey>[]): void;
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

/** Whether two lists of areas are the same, area by area. */
function sameAreas(
  a: readonly HitArea<SessionKey>[],
  b: readonly HitArea<SessionKey>[],
): boolean {
  return (
    a.length === b.length &&
    a.every((area, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        area.key === other.key &&
        area.x === other.x &&
        area.y === other.y &&
        area.width === other.width &&
        area.height === other.height
      );
    })
  );
}

export function createCanvasInput({
  api,
  logError = console.error,
}: CanvasInputOptions): CanvasInput {
  /** What takes the mouse: the actors last drawn. */
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

  return {
    setAreas(next) {
      if (sameAreas(next, areas)) {
        return;
      }
      areas = [...next];
      apply(areasChanged(pointer, areas));
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
      return true;
    },
  };
}
