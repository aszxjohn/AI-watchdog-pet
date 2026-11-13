import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTERS_HEADING,
  adapterRows,
  createReleaseToggle,
  DEMO_MODE_HINT,
  IDLE_RELEASE_TOGGLE,
  INFERRED_LABEL,
  INFERRED_TITLE,
  INFERRED_TURN_END_TITLE,
  inferredTitle,
  nativeIdOf,
  NO_ADAPTERS_TEXT,
  NO_SESSIONS_TEXT,
  RELEASE_ACTION,
  RELEASED_LABEL,
  releaseErrorText,
  SESSION_COLUMNS,
  sessionRows,
  SESSIONS_HEADING,
  SHOW_AGAIN_ACTION,
  type ReleaseToggleState,
} from '../../src/panels/session-rows';
import type { SessionKey } from '../../src/shared/detection-events';
import type { IpcResult } from '../../src/shared/ipc';
import type { StagePool } from '../../src/shared/pool';
import type { StageAdapter, StageSession } from '../../src/shared/stage-view';
import { STATE_CODES, STATE_DISPLAY_NAMES } from '../../src/shared/states';

const DEMO: StageSession = {
  sessionKey: 'demo:1',
  source: 'demo',
  displayName: '示範',
  state: 'approval',
  confidence: 'exact',
};

const NOTHING_RELEASED: StagePool = { released: [] };

function session(fields: Partial<StageSession>): StageSession {
  return { ...DEMO, ...fields };
}

