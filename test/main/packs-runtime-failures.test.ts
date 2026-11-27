/**
 * main/packs (Story 3.9): the sandbox failures the overlay reports
 * (`packs:runtime-failed`), counted per pack@version in the store's
 * memory, the answer (rebuild or not), the failure mark the first answer
 * with none puts on the store, and the run log line of each; and the
 * channel as the IPC layer registers it (overlay only, arguments checked),
 * over fake electron. The store is a real one in a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_SANDBOX_RENDERERS,
  registerPackSandboxHandlers,
} from '../../src/main/packs/ipc';
import { createRuntimeFailures } from '../../src/main/packs/runtime-failures';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import { PACK_RESTART_LIMIT } from '../../src/shared/constants';
import { packsRuntimeFailed } from '../../src/shared/ipc';
import type { PackIndexEntry } from '../../src/shared/packs';
import type {
  PackRuntimeFailedResult,
  PackRuntimeFailure,
} from '../../src/shared/sandbox';
import type { StageViewPacksSections } from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const OVERLAY_URL = 'app://overlay/index.html';

let dir: string;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.resetFakeElectron();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-runtime-failures-'));
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** An index entry of `packId` at `version`. */
function entry(version = '1.0.0', packId = 'sample-pack'): PackIndexEntry {
  return {
    id: packId,
    name: '範例包',
    version,
    apiVersion: '1.0',
    characters: [{ id: 'probe-one', name: '探針一', height: 110 }],
    servedPaths: ['entry.js'],
  };
}

/**
 * A store in the temp folder with `entries` installed, its folders made
 * (so a later load keeps them); the console lines so far are cleared.
 */
function storeWith(...entries: PackIndexEntry[]): PacksStore {
  const store = loadPacks({ dir });
  store.save(entries);
  for (const { id, version } of entries) {
    fs.mkdirSync(path.join(dir, id, version), { recursive: true });
  }
  vi.clearAllMocks();
  return store;
}

/** The mark of `packId` in the store's packs section, if any. */
function markOf(
  sections: StageViewPacksSections,
  packId = 'sample-pack',
): string | undefined {
  return sections.packs.installed.find((pack) => pack.id === packId)
    ?.runtimeFailed;
}

function failure(
  version = '1.0.0',
  reason: PackRuntimeFailure['reason'] = 'heartbeat-timeout',
  packId = 'sample-pack',
): PackRuntimeFailure {
  return { packId, version, reason };
}

