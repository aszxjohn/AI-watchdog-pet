import { describe, expect, it, vi } from 'vitest';
import {
  createPackImportActions,
  ENTRY_PROBLEM_TEXTS,
  fieldPathText,
  IDLE_PACK_IMPORT_ACTIONS,
  INSTALL_FAILURE_TEXTS,
  isolatedName,
  ISSUE_RULE_TEXTS,
  issueText,
  packImportControls,
  packImportView,
  READING_TEXT,
  rejectionDetails,
  rejectionText,
  requestErrorText,
  SIZE_LIMIT_TEXTS,
  ZOD_ISSUE_FALLBACK_TEXT,
  ZOD_ISSUE_TEXTS,
  type PackImportActionState,
} from '../../src/panels/pack-import';
import type { IpcResult } from '../../src/shared/ipc';
import { PACK_API_ISSUE_RULES } from '../../src/shared/pack-api';
import {
  PACK_ENTRY_PROBLEMS,
  PACK_INSTALL_FAILURE_CODES,
  PACK_REJECTION_CODES,
  PACK_SIZE_LIMITS,
  stagePackImportSchema,
  type PackRejection,
  type PackRejectionCode,
  type StagePackImport,
} from '../../src/shared/packs';

/** One rejection of every code, with the text each must show. */
const REJECTIONS: Readonly<
  Record<PackRejectionCode, readonly [PackRejection, readonly string[]]>
> = {
  'unreadable-file': [{ code: 'unreadable-file' }, ['讀不到這個檔案']],
  'invalid-archive': [{ code: 'invalid-archive' }, ['不是可用的角色包檔案']],
  'unsafe-path': [
    { code: 'unsafe-path', path: 'pack/../x.js' },
    ['不安全的檔名', '「pack/../x.js」'],
  ],
  shortcut: [
    { code: 'shortcut', path: 'pack/link' },
    ['捷徑', '「pack/link」'],
  ],
  'name-conflict': [
    { code: 'name-conflict', path: 'pack/A.png' },
    ['只差大小寫', '「pack/A.png」'],
  ],
  'invalid-root': [{ code: 'invalid-root' }, ['最外層必須剛好是一個資料夾']],
  'too-large': [
    { code: 'too-large', limit: 'total-size' },
    ['角色包太大', '64 MiB'],
  ],
  'missing-manifest': [{ code: 'missing-manifest' }, ['沒有 manifest.json']],
  'manifest-not-json': [{ code: 'manifest-not-json' }, ['不是有效的 JSON']],
  'api-incompatible': [
    { code: 'api-incompatible', reason: 'pack-newer', required: '1.3' },
    ['需要舞台 API ≥ 1.3', '目前是 1.0'],
  ],
  'invalid-manifest': [
    { code: 'invalid-manifest', issues: [] },
    ['manifest.json 的內容不符合規格'],
  ],
  'root-folder-mismatch': [
    { code: 'root-folder-mismatch', folder: 'my-pack', packId: 'other-pack' },
    ['「my-pack」', '「other-pack」'],
  ],
  'missing-file': [
    { code: 'missing-file', path: 'img/a.png' },
    ['不在包裡', '「img/a.png」'],
  ],
  'entry-unparsable': [
    { code: 'entry-unparsable', reason: 'require' },
    ['入口程式無法載入', 'require()'],
  ],
  'unsupported-image-format': [
    { code: 'unsupported-image-format', path: 'img/a.jpg' },
    ['不是 PNG', '「img/a.jpg」'],
  ],
  'invalid-spritesheet': [
    { code: 'invalid-spritesheet', path: 'img/sheet.json' },
    ['spritesheet', '「img/sheet.json」'],
  ],
  'image-too-large': [
    { code: 'image-too-large', limit: 'side', path: 'img/big.png' },
    ['「img/big.png」', '4096 像素'],
  ],
};

function rejected(
  rejection: PackRejection,
  moreIssues = 0,
): Extract<StagePackImport, { outcome: 'rejected' }> {
  return { phase: 'result', outcome: 'rejected', rejection, moreIssues };
}

const CONFIRM: Extract<StagePackImport, { phase: 'confirm' }> = {
  phase: 'confirm',
  packId: 'sample-pack',
  name: '範例包',
  version: '1.2.0',
  previous: { name: '舊範例包', version: '1.1.0' },
  downgrade: false,
};

