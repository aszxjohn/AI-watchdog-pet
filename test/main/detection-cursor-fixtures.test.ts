/**
 * The Cursor fixtures and the adapter's read-only promise (Story 2.7):
 *
 * - the fixtures hold only what the de-identification allowlist keeps (no
 *   text but the fixed ones), and no home-folder path;
 * - the de-identification script drops or replaces everything else;
 * - the whole adapter, real watcher included, run over a copy of the
 *   fixtures, leaves every file exactly as it was, and opens only
 *   transcripts, to read;
 * - with the real watcher, after the sync: an append, a transcript written
 *   anew and smaller, a new session folder and a new subagent folder.
 */
import nodeFs, {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_TOOLS,
  createRenumbering,
  deidentifyRecord,
  FIXTURE_ERROR,
  FIXTURE_PROMPT,
  FIXTURE_REPLY,
  FIXTURE_SLUG,
  FIXTURE_TOOL,
  fixtureProblems,
  inputKindOf,
  USER_ABORTED,
} from '../../scripts/deidentify-cursor.mjs';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createCursorAdapter } from '../../src/main/detection/adapters/cursor/cursor';
import type { TranscriptFs } from '../../src/main/detection/adapters/jsonl/read';
import type { AdapterOutput } from '../../src/shared/detection-events';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import {
  SOURCE_CAPABILITIES,
  type AdapterHealth,
} from '../../src/shared/sources';
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
  '../fixtures/cursor',
);

