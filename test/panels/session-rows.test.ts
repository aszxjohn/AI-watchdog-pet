import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTERS_HEADING,
  adapterRows,
  createSessionActions,
  DEMO_MODE_HINT,
  IDLE_SESSION_ACTIONS,
  INFERRED_LABEL,
  INFERRED_TITLE,
  INFERRED_TURN_END_TITLE,
  inferredTitle,
  LOCKING_NOTE,
  lockNoteText,
  nativeIdOf,
  NO_ADAPTERS_TEXT,
  NO_CHARACTER_TEXT,
  NO_SESSIONS_TEXT,
  RELEASE_ACTION,
  releaseAllConfirmText,
  releaseAllLabel,
  RELEASED_LABEL,
  SESSION_COLUMNS,
  sessionActionErrorText,
  sessionRows,
  SESSIONS_HEADING,
  sessionToolbar,
  SHOW_AGAIN_ACTION,
  showAllLabel,
  UNLOCKED_LABEL,
  type SessionActionState,
  type SessionPoolApi,
} from '../../src/panels/session-rows';
import type { SessionKey } from '../../src/shared/detection-events';
import type { IpcResult } from '../../src/shared/ipc';
import type { StagePool } from '../../src/shared/pool';
import type {
  StageAdapter,
  StageSession,
  StageView,
} from '../../src/shared/stage-view';
import { STATE_CODES, STATE_DISPLAY_NAMES } from '../../src/shared/states';

const DEMO: StageSession = {
  sessionKey: 'demo:1',
  source: 'demo',
  displayName: '示範',
  state: 'approval',
  confidence: 'exact',
};

const NOTHING_RELEASED: StagePool = {
  released: [],
  locked: [],
  lockOn: false,
};

/** No actor and no installed pack: every row reads 沒有角色. */
const NO_CHARACTERS: Pick<StageView, 'actors' | 'packs'> = {
  actors: [],
  packs: { installed: [] },
};

function session(fields: Partial<StageSession>): StageSession {
  return { ...DEMO, ...fields };
}

