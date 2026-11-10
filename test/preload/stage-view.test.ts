import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageViewDelta, stageViewSubscribe } from '../../src/shared/ipc';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type {
  StageViewDelta,
  StageViewSnapshot,
} from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

// Resolve the electron mock before any vi.resetModules(): the mock is cached
// from its first import, so every fresh preload import below then shares
// this fake (the same instance as `fake`).
await import('electron');

/** A snapshot whose settings rev equals its own rev, for brevity. */
function snapshot(rev: number, id: number | null = null): StageViewSnapshot {
  return {
    rev,
    view: {
      settings: { rev, values: { ...SETTINGS_DEFAULTS, canvasDisplayId: id } },
      displays: [],
      canvas: null,
      power: { suspended: false, locked: false },
      sessions: [],
      adapters: [],
    },
  };
}

/** A delta that replaces the settings section only. */
function delta(rev: number, id: number | null): StageViewDelta {
  return { rev, sections: { settings: snapshot(rev, id).view.settings } };
}

/** Sends a push to this renderer, as main's pushToRenderer would. */
function push(payload: unknown): void {
  fake.sender.send(stageViewDelta.channel, payload);
}

/** Lets pending invoke replies and microtasks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Answers every `stage-view:subscribe` with `reply()`. */
function serve(reply: () => unknown) {
  const handler = vi.fn(reply);
  fake.listeners.set(stageViewSubscribe.channel, handler);
  return handler;
}

/** Holds each `stage-view:subscribe` until the test answers it. */
function serveManually() {
  const answers: ((reply: unknown) => void)[] = [];
  const handler = serve(() => new Promise((resolve) => answers.push(resolve)));
  return { handler, answers };
}

function ok(data: StageViewSnapshot) {
  return { ok: true, data };
}

