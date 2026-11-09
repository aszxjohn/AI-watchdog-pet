import type {
  BrowserWindowConstructorOptions,
  IgnoreMouseEventsOptions,
} from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canvasWindowOptions,
  createCanvasWindows,
  logCanvasReady,
  overlayUrl,
  setClickThrough,
  type CanvasPlacement,
  type CanvasWindowHandle,
} from '../../src/main/windows/canvas-window';
import type { WindowsEnvironment } from '../../src/main/windows/environment';
import { secureWebPreferences } from '../../src/main/windows/security';
import {
  CANVAS_REBUILD_LIMIT,
  CANVAS_REBUILD_WINDOW_MS,
} from '../../src/shared/constants';
import type { DisplayBounds } from '../../src/shared/stage-view';

vi.mock('electron', () => import('../helpers/fake-electron'));

const PRELOAD = '/app/.vite/build/overlay.cjs';
const OVERLAY_DEV_URL = 'http://localhost:5174';
const PACKAGED: WindowsEnvironment = {
  packaged: true,
  devServers: { panels: undefined, overlay: undefined },
};
const DEV: WindowsEnvironment = {
  packaged: false,
  devServers: {
    panels: { url: 'http://localhost:5173', origin: 'http://localhost:5173' },
    overlay: { url: OVERLAY_DEV_URL, origin: OVERLAY_DEV_URL },
  },
};
const PRIMARY: CanvasPlacement = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};
const EXTERNAL: CanvasPlacement = {
  displayId: 69733632,
  bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  fallback: false,
};

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A fake BrowserWindow that records what the canvas does to it. */
class FakeWindow implements CanvasWindowHandle {
  static created: FakeWindow[] = [];
  readonly calls: string[] = [];
  readonly loaded: string[] = [];
  readonly ignoreMouse: unknown[][] = [];
  readonly bounds: DisplayBounds[] = [];
  destroyed = false;
  /** When set, getBounds answers this instead of what was asked for. */
  osBounds: DisplayBounds | undefined;
  /** When set, loadURL rejects the way Electron does for a failed load. */
  static rejectLoads = false;
  readonly windowListeners = new Map<string, (() => void)[]>();
  readonly contentsListeners = new Map<
    string,
    ((...args: never[]) => void)[]
  >();

  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeWindow.created.push(this);
  }

  readonly webContents = {
    loadURL: (url: string) => {
      this.loaded.push(url);
      return FakeWindow.rejectLoads
        ? Promise.reject(new Error('ERR_FILE_NOT_FOUND (-6) loading url'))
        : Promise.resolve();
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      const list = this.contentsListeners.get(event) ?? [];
      list.push(listener);
      this.contentsListeners.set(event, list);
    },
  };

  once(event: string, listener: () => void) {
    this.addWindowListener(event, listener);
  }
  on(event: string, listener: () => void) {
    this.addWindowListener(event, listener);
  }
  private addWindowListener(event: string, listener: () => void) {
    const list = this.windowListeners.get(event) ?? [];
    list.push(listener);
    this.windowListeners.set(event, list);
  }
  emit(event: string) {
    for (const listener of this.windowListeners.get(event) ?? []) {
      listener();
    }
  }
  emitContents(event: string, ...args: unknown[]) {
    for (const listener of this.contentsListeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  /** What a crashed renderer does. */
  crash(reason = 'crashed', exitCode = 11) {
    this.emitContents('render-process-gone', {}, { reason, exitCode });
  }
  setIgnoreMouseEvents(...args: [boolean, IgnoreMouseEventsOptions?]) {
    this.ignoreMouse.push(args);
  }
  setBounds(bounds: DisplayBounds) {
    this.bounds.push(bounds);
  }
  getBounds(): DisplayBounds {
    const { x = 0, y = 0, width = 0, height = 0 } = this.options;
    return this.osBounds ?? this.bounds.at(-1) ?? { x, y, width, height };
  }
  showInactive() {
    this.calls.push('showInactive');
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.calls.push('destroy');
    this.destroyed = true;
    this.emit('closed');
  }
}

function setup(
  options: { env?: WindowsEnvironment; platform?: NodeJS.Platform } = {},
) {
  FakeWindow.created = [];
  let time = 0;
  const deferred: (() => void)[] = [];
  const canvas = createCanvasWindows({
    createWindow: (windowOptions) => new FakeWindow(windowOptions),
    preload: PRELOAD,
    env: options.env ?? PACKAGED,
    platform: options.platform ?? 'darwin',
    now: () => time,
    defer: (run) => {
      deferred.push(run);
    },
  });
  return {
    canvas,
    win: () => FakeWindow.created.at(-1) as FakeWindow,
    /** Runs what the canvas deferred (the rebuild after a crash). */
    flush() {
      for (const run of deferred.splice(0)) {
        run();
      }
    },
    setTime(ms: number) {
      time = ms;
    },
  };
}

describe('canvas window settings', () => {
  it.each([['darwin'], ['win32'], ['linux']] as const)(
    '%s: covers the display exactly, transparent, frameless, on top, never focused, not in the taskbar',
    (platform) => {
      const options = canvasWindowOptions(PRELOAD, EXTERNAL.bounds, platform);

      expect(options).toMatchObject({
        x: 1512,
        y: -200,
        width: 2560,
        height: 1440,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
      });
      expect(options).not.toHaveProperty('visibleOnAllWorkspaces');
    },
  );

  it('is a non-activating panel on macOS, a tool window on Windows (out of Alt+Tab), nothing on Linux', () => {
    expect(canvasWindowOptions(PRELOAD, PRIMARY.bounds, 'darwin').type).toBe(
      'panel',
    );
    expect(canvasWindowOptions(PRELOAD, PRIMARY.bounds, 'win32').type).toBe(
      'toolbar',
    );
    expect(
      canvasWindowOptions(PRELOAD, PRIMARY.bounds, 'linux'),
    ).not.toHaveProperty('type');
  });

  it('may cover the macOS menu bar area (enableLargerThanScreen), on macOS only', () => {
    expect(
      canvasWindowOptions(PRELOAD, PRIMARY.bounds, 'darwin')
        .enableLargerThanScreen,
    ).toBe(true);
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        canvasWindowOptions(PRELOAD, PRIMARY.bounds, platform),
      ).not.toHaveProperty('enableLargerThanScreen');
    }
  });

  it.each([['darwin'], ['win32'], ['linux']] as const)(
    '%s: has the AD-24 webPreferences baseline from security.ts, plus no background throttling',
    (platform) => {
      expect(
        canvasWindowOptions(PRELOAD, PRIMARY.bounds, platform).webPreferences,
      ).toStrictEqual({
        ...secureWebPreferences(PRELOAD),
        backgroundThrottling: false,
      });
    },
  );
});

