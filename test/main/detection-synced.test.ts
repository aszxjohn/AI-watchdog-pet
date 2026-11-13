/**
 * main/detection's start-up sync (Story 2.8): onSynced hears, once, the
 * session keys adapters reported until every source adapter sent
 * `sync.ready` or failed to start, or syncTimeoutMs passed, after the
 * sections that change published, and the sources that did not confirm
 * (Epic 2 close-out B1). Fake adapters and clocks; the real sessions and
 * reducer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterContext,
  DetectionAdapter,
} from '../../src/main/detection/adapter';
import {
  createDetection,
  type Detection,
} from '../../src/main/detection/detection';
import {
  confidenceFor,
  type DetectionEvent,
  detectionEventSchema,
  type SessionKey,
} from '../../src/shared/detection-events';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
  type SettingsValues,
} from '../../src/shared/settings';
import type { SourceCode } from '../../src/shared/sources';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';

const SYNC_TIMEOUT_MS = SETTINGS_DEFAULTS.syncTimeoutMs;

let clock: FakeClock;
let settings: ReturnType<typeof fakeSettings>;
/** What the test heard, in order: section changes and sync notifications. */
let heard: string[];

function fakeSettings() {
  let state: SettingsState = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
  const listeners = new Set<(next: SettingsState) => void>();
  return {
    get: () => state,
    onChange(listener: (next: SettingsState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(changes: Partial<SettingsValues>) {
      state = { rev: state.rev + 1, values: { ...state.values, ...changes } };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

beforeEach(() => {
  clock = fakeClock();
  settings = fakeSettings();
  heard = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A source adapter the test emits for; `onStart` runs inside start(). */
function fakeAdapter(
  source: SourceCode,
  onStart?: (context: AdapterContext) => void,
) {
  let context: AdapterContext | undefined;
  const adapter: DetectionAdapter = {
    source,
    start(given) {
      context = given;
      onStart?.(given);
    },
    stop() {},
  };
  const ctx = (): AdapterContext => {
    if (context === undefined) {
      throw new Error('not started');
    }
    return context;
  };
  return { adapter, ctx };
}

function event(
  source: SourceCode,
  nativeId: string,
  type: DetectionEvent['type'],
  replay = false,
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source,
    sessionKey: `${source}:${nativeId}`,
    ts: clock.wall(),
    via: 'log',
    confidence: confidenceFor('log'),
    ...(replay ? { replay: true } : {}),
  });
}

function syncReady(source: SourceCode) {
  return { type: 'sync.ready', source } as const;
}

/** A source adapter whose start() throws; its stop() is recorded. */
function brokenAdapter(source: SourceCode) {
  const stop = vi.fn();
  const adapter: DetectionAdapter = {
    source,
    start() {
      throw Object.assign(new Error('x'), { code: 'EBROKEN' });
    },
    stop,
  };
  return { adapter, stop };
}

function start(...adapters: DetectionAdapter[]): Detection {
  const detection = createDetection({
    settings,
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    adapters,
  });
  detection.onChange((sections) => {
    heard.push(
      `sections ${Object.keys(sections).join(',')}${
        sections.sessions === undefined
          ? ''
          : ` [${sections.sessions.map((s) => s.sessionKey).join(' ')}]`
      }`,
    );
  });
  return detection;
}

/** Subscribes to onSynced, recording each call as `synced [<keys>]`. */
function listen(detection: Detection) {
  const calls: ReadonlySet<SessionKey>[] = [];
  const unsubscribe = detection.onSynced((reported) => {
    calls.push(reported);
    heard.push(`synced [${[...reported].sort().join(' ')}]`);
  });
  return { calls, unsubscribe };
}

describe('onSynced', () => {
  it('every source adapter sent sync.ready: heard once, with every key their events named, after that change published', () => {
    const claude = fakeAdapter('claude-code');
    const codex = fakeAdapter('codex');
    const detection = start(claude.adapter, codex.adapter);
    const { calls } = listen(detection);

    claude
      .ctx()
      .emit(
        [
          event('claude-code', 'a', 'session.start', true),
          event('claude-code', 'b', 'turn.start', true),
          syncReady('claude-code'),
        ],
        'ok',
      );
    expect(calls).toStrictEqual([]);

    codex
      .ctx()
      .emit([event('codex', 'c', 'session.start', true), syncReady('codex')]);

    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])].sort()).toStrictEqual([
      'claude-code:a',
      'claude-code:b',
      'codex:c',
    ]);
    // The sessions of the last source to sync publish first, then the sync.
    expect(heard.slice(-2)).toStrictEqual([
      'sections sessions [claude-code:a claude-code:b codex:c]',
      'synced [claude-code:a claude-code:b codex:c]',
    ]);
    // The deadline passing later is not heard again.
    clock.advance(SYNC_TIMEOUT_MS);
    expect(calls).toHaveLength(1);
  });

  it('no later change is heard: keys reported after sync are not collected', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);
    codex
      .ctx()
      .emit([event('codex', 'a', 'session.start'), syncReady('codex')]);

    codex.ctx().emit([event('codex', 'b', 'session.start')]);
    clock.advance(SYNC_TIMEOUT_MS * 2);

    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])]).toStrictEqual(['codex:a']);
  });

  it(`a source adapter that never sends sync.ready: heard once at syncTimeoutMs (${SYNC_TIMEOUT_MS} ms) since creation, with what was reported until then`, () => {
    const claude = fakeAdapter('claude-code');
    const gemini = fakeAdapter('gemini');
    const detection = start(claude.adapter, gemini.adapter);
    const { calls } = listen(detection);
    claude
      .ctx()
      .emit([
        event('claude-code', 'a', 'session.start', true),
        syncReady('claude-code'),
      ]);
    gemini.ctx().emit([event('gemini', 'g', 'session.start', true)], 'ok');

    clock.advance(SYNC_TIMEOUT_MS - 1);
    expect(calls).toStrictEqual([]);
    clock.advance(1);

    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])].sort()).toStrictEqual([
      'claude-code:a',
      'gemini:g',
    ]);

    // Its sync.ready coming later is not heard again.
    gemini.ctx().emit([syncReady('gemini')]);
    expect(calls).toHaveLength(1);
  });

  it('the deadline is syncTimeoutMs as it was at creation', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);

    settings.set({ syncTimeoutMs: SYNC_TIMEOUT_MS * 3 });
    clock.advance(SYNC_TIMEOUT_MS);

    expect(calls).toHaveLength(1);
  });

  it('an adapter that throws on start is not waited for: alone, sync is over at creation, with no deadline timer, and the log says no adapter started', () => {
    const detection = start(brokenAdapter('codex').adapter);
    expect(clock.pendingCount()).toBe(0);

    const { calls } = listen(detection);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.size).toBe(0);
    expect(
      vi
        .mocked(console.info)
        .mock.calls.map((call) => String(call[0]))
        .filter((line) => line.startsWith('[detection] start-up sync')),
    ).toStrictEqual([
      '[detection] start-up sync over: no adapter started; failed to start: codex; 0 sessions reported',
    ]);
  });

  it('with no source adapter, sync is over at creation: a subscriber hears an empty set at once', () => {
    const detection = start();
    expect(clock.pendingCount()).toBe(0);

    const { calls } = listen(detection);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.size).toBe(0);
  });

  it('every adapter syncing while it starts (no records folder) ends sync at creation, with no deadline timer', () => {
    const claude = fakeAdapter('claude-code', (context) => {
      context.emit([syncReady('claude-code')], 'missing');
    });
    const gemini = fakeAdapter('gemini', (context) => {
      context.emit([syncReady('gemini')], 'missing');
    });
    const detection = start(claude.adapter, gemini.adapter);

    expect(clock.pendingCount()).toBe(0);
    expect(listen(detection).calls).toHaveLength(1);
  });

  it('a subscriber after sync is called at once with the same set', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const first = listen(detection);
    codex
      .ctx()
      .emit([event('codex', 'a', 'session.start'), syncReady('codex')]);

    const later = listen(detection);

    expect(later.calls).toHaveLength(1);
    expect(later.calls[0]).toBe(first.calls[0]);
  });

  it('demo mode is not waited for, but the keys its events name are collected', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);

    detection.setDemo('working');
    expect(calls).toStrictEqual([]);
    codex.ctx().emit([syncReady('codex')]);

    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])]).toStrictEqual(['demo:1']);
  });

  it('demo mode alone does not end sync early: its sync.ready is not a source adapter’s', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);

    detection.setDemo('approval');

    expect(calls).toStrictEqual([]);
    expect(clock.pendingCount()).toBeGreaterThan(0);
  });

  it('an unsubscribed listener is not called', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls, unsubscribe } = listen(detection);

    unsubscribe();
    codex.ctx().emit([syncReady('codex')]);

    expect(calls).toStrictEqual([]);
  });

  it('a listener that throws is logged by code; the next one still hears', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    detection.onSynced(() => {
      throw Object.assign(new Error('x'), { code: 'EBUG' });
    });
    const { calls } = listen(detection);

    codex.ctx().emit([syncReady('codex')]);

    expect(calls).toHaveLength(1);
    expect(
      vi.mocked(console.error).mock.calls.map((call) => String(call[0])),
    ).toStrictEqual(['[detection] a synced listener failed (EBUG)']);
  });

  it("an adapter sending another source's sync.ready does not end its own wait", () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);

    codex.ctx().emit([syncReady('gemini')]);
    expect(calls).toStrictEqual([]);

    codex.ctx().emit([syncReady('codex')]);
    expect(calls).toHaveLength(1);
  });

  it('two adapters of one source are each waited for', () => {
    const first = fakeAdapter('codex');
    const second = fakeAdapter('codex');
    const detection = start(first.adapter, second.adapter);
    const { calls } = listen(detection);

    first.ctx().emit([syncReady('codex')]);
    expect(calls).toStrictEqual([]);

    second.ctx().emit([syncReady('codex')]);
    expect(calls).toHaveLength(1);
  });

  it('a listener unsubscribed by another while they are called is not called', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const later = vi.fn();
    let unsubscribeLater = () => {};
    detection.onSynced(() => {
      unsubscribeLater();
    });
    unsubscribeLater = detection.onSynced(later);

    codex.ctx().emit([syncReady('codex')]);

    expect(later).not.toHaveBeenCalled();
  });

  describe('the run log', () => {
    function syncLines(): string[] {
      return vi
        .mocked(console.info)
        .mock.calls.map((call) => String(call[0]))
        .filter((line) => line.startsWith('[detection] start-up sync'));
    }

    it('says every adapter synced, with the count of keys reported only', () => {
      const codex = fakeAdapter('codex');
      start(codex.adapter);

      codex
        .ctx()
        .emit([
          event('codex', 'secret-id', 'session.start', true),
          syncReady('codex'),
        ]);

      expect(syncLines()).toStrictEqual([
        '[detection] start-up sync over: every adapter sent sync.ready; 1 sessions reported',
      ]);
      expect(syncLines().join('\n')).not.toContain('secret-id');
    });

    it('says the deadline passed and which sources it was still waiting for', () => {
      const claude = fakeAdapter('claude-code');
      const gemini = fakeAdapter('gemini');
      const cursor = fakeAdapter('cursor');
      start(claude.adapter, gemini.adapter, cursor.adapter);
      claude.ctx().emit([syncReady('claude-code')]);

      clock.advance(SYNC_TIMEOUT_MS);

      expect(syncLines()).toStrictEqual([
        '[detection] start-up sync over: syncTimeoutMs passed, still waiting for gemini, cursor; 0 sessions reported',
      ]);
    });

    it('says nothing with no source adapter: there was nothing to wait for', () => {
      listen(start());

      expect(syncLines()).toStrictEqual([]);
    });

    it('names the adapters that failed to start, by source code', () => {
      const claude = fakeAdapter('claude-code');
      start(claude.adapter, brokenAdapter('cursor').adapter);

      claude
        .ctx()
        .emit([
          event('claude-code', 'secret-id', 'session.start', true),
          syncReady('claude-code'),
        ]);

      expect(syncLines()).toStrictEqual([
        '[detection] start-up sync over: every adapter that started sent sync.ready; failed to start: cursor; 1 sessions reported',
      ]);
      expect(syncLines().join('\n')).not.toContain('secret-id');
    });

    it('names both when the deadline passed and an adapter failed to start', () => {
      const claude = fakeAdapter('claude-code');
      const gemini = fakeAdapter('gemini');
      start(claude.adapter, gemini.adapter, brokenAdapter('cursor').adapter);
      claude.ctx().emit([syncReady('claude-code')]);

      clock.advance(SYNC_TIMEOUT_MS);

      expect(syncLines()).toStrictEqual([
        '[detection] start-up sync over: syncTimeoutMs passed, still waiting for gemini; failed to start: cursor; 0 sessions reported',
      ]);
    });
  });

  it('stop() clears the deadline: nothing is heard afterwards', () => {
    const codex = fakeAdapter('codex');
    const detection = start(codex.adapter);
    const { calls } = listen(detection);
    expect(clock.pendingCount()).toBe(1);

    detection.stop();

    expect(clock.pendingCount()).toBe(0);
    clock.advance(SYNC_TIMEOUT_MS);
    expect(calls).toStrictEqual([]);
  });
});

