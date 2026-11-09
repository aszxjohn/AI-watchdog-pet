import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_CODES,
  confidenceFor,
  confidenceSchema,
  DETECTION_EVENT_TYPES,
  DETECTION_ID_MAX_LENGTH,
  detectionEventSchema,
  type DetectionEventType,
  eventTsSchema,
  makeSessionKey,
  nativeIdSchema,
  sessionKeySchema,
  VIA_CODES,
  viaSchema,
} from '../../src/shared/detection-events';
import { SOURCE_CODES } from '../../src/shared/sources';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const UUID = '0b6a7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const LONGEST = 'x'.repeat(DETECTION_ID_MAX_LENGTH);
const TOO_LONG = 'x'.repeat(DETECTION_ID_MAX_LENGTH + 1);

/** Fields every event carries, for a Claude Code session read from its log. */
const COMMON = {
  source: 'claude-code',
  sessionKey: `claude-code:${UUID}`,
  ts: 1_762_675_200_000,
  via: 'log',
  confidence: 'exact',
} as const;

/** One valid event of each type. */
const SAMPLES: Record<DetectionEventType, Record<string, unknown>> = {
  'session.start': { type: 'session.start', ...COMMON },
  'session.end': { type: 'session.end', ...COMMON },
  'session.meta': {
    type: 'session.meta',
    ...COMMON,
    displayName: 'gundam-pet',
  },
  'turn.start': { type: 'turn.start', ...COMMON },
  'turn.end': { type: 'turn.end', ...COMMON },
  'tool.start': {
    type: 'tool.start',
    ...COMMON,
    toolCallId: 'toolu_01',
    toolName: 'Bash',
  },
  'tool.end': { type: 'tool.end', ...COMMON, toolCallId: 'toolu_01' },
  'approval.request': {
    type: 'approval.request',
    ...COMMON,
    requestId: 'toolu_01',
  },
  'approval.resolved': {
    type: 'approval.resolved',
    ...COMMON,
    requestId: 'toolu_01',
  },
  'question.request': {
    type: 'question.request',
    ...COMMON,
    requestId: 'toolu_02',
  },
  'question.resolved': {
    type: 'question.resolved',
    ...COMMON,
    requestId: 'toolu_02',
  },
  error: { type: 'error', ...COMMON },
  activity: { type: 'activity', ...COMMON },
};

function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe('via and confidence', () => {
  it('lists the codes of AD-21', () => {
    expect([...VIA_CODES]).toStrictEqual(['log', 'registry', 'inferred']);
    expect([...CONFIDENCE_CODES]).toStrictEqual(['exact', 'inferred']);
  });

  it.each([
    ['log', 'exact'],
    ['registry', 'exact'],
    ['inferred', 'inferred'],
  ] as const)('confidenceFor(%s) is %s', (via, confidence) => {
    expect(confidenceFor(via)).toBe(confidence);
  });

  it.each(VIA_CODES)('round-trips via %s', (via) => {
    expectRoundTrip(viaSchema, via);
  });

  it.each(CONFIDENCE_CODES)('round-trips confidence %s', (confidence) => {
    expectRoundTrip(confidenceSchema, confidence);
  });

  it.each([['transcript'], ['Log'], [''], [null]])(
    'rejects via %j',
    (value) => {
      expectRejected(viaSchema, value);
    },
  );

  it.each([['guess'], ['Exact'], [''], [null]])(
    'rejects confidence %j',
    (value) => {
      expectRejected(confidenceSchema, value);
    },
  );
});