describe('sessionRows', () => {
  it('I/O matrix 打開示範模式: the demo session reads 示範 / 示範 / 要你批准', () => {
    expect(
      sessionRows({ sessions: [DEMO], pool: NOTHING_RELEASED }),
    ).toStrictEqual([
      {
        key: 'demo:1',
        source: '示範',
        name: '示範',
        state: '要你批准',
        stateCode: 'approval',
        inferred: false,
        released: false,
        action: '釋放',
      },
    ]);
  });

  it.each(STATE_CODES)('shows the state %s by its Chinese name', (state) => {
    const [row] = sessionRows({
      sessions: [session({ state })],
      pool: NOTHING_RELEASED,
    });
    expect(row?.state).toBe(STATE_DISPLAY_NAMES[state]);
    expect(row?.stateCode).toBe(state);
  });

  it('I/O matrix 推測標示: an inferred state is marked, an exact one is not', () => {
    const rows = sessionRows({
      pool: NOTHING_RELEASED,
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

  it('explains a guessed request and a guessed turn end differently (Story 2.6)', () => {
    expect(INFERRED_TITLE).toBe(
      '紀錄沒有寫出這個狀態：工具執行太久還沒結束，推測在等你',
    );
    expect(INFERRED_TURN_END_TITLE).toBe(
      '紀錄沒有寫出這一輪結束：回覆後一段時間沒有新紀錄，推測這一輪結束了',
    );
    expect(
      Object.fromEntries(
        STATE_CODES.map((state) => [state, inferredTitle(state)]),
      ),
    ).toStrictEqual({
      waiting: INFERRED_TURN_END_TITLE,
      thinking: INFERRED_TITLE,
      working: INFERRED_TITLE,
      approval: INFERRED_TITLE,
      decision: INFERRED_TITLE,
      done: INFERRED_TURN_END_TITLE,
      idle: INFERRED_TITLE,
      error: INFERRED_TITLE,
    });
  });

  it('shows the native id while the session has no display name', () => {
    const [row] = sessionRows({
      pool: NOTHING_RELEASED,
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

  it('orders rows by source, then in the order StageView lists them', () => {
    const rows = sessionRows({
      pool: NOTHING_RELEASED,
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
      'codex:z',
      'codex:y',
      'codex:x',
      'cursor:p',
      'demo:1',
    ]);
  });

  it('keeps the order when a state changes', () => {
    const sessions = [
      session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
      session({ sessionKey: 'codex:b', source: 'codex', displayName: 'b' }),
    ];
    const before = sessionRows({ sessions, pool: NOTHING_RELEASED }).map(
      (row) => row.key,
    );
    // StageView keeps listing them in the order they were first seen.
    const after = sessionRows({
      pool: NOTHING_RELEASED,
      sessions: [
        { ...sessions[0], state: 'idle' } as StageSession,
        { ...sessions[1], state: 'error' } as StageSession,
      ],
    }).map((row) => row.key);
    expect(after).toStrictEqual(before);
  });

  it('keeps every row in place when a session is released or shown again', () => {
    const sessions = [
      session({ sessionKey: 'codex:b', source: 'codex', displayName: 'b' }),
      session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
    ];
    const order = (released: SessionKey[]) =>
      sessionRows({ sessions, pool: { released } }).map((row) => row.key);

    expect(order([])).toStrictEqual(['codex:b', 'codex:a']);
    expect(order(['codex:b'])).toStrictEqual(['codex:b', 'codex:a']);
    expect(order(['codex:a', 'codex:b'])).toStrictEqual(['codex:b', 'codex:a']);
  });

  it('I/O matrix 沒有 session: no row, and the page text says so and points at 示範模式', () => {
    expect(sessionRows({ sessions: [], pool: NOTHING_RELEASED })).toStrictEqual(
      [],
    );
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
    sessionRows({
      sessions: sessions as StageSession[],
      pool: NOTHING_RELEASED,
    });
    expect(sessions.map((s) => s.sessionKey)).toStrictEqual([
      'demo:2',
      'demo:1',
    ]);
  });

  it('has the column headings 來源, 名稱, 狀態, 操作 (the 釋放 / 改回顯示 button)', () => {
    expect([...SESSION_COLUMNS]).toStrictEqual([
      '來源',
      '名稱',
      '狀態',
      '操作',
    ]);
    expect(SESSIONS_HEADING).toContain('session');
  });
});

describe('I/O matrix', () => {
  /** Claude Code sessions as StageView lists them: first seen first. */
  const listed = [
    session({
      sessionKey: 'claude-code:b',
      source: 'claude-code',
      displayName: 'zeta',
    }),
    session({ sessionKey: 'demo:1' }),
    session({
      sessionKey: 'claude-code:a',
      source: 'claude-code',
      displayName: 'gundam-pet',
    }),
  ];

  function keys(sessions: StageSession[]) {
    return sessionRows({ sessions, pool: NOTHING_RELEASED }).map(
      (row) => row.key,
    );
  }

  it('名稱改變: a session whose name goes from its folder to its title keeps its row', () => {
    const before = keys(listed);
    expect(before).toStrictEqual(['claude-code:b', 'claude-code:a', 'demo:1']);

    const renamed = listed.map((s) =>
      s.sessionKey === 'claude-code:a' ? { ...s, displayName: 'aaa 修正' } : s,
    );

    expect(keys(renamed)).toStrictEqual(before);
  });

  it('新 session: one more of a source goes last among that source’s rows', () => {
    const added = [
      ...listed,
      session({
        sessionKey: 'claude-code:0',
        source: 'claude-code',
        displayName: 'aaa',
      }),
    ];

    expect(keys(added)).toStrictEqual([
      'claude-code:b',
      'claude-code:a',
      'claude-code:0',
      'demo:1',
    ]);
  });
});

describe('released sessions (Story 2.8)', () => {
  const sessions = [
    session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
    session({
      sessionKey: 'codex:b',
      source: 'codex',
      displayName: 'b',
      state: 'working',
      confidence: 'inferred',
    }),
    session({ sessionKey: 'demo:1' }),
  ];

  it('I/O matrix 釋放: a released row keeps its state, is marked released and offers 改回顯示', () => {
    const rows = sessionRows({
      sessions,
      pool: { released: ['codex:b', 'demo:1'] },
    });

    expect(
      rows.map((row) => [
        row.key,
        row.state,
        row.inferred,
        row.released,
        row.action,
      ]),
    ).toStrictEqual([
      ['codex:a', '要你批准', false, false, '釋放'],
      ['codex:b', '工作中', true, true, '改回顯示'],
      ['demo:1', '要你批准', false, true, '改回顯示'],
    ]);
    expect(RELEASED_LABEL).toBe('已釋放');
    expect(RELEASE_ACTION).toBe('釋放');
    expect(SHOW_AGAIN_ACTION).toBe('改回顯示');
  });

  it('I/O matrix 改回顯示: once the key leaves the pool, the mark goes and the button is 釋放 again', () => {
    const [row] = sessionRows({
      sessions: [sessions[0] as StageSession],
      pool: NOTHING_RELEASED,
    });
    expect(row?.released).toBe(false);
    expect(row?.action).toBe('釋放');
  });

  it('keeps the order when a session is released or shown again: the row does not move', () => {
    const order = (released: SessionKey[]) =>
      sessionRows({ sessions, pool: { released } }).map((row) => row.key);
    const before = order([]);

    expect(order(['codex:a'])).toStrictEqual(before);
    expect(order(['codex:a', 'codex:b', 'demo:1'])).toStrictEqual(before);
  });

  it('ignores a released key with no session (saved from an earlier run, or ended)', () => {
    const rows = sessionRows({
      sessions: [sessions[0] as StageSession],
      pool: { released: ['claude-code:gone'] },
    });
    expect(rows.map((row) => [row.key, row.released])).toStrictEqual([
      ['codex:a', false],
    ]);
  });
});

describe('releaseErrorText', () => {
  it('says which request failed, with the error code when there is one', () => {
    expect(
      releaseErrorText(true, {
        code: 'invoke-failed',
        message: 'invoke failed',
      }),
    ).toBe('無法釋放 session（invoke-failed：invoke failed）');
    expect(releaseErrorText(false, undefined)).toBe('無法改回顯示');
  });
});

describe('createReleaseToggle', () => {
  type Reply = IpcResult<null>;

  /** A pool.setReleased whose reply the test sends when it wants. */
  function manualSetReleased() {
    const calls: [SessionKey, boolean][] = [];
    const pending: {
      resolve: (reply: Reply) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const setReleased = vi.fn(
      (sessionKey: SessionKey, released: boolean) =>
        new Promise<Reply>((resolve, reject) => {
          calls.push([sessionKey, released]);
          pending.push({ resolve, reject });
        }),
    );
    return {
      setReleased,
      calls,
      answer: (reply: Reply) => pending.shift()?.resolve(reply),
      fail: (error: unknown) => pending.shift()?.reject(error),
    };
  }

  function setup() {
    const remote = manualSetReleased();
    const states: ReleaseToggleState[] = [];
    const logError = vi.fn();
    const toggle = createReleaseToggle(
      remote.setReleased,
      (state) => {
        states.push(state);
      },
      logError,
    );
    return { remote, states, logError, toggle };
  }

  const SHOWN = { key: 'codex:a', released: false } as const;
  const RELEASED = { key: 'codex:a', released: true } as const;

  it('starts idle', () => {
    expect(IDLE_RELEASE_TOGGLE).toStrictEqual({ sending: false, error: null });
  });

  it('releases a shown row: reports sending while the reply is pending, then idle', async () => {
    const { remote, states, toggle } = setup();

    const done = toggle.toggle(SHOWN);

    expect(states).toStrictEqual([{ sending: true, error: null }]);
    expect(remote.calls).toStrictEqual([['codex:a', true]]);
    remote.answer({ ok: true, data: null });
    await done;
    expect(states.at(-1)).toStrictEqual({ sending: false, error: null });
  });

  it('shows a released row again', async () => {
    const { remote, toggle } = setup();

    const done = toggle.toggle(RELEASED);

    expect(remote.calls).toStrictEqual([['codex:a', false]]);
    remote.answer({ ok: true, data: null });
    await done;
  });

  it('ignores another press while one is on its way', async () => {
    const { remote, toggle } = setup();

    const first = toggle.toggle(SHOWN);
    await toggle.toggle({ key: 'demo:1', released: false });

    expect(remote.setReleased).toHaveBeenCalledOnce();
    remote.answer({ ok: true, data: null });
    await first;
  });

  it('shows releaseErrorText for { ok: false }, ends sending, and never touches the rows', async () => {
    const { remote, states, logError, toggle } = setup();
    const refused = {
      code: 'sender-rejected',
      message: 'sender is not allowed',
    } as const;

    const done = toggle.toggle(SHOWN);
    remote.answer({ ok: false, error: refused });
    await done;

    expect(states).toStrictEqual([
      { sending: true, error: null },
      { sending: false, error: releaseErrorText(true, refused) },
    ]);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('shows the generic error when the call rejects', async () => {
    const { remote, states, toggle } = setup();

    const done = toggle.toggle(RELEASED);
    remote.fail(new Error('gone'));
    await done;

    expect(states.at(-1)).toStrictEqual({
      sending: false,
      error: '無法改回顯示',
    });
  });

  it('never rejects, and takes the next press, when onState throws on the outcome', async () => {
    const remote = manualSetReleased();
    const toggle = createReleaseToggle(
      remote.setReleased,
      (state) => {
        if (!state.sending) {
          throw new Error('page gone');
        }
      },
      vi.fn(),
    );

    const first = toggle.toggle(SHOWN);
    remote.answer({ ok: true, data: null });
    await expect(first).resolves.toBeUndefined();

    // Not stuck sending: the next press is sent.
    const second = toggle.toggle(SHOWN);
    expect(remote.setReleased).toHaveBeenCalledTimes(2);
    remote.answer({ ok: true, data: null });
    await expect(second).resolves.toBeUndefined();
  });

  it('never rejects when onState throws on sending; nothing is sent and the next press still runs', async () => {
    const remote = manualSetReleased();
    const onState = vi.fn((state: ReleaseToggleState) => {
      if (state.sending) {
        throw new Error('page gone');
      }
    });
    const toggle = createReleaseToggle(remote.setReleased, onState, vi.fn());

    await expect(toggle.toggle(SHOWN)).resolves.toBeUndefined();
    await expect(toggle.toggle(SHOWN)).resolves.toBeUndefined();

    expect(remote.setReleased).not.toHaveBeenCalled();
    expect(onState.mock.calls.map(([state]) => state)).toStrictEqual([
      { sending: true, error: null },
      { sending: false, error: releaseErrorText(true, undefined) },
      { sending: true, error: null },
      { sending: false, error: releaseErrorText(true, undefined) },
    ]);
  });

  it('never rejects, ends sending and keeps the error, when logError throws', async () => {
    const remote = manualSetReleased();
    const states: ReleaseToggleState[] = [];
    const toggle = createReleaseToggle(
      remote.setReleased,
      (state) => {
        states.push(state);
      },
      () => {
        throw new Error('console gone');
      },
    );
    const refused = {
      code: 'invoke-failed',
      message: 'invoke failed',
    } as const;

    const done = toggle.toggle(SHOWN);
    remote.answer({ ok: false, error: refused });
    await expect(done).resolves.toBeUndefined();

    expect(states.at(-1)).toStrictEqual({
      sending: false,
      error: releaseErrorText(true, refused),
    });
    const again = toggle.toggle(SHOWN);
    expect(remote.setReleased).toHaveBeenCalledTimes(2);
    remote.answer({ ok: true, data: null });
    await again;
  });

  it('clears an earlier error on the next press, and can press again', async () => {
    const { remote, states, toggle } = setup();
    const failed = toggle.toggle(SHOWN);
    remote.fail(new Error('gone'));
    await failed;

    const done = toggle.toggle(SHOWN);
    expect(states.at(-1)).toStrictEqual({ sending: true, error: null });
    remote.answer({ ok: true, data: null });
    await done;

    expect(states.at(-1)).toStrictEqual({ sending: false, error: null });
    expect(remote.setReleased).toHaveBeenCalledTimes(2);
  });
});

describe('nativeIdOf', () => {
  it.each<[SessionKey, string]>([
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
