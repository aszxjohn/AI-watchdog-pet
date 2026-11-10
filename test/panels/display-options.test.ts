import { describe, expect, it, vi } from 'vitest';
import {
  canvasDisplayText,
  createDisplayChooser,
  displayChoices,
  displayOptionLabel,
  displayPatch,
  patchErrorText,
  PRIMARY_OPTION_LABEL,
  stageViewStatusText,
  type DisplayChoiceState,
} from '../../src/panels/display-options';
import type { IpcResult } from '../../src/shared/ipc';
import {
  SETTINGS_DEFAULTS,
  settingsPatchSchema,
  type SettingsPatch,
  type SettingsPatchResult,
} from '../../src/shared/settings';
import type {
  StageCanvas,
  StageDisplay,
  StageView,
} from '../../src/shared/stage-view';

const BUILT_IN: StageDisplay = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  primary: true,
};
const EXTERNAL: StageDisplay = {
  id: 69733632,
  label: 'DELL U2720Q',
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  primary: false,
};

function view(
  canvasDisplayId: number | null,
  displays: StageDisplay[] = [BUILT_IN, EXTERNAL],
  rev = 3,
): Pick<StageView, 'settings' | 'displays'> {
  return {
    settings: { rev, values: { ...SETTINGS_DEFAULTS, canvasDisplayId } },
    displays,
  };
}

describe('displayOptionLabel', () => {
  it('names the display with width × height, marking the primary one', () => {
    expect(displayOptionLabel(BUILT_IN)).toBe(
      'Built-in Retina Display 1512×982・目前的主螢幕',
    );
    expect(displayOptionLabel(EXTERNAL)).toBe('DELL U2720Q 2560×1440');
  });

  it('calls an unnamed display 螢幕 <id>', () => {
    expect(displayOptionLabel({ ...EXTERNAL, label: '  ' })).toBe(
      '螢幕 69733632 2560×1440',
    );
  });
});

describe('displayChoices', () => {
  it('lists 主螢幕（跟著系統設定）first, then every display, and selects it when the setting is null', () => {
    expect(displayChoices(view(null))).toStrictEqual({
      options: [
        { key: 'primary', value: null, label: '主螢幕（跟著系統設定）' },
        {
          key: 'display-1',
          value: 1,
          label: 'Built-in Retina Display 1512×982・目前的主螢幕',
        },
        {
          key: 'display-69733632',
          value: 69733632,
          label: 'DELL U2720Q 2560×1440',
        },
      ],
      selected: 'primary',
    });
    expect(PRIMARY_OPTION_LABEL).toBe('主螢幕（跟著系統設定）');
  });

  it('selects the display the setting names', () => {
    expect(displayChoices(view(EXTERNAL.id)).selected).toBe('display-69733632');
    expect(displayChoices(view(BUILT_IN.id)).selected).toBe('display-1');
  });

  it('adds 螢幕 <id>（未連接，暫用主螢幕）and selects it when the chosen display is not connected', () => {
    const choices = displayChoices(view(EXTERNAL.id, [BUILT_IN]));

    expect(choices.options.map((option) => option.label)).toStrictEqual([
      '主螢幕（跟著系統設定）',
      'Built-in Retina Display 1512×982・目前的主螢幕',
      '螢幕 69733632（未連接，暫用主螢幕）',
    ]);
    expect(choices.options.at(-1)).toStrictEqual({
      key: 'missing-69733632',
      value: 69733632,
      label: '螢幕 69733632（未連接，暫用主螢幕）',
    });
    expect(choices.selected).toBe('missing-69733632');
  });

  it('follows StageView: the primary mark moves with the system setting', () => {
    const swapped = displayChoices(
      view(null, [
        { ...BUILT_IN, primary: false },
        { ...EXTERNAL, primary: true },
      ]),
    );
    expect(swapped.options.map((option) => option.label)).toStrictEqual([
      '主螢幕（跟著系統設定）',
      'Built-in Retina Display 1512×982',
      'DELL U2720Q 2560×1440・目前的主螢幕',
    ]);
  });

  it('has only 主螢幕 when no display is listed yet', () => {
    expect(displayChoices(view(null, []))).toStrictEqual({
      options: [{ key: 'primary', value: null, label: PRIMARY_OPTION_LABEL }],
      selected: 'primary',
    });
  });

  it('gives every option a distinct key', () => {
    const { options } = displayChoices(view(42));
    expect(new Set(options.map((option) => option.key)).size).toBe(
      options.length,
    );
  });
});

describe('displayPatch', () => {
  it('sets canvasDisplayId from the StageView settings rev', () => {
    const [, external] = displayChoices(view(null, undefined, 7)).options;
    const patch = displayPatch(7, external!);

    expect(patch).toStrictEqual({
      baseRev: 7,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: 1 }],
    });
    expect(settingsPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('sets null for 主螢幕（跟著系統設定）', () => {
    const current = view(EXTERNAL.id);
    const [primary] = displayChoices(current).options;

    expect(displayPatch(current.settings.rev, primary!)).toStrictEqual({
      baseRev: 3,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: null }],
    });
  });
});

describe('patchErrorText', () => {
  it('says the change failed, with the error code when there is one', () => {
    expect(
      patchErrorText({ code: 'invoke-failed', message: 'invoke failed' }),
    ).toBe('無法變更畫布所在螢幕（invoke-failed：invoke failed）');
    expect(patchErrorText(undefined)).toBe('無法變更畫布所在螢幕');
  });
});

