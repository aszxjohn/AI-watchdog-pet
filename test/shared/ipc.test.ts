import { describe, expect, it } from 'vitest';
import {
  appGetVersion,
  CANVAS_READY_REASON_MAX_LENGTH,
  canvasReady,
  ipcErrorCodeSchema,
  ipcErrorSchema,
  ipcFailure,
  ipcResultSchema,
  isIpcChannelName,
  parseIpcResult,
  settingsGet,
  settingsPatch,
  stageViewDelta,
  stageViewSubscribe,
} from '../../src/shared/ipc';
import { z } from '../../src/shared/zod-setup';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import { expectRejected, expectRoundTrip } from './schema-helpers';

describe('isIpcChannelName', () => {
  it.each([
    'app:get-version',
    'settings:patch',
    'settings:get',
    'packs:runtime-failed',
    'stage-view:subscribe',
    'pool2:assign',
  ])('accepts %s', (name) => {
    expect(isIpcChannelName(name)).toBe(true);
  });

  it.each([
    ['no domain', 'getVersion'],
    ['camelCase action', 'app:getVersion'],
    ['upper-case domain', 'App:get-version'],
    ['empty action', 'app:'],
    ['empty domain', ':get-version'],
    ['three parts', 'app:get:version'],
    ['double hyphen', 'app:get--version'],
    ['leading hyphen', 'app:-get'],
    ['trailing hyphen', 'app:get-'],
    ['underscore', 'app:get_version'],
    ['space', 'app :get'],
    ['leading digit', '1app:get'],
    ['empty', ''],
  ])('rejects %s (%s)', (_label, name) => {
    expect(isIpcChannelName(name)).toBe(false);
  });
});

describe('ipcErrorCodeSchema', () => {
  it.each(ipcErrorCodeSchema.options)('round-trips %s', (code) => {
    expectRoundTrip(ipcErrorCodeSchema, code);
  });

  it.each([['unknown'], [''], [404], [null]])('rejects %j', (value) => {
    expectRejected(ipcErrorCodeSchema, value);
  });
});

describe('ipcErrorSchema', () => {
  it('round-trips an error', () => {
    expectRoundTrip(ipcErrorSchema, {
      code: 'invalid-input',
      message: 'arguments do not match the channel schema',
    });
  });

  it.each([
    ['unknown code', { code: 'boom', message: 'x' }],
    ['missing message', { code: 'invalid-input' }],
    ['non-string message', { code: 'invalid-input', message: 1 }],
    ['extra key (stack)', { code: 'handler-failed', message: 'x', stack: 's' }],
    ['not an object', 'handler-failed'],
  ])('rejects %s', (_label, value) => {
    expectRejected(ipcErrorSchema, value);
  });
});

