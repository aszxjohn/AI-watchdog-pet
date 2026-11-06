/**
 * The overlay's startup (AD-9, AD-20), with PixiJS and the preload API
 * passed in: no PixiJS and no DOM types here, so it is unit-tested under
 * Node. main.ts wires the real ones.
 *
 * 1. Subscribe to StageView (a rebuilt canvas gets a fresh snapshot).
 * 2. Initialise the canvas.
 * 3. Report once on `canvas:ready`: the renderer and the world size it got,
 *    or a short reason it failed. A failure leaves the app running; main
 *    only logs it.
 */
import {
  CANVAS_READY_REASON_MAX_LENGTH,
  canvasRendererSchema,
  type CanvasReadyReport,
} from '../shared/ipc';
import type { OverlayApi } from '../shared/preload-api';
import type { StageViewSnapshot } from '../shared/stage-view';

/** What an initialised canvas reports about itself. */
export interface InitialisedCanvas {
  /** PixiJS `renderer.name`: `webgl`, `webgpu` or `canvas`. */
  readonly renderer: string;
  /** The world size it sees, in DIP (`app.screen`). */
  readonly width: number;
  readonly height: number;
}

export interface OverlayStartOptions {
  /** `window.awp`; undefined when the preload did not load. */
  readonly api: OverlayApi | undefined;
  /** Initialises PixiJS; resolves with what it got, or rejects. */
  readonly initCanvas: () => Promise<InitialisedCanvas>;
  /** Hears each StageView state. */
  readonly onView?: (snapshot: StageViewSnapshot) => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

/**
 * A short, bounded reason for `canvas:ready` from a thrown value. Never
 * throws: a value that cannot be turned into text (a null-prototype object,
 * a throwing toString) gives `unknown error`.
 */
export function failureReport(error: unknown): CanvasReadyReport {
  let reason: string;
  try {
    if (error instanceof Error) {
      reason =
        error.message === '' ? error.name : `${error.name}: ${error.message}`;
    } else {
      reason = String(error);
    }
  } catch {
    reason = '';
  }
  return {
    ok: false,
    reason: (reason === '' ? 'unknown error' : reason).slice(
      0,
      CANVAS_READY_REASON_MAX_LENGTH,
    ),
  };
}

/** The `canvas:ready` report for an initialised canvas. */
export function readyReport(canvas: InitialisedCanvas): CanvasReadyReport {
  const renderer = canvasRendererSchema.safeParse(canvas.renderer);
  if (!renderer.success) {
    return failureReport(`unknown renderer "${canvas.renderer}"`);
  }
  const size = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    ok: true,
    renderer: renderer.data,
    width: size(canvas.width),
    height: size(canvas.height),
  };
}

/**
 * Starts the overlay. Resolves with the report it sent, or undefined when
 * there is no preload API to send it with. Never rejects.
 */
export async function startOverlay({
  api,
  initCanvas,
  onView,
  logError = console.error,
}: OverlayStartOptions): Promise<CanvasReadyReport | undefined> {
  if (api === undefined) {
    logError('[overlay] window.awp is missing: the preload did not load');
    return undefined;
  }

  try {
    api.stageView.subscribe(
      (snapshot) => {
        onView?.(snapshot);
      },
      (error) => {
        logError(`[overlay] StageView: ${error.code}: ${error.message}`);
      },
    );
  } catch (error) {
    logError('[overlay] could not subscribe to StageView', error);
  }

  let report: CanvasReadyReport;
  try {
    report = readyReport(await initCanvas());
  } catch (error) {
    logError('[overlay] the canvas could not be initialised', error);
    report = failureReport(error);
  }

  try {
    const result = await api.canvas.ready(report);
    if (!result.ok) {
      logError(
        `[overlay] canvas:ready: ${result.error.code}: ${result.error.message}`,
      );
    }
  } catch (error) {
    logError('[overlay] canvas:ready failed', error);
  }
  return report;
}