describe('click-through', () => {
  it.each([['darwin'], ['win32']] as const)(
    '%s: ignores clicks but forwards mouse moves',
    (platform) => {
      const win = { setIgnoreMouseEvents: vi.fn() };
      setClickThrough(win, platform);
      expect(win.setIgnoreMouseEvents.mock.calls).toStrictEqual([
        [true, { forward: true }],
      ]);
    },
  );

  it.each([['linux'], ['freebsd']] as const)(
    '%s: ignores the whole window',
    (platform) => {
      const win = { setIgnoreMouseEvents: vi.fn() };
      setClickThrough(win, platform);
      expect(win.setIgnoreMouseEvents.mock.calls).toStrictEqual([[true]]);
    },
  );

  it.each([
    ['darwin', [true, { forward: true }]],
    ['win32', [true, { forward: true }]],
    ['linux', [true]],
  ] as const)(
    '%s: the canvas is click-through from creation',
    (platform, args) => {
      const { canvas, win } = setup({ platform });
      canvas.place(PRIMARY);
      expect(win().ignoreMouse).toStrictEqual([args]);
    },
  );
});

describe('overlayUrl', () => {
  it('loads app://overlay/ once packaged and the overlay dev server under npm start', () => {
    expect(overlayUrl(PACKAGED)).toBe('app://overlay/index.html');
    expect(overlayUrl(DEV)).toBe(OVERLAY_DEV_URL);
  });
});

