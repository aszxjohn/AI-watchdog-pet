/**
 * `packs:choose` and `packs:confirm` (Story 3.2): only the panels may call
 * them, `packs:confirm` only with a boolean, and both answer null at once,
 * whatever the import does next. The import itself is the importer's
 * (packs-importer.test.ts); here it is a recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACKS_RENDERERS,
  registerPackHandlers,
} from '../../src/main/packs/ipc';
import { packsChoose, packsConfirm } from '../../src/shared/ipc';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let calls: string[];
let choose: ReturnType<typeof vi.fn<() => Promise<void>>>;
let confirm: ReturnType<typeof vi.fn<(replace: boolean) => void>>;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  calls = [];
  // A dialog that never closes: the answer must not wait for it.
  choose = vi.fn(() => {
    calls.push('choose');
    return new Promise<void>(() => {});
  });
  confirm = vi.fn((replace: boolean) => {
    calls.push(`confirm ${replace}`);
  });
  registerPackHandlers({ choose, confirm });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return fake.ipcRenderer.invoke(channel, ...args);
}

describe('packs:choose and packs:confirm', () => {
  it('are open to the panels only', () => {
    expect(PACKS_RENDERERS).toStrictEqual(['panels']);
  });
});

describe('I/O matrix', () => {
  it('選檔: packs:choose answers null at once, before the dialog closes, and starts choose() once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const reply = invoke(packsChoose.channel);

    // With timers frozen, the IPC timeout cannot answer for it; and its
    // timer is cleared once the handler has answered.
    expect(await reply).toStrictEqual({ ok: true, data: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toStrictEqual(['choose']);
  });

  it.each([[true], [false]])(
    '需要確認: packs:confirm(%s) answers null and passes the flag on',
    async (replace) => {
      expect(await invoke(packsConfirm.channel, replace)).toStrictEqual({
        ok: true,
        data: null,
      });
      expect(calls).toStrictEqual([`confirm ${replace}`]);
    },
  );

  it.each([
    ['no flag', []],
    ['a string', ['yes']],
    ['a number', [1]],
    ['null', [null]],
    ['an object', [{ replace: true }]],
    ['two flags', [true, false]],
  ])(
    '壞輸入: packs:confirm with %s answers invalid-input and reaches nothing',
    async (_label, args) => {
      expect(await invoke(packsConfirm.channel, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(calls).toStrictEqual([]);
    },
  );

  it('壞輸入: packs:choose with an argument answers invalid-input and opens no dialog', async () => {
    expect(await invoke(packsChoose.channel, '/a.awpet')).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(calls).toStrictEqual([]);
  });

  it.each([
    ['the overlay', 'app://overlay/index.html'],
    ['a web page', 'https://example.com/'],
  ])(
    '壞輸入: both answer sender-rejected to %s, reaching nothing',
    async (_label, url) => {
      fake.sender.mainFrame.url = url;

      expect(await invoke(packsChoose.channel)).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(await invoke(packsConfirm.channel, true)).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(calls).toStrictEqual([]);
    },
  );
});
