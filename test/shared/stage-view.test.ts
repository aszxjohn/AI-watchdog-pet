import { describe, expect, it } from 'vitest';
import {
  SETTINGS_DEFAULTS,
  settingsFieldSchemas,
} from '../../src/shared/settings';
import { DETECTION_ID_MAX_LENGTH } from '../../src/shared/detection-events';
import { ADAPTER_HEALTH_CODES, SOURCE_CODES } from '../../src/shared/sources';
import {
  applyStageViewDelta,
  DISPLAY_LABEL_MAX_LENGTH,
  displayIdSchema,
  stageAdapterSchema,
  stageAdaptersSchema,
  stageCanvasSchema,
  stageDisplaySchema,
  stageDisplaysSchema,
  stagePowerSchema,
  stageSessionSchema,
  stageSessionsSchema,
  stageViewDeltaSchema,
  stageViewSchema,
  stageViewSectionsSchema,
  stageViewSnapshotSchema,
  type StageView,
} from '../../src/shared/stage-view';
import { STATE_CODES } from '../../src/shared/states';
import { expectRejected, expectRoundTrip } from './schema-helpers';

/** The Design Notes example. */
const DISPLAY = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  primary: true,
};
const SECOND = {
  id: 69733632,
  label: 'DELL U2720Q',
  bounds: { x: -2560, y: -300, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  primary: false,
};
const CANVAS = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};
const POWER = { suspended: false, locked: false };
const SESSION = {
  sessionKey: 'demo:1',
  source: 'demo',
  displayName: '示範',
  state: 'approval',
  confidence: 'exact',
} as const;
const CODEX_SESSION = {
  sessionKey: 'codex:0199a3c2-7f1e',
  source: 'codex',
  displayName: null,
  state: 'approval',
  confidence: 'inferred',
} as const;
const ADAPTER = { source: 'demo', health: 'ok' } as const;

const VIEW: StageView = {
  settings: { rev: 0, values: { ...SETTINGS_DEFAULTS, canvasDisplayId: null } },
  displays: [DISPLAY],
  canvas: CANVAS,
  power: POWER,
  sessions: [SESSION],
  adapters: [ADAPTER],
};
const NEXT_SETTINGS = {
  rev: 4,
  values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 69733632 },
};

describe('displayIdSchema', () => {
  it('accepts exactly what the canvasDisplayId setting accepts', () => {
    for (const id of [0, 1, 69733632, 2 ** 32 + 5, -1, 1.5, 2 ** 53, NaN]) {
      expect(displayIdSchema.safeParse(id).success, String(id)).toBe(
        settingsFieldSchemas.canvasDisplayId.safeParse(id).success,
      );
    }
  });
});

describe('stageDisplaySchema', () => {
  it.each([
    ['the design-notes display', DISPLAY],
    ['a display left of and above the primary', SECOND],
    ['an unnamed display', { ...DISPLAY, label: '' }],
    ['a fractional scale factor', { ...DISPLAY, scaleFactor: 1.25 }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageDisplaySchema, value);
  });

  it.each([
    ['a negative id', { ...DISPLAY, id: -1 }],
    ['a fractional id', { ...DISPLAY, id: 1.5 }],
    ['an id past the safe integers', { ...DISPLAY, id: 2 ** 53 }],
    ['no label', { ...DISPLAY, label: undefined }],
    [
      'a label that is too long',
      { ...DISPLAY, label: 'x'.repeat(DISPLAY_LABEL_MAX_LENGTH + 1) },
    ],
    ['zero width', { ...DISPLAY, bounds: { ...DISPLAY.bounds, width: 0 } }],
    [
      'negative height',
      { ...DISPLAY, bounds: { ...DISPLAY.bounds, height: -1 } },
    ],
    ['fractional x', { ...DISPLAY, bounds: { ...DISPLAY.bounds, x: 0.5 } }],
    [
      'bounds with an extra key',
      { ...DISPLAY, bounds: { ...DISPLAY.bounds, z: 0 } },
    ],
    ['a zero scale factor', { ...DISPLAY, scaleFactor: 0 }],
    ['an infinite scale factor', { ...DISPLAY, scaleFactor: Infinity }],
    ['primary as a string', { ...DISPLAY, primary: 'yes' }],
    ['an extra key', { ...DISPLAY, workArea: DISPLAY.bounds }],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageDisplaySchema, value);
  });
});

describe('stageDisplaysSchema', () => {
  it.each([
    ['no display', []],
    ['one display', [DISPLAY]],
    ['two displays', [DISPLAY, SECOND]],
    ['no primary display', [{ ...DISPLAY, primary: false }]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageDisplaysSchema, value);
  });

  it.each([
    ['two displays with one id', [DISPLAY, { ...SECOND, id: DISPLAY.id }]],
    ['two primary displays', [DISPLAY, { ...SECOND, primary: true }]],
    ['not a list', DISPLAY],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageDisplaysSchema, value);
  });
});