describe('sessionRows', () => {
  it('I/O matrix 打開示範模式: the demo session reads 示範 / 示範 / 要你批准', () => {
    expect(
      sessionRows({
        ...NO_CHARACTERS,
        sessions: [DEMO],
        pool: NOTHING_RELEASED,
      }),
    ).toStrictEqual([
      {
        key: 'demo:1',
        source: '示範',
        name: '示範',
        state: '要你批准',
        stateCode: 'approval',
        inferred: false,
        released: false,
        locked: false,
        mark: null,
        character: '沒有角色',
        characterKey: null,
        action: '釋放',
      },
    ]);
  });

  it.each(STATE_CODES)('shows the state %s by its Chinese name', (state) => {
    const [row] = sessionRows({
      ...NO_CHARACTERS,
      sessions: [session({ state })],
      pool: NOTHING_RELEASED,
    });
    expect(row?.state).toBe(STATE_DISPLAY_NAMES[state]);
    expect(row?.stateCode).toBe(state);
  });

  it('I/O matrix 推測標示: an inferred state is marked, an exact one is not', () => {
    const rows = sessionRows({
      ...NO_CHARACTERS,
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
      ...NO_CHARACTERS,
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
      ...NO_CHARACTERS,
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
    const before = sessionRows({
      ...NO_CHARACTERS,
      sessions,
      pool: NOTHING_RELEASED,
    }).map((row) => row.key);
    // StageView keeps listing them in the order they were first seen.
    const after = sessionRows({
      ...NO_CHARACTERS,
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
      sessionRows({
        ...NO_CHARACTERS,
        sessions,
        pool: { ...NOTHING_RELEASED, released },
      }).map((row) => row.key);

    expect(order([])).toStrictEqual(['codex:b', 'codex:a']);
    expect(order(['codex:b'])).toStrictEqual(['codex:b', 'codex:a']);
    expect(order(['codex:a', 'codex:b'])).toStrictEqual(['codex:b', 'codex:a']);
  });

  it('I/O matrix 沒有 session: no row, and the page text says so and points at 示範模式', () => {
    expect(
      sessionRows({
        ...NO_CHARACTERS,
        sessions: [],
        pool: NOTHING_RELEASED,
      }),
    ).toStrictEqual([]);
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
      ...NO_CHARACTERS,
      sessions: sessions as StageSession[],
      pool: NOTHING_RELEASED,
    });
    expect(sessions.map((s) => s.sessionKey)).toStrictEqual([
      'demo:2',
      'demo:1',
    ]);
  });

  it('has the column headings 鎖定 (the checkbox), 來源, 名稱, 狀態, 角色, 操作 (the 釋放 / 改回顯示 button)', () => {
    expect([...SESSION_COLUMNS]).toStrictEqual([
      '鎖定',
      '來源',
      '名稱',
      '狀態',
      '角色',
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
    return sessionRows({
      ...NO_CHARACTERS,
      sessions,
      pool: NOTHING_RELEASED,
    }).map((row) => row.key);
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
      ...NO_CHARACTERS,
      sessions,
      pool: { ...NOTHING_RELEASED, released: ['codex:b', 'demo:1'] },
    });

    expect(
      rows.map((row) => [
        row.key,
        row.state,
        row.inferred,
        row.released,
        row.mark,
        row.action,
      ]),
    ).toStrictEqual([
      ['codex:a', '要你批准', false, false, null, '釋放'],
      ['codex:b', '工作中', true, true, '已釋放', '改回顯示'],
      ['demo:1', '要你批准', false, true, '已釋放', '改回顯示'],
    ]);
    expect(RELEASED_LABEL).toBe('已釋放');
    expect(RELEASE_ACTION).toBe('釋放');
    expect(SHOW_AGAIN_ACTION).toBe('改回顯示');
  });

  it('I/O matrix 改回顯示: once the key leaves the pool, the mark goes and the button is 釋放 again', () => {
    const [row] = sessionRows({
      ...NO_CHARACTERS,
      sessions: [sessions[0] as StageSession],
      pool: NOTHING_RELEASED,
    });
    expect(row?.released).toBe(false);
    expect(row?.action).toBe('釋放');
  });

  it('keeps the order when a session is released or shown again: the row does not move', () => {
    const order = (released: SessionKey[]) =>
      sessionRows({
        ...NO_CHARACTERS,
        sessions,
        pool: { ...NOTHING_RELEASED, released },
      }).map((row) => row.key);
    const before = order([]);

    expect(order(['codex:a'])).toStrictEqual(before);
    expect(order(['codex:a', 'codex:b', 'demo:1'])).toStrictEqual(before);
  });

  it('ignores a released key with no session (saved from an earlier run, or ended)', () => {
    const rows = sessionRows({
      ...NO_CHARACTERS,
      sessions: [sessions[0] as StageSession],
      pool: { ...NOTHING_RELEASED, released: ['claude-code:gone'] },
    });
    expect(rows.map((row) => [row.key, row.released])).toStrictEqual([
      ['codex:a', false],
    ]);
  });
});

describe('I/O matrix', () => {
  const PACKS: StageView['packs'] = {
    installed: [
      {
        id: 'another-pack',
        name: '另一包',
        version: '2.0.0',
        apiVersion: '1.0',
        compatibility: { compatible: true },
        characters: [{ id: 'probe-one', name: '別包的探針一', height: 110 }],
      },
      {
        id: 'sample-pack',
        name: '範例包',
        version: '1.0.0',
        apiVersion: '1.0',
        compatibility: { compatible: true },
        characters: [
          { id: 'probe-one', name: '探針一', height: 110 },
          { id: 'probe-two', name: '探針二', height: 96 },
        ],
      },
    ],
  };
  const SESSIONS = [
    session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
    session({ sessionKey: 'codex:b', source: 'codex', displayName: 'b' }),
    session({ sessionKey: 'codex:c', source: 'codex', displayName: 'c' }),
    session({ sessionKey: 'codex:d', source: 'codex', displayName: 'd' }),
    session({ sessionKey: 'demo:1' }),
  ];
  function actor(
    sessionKey: SessionKey,
    characterKey: StageView['actors'][number]['characterKey'],
    actorId: string,
  ): StageView['actors'][number] {
    const of = SESSIONS.find((s) => s.sessionKey === sessionKey);
    if (of === undefined) {
      throw new Error('no such session');
    }
    return {
      actorId,
      sessionKey,
      characterKey,
      state: of.state,
      confidence: of.confidence,
      displayName: of.displayName,
    };
  }

  it('面板: each row names the character its session plays; a row with none reads 沒有角色; a released row is marked as before', () => {
    const rows = sessionRows({
      sessions: SESSIONS,
      pool: { ...NOTHING_RELEASED, released: ['codex:c'] },
      actors: [
        actor('codex:a', 'sample-pack/probe-one', 'x1'),
        actor('codex:b', 'another-pack/probe-one', 'x2'),
        actor('codex:d', 'sample-pack/probe-one', 'x3'),
        actor('demo:1', 'sample-pack/probe-two', 'x4'),
      ],
      packs: PACKS,
    });

    expect(
      rows.map((row) => [
        row.key,
        row.character,
        row.characterKey,
        row.released,
      ]),
    ).toStrictEqual([
      ['codex:a', '探針一', 'sample-pack/probe-one', false],
      // Same character id, another pack: its own name.
      ['codex:b', '別包的探針一', 'another-pack/probe-one', false],
      ['codex:c', '沒有角色', null, true],
      // One character for two sessions (the pool ran out).
      ['codex:d', '探針一', 'sample-pack/probe-one', false],
      ['demo:1', '探針二', 'sample-pack/probe-two', false],
    ]);
    expect(NO_CHARACTER_TEXT).toBe('沒有角色');
  });

  it('面板: a character no installed pack names any more (its pack was removed) shows its key', () => {
    const [row] = sessionRows({
      sessions: [SESSIONS[0] as StageSession],
      pool: NOTHING_RELEASED,
      actors: [actor('codex:a', 'removed-pack/probe-one', 'x1')],
      packs: PACKS,
    });

    expect(row?.character).toBe('removed-pack/probe-one');
    expect(row?.characterKey).toBe('removed-pack/probe-one');
  });

  it('面板: before the start-up sync, or with an empty pool, every row reads 沒有角色', () => {
    const rows = sessionRows({
      sessions: SESSIONS,
      pool: NOTHING_RELEASED,
      actors: [],
      packs: PACKS,
    });

    expect(rows.map((row) => row.character)).toStrictEqual(
      SESSIONS.map(() => '沒有角色'),
    );
    expect(rows.every((row) => row.characterKey === null)).toBe(true);
  });

  it('面板: an actor of a session not listed is ignored, and the rows keep their order', () => {
    const rows = sessionRows({
      sessions: [SESSIONS[1] as StageSession, SESSIONS[0] as StageSession],
      pool: NOTHING_RELEASED,
      actors: [
        actor('codex:a', 'sample-pack/probe-one', 'x1'),
        actor('codex:d', 'sample-pack/probe-two', 'x2'),
      ],
      packs: PACKS,
    });

    expect(rows.map((row) => [row.key, row.character])).toStrictEqual([
      ['codex:b', '沒有角色'],
      ['codex:a', '探針一'],
    ]);
  });
});

describe('sessionActionErrorText', () => {
  it('says which request failed, with the error code when there is one', () => {
    expect(
      sessionActionErrorText('release', {
        code: 'invoke-failed',
        message: 'invoke failed',
      }),
    ).toBe('無法釋放 session（invoke-failed：invoke failed）');
    expect(sessionActionErrorText('show', undefined)).toBe('無法改回顯示');
    expect(sessionActionErrorText('release-all', undefined)).toBe(
      '無法全部釋放',
    );
  });
});

type Reply = IpcResult<null>;

/**
 * `window.awp.pool` for createSessionActions: each call is recorded as
 * [method, ...arguments] and answered when the test wants.
 */
function manualPool() {
  const calls: unknown[][] = [];
  const pending: {
    resolve: (reply: Reply) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const reply = (...call: unknown[]) =>
    new Promise<Reply>((resolve, reject) => {
      calls.push(call);
      pending.push({ resolve, reject });
    });
  const api: SessionPoolApi = {
    setReleased: (key, released) => reply('setReleased', key, released),
    setReleasedMany: (keys, released) =>
      reply('setReleasedMany', keys, released),
    setLocked: (key, locked) => reply('setLocked', key, locked),
    setLockOn: (on) => reply('setLockOn', on),
  };
  return {
    api,
    calls,
    answer: (answer: Reply) => pending.shift()?.resolve(answer),
    fail: (error: unknown) => pending.shift()?.reject(error),
  };
}

describe('createSessionActions', () => {
  function setup() {
    const remote = manualPool();
    const states: SessionActionState[] = [];
    const logError = vi.fn();
    const actions = createSessionActions(
      remote.api,
      (state) => {
        states.push(state);
      },
      logError,
    );
    return { remote, states, logError, actions };
  }

  const SHOWN = { key: 'codex:a', released: false } as const;
  const RELEASED = { key: 'codex:a', released: true } as const;
  const OK: Reply = { ok: true, data: null };
  const SENDING = { sending: true, error: null, confirming: false };
  const IDLE = { sending: false, error: null, confirming: false };

  it('starts idle', () => {
    expect(IDLE_SESSION_ACTIONS).toStrictEqual(IDLE);
  });

  it('releases a shown row: reports sending while the reply is pending, then idle', async () => {
    const { remote, states, actions } = setup();

    const done = actions.toggle(SHOWN);

    expect(states).toStrictEqual([SENDING]);
    expect(remote.calls).toStrictEqual([['setReleased', 'codex:a', true]]);
    remote.answer(OK);
    await done;
    expect(states.at(-1)).toStrictEqual(IDLE);
  });

  it('shows a released row again', async () => {
    const { remote, actions } = setup();

    const done = actions.toggle(RELEASED);

    expect(remote.calls).toStrictEqual([['setReleased', 'codex:a', false]]);
    remote.answer(OK);
    await done;
  });

  it('ignores another press while one is on its way, a batch or a lock too', async () => {
    const { remote, actions } = setup();

    const first = actions.toggle(SHOWN);
    await actions.toggle({ key: 'demo:1', released: false });
    await actions.showAll(['demo:1']);
    await actions.toggleLock({ key: 'demo:1', locked: false });
    await actions.setLockOn(true);

    expect(remote.calls).toHaveLength(1);
    remote.answer(OK);
    await first;
  });

  it('shows the error text for { ok: false }, ends sending, and never touches the rows', async () => {
    const { remote, states, logError, actions } = setup();
    const refused = {
      code: 'sender-rejected',
      message: 'sender is not allowed',
    } as const;

    const done = actions.toggle(SHOWN);
    remote.answer({ ok: false, error: refused });
    await done;

    expect(states).toStrictEqual([
      SENDING,
      { ...IDLE, error: sessionActionErrorText('release', refused) },
    ]);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('shows the generic error when the call rejects', async () => {
    const { remote, states, actions } = setup();

    const done = actions.toggle(RELEASED);
    remote.fail(new Error('gone'));
    await done;

    expect(states.at(-1)).toStrictEqual({ ...IDLE, error: '無法改回顯示' });
  });

  it('never rejects, and takes the next press, when onState throws on the outcome', async () => {
    const remote = manualPool();
    const actions = createSessionActions(
      remote.api,
      (state) => {
        if (!state.sending) {
          throw new Error('page gone');
        }
      },
      vi.fn(),
    );

    const first = actions.toggle(SHOWN);
    remote.answer(OK);
    await expect(first).resolves.toBeUndefined();

    // Not stuck sending: the next press is sent.
    const second = actions.toggle(SHOWN);
    expect(remote.calls).toHaveLength(2);
    remote.answer(OK);
    await expect(second).resolves.toBeUndefined();
  });

  it('never rejects when onState throws on sending; nothing is sent and the next press still runs', async () => {
    const remote = manualPool();
    const onState = vi.fn((state: SessionActionState) => {
      if (state.sending) {
        throw new Error('page gone');
      }
    });
    const actions = createSessionActions(remote.api, onState, vi.fn());

    await expect(actions.toggle(SHOWN)).resolves.toBeUndefined();
    await expect(actions.toggle(SHOWN)).resolves.toBeUndefined();

    expect(remote.calls).toStrictEqual([]);
    const failed = {
      ...IDLE,
      error: sessionActionErrorText('release', undefined),
    };
    expect(onState.mock.calls.map(([state]) => state)).toStrictEqual([
      SENDING,
      failed,
      SENDING,
      failed,
    ]);
  });

  it('never rejects, ends sending and keeps the error, when logError throws', async () => {
    const remote = manualPool();
    const states: SessionActionState[] = [];
    const actions = createSessionActions(
      remote.api,
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

    const done = actions.toggle(SHOWN);
    remote.answer({ ok: false, error: refused });
    await expect(done).resolves.toBeUndefined();

    expect(states.at(-1)).toStrictEqual({
      ...IDLE,
      error: sessionActionErrorText('release', refused),
    });
    const again = actions.toggle(SHOWN);
    expect(remote.calls).toHaveLength(2);
    remote.answer(OK);
    await again;
  });

  it('clears an earlier error on the next press, and can press again', async () => {
    const { remote, states, actions } = setup();
    const failed = actions.toggle(SHOWN);
    remote.fail(new Error('gone'));
    await failed;

    const done = actions.toggle(SHOWN);
    expect(states.at(-1)).toStrictEqual(SENDING);
    remote.answer(OK);
    await done;

    expect(states.at(-1)).toStrictEqual(IDLE);
    expect(remote.calls).toHaveLength(2);
  });
});

describe('I/O matrix', () => {
  // Session bulk-lock: the toolbar and what its buttons send.
  const SESSIONS = [
    session({ sessionKey: 'codex:a', source: 'codex', displayName: 'a' }),
    session({ sessionKey: 'codex:b', source: 'codex', displayName: 'b' }),
    session({ sessionKey: 'demo:1' }),
  ];

  function rowsWith(pool: Partial<StagePool>) {
    return sessionRows({
      ...NO_CHARACTERS,
      sessions: SESSIONS,
      pool: { ...NOTHING_RELEASED, ...pool },
    });
  }

  it('工具列: the numbers on the buttons are the rows not released and the rows released; the switch has one line saying what it does now', () => {
    const rows = rowsWith({ released: ['codex:b'], locked: ['codex:a'] });

    const toolbar = sessionToolbar(
      rows,
      { lockOn: false },
      IDLE_SESSION_ACTIONS,
      true,
    );

    expect(toolbar.visible).toBe(true);
    expect(toolbar.releaseAll).toStrictEqual({
      label: '全部釋放（2）',
      disabled: false,
      keys: ['codex:a', 'demo:1'],
    });
    expect(toolbar.showAll).toStrictEqual({
      label: '全部顯示（1）',
      disabled: false,
      keys: ['codex:b'],
    });
    expect(toolbar.lockOn).toStrictEqual({ checked: false, disabled: false });
    expect(toolbar.lockNote).toBe(lockNoteText(false, 1));
    expect(toolbar.lockingNote).toBeNull();
    expect(toolbar.rowReleaseDisabled).toBe(false);
    expect(releaseAllLabel(0)).toBe('全部釋放（0）');
    expect(showAllLabel(3)).toBe('全部顯示（3）');
    expect(lockNoteText(false, 1)).toBe(
      '關著：沒釋放的 session 都會分到角色。打開後，只有勾選鎖定的 1 個 session 有角色。',
    );
    expect(lockNoteText(false, 0)).toBe(
      '關著：沒釋放的 session 都會分到角色。要打開，先在「鎖定」欄勾選想留下角色的 session。',
    );
    expect(lockNoteText(true, 2)).toBe(
      '開著：只有勾選鎖定的 2 個 session 有角色，其他 session 和之後新出現的都不出角色。',
    );
  });

  it('工具列: nothing to send disables a button; with no row locked the switch is disabled while off', () => {
    const toolbar = sessionToolbar(
      rowsWith({}),
      { lockOn: false },
      IDLE_SESSION_ACTIONS,
      true,
    );

    expect(toolbar.releaseAll.disabled).toBe(false);
    expect(toolbar.showAll).toMatchObject({
      label: '全部顯示（0）',
      disabled: true,
    });
    expect(toolbar.lockOn).toStrictEqual({ checked: false, disabled: true });
    expect(toolbar.lockNote).toBe(lockNoteText(false, 0));
  });

  it('工具列: with no row it shows only while 鎖定展示 is on, so the switch can still be turned off; its line says no locked session is listed', () => {
    expect(
      sessionToolbar([], { lockOn: false }, IDLE_SESSION_ACTIONS, true).visible,
    ).toBe(false);

    const toolbar = sessionToolbar(
      [],
      { lockOn: true },
      IDLE_SESSION_ACTIONS,
      true,
    );

    expect(toolbar.visible).toBe(true);
    expect(toolbar.lockOn).toStrictEqual({ checked: true, disabled: false });
    expect(toolbar.lockNote).toBe(lockNoteText(true, 0));
    expect(lockNoteText(true, 0)).toBe(
      '開著，但清單上沒有勾選鎖定的 session，所以其他 session 都不出角色。關掉開關就恢復。',
    );
  });

  it('打開鎖定: with 鎖定展示 on, only the ticked rows count; the others are faded and marked 未鎖定, released or not; every release button is disabled, with 鎖定中 beside them', () => {
    const rows = rowsWith({
      released: ['codex:a', 'codex:b'],
      locked: ['codex:a'],
      lockOn: true,
    });
    const toolbar = sessionToolbar(
      rows,
      { lockOn: true },
      IDLE_SESSION_ACTIONS,
      true,
    );

    expect(
      rows.map((row) => [row.key, row.locked, row.released, row.mark]),
    ).toStrictEqual([
      ['codex:a', true, true, null],
      ['codex:b', false, true, UNLOCKED_LABEL],
      ['demo:1', false, false, UNLOCKED_LABEL],
    ]);
    expect(UNLOCKED_LABEL).toBe('未鎖定');
    expect(toolbar.releaseAll.disabled).toBe(true);
    expect(toolbar.showAll.disabled).toBe(true);
    expect(toolbar.rowReleaseDisabled).toBe(true);
    expect(toolbar.rowLockDisabled).toBe(false);
    expect(toolbar.lockingNote).toBe(LOCKING_NOTE);
    expect(LOCKING_NOTE).toBe('鎖定中');
    expect(toolbar.lockOn).toStrictEqual({ checked: true, disabled: false });
    expect(toolbar.lockNote).toBe(lockNoteText(true, 1));
  });

  it('鎖定（關著）: a ticked row with 鎖定展示 off is marked only as released or not', () => {
    const rows = rowsWith({
      released: ['codex:b'],
      locked: ['codex:a', 'codex:b'],
    });

    expect(rows.map((row) => [row.key, row.locked, row.mark])).toStrictEqual([
      ['codex:a', true, null],
      ['codex:b', true, RELEASED_LABEL],
      ['demo:1', false, null],
    ]);
  });

  it('全部釋放: pressing it asks first and sends nothing; 全部釋放 on the question sends the keys listed in one request, then stops asking', async () => {
    const remote = manualPool();
    let state = IDLE_SESSION_ACTIONS;
    const actions = createSessionActions(remote.api, (next) => {
      state = next;
    });
    const rows = rowsWith({ released: ['codex:b'] });

    actions.askReleaseAll();
    const asking = sessionToolbar(rows, { lockOn: false }, state, true);

    expect(remote.calls).toStrictEqual([]);
    expect(asking.releaseAll.disabled).toBe(true);
    expect(asking.confirm).toStrictEqual({
      text: releaseAllConfirmText(2),
      disabled: false,
      keys: ['codex:a', 'demo:1'],
    });
    expect(releaseAllConfirmText(2)).toBe('把 2 個 session 的角色全部收起來？');

    const done = actions.releaseAll(asking.confirm?.keys ?? []);
    expect(remote.calls).toStrictEqual([
      ['setReleasedMany', ['codex:a', 'demo:1'], true],
    ]);
    remote.answer({ ok: true, data: null });
    await done;

    expect(state).toStrictEqual(IDLE_SESSION_ACTIONS);
    expect(
      sessionToolbar(rows, { lockOn: false }, state, true).confirm,
    ).toBeNull();
  });

  it('全部釋放: any other press while asking ends the question, so it never comes back by itself', async () => {
    const remote = manualPool();
    let state = IDLE_SESSION_ACTIONS;
    const actions = createSessionActions(remote.api, (next) => {
      state = next;
    });
    const rows = rowsWith({ locked: ['codex:a'] });

    actions.askReleaseAll();
    const done = actions.setLockOn(true);
    remote.answer({ ok: true, data: null });
    await done;

    expect(state).toStrictEqual(IDLE_SESSION_ACTIONS);
    expect(
      sessionToolbar(rows, { lockOn: false }, state, true).confirm,
    ).toBeNull();
  });

  it('取消: 取消 on the question stops asking and sends nothing', () => {
    const remote = manualPool();
    const states: SessionActionState[] = [];
    const actions = createSessionActions(remote.api, (state) => {
      states.push(state);
    });

    actions.askReleaseAll();
    actions.keepAll();

    expect(remote.calls).toStrictEqual([]);
    expect(states).toStrictEqual([
      { ...IDLE_SESSION_ACTIONS, confirming: true },
      IDLE_SESSION_ACTIONS,
    ]);
  });

  it('全部顯示, 鎖定 and 鎖定展示: each sends one request with what the row or toolbar says', async () => {
    const remote = manualPool();
    const actions = createSessionActions(remote.api, () => {});

    for (const press of [
      () => actions.showAll(['codex:b']),
      () => actions.toggleLock({ key: 'codex:a', locked: false }),
      () => actions.toggleLock({ key: 'codex:a', locked: true }),
      () => actions.setLockOn(true),
    ]) {
      const done = press();
      remote.answer({ ok: true, data: null });
      await done;
    }

    expect(remote.calls).toStrictEqual([
      ['setReleasedMany', ['codex:b'], false],
      ['setLocked', 'codex:a', true],
      ['setLocked', 'codex:a', false],
      ['setLockOn', true],
    ]);
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