describe('placing the canvas', () => {
  it('creates it on the first placement, loads the overlay and logs it', () => {
    const { canvas, win } = setup();

    canvas.place(PRIMARY);

    expect(FakeWindow.created).toHaveLength(1);
    expect(win().options).toStrictEqual(
      canvasWindowOptions(PRELOAD, PRIMARY.bounds, 'darwin'),
    );
    expect(win().loaded).toStrictEqual(['app://overlay/index.html']);
    expect(canvas.current()).toBe(win());
    expect(lines(info)).toContain(
      '[windows] canvas window created on display 1, 1512x982 at 0,0, scale 2',
    );
  });

  it('loads the overlay dev server under npm start', () => {
    const { canvas, win } = setup({ env: DEV });
    canvas.place(PRIMARY);
    expect(win().loaded).toStrictEqual([OVERLAY_DEV_URL]);
  });

  it('shows it without focus once ready, and never focuses it', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);
    expect(win().calls).toStrictEqual([]);

    win().emit('ready-to-show');

    expect(win().calls).toStrictEqual(['showInactive']);
  });

  it('moves it with setBounds when the placement changes, and logs it', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);

    canvas.place(EXTERNAL);

    expect(FakeWindow.created).toHaveLength(1);
    expect(win().bounds).toStrictEqual([EXTERNAL.bounds]);
    expect(lines(info)).toContain(
      '[windows] canvas window moved to display 69733632, 2560x1440 at 1512,-200, scale 1.5',
    );
  });

  it('logs nothing when the window is where it was asked to be', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);
    win().emit('ready-to-show');
    canvas.place(EXTERNAL);

    expect(lines(warn)).toStrictEqual([]);
  });

  it('warns, with both bounds, when the OS put the window elsewhere once shown', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);
    win().osBounds = { x: 0, y: 30, width: 1512, height: 982 };

    win().emit('ready-to-show');

    expect(lines(warn)).toStrictEqual([
      '[windows] canvas window is at 1512x982 at 0,30, not the requested 1512x982 at 0,0 (once shown)',
    ]);
  });

  it('warns, with both bounds, when a move did not land where asked', () => {
    const { canvas, win } = setup({ platform: 'win32' });
    canvas.place(PRIMARY);
    win().osBounds = { x: 1512, y: -200, width: 1707, height: 960 };

    canvas.place(EXTERNAL);

    expect(lines(warn)).toStrictEqual([
      '[windows] canvas window is at 1707x960 at 1512,-200, not the requested 2560x1440 at 1512,-200 (after the move)',
    ]);
  });

  it('does nothing when the bounds stay the same', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);

    canvas.place({ ...PRIMARY, fallback: true });

    expect(win().bounds).toStrictEqual([]);
  });

  it('creates a new one if the window was closed', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);
    win().destroy();
    expect(canvas.current()).toBeUndefined();
    expect(lines(info)).toContain('[windows] canvas window closed');

    canvas.place(PRIMARY);

    expect(FakeWindow.created).toHaveLength(2);
  });
});

describe('load failures', () => {
  it('swallows a rejected load (did-fail-load reports it) and keeps the window', async () => {
    const { canvas, win } = setup();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    FakeWindow.rejectLoads = true;
    try {
      canvas.place(PRIMARY);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      FakeWindow.rejectLoads = false;
      process.off('unhandledRejection', unhandled);
    }

    expect(win().loaded).toStrictEqual(['app://overlay/index.html']);
    expect(unhandled).not.toHaveBeenCalled();
    expect(win().calls).not.toContain('destroy');
    expect(canvas.current()).toBe(win());
  });

  it('logs a main-frame load failure and keeps the window', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);

    win().emitContents(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app://overlay/index.html',
      true,
    );

    expect(lines(error)).toStrictEqual([
      '[windows] canvas page failed to load (-6 ERR_FILE_NOT_FOUND)',
    ]);
    expect(win().calls).not.toContain('destroy');
  });

  it('ignores an aborted load and a failed subframe', () => {
    const { canvas, win } = setup();
    canvas.place(PRIMARY);

    win().emitContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'x', true);
    win().emitContents('did-fail-load', {}, -6, 'ERR_FILE', 'x', false);

    expect(lines(error)).toStrictEqual([]);
  });
});

