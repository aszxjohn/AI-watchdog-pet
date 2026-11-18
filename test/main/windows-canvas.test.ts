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
  registerCanvasContextMenuHandler,
  registerCanvasGpuHandler,
  registerCanvasHoverHandler,
  registerCanvasReadyHandler,
  setClickThrough,
  type CanvasPlacement,
  type CanvasWindowHandle,
} from '../../src/main/windows/canvas-window';
import type { WindowsEnvironment } from '../../src/main/windows/environment';
import { secureWebPreferences } from '../../src/main/windows/security';
import {
  CANVAS_CONTEXT_RESTORE_MS,
  CANVAS_REBUILD_LIMIT,
  CANVAS_REBUILD_WINDOW_MS,
  CANVAS_UNRESPONSIVE_RELOAD_MS,
} from '../../src/shared/constants';
import type { SessionKey } from '../../src/shared/detection-events';
import {
  canvasContextMenu,
  canvasGpu,
  canvasReady,
  canvasSetHover,
  type CanvasReadyReport,
} from '../../src/shared/ipc';
import type { DisplayBounds } from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';
import { fakeClock, MONO_START } from '../helpers/fake-clock';

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
  /** The last webContents id handed out; each window gets the next. */
  static lastId = 100;
  readonly calls: string[] = [];
  readonly loaded: string[] = [];
  readonly ignoreMouse: unknown[][] = [];
  readonly bounds: DisplayBounds[] = [];
  destroyed = false;
  /** When set, getBounds answers this instead of what was asked for. */
  osBounds: DisplayBounds | undefined;
  /** When set, loadURL rejects the way Electron does for a failed load. */
  static rejectLoads = false;
  /** When set, webContents.reload() throws (after it is recorded). */
  failReload = false;
  /** When set, webContents.forcefullyCrashRenderer() throws. */
  failCrash = false;
  readonly windowListeners = new Map<string, (() => void)[]>();
  readonly contentsListeners = new Map<
    string,
    ((...args: never[]) => void)[]
  >();

  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeWindow.created.push(this);
    FakeWindow.lastId += 1;
    this.webContents.id = FakeWindow.lastId;
  }

  readonly webContents = {
    /** Settable, so a test can make it the fake IPC sender's. */
    id: 0,
    loadURL: (url: string) => {
      this.loaded.push(url);
      return FakeWindow.rejectLoads
        ? Promise.reject(new Error('ERR_FILE_NOT_FOUND (-6) loading url'))
        : Promise.resolve();
    },
    reload: () => {
      this.calls.push('reload');
      if (this.failReload) {
        throw Object.assign(new Error('reload failed'), { code: 'EFAKE' });
      }
    },
    forcefullyCrashRenderer: () => {
      this.calls.push('forcefullyCrashRenderer');
      if (this.failCrash) {
        throw Object.assign(new Error('crash failed'), { code: 'EFAKE' });
      }
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
  /** What a new page load (a reload) does once it commits. */
  navigate() {
    this.emitContents('did-navigate', {}, 'app://overlay/index.html', -1, '');
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
  const clock = fakeClock();
  const deferred: (() => void)[] = [];
  const canvas = createCanvasWindows({
    createWindow: (windowOptions) => new FakeWindow(windowOptions),
    preload: PRELOAD,
    env: options.env ?? PACKAGED,
    platform: options.platform ?? 'darwin',
    now: clock.monotonic,
    defer: (run) => {
      deferred.push(run);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    canvas,
    clock,
    win: () => FakeWindow.created.at(-1) as FakeWindow,
    /** Runs what the canvas deferred (the rebuild after a crash). */
    flush() {
      for (const run of deferred.splice(0)) {
        run();
      }
    },
    /** Moves the clock to `ms` after its start (never back), firing timers. */
    setTime(ms: number) {
      clock.advance(MONO_START + ms - clock.monotonic());
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
      `[windows] rebuilding the canvas window (recovery 1 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
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

describe('hover (AD-14): click-through follows the overlay', () => {
  const OFF = [false];
  const ON = [true, { forward: true }];

  /** A placed canvas on `platform` and its page's webContents id. */
  function placed(platform: NodeJS.Platform = 'darwin') {
    const context = setup({ platform });
    context.canvas.place(PRIMARY);
    return { ...context, id: context.win().webContents.id };
  }

  it.each([['darwin'], ['win32']] as const)(
    '%s 移到方塊上 / 移開: over turns click-through off, not over restores setClickThrough',
    (platform) => {
      const { canvas, win, id } = placed(platform);
      expect(win().ignoreMouse).toStrictEqual([ON]);

      canvas.setHover(id, { seq: 1, over: true });
      expect(win().ignoreMouse).toStrictEqual([ON, OFF]);

      canvas.setHover(id, { seq: 2, over: false });
      expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    },
  );

  it('is idempotent: a request that changes nothing does nothing', () => {
    const { canvas, win, id } = placed();

    canvas.setHover(id, { seq: 1, over: false });
    canvas.setHover(id, { seq: 2, over: true });
    canvas.setHover(id, { seq: 3, over: true });

    expect(win().ignoreMouse).toStrictEqual([ON, OFF]);
  });

  it('過時的請求: drops a seq not greater than the last one taken; click-through stays', () => {
    const { canvas, win, id } = placed();
    canvas.setHover(id, { seq: 2, over: true });

    canvas.setHover(id, { seq: 2, over: false });
    canvas.setHover(id, { seq: 1, over: false });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF]);

    canvas.setHover(id, { seq: 3, over: false });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
  });

  it('counts a dropped-as-unchanged request: a later, smaller seq is still stale', () => {
    const { canvas, win, id } = placed();
    canvas.setHover(id, { seq: 5, over: false });

    canvas.setHover(id, { seq: 4, over: true });

    expect(win().ignoreMouse).toStrictEqual([ON]);
  });

  it('畫布重載: a new page load restores click-through and counts seq from 0 again', () => {
    const { canvas, win, id } = placed();
    canvas.setHover(id, { seq: 7, over: true });

    win().navigate();

    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    canvas.setHover(id, { seq: 1, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON, OFF]);
  });

  it('a page load while not over changes nothing but still counts seq from 0', () => {
    const { canvas, win, id } = placed();
    canvas.setHover(id, { seq: 7, over: false });

    win().navigate();

    expect(win().ignoreMouse).toStrictEqual([ON]);
    canvas.setHover(id, { seq: 1, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF]);
  });

  it('畫布重建: a rebuilt window starts click-through with seq 0, and the old page is ignored', () => {
    const { canvas, win, flush, id } = placed();
    const first = win();
    canvas.setHover(id, { seq: 9, over: true });

    first.crash();
    flush();
    const second = win();
    expect(second).not.toBe(first);
    expect(second.ignoreMouse).toStrictEqual([ON]);

    canvas.setHover(id, { seq: 10, over: false });
    first.navigate();
    expect(second.ignoreMouse).toStrictEqual([ON]);

    canvas.setHover(second.webContents.id, { seq: 1, over: true });
    expect(second.ignoreMouse).toStrictEqual([ON, OFF]);
  });

  it("drops a request from any page but the live canvas window's", () => {
    const { canvas, win, id } = placed();

    canvas.setHover(id + 1, { seq: 1, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON]);

    win().destroy();
    canvas.setHover(id, { seq: 2, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON]);
  });

  it.each([['linux'], ['freebsd']] as const)(
    '%s never toggles: the whole window stays click-through',
    (platform) => {
      const { canvas, win, id } = placed(platform);

      canvas.setHover(id, { seq: 1, over: true });
      canvas.setHover(id, { seq: 2, over: false });
      win().navigate();
      win().emit('unresponsive');

      expect(win().ignoreMouse).toStrictEqual([[true]]);
    },
  );

  it('a page that stops responding while over gets click-through back, logged; seq is kept', () => {
    const { canvas, win, id } = placed('win32');
    canvas.setHover(id, { seq: 3, over: true });

    win().emit('unresponsive');

    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    expect(lines(warn)).toStrictEqual([
      '[windows] canvas page stopped responding while it took the mouse; click-through is back on',
    ]);
    // seq kept: an old request is still stale, the page's next one counts.
    canvas.setHover(id, { seq: 3, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    canvas.setHover(id, { seq: 4, over: false });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    canvas.setHover(id, { seq: 5, over: true });
    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON, OFF]);
  });

  it('a page that stops responding while not over changes nothing', () => {
    const { canvas, win, id } = placed();
    canvas.setHover(id, { seq: 1, over: true });
    canvas.setHover(id, { seq: 2, over: false });

    win().emit('unresponsive');

    expect(win().ignoreMouse).toStrictEqual([ON, OFF, ON]);
    expect(lines(warn)).toStrictEqual([]);
  });

  it('a replaced window going unresponsive does not touch the new one', () => {
    const { canvas, win, flush, id } = placed();
    const first = win();
    canvas.setHover(id, { seq: 1, over: true });
    first.crash();
    flush();
    const second = win();
    canvas.setHover(second.webContents.id, { seq: 1, over: true });

    first.emit('unresponsive');

    expect(second.ignoreMouse).toStrictEqual([ON, OFF]);
  });

  it('windowOf: the live canvas window for its page, nothing for another page or once closed', () => {
    const { canvas, win, id } = placed();

    expect(canvas.windowOf(id)).toBe(win());
    expect(canvas.windowOf(id + 1)).toBeUndefined();

    win().destroy();
    expect(canvas.windowOf(id)).toBeUndefined();
  });
});

describe('canvas:set-hover and canvas:context-menu handlers', () => {
  const OVERLAY_URL = 'app://overlay/index.html';

  beforeEach(() => {
    fake.resetFakeElectron();
    fake.sender.mainFrame.url = OVERLAY_URL;
  });

  /** A placed canvas whose page is the fake IPC sender, both handlers registered. */
  function wired() {
    const context = setup();
    context.canvas.place(PRIMARY);
    context.win().webContents.id = fake.sender.id;
    const open = vi.fn<(sessionKey: SessionKey, win: FakeWindow) => void>();
    registerCanvasHoverHandler(context.canvas);
    registerCanvasContextMenuHandler(context.canvas, open);
    return { ...context, open };
  }

  it('移到方塊上 / 移開 through IPC: each request answers null and toggles click-through', async () => {
    const { win } = wired();

    expect(
      await fake.ipcRenderer.invoke(canvasSetHover.channel, {
        seq: 1,
        over: true,
      }),
    ).toStrictEqual({ ok: true, data: null });
    expect(win().ignoreMouse.at(-1)).toStrictEqual([false]);

    await fake.ipcRenderer.invoke(canvasSetHover.channel, {
      seq: 2,
      over: false,
    });
    expect(win().ignoreMouse.at(-1)).toStrictEqual([true, { forward: true }]);
  });

  it.each([
    ['seq 0', [{ seq: 0, over: true }]],
    ['a negative seq', [{ seq: -1, over: true }]],
    ['a fractional seq', [{ seq: 1.5, over: true }]],
    ['no over', [{ seq: 1 }]],
    ['over as a string', [{ seq: 1, over: 'true' }]],
    ['an extra key', [{ seq: 1, over: true, x: 3 }]],
    [
      'two requests',
      [
        { seq: 1, over: true },
        { seq: 2, over: false },
      ],
    ],
    ['no request', []],
  ])(
    '壞請求 (%s): rejected by the registration function, click-through unchanged',
    async (_label, args) => {
      const { win } = wired();

      const reply = await fake.ipcRenderer.invoke(
        canvasSetHover.channel,
        ...args,
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(win().ignoreMouse).toStrictEqual([[true, { forward: true }]]);
    },
  );

  it('only the overlay may send a hover: the panels get sender-rejected', async () => {
    const { win } = wired();
    fake.sender.mainFrame.url = 'app://panels/index.html';

    const reply = await fake.ipcRenderer.invoke(canvasSetHover.channel, {
      seq: 1,
      over: true,
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(win().ignoreMouse).toStrictEqual([[true, { forward: true }]]);
  });

  it('右鍵: a right-click on the canvas goes to open with its session key and the canvas window', async () => {
    const { win, open } = wired();

    const reply = await fake.ipcRenderer.invoke(canvasContextMenu.channel, {
      sessionKey: 'demo:1',
    });

    expect(reply).toStrictEqual({ ok: true, data: null });
    expect(open.mock.calls).toStrictEqual([['demo:1', win()]]);
  });

  it('drops a right-click from a page that is not the live canvas window', async () => {
    const { win, open } = wired();
    win().webContents.id = fake.sender.id + 1;

    const reply = await fake.ipcRenderer.invoke(canvasContextMenu.channel, {
      sessionKey: 'demo:1',
    });

    expect(reply).toStrictEqual({ ok: true, data: null });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['not a session key', [{ sessionKey: 'nope' }]],
    ['an unknown source', [{ sessionKey: 'vim:1' }]],
    ['an empty native id', [{ sessionKey: 'demo:' }]],
    ['a control character', [{ sessionKey: 'demo:\u0007' }]],
    ['an extra key', [{ sessionKey: 'demo:1', state: 'error' }]],
    ['a bare string', ['demo:1']],
    ['no request', []],
  ])(
    '壞請求 (%s): rejected by the registration function, no menu',
    async (_label, args) => {
      const { open } = wired();

      const reply = await fake.ipcRenderer.invoke(
        canvasContextMenu.channel,
        ...args,
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('only the overlay may ask for a menu: the panels get sender-rejected', async () => {
    const { open } = wired();
    fake.sender.mainFrame.url = 'app://panels/index.html';

    const reply = await fake.ipcRenderer.invoke(canvasContextMenu.channel, {
      sessionKey: 'demo:1',
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('I/O matrix', () => {
  const ON = [true, { forward: true }];
  const LOST_LINE =
    '[windows] canvas WebGL context lost; nothing is drawn until it is restored';
  const RELOAD_LINE = `[windows] reloading the canvas page: its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s`;
  const NEW_RENDERER_LINE = `[windows] reloading the canvas page in a new renderer: it still did not respond ${CANVAS_UNRESPONSIVE_RELOAD_MS / 1000} s after Chromium found it unresponsive`;

  /** A placed canvas on `platform`, shown, and its page's webContents id. */
  function placed(platform: NodeJS.Platform = 'darwin') {
    const context = setup({ platform });
    context.canvas.place(PRIMARY);
    context.win().emit('ready-to-show');
    return { ...context, id: context.win().webContents.id };
  }

  /** How many times `win` was asked for `call`. */
  function count(win: FakeWindow, call: string): number {
    return win.calls.filter((each) => each === call).length;
  }

  it('context lost 後還原: lost is one warning; restored in time is one line with how long it took, and nothing is reloaded', () => {
    const { canvas, win, id, setTime, clock } = placed();
    setTime(1_000);

    canvas.gpu(id, 'context-lost');
    expect(lines(warn)).toStrictEqual([LOST_LINE]);

    setTime(1_000 + CANVAS_CONTEXT_RESTORE_MS - 1_500);
    canvas.gpu(id, 'context-restored');
    expect(lines(info)).toContain(
      `[windows] canvas WebGL context restored after ${((CANVAS_CONTEXT_RESTORE_MS - 1_500) / 1000).toFixed(1)} s`,
    );

    clock.advance(10 * CANVAS_CONTEXT_RESTORE_MS);
    expect(count(win(), 'reload')).toBe(0);
    expect(FakeWindow.created).toHaveLength(1);
    expect(clock.pendingCount()).toBe(0);
    expect(lines(error)).toStrictEqual([]);
  });

  it('context lost 後還原: a later loss on the same page is a new one, with its own line and its own wait', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');
    canvas.gpu(id, 'context-restored');

    clock.advance(30_000);
    canvas.gpu(id, 'context-lost');
    expect(lines(warn)).toStrictEqual([LOST_LINE, LOST_LINE]);

    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    expect(count(win(), 'reload')).toBe(1);
  });

  it('context 沒還原: not restored within CANVAS_CONTEXT_RESTORE_MS, the page of the same window is reloaded, logged with the count', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');

    clock.advance(CANVAS_CONTEXT_RESTORE_MS - 1);
    expect(count(win(), 'reload')).toBe(0);

    clock.advance(1);
    expect(count(win(), 'reload')).toBe(1);
    expect(win().calls).not.toContain('forcefullyCrashRenderer');
    expect(FakeWindow.created).toHaveLength(1);
    expect(canvas.current()).toBe(win());
    expect(lines(warn)).toStrictEqual([
      LOST_LINE,
      `${RELOAD_LINE} (recovery 1 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
    ]);
    expect(lines(error)).toStrictEqual([]);
  });

  it('context 沒還原: the reloaded page starts over: a restored from it is not the old loss, and nothing more is reloaded', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');
    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    win().navigate();

    canvas.gpu(id, 'context-restored');
    clock.advance(60_000);

    expect(count(win(), 'reload')).toBe(1);
    expect(lines(info).filter((line) => line.includes('restored'))).toEqual([]);
  });

  it('context 沒還原: a new page load before the wait is over ends the wait; nothing is reloaded', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');

    clock.advance(CANVAS_CONTEXT_RESTORE_MS - 1_000);
    win().navigate();
    clock.advance(60_000);

    expect(count(win(), 'reload')).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it('context 沒還原: a window rebuilt meanwhile is not reloaded for its old page', () => {
    const { canvas, win, id, clock, flush } = placed();
    const first = win();
    canvas.gpu(id, 'context-lost');
    first.crash();
    flush();
    const second = win();

    clock.advance(60_000);

    expect(second).not.toBe(first);
    expect(count(first, 'reload')).toBe(0);
    expect(count(second, 'reload')).toBe(0);
  });

  it('重複事件: the same page saying lost twice is one line, and the wait is not restarted', () => {
    const { canvas, win, id, setTime } = placed();
    canvas.gpu(id, 'context-lost');
    setTime(CANVAS_CONTEXT_RESTORE_MS - 1_000);
    canvas.gpu(id, 'context-lost');

    expect(lines(warn)).toStrictEqual([LOST_LINE]);
    setTime(CANVAS_CONTEXT_RESTORE_MS);
    expect(count(win(), 'reload')).toBe(1);
  });

  it('重複事件: restored with nothing lost, or twice, is logged once at most and changes nothing', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-restored');
    expect(lines(info).filter((line) => line.includes('restored'))).toEqual([]);

    canvas.gpu(id, 'context-lost');
    canvas.gpu(id, 'context-restored');
    canvas.gpu(id, 'context-restored');
    clock.advance(60_000);

    expect(lines(info).filter((line) => line.includes('restored'))).toEqual([
      '[windows] canvas WebGL context restored after 0.0 s',
    ]);
    expect(count(win(), 'reload')).toBe(0);
  });

  it('重複事件: unresponsive twice does not restart the wait', () => {
    const { win, setTime } = placed();
    win().emit('unresponsive');
    setTime(CANVAS_UNRESPONSIVE_RELOAD_MS - 1_000);
    win().emit('unresponsive');

    setTime(CANVAS_UNRESPONSIVE_RELOAD_MS);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
  });

  it('無回應後恢復: click-through comes back at once; responsive in time is one line, and nothing is reloaded', () => {
    const { canvas, win, id, setTime, clock } = placed('win32');
    canvas.setHover(id, { seq: 1, over: true });

    win().emit('unresponsive');
    expect(win().ignoreMouse.at(-1)).toStrictEqual(ON);

    setTime(4_000);
    win().emit('responsive');
    expect(lines(info)).toContain(
      '[windows] canvas page responding again after 4.0 s; not reloading it',
    );

    clock.advance(60_000);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(0);
    expect(count(win(), 'reload')).toBe(0);
    expect(FakeWindow.created).toHaveLength(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it('無回應後恢復: responsive with nothing unresponsive logs nothing', () => {
    const { win } = placed();
    win().emit('responsive');
    expect(
      lines(info).filter((line) => line.includes('responding again')),
    ).toEqual([]);
  });

  it('一直無回應: still unresponsive after CANVAS_UNRESPONSIVE_RELOAD_MS, its renderer is stopped and, once gone, the page of the same window reloaded; logged', () => {
    const { win, clock, flush } = placed();
    win().emit('unresponsive');

    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS - 1);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(0);

    clock.advance(1);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
    expect(count(win(), 'reload')).toBe(0);
    expect(lines(warn)).toStrictEqual([
      `${NEW_RENDERER_LINE} (recovery 1 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
    ]);

    // The renderer it stopped goes away: not a crash to rebuild for.
    win().crash('killed', 9);
    expect(lines(info)).toContain(
      '[windows] canvas renderer stopped (killed, exit code 9); reloading its page',
    );
    flush();

    expect(win().calls).toStrictEqual([
      'showInactive',
      'forcefullyCrashRenderer',
      'reload',
    ]);
    expect(FakeWindow.created).toHaveLength(1);
    expect(lines(error)).toStrictEqual([]);
    expect(
      lines(info).filter((line) => line.includes('rebuilding')),
    ).toStrictEqual([]);
  });

  it('一直無回應: a crash after that reload is a crash again: the window is rebuilt', () => {
    const { win, clock, flush } = placed();
    const first = win();
    first.emit('unresponsive');
    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
    first.crash('killed', 9);
    flush();
    first.navigate();

    first.crash('crashed', 11);
    flush();

    expect(FakeWindow.created).toHaveLength(2);
    expect(lines(error)).toContain(
      '[windows] canvas renderer gone (crashed, exit code 11)',
    );
    expect(lines(info)).toContain(
      `[windows] rebuilding the canvas window (recovery 2 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
    );
  });

  it('一直無回應: a page that already took the mouse gets click-through back at once and is reloaded later', () => {
    const { canvas, win, id, clock } = placed();
    canvas.setHover(id, { seq: 1, over: true });

    win().emit('unresponsive');
    expect(win().ignoreMouse.at(-1)).toStrictEqual(ON);

    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
  });

  it('次數上限: rebuilds and reloads count together; the 4th within 60 s is not done, is one error line, and nothing is handled after', () => {
    const { canvas, win, id, clock, flush, setTime } = placed();
    // 1: a reload, the context not restored (at 5 s).
    canvas.gpu(id, 'context-lost');
    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    win().navigate();
    // 2: a rebuild, the renderer gone (at 10 s).
    setTime(10_000);
    win().crash();
    flush();
    win().emit('ready-to-show');
    // 3: a reload in a new renderer, not responding (at 30 s).
    setTime(20_000);
    win().emit('unresponsive');
    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
    win().crash('killed', 9);
    flush();
    win().navigate();
    expect(count(win(), 'reload')).toBe(1);

    // 4: the context lost again, not restored (at 45 s): not reloaded.
    setTime(40_000);
    canvas.gpu(win().webContents.id, 'context-lost');
    clock.advance(CANVAS_CONTEXT_RESTORE_MS);

    expect(count(win(), 'reload')).toBe(1);
    expect(lines(error).at(-1)).toBe(
      `[windows] canvas needed a rebuild or reload 4 times within 60 s, the last because its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s; not rebuilding or reloading it again (the app keeps running with the canvas as it is)`,
    );
    const errors = lines(error).length;

    // Nothing after: no reload, no rebuild, no move, no other line.
    win().emit('unresponsive');
    clock.advance(60_000);
    win().crash();
    flush();
    canvas.place(EXTERNAL);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
    expect(FakeWindow.created).toHaveLength(2);
    expect(win().bounds).toStrictEqual([]);
    expect(lines(error)).toHaveLength(errors + 1);
    expect(lines(error).at(-1)).toBe(
      '[windows] canvas renderer gone (crashed, exit code 11)',
    );
  });

  it('次數上限: a renderer gone as the 4th after reloads says so, and the app keeps running without a canvas', () => {
    const { canvas, win, id, clock, flush, setTime } = placed();
    for (const at of [0, 10_000, 20_000]) {
      setTime(at);
      canvas.gpu(id, 'context-lost');
      clock.advance(CANVAS_CONTEXT_RESTORE_MS);
      win().navigate();
    }
    expect(count(win(), 'reload')).toBe(3);

    setTime(59_000);
    win().crash();
    flush();

    expect(FakeWindow.created).toHaveLength(1);
    expect(canvas.current()).toBeUndefined();
    expect(lines(error).at(-1)).toBe(
      '[windows] canvas needed a rebuild or reload 4 times within 60 s, the last because its renderer went away; not rebuilding or reloading it again (the app keeps running without a canvas)',
    );
  });

  it('次數上限: only the last 60 s count, reloads too', () => {
    const { canvas, win, id, clock, setTime } = placed();
    for (const at of [0, 10_000, 20_000, 70_000]) {
      setTime(at);
      canvas.gpu(id, 'context-lost');
      clock.advance(CANVAS_CONTEXT_RESTORE_MS);
      win().navigate();
    }

    expect(count(win(), 'reload')).toBe(4);
    expect(lines(warn)).toContain(
      `${RELOAD_LINE} (recovery 3 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
    );
    expect(lines(error)).toStrictEqual([]);
  });

  it('壞輸入: a report from a page that is not the live canvas window changes nothing', () => {
    const { canvas, win, id, clock } = placed();

    canvas.gpu(id + 1, 'context-lost');
    win().destroy();
    canvas.gpu(id, 'context-lost');
    clock.advance(60_000);

    expect(lines(warn)).toStrictEqual([]);
    expect(count(win(), 'reload')).toBe(0);
  });

  const READY: CanvasReadyReport = {
    ok: true,
    renderer: 'webgl',
    width: 1512,
    height: 982,
  };
  const FAILED: CanvasReadyReport = { ok: false, reason: 'Error: no WebGL' };
  const NOT_INITIALISED = `[windows] reloading the canvas page: its canvas did not initialise after a recovery (canvas:ready)`;
  const RECOVERY = (n: number) =>
    `(recovery ${n} of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`;

  it('context 沒還原: the reloaded page reporting that its canvas did not initialise is reloaded again, as one more recovery; once one initialised, a failure is not', () => {
    const { canvas, win, id, clock, flush } = placed();
    canvas.gpu(id, 'context-lost');
    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    win().navigate();

    canvas.ready(id, FAILED);
    // Answered first: the reload comes outside the call.
    expect(count(win(), 'reload')).toBe(1);
    flush();
    expect(count(win(), 'reload')).toBe(2);
    expect(lines(warn)).toContain(`${NOT_INITIALISED} ${RECOVERY(2)}`);

    win().navigate();
    canvas.ready(id, READY);
    canvas.ready(id, FAILED);
    flush();
    expect(count(win(), 'reload')).toBe(2);
  });

  it('context 沒還原: a rebuilt window whose canvas did not initialise has its page reloaded, as one more recovery', () => {
    const { canvas, win, flush } = placed();
    win().crash();
    flush();
    const second = win();
    second.emit('ready-to-show');

    canvas.ready(second.webContents.id, FAILED);
    flush();

    expect(count(second, 'reload')).toBe(1);
    expect(lines(warn)).toContain(`${NOT_INITIALISED} ${RECOVERY(2)}`);
  });

  it('context 沒還原: the first page failing to initialise (no recovery before it) is only logged, as before', () => {
    const { canvas, win, id, flush } = placed();

    canvas.ready(id, FAILED);
    flush();

    expect(count(win(), 'reload')).toBe(0);
    expect(FakeWindow.created).toHaveLength(1);
  });

  it('次數上限: a canvas that keeps failing to initialise after recoveries is reloaded within the limit, then left, with one error line', () => {
    const { canvas, win, id, clock, flush } = placed();
    canvas.gpu(id, 'context-lost');
    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      win().navigate();
      canvas.ready(id, FAILED);
      flush();
    }

    expect(count(win(), 'reload')).toBe(CANVAS_REBUILD_LIMIT);
    expect(lines(error)).toStrictEqual([
      `[windows] canvas needed a rebuild or reload 4 times within 60 s, the last because its canvas did not initialise after a recovery (canvas:ready); not rebuilding or reloading it again (the app keeps running with the canvas as it is)`,
    ]);
  });

  it('次數上限: once the limit is reached, a new lost context or unresponsive page logs nothing and starts no wait', () => {
    const { canvas, win, id, clock } = placed();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      canvas.gpu(id, 'context-lost');
      clock.advance(CANVAS_CONTEXT_RESTORE_MS);
      win().navigate();
    }
    expect(lines(error)).toHaveLength(1);
    const warnings = lines(warn).length;

    canvas.gpu(id, 'context-lost');
    win().emit('unresponsive');

    expect(lines(warn)).toHaveLength(warnings);
    expect(clock.pendingCount()).toBe(0);
  });

  it('context 沒還原: not restored while the page is also unresponsive, it is reloaded in a new renderer, as one recovery', () => {
    const { canvas, win, id, clock, flush } = placed();
    canvas.gpu(id, 'context-lost');
    win().emit('unresponsive');

    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
    expect(count(win(), 'reload')).toBe(0);
    expect(lines(warn)).toStrictEqual([
      LOST_LINE,
      `[windows] reloading the canvas page in a new renderer: its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s ${RECOVERY(1)}`,
    ]);

    // The other wait is over too: one recovery, not two.
    clock.advance(60_000);
    win().crash('killed', 9);
    flush();
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(1);
    expect(count(win(), 'reload')).toBe(1);
    expect(
      lines(warn).filter((line) => line.includes('reloading the canvas page')),
    ).toHaveLength(1);
  });

  it('context 沒還原: the window closed while its context is lost (and it is unresponsive) leaves no wait behind', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');
    win().emit('unresponsive');

    win().destroy();

    expect(clock.pendingCount()).toBe(0);
  });

  it('一直無回應: the window closed while it is unresponsive leaves no wait behind', () => {
    const { win, clock } = placed();
    win().emit('unresponsive');

    win().destroy();

    expect(clock.pendingCount()).toBe(0);
  });

  it('一直無回應: stopping its renderer throws: logged, and the window is rebuilt instead, within the limit; a later crash is a crash again', () => {
    const { win, clock, flush } = placed();
    const first = win();
    first.failCrash = true;
    first.emit('unresponsive');

    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
    expect(lines(error)).toContain(
      '[windows] stopping the renderer of the canvas page failed: EFAKE',
    );
    expect(lines(warn)).toContain(
      '[windows] the canvas page could not be reloaded; rebuilding the window instead',
    );
    flush();

    expect(first.calls).toContain('destroy');
    expect(FakeWindow.created).toHaveLength(2);
    expect(lines(info)).toContain(
      `[windows] rebuilding the canvas window ${RECOVERY(2)}`,
    );
    win().crash();
    flush();
    expect(FakeWindow.created).toHaveLength(3);
  });

  it('一直無回應: the reload after its stopped renderer is gone throws: logged, and the window is rebuilt instead', () => {
    const { win, clock, flush } = placed();
    const first = win();
    first.failReload = true;
    first.emit('unresponsive');
    clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
    first.crash('killed', 9);

    flush();
    expect(lines(error)).toContain(
      '[windows] reloading the canvas page failed: EFAKE',
    );
    flush();

    expect(first.calls).toContain('destroy');
    expect(FakeWindow.created).toHaveLength(2);
  });

  it('context 沒還原: the reload throws: logged, and the window is rebuilt instead, with no wait left behind', () => {
    const { canvas, win, id, clock, flush } = placed();
    const first = win();
    first.failReload = true;
    canvas.gpu(id, 'context-lost');

    clock.advance(CANVAS_CONTEXT_RESTORE_MS);
    expect(lines(error)).toContain(
      '[windows] reloading the canvas page failed: EFAKE',
    );
    flush();

    expect(first.calls).toContain('destroy');
    expect(FakeWindow.created).toHaveLength(2);
    expect(canvas.current()).toBe(win());
    expect(clock.pendingCount()).toBe(0);
  });

  it('macOS 隱藏: accepted, the canvas window has no hiding handling: it hears only ready-to-show, closed, unresponsive and responsive', () => {
    const { win } = placed();
    expect([...win().windowListeners.keys()].sort()).toStrictEqual([
      'closed',
      'ready-to-show',
      'responsive',
      'unresponsive',
    ]);
  });

  it.each([['win32'], ['linux']] as const)(
    'Windows: the WebGL context and responsiveness are handled the same on %s',
    (platform) => {
      const { canvas, win, id, clock, flush } = placed(platform);
      canvas.gpu(id, 'context-lost');
      clock.advance(CANVAS_CONTEXT_RESTORE_MS);
      win().navigate();
      win().emit('unresponsive');
      clock.advance(CANVAS_UNRESPONSIVE_RELOAD_MS);
      win().crash('killed', 1);
      flush();

      expect(win().calls).toStrictEqual([
        'showInactive',
        'reload',
        'forcefullyCrashRenderer',
        'reload',
      ]);
    },
  );

  describe('canvas:ready', () => {
    beforeEach(() => {
      fake.resetFakeElectron();
      fake.sender.mainFrame.url = 'app://overlay/index.html';
    });

    it('context 沒還原: a failure from the reloaded page is logged, answered null and reaches the canvas with the sending page, which reloads it again', async () => {
      const context = placed();
      context.win().webContents.id = fake.sender.id;
      registerCanvasReadyHandler(context.canvas);
      context.canvas.gpu(fake.sender.id, 'context-lost');
      context.clock.advance(CANVAS_CONTEXT_RESTORE_MS);
      context.win().navigate();

      const reply = await fake.ipcRenderer.invoke(canvasReady.channel, {
        ok: false,
        reason: 'Error: no WebGL',
      });
      context.flush();

      expect(reply).toStrictEqual({ ok: true, data: null });
      expect(lines(error)).toContain(
        '[windows] canvas failed to initialise: Error: no WebGL',
      );
      expect(count(context.win(), 'reload')).toBe(2);
    });
  });

  describe('canvas:gpu', () => {
    const OVERLAY_URL = 'app://overlay/index.html';

    beforeEach(() => {
      fake.resetFakeElectron();
      fake.sender.mainFrame.url = OVERLAY_URL;
    });

    /** A placed canvas whose page is the fake IPC sender, the handler registered. */
    function wired() {
      const context = placed();
      context.win().webContents.id = fake.sender.id;
      registerCanvasGpuHandler(context.canvas);
      return context;
    }

    it('context lost 後還原: each report answers null and reaches the canvas with the sending page', async () => {
      wired();

      expect(
        await fake.ipcRenderer.invoke(canvasGpu.channel, 'context-lost'),
      ).toStrictEqual({ ok: true, data: null });
      expect(
        await fake.ipcRenderer.invoke(canvasGpu.channel, 'context-restored'),
      ).toStrictEqual({ ok: true, data: null });

      expect(lines(warn)).toStrictEqual([LOST_LINE]);
      expect(lines(info)).toContain(
        '[windows] canvas WebGL context restored after 0.0 s',
      );
    });

    it.each([
      ['no state', []],
      ['an unknown state', ['lost']],
      ['two states', ['context-lost', 'context-restored']],
      ['an object', [{ state: 'context-lost' }]],
      ['null', [null]],
    ])(
      '壞輸入 (%s): invalid-input, and nothing is lost or reloaded',
      async (_label, args) => {
        const { win, clock } = wired();

        const reply = await fake.ipcRenderer.invoke(canvasGpu.channel, ...args);
        clock.advance(60_000);

        expect(reply).toMatchObject({
          ok: false,
          error: { code: 'invalid-input' },
        });
        expect(lines(warn)).not.toContain(LOST_LINE);
        expect(count(win(), 'reload')).toBe(0);
      },
    );

    it('壞輸入: the panels calling it are sender-rejected, and nothing is lost or reloaded', async () => {
      const { win, clock } = wired();
      fake.sender.mainFrame.url = 'app://panels/index.html';

      const reply = await fake.ipcRenderer.invoke(
        canvasGpu.channel,
        'context-lost',
      );
      clock.advance(60_000);

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(lines(warn)).not.toContain(LOST_LINE);
      expect(count(win(), 'reload')).toBe(0);
    });
  });
});

describe('waits for a reload', () => {
  /** A placed canvas, shown, and its page's webContents id. */
  function placed() {
    const context = setup();
    context.canvas.place(PRIMARY);
    context.win().emit('ready-to-show');
    return { ...context, id: context.win().webContents.id };
  }

  /** How many times `win` was asked for `call`. */
  function count(win: FakeWindow, call: string): number {
    return win.calls.filter((each) => each === call).length;
  }

  it('once the app is quitting (stop), a new lost context or unresponsive page logs nothing and starts no wait', () => {
    const { canvas, win, id, clock } = placed();
    canvas.stop();

    canvas.gpu(id, 'context-lost');
    win().emit('unresponsive');

    expect(lines(warn)).toStrictEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('once the app is quitting (stop), no wait reloads anything', () => {
    const { canvas, win, id, clock } = placed();
    canvas.gpu(id, 'context-lost');
    win().emit('unresponsive');

    canvas.stop();
    clock.advance(60_000);

    expect(clock.pendingCount()).toBe(0);
    expect(count(win(), 'reload')).toBe(0);
    expect(count(win(), 'forcefullyCrashRenderer')).toBe(0);
  });
});
