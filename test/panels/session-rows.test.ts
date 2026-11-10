import { describe, expect, it } from 'vitest';
import {
  ADAPTERS_HEADING,
  adapterRows,
  DEMO_MODE_HINT,
  INFERRED_LABEL,
  nativeIdOf,
  NO_ADAPTERS_TEXT,
  NO_SESSIONS_TEXT,
  SESSION_COLUMNS,
  sessionRows,
  SESSIONS_HEADING,
} from '../../src/panels/session-rows';
import type { StageAdapter, StageSession } from '../../src/shared/stage-view';
import { STATE_CODES, STATE_DISPLAY_NAMES } from '../../src/shared/states';

const DEMO: StageSession = {
  sessionKey: 'demo:1',
  source: 'demo',
  displayName: '示範',
  state: 'approval',
  confidence: 'exact',
};

function session(fields: Partial<StageSession>): StageSession {
  return { ...DEMO, ...fields };
}

describe('sessionRows', () => {
  it('I/O matrix 打開示範模式: the demo session reads 示範 / 示範 / 要你批准', () => {
    expect(sessionRows({ sessions: [DEMO] })).toStrictEqual([
      {
        key: 'demo:1',
        source: '示範',
        name: '示範',
        state: '要你批准',
        stateCode: 'approval',
        inferred: false,
      },
    ]);
  });

  it.each(STATE_CODES)('shows the state %s by its Chinese name', (state) => {
    const [row] = sessionRows({ sessions: [session({ state })] });
    expect(row?.state).toBe(STATE_DISPLAY_NAMES[state]);
    expect(row?.stateCode).toBe(state);
  });

  it('I/O matrix 推測標示: an inferred state is marked, an exact one is not', () => {
    const rows = sessionRows({
      sessions: [
        session({
          sessionKey: 'codex:a',
          source: 'codex',
          displayName: 'a',
          confidence: 'inferred',
        }),
        session({
          sessionKey: 'codex:b',
          source: 'codex',
          displayName: 'b',
          state: 'working',
        }),
      ],
    });
    expect(
      rows.map((row) => [row.name, row.state, row.inferred]),
    ).toStrictEqual([
      ['a', '要你批准', true],
      ['b', '工作中', false],
    ]);
    expect(INFERRED_LABEL).toBe('推測');
  });

  it('shows the native id while the session has no display name', () => {
    const [row] = sessionRows({
      sessions: [
        session({
          sessionKey: 'claude-code:5f0c-a:b',
          source: 'claude-code',
          displayName: null,
        }),
      ],
    });
    expect(row?.name).toBe('5f0c-a:b');
    expect(row?.source).toBe('Claude Code');
  });

  it('orders rows by source, then name, then key, whatever order they come in', () => {
    const rows = sessionRows({
      sessions: [
        session({ sessionKey: 'demo:1', source: 'demo', displayName: '示範' }),
        session({ sessionKey: 'codex:z', source: 'codex', displayName: 'b' }),
        session({ sessionKey: 'codex:y', source: 'codex', displayName: 'b' }),
        session({ sessionKey: 'codex:x', source: 'codex', displayName: 'a' }),
        session({
          sessionKey: 'claude-code:q',
          source: 'claude-code',
          displayName: null,
        }),
        session({ sessionKey: 'cursor:p', source: 'cursor', displayName: 'a' }),
      ],
    });
    expect(rows.map((row) => row.key)).toStrictEqual([
      'claude-code:q',
      'codex:x',
      'codex:y',
      'codex:z',
      'cursor:p',
      'demo:1',
    ]);
  });

  it('keeps the order when a state changes', () => {
    const sessions = [
      session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
      session({ sessionKey: 'codex:b', source: 'codex', displayName: 'b' }),
    ];
    const before = sessionRows({ sessions }).map((row) => row.key);
    const after = sessionRows({
      sessions: [
        { ...sessions[1], state: 'error' } as StageSession,
        { ...sessions[0], state: 'idle' } as StageSession,
      ],
    }).map((row) => row.key);
    expect(after).toStrictEqual(before);
  });

  it('I/O matrix 沒有 session: no row, and the page text says so and points at 示範模式', () => {
    expect(sessionRows({ sessions: [] })).toStrictEqual([]);
    expect(NO_SESSIONS_TEXT).toBe('目前沒有偵測到 session');
    // The icon is in the menu bar on macOS, the notification area on Windows.
    expect(DEMO_MODE_HINT).toContain('選單列或系統匣');
    expect(DEMO_MODE_HINT).toContain('「示範模式」');
  });

  it('leaves the StageView list as it was', () => {
    const sessions = Object.freeze([
      session({ sessionKey: 'demo:2' }),
      session({ sessionKey: 'demo:1' }),
    ]);
    sessionRows({ sessions: sessions as StageSession[] });
    expect(sessions.map((s) => s.sessionKey)).toStrictEqual([
      'demo:2',
      'demo:1',
    ]);
  });

  it('has the column headings 來源, 名稱, 狀態', () => {
    expect([...SESSION_COLUMNS]).toStrictEqual(['來源', '名稱', '狀態']);
    expect(SESSIONS_HEADING).toContain('session');
  });
});

describe('nativeIdOf', () => {
  it.each([
    ['demo:1', '1'],
    ['claude-code:5f0c', '5f0c'],
    ['cursor:a:b:c', 'a:b:c'],
  ])('%s -> %s', (key, id) => {
    expect(nativeIdOf(key)).toBe(id);
  });
});

describe('adapterRows', () => {
  it('I/O matrix 打開示範模式: demo reads 示範 / 正常', () => {
    expect(
      adapterRows({ adapters: [{ source: 'demo', health: 'ok' }] }),
    ).toStrictEqual([
      { key: 'demo', source: '示範', health: '正常', healthCode: 'ok' },
    ]);
  });

  it('names every health and orders by source', () => {
    const adapters: StageAdapter[] = [
      { source: 'demo', health: 'ok' },
      { source: 'cursor', health: 'missing' },
      { source: 'claude-code', health: 'degraded' },
    ];
    expect(
      adapterRows({ adapters }).map((row) => [row.source, row.health]),
    ).toStrictEqual([
      ['Claude Code', '部分可用'],
      ['Cursor', '找不到'],
      ['示範', '正常'],
    ]);
    expect(adapters.map((a) => a.source)).toStrictEqual([
      'demo',
      'cursor',
      'claude-code',
    ]);
  });

  it('I/O matrix 關閉示範模式: no adapter, no row', () => {
    expect(adapterRows({ adapters: [] })).toStrictEqual([]);
    expect(NO_ADAPTERS_TEXT).toBe('目前沒有執行中的轉接器');
    expect(ADAPTERS_HEADING).toBe('轉接器');
  });
});
