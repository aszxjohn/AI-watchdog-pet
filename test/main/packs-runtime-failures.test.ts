/**
 * main/packs (Story 3.9): the sandbox failures the overlay reports
 * (`packs:runtime-failed`), counted per pack@version in memory, the
 * answer (rebuild or not) and the run log line of each; and the channel as
 * the IPC layer registers it (overlay only, arguments checked), over fake
 * electron. The store is a fake `find`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_SANDBOX_RENDERERS,
  registerPackSandboxHandlers,
} from '../../src/main/packs/ipc';
import { createRuntimeFailures } from '../../src/main/packs/runtime-failures';
import {
  PACK_RESTART_LIMIT,
  SANDBOX_IDLE_MS,
} from '../../src/shared/constants';
import { packsRuntimeFailed } from '../../src/shared/ipc';
import type { PackIndexEntry } from '../../src/shared/packs';
import type {
  PackRuntimeFailedResult,
  PackRuntimeFailure,
} from '../../src/shared/sandbox';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const OVERLAY_URL = 'app://overlay/index.html';

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.resetFakeElectron();
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

/** A store whose installed versions are `versions` (pack id → version). */
function storeOf(versions: Record<string, string>) {
  return {
    find: (packId: string) =>
      versions[packId] === undefined
        ? undefined
        : ({ id: packId, version: versions[packId] } as PackIndexEntry),
  };
}

function failure(
  version = '1.0.0',
  reason: PackRuntimeFailure['reason'] = 'heartbeat-timeout',
  packId = 'sample-pack',
): PackRuntimeFailure {
  return { packId, version, reason };
}

describe('I/O matrix', () => {
  it(`第 4 次: the first ${PACK_RESTART_LIMIT} failures of the version installed are rebuilt, each with a warn line; the next one, and every one after, is not, with an error line`, () => {
    const failures = createRuntimeFailures(storeOf({ 'sample-pack': '1.0.0' }));

    const answers = [
      failures.report(failure('1.0.0', 'heartbeat-timeout')),
      failures.report(failure('1.0.0', 'draw-timeout')),
      failures.report(failure('1.0.0', 'boot-timeout')),
      failures.report(failure('1.0.0', 'worker-error')),
      failures.report(failure('1.0.0', 'entry-threw')),
    ];

    expect(answers).toStrictEqual([
      { restart: true },
      { restart: true },
      { restart: true },
      { restart: false },
      { restart: false },
    ]);
    expect(lines(warn)).toStrictEqual([
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (heartbeat-timeout; restart 1 of ${PACK_RESTART_LIMIT})`,
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (draw-timeout; restart 2 of ${PACK_RESTART_LIMIT})`,
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.0 (boot-timeout; restart 3 of ${PACK_RESTART_LIMIT})`,
    ]);
    expect(lines(error)).toStrictEqual([
      `[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (worker-error; failure 4, past ${PACK_RESTART_LIMIT} restarts in this run): not rebuilt now, its actors stay in the placeholder; it boots again only once it has had no actor for ${SANDBOX_IDLE_MS} ms and one comes back`,
      `[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (entry-threw; failure 5, past ${PACK_RESTART_LIMIT} restarts in this run): not rebuilt now, its actors stay in the placeholder; it boots again only once it has had no actor for ${SANDBOX_IDLE_MS} ms and one comes back`,
    ]);
    expect(lines(info)).toStrictEqual([]);
  });

  it('新版本: another version installed counts from 0; each pack counts on its own', () => {
    const versions: Record<string, string> = {
      'sample-pack': '1.0.0',
      'other-pack': '2.0.0',
    };
    const failures = createRuntimeFailures(storeOf(versions));
    for (let n = 0; n <= PACK_RESTART_LIMIT; n += 1) {
      failures.report(failure('1.0.0'));
    }
    expect(failures.report(failure('1.0.0'))).toStrictEqual({ restart: false });
    expect(
      failures.report(failure('2.0.0', 'heartbeat-timeout', 'other-pack')),
    ).toStrictEqual({ restart: true });

    versions['sample-pack'] = '1.0.1';
    expect(failures.report(failure('1.0.1'))).toStrictEqual({ restart: true });
    expect(lines(warn).at(-1)).toBe(
      `[packs] pack sample-pack: restarting its sandbox of version 1.0.1 (heartbeat-timeout; restart 1 of ${PACK_RESTART_LIMIT})`,
    );
  });

  it('不是目前的版本: a failure of a version not installed now (updated, or the pack removed, meanwhile) is not rebuilt and not counted', () => {
    const versions: Record<string, string> = { 'sample-pack': '1.1.0' };
    const failures = createRuntimeFailures(storeOf(versions));

    expect(failures.report(failure('1.0.0'))).toStrictEqual({
      restart: false,
    });
    delete versions['sample-pack'];
    expect(failures.report(failure('1.1.0'))).toStrictEqual({
      restart: false,
    });
    expect(lines(info)).toStrictEqual([
      '[packs] pack sample-pack: not restarting its sandbox of version 1.0.0 (heartbeat-timeout): version 1.1.0 is installed; not counted',
      '[packs] pack sample-pack: not restarting its sandbox of version 1.1.0 (heartbeat-timeout): the pack is not installed; not counted',
    ]);

    // Neither counted: 1.1.0 back, it still has all its restarts.
    versions['sample-pack'] = '1.1.0';
    const answers = Array.from({ length: PACK_RESTART_LIMIT + 1 }, () =>
      failures.report(failure('1.1.0')),
    );
    expect(answers.map(({ restart }) => restart)).toStrictEqual([
      ...Array.from({ length: PACK_RESTART_LIMIT }, () => true),
      false,
    ]);
  });

  it('只存在記憶體: a new counter (a new run) counts from 0', () => {
    const store = storeOf({ 'sample-pack': '1.0.0' });
    const first = createRuntimeFailures(store);
    for (let n = 0; n <= PACK_RESTART_LIMIT; n += 1) {
      first.report(failure());
    }
    expect(first.report(failure())).toStrictEqual({ restart: false });

    expect(createRuntimeFailures(store).report(failure())).toStrictEqual({
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
