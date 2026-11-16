import { describe, expect, it, vi } from 'vitest';
import {
  NOT_SAVED_TEXT,
  patchErrorText,
} from '../../src/panels/display-options';
import {
  createPackListActions,
  createPackRowActions,
  ENABLED_LABEL,
  EXPORT_BUTTON_LABEL,
  EXPORT_FAILURE_TEXTS,
  EXPORTING_TEXT,
  exportRequestErrorText,
  heightHintText,
  IDLE_PACK_LIST_ACTIONS,
  IDLE_PACK_ROW_ACTIONS,
  IN_POOL_LABEL,
  inPoolOp,
  NO_PACKS_TEXT,
  PACK_LIST_HEADING,
  PACK_LIST_PATCH_FAILED,
  packEnabledOp,
  packListDisabled,
  packExportStatus,
  packListPatch,
  packListView,
  packRowControls,
  RECOMMENDED_HEIGHT_RANGE,
  REMOVE_BUTTON_LABEL,
  REMOVE_CANCEL_LABEL,
  REMOVE_CONFIRM_LABEL,
  REMOVE_FAILURE_TEXTS,
  removeConfirmText,
  removeFailedText,
  versionText,
  type PackListActionState,
  type PackListPack,
  type PackRowActionState,
  type PackRowButton,
  type PackRowPress,
} from '../../src/panels/pack-list';
import type { IpcResult } from '../../src/shared/ipc';
import {
  PACK_EXPORT_FAILURE_CODES,
  PACK_REMOVE_FAILURE_CODES,
  stagePackExportSchema,
  type PackRemoveResult,
  type StagePackExport,
  type StagePacks,
} from '../../src/shared/packs';
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

// ---------------------------------------------------------------------------
// 匯出… and 移除… (Story 3.3's second half).

/** FSI … PDI around an author-written name. */
function iso(name: string): string {
  return `\u2068${name}\u2069`;
}

const IDLE_EXPORT: StagePackExport = { phase: 'idle' };
const SAVING_ALPHA: StagePackExport = { phase: 'saving', packId: 'alpha-pack' };

/** The rows of PACKS (packListView), by id. */
function rows(): readonly PackListPack[] {
  return packListView(PACKS, settings());
}

function row(id: string): PackListPack {
  return find(rows(), id);
}

/** The button of `key` among `buttons`. */
function button(
  buttons: readonly PackRowButton[],
  key: PackRowButton['key'],
): PackRowButton {
  const found = buttons.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`no ${key} button`);
  }
  return found;
}