describe('createDisplayChooser', () => {
  type Reply = IpcResult<SettingsPatchResult>;

  /** A settings.patch whose reply the test sends when it wants. */
  function manualPatch() {
    const calls: SettingsPatch[] = [];
    /** One entry per pending call, oldest first. */
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
    const states: DisplayChoiceState[] = [];
    const logError = vi.fn();
    const chooser = createDisplayChooser(
      remote.patch,
      (state) => {
        states.push(state);
      },
      logError,
    );
    const choices = displayChoices(view(null));
    const option = (key: string) => choices.options.find((o) => o.key === key)!;
    return { remote, states, logError, chooser, choices, option };
  }

  const CURRENT = { selected: 'primary', settingsRev: 3 };

  it('does nothing when the chosen option is already selected', async () => {
    const { remote, states, chooser, option } = setup();

    await chooser.choose(option('primary'), CURRENT);

    expect(remote.patch).not.toHaveBeenCalled();
    expect(states).toStrictEqual([]);
  });

  it('reports saving while the reply is pending, and sends the patch at the StageView settings rev', async () => {
    const { remote, states, chooser, option } = setup();

    const done = chooser.choose(option('display-69733632'), CURRENT);

    expect(states).toStrictEqual([{ saving: true, error: null }]);
    expect(remote.calls).toStrictEqual([
      {
        baseRev: 3,
        ops: [{ op: 'set', field: 'canvasDisplayId', value: 69733632 }],
      },
    ]);
    remote.answer({ ok: true, data: { rev: 4, merged: false } });
    await done;
  });

  it('ignores another choice while one is on its way', async () => {
    const { remote, chooser, option } = setup();

    const first = chooser.choose(option('display-69733632'), CURRENT);
    await chooser.choose(option('display-1'), CURRENT);

    expect(remote.patch).toHaveBeenCalledOnce();
    remote.answer({ ok: true, data: { rev: 4, merged: false } });
    await first;
  });

  it('shows patchErrorText for { ok: false }, ends saving, and never touches the selection', async () => {
    const { remote, states, logError, chooser, option } = setup();
    const refused = {
      code: 'sender-rejected',
      message: 'sender is not allowed',
    } as const;

    const done = chooser.choose(option('display-1'), CURRENT);
    remote.answer({ ok: false, error: refused });
    await done;

    expect(states).toStrictEqual([
      { saving: true, error: null },
      { saving: false, error: patchErrorText(refused) },
    ]);
    for (const state of states) {
      expect(Object.keys(state).sort()).toStrictEqual(['error', 'saving']);
    }
    expect(logError).toHaveBeenCalledOnce();
  });

  it('shows the generic error when the call rejects', async () => {
    const { remote, states, chooser, option } = setup();

    const done = chooser.choose(option('display-1'), CURRENT);
    remote.fail(new Error('gone'));
    await done;

    expect(states.at(-1)).toStrictEqual({
      saving: false,
      error: '無法變更畫布所在螢幕',
    });
  });

  it('clears saving and an earlier error on success, and can choose again', async () => {
    const { remote, states, chooser, option } = setup();
    const failed = chooser.choose(option('display-1'), CURRENT);
    remote.fail(new Error('gone'));
    await failed;

    const done = chooser.choose(option('display-1'), CURRENT);
    expect(states.at(-1)).toStrictEqual({ saving: true, error: null });
    remote.answer({ ok: true, data: { rev: 4, merged: false } });
    await done;

    expect(states.at(-1)).toStrictEqual({ saving: false, error: null });
    expect(remote.patch).toHaveBeenCalledTimes(2);
  });
});

describe('the StageView status line', () => {
  const ON_BUILT_IN: NonNullable<StageCanvas> = {
    displayId: 1,
    bounds: BUILT_IN.bounds,
    scaleFactor: 2,
    fallback: false,
  };

  it.each([
    ['the primary display', ON_BUILT_IN, '主螢幕'],
    [
      'another display, by its name',
      { ...ON_BUILT_IN, displayId: EXTERNAL.id, bounds: EXTERNAL.bounds },
      'DELL U2720Q',
    ],
    [
      'the primary display while the chosen one is unplugged',
      { ...ON_BUILT_IN, fallback: true },
      '主螢幕（暫用主螢幕）',
    ],
    ['no canvas yet', null, '尚未就緒'],
    [
      'a display StageView does not list',
      { ...ON_BUILT_IN, displayId: 7 },
      '螢幕 7',
    ],
  ])('%s -> %s', (_label, canvas, text) => {
    expect(canvasDisplayText({ displays: [BUILT_IN, EXTERNAL], canvas })).toBe(
      text,
    );
  });

  it('names an unnamed display 螢幕 <id>', () => {
    expect(
      canvasDisplayText({
        displays: [BUILT_IN, { ...EXTERNAL, label: '' }],
        canvas: { ...ON_BUILT_IN, displayId: EXTERNAL.id },
      }),
    ).toBe('螢幕 69733632');
  });

  it('reads the canvas section, not the setting: a fallback shows where the canvas is', () => {
    expect(
      stageViewStatusText({
        rev: 9,
        view: {
          settings: {
            rev: 2,
            values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 999 },
          },
          displays: [BUILT_IN, EXTERNAL],
          canvas: { ...ON_BUILT_IN, fallback: true },
          power: { suspended: false, locked: false },
          sessions: [],
          adapters: [],
        },
      }),
    ).toBe('StageView rev 9｜畫布螢幕：主螢幕（暫用主螢幕）');
  });
});
