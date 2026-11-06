/**
 * main/windows' part of StageView (AD-3, AD-20): the `displays`, `canvas`
 * and `power` sections are owned here and nowhere else; main/stage-view
 * only composes them, and nothing else is pushed to renderers.
 *
 * - createWindowsStageSource: the three sections, with `get()` and
 *   `onChange()` for createStageView. Before `ready` they are an empty
 *   display list, `canvas: null`, and neither suspended nor locked.
 *   `update()` reports only the sections whose value changed, all in one
 *   change, and nothing when none did.
 * - watchDisplays: after `ready`, re-reads the displays and decides where
 *   the canvas goes now, on every display added, removed or changed, and on
 *   every settings change; then moves the canvas there.
 */
import type { SettingsState } from '../../shared/settings';
import type { StageViewWindowsSections } from '../../shared/stage-view';
import { errorCode, logEvent } from '../log/run-log';
import type { CanvasWindows } from './canvas-window';
import {
  describePlacement,
  resolveCanvasPlacement,
  toStageDisplays,
  type ScreenDisplay,
} from './displays';

export type WindowsSectionsListener = (
  sections: Partial<StageViewWindowsSections>,
) => void;

export interface WindowsStageSource {
  /** The current sections. */
  get(): StageViewWindowsSections;
  /** Hears the sections each update changed. Returns an unsubscribe. */
  onChange(listener: WindowsSectionsListener): () => void;
  /** Replaces the given sections; listeners hear the ones that changed. */
  update(sections: Partial<StageViewWindowsSections>): void;
}

const SECTION_NAMES = ['displays', 'canvas', 'power'] as const;

/** The sections before `ready`. */
export function initialWindowsSections(): StageViewWindowsSections {
  return {
    displays: [],
    canvas: null,
    power: { suspended: false, locked: false },
  };
}

/** Same value, as it would be sent over IPC. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function createWindowsStageSource(): WindowsStageSource {
  let sections = initialWindowsSections();
  const listeners = new Set<WindowsSectionsListener>();

  return {
    get: () => sections,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    update(next) {
      const changed = Object.fromEntries(
        SECTION_NAMES.filter(
          (name) =>
            Object.hasOwn(next, name) &&
            next[name] !== undefined &&
            !same(next[name], sections[name]),
        ).map((name) => [name, next[name]]),
      ) as Partial<StageViewWindowsSections>;
      if (Object.keys(changed).length === 0) {
        return;
      }
      sections = { ...sections, ...changed };
      for (const listener of listeners) {
        listener(changed);
      }
    },
  };
}

export type ScreenEvent =
  | 'display-added'
  | 'display-removed'
  | 'display-metrics-changed';

/** The parts of Electron's `screen` used here. */
export interface ScreenApi {
  getAllDisplays(): ScreenDisplay[];
  getPrimaryDisplay(): { readonly id: number };
  on(event: ScreenEvent, listener: () => void): unknown;
}

export interface WatchDisplaysOptions {
  readonly screen: ScreenApi;
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  readonly source: Pick<WindowsStageSource, 'get' | 'update'>;
  readonly canvas: Pick<CanvasWindows, 'place'>;
}

const SCREEN_EVENTS: readonly ScreenEvent[] = [
  'display-added',
  'display-removed',
  'display-metrics-changed',
];

/**
 * Lays the stage out now and again on every display or settings change:
 * the `displays` and `canvas` sections are updated together, the run log
 * gets a line when either changes, and the canvas is placed. When the
 * chosen display is not connected the canvas goes to the primary display
 * (`fallback`), and comes back once it is connected again; the setting
 * itself is never changed here. Call once, after `ready`.
 */
export function watchDisplays({
  screen,
  settings,
  source,
  canvas,
}: WatchDisplaysOptions): void {
  function layout(): void {
    let displays;
    try {
      displays = toStageDisplays(
        screen.getAllDisplays(),
        screen.getPrimaryDisplay().id,
      );
    } catch (error) {
      logEvent(
        'windows',
        `displays could not be read (${errorCode(error)})`,
        'error',
      );
      return;
    }
    const wanted = settings.get().values.canvasDisplayId;
    const placement = resolveCanvasPlacement(wanted, displays);
    const before = source.get();
    source.update({ displays, canvas: placement });

    if (!same(before.displays, displays)) {
      const primary = displays.find((display) => display.primary);
      logEvent(
        'windows',
        `displays: ${displays.length} connected (ids ${displays.map((display) => display.id).join(', ') || 'none'}; primary ${primary?.id ?? 'none'})`,
      );
    }
    if (placement === null) {
      logEvent('windows', 'no display to put the canvas on', 'error');
      return;
    }
    if (!same(before.canvas, placement)) {
      logEvent(
        'windows',
        placement.fallback
          ? `canvas on ${describePlacement(placement)} (display ${String(wanted)} is not connected; using the primary display for now)`
          : `canvas on ${describePlacement(placement)}`,
        placement.fallback ? 'warn' : 'info',
      );
    }
    // A throwing BrowserWindow constructor or setBounds must not stop the
    // startup chain (watchPower comes next) or escape a screen event.
    try {
      canvas.place(placement);
    } catch (error) {
      logEvent(
        'windows',
        `canvas could not be placed (${errorCode(error)})`,
        'error',
      );
    }
  }

  for (const event of SCREEN_EVENTS) {
    screen.on(event, layout);
  }
  settings.onChange(layout);
  layout();
}