describe('nativeIdSchema', () => {
  it.each([[UUID], ['a'], [LONGEST], ['a:b'], ['示範 session'], ['a b']])(
    'round-trips %j',
    (value) => {
      expectRoundTrip(nativeIdSchema, value);
    },
  );

  it.each([
    ['empty', ''],
    ['too long', TOO_LONG],
    ['a newline', 'a\nb'],
    ['a tab', '\tabc'],
    ['NUL', 'a\u0000'],
    ['DEL', 'a\u007f'],
    ['a C1 control', 'a\u0085'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(nativeIdSchema, value);
  });
});

describe('sessionKeySchema', () => {
  it.each(SOURCE_CODES)('round-trips a %s key', (source) => {
    expectRoundTrip(sessionKeySchema, `${source}:${UUID}`);
  });

  it.each([
    ['the longest native id', `codex:${LONGEST}`],
    ['a colon in the native id', 'cursor:a:b'],
    ['a non-ASCII native id', 'demo:示範-1'],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(sessionKeySchema, value);
  });

  it.each([
    ['empty string', ''],
    ['a source alone', 'codex'],
    ['an empty native id', 'codex:'],
    ['no source', `:${UUID}`],
    ['an unknown source', `claude:${UUID}`],
    ['a source in the wrong case', `Codex:${UUID}`],
    ['a native id that is too long', `codex:${TOO_LONG}`],
    ['a newline in the native id', 'codex:a\nb'],
    ['NUL in the native id', 'codex:a\u0000'],
    ['DEL in the native id', 'codex:\u007f'],
    ['a C1 control in the native id', 'codex:a\u009b'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(sessionKeySchema, value);
  });
});

describe('makeSessionKey', () => {
  it.each(SOURCE_CODES)('builds a valid %s key', (source) => {
    const key = makeSessionKey(source, UUID);
    expect(key).toBe(`${source}:${UUID}`);
    expectRoundTrip(sessionKeySchema, key);
  });

  it('keeps a colon in the native id', () => {
    expect(makeSessionKey('cursor', 'a:b')).toBe('cursor:a:b');
  });

  it.each([
    ['empty', ''],
    ['too long', TOO_LONG],
    ['a control character', 'a\rb'],
  ])('returns null for a native id that is %s', (_label, nativeId) => {
    expect(makeSessionKey('codex', nativeId)).toBeNull();
  });
});

describe('eventTsSchema', () => {
  it.each([[0], [COMMON.ts], [Number.MAX_SAFE_INTEGER]])(
    'round-trips %j',
    (value) => {
      expectRoundTrip(eventTsSchema, value);
    },
  );

  it.each([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['a string', '0'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(eventTsSchema, value);
  });
});

describe('detectionEventSchema', () => {
  it('has exactly the 13 event types of AD-21', () => {
    expect([...DETECTION_EVENT_TYPES]).toStrictEqual([
      'session.start',
      'session.end',
      'session.meta',
      'turn.start',
      'turn.end',
      'tool.start',
      'tool.end',
      'approval.request',
      'approval.resolved',
      'question.request',
      'question.resolved',
      'error',
      'activity',
    ]);
    expect(
      detectionEventSchema.options.map((option) => option.shape.type.value),
    ).toStrictEqual([...DETECTION_EVENT_TYPES]);
  });

  it.each(DETECTION_EVENT_TYPES)('round-trips %s', (type) => {
    expectRoundTrip(detectionEventSchema, SAMPLES[type]);
  });

  it.each(DETECTION_EVENT_TYPES)('round-trips an inferred %s', (type) => {
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES[type],
      via: 'inferred',
      confidence: 'inferred',
    });
  });

  it('round-trips an event read from a registry', () => {
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES['approval.request'],
      via: 'registry',
      confidence: 'exact',
    });
  });

  it.each(SOURCE_CODES)('round-trips an event from %s', (source) => {
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES['turn.start'],
      source,
      sessionKey: `${source}:${UUID}`,
    });
  });

  it('round-trips ids and names of the longest length', () => {
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES['tool.start'],
      toolCallId: LONGEST,
      toolName: LONGEST,
    });
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES['session.meta'],
      displayName: LONGEST,
    });
    expectRoundTrip(detectionEventSchema, {
      ...SAMPLES['question.request'],
      requestId: LONGEST,
    });
  });

  it.each([
    ['an unknown type', { ...SAMPLES['tool.end'], type: 'tool.progress' }],
    ['no type', without(SAMPLES['turn.start'], 'type')],
    [
      'an unknown source',
      { ...SAMPLES['turn.start'], source: 'claude', sessionKey: 'claude:a' },
    ],
    [
      'a sessionKey of another source',
      { ...SAMPLES['turn.start'], source: 'codex' },
    ],
    ['an invalid sessionKey', { ...SAMPLES['turn.start'], sessionKey: 'x' }],
    [
      'via inferred with confidence exact',
      { ...SAMPLES['approval.request'], via: 'inferred', confidence: 'exact' },
    ],
    [
      'via log with confidence inferred',
      { ...SAMPLES['approval.request'], via: 'log', confidence: 'inferred' },
    ],
    [
      'via registry with confidence inferred',
      { ...SAMPLES['turn.end'], via: 'registry', confidence: 'inferred' },
    ],
    ['no via', without(SAMPLES['turn.end'], 'via')],
    ['no confidence', without(SAMPLES['turn.end'], 'confidence')],
    ['no source', without(SAMPLES['turn.end'], 'source')],
    ['no sessionKey', without(SAMPLES['turn.end'], 'sessionKey')],
    ['no ts', without(SAMPLES['turn.end'], 'ts')],
    [
      'tool.start without toolCallId',
      without(SAMPLES['tool.start'], 'toolCallId'),
    ],
    ['tool.start without toolName', without(SAMPLES['tool.start'], 'toolName')],
    ['tool.end without toolCallId', without(SAMPLES['tool.end'], 'toolCallId')],
    [
      'approval.request without requestId',
      without(SAMPLES['approval.request'], 'requestId'),
    ],
    [
      'approval.resolved without requestId',
      without(SAMPLES['approval.resolved'], 'requestId'),
    ],
    [
      'question.request without requestId',
      without(SAMPLES['question.request'], 'requestId'),
    ],
    [
      'question.resolved without requestId',
      without(SAMPLES['question.resolved'], 'requestId'),
    ],
    [
      'approval.request with toolCallId instead of requestId',
      {
        ...without(SAMPLES['approval.request'], 'requestId'),
        toolCallId: 'toolu_01',
      },
    ],
    [
      'session.meta without displayName',
      without(SAMPLES['session.meta'], 'displayName'),
    ],
    ['an extra field', { ...SAMPLES.activity, message: 'hi' }],
    ['an error message', { ...SAMPLES.error, message: 'boom' }],
    ['tool.end with toolName', { ...SAMPLES['tool.end'], toolName: 'Bash' }],
    ['a replay flag', { ...SAMPLES['turn.start'], replay: true }],
    ['a negative ts', { ...SAMPLES['turn.start'], ts: -1 }],
    ['a fractional ts', { ...SAMPLES['turn.start'], ts: 1.5 }],
    ['an unsafe ts', { ...SAMPLES['turn.start'], ts: 2 ** 53 }],
    ['a string ts', { ...SAMPLES['turn.start'], ts: '0' }],
    ['a NaN ts', { ...SAMPLES['turn.start'], ts: Number.NaN }],
    ['an empty toolCallId', { ...SAMPLES['tool.end'], toolCallId: '' }],
    [
      'a toolCallId that is too long',
      { ...SAMPLES['tool.end'], toolCallId: TOO_LONG },
    ],
    ['an empty toolName', { ...SAMPLES['tool.start'], toolName: '' }],
    [
      'a toolName that is too long',
      { ...SAMPLES['tool.start'], toolName: TOO_LONG },
    ],
    ['an empty requestId', { ...SAMPLES['approval.resolved'], requestId: '' }],
    [
      'a requestId that is too long',
      { ...SAMPLES['question.request'], requestId: TOO_LONG },
    ],
    ['an empty displayName', { ...SAMPLES['session.meta'], displayName: '' }],
    [
      'a displayName that is too long',
      { ...SAMPLES['session.meta'], displayName: TOO_LONG },
    ],
    ['a numeric toolCallId', { ...SAMPLES['tool.end'], toolCallId: 1 }],
    ['an array', [SAMPLES['turn.start']]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(detectionEventSchema, value);
  });
});