describe('ipcResultSchema', () => {
  const schema = ipcResultSchema(z.string());

  it('round-trips a success', () => {
    expectRoundTrip(schema, { ok: true, data: '1.0.0' });
  });

  it('round-trips a failure', () => {
    expectRoundTrip(schema, {
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    });
  });

  it.each([
    ['success without data', { ok: true }],
    ['data of the wrong type', { ok: true, data: 1 }],
    ['failure without error', { ok: false }],
    ['failure with a bad error', { ok: false, error: { code: 'x' } }],
    ['success with an error too', { ok: true, data: 'v', error: undefined }],
    [
      'failure with data too',
      { ok: false, data: 'v', error: ipcFailure('handler-failed', 'x').error },
    ],
    ['missing ok', { data: 'v' }],
    ['ok as a string', { ok: 'true', data: 'v' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(schema, value);
  });
});

describe('ipcFailure', () => {
  it('builds a failure that the result schema accepts', () => {
    const failure = ipcFailure('sender-rejected', 'sender is not allowed');
    expect(failure).toStrictEqual({
      ok: false,
      error: { code: 'sender-rejected', message: 'sender is not allowed' },
    });
    expectRoundTrip(ipcResultSchema(z.never()), failure);
  });
});

describe('app:get-version contract', () => {
  it('uses a valid channel name', () => {
    expect(isIpcChannelName(appGetVersion.channel)).toBe(true);
  });

  it('round-trips its empty argument list', () => {
    expectRoundTrip(appGetVersion.input, []);
  });

  it.each([
    ['one argument', ['x']],
    ['an undefined argument', [undefined]],
    ['not an argument list', 'x'],
  ])('rejects input with %s', (_label, value) => {
    expectRejected(appGetVersion.input, value);
  });

  it('round-trips a version string', () => {
    expectRoundTrip(appGetVersion.output, '1.0.0');
  });

  it.each([
    ['empty string', ''],
    ['number', 1],
    ['null', null],
  ])('rejects output that is %s', (_label, value) => {
    expectRejected(appGetVersion.output, value);
  });
});

describe('parseIpcResult', () => {
  it('passes a valid reply through', () => {
    const reply = { ok: true, data: '1.0.0' };
    expect(parseIpcResult(appGetVersion, structuredClone(reply))).toStrictEqual(
      reply,
    );
  });

  it('passes a valid failure through', () => {
    const reply = ipcFailure('handler-failed', 'handler failed');
    expect(parseIpcResult(appGetVersion, structuredClone(reply))).toStrictEqual(
      reply,
    );
  });

  it.each([
    ['data of the wrong type', { ok: true, data: 42 }],
    ['data failing the output schema', { ok: true, data: '' }],
    ['no envelope', '1.0.0'],
    ['undefined', undefined],
  ])('turns a reply with %s into invalid-response', (_label, reply) => {
    const result = parseIpcResult(appGetVersion, reply);
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe('invalid-response');
  });
});

describe('settings and StageView contracts', () => {
  const STATE = {
    rev: 2,
    values: { ...SETTINGS_DEFAULTS, canvasDisplayId: null },
  };
  const PATCH = {
    baseRev: 2,
    ops: [{ op: 'set', field: 'canvasDisplayId', value: 7 }],
  };
  const SNAPSHOT = {
    rev: 5,
    view: {
      settings: STATE,
      displays: [],
      canvas: null,
      power: { suspended: false, locked: false },
    },
  };
  const DELTA = { rev: 6, sections: { settings: STATE } };

  it.each([
    [settingsGet.channel, 'settings:get'],
    [settingsPatch.channel, 'settings:patch'],
    [stageViewSubscribe.channel, 'stage-view:subscribe'],
    [stageViewDelta.channel, 'stage-view:delta'],
  ])('%s is a valid channel name', (channel, expected) => {
    expect(channel).toBe(expected);
    expect(isIpcChannelName(channel)).toBe(true);
  });

  it('settings:get takes no arguments and answers values with their rev', () => {
    expectRoundTrip(settingsGet.input, []);
    expectRejected(settingsGet.input, ['x']);
    expectRoundTrip(settingsGet.output, STATE);
    expectRejected(settingsGet.output, STATE.values);
  });

  it('settings:patch takes exactly one patch and answers { rev, merged }', () => {
    expectRoundTrip(settingsPatch.input, [PATCH]);
    expectRejected(settingsPatch.input, []);
    expectRejected(settingsPatch.input, [PATCH, PATCH]);
    expectRejected(settingsPatch.input, [{ ...PATCH, ops: [] }]);
    expectRoundTrip(settingsPatch.output, { rev: 3, merged: false });
    expectRejected(settingsPatch.output, { rev: 3 });
  });

  it('stage-view:subscribe takes no arguments and answers a snapshot', () => {
    expectRoundTrip(stageViewSubscribe.input, []);
    expectRejected(stageViewSubscribe.input, [0]);
    expectRoundTrip(stageViewSubscribe.output, SNAPSHOT);
    expectRejected(stageViewSubscribe.output, DELTA);
  });

  it('stage-view:delta carries a delta', () => {
    expectRoundTrip(stageViewDelta.payload, DELTA);
    expectRejected(stageViewDelta.payload, SNAPSHOT);
    expectRejected(stageViewDelta.payload, { rev: 6, sections: {} });
  });
});

describe('canvas:ready contract', () => {
  const READY = { ok: true, renderer: 'webgl', width: 1512, height: 982 };
  const FAILED = { ok: false, reason: 'Error: WebGL unsupported' };

  it('uses a valid channel name', () => {
    expect(canvasReady.channel).toBe('canvas:ready');
    expect(isIpcChannelName(canvasReady.channel)).toBe(true);
  });

  it.each([
    ['a webgl canvas', READY],
    ['a webgpu canvas', { ...READY, renderer: 'webgpu' }],
    ['a canvas-2d fallback', { ...READY, renderer: 'canvas' }],
    ['an empty world', { ...READY, width: 0, height: 0 }],
    ['a failure', FAILED],
    [
      'a failure at the length limit',
      { ok: false, reason: 'x'.repeat(CANVAS_READY_REASON_MAX_LENGTH) },
    ],
  ])('takes exactly one report: %s', (_label, report) => {
    expectRoundTrip(canvasReady.input, [report]);
  });

  it.each([
    ['no report', []],
    ['two reports', [READY, READY]],
    ['an unknown renderer', [{ ...READY, renderer: 'webgl2' }]],
    ['a fractional width', [{ ...READY, width: 1512.5 }]],
    ['a negative height', [{ ...READY, height: -1 }]],
    ['a success with a reason', [{ ...READY, reason: 'x' }]],
    ['a failure with a renderer', [{ ...FAILED, renderer: 'webgl' }]],
    ['a failure without a reason', [{ ok: false }]],
    ['an empty reason', [{ ok: false, reason: '' }]],
    [
      'a reason past the limit',
      [{ ok: false, reason: 'x'.repeat(CANVAS_READY_REASON_MAX_LENGTH + 1) }],
    ],
    ['ok as a string', [{ ...READY, ok: 'true' }]],
  ])('rejects %s', (_label, args) => {
    expectRejected(canvasReady.input, args);
  });

  it('answers null', () => {
    expectRoundTrip(canvasReady.output, null);
    expectRejected(canvasReady.output, undefined);
    expectRejected(canvasReady.output, {});
  });
});
