/**
 * The Gemini CLI fixtures and the adapter's read-only promise (Story 2.6):
 *
 * - the fixtures hold only what the de-identification allowlist keeps (no
 *   text but the fixed ones), and no home-folder path;
 * - the de-identification script drops or replaces everything else;
 * - the whole adapter, real watcher included, run over a copy of the
 *   fixtures, leaves every file exactly as it was, and opens only chat
 *   logs, to read;
 * - with the real watcher, after the sync: an append, a chat log too old
 *   to replay being written, and a new subagent folder; and the same
 *   message written again with its tool calls well within chokidar's 50 ms
 *   change throttle, read by the trailing read with no later write.
 */
import nodeFs, {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRenumbering,
  deidentifyRecord,
  FIXTURE_PROJECT_HASH,
  FIXTURE_TEXT,
  FIXTURE_TITLE,
  FIXTURE_TOOL,
  fixtureProblems,
  REQUEST_CANCELLED,
} from '../../scripts/deidentify-gemini.mjs';
import type {
  AdapterContext,
  DetectionAdapter,
} from '../../src/main/detection/adapter';
import { createGeminiAdapter } from '../../src/main/detection/adapters/gemini/gemini';
import type { TranscriptFs } from '../../src/main/detection/adapters/jsonl/read';
import { createDetection } from '../../src/main/detection/detection';
import { TRAILING_READ_MS } from '../../src/shared/constants';
import type { AdapterOutput } from '../../src/shared/detection-events';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
} from '../../src/shared/settings';
import type { AdapterHealth } from '../../src/shared/sources';
import {
  arrives,
  diagnose,
  filesUnder,
  fingerprintFiles,
  REAL_WATCH_TEST_MS,
  REAL_WATCH_WAIT_MS,
  startReal,
  stopReal,
} from '../helpers/jsonl-adapter';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/gemini',
);

describe('the fixtures', () => {
  const files = filesUnder(FIXTURES);

  it('are all chat logs in the one fixture project', () => {
    expect(files.length).toBe(3);
    for (const file of files) {
      expect(file.split(path.sep).slice(0, 3)).toStrictEqual([
        'tmp',
        'fixture-project',
        'chats',
      ]);
      expect(path.basename(file)).toMatch(/^session-.+\.jsonl$/);
    }
  });

  it.each(files)('%s: no home-folder path anywhere', (file) => {
    const text = readFileSync(path.join(FIXTURES, file), 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:(\\\\|\\|\/)Users/i);
  });

  it.each(files)(
    '%s: every record keeps only what the allowlist keeps, and no text but the fixed ones',
    (file) => {
      const lines = readFileSync(path.join(FIXTURES, file), 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(fixtureProblems(JSON.parse(line))).toStrictEqual([]);
      }
    },
  );
});

