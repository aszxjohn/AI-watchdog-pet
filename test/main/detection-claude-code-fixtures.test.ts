/**
 * The Claude Code fixtures and the adapter's read-only promise (Story 2.4):
 *
 * - the fixtures hold only what the de-identification allowlist keeps, and
 *   no home-folder path;
 * - the de-identification script drops everything else;
 * - the whole adapter, real watcher included, run over a copy of the
 *   fixtures, leaves every file exactly as it was, and opens only
 *   transcripts, to read.
 */
import nodeFs, {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRenumbering,
  deidentifyRecord,
  FIXTURE_CWD,
  FIXTURE_MCP_TOOL,
  FIXTURE_TITLE,
  fixtureProblems,
} from '../../scripts/deidentify-claude-code.mjs';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createClaudeCodeAdapter } from '../../src/main/detection/adapters/claude-code/claude-code';
import type { TranscriptFs } from '../../src/main/detection/adapters/jsonl/read';
import type { AdapterOutput } from '../../src/shared/detection-events';
import type { AdapterHealth } from '../../src/shared/sources';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
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
  '../fixtures/claude-code',
);

describe('the fixtures', () => {
  const files = filesUnder(FIXTURES);

  it('are all transcripts', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.jsonl')).toBe(true);
    }
  });

  it.each(files)('%s: no home-folder path anywhere', (file) => {
    const text = readFileSync(path.join(FIXTURES, file), 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:(\\\\|\\|\/)Users/i);
  });

  it.each(files)(
    '%s: every record keeps only what the allowlist keeps',
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

  it('keeps the allowlisted structure and drops or replaces everything else', () => {
    const record = {
      type: 'assistant',
      subtype: 'x',
      isMeta: false,
      isSidechain: true,
      isApiErrorMessage: true,
      timestamp: '2025-06-01T08:00:01.500Z',
      uuid: 'real-uuid',
      parentUuid: 'real-parent',
      sessionId: 'real-session',
      cwd: '/Users/someone/secret-project',
      gitBranch: 'feature/secret',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        model: 'some-model',
        usage: { input_tokens: 5 },
        content: [
          { type: 'thinking', thinking: 'private thoughts', signature: 'sig' },
          { type: 'text', text: 'private answer' },
          {
            type: 'tool_use',
            id: 'toolu_real',
            name: 'Bash',
            input: { command: 'cat ~/.ssh/id' },
          },
          {
            type: 'tool_use',
            id: 'toolu_mcp',
            name: 'mcp__company_db__query',
            input: {},
          },
        ],
      },
      toolUseResult: { stdout: 'secret output' },
    };
    const out = deidentifyRecord(record, renumber());
    expect(out).toStrictEqual({
      type: 'assistant',
      subtype: 'x',
      isMeta: false,
      isSidechain: true,
      isApiErrorMessage: true,
      timestamp: '2026-01-01T00:00:01.500Z',
      uuid: '10000000-0000-4000-8000-000000000001',
      cwd: FIXTURE_CWD,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking' },
          { type: 'text' },
          { type: 'tool_use', id: 'toolu_fixture_0001', name: 'Bash' },
          {
            type: 'tool_use',
            id: 'toolu_fixture_0002',
            name: FIXTURE_MCP_TOOL,
          },
        ],
      },
    });
    expect(fixtureProblems(out)).toStrictEqual([]);
  });

  it('keeps prompts a string but empty, interrupt texts as they are, titles replaced, ids matching', () => {
    const numbers = renumber();
    const out = [
      { type: 'user', message: { role: 'user', content: 'my secret prompt' } },
      { type: 'user', message: { content: '[Request interrupted by user]' } },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_a',
              content: 'secret',
              is_error: true,
            },
            {
              type: 'text',
              text: '[Request interrupted by user for tool use]',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read' }],
        },
      },
      { type: 'custom-title', customTitle: 'Secret title', sessionId: 's' },
      { type: 'ai-title', aiTitle: 'Secret AI title' },
      { type: 'last-prompt', lastPrompt: 'secret' },
    ].map((record) => deidentifyRecord(record, numbers));
    expect(out).toStrictEqual([
      { type: 'user', message: { role: 'user', content: '' } },
      { type: 'user', message: { content: '[Request interrupted by user]' } },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_fixture_0001' },
            {
              type: 'text',
              text: '[Request interrupted by user for tool use]',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_fixture_0001', name: 'Read' },
          ],
        },
      },
      { type: 'custom-title', customTitle: FIXTURE_TITLE },
      { type: 'ai-title', aiTitle: FIXTURE_TITLE },
      { type: 'last-prompt' },
    ]);
    for (const record of out) {
      expect(fixtureProblems(record)).toStrictEqual([]);
    }
  });

  it('fixtureProblems names what breaks the allowlist, by field only', () => {
    expect(
      fixtureProblems({
        type: 'user',
        sessionId: 'x',
        cwd: '/Users/me',
        customTitle: 'real title',
        message: {
          content: [
            { type: 'text', text: 'secret' },
            { type: 'tool_use', id: 'toolu_real', input: {} },
          ],
          model: 'm',
        },
      }),
    ).toStrictEqual([
      'field sessionId',
      'value of cwd',
      'value of customTitle',
      'content block text',
      'content block id',
      'content block input',
      'field message.model',
    ]);
    expect(fixtureProblems({ message: { content: 'a prompt' } })).toStrictEqual(
      ['value of message.content'],
    );
    expect(fixtureProblems([])).toStrictEqual(['not an object']);
  });
});

