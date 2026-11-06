import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDockController,
  type DockApi,
} from '../../src/main/windows/dock';
import { DOCK_HIDE_MIN_INTERVAL_MS } from '../../src/shared/constants';

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake app.dock that records show/hide calls in order. */
function fakeDock() {
  const calls: string[] = [];
  const dock = {
    show: vi.fn(async () => {
      calls.push('show');
    }),
    hide: vi.fn(() => {
      calls.push('hide');
    }),
  } satisfies DockApi;
  return { dock, calls };
}

/** A manual clock and timer queue. */
function fakeClock(start = 100_000) {
  let now = start;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      timers.push({ at: now + ms, run });
    },
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) {
          timer.run();
        } else {
          timers.push(timer);
        }
      }
    },
  };
}

function controller(platform: NodeJS.Platform = 'darwin') {
  const { dock, calls } = fakeDock();
  const clock = fakeClock();
  const ctl = createDockController({
    platform,
    dock,
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return { ctl, dock, calls, clock };
}

const LONG_AFTER = DOCK_HIDE_MIN_INTERVAL_MS + 1;

describe('Dock on macOS', () => {
  it('hides the icon at startup', () => {
    const { ctl, calls } = controller();
    ctl.hideAtStartup();
    expect(calls).toStrictEqual(['hide']);
  });

  it('shows it when the first panel opens and hides it when the last closes', async () => {
    const { ctl, calls, clock } = controller();
    ctl.hideAtStartup();
    clock.advance(LONG_AFTER);

    ctl.panelOpened();
    expect(calls).toStrictEqual(['hide', 'show']);
    expect(ctl.openPanels()).toBe(1);

    ctl.panelOpened();
    expect(calls).toStrictEqual(['hide', 'show']);
    expect(ctl.openPanels()).toBe(2);

    clock.advance(LONG_AFTER);
    ctl.panelClosed();
    expect(calls).toStrictEqual(['hide', 'show']);
    ctl.panelClosed();
    expect(calls).toStrictEqual(['hide', 'show', 'hide']);
    expect(ctl.openPanels()).toBe(0);

    await Promise.resolve();
    const lines = info.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toStrictEqual([
      '[windows] dock icon hidden (startup)',
      '[windows] dock icon hidden (no panel open)',
      '[windows] dock icon shown',
    ]);
  });

  it('ignores a close with no panel open', () => {
    const { ctl, calls } = controller();
    ctl.panelClosed();
    expect(ctl.openPanels()).toBe(0);
    expect(calls).toStrictEqual([]);
  });

  it('defers a hide that comes within a second of the last Dock change', () => {
    const { ctl, calls, clock } = controller();
    ctl.panelOpened();
    clock.advance(200);
    ctl.panelClosed();
    expect(calls).toStrictEqual(['show']);
    expect(clock.pending()).toBe(1);

    clock.advance(DOCK_HIDE_MIN_INTERVAL_MS - 201);
    expect(calls).toStrictEqual(['show']);
    clock.advance(1);
    expect(calls).toStrictEqual(['show', 'hide']);
  });

  it('drops a deferred hide when a panel opens in the meantime', () => {
    const { ctl, calls, clock } = controller();
    ctl.panelOpened();
    ctl.panelClosed();
    clock.advance(100);
    ctl.panelOpened();
    clock.advance(LONG_AFTER);
    expect(calls).toStrictEqual(['show', 'show']);
    expect(ctl.openPanels()).toBe(1);
  });

  it('schedules one deferred hide however many closes come in', () => {
    const { ctl, calls, clock } = controller();
    ctl.panelOpened();
    ctl.panelClosed();
    ctl.panelOpened();
    ctl.panelClosed();
    expect(clock.pending()).toBe(1);
    clock.advance(LONG_AFTER);
    expect(calls).toStrictEqual(['show', 'show', 'hide']);
  });

  it('logs a show that fails', async () => {
    const ctl = createDockController({
      platform: 'darwin',
      dock: {
        show: () => Promise.reject(new TypeError('no dock')),
        hide: () => {},
      },
    });
    ctl.panelOpened();
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      '[windows] dock icon could not be shown (TypeError)',
    );
  });

  it('logs a show that throws at once, and keeps counting', () => {
    const ctl = createDockController({
      platform: 'darwin',
      dock: {
        show: () => {
          throw new RangeError('no dock');
        },
        hide: () => {},
      },
    });
    expect(() => {
      ctl.panelOpened();
    }).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      '[windows] dock icon could not be shown (RangeError)',
    );
    expect(ctl.openPanels()).toBe(1);
  });

  it('logs a hide that throws, and keeps counting', () => {
    const ctl = createDockController({
      platform: 'darwin',
      dock: {
        show: async () => {},
        hide: () => {
          throw new Error('boom');
        },
      },
    });
    ctl.hideAtStartup();
    expect(error).toHaveBeenCalledWith(
      '[windows] dock icon could not be hidden (Error)',
    );
    ctl.panelOpened();
    expect(ctl.openPanels()).toBe(1);
  });
});

describe.each([['win32'], ['linux']] as const)('Dock on %s', (platform) => {
  it('never touches the Dock, but still counts panels', () => {
    const { ctl, dock } = controller(platform);
    ctl.hideAtStartup();
    ctl.panelOpened();
    ctl.panelClosed();
    expect(dock.show).not.toHaveBeenCalled();
    expect(dock.hide).not.toHaveBeenCalled();
    expect(ctl.openPanels()).toBe(0);
  });
});

describe('Dock missing on macOS', () => {
  it('does nothing when app.dock is undefined', () => {
    const ctl = createDockController({ platform: 'darwin', dock: undefined });
    ctl.hideAtStartup();
    ctl.panelOpened();
    ctl.panelClosed();
    expect(ctl.openPanels()).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });
});
