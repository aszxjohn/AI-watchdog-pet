import { describe, expect, it, vi } from 'vitest';
import {
  NOT_SAVED_TEXT,
  patchErrorText,
} from '../../src/panels/display-options';
import {
  createPackListActions,
  ENABLED_LABEL,
  heightHintText,
  IDLE_PACK_LIST_ACTIONS,
  IN_POOL_LABEL,
  inPoolOp,
  NO_PACKS_TEXT,
  PACK_LIST_HEADING,
  PACK_LIST_PATCH_FAILED,
  packEnabledOp,
  packListDisabled,
  packListPatch,
  packListView,
  RECOMMENDED_HEIGHT_RANGE,
  versionText,
  type PackListActionState,
} from '../../src/panels/pack-list';
import type { IpcResult } from '../../src/shared/ipc';
import type { StagePacks } from '../../src/shared/packs';
import {
  SETTINGS_DEFAULTS,
  settingsPatchSchema,
  settingsValuesSchema,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsValues,
} from '../../src/shared/settings';

const ALPHA = {
  id: 'alpha-pack',
  name: '甲包',
  version: '1.2.0',
  apiVersion: '1.0',
  characters: [
    { id: 'zeta', name: '角色Ｚ', height: 110 },
    { id: 'beta', name: '角色Ｂ', height: 82 },
  ],
};
const BRAVO = {
  id: 'bravo-pack',
  name: '乙包',
  version: '0.9.1',
  apiVersion: '1.0',
  characters: [{ id: 'zeta', name: '另一個Ｚ', height: 138 }],
};

const PACKS: StagePacks = { installed: [ALPHA, BRAVO] };

/** Settings values with `packEnabled` and `fixedOverrides` as given. */
function settings(
  packEnabled: Record<string, boolean> = {},
  fixedOverrides: Record<string, { inPool?: boolean }> = {},
): SettingsValues {
  return settingsValuesSchema.parse({
    ...SETTINGS_DEFAULTS,
    packEnabled,
    fixedOverrides,
  });
}

/** The pack of `id` in the view, and its characters by id. */
function find(view: ReturnType<typeof packListView>, id: string) {
  const pack = view.find((entry) => entry.id === id);
  if (pack === undefined) {
    throw new Error(`no ${id} in the view`);
  }
  return pack;
}

function character(
  view: ReturnType<typeof packListView>,
  packId: string,
  characterId: string,
) {
  const found = find(view, packId).characters.find(
    (entry) => entry.key === `${packId}/${characterId}`,
  );
  if (found === undefined) {
    throw new Error(`no ${packId}/${characterId} in the view`);
  }
  return found;
}

type Reply = IpcResult<SettingsPatchResult>;