const fixtureId = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('the fixtures', () => {
  const files = filesUnder(FIXTURES);

  it('are all transcripts in the one fixture project, laid out as Cursor does', () => {
    expect(files.length).toBe(5);
    for (const file of files) {
      const parts = file.split(path.sep);
      expect(parts.slice(0, 3)).toStrictEqual([
        'projects',
        FIXTURE_SLUG,
        'agent-transcripts',
      ]);
      const [, , , id = '', ...rest] = parts;
      expect(id).toMatch(/^\d{8}-0000-4000-8000-000000000000$/);
      expect(
        rest.length === 1
          ? rest[0] === `${id}.jsonl`
          : rest[0] === 'subagents' &&
              /^\d{8}-0000-4000-8000-000000000000\.jsonl$/.test(rest[1] ?? ''),
      ).toBe(true);
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

  it("keep Cursor's question tool and no-guess tools among its own tools", () => {
    const capability = SOURCE_CAPABILITIES.cursor;
    for (const tool of [
      ...capability.questionTools,
      ...capability.noInferTools,
    ]) {
      expect(CURSOR_TOOLS).toContain(tool);
    }
  });
});

describe('the de-identification script', () => {
  it('keeps of a message its role and its parts’ types: texts fixed, tool names Cursor’s own, inputs emptied', () => {
    const out = [
      {
        role: 'user',
        message: {
          content: [
            { type: 'text', text: 'my secret prompt' },
            { type: 'image', data: 'secret', mimeType: 'image/png' },
          ],
          id: 'secret',
        },
        extra: '/Users/me/secret',
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'private answer' },
            { type: 'text', text: '   ' },
            {
              type: 'tool_use',
              name: 'Shell',
              input: { command: 'cat ~/.ssh/id', cwd: '/Users/me/secret' },
              id: 'call-1',
            },
            { type: 'tool_use', name: 'company_db_query', input: {} },
            { type: 'tool_use', input: 'x' },
            'a string part',
            { type: 'Thinking Secret', text: 'secret' },
          ],
        },
      },
      { role: 'assistant', message: { content: 'a string reply' } },
      { role: 'assistant', message: 'secret' },
    ].map(deidentifyRecord);
    expect(out).toStrictEqual([
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: FIXTURE_PROMPT }, { type: 'image' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: FIXTURE_REPLY },
            { type: 'text', text: '' },
            { type: 'tool_use', name: 'Shell', input: {} },
            { type: 'tool_use', name: FIXTURE_TOOL, input: {} },
            { type: 'tool_use', name: FIXTURE_TOOL, input: {} },
            {},
            {},
          ],
        },
      },
      { role: 'assistant', message: { content: FIXTURE_REPLY } },
      { role: 'assistant' },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  it(`keeps of a turn end its status; its error when it is ${USER_ABORTED}, else a fixed one`, () => {
    const out = [
      { type: 'turn_ended', status: 'success', durationMs: 5 },
      { type: 'turn_ended', status: 'error', error: USER_ABORTED },
      {
        type: 'turn_ended',
        status: 'error',
        error: 'ENOENT: /Users/me/secret',
      },
      { type: 'turn_ended', status: 'Secret Status', error: 42 },
    ].map(deidentifyRecord);
    expect(out).toStrictEqual([
      { type: 'turn_ended', status: 'success' },
      { type: 'turn_ended', status: 'error', error: USER_ABORTED },
      { type: 'turn_ended', status: 'error', error: FIXTURE_ERROR },
      { type: 'turn_ended', error: FIXTURE_ERROR },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  it('keeps of any other record its codes only', () => {
    expect(
      deidentifyRecord({ type: 'summary', text: 'secret', status: 'ok' }),
    ).toStrictEqual({ type: 'summary', status: 'ok' });
    expect(deidentifyRecord({ type: 'Not A Code', role: 7 })).toStrictEqual({});
  });

  it('tells a subagent’s transcript from a session’s by its folder', () => {
    const at = (...parts: string[]) => path.join(path.sep, 'p', ...parts);
    expect(
      inputKindOf(at('s', 'agent-transcripts', 'x', 'x.jsonl')),
    ).toStrictEqual({ kind: 'main', id: 'x', sessionId: 'x' });
    expect(
      inputKindOf(at('s', 'agent-transcripts', 'x', 'subagents', 'y.jsonl')),
    ).toStrictEqual({ kind: 'subagent', id: 'y', sessionId: 'x' });
  });

  it('renumbers ids in the order it first sees them', () => {
    const renumber = createRenumbering();
    expect(renumber.id('b')).toBe(fixtureId(1));
    expect(renumber.id('a')).toBe(fixtureId(2));
    expect(renumber.id('b')).toBe(fixtureId(1));
  });

  it('fixtureProblems names what breaks the allowlist, by field only', () => {
    expect(
      fixtureProblems({
        role: 'user',
        message: {
          content: [
            { type: 'text', text: 'secret' },
            { type: 'tool_use', name: 'company_db', input: { a: 1 } },
            { type: 'text', name: 'Shell' },
            { type: 'image', data: 'x' },
            'part',
          ],
          id: 'x',
        },
        id: 'x',
      }),
    ).toStrictEqual([
      'content part text',
      'content part name',
      'content part input',
      'content part name',
      'content part data',
      'a content part that is not an object',
      'message field id',
      'field id',
    ]);
    expect(
      fixtureProblems({ role: 'user', message: { content: 'a prompt' } }),
    ).toStrictEqual(['value of content']);
    expect(
      fixtureProblems({
        type: 'turn_ended',
        status: 'error',
        error: 'secret',
        at: 1,
      }),
    ).toStrictEqual(['turn end error', 'turn end at']);
    expect(fixtureProblems({ role: 'Secret Role' })).toStrictEqual([
      'value of role',
    ]);
    expect(fixtureProblems([])).toStrictEqual(['not an object']);
  });

  describe('run on files', () => {
    const SCRIPT = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../scripts/deidentify-cursor.mjs',
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
    const input = (parts: readonly string[], records: readonly unknown[]) => {
      const file = path.join(dir, 'secret-project', ...parts);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        records.map((record) => `${JSON.stringify(record)}\n`).join(''),
      );
      return file;
    };
    const user = {
      role: 'user',
      message: { content: [{ type: 'text', text: 'x' }] },
    };

    it('lays sessions and subagents out as Cursor does, sessions numbered first; prints counts only', () => {
      const sub = input(['real-b', 'subagents', 'real-sub.jsonl'], [user]);
      const a = input(
        ['real-a', 'real-a.jsonl'],
        [user, { type: 'turn_ended', status: 'success' }],
      );
      const b = input(['real-b', 'real-b.jsonl'], [user]);
      const result = run(sub, a, b);
      expect(result.status).toBe(0);
      const out = path.join(dir, 'out');
      expect(
        filesUnder(out).map((file) => file.split(path.sep).join('/')),
      ).toStrictEqual([
        `${FIXTURE_SLUG}/agent-transcripts/${fixtureId(1)}/${fixtureId(1)}.jsonl`,
        `${FIXTURE_SLUG}/agent-transcripts/${fixtureId(2)}/${fixtureId(2)}.jsonl`,
        `${FIXTURE_SLUG}/agent-transcripts/${fixtureId(2)}/subagents/${fixtureId(3)}.jsonl`,
      ]);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(dir);
      expect(output).not.toContain('real-');
      expect(output).not.toContain('secret');
    });

    it('an input it cannot read: its number and error code only, nothing written, a failing exit', () => {
      const good = input(['real-a', 'real-a.jsonl'], [user]);
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
});

describe('the whole adapter on a copy of the fixtures, real watcher included', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    // Resolved: the adapter watches the projects folder's real path.
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-cursor-ro-')));
    root = path.join(tmp, 'projects');
    cpSync(path.join(FIXTURES, 'projects'), root, { recursive: true });
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

  const project = () => path.join(root, FIXTURE_SLUG);
  const transcripts = () => path.join(project(), 'agent-transcripts');
  /** Fixture session N's transcript, folder and session key. */
  const session = (n: number) => {
    const id = fixtureId(n);
    const dir = path.join(transcripts(), id);
    return {
      id,
      dir,
      file: path.join(dir, `${id}.jsonl`),
      key: `cursor:${id}`,
    };
  };
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const user = {
    role: 'user',
    message: { content: [{ type: 'text', text: '' }] },
  };

  it(
    'changes nothing and opens only transcripts, to read',
    async () => {
      // What Cursor keeps beside the transcripts: never opened.
      writeFileSync(path.join(root, 'notes.json'), '{}');
      for (const folder of [
        'canvases',
        'mcps',
        'assets',
        'agent-tools',
        'terminals',
      ]) {
        mkdirSync(path.join(project(), folder));
        writeFileSync(path.join(project(), folder, 'x.jsonl'), line(user));
      }
      writeFileSync(path.join(session(1).dir, 'notes.jsonl'), line(user));
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
      // The default stat (the injected file system's): stats only.
      const adapter = createCursorAdapter({ root, fs: spy });
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
      // Every transcript was read; nothing else was opened.
      expect(
        new Set(opened.map(({ file }) => path.relative(root, file))),
      ).toStrictEqual(new Set(filesUnder(path.join(FIXTURES, 'projects'))));
      for (const { file, flags } of opened) {
        expect(flags).toBe('r');
        expect(file.startsWith(transcripts() + path.sep)).toBe(true);
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
      const sessions = new Set(
        outputs.flatMap((output) =>
          output.type === 'sync.ready' ? [] : [output.sessionKey],
        ),
      );
      expect(sessions).toStrictEqual(
        new Set([1, 2, 3, 4].map((n) => session(n).key)),
      );
      // No folder is named after the fixture slug: named after the slug.
      expect(
        new Set(
          outputs.flatMap((output) =>
            output.type === 'session.meta' ? [output.displayName] : [],
          ),
        ),
      ).toStrictEqual(new Set([FIXTURE_SLUG]));
      expect(health).toBe('ok');
    },
    REAL_WATCH_TEST_MS,
  );

  it(
    'after the sync it reads an append, a transcript written anew and smaller, a new session folder and a new subagent folder',
    async () => {
      const live = session(2);
      const { adapter, outputs } = await startReal(
        createCursorAdapter({ root }),
      );

      // (a) An append to a recent transcript.
      appendFileSync(live.file, line(user));
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === live.key &&
          output.type === 'turn.start' &&
          output.replay !== true,
      );

      // (b) Written anew, smaller: its first two records, then a new one.
      const rewritten = session(1);
      const kept = readFileSync(rewritten.file, 'utf8')
        .split('\n')
        .slice(0, 2)
        .map((text) => `${text}\n`)
        .join('');
      const from = outputs.length;
      writeFileSync(rewritten.file, kept + line(user));
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === rewritten.key &&
          output.type === 'turn.start' &&
          output.replay !== true,
      );
      const since = outputs
        .slice(from)
        .filter(
          (output) =>
            output.type !== 'sync.ready' &&
            output.sessionKey === rewritten.key &&
            output.type !== 'session.meta',
        )
        .map((output) => output.type);
      expect(since).toStrictEqual(['turn.start']);

      // (c) A new session's folder, three folders down.
      const fresh = fixtureId(9);
      mkdirSync(path.join(transcripts(), fresh));
      writeFileSync(
        path.join(transcripts(), fresh, `${fresh}.jsonl`),
        line(user),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === `cursor:${fresh}` &&
          output.type === 'session.start' &&
          output.replay !== true,
      );

      // (d) A subagent folder that was not there, four folders down: its
      // records are the parent's activity.
      const subDir = path.join(live.dir, 'subagents');
      mkdirSync(subDir);
      writeFileSync(path.join(subDir, `${fixtureId(8)}.jsonl`), line(user));
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
});
