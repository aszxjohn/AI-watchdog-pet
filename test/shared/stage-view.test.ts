import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import {
  applyStageViewDelta,
  stageViewDeltaSchema,
  stageViewSchema,
  stageViewSectionsSchema,
  stageViewSnapshotSchema,
  type StageView,
} from '../../src/shared/stage-view';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const VIEW: StageView = {
  settings: { rev: 0, values: { canvasDisplayId: null } },
};
const NEXT_SETTINGS = { rev: 4, values: { canvasDisplayId: 69733632 } };

describe('stageViewSchema', () => {
  it('round-trips a view', () => {
    expectRoundTrip(stageViewSchema, VIEW);
  });

  it.each([
    ['no settings section', {}],
    ['an unknown section', { ...VIEW, actors: [] }],
    ['bad settings', { settings: { rev: 0, values: { canvasDisplayId: -1 } } }],
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
  it('round-trips the design-notes example', () => {
    expectRoundTrip(stageViewDeltaSchema, {
      rev: 8,
      sections: { settings: NEXT_SETTINGS },
    });
  });

  it.each([
    ['no sections', { rev: 1, sections: {} }],
    ['an undefined section', { rev: 1, sections: { settings: undefined } }],
    ['an unknown section', { rev: 1, sections: { actors: [] } }],
    [
      'a bad section',
      { rev: 1, sections: { settings: { rev: 1, values: {} } } },
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

    expect(next).toStrictEqual({ settings: NEXT_SETTINGS });
    expect(VIEW.settings.values).toStrictEqual(SETTINGS_DEFAULTS);
  });
});
