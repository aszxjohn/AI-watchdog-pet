import { describe, expect, it, vi } from 'vitest';
import {
  failureReport,
  readyReport,
  startOverlay,
} from '../../src/overlay/start';
import {
  CANVAS_READY_REASON_MAX_LENGTH,
  canvasReady,
  type CanvasReadyReport,
} from '../../src/shared/ipc';
import type { OverlayApi } from '../../src/shared/preload-api';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { StageViewSnapshot } from '../../src/shared/stage-view';

const SNAPSHOT: StageViewSnapshot = {
  rev: 4,
  view: {
    settings: {
      rev: 0,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: null },
    },
    displays: [],
    canvas: {
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      scaleFactor: 2,
      fallback: false,
    },
    power: { suspended: false, locked: false },
    sessions: [],
    adapters: [],
  },
};

/** A fake overlay preload API that records what the overlay does. */
function fakeApi(
  options: { readyFails?: boolean; subscribeThrows?: boolean } = {},
) {
  const order: string[] = [];
  const reports: CanvasReadyReport[] = [];
  let listener: ((snapshot: StageViewSnapshot) => void) | undefined;
  let onError: ((error: { code: string; message: string }) => void) | undefined;
  const api: OverlayApi = {
    stageView: {
      subscribe(next, error) {
        order.push('subscribe');
        if (options.subscribeThrows === true) {
          throw new Error('no ipc');
        }
        listener = next;
        onError = error as typeof onError;
        return () => {};
      },
    },
    canvas: {
      async ready(report) {
        order.push('ready');
        reports.push(report);
        return options.readyFails === true
          ? { ok: false, error: { code: 'sender-rejected', message: 'nope' } }
          : { ok: true, data: null };
      },
    },
  };
  return {
    api,
    order,
    reports,
    push: (snapshot: StageViewSnapshot) => listener?.(snapshot),
    fail: () => onError?.({ code: 'invoke-failed', message: 'x' }),
  };
}

describe('startOverlay', () => {
  it('subscribes to StageView, initialises the canvas, then reports ready once', async () => {
    const fake = fakeApi();
    const initCanvas = vi.fn(async () => {
      fake.order.push('init');
      return { renderer: 'webgl', width: 1512, height: 982 };
    });

    const report = await startOverlay({ api: fake.api, initCanvas });

    expect(fake.order).toStrictEqual(['subscribe', 'init', 'ready']);
    expect(fake.reports).toStrictEqual([
      { ok: true, renderer: 'webgl', width: 1512, height: 982 },
    ]);
    expect(report).toStrictEqual(fake.reports[0]);
    expect(canvasReady.input.safeParse([report]).success).toBe(true);
  });

  it('reports the reason when the canvas fails to initialise, and does not throw', async () => {
    const fake = fakeApi();
    const logError = vi.fn();

    const report = await startOverlay({
      api: fake.api,
      initCanvas: async () => {
        throw new Error('WebGL unsupported');
      },
      logError,
    });

    expect(fake.reports).toStrictEqual([
      { ok: false, reason: 'Error: WebGL unsupported' },
    ]);
    expect(report).toStrictEqual(fake.reports[0]);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('passes every StageView state on, and logs a failed snapshot', async () => {
    const fake = fakeApi();
    const onView = vi.fn();
    const logError = vi.fn();
    await startOverlay({
      api: fake.api,
      initCanvas: async () => ({ renderer: 'webgl', width: 1, height: 1 }),
      onView,
      logError,
    });

    fake.push(SNAPSHOT);
    fake.fail();

    expect(onView.mock.calls).toStrictEqual([[SNAPSHOT]]);
    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] StageView: invoke-failed: x'],
    ]);
  });

  it('still initialises and reports when the subscription throws', async () => {
    const fake = fakeApi({ subscribeThrows: true });
    const logError = vi.fn();

    await startOverlay({
      api: fake.api,
      initCanvas: async () => ({ renderer: 'webgl', width: 1, height: 1 }),
      logError,
    });

    expect(fake.order).toStrictEqual(['subscribe', 'ready']);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('logs a refused report and resolves', async () => {
    const fake = fakeApi({ readyFails: true });
    const logError = vi.fn();

    await expect(
      startOverlay({
        api: fake.api,
        initCanvas: async () => ({ renderer: 'webgl', width: 1, height: 1 }),
        logError,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] canvas:ready: sender-rejected: nope'],
    ]);
  });

  it('logs and stops when the preload did not load', async () => {
    const initCanvas = vi.fn();
    const logError = vi.fn();

    expect(
      await startOverlay({ api: undefined, initCanvas, logError }),
    ).toBeUndefined();
    expect(initCanvas).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });
});

describe('readyReport', () => {
  it('rounds the world size', () => {
    expect(
      readyReport({ renderer: 'webgpu', width: 1511.6, height: 981.2 }),
    ).toStrictEqual({ ok: true, renderer: 'webgpu', width: 1512, height: 981 });
  });

  it('turns an unknown renderer into a failure', () => {
    expect(
      readyReport({ renderer: 'webgl2', width: 1, height: 1 }),
    ).toStrictEqual({ ok: false, reason: 'unknown renderer "webgl2"' });
  });

  it('never reports a negative or non-finite size', () => {
    expect(
      readyReport({ renderer: 'webgl', width: -5, height: NaN }),
    ).toStrictEqual({ ok: true, renderer: 'webgl', width: 0, height: 0 });
  });
});

describe('failureReport', () => {
  it.each([
    [new TypeError('bad'), 'TypeError: bad'],
    [new Error(''), 'Error'],
    ['plain text', 'plain text'],
    ['', 'unknown error'],
    [undefined, 'undefined'],
  ])('%s -> %s', (thrown, reason) => {
    expect(failureReport(thrown)).toStrictEqual({ ok: false, reason });
  });

  it.each([
    ['a null-prototype object', Object.create(null) as unknown],
    [
      'an object whose toString throws',
      {
        toString() {
          throw new Error('no');
        },
      },
    ],
  ])('falls back to unknown error for %s', (_label, thrown) => {
    expect(failureReport(thrown)).toStrictEqual({
      ok: false,
      reason: 'unknown error',
    });
  });

  it('still reports, and resolves, when initialisation throws a null-prototype object', async () => {
    const fake = fakeApi();

    await expect(
      startOverlay({
        api: fake.api,
        initCanvas: async () => {
          throw Object.create(null) as unknown;
        },
        logError: vi.fn(),
      }),
    ).resolves.toStrictEqual({ ok: false, reason: 'unknown error' });
    expect(fake.reports).toStrictEqual([
      { ok: false, reason: 'unknown error' },
    ]);
  });

  it('cuts a long reason to the contract limit', () => {
    const report = failureReport(new Error('x'.repeat(1000)));
    expect(report.ok ? '' : report.reason).toHaveLength(
      CANVAS_READY_REASON_MAX_LENGTH,
    );
    expect(canvasReady.input.safeParse([report]).success).toBe(true);
  });
});
