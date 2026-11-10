import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasPlacement } from '../../src/main/windows/canvas-window';
import type { ScreenDisplay } from '../../src/main/windows/displays';
import {
  createWindowsStageSource,
  initialWindowsSections,
  watchDisplays,
  type ScreenEvent,
} from '../../src/main/windows/stage-sources';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
} from '../../src/shared/settings';
import { stageViewSchema } from '../../src/shared/stage-view';

vi.mock('electron', () => import('../helpers/fake-electron'));

const BUILT_IN: ScreenDisplay = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
};
const EXTERNAL: ScreenDisplay = {
  id: 69733632,
  label: 'DELL U2720Q',
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
};
const ON_BUILT_IN: CanvasPlacement = {
  displayId: 1,
  bounds: BUILT_IN.bounds,
  scaleFactor: 2,
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

describe('createWindowsStageSource', () => {
  it('starts with no displays, no canvas, neither suspended nor locked', () => {
    const source = createWindowsStageSource();

    expect(source.get()).toStrictEqual({
      displays: [],
      canvas: null,
      power: { suspended: false, locked: false },
    });
    expect(source.get()).toStrictEqual(initialWindowsSections());
    expect(
      stageViewSchema.safeParse({
        settings: {
          rev: 0,
          values: { ...SETTINGS_DEFAULTS, canvasDisplayId: null },
        },
        ...source.get(),
        sessions: [],
        adapters: [],
      }).success,
    ).toBe(true);
  });

  it('reports only the sections that changed, in one call', () => {
    const source = createWindowsStageSource();
    const listener = vi.fn();
    source.onChange(listener);

    source.update({
      displays: [],
      canvas: ON_BUILT_IN,
      power: { suspended: false, locked: false },
    });

    expect(listener.mock.calls).toStrictEqual([[{ canvas: ON_BUILT_IN }]]);
    expect(source.get().canvas).toStrictEqual(ON_BUILT_IN);
  });

  it('reports nothing when nothing changed, compared by value', () => {
    const source = createWindowsStageSource();
    source.update({ canvas: ON_BUILT_IN });
    const listener = vi.fn();
    source.onChange(listener);

    source.update({
      canvas: { ...ON_BUILT_IN, bounds: { ...BUILT_IN.bounds } },
    });
    source.update({});

    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a canvas that goes back to null, and ignores undefined', () => {
    const source = createWindowsStageSource();
    source.update({ canvas: ON_BUILT_IN });
    const listener = vi.fn();
    source.onChange(listener);

    source.update({ canvas: undefined });
    source.update({ canvas: null });

    expect(listener.mock.calls).toStrictEqual([[{ canvas: null }]]);
  });

  it('stops reporting to a listener that unsubscribed', () => {
    const source = createWindowsStageSource();
    const listener = vi.fn();
    const unsubscribe = source.onChange(listener);

    unsubscribe();
    source.update({ power: { suspended: true, locked: false } });

    expect(listener).not.toHaveBeenCalled();
  });
});

/** A fake `screen` whose displays the test changes. */
function fakeScreen(initial: ScreenDisplay[], primaryId = 1) {
  const listeners = new Map<ScreenEvent, (() => void)[]>();
  const screen = {
    displays: initial,
    primaryId,
    getAllDisplays: () => screen.displays,
    getPrimaryDisplay: () => ({ id: screen.primaryId }),
    on(event: ScreenEvent, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: ScreenEvent) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    events: () => [...listeners.keys()],
  };
  return screen;
}

/** A fake settings store; only canvasDisplayId changes. */
function fakeSettings(canvasDisplayId: number | null = null) {
  let state: SettingsState = {
    rev: 0,
    values: { ...SETTINGS_DEFAULTS, canvasDisplayId },
  };
  const listeners: ((state: SettingsState) => void)[] = [];
  return {
    get: () => state,
    onChange(listener: (state: SettingsState) => void) {
      listeners.push(listener);
      return () => {};
    },
    set(value: number | null) {
      state = {
        rev: state.rev + 1,
        values: { ...SETTINGS_DEFAULTS, canvasDisplayId: value },
      };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function setup(
  displays: ScreenDisplay[] = [BUILT_IN],
  canvasDisplayId: number | null = null,
) {
  const screen = fakeScreen(displays);
  const settings = fakeSettings(canvasDisplayId);
  const source = createWindowsStageSource();
  const changes = vi.fn();
  source.onChange(changes);
  const canvas = { place: vi.fn<(placement: CanvasPlacement) => void>() };
  watchDisplays({ screen, settings, source, canvas });
  return { screen, settings, source, changes, canvas };
}

describe('watchDisplays', () => {
  it('starts: lists the displays and puts the canvas on the primary display, in one change', () => {
    const { screen, source, changes, canvas } = setup([BUILT_IN, EXTERNAL]);

    expect(source.get().displays).toStrictEqual([
      { ...BUILT_IN, primary: true },
      { ...EXTERNAL, primary: false },
    ]);
    expect(source.get().canvas).toStrictEqual(ON_BUILT_IN);
    expect(changes).toHaveBeenCalledOnce();
    expect(Object.keys(changes.mock.calls[0]?.[0] ?? {})).toStrictEqual([
      'displays',
      'canvas',
    ]);
    expect(canvas.place.mock.calls).toStrictEqual([[ON_BUILT_IN]]);
    expect(screen.events().sort()).toStrictEqual([
      'display-added',
      'display-metrics-changed',
      'display-removed',
    ]);
    expect(lines(info)).toStrictEqual([
      '[windows] displays: 2 connected (ids 1, 69733632; primary 1)',
      '[windows] canvas on display 1, 1512x982 at 0,0, scale 2',
    ]);
  });

  it('moves the canvas when the settings choose another display', () => {
    const { settings, source, canvas } = setup([BUILT_IN, EXTERNAL]);

    settings.set(EXTERNAL.id);

    const placement = {
      displayId: EXTERNAL.id,
      bounds: EXTERNAL.bounds,
      scaleFactor: 1.5,
      fallback: false,
    };
    expect(source.get().canvas).toStrictEqual(placement);
    expect(canvas.place.mock.calls.at(-1)).toStrictEqual([placement]);
  });

  it('falls back to the primary display when the chosen one is unplugged, and moves back when it returns', () => {
    const { screen, settings, source, canvas } = setup(
      [BUILT_IN, EXTERNAL],
      EXTERNAL.id,
    );
    expect(source.get().canvas?.displayId).toBe(EXTERNAL.id);

    screen.displays = [BUILT_IN];
    screen.emit('display-removed');

    expect(source.get().canvas).toStrictEqual({
      ...ON_BUILT_IN,
      fallback: true,
    });
    expect(source.get().displays.map((d) => d.id)).toStrictEqual([1]);
    expect(canvas.place.mock.calls.at(-1)?.[0]).toMatchObject({
      displayId: 1,
      fallback: true,
    });
    expect(settings.get().values.canvasDisplayId).toBe(EXTERNAL.id);
    expect(lines(warn)).toStrictEqual([
      '[windows] canvas on display 1, 1512x982 at 0,0, scale 2 (display 69733632 is not connected; using the primary display for now)',
    ]);

    screen.displays = [BUILT_IN, EXTERNAL];
    screen.emit('display-added');

    expect(source.get().canvas).toMatchObject({
      displayId: EXTERNAL.id,
      fallback: false,
    });
    expect(canvas.place.mock.calls.at(-1)?.[0]).toMatchObject({
      displayId: EXTERNAL.id,
    });
  });

  it('starts in fallback when the chosen display is not connected', () => {
    const { source } = setup([BUILT_IN], 42);
    expect(source.get().canvas).toStrictEqual({
      ...ON_BUILT_IN,
      fallback: true,
    });
  });

  it('follows bounds and scale changes of the display the canvas is on', () => {
    const { screen, source, canvas } = setup([BUILT_IN]);

    screen.displays = [
      {
        ...BUILT_IN,
        bounds: { x: 0, y: 0, width: 1800, height: 1169 },
        scaleFactor: 1,
      },
    ];
    screen.emit('display-metrics-changed');

    const placement = {
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1800, height: 1169 },
      scaleFactor: 1,
      fallback: false,
    };
    expect(source.get().canvas).toStrictEqual(placement);
    expect(source.get().displays[0]?.scaleFactor).toBe(1);
    expect(canvas.place.mock.calls.at(-1)).toStrictEqual([placement]);
  });

  it('follows a new primary display while the setting is null', () => {
    const { screen, source } = setup([BUILT_IN, EXTERNAL]);

    screen.primaryId = EXTERNAL.id;
    screen.emit('display-metrics-changed');

    expect(source.get().canvas?.displayId).toBe(EXTERNAL.id);
    expect(source.get().displays.map((d) => d.primary)).toStrictEqual([
      false,
      true,
    ]);
  });

  it('changes nothing and logs nothing when only the work area changed', () => {
    const { screen, changes } = setup([BUILT_IN]);
    const logged = lines(info).length;

    screen.emit('display-metrics-changed');

    expect(changes).toHaveBeenCalledOnce();
    expect(lines(info)).toHaveLength(logged);
  });

  it('logs an error and places nothing when there is no display', () => {
    const { canvas, source } = setup([]);

    expect(canvas.place).not.toHaveBeenCalled();
    expect(source.get().canvas).toBeNull();
    expect(lines(error)).toStrictEqual([
      '[windows] no display to put the canvas on',
    ]);
  });

  it('logs, and does not throw, when placing the canvas throws', () => {
    const screen = fakeScreen([BUILT_IN, EXTERNAL]);
    const settings = fakeSettings();
    const source = createWindowsStageSource();
    const canvas = {
      place: vi.fn(() => {
        throw Object.assign(new Error('window'), { code: 'EWINDOW' });
      }),
    };

    expect(() => {
      watchDisplays({ screen, settings, source, canvas });
    }).not.toThrow();
    expect(source.get().canvas).toStrictEqual(ON_BUILT_IN);
    expect(lines(error)).toStrictEqual([
      '[windows] canvas could not be placed (EWINDOW)',
    ]);

    // A later display event does not throw either.
    screen.primaryId = EXTERNAL.id;
    expect(() => {
      screen.emit('display-metrics-changed');
    }).not.toThrow();
    expect(canvas.place).toHaveBeenCalledTimes(2);
    expect(lines(error)).toHaveLength(2);
  });

  it('logs and keeps the last layout when the displays cannot be read', () => {
    const { screen, source, canvas } = setup([BUILT_IN]);
    screen.getAllDisplays = () => {
      throw Object.assign(new Error('boom'), { code: 'EBOOM' });
    };

    screen.emit('display-added');

    expect(source.get().canvas).toStrictEqual(ON_BUILT_IN);
    expect(canvas.place).toHaveBeenCalledOnce();
    expect(lines(error)).toStrictEqual([
      '[windows] displays could not be read (EBOOM)',
    ]);
  });
});
