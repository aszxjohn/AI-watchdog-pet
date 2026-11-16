/**
 * `packs:choose` and `packs:confirm` (Story 3.2), `packs:export` and
 * `packs:remove` (Story 3.3): only the panels may call them, `packs:confirm`
 * only with a boolean, `packs:export` and `packs:remove` only with a pack
 * id. The first three answer null at once, whatever the import or export
 * does next; `packs:remove` answers what the removal did. The import, the
 * export and the removal themselves are tested in their own files; here
 * they are recorders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACKS_RENDERERS,
  registerPackHandlers,
} from '../../src/main/packs/ipc';
import {
  packsChoose,
  packsConfirm,
  packsExport,
  packsRemove,
} from '../../src/shared/ipc';
import type { PackRemoveResult } from '../../src/shared/packs';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let calls: string[];
let choose: ReturnType<typeof vi.fn<() => Promise<void>>>;
let confirm: ReturnType<typeof vi.fn<(replace: boolean) => void>>;
let start: ReturnType<typeof vi.fn<(packId: string) => Promise<void>>>;
let remove: ReturnType<typeof vi.fn<(packId: string) => PackRemoveResult>>;

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
  // A save dialog that never closes: the answer must not wait for it.
  start = vi.fn((packId: string) => {
    calls.push(`export ${packId}`);
    return new Promise<void>(() => {});
  });
  remove = vi.fn((packId: string): PackRemoveResult => {
    calls.push(`remove ${packId}`);
    return { ok: true };
  });
  registerPackHandlers({ choose, confirm }, { start }, remove);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return fake.ipcRenderer.invoke(channel, ...args);
}

describe('the packs channels (import, export, removal)', () => {
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

  it.each([
    ['the overlay', 'app://overlay/index.html'],
    ['a web page', 'https://example.com/'],
  ])(
    '壞輸入: packs:export and packs:remove answer sender-rejected to %s, reaching nothing',
    async (_label, url) => {
      fake.sender.mainFrame.url = url;

      expect(await invoke(packsExport.channel, 'sample-pack')).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(await invoke(packsRemove.channel, 'sample-pack')).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(calls).toStrictEqual([]);
    },
  );

  it('匯出: packs:export answers null at once, before the save dialog closes, and starts the export of that pack once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const reply = invoke(packsExport.channel, 'sample-pack');

    // With timers frozen, the IPC timeout cannot answer for it; and its
    // timer is cleared once the handler has answered.
    expect(await reply).toStrictEqual({ ok: true, data: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toStrictEqual(['export sample-pack']);
  });

  it('移除: packs:remove removes that pack and answers what the removal did', async () => {
    expect(await invoke(packsRemove.channel, 'sample-pack')).toStrictEqual({
      ok: true,
      data: { ok: true },
    });
    expect(calls).toStrictEqual(['remove sample-pack']);
  });

  it.each([['index-unwritable'], ['index-write-failed']] as const)(
    '移除失敗: packs:remove answers the code %s as its data',
    async (code) => {
      remove.mockReturnValue({ ok: false, code });

      expect(await invoke(packsRemove.channel, 'sample-pack')).toStrictEqual({
        ok: true,
        data: { ok: false, code },
      });
    },
  );

  it('已不在: packs:remove answers not-installed as its data', async () => {
    remove.mockReturnValue({ ok: false, code: 'not-installed' });

    expect(await invoke(packsRemove.channel, 'gone-pack')).toStrictEqual({
      ok: true,
      data: { ok: false, code: 'not-installed' },
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith('gone-pack');
  });

  it.each([
    ['no id', []],
    ['an id with upper case', ['Sample-Pack']],
    ['a path', ['../sample-pack']],
    ['an all-digit id', ['123']],
    ['a number', [1]],
    ['two ids', ['sample-pack', 'other-pack']],
  ])(
    '壞輸入: packs:export and packs:remove with %s answer invalid-input and reach nothing',
    async (_label, args) => {
      expect(await invoke(packsExport.channel, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(await invoke(packsRemove.channel, ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(calls).toStrictEqual([]);
    },
  );

  it('壞輸入: a removal answer that fails the schema is invalid-output, not passed on', async () => {
    remove.mockReturnValue({
      ok: false,
      code: 'disk-full',
    } as unknown as PackRemoveResult);

    expect(await invoke(packsRemove.channel, 'sample-pack')).toMatchObject({
      ok: false,
      error: { code: 'invalid-output' },
    });
  });
});