describe('stageCanvasSchema', () => {
  it.each([
    ['the design-notes canvas', CANVAS],
    ['a fallback canvas', { ...CANVAS, fallback: true }],
    ['null (not placed yet)', null],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageCanvasSchema, value);
  });

  it.each([
    ['undefined', undefined],
    ['no fallback', { ...CANVAS, fallback: undefined }],
    ['a negative display id', { ...CANVAS, displayId: -1 }],
    ['zero width', { ...CANVAS, bounds: { ...CANVAS.bounds, width: 0 } }],
    ['a negative scale factor', { ...CANVAS, scaleFactor: -2 }],
    ['an extra key', { ...CANVAS, primary: true }],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageCanvasSchema, value);
  });
});

describe('stagePowerSchema', () => {
  it.each([
    [POWER],
    [{ suspended: true, locked: false }],
    [{ suspended: false, locked: true }],
    [{ suspended: true, locked: true }],
  ])('round-trips %j', (value) => {
    expectRoundTrip(stagePowerSchema, value);
  });

  it.each([
    ['no locked', { suspended: false }],
    ['a number', { suspended: 0, locked: false }],
    ['an extra key', { ...POWER, idle: false }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(stagePowerSchema, value);
  });
});

describe('stageSessionSchema', () => {
  it.each([
    ['the demo session', SESSION],
    ['an inferred session with no display name yet', CODEX_SESSION],
    [
      'a display name at the longest',
      { ...SESSION, displayName: 'x'.repeat(DETECTION_ID_MAX_LENGTH) },
    ],
    ['a native id with a colon', { ...SESSION, sessionKey: 'demo:a:b' }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageSessionSchema, value);
  });

  it.each(STATE_CODES)('round-trips the state %s', (state) => {
    expectRoundTrip(stageSessionSchema, { ...SESSION, state });
  });

  it.each(SOURCE_CODES)('round-trips a session of %s', (source) => {
    expectRoundTrip(stageSessionSchema, {
      ...SESSION,
      source,
      sessionKey: `${source}:s1`,
    });
  });

  it.each([
    ['a key of another source', { ...SESSION, sessionKey: 'codex:1' }],
    ['a key with no native id', { ...SESSION, sessionKey: 'demo:' }],
    ['a key with no source', { ...SESSION, sessionKey: '1' }],
    [
      'an unknown source',
      { ...SESSION, source: 'claude', sessionKey: 'claude:1' },
    ],
    ['an unknown state', { ...SESSION, state: 'sleeping' }],
    ['a Chinese state name', { ...SESSION, state: '要你批准' }],
    ['an unknown confidence', { ...SESSION, confidence: 'maybe' }],
    ['an empty display name', { ...SESSION, displayName: '' }],
    [
      'a display name that is too long',
      { ...SESSION, displayName: 'x'.repeat(DETECTION_ID_MAX_LENGTH + 1) },
    ],
    ['no display name key', { ...SESSION, displayName: undefined }],
    ['no confidence', { ...SESSION, confidence: undefined }],
    ['an extra key', { ...SESSION, actorId: 'a1' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageSessionSchema, value);
  });
});

describe('stageSessionsSchema', () => {
  it.each([
    ['no session', []],
    ['one session', [SESSION]],
    ['two sessions', [SESSION, CODEX_SESSION]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageSessionsSchema, value);
  });

  it.each([
    ['two sessions with one key', [SESSION, { ...SESSION, state: 'done' }]],
    ['a bad session', [{ ...SESSION, state: 'sleeping' }]],
    ['not a list', SESSION],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageSessionsSchema, value);
  });
});

describe('stageAdapterSchema', () => {
  it.each(ADAPTER_HEALTH_CODES)('round-trips the health %s', (health) => {
    expectRoundTrip(stageAdapterSchema, { source: 'codex', health });
  });

  it.each([
    ['an unknown health', { ...ADAPTER, health: 'broken' }],
    ['a Chinese health name', { ...ADAPTER, health: '正常' }],
    ['an unknown source', { ...ADAPTER, source: 'claude' }],
    ['no health', { source: 'demo' }],
    ['an extra key', { ...ADAPTER, detail: 'x' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageAdapterSchema, value);
  });
});

describe('stageAdaptersSchema', () => {
  it.each([
    ['no adapter', []],
    ['one adapter', [ADAPTER]],
    ['two adapters', [ADAPTER, { source: 'codex', health: 'degraded' }]],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(stageAdaptersSchema, value);
  });

  it.each([
    [
      'two adapters of one source',
      [ADAPTER, { ...ADAPTER, health: 'missing' }],
    ],
    ['not a list', ADAPTER],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageAdaptersSchema, value);
  });
});

describe('stageViewSchema', () => {
  it('round-trips a view', () => {
    expectRoundTrip(stageViewSchema, VIEW);
  });

  it('round-trips the view before ready: no displays, no canvas, no session, no adapter', () => {
    expectRoundTrip(stageViewSchema, {
      ...VIEW,
      displays: [],
      canvas: null,
      sessions: [],
      adapters: [],
    });
  });

  it.each([
    ['no settings section', { ...VIEW, settings: undefined }],
    ['no displays section', { ...VIEW, displays: undefined }],
    ['no canvas section', { ...VIEW, canvas: undefined }],
    ['no power section', { ...VIEW, power: undefined }],
    ['no sessions section', { ...VIEW, sessions: undefined }],
    ['no adapters section', { ...VIEW, adapters: undefined }],
    [
      'two sessions with one key',
      { ...VIEW, sessions: [SESSION, { ...SESSION, state: 'done' }] },
    ],
    [
      'an adapter with an unknown health',
      { ...VIEW, adapters: [{ ...ADAPTER, health: 'x' }] },
    ],
    ['an unknown section', { ...VIEW, actors: [] }],
    [
      'bad settings',
      {
        ...VIEW,
        settings: {
          rev: 0,
          values: { ...SETTINGS_DEFAULTS, canvasDisplayId: -1 },
        },
      },
    ],
    ['bad displays', { ...VIEW, displays: [{ ...DISPLAY, id: -1 }] }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageViewSchema, value);
  });
});

describe('stageViewSnapshotSchema', () => {
  it('round-trips a snapshot', () => {
    expectRoundTrip(stageViewSnapshotSchema, { rev: 0, view: VIEW });
  });

  it.each([
    ['no rev', { view: VIEW }],
    ['a negative rev', { rev: -1, view: VIEW }],
    ['no view', { rev: 0 }],
    ['an extra key', { rev: 0, view: VIEW, sections: {} }],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageViewSnapshotSchema, value);
  });
});