describe('I/O matrix', () => {
  /** Subscribes to onSynced, recording both sets of each call, sorted. */
  function listenBoth(detection: Detection) {
    const calls: { reported: string[]; unconfirmed: string[] }[] = [];
    detection.onSynced((reported, unconfirmed) => {
      calls.push({
        reported: [...reported].sort(),
        unconfirmed: [...unconfirmed].sort(),
      });
    });
    return calls;
  }

  it('全部同步: every adapter sent sync.ready: no source is unconfirmed', () => {
    const claude = fakeAdapter('claude-code');
    const cursor = fakeAdapter('cursor');
    const detection = start(claude.adapter, cursor.adapter);
    const calls = listenBoth(detection);

    claude
      .ctx()
      .emit([
        event('claude-code', 'a', 'session.start', true),
        syncReady('claude-code'),
      ]);
    cursor.ctx().emit([syncReady('cursor')]);

    expect(calls).toStrictEqual([
      { reported: ['claude-code:a'], unconfirmed: [] },
    ]);
  });

  it(`同步逾時: cursor has not sent sync.ready at syncTimeoutMs (${SYNC_TIMEOUT_MS} ms): cursor is unconfirmed, and the log names it`, () => {
    const claude = fakeAdapter('claude-code');
    const cursor = fakeAdapter('cursor');
    const detection = start(claude.adapter, cursor.adapter);
    const calls = listenBoth(detection);
    claude
      .ctx()
      .emit([
        event('claude-code', 'a', 'session.start', true),
        syncReady('claude-code'),
      ]);
    cursor.ctx().emit([event('cursor', 'c', 'session.start', true)], 'ok');

    clock.advance(SYNC_TIMEOUT_MS);

    expect(calls).toStrictEqual([
      { reported: ['claude-code:a', 'cursor:c'], unconfirmed: ['cursor'] },
    ]);
    expect(
      vi
        .mocked(console.info)
        .mock.calls.map((call) => String(call[0]))
        .filter((line) => line.startsWith('[detection] start-up sync')),
    ).toStrictEqual([
      '[detection] start-up sync over: syncTimeoutMs passed, still waiting for cursor; 2 sessions reported',
    ]);
  });

  it('啟動失敗: cursor’s start() throws: sync ends once the others are ready, not at the deadline; cursor is unconfirmed, its health degraded, and stop() still stops it', () => {
    const claude = fakeAdapter('claude-code');
    const cursor = brokenAdapter('cursor');
    const detection = start(claude.adapter, cursor.adapter);
    const calls = listenBoth(detection);
    expect(calls).toStrictEqual([]);

    claude
      .ctx()
      .emit(
        [
          event('claude-code', 'a', 'session.start', true),
          syncReady('claude-code'),
        ],
        'ok',
      );

    // Heard at once, with no time passed: the deadline was not waited for.
    expect(calls).toStrictEqual([
      { reported: ['claude-code:a'], unconfirmed: ['cursor'] },
    ]);
    clock.advance(SYNC_TIMEOUT_MS);
    expect(calls).toHaveLength(1);
    expect(detection.get().adapters).toStrictEqual([
      { source: 'cursor', health: 'degraded' },
      { source: 'claude-code', health: 'ok' },
    ]);
    expect(
      vi.mocked(console.error).mock.calls.map((call) => String(call[0])),
    ).toStrictEqual([
      '[detection] the cursor adapter failed to start (EBROKEN)',
    ]);

    detection.stop();
    expect(cursor.stop).toHaveBeenCalledOnce();
  });

  it('啟動失敗: a subscriber before sync and one after it get the same sets', () => {
    const claude = fakeAdapter('claude-code');
    const detection = start(claude.adapter, brokenAdapter('cursor').adapter);
    type Heard = [ReadonlySet<SessionKey>, ReadonlySet<SourceCode>];
    const before: Heard[] = [];
    const after: Heard[] = [];
    detection.onSynced((reported, unconfirmed) => {
      before.push([reported, unconfirmed]);
    });

    claude
      .ctx()
      .emit([
        event('claude-code', 'a', 'session.start', true),
        syncReady('claude-code'),
      ]);
    detection.onSynced((reported, unconfirmed) => {
      after.push([reported, unconfirmed]);
    });

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const [reported, unconfirmed] = before[0] ?? [];
    expect([...(reported ?? [])]).toStrictEqual(['claude-code:a']);
    expect([...(unconfirmed ?? [])]).toStrictEqual(['cursor']);
    expect(after[0]?.[0]).toBe(reported);
    expect(after[0]?.[1]).toBe(unconfirmed);
  });
});