/** A settings.patch whose replies the test hands out one by one. */
function manualPatch() {
  const calls: SettingsPatch[] = [];
  const pending: {
    resolve: (reply: Reply) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const patch = vi.fn(
    (next: SettingsPatch) =>
      new Promise<Reply>((resolve, reject) => {
        calls.push(next);
        pending.push({ resolve, reject });
      }),
  );
  return {
    patch,
    calls,
    answer: (reply: Reply) => pending.shift()?.resolve(reply),
    fail: (error: unknown) => pending.shift()?.reject(error),
  };
}

function setup() {
  const remote = manualPatch();
  const states: PackListActionState[] = [];
  const logError = vi.fn();
  const actions = createPackListActions(
    { patch: remote.patch },
    (state) => {
      states.push(state);
    },
    logError,
  );
  return { remote, states, logError, actions };
}

const SAVED: Reply = { ok: true, data: { rev: 8, merged: false, saved: true } };
const PACK_OFF = packEnabledOp('alpha-pack', false);

describe('the texts', () => {
  it('heading, empty text and checkbox labels', () => {
    expect(PACK_LIST_HEADING).toBe('已安裝');
    expect(NO_PACKS_TEXT).toBe('還沒有安裝角色包');
    expect(ENABLED_LABEL).toBe('上場');
    expect(IN_POOL_LABEL).toBe('加入池子');
    expect(versionText('1.2.0')).toBe('版本 1.2.0');
  });

  it('the recommended range is 110 ± 25%: 82.5 to 137.5', () => {
    expect(RECOMMENDED_HEIGHT_RANGE).toStrictEqual({ min: 82.5, max: 137.5 });
  });

  it('a failure names the list, then the code and message', () => {
    expect(PACK_LIST_PATCH_FAILED).toBe('無法變更角色包設定');
    expect(
      patchErrorText(
        { code: 'handler-failed', message: 'handler failed' },
        PACK_LIST_PATCH_FAILED,
      ),
    ).toBe('無法變更角色包設定（handler-failed：handler failed）');
    expect(patchErrorText(undefined, PACK_LIST_PATCH_FAILED)).toBe(
      '無法變更角色包設定',
    );
  });
});

describe('the ops and the patch', () => {
  it('上場 changes one pack id; 加入池子 one character key', () => {
    expect(packEnabledOp('alpha-pack', false)).toStrictEqual({
      op: 'setPackEnabled',
      packId: 'alpha-pack',
      value: false,
    });
    expect(inPoolOp('alpha-pack', 'zeta', true)).toStrictEqual({
      op: 'setFixed',
      characterKey: 'alpha-pack/zeta',
      param: 'inPool',
      value: true,
    });
  });

  it('a patch carries the one op at the settings rev, and passes the shared schema', () => {
    const op = inPoolOp('alpha-pack', 'zeta', false);
    const patch = packListPatch(5, op);

    expect(patch).toStrictEqual({ baseRev: 5, ops: [op] });
    expect(settingsPatchSchema.safeParse(patch).success).toBe(true);
    expect(
      settingsPatchSchema.safeParse(packListPatch(0, PACK_OFF)).success,
    ).toBe(true);
  });
});

describe('I/O matrix', () => {
  it('空清單: no installed pack lists nothing (the page shows 還沒有安裝角色包)', () => {
    expect(packListView({ installed: [] }, settings())).toStrictEqual([]);
  });

  it('列出: each pack by id with its name, version and characters in manifest order, all checked', () => {
    const view = packListView(PACKS, settings());

    expect(view.map((pack) => pack.id)).toStrictEqual([
      'alpha-pack',
      'bravo-pack',
    ]);
    expect(view[0]).toStrictEqual({
      id: 'alpha-pack',
      name: '甲包',
      version: '版本 1.2.0',
      enabled: {
        id: 'enabled:alpha-pack',
        checked: true,
        ariaLabel: '上場：甲包',
        toggle: packEnabledOp('alpha-pack', false),
      },
      characters: [
        {
          key: 'alpha-pack/zeta',
          name: '角色Ｚ',
          inPool: {
            id: 'in-pool:alpha-pack/zeta',
            checked: true,
            ariaLabel: '加入池子：甲包／角色Ｚ',
            toggle: inPoolOp('alpha-pack', 'zeta', false),
          },
          heightHint: null,
          heightHintId: null,
        },
        {
          key: 'alpha-pack/beta',
          name: '角色Ｂ',
          inPool: {
            id: 'in-pool:alpha-pack/beta',
            checked: true,
            ariaLabel: '加入池子：甲包／角色Ｂ',
            toggle: inPoolOp('alpha-pack', 'beta', false),
          },
          heightHint: heightHintText(82),
          heightHintId: 'in-pool:alpha-pack/beta:hint',
        },
      ],
    });
  });

  it('列出: sorts by id even if handed out of order', () => {
    const view = packListView(
      { installed: [BRAVO, ALPHA] } as StagePacks,
      settings(),
    );

    expect(view.map((pack) => pack.id)).toStrictEqual([
      'alpha-pack',
      'bravo-pack',
    ]);
  });

  it('列出: every checkbox and hint id is unique on the page, the same character id in two packs included', () => {
    const view = packListView(PACKS, settings());
    const ids = view.flatMap((pack) => [
      pack.enabled.id,
      ...pack.characters.flatMap((entry) => [
        entry.inPool.id,
        ...(entry.heightHintId === null ? [] : [entry.heightHintId]),
      ]),
    ]);

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('列出: two packs with a same-named character name each 加入池子 checkbox with its pack', () => {
    const view = packListView(
      {
        installed: [
          { ...ALPHA, characters: [{ id: 'zeta', name: '同名', height: 110 }] },
          { ...BRAVO, characters: [{ id: 'zeta', name: '同名', height: 110 }] },
        ],
      },
      settings(),
    );

    expect(character(view, 'alpha-pack', 'zeta').inPool.ariaLabel).toBe(
      '加入池子：甲包／同名',
    );
    expect(character(view, 'bravo-pack', 'zeta').inPool.ariaLabel).toBe(
      '加入池子：乙包／同名',
    );
    expect(find(view, 'bravo-pack').enabled.ariaLabel).toBe('上場：乙包');
  });

  it('切換上場: a 上場 pack is checked and sends only its own setPackEnabled false', async () => {
    const values = settings();
    const { enabled } = find(packListView(PACKS, values), 'alpha-pack');
    const { remote, actions } = setup();

    expect(enabled.checked).toBe(true);
    const done = actions.toggle(enabled.toggle, 3);

    expect(remote.calls).toStrictEqual([
      {
        baseRev: 3,
        ops: [{ op: 'setPackEnabled', packId: 'alpha-pack', value: false }],
      },
    ]);
    remote.answer(SAVED);
    await done;
  });

  it('切換上場: the checkbox stays as StageView has it until StageView brings the new value', async () => {
    const values = settings();
    const { remote, states, actions } = setup();
    const before = find(packListView(PACKS, values), 'alpha-pack').enabled;

    const done = actions.toggle(before.toggle, 3);
    remote.answer(SAVED);
    await done;

    // Same StageView: still checked; the actions never touch it.
    expect(
      find(packListView(PACKS, values), 'alpha-pack').enabled.checked,
    ).toBe(true);
    expect(states.at(-1)).toStrictEqual(IDLE_PACK_LIST_ACTIONS);
    // StageView with main's new value: unchecked.
    const after = settings({ 'alpha-pack': false });
    expect(find(packListView(PACKS, after), 'alpha-pack').enabled.checked).toBe(
      false,
    );
    expect(find(packListView(PACKS, after), 'bravo-pack').enabled.checked).toBe(
      true,
    );
  });

  it('改回預設: an unchecked pack or character sends value true (main then removes the entry)', () => {
    const view = packListView(
      PACKS,
      settings(
        { 'alpha-pack': false },
        { 'alpha-pack/zeta': { inPool: false } },
      ),
    );

    const alpha = find(view, 'alpha-pack');
    expect(alpha.enabled.checked).toBe(false);
    expect(alpha.enabled.toggle).toStrictEqual(
      packEnabledOp('alpha-pack', true),
    );
    const zeta = character(view, 'alpha-pack', 'zeta');
    expect(zeta.inPool.checked).toBe(false);
    expect(zeta.inPool.toggle).toStrictEqual(
      inPoolOp('alpha-pack', 'zeta', true),
    );
  });

  it('加入池子: one character out of the pool leaves its pack mate and the same id in another pack checked', () => {
    const view = packListView(
      PACKS,
      settings({}, { 'alpha-pack/zeta': { inPool: false } }),
    );

    expect(character(view, 'alpha-pack', 'zeta').inPool.checked).toBe(false);
    expect(character(view, 'alpha-pack', 'beta').inPool.checked).toBe(true);
    expect(character(view, 'bravo-pack', 'zeta').inPool.checked).toBe(true);
    expect(find(view, 'alpha-pack').enabled.checked).toBe(true);
  });

  it('加入池子: the checkbox sends only setFixed of <packId>/<characterId>', async () => {
    const view = packListView(PACKS, settings());
    const { remote, actions } = setup();

    const done = actions.toggle(
      character(view, 'bravo-pack', 'zeta').inPool.toggle,
      4,
    );

    expect(remote.calls).toStrictEqual([
      {
        baseRev: 4,
        ops: [
          {
            op: 'setFixed',
            characterKey: 'bravo-pack/zeta',
            param: 'inPool',
            value: false,
          },
        ],
      },
    ]);
    remote.answer(SAVED);
    await done;
  });

  it('加入池子: works the same while the pack is not 上場', () => {
    const view = packListView(PACKS, settings({ 'alpha-pack': false }));

    const zeta = character(view, 'alpha-pack', 'zeta');
    expect(zeta.inPool.checked).toBe(true);
    expect(zeta.inPool.toggle).toStrictEqual(
      inPoolOp('alpha-pack', 'zeta', false),
    );
    expect(packListDisabled(false, true)).toBe(false);
  });

  it.each([[82], [138], [82.4], [137.6], [1], [400]])(
    '身高提示: height %s gets a hint with that height and the recommended range',
    (height) => {
      const hint = heightHintText(height);

      expect(hint).not.toBeNull();
      expect(hint).toContain(`身高 ${height}`);
      expect(hint).toContain('82.5～137.5');
    },
  );

  it.each([[82.5], [137.5], [110], [96]])(
    '身高提示: height %s gets no hint',
    (height) => {
      expect(heightHintText(height)).toBeNull();
    },
  );

  it('身高提示: says whether it may look small or large, and sits beside its character in the view', () => {
    expect(heightHintText(82)).toBe(
      '身高 82，建議 82.5～137.5，和其他角色放在一起可能偏小',
    );
    expect(heightHintText(138)).toBe(
      '身高 138，建議 82.5～137.5，和其他角色放在一起可能偏大',
    );
    const view = packListView(PACKS, settings());
    expect(character(view, 'alpha-pack', 'zeta').heightHint).toBeNull();
    expect(character(view, 'alpha-pack', 'beta').heightHint).toBe(
      heightHintText(82),
    );
    expect(character(view, 'bravo-pack', 'zeta').heightHint).toBe(
      heightHintText(138),
    );
  });

  it('身高提示: the hint id builds on its 加入池子 checkbox id (for aria-describedby); no hint, no id', () => {
    const view = packListView(PACKS, settings());

    const beta = character(view, 'alpha-pack', 'beta');
    expect(beta.heightHintId).toBe(`${beta.inPool.id}:hint`);
    const bravoZeta = character(view, 'bravo-pack', 'zeta');
    expect(bravoZeta.heightHintId).toBe('in-pool:bravo-pack/zeta:hint');
    expect(character(view, 'alpha-pack', 'zeta').heightHintId).toBeNull();
  });

  it('沒保存: saved false shows NOT_SAVED_TEXT, not an error and not success', async () => {
    const { remote, states, logError, actions } = setup();

    const done = actions.toggle(PACK_OFF, 3);
    remote.answer({ ok: true, data: { rev: 4, merged: false, saved: false } });
    await done;

    expect(states).toStrictEqual([
      { saving: true, error: null, notice: null },
      { saving: false, error: null, notice: NOT_SAVED_TEXT },
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('寫入失敗: an error reply shows why, with its code and message, and logs it', async () => {
    const { remote, states, logError, actions } = setup();
    const refused = {
      code: 'sender-rejected',
      message: 'sender is not allowed',
    } as const;

    const done = actions.toggle(PACK_OFF, 3);
    remote.answer({ ok: false, error: refused });
    await done;

    expect(states).toStrictEqual([
      { saving: true, error: null, notice: null },
      {
        saving: false,
        error: '無法變更角色包設定（sender-rejected：sender is not allowed）',
        notice: null,
      },
    ]);
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      '[panels] settings:patch: sender-rejected: sender is not allowed',
    );
  });

  it('寫入失敗: a call that rejects still resolves, with the plain failure text', async () => {
    const { remote, states, logError, actions } = setup();

    const done = actions.toggle(PACK_OFF, 3);
    remote.fail(new Error('gone'));
    await done;

    expect(states.at(-1)).toStrictEqual({
      saving: false,
      error: '無法變更角色包設定',
      notice: null,
    });
    expect(logError).toHaveBeenCalledOnce();
  });

  it('送出中: every checkbox is disabled while a patch is on its way, and a click then sends nothing', async () => {
    const { remote, states, actions } = setup();
    const view = packListView(PACKS, settings());

    const first = actions.toggle(find(view, 'alpha-pack').enabled.toggle, 3);
    expect(states.at(-1)?.saving).toBe(true);
    expect(packListDisabled(true, true)).toBe(true);
    await actions.toggle(
      character(view, 'bravo-pack', 'zeta').inPool.toggle,
      3,
    );
    await actions.toggle(find(view, 'bravo-pack').enabled.toggle, 3);

    expect(remote.patch).toHaveBeenCalledOnce();
    remote.answer(SAVED);
    await first;

    expect(packListDisabled(states.at(-1)!.saving, true)).toBe(false);
    const next = actions.toggle(find(view, 'bravo-pack').enabled.toggle, 8);
    expect(remote.patch).toHaveBeenCalledTimes(2);
    remote.answer(SAVED);
    await next;
  });

  it('送出中: with no preload API every checkbox is disabled', () => {
    expect(packListDisabled(false, false)).toBe(true);
  });

  it('換版本: a character gone from the new version is not listed; the ones still there keep their settings', () => {
    const values = settings(
      {},
      {
        'alpha-pack/zeta': { inPool: false },
        'alpha-pack/gone-character': { inPool: false },
      },
    );
    const newVersion: StagePacks = {
      installed: [{ ...ALPHA, version: '2.0.0' }, BRAVO],
    };

    const view = packListView(newVersion, values);

    const alpha = find(view, 'alpha-pack');
    expect(alpha.version).toBe('版本 2.0.0');
    expect(alpha.characters.map((entry) => entry.key)).toStrictEqual([
      'alpha-pack/zeta',
      'alpha-pack/beta',
    ]);
    expect(character(view, 'alpha-pack', 'zeta').inPool.checked).toBe(false);
  });

  it('沒安裝的設定: settings of packs and characters not installed are not listed', () => {
    const values = settings(
      { 'gone-pack': false },
      { 'gone-pack/zeta': { inPool: false } },
    );

    const view = packListView(PACKS, values);

    expect(view.map((pack) => pack.id)).toStrictEqual([
      'alpha-pack',
      'bravo-pack',
    ]);
    expect(view.every((pack) => pack.enabled.checked)).toBe(true);
    expect(
      view.flatMap((pack) => pack.characters).every((c) => c.inPool.checked),
    ).toBe(true);
  });

  it('超過上限: a patch main refuses (handler-failed) shows the failure, the checkbox left to StageView', async () => {
    const { remote, states, actions } = setup();

    const done = actions.toggle(packEnabledOp('charlie-pack', false), 3);
    remote.answer({
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    });
    await done;

    expect(states.at(-1)).toStrictEqual({
      saving: false,
      error: '無法變更角色包設定（handler-failed：handler failed）',
      notice: null,
    });
  });
});

describe('createPackListActions', () => {
  it('clears an earlier error or notice when the next change starts and once it is kept', async () => {
    const { remote, states, actions } = setup();
    const failed = actions.toggle(PACK_OFF, 3);
    remote.fail(new Error('gone'));
    await failed;

    const done = actions.toggle(PACK_OFF, 3);
    expect(states.at(-1)).toStrictEqual({
      saving: true,
      error: null,
      notice: null,
    });
    remote.answer(SAVED);
    await done;

    expect(states.at(-1)).toStrictEqual(IDLE_PACK_LIST_ACTIONS);
  });

  it('an onState that throws on the outcome does not leave the checkboxes stuck', async () => {
    const remote = manualPatch();
    let throwOnOutcome = true;
    const seen: PackListActionState[] = [];
    const actions = createPackListActions(
      { patch: remote.patch },
      (state) => {
        seen.push(state);
        if (!state.saving && throwOnOutcome) {
          throwOnOutcome = false;
          throw new Error('page gone');
        }
      },
      vi.fn(),
    );

    const first = actions.toggle(PACK_OFF, 3);
    remote.answer(SAVED);
    await expect(first).resolves.toBeUndefined();

    const second = actions.toggle(PACK_OFF, 4);
    expect(remote.patch).toHaveBeenCalledTimes(2);
    remote.answer(SAVED);
    await second;
  });

  it('an onState that throws when saving starts sends nothing, and the next click is not ignored', async () => {
    const remote = manualPatch();
    const logError = vi.fn();
    const outcomes: PackListActionState[] = [];
    const actions = createPackListActions(
      { patch: remote.patch },
      (state) => {
        if (state.saving) {
          throw new Error('page gone');
        }
        outcomes.push(state);
      },
      logError,
    );

    await actions.toggle(PACK_OFF, 3);
    await actions.toggle(PACK_OFF, 3);

    expect(remote.patch).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(2);
    expect(outcomes).toStrictEqual([
      { saving: false, error: '無法變更角色包設定', notice: null },
      { saving: false, error: '無法變更角色包設定', notice: null },
    ]);
  });
});