describe('I/O matrix', () => {
  it(`第 4 次: the first ${PACK_RESTART_LIMIT} failures of the version installed are rebuilt, each with a warn line; the next one is not and marks the version failed with its reason (one change, nothing written); every one after is not rebuilt either and keeps the first reason`, () => {
    const store = storeWith(entry('1.0.0'));
    const index = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const heard: StageViewPacksSections[] = [];
    store.onChange((sections) => heard.push(sections));
    const failures = createRuntimeFailures(store);

    const answers = [
      failures.report(failure('1.0.0', 'heartbeat-timeout')),
      failures.report(failure('1.0.0', 'draw-timeout')),
      failures.report(failure('1.0.0', 'boot-timeout')),
    ];
    expect(heard).toStrictEqual([]);
    expect(markOf(store.get())).toBeUndefined();
    answers.push(
      failures.report(failure('1.0.0', 'worker-error')),
      failures.report(failure('1.0.0', 'entry-threw')),
    );

    expect(answers).toStrictEqual([
      { restart: true },
      { restart: true },
      { restart: true },
      { restart: false },
      { restart: false },
    ]);
    expect(heard).toHaveLength(1);
    expect(markOf(heard[0]!)).toBe('worker-error');
    expect(markOf(store.get())).toBe('worker-error');
    expect(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).toBe(index);
    expect(lines(warn)).toStrictEqual([
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (heartbeat-timeout; restart 1 of ${PACK_RESTART_LIMIT})`,
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (draw-timeout; restart 2 of ${PACK_RESTART_LIMIT})`,
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (boot-timeout; restart 3 of ${PACK_RESTART_LIMIT})`,
    ]);
    expect(lines(error)).toStrictEqual([
      `[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (worker-error; failure 4, past ${PACK_RESTART_LIMIT} restarts in this run): marked it failed; out of the pool until the pack is imported again or the app restarts`,
      `[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (entry-threw; failure 5, past ${PACK_RESTART_LIMIT} restarts in this run): marked failed already; out of the pool until the pack is imported again or the app restarts`,
    ]);
    expect(lines(info)).toStrictEqual([]);
  });

  it('新版本: another version installed counts from 0, unmarked; each pack counts on its own', () => {
    const store = storeWith(entry('1.0.0'), entry('2.0.0', 'other-pack'));
    const failures = createRuntimeFailures(store);
    for (let n = 0; n <= PACK_RESTART_LIMIT; n += 1) {
      failures.report(failure('1.0.0'));
    }
    expect(failures.report(failure('1.0.0'))).toStrictEqual({ restart: false });
    expect(markOf(store.get())).toBe('heartbeat-timeout');
    expect(
      failures.report(failure('2.0.0', 'heartbeat-timeout', 'other-pack')),
    ).toStrictEqual({ restart: true });
    expect(markOf(store.get(), 'other-pack')).toBeUndefined();

    store.save([
      ...store.list().filter((each) => each.id !== 'sample-pack'),
      entry('1.0.1'),
    ]);

    expect(markOf(store.get())).toBeUndefined();
    expect(failures.report(failure('1.0.1'))).toStrictEqual({ restart: true });
    expect(lines(warn).at(-1)).toBe(
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.1 (heartbeat-timeout; restart 1 of ${PACK_RESTART_LIMIT})`,
    );
  });

  it('不是目前的版本: a failure of a version not installed now (updated, or the pack removed, meanwhile) is not rebuilt and not counted', () => {
    const store = storeWith(entry('1.1.0'));
    const failures = createRuntimeFailures(store);
    for (let n = 0; n < PACK_RESTART_LIMIT; n += 1) {
      failures.report(failure('1.1.0'));
    }

    expect(failures.report(failure('1.0.0'))).toStrictEqual({
      restart: false,
    });
    // Not counted, and 1.1.0's count goes on: this is its 4th failure.
    expect(failures.report(failure('1.1.0'))).toStrictEqual({
      restart: false,
    });
    expect(markOf(store.get())).toBe('heartbeat-timeout');

    store.save([]);
    expect(failures.report(failure('1.1.0'))).toStrictEqual({
      restart: false,
    });
    expect(lines(info)).toStrictEqual([
      '[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (heartbeat-timeout): version 1.1.0 is installed; not counted',
      '[packs] pack sample-pack: removed; its 4 sandbox failures of version 1.1.0 this run and its failed mark are cleared',
      '[packs] pack sample-pack: not restarting its sandbox of version 1.1.0 (heartbeat-timeout): the pack is not installed; not counted',
    ]);
  });

  it('重新啟動 app: the counts and the mark are in memory only: the next run (a new store over the same folder) has no mark and counts from 0', () => {
    const store = storeWith(entry('1.0.0'));
    const first = createRuntimeFailures(store);
    for (let n = 0; n <= PACK_RESTART_LIMIT; n += 1) {
      first.report(failure());
    }
    expect(markOf(store.get())).toBe('heartbeat-timeout');

    const next = loadPacks({ dir });

    expect(next.list()).toStrictEqual([entry('1.0.0')]);
    expect(markOf(next.get())).toBeUndefined();
    expect(createRuntimeFailures(next).report(failure())).toStrictEqual({
      restart: true,
    });
  });
});

describe('packs:runtime-failed', () => {
  let reported: PackRuntimeFailure[];

  beforeEach(() => {
    reported = [];
    registerPackSandboxHandlers(
      async () => ({ ok: false, code: 'not-installed' }),
      () => {},
      () => ({ ok: false, code: 'not-installed' }),
      (each): PackRuntimeFailedResult => {
        reported.push(each);
        return { restart: reported.length === 1 };
      },
    );
    fake.sender.mainFrame.url = OVERLAY_URL;
  });

  function invoke(...args: unknown[]): Promise<unknown> {
    return fake.ipcRenderer.invoke(packsRuntimeFailed.channel, ...args);
  }

  it('is open to the overlay only', async () => {
    expect(PACK_SANDBOX_RENDERERS).toStrictEqual(['overlay']);
    fake.sender.mainFrame.url = 'app://panels/index.html';
    expect(await invoke(failure())).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(reported).toStrictEqual([]);
  });

  it("the overlay's failure reaches runtimeFailed, and its answer comes back", async () => {
    expect(await invoke(failure())).toStrictEqual({
      ok: true,
      data: { restart: true },
    });
    expect(await invoke(failure('1.0.0', 'draw-timeout'))).toStrictEqual({
      ok: true,
      data: { restart: false },
    });
    expect(reported).toStrictEqual([
      failure(),
      failure('1.0.0', 'draw-timeout'),
    ]);
  });

  it.each<[string, unknown[]]>([
    ['no argument', []],
    ['an unknown reason', [{ ...failure(), reason: 'tired' }]],
    ['a bad pack id', [{ ...failure(), packId: '_stage' }]],
    ['a bad version', [{ ...failure(), version: '1.0' }]],
    ['an extra field', [{ ...failure(), stack: 'x' }]],
    ['two failures', [failure(), failure()]],
  ])(
    '壞輸入: with %s it answers invalid-input and counts nothing',
    async (_label, args) => {
      expect(await invoke(...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(reported).toStrictEqual([]);
    },
  );
});
