import { describe, expect, it, vi } from 'vitest';
import { NOT_SAVED_TEXT } from '../../src/panels/display-options';
import {
  createTimingSaver,
  IDLE_TIMING_SAVE,
  parseTiming,
  SAVE_LABEL,
  SAVED_TEXT,
  saveErrorText,
  TIMING_FIELDS,
  TIMING_HEADING,
  timingErrorText,
  timingForm,
  timingRange,
  timingRangeText,
  timingText,
  type TimingDrafts,
  type TimingField,
  type TimingFieldDef,
  type TimingSaveState,
} from '../../src/panels/timing-fields';
import type { IpcResult } from '../../src/shared/ipc';
import {
  SETTINGS_DEFAULTS,
  settingsFieldSchemas,
  settingsPatchSchema,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsState,
  type SettingsValues,
} from '../../src/shared/settings';

function def(field: TimingField): TimingFieldDef {
  const found = TIMING_FIELDS.find((entry) => entry.field === field);
  if (found === undefined) {
    throw new Error(`no field ${field}`);
  }
  return found;
}

/** StageView's settings section. */
function settings(
  values: Partial<SettingsValues> = {},
  rev = 3,
): SettingsState {
  return { rev, values: { ...SETTINGS_DEFAULTS, ...values } };
}

