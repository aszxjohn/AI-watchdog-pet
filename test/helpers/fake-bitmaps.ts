/**
 * Stand-ins for the browser's ImageBitmap and OffscreenCanvas (Story 3.6's
 * last part), which Node does not have:
 *
 * - FakeImageBitmap counts its close() calls; closed, it is 0 x 0 as a
 *   real one is. Its size is in private fields behind `width` and `height`
 *   getters on its prototype, so, as a real one's, the `width` getter
 *   throws for anything but a FakeImageBitmap, whatever its prototype (the
 *   Worker bootstrap's brand check, bitmapBrandOf). stubImageBitmap()
 *   makes it the global ImageBitmap (what src/shared/draw-size.ts's
 *   isImageBitmap and bitmapBrandOf(globalThis) look for);
 *   vi.unstubAllGlobals takes it away.
 * - fakeOffscreenCanvas() is a fresh OffscreenCanvas constructor (and 2d
 *   context class) each time: its context has a `canvas` getter on its
 *   prototype, as the browser's has, which can be made non-configurable;
 *   setting a size clears the canvas, and so does transferToImageBitmap,
 *   which gives a FakeImageBitmap of its size.
 */
import { vi } from 'vitest';

export class FakeImageBitmap {
  #width: number;
  #height: number;
  /** How many times close() was called. */
  closes = 0;

  constructor(width = 8, height = 8) {
    this.#width = width;
    this.#height = height;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  close(): void {
    this.closes += 1;
    this.#width = 0;
    this.#height = 0;
  }
}

/** Makes FakeImageBitmap the global ImageBitmap (vi.unstubAllGlobals undoes it). */
export function stubImageBitmap(): void {
  vi.stubGlobal('ImageBitmap', FakeImageBitmap);
}

/** One fake canvas, as the tests look at it. */
export interface FakeCanvas {
  width: number;
  height: number;
  /** How many times it was cleared: each size set, each bitmap taken. */
  readonly clears: number;
  /** The bitmaps taken from it, in order. */
  readonly bitmaps: readonly FakeImageBitmap[];
  getContext(contextId: string): object | null;
  transferToImageBitmap(): FakeImageBitmap;
}

export interface FakeOffscreenCanvas {
  /** The constructor, to put on a scope as `OffscreenCanvas`. */
  readonly OffscreenCanvas: new (width: number, height: number) => FakeCanvas;
  /** Its 2d context's prototype (where `canvas` is). */
  readonly contextPrototype: object;
  /** Every canvas made, in order. */
  readonly made: readonly FakeCanvas[];
}

export function fakeOffscreenCanvas(
  options: {
    /** The context's `canvas` getter cannot be deleted. */
    readonly lockedCanvasGetter?: boolean;
    /** getContext('2d') gives null. */
    readonly no2d?: boolean;
  } = {},
): FakeOffscreenCanvas {
  const made: FakeCanvas[] = [];
  const canvasOf = new WeakMap<object, FakeCanvas>();

  class Context2d {
    constructor(canvas: FakeCanvas) {
      canvasOf.set(this, canvas);
    }

    fillRect(): void {}
  }
  Object.defineProperty(Context2d.prototype, 'canvas', {
    get(this: object) {
      return canvasOf.get(this);
    },
    configurable: options.lockedCanvasGetter !== true,
    enumerable: true,
  });

  class Canvas implements FakeCanvas {
    #width: number;
    #height: number;
    #clears = 0;
    readonly #context: Context2d;
    readonly bitmaps: FakeImageBitmap[] = [];

    constructor(width: number, height: number) {
      this.#width = width;
      this.#height = height;
      this.#context = new Context2d(this);
      made.push(this);
    }

    get width(): number {
      return this.#width;
    }

    set width(value: number) {
      this.#width = value;
      this.#clears += 1;
    }

    get height(): number {
      return this.#height;
    }

    set height(value: number) {
      this.#height = value;
      this.#clears += 1;
    }

    get clears(): number {
      return this.#clears;
    }

    getContext(contextId: string): object | null {
      return contextId === '2d' && options.no2d !== true ? this.#context : null;
    }

    transferToImageBitmap(): FakeImageBitmap {
      const bitmap = new FakeImageBitmap(this.#width, this.#height);
      this.bitmaps.push(bitmap);
      this.#clears += 1;
      return bitmap;
    }
  }

  return {
    OffscreenCanvas: Canvas,
    contextPrototype: Context2d.prototype,
    made,
  };
}