describe('the de-identification script', () => {
  const renumber = () =>
    createRenumbering(Date.parse('2025-06-01T08:00:00.000Z'));

  it('keeps the header’s kind, renumbers its session id, fixes its project hash and shifts its times', () => {
    const out = deidentifyRecord(
      {
        sessionId: 'real-session',
        projectHash: 'abc123',
        startTime: '2025-06-01T08:00:00.000Z',
        lastUpdated: '2025-06-01T08:00:02.000Z',
        kind: 'main',
        directories: ['/Users/someone/secret'],
      },
      renumber(),
      true,
    );
    expect(out).toStrictEqual({
      sessionId: '00000001-0000-4000-8000-000000000000',
      projectHash: FIXTURE_PROJECT_HASH,
      startTime: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:02.000Z',
      kind: 'main',
    });
    expect(fixtureProblems(out)).toStrictEqual([]);
  });

  it('keeps of a message whether it is empty and whether it is a functionResponse; ids renumbered and matching', () => {
    const numbers = renumber();
    const out = [
      {
        id: 'm-1',
        timestamp: '2025-06-01T08:00:01.000Z',
        type: 'user',
        content: [{ text: 'my secret prompt' }, { inlineData: { data: 'x' } }],
      },
      {
        id: 'm-2',
        timestamp: '2025-06-01T08:00:02.000Z',
        type: 'gemini',
        content: '',
        model: 'some-model',
        thoughts: [{ subject: 'secret' }],
        tokens: { input: 5 },
      },
      {
        id: 'm-2',
        timestamp: '2025-06-01T08:00:02.000Z',
        type: 'gemini',
        content: 'private answer',
        toolCalls: [
          {
            id: 'run_shell_command__real1',
            name: 'run_shell_command',
            args: { command: 'cat ~/.ssh/id' },
            result: [{ functionResponse: { response: 'secret output' } }],
            status: 'success',
            timestamp: '2025-06-01T08:00:03.000Z',
            displayName: 'Shell',
            description: 'secret',
            resultDisplay: 'secret',
          },
          { id: 'company_db__q', name: 'company_db__query', status: 'error' },
        ],
      },
      {
        id: 'm-3',
        timestamp: '2025-06-01T08:00:04.000Z',
        type: 'user',
        content: [
          {
            functionResponse: {
              id: 'run_shell_command__real1',
              name: 'run_shell_command',
              response: { output: 'secret output' },
            },
          },
        ],
      },
      { id: 'm-4', type: 'info', content: REQUEST_CANCELLED },
      { id: 'm-5', type: 'info', content: 'Loaded /Users/me/secret' },
      { id: 'm-6', type: 'info', content: '   ' },
    ].map((record) => deidentifyRecord(record, numbers, false));
    expect(out).toStrictEqual([
      {
        type: 'user',
        id: '20000000-0000-4000-8000-000000000001',
        timestamp: '2026-01-01T00:00:01.000Z',
        content: [{ text: FIXTURE_TEXT }, {}],
      },
      {
        type: 'gemini',
        id: '20000000-0000-4000-8000-000000000002',
        timestamp: '2026-01-01T00:00:02.000Z',
        content: '',
      },
      {
        type: 'gemini',
        id: '20000000-0000-4000-8000-000000000002',
        timestamp: '2026-01-01T00:00:02.000Z',
        content: FIXTURE_TEXT,
        toolCalls: [
          {
            id: 'fixture_call_0001',
            name: 'run_shell_command',
            status: 'success',
            timestamp: '2026-01-01T00:00:03.000Z',
          },
          { id: 'fixture_call_0002', name: FIXTURE_TOOL, status: 'error' },
        ],
      },
      {
        type: 'user',
        id: '20000000-0000-4000-8000-000000000003',
        timestamp: '2026-01-01T00:00:04.000Z',
        content: [{ functionResponse: {} }],
      },
      {
        type: 'info',
        id: '20000000-0000-4000-8000-000000000004',
        content: REQUEST_CANCELLED,
      },
      {
        type: 'info',
        id: '20000000-0000-4000-8000-000000000005',
        content: FIXTURE_TEXT,
      },
      { type: 'info', id: '20000000-0000-4000-8000-000000000006', content: '' },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  it('keeps of $set only its keys: summary replaced, messages emptied, sessionId renumbered, every other value null; $rewindTo renumbered', () => {
    const numbers = renumber();
    const out = [
      {
        $set: {
          summary: 'Secret title',
          messages: [{ type: 'user', content: 'secret' }],
          lastUpdated: '2025-06-01T08:00:00.000Z',
          memoryScratchpad: { touchedPaths: ['/Users/me/secret'] },
          sessionId: 'real-next',
        },
      },
      { $rewindTo: 'm-9' },
    ].map((record) => deidentifyRecord(record, numbers, false));
    expect(out).toStrictEqual([
      {
        $set: {
          summary: FIXTURE_TITLE,
          messages: [],
          lastUpdated: null,
          memoryScratchpad: null,
          sessionId: '00000001-0000-4000-8000-000000000000',
        },
      },
      { $rewindTo: '20000000-0000-4000-8000-000000000001' },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  it('a blank or non-string $set.summary becomes null, not the fixture title', () => {
    const numbers = renumber();
    const out = [
      { $set: { summary: '   ' } },
      { $set: { summary: 42 } },
      { $set: { summary: null } },
    ].map((record) => deidentifyRecord(record, numbers, false));
    expect(out).toStrictEqual([
      { $set: { summary: null } },
      { $set: { summary: null } },
      { $set: { summary: null } },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  describe('run on files', () => {
    const SCRIPT = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../scripts/deidentify-gemini.mjs',
    );
    let dir: string;

    beforeEach(() => {
      dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-deid-')));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const run = (...inputs: string[]) =>
      spawnSync(
        process.execPath,
        [SCRIPT, '--out', path.join(dir, 'out'), ...inputs],
        { encoding: 'utf8' },
      );
    const input = (name: string, records: readonly unknown[]) => {
      const file = path.join(dir, name);
      writeFileSync(
        file,
        records.map((record) => `${JSON.stringify(record)}\n`).join(''),
      );
      return file;
    };
    const header = (sessionId: string) => ({
      sessionId,
      projectHash: 'secret-hash',
      startTime: '2025-06-01T08:00:00.000Z',
      lastUpdated: '2025-06-01T08:00:00.000Z',
      kind: 'main',
    });

    it("numbers every input's header first, in input order: each file is named by its header's id", () => {
      const first = input('first.jsonl', [
        header('real-a'),
        { $set: { sessionId: 'real-other' } },
      ]);
      const second = input('second.jsonl', [header('real-b')]);
      const result = run(first, second);
      expect(result.status).toBe(0);
      const chats = path.join(dir, 'out', 'fixture-project', 'chats');
      const written = readdirSync(chats).sort();
      expect(written).toStrictEqual([
        'session-2026-01-01T00-00-00000001.jsonl',
        'session-2026-01-01T00-00-00000002.jsonl',
      ]);
      for (const name of written) {
        const [headerLine] = readFileSync(path.join(chats, name), 'utf8').split(
          '\n',
        );
        const { sessionId } = JSON.parse(headerLine ?? '{}') as {
          sessionId: string;
        };
        expect(name).toContain(sessionId.slice(0, 8));
      }
      expect(`${result.stdout}${result.stderr}`).not.toContain(dir);
    });

    it('an input it cannot read: its number and error code only, nothing written, a failing exit', () => {
      const good = input('good.jsonl', [header('real-a')]);
      const missing = path.join(dir, 'secret-name.jsonl');
      const result = run(good, missing);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('input 2: ENOENT');
      expect(result.stderr).not.toContain('secret-name');
      expect(result.stderr).not.toContain(dir);
      expect(nodeFs.existsSync(path.join(dir, 'out'))).toBe(false);
    });
  });

  it('fixtureProblems names what breaks the allowlist, by field only', () => {
    expect(
      fixtureProblems({
        sessionId: 'real-session',
        projectHash: 'abc',
        directories: [],
      }),
    ).toStrictEqual([
      'header sessionId',
      'header projectHash',
      'header directories',
    ]);
    expect(
      fixtureProblems({
        type: 'gemini',
        id: 'm-1',
        content: [{ text: 'secret' }, { functionResponse: { response: 1 } }],
        toolCalls: [{ id: 'x', name: 'company_db__query', args: {} }],
        model: 'm',
      }),
    ).toStrictEqual([
      'value of id',
      'content part text',
      'content part functionResponse',
      'tool call id',
      'tool call name',
      'tool call args',
      'field model',
    ]);
    expect(
      fixtureProblems({ type: 'user', content: 'a prompt' }),
    ).toStrictEqual(['value of content']);
    expect(
      fixtureProblems({ $set: { summary: 'real', lastUpdated: 'x' } }),
    ).toStrictEqual(['$set summary', '$set lastUpdated']);
    expect(fixtureProblems({ $rewindTo: 'm-1' })).toStrictEqual([
      '$rewindTo record',
    ]);
    expect(fixtureProblems([])).toStrictEqual(['not an object']);
  });
});

describe('the whole adapter on a copy of the fixtures, real watcher included', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    // Resolved: the adapter watches the tmp folder's real path.
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-gemini-ro-')));
    root = path.join(tmp, 'tmp');
    cpSync(path.join(FIXTURES, 'tmp'), root, { recursive: true });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Windows may still hold the closed watcher's handles for a moment.
    rmSync(tmp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  const chats = () => path.join(root, 'fixture-project', 'chats');
  /** The fixture chat log of session N, and its session key. */
  const session = (n: number) => {
    const name = readdirSync(chats()).find((entry) =>
      entry.endsWith(`-0000000${n}.jsonl`),
    );
    if (name === undefined) {
      throw new Error(`no fixture session ${n}`);
    }
    return {
      file: path.join(chats(), name),
      key: `gemini:0000000${n}-0000-4000-8000-000000000000`,
      id: `0000000${n}-0000-4000-8000-000000000000`,
    };
  };
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const now = () => new Date().toISOString();

  it(
    'changes nothing and opens only chat logs, to read',
    async () => {
      // Files Gemini CLI keeps beside the chat logs: never opened.
      writeFileSync(path.join(root, 'fixture-project', 'logs.json'), '[]');
      writeFileSync(path.join(root, 'fixture-project', '.project_root'), '/x');
      writeFileSync(
        path.join(chats(), 'session-2025-01-01T00-00-legacy.json'),
        '{}',
      );
      const before = fingerprintFiles(tmp);
      const calls: string[] = [];
      const opened: { file: string; flags: string }[] = [];
      const spy: TranscriptFs = {
        readdirSync: (dir, options) => {
          calls.push('readdirSync');
          return nodeFs.readdirSync(dir, options);
        },
        statSync: (file) => {
          calls.push('statSync');
          return nodeFs.statSync(file);
        },
        realpathSync: (file) => {
          calls.push('realpathSync');
          return nodeFs.realpathSync(file);
        },
        openSync: (file, flags) => {
          calls.push('openSync');
          opened.push({ file, flags });
          return nodeFs.openSync(file, flags);
        },
        fstatSync: (fd) => {
          calls.push('fstatSync');
          return nodeFs.fstatSync(fd);
        },
        readSync: (fd, buffer, offset, length, position) => {
          calls.push('readSync');
          return nodeFs.readSync(fd, buffer, offset, length, position);
        },
        closeSync: (fd) => {
          calls.push('closeSync');
          nodeFs.closeSync(fd);
        },
      };
      const outputs: AdapterOutput[] = [];
      let health: AdapterHealth | undefined;
      const context: AdapterContext = {
        emit(batch, reported) {
          outputs.push(...batch);
          if (reported !== undefined) {
            health = reported;
          }
        },
        timings: () => SETTINGS_DEFAULTS,
        wallNow: Date.now,
        setTimer: (run, delayMs) => setTimeout(run, delayMs),
        clearTimer: (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      };
      const adapter = createGeminiAdapter({ root, fs: spy });
      adapter.start(context);
      await vi.waitFor(
        () => {
          expect(
            outputs.some((output) => output.type === 'sync.ready'),
            diagnose(outputs, health),
          ).toBe(true);
        },
        { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
      );
      adapter.stop();
      // Let the watcher finish closing.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(fingerprintFiles(tmp)).toStrictEqual(before);
      // Every chat log was read; nothing else was opened.
      expect(
        new Set(opened.map(({ file }) => path.relative(root, file))),
      ).toStrictEqual(
        new Set(filesUnder(root).filter((file) => file.endsWith('.jsonl'))),
      );
      for (const { file, flags } of opened) {
        expect(flags).toBe('r');
        expect(file.startsWith(chats() + path.sep)).toBe(true);
        expect(file.endsWith('.jsonl')).toBe(true);
      }
      expect(new Set(calls)).toStrictEqual(
        new Set([
          'readdirSync',
          'statSync',
          'realpathSync',
          'openSync',
          'fstatSync',
          'readSync',
          'closeSync',
        ]),
      );
      // The session opened with no prompt does not show.
      const sessions = new Set(
        outputs.flatMap((output) =>
          output.type === 'sync.ready' ? [] : [output.sessionKey],
        ),
      );
      expect(sessions).toStrictEqual(new Set([session(1).key, session(2).key]));
      expect(health).toBe('ok');
    },
    REAL_WATCH_TEST_MS,
  );

  it(
    'after the sync it reads an append, a chat log too old to replay, and a new subagent folder',
    async () => {
      // Outside the discovery window: neither replayed nor followed at start.
      const old = session(1);
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(old.file, threeHoursAgo, threeHoursAgo);
      const live = session(2);
      const { adapter, outputs } = await startReal(
        createGeminiAdapter({ root }),
      );
      expect(
        outputs.some(
          (output) =>
            output.type !== 'sync.ready' && output.sessionKey === old.key,
        ),
      ).toBe(false);

      // (a) An append to a recent chat log.
      appendFileSync(
        live.file,
        line({
          id: 'w-1',
          timestamp: now(),
          type: 'user',
          content: [{ text: '' }],
        }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === live.key &&
          output.type === 'turn.start' &&
          output.replay !== true,
      );

      // (b) The old chat log: picked up, replayed from its tail.
      appendFileSync(
        old.file,
        line({
          id: 'w-3',
          timestamp: now(),
          type: 'user',
          content: [{ text: '' }],
        }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === old.key &&
          output.type === 'turn.start' &&
          output.replay === true,
      );

      // (c) A subagent folder that was not there, three folders down: its
      // records are the parent's activity.
      const subDir = path.join(chats(), live.id);
      mkdirSync(subDir);
      writeFileSync(
        path.join(subDir, 'subagent-fixture-1.jsonl'),
        line({
          sessionId: 'f0000000-0000-4000-8000-000000000001',
          projectHash: FIXTURE_PROJECT_HASH,
          startTime: now(),
          lastUpdated: now(),
          kind: 'subagent',
        }) +
          line({
            id: 's-1',
            timestamp: now(),
            type: 'user',
            content: [{ text: '' }],
          }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === live.key &&
          output.type === 'activity' &&
          output.replay !== true,
      );

      await stopReal(adapter);
    },
    REAL_WATCH_TEST_MS,
  );

  it(
    'the same message written again with its tool calls well within 50 ms is read with no later write: back to 思考中',
    async () => {
      const live = session(2);
      const adapter = createGeminiAdapter({ root });
      const outputs: AdapterOutput[] = [];
      /** The real adapter, its outputs also kept for the failure message. */
      const tapped: DetectionAdapter = {
        source: adapter.source,
        start(context) {
          adapter.start({
            ...context,
            emit(batch, health) {
              outputs.push(...batch);
              context.emit(batch, health);
            },
          });
        },
        stop() {
          adapter.stop();
        },
      };
      const settings: SettingsState = {
        rev: 0,
        values: { ...SETTINGS_DEFAULTS },
      };
      // Real clocks and timers, so the trailing read runs as in the app.
      const detection = createDetection({
        settings: { get: () => settings, onChange: () => () => {} },
        monotonic: () => performance.now(),
        adapters: [tapped],
      });
      const stateOf = () =>
        detection.get().sessions.find((s) => s.sessionKey === live.key)?.state;
      const until = async (state: string, interval = 20) => {
        await vi.waitFor(
          () => {
            expect(stateOf(), diagnose(outputs)).toBe(state);
          },
          { timeout: REAL_WATCH_WAIT_MS, interval },
        );
      };
      try {
        await vi.waitFor(
          () => {
            expect(
              outputs.some((output) => output.type === 'sync.ready'),
              diagnose(outputs),
            ).toBe(true);
          },
          { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
        );
        appendFileSync(
          live.file,
          line({
            id: 'w-1',
            timestamp: now(),
            type: 'user',
            content: [{ text: '' }],
          }),
        );
        await until('thinking');
        // Past that write's change throttle and trailing read.
        await new Promise((resolve) =>
          setTimeout(resolve, 3 * TRAILING_READ_MS),
        );

        appendFileSync(
          live.file,
          line({ id: 'w-2', timestamp: now(), type: 'gemini', content: '' }),
        );
        // Polled every millisecond: the rewrite below lands a few ms after
        // the change of this write was reported, as Gemini CLI's ~20 ms
        // for a quick tool, well within chokidar's 50 ms, so chokidar
        // reports no change for it.
        await until('working', 1);
        appendFileSync(
          live.file,
          line({
            id: 'w-2',
            timestamp: now(),
            type: 'gemini',
            content: '',
            toolCalls: [
              {
                id: 'glob__w',
                name: 'glob',
                status: 'success',
                timestamp: now(),
              },
            ],
          }) +
            line({
              id: 'w-3',
              timestamp: now(),
              type: 'user',
              content: [{ functionResponse: {} }],
            }),
        );
        // Nothing is written after it: only the trailing read can see it.
        await until('thinking');
        expect(
          outputs.some(
            (output) =>
              output.type === 'tool.end' && output.toolCallId === 'glob__w',
          ),
        ).toBe(true);
      } finally {
        detection.stop();
        // Let the watcher finish closing.
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
    REAL_WATCH_TEST_MS,
  );
});