describe('the whole adapter on a copy of the fixtures, real watcher included', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    // Resolved: the adapter watches the projects folder's real path.
    tmp = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'awp-claude-code-ro-')),
    );
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

  /** Each file's path, size, modification time and content hash. */
  const fingerprint = () => fingerprintFiles(tmp);

  it(
    'the whole adapter, real watcher included, changes nothing and opens only transcripts, to read',
    async () => {
      const before = fingerprint();
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
      const adapter = createClaudeCodeAdapter({ root, fs: spy });
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

      expect(fingerprint()).toStrictEqual(before);
      // Every transcript was replayed: six sessions and one subagent.
      expect(
        new Set(opened.map(({ file }) => path.relative(root, file))),
      ).toStrictEqual(new Set(filesUnder(root)));
      for (const { file, flags } of opened) {
        expect(flags).toBe('r');
        expect(file.startsWith(root + path.sep)).toBe(true);
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
      expect(sessions.size).toBe(6);
    },
    REAL_WATCH_TEST_MS,
  );

  const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const projectDir = () => path.join(root, '-fixture-project');
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const now = () => new Date().toISOString();

  it(
    'after the sync it reads appends to a session, to a subagent, and to a transcript too old to replay',
    async () => {
      // Outside the discovery window: neither replayed nor followed at start.
      const old = path.join(projectDir(), `${ID(2)}.jsonl`);
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(old, threeHoursAgo, threeHoursAgo);
      const { adapter, outputs } = await startReal(
        createClaudeCodeAdapter({ root }),
      );
      expect(
        outputs.some(
          (output) =>
            output.type !== 'sync.ready' &&
            output.sessionKey === `claude-code:${ID(2)}`,
        ),
      ).toBe(false);

      // (a) A recent session's transcript.
      appendFileSync(
        path.join(projectDir(), `${ID(1)}.jsonl`),
        line({
          type: 'user',
          timestamp: now(),
          message: { role: 'user', content: '' },
        }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === `claude-code:${ID(1)}` &&
          output.type === 'turn.start' &&
          output.replay !== true,
      );

      // (b) A subagent's transcript, three folders down: its tool call is
      // the parent's.
      appendFileSync(
        path.join(projectDir(), ID(3), 'subagents', 'agent-fixture-1.jsonl'),
        line({
          type: 'assistant',
          timestamp: now(),
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_watch_1', name: 'Bash' }],
          },
        }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === `claude-code:${ID(3)}` &&
          output.type === 'tool.start' &&
          output.toolCallId === 'toolu_watch_1',
      );

      // (c) The old transcript: picked up, replayed from its tail.
      appendFileSync(
        old,
        line({
          type: 'user',
          timestamp: now(),
          message: { role: 'user', content: '' },
        }),
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === `claude-code:${ID(2)}` &&
          output.type === 'turn.start' &&
          output.replay === true,
      );

      await stopReal(adapter);
    },
    REAL_WATCH_TEST_MS,
  );

  it(
    'the projects folder removed: missing; back with a transcript: ok, and the session appears',
    async () => {
      const { adapter, outputs, state } = await startReal(
        createClaudeCodeAdapter({ root }),
      );
      expect(state.health).toBe('ok');

      rmSync(root, { recursive: true, force: true });
      await vi.waitFor(
        () => {
          expect(state.health, diagnose(outputs, state.health)).toBe('missing');
        },
        { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
      );

      const id = 'eeeeeeee-0000-4000-8000-000000000001';
      mkdirSync(projectDir(), { recursive: true });
      writeFileSync(
        path.join(projectDir(), `${id}.jsonl`),
        line({
          type: 'user',
          timestamp: now(),
          cwd: '/fixture/project',
          message: { role: 'user', content: '' },
        }),
      );
      await vi.waitFor(
        () => {
          expect(state.health, diagnose(outputs, state.health)).toBe('ok');
        },
        { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
      );
      await arrives(
        outputs,
        (output) =>
          output.sessionKey === `claude-code:${id}` &&
          output.type === 'turn.start',
      );

      await stopReal(adapter);
    },
    REAL_WATCH_TEST_MS,
  );
});