describe('the fields', () => {
  it('are 做完了過場 (秒), 無動靜轉休息中 (分鐘), 推測要你批准 (秒), in that order', () => {
    expect(TIMING_FIELDS).toStrictEqual([
      { field: 'doneMs', label: '做完了過場', unit: '秒', unitMs: 1000 },
      {
        field: 'idleMs',
        label: '無動靜轉休息中',
        unit: '分鐘',
        unitMs: 60_000,
      },
      {
        field: 'approvalInferMs',
        label: '推測要你批准',
        unit: '秒',
        unitMs: 1000,
      },
    ]);
    expect(Object.isFrozen(TIMING_FIELDS)).toBe(true);
    for (const entry of TIMING_FIELDS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(TIMING_HEADING).toBe('計時');
    expect(SAVE_LABEL).toBe('儲存');
  });

  it.each([
    ['doneMs', 1, 60, '範圍 1～60'],
    ['idleMs', 1, 60, '範圍 1～60'],
    ['approvalInferMs', 1, 600, '範圍 1～600'],
  ] as const)('%s takes %i to %i whole units', (field, min, max, rangeText) => {
    expect(timingRange(def(field))).toStrictEqual({ min, max });
    expect(timingRangeText(def(field))).toBe(rangeText);
    expect(timingErrorText(def(field))).toBe(`請輸入 ${min}～${max} 的整數`);
  });

  it.each(TIMING_FIELDS)(
    "$field's range is its settings schema's, not a number of its own",
    (entry) => {
      const schema = settingsFieldSchemas[entry.field];
      const { min, max } = timingRange(entry);
      expect(min * entry.unitMs).toBe(schema.minValue);
      expect(max * entry.unitMs).toBe(schema.maxValue);
    },
  );
});

describe('timingText', () => {
  it.each([
    ['doneMs', 5000, '5'],
    ['doneMs', 1500, '1.5'],
    ['idleMs', 300_000, '5'],
    ['idleMs', 90_000, '1.5'],
    ['approvalInferMs', 10_000, '10'],
    ['approvalInferMs', 600_000, '600'],
  ] as const)('%s %i ms shows as %s', (field, valueMs, text) => {
    expect(timingText(def(field), valueMs)).toBe(text);
  });
});

describe('parseTiming', () => {
  it.each([
    ['doneMs', '8', 8000],
    ['doneMs', '1', 1000],
    ['doneMs', '60', 60_000],
    ['doneMs', ' 8 ', 8000],
    ['doneMs', '08', 8000],
    ['idleMs', '2', 120_000],
    ['idleMs', '60', 3_600_000],
    ['approvalInferMs', '5', 5000],
    ['approvalInferMs', '600', 600_000],
  ] as const)('%s %j is %i ms', (field, text, valueMs) => {
    expect(parseTiming(def(field), text)).toStrictEqual({ ok: true, valueMs });
    expect(settingsFieldSchemas[field].safeParse(valueMs).success).toBe(true);
  });

  it.each([
    ['0', '0'],
    ['61', '61'],
    ['2.5', '2.5'],
    ['blank', ''],
    ['spaces', '   '],
    ['abc', 'abc'],
    ['a negative number', '-5'],
    ['a sign', '+5'],
    ['an exponent', '1e1'],
    ['a number and text', '5 分鐘'],
    ['a huge number', '9'.repeat(30)],
  ])('rejects %s for 休息中 with the range', (_label, text) => {
    expect(parseTiming(def('idleMs'), text)).toStrictEqual({
      ok: false,
      error: '請輸入 1～60 的整數',
    });
  });

  it('rejects 601 for 推測要你批准', () => {
    expect(parseTiming(def('approvalInferMs'), '601')).toStrictEqual({
      ok: false,
      error: '請輸入 1～600 的整數',
    });
  });

  it.each([
    ['doneMs', '８', 8000],
    ['doneMs', '０５', 5000],
    ['doneMs', '　８　', 8000],
    ['idleMs', '６０', 3_600_000],
  ] as const)(
    'takes full-width digits from an input method: %s %j is %i ms',
    (field, text, valueMs) => {
      expect(parseTiming(def(field), text)).toStrictEqual({
        ok: true,
        valueMs,
      });
    },
  );

  it.each(['６１', '０', '２．５'])(
    'still rejects a full-width value out of range for 休息中: %j',
    (text) => {
      expect(parseTiming(def('idleMs'), text)).toStrictEqual({
        ok: false,
        error: '請輸入 1～60 的整數',
      });
    },
  );
});

describe('timingForm', () => {
  it('顯示: each field shows its StageView value with its unit and range; nothing to send', () => {
    const form = timingForm(
      settings({ doneMs: 8000, idleMs: 120_000, approvalInferMs: 30_000 }),
      {},
    );

    expect(
      form.fields.map(({ field, label, unit, range, text, error }) => ({
        field,
        label,
        unit,
        range,
        text,
        error,
      })),
    ).toStrictEqual([
      {
        field: 'doneMs',
        label: '做完了過場',
        unit: '秒',
        range: '範圍 1～60',
        text: '8',
        error: null,
      },
      {
        field: 'idleMs',
        label: '無動靜轉休息中',
        unit: '分鐘',
        range: '範圍 1～60',
        text: '2',
        error: null,
      },
      {
        field: 'approvalInferMs',
        label: '推測要你批准',
        unit: '秒',
        range: '範圍 1～600',
        text: '30',
        error: null,
      },
    ]);
    expect(form.patch).toBeNull();
  });

  it('shows a value written by hand in a fraction of a unit as it is, and does not send it', () => {
    const current = settings({ doneMs: 1500 });

    const untouched = timingForm(current, {});
    expect(untouched.fields[0]?.text).toBe('1.5');
    expect(untouched.fields[0]?.error).toBeNull();
    expect(untouched.patch).toBeNull();

    const other = timingForm(current, { doneMs: '1.5', idleMs: '2' });
    expect(other.fields[0]?.error).toBeNull();
    expect(other.patch).toStrictEqual({
      baseRev: 3,
      ops: [{ op: 'set', field: 'idleMs', value: 120_000 }],
    });
  });

  it('送一欄: 做完了 changed to 8 sends only doneMs 8000, at the StageView settings rev', () => {
    const form = timingForm(settings({}, 7), { doneMs: '8' });

    expect(form.fields[0]?.text).toBe('8');
    expect(form.patch).toStrictEqual({
      baseRev: 7,
      ops: [{ op: 'set', field: 'doneMs', value: 8000 }],
    });
    expect(settingsPatchSchema.safeParse(form.patch).success).toBe(true);
  });

  it('送多欄: all three changed is one patch with three ops', () => {
    const form = timingForm(settings(), {
      doneMs: '8',
      idleMs: '2',
      approvalInferMs: '5',
    });

    expect(form.patch).toStrictEqual({
      baseRev: 3,
      ops: [
        { op: 'set', field: 'doneMs', value: 8000 },
        { op: 'set', field: 'idleMs', value: 120_000 },
        { op: 'set', field: 'approvalInferMs', value: 5000 },
      ],
    });
    expect(settingsPatchSchema.safeParse(form.patch).success).toBe(true);
  });

  it.each<[string, TimingDrafts]>([
    ['no draft', {}],
    ['drafts that are the shown text', { doneMs: '5', idleMs: '5' }],
    ['the shown text with spaces', { approvalInferMs: ' 10 ' }],
    ['the same value written another way', { doneMs: '05' }],
    ['the shown value in full-width digits', { doneMs: '５', idleMs: '０５' }],
  ])('沒改: %s has nothing to send', (_label, drafts) => {
    const form = timingForm(settings(), drafts);
    expect(form.patch).toBeNull();
    expect(form.fields.every((field) => field.error === null)).toBe(true);
  });

  it.each(['0', '61', '2.5', '', 'abc'])(
    '超出範圍: 休息中 %j shows the range under it, and nothing is sent, not even a valid field',
    (text) => {
      const form = timingForm(settings(), { doneMs: '8', idleMs: text });

      expect(form.fields.map((field) => field.error)).toStrictEqual([
        null,
        '請輸入 1～60 的整數',
        null,
      ]);
      expect(form.fields[1]?.text).toBe(text);
      expect(form.patch).toBeNull();
    },
  );

  it('follows StageView for a field with no draft, and keeps a draft over a newer value', () => {
    const drafts: TimingDrafts = { doneMs: '8' };

    const form = timingForm(
      settings({ doneMs: 20_000, idleMs: 600_000 }, 4),
      drafts,
    );

    expect(form.fields.map((field) => field.text)).toStrictEqual([
      '8',
      '10',
      '10',
    ]);
    expect(form.patch).toStrictEqual({
      baseRev: 4,
      ops: [{ op: 'set', field: 'doneMs', value: 8000 }],
    });
  });

  it('full-width digits from an input method are sent like ASCII ones; one out of range still blocks the save', () => {
    expect(timingForm(settings(), { doneMs: '８' }).patch).toStrictEqual({
      baseRev: 3,
      ops: [{ op: 'set', field: 'doneMs', value: 8000 }],
    });

    const blocked = timingForm(settings(), { doneMs: '８', idleMs: '６１' });
    expect(blocked.fields[1]?.error).toBe('請輸入 1～60 的整數');
    expect(blocked.patch).toBeNull();
  });

  it('a draft of the value StageView now has is no longer a change', () => {
    expect(timingForm(settings({ doneMs: 8000 }), { doneMs: '8' }).patch).toBe(
      null,
    );
  });
});

describe('createTimingSaver', () => {
  type Reply = IpcResult<SettingsPatchResult>;

  /** A settings.patch whose reply the test sends when it wants. */
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
    const states: TimingSaveState[] = [];
    const logError = vi.fn();
    const saver = createTimingSaver(
      remote.patch,
      (state) => {
        states.push(state);
      },
      logError,
    );
    return { remote, states, logError, saver };
  }

  const KEPT: Reply = {
    ok: true,
    data: { rev: 4, merged: false, saved: true },
  };
  const NOT_KEPT: Reply = {
    ok: true,
    data: { rev: 4, merged: false, saved: false },
  };

  it('starts idle', () => {
    expect(IDLE_TIMING_SAVE).toStrictEqual({ saving: false, outcome: null });
    expect(Object.isFrozen(IDLE_TIMING_SAVE)).toBe(true);
  });

  it('送一欄: sends the one patch, saving while it is pending, then 已儲存; resolves true', async () => {
    const { remote, states, saver } = setup();

    const done = saver.save(settings(), { doneMs: '8' });

    expect(states).toStrictEqual([{ saving: true, outcome: null }]);
    expect(remote.calls).toStrictEqual([
      { baseRev: 3, ops: [{ op: 'set', field: 'doneMs', value: 8000 }] },
    ]);
    remote.answer(KEPT);

    await expect(done).resolves.toBe(true);
    expect(states).toStrictEqual([
      { saving: true, outcome: null },
      { saving: false, outcome: { kind: 'saved', text: SAVED_TEXT } },
    ]);
    expect(SAVED_TEXT).toBe('已儲存');
  });

  it('儲存成功後: with the drafts dropped, the fields show StageView again, 8 once it brings doneMs 8000', async () => {
    const { remote, saver } = setup();
    let drafts: TimingDrafts = { doneMs: '8' };

    const done = saver.save(settings(), drafts);
    remote.answer(KEPT);
    if (await done) {
      drafts = {};
    }

    expect(timingForm(settings(), drafts).fields[0]?.text).toBe('5');
    expect(
      timingForm(settings({ doneMs: 8000 }, 4), drafts).fields[0]?.text,
    ).toBe('8');
  });

  it('送多欄: one call with three ops', async () => {
    const { remote, saver } = setup();

    const done = saver.save(settings(), {
      doneMs: '8',
      idleMs: '2',
      approvalInferMs: '5',
    });
    remote.answer(KEPT);
    await done;

    expect(remote.patch).toHaveBeenCalledOnce();
    expect(remote.calls[0]?.ops).toHaveLength(3);
  });

  it.each<[string, TimingDrafts]>([
    ['沒改', {}],
    ['沒改 (the shown text)', { doneMs: '5' }],
    ['超出範圍', { idleMs: '61' }],
    ['超出範圍 in one field of two', { doneMs: '8', idleMs: 'abc' }],
  ])(
    '%s: sends nothing, reports nothing, resolves false',
    async (_label, drafts) => {
      const { remote, states, saver } = setup();

      await expect(saver.save(settings(), drafts)).resolves.toBe(false);

      expect(remote.patch).not.toHaveBeenCalled();
      expect(states).toStrictEqual([]);
    },
  );

  it('存不到: main applied it without keeping settings.json: the not-saved notice, not an error; resolves true', async () => {
    const { remote, states, logError, saver } = setup();

    const done = saver.save(settings(), { doneMs: '8' });
    remote.answer(NOT_KEPT);

    await expect(done).resolves.toBe(true);
    expect(states.at(-1)).toStrictEqual({
      saving: false,
      outcome: { kind: 'not-saved', text: NOT_SAVED_TEXT },
    });
    expect(NOT_SAVED_TEXT).toBe(
      '已套用，但無法存到設定檔，重新啟動後會回到原本的值',
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('送出失敗: { ok: false } shows the error with its code and resolves false, so the drafts stay; it can send again', async () => {
    const { remote, states, logError, saver } = setup();
    const refused = {
      code: 'invalid-input',
      message: 'arguments do not match the schema',
    } as const;
    const drafts: TimingDrafts = { doneMs: '8' };

    const first = saver.save(settings(), drafts);
    remote.answer({ ok: false, error: refused });

    await expect(first).resolves.toBe(false);
    expect(states.at(-1)).toStrictEqual({
      saving: false,
      outcome: { kind: 'error', text: saveErrorText(refused) },
    });
    expect(saveErrorText(refused)).toBe(
      '無法儲存計時設定（invalid-input：arguments do not match the schema）',
    );
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      '[panels] settings:patch: invalid-input: arguments do not match the schema',
    );

    const second = saver.save(settings(), drafts);
    expect(states.at(-1)).toStrictEqual({ saving: true, outcome: null });
    remote.answer(KEPT);
    await expect(second).resolves.toBe(true);
    expect(remote.patch).toHaveBeenCalledTimes(2);
  });

  it('送出失敗: a rejected call shows the generic error and resolves false; it can send again', async () => {
    const { remote, states, logError, saver } = setup();

    const first = saver.save(settings(), { doneMs: '8' });
    remote.fail(new Error('gone'));

    await expect(first).resolves.toBe(false);
    expect(states.at(-1)).toStrictEqual({
      saving: false,
      outcome: { kind: 'error', text: '無法儲存計時設定' },
    });
    expect(logError).toHaveBeenCalledOnce();

    const second = saver.save(settings(), { doneMs: '8' });
    remote.answer(KEPT);
    await expect(second).resolves.toBe(true);
  });

  it('送出中: another save while one is on its way is ignored', async () => {
    const { remote, saver } = setup();

    const first = saver.save(settings(), { doneMs: '8' });
    await expect(saver.save(settings(), { doneMs: '9' })).resolves.toBe(false);

    expect(remote.patch).toHaveBeenCalledOnce();
    remote.answer(KEPT);
    await first;
  });

  it('never rejects, and recovers, when onState and logError throw', async () => {
    const remote = manualPatch();
    const saver = createTimingSaver(
      remote.patch,
      () => {
        throw new Error('page gone');
      },
      () => {
        throw new Error('no console');
      },
    );

    await expect(saver.save(settings(), { doneMs: '8' })).resolves.toBe(false);
    expect(remote.patch).not.toHaveBeenCalled();

    const quiet = createTimingSaver(
      remote.patch,
      () => {},
      () => {
        throw new Error('no console');
      },
    );
    const failed = quiet.save(settings(), { doneMs: '8' });
    remote.answer({
      ok: false,
      error: { code: 'invoke-failed', message: 'invoke failed' },
    });
    await expect(failed).resolves.toBe(false);

    const again = quiet.save(settings(), { doneMs: '8' });
    remote.answer(KEPT);
    await expect(again).resolves.toBe(true);
  });
});