describe('stageViewSectionsSchema', () => {
  it('lists every section of the view', () => {
    expect(Object.keys(stageViewSectionsSchema.shape)).toStrictEqual(
      Object.keys(stageViewSchema.shape),
    );
  });
});

describe('stageViewDeltaSchema', () => {
  it.each([
    ['settings', { settings: NEXT_SETTINGS }],
    ['displays', { displays: [DISPLAY, SECOND] }],
    ['canvas', { canvas: { ...CANVAS, fallback: true } }],
    ['a canvas back to null', { canvas: null }],
    ['power', { power: { suspended: true, locked: false } }],
    [
      'displays and canvas together',
      { displays: [SECOND], canvas: { ...CANVAS, displayId: SECOND.id } },
    ],
    ['sessions', { sessions: [SESSION, CODEX_SESSION] }],
    ['no sessions any more', { sessions: [] }],
    ['adapters', { adapters: [ADAPTER] }],
    ['sessions and adapters together', { sessions: [], adapters: [] }],
  ])('round-trips a delta with %s', (_label, sections) => {
    expectRoundTrip(stageViewDeltaSchema, { rev: 8, sections });
  });

  it.each([
    ['no sections', { rev: 1, sections: {} }],
    ['an undefined section', { rev: 1, sections: { settings: undefined } }],
    ['an undefined canvas', { rev: 1, sections: { canvas: undefined } }],
    ['an unknown section', { rev: 1, sections: { actors: [] } }],
    [
      'a bad section',
      { rev: 1, sections: { settings: { rev: 1, values: {} } } },
    ],
    ['bad power', { rev: 1, sections: { power: { suspended: true } } }],
    ['null displays', { rev: 1, sections: { displays: null } }],
    ['undefined sessions', { rev: 1, sections: { sessions: undefined } }],
    [
      'bad sessions',
      { rev: 1, sections: { sessions: [{ ...SESSION, state: 'x' }] } },
    ],
    [
      'good sessions with bad adapters',
      {
        rev: 1,
        sections: { sessions: [SESSION], adapters: [ADAPTER, ADAPTER] },
      },
    ],
    ['rev 0', { rev: 0, sections: { settings: NEXT_SETTINGS } }],
    ['a fractional rev', { rev: 1.5, sections: { settings: NEXT_SETTINGS } }],
    ['no rev', { sections: { settings: NEXT_SETTINGS } }],
    [
      'an extra key',
      { rev: 1, sections: { settings: NEXT_SETTINGS }, view: VIEW },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(stageViewDeltaSchema, value);
  });
});

describe('applyStageViewDelta', () => {
  it('replaces each section the delta carries, whole', () => {
    const next = applyStageViewDelta(VIEW, { settings: NEXT_SETTINGS });

    expect(next).toStrictEqual({ ...VIEW, settings: NEXT_SETTINGS });
    expect(VIEW.settings.values).toStrictEqual(SETTINGS_DEFAULTS);
  });

  it('replaces several sections at once and keeps the others', () => {
    const next = applyStageViewDelta(VIEW, {
      displays: [SECOND],
      canvas: null,
    });

    expect(next).toStrictEqual({
      settings: VIEW.settings,
      displays: [SECOND],
      canvas: null,
      power: POWER,
      sessions: [SESSION],
      adapters: [ADAPTER],
    });
  });
});