async function loadPreload() {
  vi.resetModules();
  return import('../../src/preload/stage-view');
}

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.resetFakeElectron();
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribeStageView', () => {
  it('gives the snapshot first, then the state after each delta', async () => {
    serve(() => ok(snapshot(3)));
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();

    subscribeStageView(listener);
    await settle();
    push(delta(4, 1));
    push(delta(5, 2));

    expect(listener.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(3),
      snapshot(4, 1),
      snapshot(5, 2),
    ]);
  });

  it('holds deltas that arrive before the snapshot and drops those it already covers', async () => {
    const { answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();

    subscribeStageView(listener);
    push(delta(7, 7));
    push(delta(5, 5));
    push(delta(6, 6));
    push(delta(4, 4));
    expect(listener).not.toHaveBeenCalled();
    answers[0]?.(ok(snapshot(5, 5)));
    await settle();

    expect(listener.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(5, 5),
      snapshot(6, 6),
      snapshot(7, 7),
    ]);
  });

  it('ignores a delta at or below the current rev', async () => {
    serve(() => ok(snapshot(3)));
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();
    subscribeStageView(listener);
    await settle();

    push(delta(3, 9));
    push(delta(2, 9));

    expect(listener).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('re-fetches the snapshot on a rev gap, and listeners only see consistent states', async () => {
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();
    subscribeStageView(listener);
    answers[0]?.(ok(snapshot(1, 1)));
    await settle();

    push(delta(3, 3));
    expect(error).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(2);
    push(delta(4, 4));
    push(delta(5, 5));
    answers[1]?.(ok(snapshot(4, 4)));
    await settle();

    expect(listener.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(1, 1),
      snapshot(4, 4),
      snapshot(5, 5),
    ]);
  });

  it.each([
    ['an empty delta', { rev: 2, sections: {} }],
    ['an unknown section', { rev: 2, sections: { actors: [] } }],
    ['a bad value', delta(2, -1)],
    ['no rev', { sections: snapshot(2).view }],
    ['not an object', 'delta'],
  ])(
    're-fetches the snapshot when a delta is malformed (%s)',
    async (_label, payload) => {
      const { handler, answers } = serveManually();
      const { subscribeStageView } = await loadPreload();
      const listener = vi.fn();
      subscribeStageView(listener);
      answers[0]?.(ok(snapshot(1)));
      await settle();

      push(payload);

      expect(error).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledOnce();
      answers[1]?.(ok(snapshot(2, 8)));
      await settle();
      expect(listener).toHaveBeenLastCalledWith(snapshot(2, 8));
    },
  );

  it('does not start a second fetch while one is on its way', async () => {
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    subscribeStageView(vi.fn());
    answers[0]?.(ok(snapshot(1)));
    await settle();

    push(delta(5, 5));
    push('garbage');
    push(delta(9, 9));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('shares one subscription between listeners', async () => {
    const handler = serve(() => ok(snapshot(2)));
    const { subscribeStageView } = await loadPreload();
    const first = vi.fn();
    const second = vi.fn();

    subscribeStageView(first);
    await settle();
    subscribeStageView(second);
    await settle();
    push(delta(3, 3));

    expect(handler).toHaveBeenCalledOnce();
    expect(fake.rendererListenerCount(stageViewDelta.channel)).toBe(1);
    expect(first.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(2),
      snapshot(3, 3),
    ]);
    expect(second.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(2),
      snapshot(3, 3),
    ]);
  });

  it('gives a listener that joins mid-fetch the snapshot when it arrives', async () => {
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const first = vi.fn();
    const second = vi.fn();

    subscribeStageView(first);
    subscribeStageView(second);
    answers[0]?.(ok(snapshot(1)));
    await settle();

    expect(handler).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledExactlyOnceWith(snapshot(1));
    expect(second).toHaveBeenCalledExactlyOnceWith(snapshot(1));
  });

  it('stops calling a listener once it unsubscribes', async () => {
    serve(() => ok(snapshot(1)));
    const { subscribeStageView } = await loadPreload();
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = subscribeStageView(leaving);
    subscribeStageView(staying);
    await settle();

    unsubscribe();
    unsubscribe();
    push(delta(2, 2));

    expect(leaving).toHaveBeenCalledOnce();
    expect(staying).toHaveBeenLastCalledWith(snapshot(2, 2));
    expect(fake.rendererListenerCount(stageViewDelta.channel)).toBe(1);
  });

  it('stops listening when the last listener leaves, and starts over on the next subscribe', async () => {
    let rev = 1;
    const handler = serve(() => ok(snapshot(rev)));
    const { subscribeStageView } = await loadPreload();
    const unsubscribe = subscribeStageView(vi.fn());
    await settle();

    unsubscribe();
    expect(fake.rendererListenerCount(stageViewDelta.channel)).toBe(0);

    rev = 6;
    const listener = vi.fn();
    subscribeStageView(listener);
    await settle();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot(6));
  });

  it('gives the snapshot to a listener that unsubscribes and subscribes again at once (React StrictMode)', async () => {
    // StrictMode in development runs every effect twice: subscribe, clean up
    // (unsubscribe) and subscribe again, synchronously, while the first
    // snapshot is still on its way. That first answer is then stale, so the
    // second subscribe must fetch its own.
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();

    const unsubscribe = subscribeStageView(listener);
    unsubscribe();
    subscribeStageView(listener);
    answers[0]?.(ok(snapshot(1, 1)));
    answers[1]?.(ok(snapshot(2, 2)));
    await settle();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot(2, 2));
    push(delta(3, 3));
    expect(listener).toHaveBeenLastCalledWith(snapshot(3, 3));
  });

  it('ignores a snapshot that arrives after everyone left', async () => {
    const { answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();
    const unsubscribe = subscribeStageView(listener);

    unsubscribe();
    answers[0]?.(ok(snapshot(1)));
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a failed snapshot to onError and retries on the next delta', async () => {
    let reply: unknown = {
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    };
    const handler = serve(() => reply);
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();
    const onError = vi.fn();

    subscribeStageView(listener, onError);
    await settle();

    expect(onError).toHaveBeenCalledExactlyOnceWith({
      code: 'handler-failed',
      message: 'handler failed',
    });
    expect(listener).not.toHaveBeenCalled();

    reply = ok(snapshot(3, 3));
    push(delta(3, 3));
    await settle();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot(3, 3));
  });

  it('keeps calling other listeners when one throws', async () => {
    serve(() => ok(snapshot(1)));
    const { subscribeStageView } = await loadPreload();
    const throwing = vi.fn(() => {
      throw new Error('renderer bug');
    });
    const other = vi.fn();
    subscribeStageView(throwing);
    subscribeStageView(other);
    await settle();

    push(delta(2, 2));

    expect(other.mock.calls.map(([state]) => state)).toStrictEqual([
      snapshot(1),
      snapshot(2, 2),
    ]);
  });

  it('fetches a new snapshot after a renderer reload', async () => {
    let rev = 2;
    const handler = serve(() => ok(snapshot(rev)));
    const before = await loadPreload();
    before.subscribeStageView(vi.fn());
    await settle();

    // A reload runs the preload again from scratch.
    fake.rendererListeners.clear();
    rev = 9;
    const after = await loadPreload();
    const listener = vi.fn();
    after.subscribeStageView(listener);
    await settle();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot(9));
  });

  it('does not replay held deltas when the last listener leaves during the snapshot', async () => {
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const seen: StageViewSnapshot[] = [];
    const unsubscribe = subscribeStageView((state) => {
      seen.push(state);
      unsubscribe();
    });
    push(delta(2, 2));
    push(delta(3, 3));

    answers[0]?.(ok(snapshot(1, 1)));
    await settle();

    expect(seen).toStrictEqual([snapshot(1, 1)]);
    expect(handler).toHaveBeenCalledOnce();

    const next = vi.fn();
    subscribeStageView(next);
    expect(handler).toHaveBeenCalledTimes(2);
    answers[1]?.(ok(snapshot(7, 7)));
    await settle();

    expect(next).toHaveBeenCalledExactlyOnceWith(snapshot(7, 7));
  });

  it('reports a failed resync to onError, and listeners keep their last state', async () => {
    const { handler, answers } = serveManually();
    const { subscribeStageView } = await loadPreload();
    const listener = vi.fn();
    const onError = vi.fn();
    subscribeStageView(listener, onError);
    answers[0]?.(ok(snapshot(1, 1)));
    await settle();

    push(delta(3, 3));
    expect(handler).toHaveBeenCalledTimes(2);
    answers[1]?.({
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    });
    await settle();

    expect(onError).toHaveBeenCalledExactlyOnceWith({
      code: 'handler-failed',
      message: 'handler failed',
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot(1, 1));
  });
});