describe('the Chinese texts', () => {
  it.each(PACK_REJECTION_CODES.map((code) => [code]))(
    'rejection code %s has its own text with what it carries',
    (code) => {
      const [rejection, wanted] = REJECTIONS[code];
      const text = rejectionText(rejection);
      for (const part of wanted) {
        expect(text).toContain(part);
      }
      expect(text).not.toContain(code);
    },
  );

  it('every rejection code reads differently', () => {
    const texts = PACK_REJECTION_CODES.map((code) =>
      rejectionText(REJECTIONS[code][0]),
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('api-incompatible: another major is 這個角色包的 API 版本不相容; a newer minor is 需要舞台 API ≥ x.y', () => {
    expect(
      rejectionText({
        code: 'api-incompatible',
        reason: 'major-mismatch',
        required: '2.0',
      }),
    ).toBe('這個角色包的 API 版本不相容（角色包是 2.0，舞台是 1.0）');
    expect(
      rejectionText({
        code: 'api-incompatible',
        reason: 'pack-newer',
        required: '1.3',
      }),
    ).toBe('需要舞台 API ≥ 1.3（目前是 1.0），請先更新 app');
  });

  it.each(PACK_SIZE_LIMITS.map((limit) => [limit]))(
    'too-large %s has its own text',
    (limit) => {
      expect(rejectionText({ code: 'too-large', limit })).toBe(
        `角色包太大：${SIZE_LIMIT_TEXTS[limit]}`,
      );
    },
  );

  it('the size texts name the limits: 1024 entries, 64 MiB, 512 files', () => {
    expect(SIZE_LIMIT_TEXTS['entry-count']).toContain('1024');
    expect(SIZE_LIMIT_TEXTS['total-size']).toContain('64 MiB');
    expect(SIZE_LIMIT_TEXTS['file-count']).toContain('512');
    expect(new Set(Object.values(SIZE_LIMIT_TEXTS)).size).toBe(4);
  });

  it('image-too-large names the image over the side limit, and the total in 萬 pixels', () => {
    expect(
      rejectionText({
        code: 'image-too-large',
        limit: 'side',
        path: 'img/big.png',
      }),
    ).toBe('圖片「img/big.png」的寬或高超過 4096 像素');
    expect(
      rejectionText({ code: 'image-too-large', limit: 'total-pixels' }),
    ).toBe('所有圖片加起來超過 6400 萬像素');
  });

  it.each(PACK_ENTRY_PROBLEMS.map((reason) => [reason]))(
    'entry-unparsable %s has its own text',
    (reason) => {
      expect(rejectionText({ code: 'entry-unparsable', reason })).toBe(
        `入口程式無法載入：${ENTRY_PROBLEM_TEXTS[reason]}`,
      );
    },
  );

  it.each(PACK_API_ISSUE_RULES.map((rule) => [rule]))(
    'manifest rule %s has its own text',
    (rule) => {
      const text = ISSUE_RULE_TEXTS[rule];
      expect(text.length).toBeGreaterThan(0);
      expect(issueText({ code: 'custom', rule, path: ['entry'] })).toBe(
        `entry：${text}`,
      );
    },
  );

  it('every manifest rule reads differently, and no text lists a rule that is not one', () => {
    const texts = PACK_API_ISSUE_RULES.map((rule) => ISSUE_RULE_TEXTS[rule]);
    expect(new Set(texts).size).toBe(texts.length);
    expect(Object.keys(ISSUE_RULE_TEXTS).sort()).toStrictEqual(
      [...PACK_API_ISSUE_RULES].sort(),
    );
  });

  it('scale-off-grid names the range and step', () => {
    expect(ISSUE_RULE_TEXTS['scale-off-grid']).toBe(
      '大小必須在 0.5～2.0 之間，每格 0.1',
    );
  });

  it('a problem with no rule is worded by its zod code; an unknown code (or one named like an Object key) gets the fallback', () => {
    expect(issueText({ code: 'invalid_type', path: ['name'] })).toBe(
      `name：${ZOD_ISSUE_TEXTS.invalid_type}`,
    );
    expect(issueText({ code: 'unrecognized_keys', path: ['extra'] })).toBe(
      'extra：不認得這個欄位',
    );
    expect(issueText({ code: 'something_new', path: [] })).toBe(
      `（整份 manifest）：${ZOD_ISSUE_FALLBACK_TEXT}`,
    );
    expect(issueText({ code: 'toString', path: [] })).toBe(
      `（整份 manifest）：${ZOD_ISSUE_FALLBACK_TEXT}`,
    );
  });

  it.each(PACK_INSTALL_FAILURE_CODES.map((code) => [code]))(
    'install failure %s has its own text',
    (code) => {
      expect(INSTALL_FAILURE_TEXTS[code].length).toBeGreaterThan(0);
    },
  );

  it('every install failure reads differently', () => {
    const texts = PACK_INSTALL_FAILURE_CODES.map(
      (code) => INSTALL_FAILURE_TEXTS[code],
    );
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('fieldPathText', () => {
  it.each<[(string | number)[], string]>([
    [[], '（整份 manifest）'],
    [['entry'], 'entry'],
    [['characters', 0, 'hitbox'], 'characters[0].hitbox'],
    [
      ['characters', 1, 'params', 2, 'options', 0],
      'characters[1].params[2].options[0]',
    ],
    [['assets', 'probe-one', 'path'], 'assets.probe-one.path'],
  ])('%j reads %s', (path, text) => {
    expect(fieldPathText(path)).toBe(text);
  });
});

describe('I/O matrix', () => {
  it('選檔: before any import, 匯入角色包… may be pressed and there is no status line', () => {
    expect(packImportView({ phase: 'idle' })).toStrictEqual({
      canChoose: true,
      status: null,
      confirm: null,
    });
  });

  it('讀取中再匯入: while reading, the button is disabled and the status line says 讀取中…', () => {
    expect(packImportView({ phase: 'reading' })).toStrictEqual({
      canChoose: false,
      status: { tone: 'progress', text: READING_TEXT, details: [] },
      confirm: null,
    });
  });

  it('新包: 已安裝 with its name and version; the button may be pressed again', () => {
    expect(
      packImportView({
        phase: 'result',
        outcome: 'installed',
        packId: 'sample-pack',
        name: '範例包',
        version: '1.2.0',
      }),
    ).toStrictEqual({
      canChoose: true,
      status: {
        tone: 'success',
        text: '已安裝：\u2068範例包\u2069 1.2.0',
        details: [],
      },
      confirm: null,
    });
  });

  it('拒絕: 無法匯入 with the reason in Chinese, its parameters included', () => {
    const view = packImportView(
      rejected({
        code: 'api-incompatible',
        reason: 'pack-newer',
        required: '1.3',
      }),
    );
    expect(view).toStrictEqual({
      canChoose: true,
      status: {
        tone: 'error',
        text: '無法匯入：需要舞台 API ≥ 1.3（目前是 1.0），請先更新 app',
        details: [],
      },
      confirm: null,
    });
  });

  it('manifest 錯: the field paths and their Chinese text under the line, then 還有 N 項', () => {
    const view = packImportView(
      rejected(
        {
          code: 'invalid-manifest',
          issues: [
            {
              code: 'custom',
              rule: 'hitbox-outside-bounds',
              path: ['characters', 0, 'hitbox'],
            },
            { code: 'unrecognized_keys', path: ['extra'] },
          ],
        },
        7,
      ),
    );
    expect(view.status).toStrictEqual({
      tone: 'error',
      text: '無法匯入：manifest.json 的內容不符合規格',
      details: [
        'characters[0].hitbox：hitbox 超出了 bounds',
        'extra：不認得這個欄位',
        '還有 7 項',
      ],
    });
  });

  it('manifest 錯: no 還有 line when nothing was left out; no lines for other codes', () => {
    expect(
      rejectionDetails(
        {
          code: 'invalid-manifest',
          issues: [{ code: 'too_big', path: ['name'] }],
        },
        0,
      ),
    ).toStrictEqual(['name：太大或太長']);
    expect(rejectionDetails({ code: 'missing-manifest' }, 0)).toStrictEqual([]);
  });

  it('需要確認: the new and the installed name and version; the button is disabled; no downgrade warning', () => {
    expect(packImportView(CONFIRM)).toStrictEqual({
      canChoose: false,
      status: null,
      confirm: {
        question:
          '已安裝「\u2068舊範例包\u2069」1.1.0，要用「\u2068範例包\u2069」1.2.0 取代嗎？',
        downgradeWarning: null,
      },
    });
  });

  it('需要確認: the same version says it reinstalls', () => {
    const view = packImportView({
      ...CONFIRM,
      previous: { name: '範例包', version: '1.2.0' },
    });
    expect(view.confirm?.question).toBe(
      '已安裝「\u2068範例包\u2069」1.2.0，要用「\u2068範例包\u2069」1.2.0 取代嗎？（同一個版本，會重新安裝）',
    );
  });

  it('需要確認: a name with a bidi override (U+202E) is isolated with FSI … PDI, so it cannot reorder the versions or the rest of the line', () => {
    const tricky = '包\u202E0.9.9';
    const view = packImportView({
      ...CONFIRM,
      name: tricky,
      previous: { name: tricky, version: '1.1.0' },
    });
    expect(isolatedName(tricky)).toBe('\u2068包\u202E0.9.9\u2069');
    expect(view.confirm?.question).toBe(
      `已安裝「\u2068${tricky}\u2069」1.1.0，要用「\u2068${tricky}\u2069」1.2.0 取代嗎？`,
    );
    expect(
      packImportView({
        phase: 'result',
        outcome: 'installed',
        packId: 'sample-pack',
        name: tricky,
        version: '1.2.0',
      }).status?.text,
    ).toBe(`已安裝：\u2068${tricky}\u2069 1.2.0`);
  });

  it('降版: an older version adds the downgrade warning', () => {
    const view = packImportView({
      ...CONFIRM,
      version: '1.0.0',
      downgrade: true,
    });
    expect(view.confirm?.downgradeWarning).toBe(
      '注意：1.0.0 比已安裝的 1.1.0 舊，取代後會降版。',
    );
  });

  it('取消取代: 已取消, neutral', () => {
    expect(
      packImportView({ phase: 'result', outcome: 'cancelled' }),
    ).toStrictEqual({
      canChoose: true,
      status: {
        tone: 'neutral',
        text: '已取消，沒有取代已安裝的版本',
        details: [],
      },
      confirm: null,
    });
  });

  it('計畫過期: stale-plan is a Chinese failure saying to import again', () => {
    expect(
      packImportView({ phase: 'result', outcome: 'failed', code: 'stale-plan' })
        .status,
    ).toStrictEqual({
      tone: 'error',
      text: `安裝失敗：${INSTALL_FAILURE_TEXTS['stale-plan']}。已安裝的角色包沒有變動。`,
      details: [],
    });
    expect(INSTALL_FAILURE_TEXTS['stale-plan']).toContain('請重新匯入');
  });

  it.each(PACK_INSTALL_FAILURE_CODES.map((code) => [code]))(
    '安裝失敗: %s shows its Chinese reason and says the installed pack is unchanged',
    (code) => {
      const view = packImportView({ phase: 'result', outcome: 'failed', code });
      expect(view.canChoose).toBe(true);
      expect(view.status?.text).toBe(
        `安裝失敗：${INSTALL_FAILURE_TEXTS[code]}。已安裝的角色包沒有變動。`,
      );
    },
  );

  it('every state the views above use passes the shared schema', () => {
    for (const state of [
      CONFIRM,
      rejected({ code: 'missing-manifest' }),
      rejected({ code: 'invalid-manifest', issues: [] }, 3),
    ]) {
      expect(stagePackImportSchema.safeParse(state).success).toBe(true);
    }
  });
});

describe('packImportControls', () => {
  it('選檔: 匯入角色包… may be pressed only with the API, nothing on its way, and canChoose', () => {
    expect(
      packImportControls({ canChoose: true }, false, true).importDisabled,
    ).toBe(false);
    expect(
      packImportControls({ canChoose: false }, false, true).importDisabled,
    ).toBe(true);
    expect(
      packImportControls({ canChoose: true }, true, true).importDisabled,
    ).toBe(true);
    expect(
      packImportControls({ canChoose: true }, false, false).importDisabled,
    ).toBe(true);
  });

  it('讀取中再匯入, 需要確認: the button is disabled while reading and while confirming', () => {
    expect(
      packImportControls(packImportView({ phase: 'reading' }), false, true)
        .importDisabled,
    ).toBe(true);
    expect(
      packImportControls(packImportView(CONFIRM), false, true).importDisabled,
    ).toBe(true);
  });

  it('需要確認: 取代 sends true and 取消 sends false, in that order, enabled with the API and nothing on its way', () => {
    expect(
      packImportControls(packImportView(CONFIRM), false, true).confirmButtons,
    ).toStrictEqual([
      { key: 'replace', label: '取代', replace: true, disabled: false },
      { key: 'keep', label: '取消', replace: false, disabled: false },
    ]);
  });

  it.each([
    ['a request is on its way', true, true],
    ['there is no preload API', false, false],
  ])(
    '需要確認: both confirm buttons are disabled while %s',
    (_label, sending, hasApi) => {
      for (const button of packImportControls(
        packImportView(CONFIRM),
        sending,
        hasApi,
      ).confirmButtons) {
        expect(button.disabled).toBe(true);
      }
    },
  );
});

describe('createPackImportActions', () => {
  function api(
    reply: IpcResult<null> | Promise<IpcResult<null>> = {
      ok: true,
      data: null,
    },
  ) {
    return {
      choose: vi.fn(async () => reply),
      confirm: vi.fn(async (_replace: boolean) => reply),
    };
  }

  it('選檔: reports sending, asks main to open the dialog, then reports no error; the section is left to StageView', async () => {
    const calls = api();
    const states: PackImportActionState[] = [];
    const actions = createPackImportActions(calls, (state) => {
      states.push(state);
    });

    await actions.choose();

    expect(calls.choose).toHaveBeenCalledOnce();
    expect(states).toStrictEqual([
      { sending: true, error: null },
      IDLE_PACK_IMPORT_ACTIONS,
    ]);
  });

  it.each([[true], [false]])(
    '需要確認: confirm(%s) passes the choice on',
    async (replace) => {
      const calls = api();
      const actions = createPackImportActions(calls, () => {});

      await actions.confirm(replace);

      expect(calls.confirm).toHaveBeenCalledExactlyOnceWith(replace);
    },
  );

  it('a failed request shows why, in Chinese with the code, and logs it', async () => {
    const calls = api({
      ok: false,
      error: { code: 'sender-rejected', message: 'sender is not allowed' },
    });
    const states: PackImportActionState[] = [];
    const logError = vi.fn();
    const actions = createPackImportActions(
      calls,
      (state) => {
        states.push(state);
      },
      logError,
    );

    await actions.confirm(true);

    expect(states.at(-1)).toStrictEqual({
      sending: false,
      error: '無法取代（sender-rejected：sender is not allowed）',
    });
    expect(logError).toHaveBeenCalledWith(
      '[panels] packs:confirm: sender-rejected: sender is not allowed',
    );
  });

  it('a request that rejects still resolves, with a plain error', async () => {
    const calls = api(Promise.reject(new Error('gone')));
    const states: PackImportActionState[] = [];
    const actions = createPackImportActions(
      calls,
      (state) => {
        states.push(state);
      },
      () => {},
    );

    await expect(actions.choose()).resolves.toBeUndefined();
    expect(states.at(-1)).toStrictEqual({
      sending: false,
      error: '無法開始匯入',
    });
  });

  it('a press while a request is on its way is ignored', async () => {
    let answer: (reply: IpcResult<null>) => void = () => {};
    const calls = {
      choose: vi.fn(
        () =>
          new Promise<IpcResult<null>>((resolve) => {
            answer = resolve;
          }),
      ),
      confirm: vi.fn(async () => ({ ok: true as const, data: null })),
    };
    const actions = createPackImportActions(calls, () => {});

    const first = actions.choose();
    await actions.choose();
    await actions.confirm(false);
    answer({ ok: true, data: null });
    await first;
    await actions.confirm(false);

    expect(calls.choose).toHaveBeenCalledOnce();
    expect(calls.confirm).toHaveBeenCalledOnce();
  });

  it('an onState that throws on the outcome does not leave the buttons stuck', async () => {
    const calls = api();
    const actions = createPackImportActions(
      calls,
      (state) => {
        if (!state.sending) {
          throw new Error('page gone');
        }
      },
      () => {},
    );

    await expect(actions.choose()).resolves.toBeUndefined();
    await expect(actions.choose()).resolves.toBeUndefined();
    expect(calls.choose).toHaveBeenCalledTimes(2);
  });

  it('requestErrorText names the button that failed', () => {
    expect(requestErrorText('choose', undefined)).toBe('無法開始匯入');
    expect(requestErrorText('replace', undefined)).toBe('無法取代');
    expect(requestErrorText('keep', undefined)).toBe('無法取消');
  });
});