describe('renderer crashes', () => {
  it('logs the crash and rebuilds the window at the same place, outside the event', () => {
    const { canvas, win, flush } = setup({ platform: 'win32' });
    canvas.place(EXTERNAL);
    const first = win();

    first.crash('crashed', 11);

    expect(lines(error)).toContain(
      '[windows] canvas renderer gone (crashed, exit code 11)',
    );
    expect(first.calls).not.toContain('destroy');
    expect(FakeWindow.created).toHaveLength(1);

    flush();

    expect(first.calls).toContain('destroy');
    expect(FakeWindow.created).toHaveLength(2);
    const second = win();
    expect(second.options).toStrictEqual(
      canvasWindowOptions(PRELOAD, EXTERNAL.bounds, 'win32'),
    );
    expect(second.ignoreMouse).toStrictEqual([[true, { forward: true }]]);
    expect(second.loaded).toStrictEqual(['app://overlay/index.html']);
    expect(canvas.current()).toBe(second);
    expect(lines(info)).toContain(
      `[windows] rebuilding the canvas window (1 of ${CANVAS_REBUILD_LIMIT} within 60 s)`,
    );
    // The old window closing is part of the rebuild, not a separate event.
    expect(lines(info)).not.toContain('[windows] canvas window closed');
  });

  it('rebuilds at the latest placement', () => {
    const { canvas, win, flush } = setup();
    canvas.place(PRIMARY);
    win().crash();
    canvas.place(EXTERNAL);

    flush();

    expect(FakeWindow.created).toHaveLength(2);
    expect(win().options).toMatchObject(EXTERNAL.bounds);
  });

  it(`stops after ${CANVAS_REBUILD_LIMIT} rebuilds within ${CANVAS_REBUILD_WINDOW_MS / 1000} s and logs an error`, () => {
    const { canvas, win, flush, setTime } = setup();
    canvas.place(PRIMARY);

    for (const at of [0, 10_000, 20_000]) {
      setTime(at);
      win().crash();
      flush();
    }
    expect(FakeWindow.created).toHaveLength(1 + CANVAS_REBUILD_LIMIT);

    setTime(59_999);
    const last = win();
    last.crash();
    flush();

    expect(FakeWindow.created).toHaveLength(1 + CANVAS_REBUILD_LIMIT);
    expect(last.calls).toContain('destroy');
    expect(canvas.current()).toBeUndefined();
    expect(lines(error).at(-1)).toBe(
      '[windows] canvas renderer gone 4 times within 60 s; not rebuilding it again (the app keeps running without a canvas)',
    );

    // Nothing brings it back, not even a new placement.
    canvas.place(EXTERNAL);
    expect(FakeWindow.created).toHaveLength(1 + CANVAS_REBUILD_LIMIT);
  });

  it('counts only the rebuilds of the last 60 s', () => {
    const { canvas, win, flush, setTime } = setup();
    canvas.place(PRIMARY);

    for (const at of [0, 10_000, 20_000, 60_000, 70_000, 80_000, 120_000]) {
      setTime(at);
      win().crash();
      flush();
    }

    expect(FakeWindow.created).toHaveLength(8);
    expect(canvas.current()).toBe(win());
  });

  it('ignores a crash report from a window it already replaced', () => {
    const { canvas, win, flush } = setup();
    canvas.place(PRIMARY);
    const first = win();
    first.crash();
    flush();

    first.crash();
    flush();

    expect(FakeWindow.created).toHaveLength(2);
  });

  it('does not rebuild once stopped (app quitting)', () => {
    const { canvas, win, flush } = setup();
    canvas.place(PRIMARY);

    canvas.stop();
    win().crash();
    flush();

    expect(FakeWindow.created).toHaveLength(1);
    canvas.place(EXTERNAL);
    expect(FakeWindow.created).toHaveLength(1);
  });
});

describe('logCanvasReady', () => {
  it('logs 畫布就緒 with the renderer and the world size', () => {
    logCanvasReady({ ok: true, renderer: 'webgl', width: 1512, height: 982 });
    expect(lines(info)).toStrictEqual([
      '[windows] canvas ready (renderer webgl, 1512x982)',
    ]);
  });

  it('logs a failed initialisation as an error', () => {
    logCanvasReady({ ok: false, reason: 'Error: no WebGL' });
    expect(lines(error)).toStrictEqual([
      '[windows] canvas failed to initialise: Error: no WebGL',
    ]);
  });
});