/** A packs API whose replies the test hands out one by one. */
function manualPacks() {
  const calls: string[] = [];
  const exports: {
    resolve: (reply: IpcResult<null>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const removals: {
    resolve: (reply: IpcResult<PackRemoveResult>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const api = {
    export: vi.fn(
      (packId: string) =>
        new Promise<IpcResult<null>>((resolve, reject) => {
          calls.push(`export ${packId}`);
          exports.push({ resolve, reject });
        }),
    ),
    remove: vi.fn(
      (packId: string) =>
        new Promise<IpcResult<PackRemoveResult>>((resolve, reject) => {
          calls.push(`remove ${packId}`);
          removals.push({ resolve, reject });
        }),
    ),
  };
  return {
    api,
    calls,
    answerExport: (reply: IpcResult<null>) => exports.shift()?.resolve(reply),
    failExport: (error: unknown) => exports.shift()?.reject(error),
    answerRemove: (reply: IpcResult<PackRemoveResult>) =>
      removals.shift()?.resolve(reply),
    failRemove: (error: unknown) => removals.shift()?.reject(error),
  };
}

function rowSetup() {
  const remote = manualPacks();
  const states: PackRowActionState[] = [];
  const logError = vi.fn();
  const actions = createPackRowActions(
    remote.api,
    (state) => {
      states.push(state);
    },
    logError,
  );
  /** The page's state now (what React would hold). */
  const now = () => states.at(-1) ?? IDLE_PACK_ROW_ACTIONS;
  /** Presses `key` on the row of `id` as the page shows it now. */
  const press = (id: string, key: PackRowButton['key']) => {
    const controls = packRowControls(row(id), IDLE_EXPORT, now(), true);
    const all = [...controls.buttons, ...(controls.confirm?.buttons ?? [])];
    return actions.press(button(all, key).press);
  };
  return { remote, states, logError, actions, now, press };
}

const REMOVED: IpcResult<PackRemoveResult> = { ok: true, data: { ok: true } };

describe('the export and removal texts', () => {
  it('the buttons and the status while saving', () => {
    expect(EXPORT_BUTTON_LABEL).toBe('匯出…');
    expect(REMOVE_BUTTON_LABEL).toBe('移除…');
    expect(REMOVE_CONFIRM_LABEL).toBe('移除');
    expect(REMOVE_CANCEL_LABEL).toBe('取消');
    expect(EXPORTING_TEXT).toBe('匯出中…');
  });

  it.each([
    ['export', EXPORT_FAILURE_TEXTS, PACK_EXPORT_FAILURE_CODES],
    ['removal', REMOVE_FAILURE_TEXTS, PACK_REMOVE_FAILURE_CODES],
  ] as const)(
    'every %s failure code has its own Chinese text, and no other code does',
    (_label, texts, codes) => {
      expect(Object.keys(texts).sort()).toStrictEqual([...codes].sort());
      for (const code of codes) {
        expect(texts[code as keyof typeof texts]).toMatch(/\p{Script=Han}/u);
        expect(texts[code as keyof typeof texts]).not.toContain(code);
      }
      expect(new Set(Object.values(texts)).size).toBe(codes.length);
    },
  );

  it('not-installed reads 已不在, for an export and a removal alike', () => {
    expect(EXPORT_FAILURE_TEXTS['not-installed']).toContain('已不在');
    expect(REMOVE_FAILURE_TEXTS['not-installed']).toContain('已不在');
  });

  it('the removal question names the pack (isolated) and its version, and says the settings stay', () => {
    expect(removeConfirmText('甲包', '版本 1.2.0')).toBe(
      `要移除「${iso('甲包')}」版本 1.2.0 嗎？它的檔案會刪除；上場與加入池子的選擇會保留，之後重新匯入同一包時會回來。`,
    );
  });

  it('a request that fails names the pack, then the code and message', () => {
    const error = { code: 'invoke-failed', message: 'invoke failed' } as const;
    expect(exportRequestErrorText('甲包', error)).toBe(
      `無法開始匯出「${iso('甲包')}」（invoke-failed：invoke failed）`,
    );
    expect(exportRequestErrorText('甲包', undefined)).toBe(
      `無法開始匯出「${iso('甲包')}」`,
    );
    expect(removeFailedText('甲包', { error })).toBe(
      `無法移除「${iso('甲包')}」（invoke-failed：invoke failed）`,
    );
    expect(removeFailedText('甲包', { error: undefined })).toBe(
      `無法移除「${iso('甲包')}」`,
    );
    expect(removeFailedText('甲包', { code: 'index-write-failed' })).toBe(
      `無法移除「${iso('甲包')}」：${REMOVE_FAILURE_TEXTS['index-write-failed']}`,
    );
  });
});

describe('I/O matrix', () => {
  it('匯出: every row has 匯出… then 移除…, named with its pack; 匯出… sends packs:export of that pack once, and nothing else changes on the page', async () => {
    const { remote, states, press } = rowSetup();
    const controls = packRowControls(
      row('bravo-pack'),
      IDLE_EXPORT,
      IDLE_PACK_ROW_ACTIONS,
      true,
    );
    expect(
      controls.buttons.map(({ key, label, ariaLabel, disabled }) => ({
        key,
        label,
        ariaLabel,
        disabled,
      })),
    ).toStrictEqual([
      {
        key: 'export',
        label: '匯出…',
        ariaLabel: '匯出：乙包',
        disabled: false,
      },
      {
        key: 'ask-remove',
        label: '移除…',
        ariaLabel: '移除：乙包',
        disabled: false,
      },
    ]);
    expect(controls.confirm).toBeNull();

    const pressed = press('bravo-pack', 'export');
    expect(remote.calls).toStrictEqual(['export bravo-pack']);
    expect(states.at(-1)).toStrictEqual({
      confirming: null,
      sending: true,
      error: null,
    });
    remote.answerExport({ ok: true, data: null });
    await pressed;

    expect(states.at(-1)).toStrictEqual(IDLE_PACK_ROW_ACTIONS);
    expect(remote.api.remove).not.toHaveBeenCalled();
  });

  it("匯出: while an export is saving, every row's 匯出… is disabled and 移除… is not; the status line says 匯出中…", () => {
    for (const pack of rows()) {
      const controls = packRowControls(
        pack,
        SAVING_ALPHA,
        IDLE_PACK_ROW_ACTIONS,
        true,
      );
      expect(button(controls.buttons, 'export').disabled, pack.id).toBe(true);
      expect(button(controls.buttons, 'ask-remove').disabled, pack.id).toBe(
        false,
      );
    }
    expect(packExportStatus(SAVING_ALPHA)).toStrictEqual({
      tone: 'progress',
      text: '匯出中…',
    });
  });

  it('取消匯出: back to idle, no status line and no error', () => {
    expect(packExportStatus({ phase: 'idle' })).toBeNull();
    for (const pack of rows()) {
      const controls = packRowControls(
        pack,
        IDLE_EXPORT,
        IDLE_PACK_ROW_ACTIONS,
        true,
      );
      expect(button(controls.buttons, 'export').disabled).toBe(false);
    }
  });

  it('匯出完成: 已匯出 with the name (isolated) and version', () => {
    const exported: StagePackExport = {
      phase: 'result',
      outcome: 'exported',
      packId: 'alpha-pack',
      name: '甲包',
      version: '1.2.0',
    };
    expect(stagePackExportSchema.safeParse(exported).success).toBe(true);

    expect(packExportStatus(exported)).toStrictEqual({
      tone: 'success',
      text: `已匯出：${iso('甲包')} 1.2.0`,
    });
  });

  it.each([
    ['讀不到', 'read-failed'],
    ['寫不進', 'write-failed'],
    ['匯出時被移除', 'not-installed'],
  ] as const)(
    '%s: a failed %s export shows its Chinese reason and that nothing was written',
    (_row, code) => {
      expect(
        packExportStatus({
          phase: 'result',
          outcome: 'failed',
          packId: 'alpha-pack',
          code,
        }),
      ).toStrictEqual({
        tone: 'error',
        text: `無法匯出：${EXPORT_FAILURE_TEXTS[code]}。沒有寫出任何檔案。`,
      });
    },
  );

  it('匯出中再匯出: while a request is on its way, every row button is disabled and a press sends nothing', async () => {
    const { remote, actions, now, press } = rowSetup();
    const first = press('alpha-pack', 'export');

    for (const pack of rows()) {
      const controls = packRowControls(pack, IDLE_EXPORT, now(), true);
      for (const entry of controls.buttons) {
        expect(entry.disabled, `${pack.id} ${entry.key}`).toBe(true);
      }
    }
    await actions.press({
      kind: 'export',
      packId: 'bravo-pack',
      name: '乙包',
    });
    await actions.press({ kind: 'ask-remove', packId: 'bravo-pack' });
    await actions.press({
      kind: 'remove',
      packId: 'bravo-pack',
      name: '乙包',
    });

    expect(remote.calls).toStrictEqual(['export alpha-pack']);
    expect(now().confirming).toBeNull();
    remote.answerExport({ ok: true, data: null });
    await first;
  });

  it('移除確認: 移除… sends nothing; only that row then shows its name, version, 移除 and 取消, and its 移除… is disabled', async () => {
    const { remote, states, now, press } = rowSetup();

    await press('alpha-pack', 'ask-remove');

    expect(remote.calls).toStrictEqual([]);
    expect(states).toStrictEqual([
      { confirming: 'alpha-pack', sending: false, error: null },
    ]);
    const alpha = packRowControls(row('alpha-pack'), IDLE_EXPORT, now(), true);
    expect(alpha.confirm).toStrictEqual({
      id: 'remove-confirm:alpha-pack',
      text: removeConfirmText('甲包', '版本 1.2.0'),
      buttons: [
        {
          key: 'remove',
          label: '移除',
          ariaLabel: '確定移除：甲包',
          disabled: false,
          press: { kind: 'remove', packId: 'alpha-pack', name: '甲包' },
        },
        {
          key: 'keep',
          label: '取消',
          ariaLabel: '取消移除：甲包',
          disabled: false,
          press: { kind: 'keep' },
        },
      ],
    });
    expect(alpha.confirm?.text).toContain('甲包');
    expect(alpha.confirm?.text).toContain('1.2.0');
    expect(button(alpha.buttons, 'ask-remove').disabled).toBe(true);
    expect(button(alpha.buttons, 'export').disabled).toBe(false);
    const bravo = packRowControls(row('bravo-pack'), IDLE_EXPORT, now(), true);
    expect(bravo.confirm).toBeNull();
    expect(button(bravo.buttons, 'ask-remove').disabled).toBe(false);
  });

  it('移除確認: 移除… on another row moves the question there', async () => {
    const { now, press } = rowSetup();
    await press('alpha-pack', 'ask-remove');

    await press('bravo-pack', 'ask-remove');

    expect(now().confirming).toBe('bravo-pack');
    expect(
      packRowControls(row('alpha-pack'), IDLE_EXPORT, now(), true).confirm,
    ).toBeNull();
  });

  it('取消移除: 取消 sends nothing and the row is back as it was', async () => {
    const { remote, now, press } = rowSetup();
    const before = packRowControls(row('alpha-pack'), IDLE_EXPORT, now(), true);
    await press('alpha-pack', 'ask-remove');

    await press('alpha-pack', 'keep');

    expect(remote.calls).toStrictEqual([]);
    expect(now()).toStrictEqual(IDLE_PACK_ROW_ACTIONS);
    expect(
      packRowControls(row('alpha-pack'), IDLE_EXPORT, now(), true),
    ).toStrictEqual(before);
  });

  it('移除: 移除 sends packs:remove of that pack once (every row button disabled meanwhile); then the question goes with no error; the row itself stays until StageView drops it', async () => {
    const { remote, states, now, press } = rowSetup();
    await press('alpha-pack', 'ask-remove');

    const removing = press('alpha-pack', 'remove');
    expect(remote.calls).toStrictEqual(['remove alpha-pack']);
    expect(now()).toStrictEqual({
      confirming: 'alpha-pack',
      sending: true,
      error: null,
    });
    const meanwhile = packRowControls(
      row('alpha-pack'),
      IDLE_EXPORT,
      now(),
      true,
    );
    for (const entry of [
      ...meanwhile.buttons,
      ...(meanwhile.confirm?.buttons ?? []),
    ]) {
      expect(entry.disabled, entry.key).toBe(true);
    }
    remote.answerRemove(REMOVED);
    await removing;

    expect(states.at(-1)).toStrictEqual(IDLE_PACK_ROW_ACTIONS);
    // The page's list comes from StageView only: still listed here.
    expect(rows().map((pack) => pack.id)).toStrictEqual([
      'alpha-pack',
      'bravo-pack',
    ]);
    // Once StageView's packs section drops it, so does the list.
    expect(
      packListView({ installed: [BRAVO] }, settings()).map((pack) => pack.id),
    ).toStrictEqual(['bravo-pack']);
  });

  it('刪資料夾失敗: main still answers removed, so the page shows no error', async () => {
    const { remote, now, press } = rowSetup();
    await press('alpha-pack', 'ask-remove');
    const removing = press('alpha-pack', 'remove');
    remote.answerRemove(REMOVED);
    await removing;

    expect(now().error).toBeNull();
  });

  it.each([['index-unwritable'], ['index-write-failed']] as const)(
    '移除失敗: %s shows why, in Chinese, with the pack name; the question goes and the list is left to StageView',
    async (code) => {
      const { remote, now, press, logError } = rowSetup();
      await press('alpha-pack', 'ask-remove');
      const removing = press('alpha-pack', 'remove');
      remote.answerRemove({ ok: true, data: { ok: false, code } });
      await removing;

      expect(now()).toStrictEqual({
        confirming: null,
        sending: false,
        error: `無法移除「${iso('甲包')}」：${REMOVE_FAILURE_TEXTS[code]}`,
      });
      expect(logError).not.toHaveBeenCalled();
      expect(rows().map((pack) => pack.id)).toContain('alpha-pack');
    },
  );

  it('已不在: not-installed shows 已不在', async () => {
    const { remote, now, press } = rowSetup();
    await press('alpha-pack', 'ask-remove');
    const removing = press('alpha-pack', 'remove');
    remote.answerRemove({
      ok: true,
      data: { ok: false, code: 'not-installed' },
    });
    await removing;

    expect(now().error).toBe(
      `無法移除「${iso('甲包')}」：${REMOVE_FAILURE_TEXTS['not-installed']}`,
    );
    expect(now().error).toContain('已不在');
  });

  it.each([
    ['invalid-input', 'arguments do not match the channel schema'],
    ['sender-rejected', 'sender is not allowed'],
  ] as const)(
    '壞輸入: a %s reply shows the code and message and is logged; nothing else changes',
    async (code, message) => {
      const { remote, now, press, logError } = rowSetup();
      const exporting = press('alpha-pack', 'export');
      remote.answerExport({ ok: false, error: { code, message } });
      await exporting;
      expect(now().error).toBe(
        `無法開始匯出「${iso('甲包')}」（${code}：${message}）`,
      );

      await press('alpha-pack', 'ask-remove');
      const removing = press('alpha-pack', 'remove');
      remote.answerRemove({ ok: false, error: { code, message } });
      await removing;
      expect(now()).toStrictEqual({
        confirming: null,
        sending: false,
        error: `無法移除「${iso('甲包')}」（${code}：${message}）`,
      });
      expect(logError.mock.calls.map((call) => call[0])).toStrictEqual([
        `[panels] packs:export: ${code}: ${message}`,
        `[panels] packs:remove: ${code}: ${message}`,
      ]);
    },
  );

  it('壞輸入: with no preload API every row button is disabled', () => {
    const controls = packRowControls(
      row('alpha-pack'),
      IDLE_EXPORT,
      { confirming: 'alpha-pack', sending: false, error: null },
      false,
    );
    for (const entry of [
      ...controls.buttons,
      ...(controls.confirm?.buttons ?? []),
    ]) {
      expect(entry.disabled, entry.key).toBe(true);
    }
  });
});

describe('createPackRowActions', () => {
  it('a call that rejects still resolves, with the plain failure text, and is logged', async () => {
    const { remote, now, press, logError } = rowSetup();
    const exporting = press('alpha-pack', 'export');
    remote.failExport(new Error('gone'));
    await expect(exporting).resolves.toBeUndefined();
    expect(now().error).toBe(`無法開始匯出「${iso('甲包')}」`);

    await press('alpha-pack', 'ask-remove');
    const removing = press('alpha-pack', 'remove');
    remote.failRemove(new Error('gone'));
    await expect(removing).resolves.toBeUndefined();
    expect(now()).toStrictEqual({
      confirming: null,
      sending: false,
      error: `無法移除「${iso('甲包')}」`,
    });
    expect(logError.mock.calls.map((call) => call[0])).toStrictEqual([
      '[panels] packs:export failed',
      '[panels] packs:remove failed',
    ]);
  });

  it('移除… clears an earlier error; the next request clears it too', async () => {
    const { remote, now, press } = rowSetup();
    const exporting = press('alpha-pack', 'export');
    remote.failExport(new Error('gone'));
    await exporting;

    await press('alpha-pack', 'ask-remove');
    expect(now().error).toBeNull();

    await press('alpha-pack', 'keep');
    const again = press('alpha-pack', 'export');
    remote.failExport(new Error('gone'));
    await again;
    const last = press('alpha-pack', 'export');
    expect(now().error).toBeNull();
    remote.answerExport({ ok: true, data: null });
    await last;
  });

  it('an export does not close a question open on another row', async () => {
    const { remote, now, press } = rowSetup();
    await press('bravo-pack', 'ask-remove');

    const exporting = press('alpha-pack', 'export');
    remote.answerExport({ ok: true, data: null });
    await exporting;

    expect(now().confirming).toBe('bravo-pack');
  });

  it('an onState that throws when a request starts sends nothing, and the next press is not ignored', async () => {
    const remote = manualPacks();
    const logError = vi.fn();
    const outcomes: PackRowActionState[] = [];
    const actions = createPackRowActions(
      remote.api,
      (state) => {
        if (state.sending) {
          throw new Error('page gone');
        }
        outcomes.push(state);
      },
      logError,
    );
    const press: PackRowPress = {
      kind: 'export',
      packId: 'alpha-pack',
      name: '甲包',
    };

    await actions.press(press);
    await actions.press(press);

    expect(remote.api.export).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(2);
    expect(outcomes).toStrictEqual([
      {
        confirming: null,
        sending: false,
        error: `無法開始匯出「${iso('甲包')}」`,
      },
      {
        confirming: null,
        sending: false,
        error: `無法開始匯出「${iso('甲包')}」`,
      },
    ]);
  });

  it('an onState that throws on the outcome does not leave the buttons stuck', async () => {
    const remote = manualPacks();
    let throwOnOutcome = true;
    const actions = createPackRowActions(
      remote.api,
      (state) => {
        if (!state.sending && throwOnOutcome) {
          throwOnOutcome = false;
          throw new Error('page gone');
        }
      },
      vi.fn(),
    );
    const press: PackRowPress = {
      kind: 'export',
      packId: 'alpha-pack',
      name: '甲包',
    };

    const first = actions.press(press);
    remote.answerExport({ ok: true, data: null });
    await expect(first).resolves.toBeUndefined();

    const second = actions.press(press);
    expect(remote.api.export).toHaveBeenCalledTimes(2);
    remote.answerExport({ ok: true, data: null });
    await second;
  });

  it('an onState that throws on 移除… or 取消 is ignored; the question still opens and closes', async () => {
    const remote = manualPacks();
    const actions = createPackRowActions(
      remote.api,
      () => {
        throw new Error('page gone');
      },
      vi.fn(),
    );

    await expect(
      actions.press({ kind: 'ask-remove', packId: 'alpha-pack' }),
    ).resolves.toBeUndefined();
    await expect(actions.press({ kind: 'keep' })).resolves.toBeUndefined();
    expect(remote.calls).toStrictEqual([]);
  });
});
