/**
 * `pool:set-released` (Story 2.8), and `pool:set-released-many`,
 * `pool:set-locked` and `pool:set-lock-on` (session bulk-lock): only the
 * panels may call them, only with valid arguments, and each answers null
 * whether or not anything changed. The outcome reaches renderers through
 * StageView, not the reply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POOL_RENDERERS, registerPoolHandlers } from '../../src/main/pool/ipc';
import {
  loadPool,
  type PoolListener,
  type PoolStore,
} from '../../src/main/pool/store';
import { POOL_FLUSH_DEBOUNCE_MS } from '../../src/shared/constants';
import type { SessionKey } from '../../src/shared/detection-events';
import {
  poolSetLocked,
  poolSetLockOn,
  poolSetReleased,
  poolSetReleasedMany,
} from '../../src/shared/ipc';
import { POOL_SET_RELEASED_MANY_MAX_KEYS } from '../../src/shared/pool';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let dir: string;
let store: PoolStore;
let onChange: ReturnType<typeof vi.fn<PoolListener>>;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-pool-ipc-'));
  store = loadPool({ file: path.join(dir, 'assignments.json') });
  onChange = vi.fn<PoolListener>();
  store.onChange(onChange);
  registerPoolHandlers(store);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function invoke(...args: unknown[]): Promise<unknown> {
  return fake.ipcRenderer.invoke(poolSetReleased.channel, ...args);
}

/** The store's `pool` section. */
function section(
  released: readonly SessionKey[],
  locked: readonly SessionKey[] = [],
  lockOn = false,
) {
  return { pool: { released, locked, lockOn } };
}

describe('pool:set-released', () => {
  it('is open to the panels only', () => {
    expect(POOL_RENDERERS).toStrictEqual(['panels']);
  });

  it('releases a key for the panels and answers null', async () => {
    expect(await invoke('demo:1', true)).toStrictEqual({
      ok: true,
      data: null,
    });
    expect(store.get()).toStrictEqual(section(['demo:1']));
  });

  it('shows a released key again and answers null', async () => {
    await invoke('demo:1', true);

    expect(await invoke('demo:1', false)).toStrictEqual({
      ok: true,
      data: null,
    });
    expect(store.get()).toStrictEqual(section([]));
  });

  it('I/O matrix 沒有變化: answers success to a key already released, with no change and no write', async () => {
    await invoke('demo:1', true);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    onChange.mockClear();
    const writes = vi.spyOn(fs, 'writeFileSync');

    expect(await invoke('demo:1', true)).toStrictEqual({
      ok: true,
      data: null,
    });
    vi.runAllTimers();
    store.flushSync();

    expect(onChange).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();

    // The spy does see a write when something changes.
    await invoke('demo:2', true);
    store.flushSync();
    expect(writes).toHaveBeenCalledOnce();
  });

  it.each([
    ['the overlay', 'app://overlay/index.html'],
    ['a web page', 'https://example.com/'],
  ])(
    'I/O matrix 壞輸入: answers sender-rejected to %s, changing nothing',
    async (_label, url) => {
      fake.sender.mainFrame.url = url;

      expect(await invoke('demo:1', true)).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(store.get()).toStrictEqual(section([]));
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an unknown source', ['vim:1', true]],
    ['an empty native id', ['demo:', true]],
    ['a control character', ['demo:1\u0007', true]],
    ['no flag', ['demo:1']],
    ['a flag that is not a boolean', ['demo:1', 'yes']],
    ['an extra argument', ['demo:1', true, 'more']],
  ])(
    'I/O matrix 壞輸入: answers invalid-input to %s, changing nothing',
    async (_label, args) => {
      expect(await invoke(...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(store.get()).toStrictEqual(section([]));
      expect(onChange).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(fs.readdirSync(dir)).toStrictEqual([]);
    },
  );
});

describe('I/O matrix', () => {
  function call(channel: string, ...args: unknown[]): Promise<unknown> {
    return fake.ipcRenderer.invoke(channel, ...args);
  }

  it('全部釋放: pool:set-released-many releases every key given, in one change, and answers null; with false it shows them again', async () => {
    expect(
      await call(poolSetReleasedMany.channel, ['demo:2', 'demo:1'], true),
    ).toStrictEqual({ ok: true, data: null });
    expect(store.get()).toStrictEqual(section(['demo:1', 'demo:2']));
    expect(onChange).toHaveBeenCalledOnce();

    expect(
      await call(poolSetReleasedMany.channel, ['demo:1', 'demo:2'], false),
    ).toStrictEqual({ ok: true, data: null });
    expect(store.get()).toStrictEqual(section([]));
  });

  it('打開鎖定: pool:set-locked locks a key and pool:set-lock-on turns 鎖定展示 on, each answering null', async () => {
    expect(await call(poolSetLocked.channel, 'demo:1', true)).toStrictEqual({
      ok: true,
      data: null,
    });
    expect(await call(poolSetLockOn.channel, true)).toStrictEqual({
      ok: true,
      data: null,
    });

    expect(store.get()).toStrictEqual(section([], ['demo:1'], true));
  });

  it.each([
    [poolSetReleasedMany.channel, [['demo:1'], true]],
    [poolSetLocked.channel, ['demo:1', true]],
    [poolSetLockOn.channel, [false]],
  ])(
    '壞輸入: %s answers sender-rejected to the overlay, changing nothing',
    async (channel, args) => {
      fake.sender.mainFrame.url = 'app://overlay/index.html';

      expect(await call(channel, ...args)).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(store.get()).toStrictEqual(section([]));
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a bad key in the batch', poolSetReleasedMany.channel, [['vim:1'], true]],
    ['an empty batch', poolSetReleasedMany.channel, [[], true]],
    [
      'a batch past the limit',
      poolSetReleasedMany.channel,
      [
        Array.from(
          { length: POOL_SET_RELEASED_MANY_MAX_KEYS + 1 },
          (_, i) => `demo:${i}`,
        ),
        true,
      ],
    ],
    ['a bad key to lock', poolSetLocked.channel, ['demo:', true]],
    ['a flag that is not a boolean', poolSetLockOn.channel, ['on']],
  ])(
    '壞輸入: answers invalid-input to %s, changing nothing',
    async (_label, channel, args) => {
      expect(await call(channel, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(store.get()).toStrictEqual(section([]));
      expect(onChange).not.toHaveBeenCalled();
    },
  );
});
