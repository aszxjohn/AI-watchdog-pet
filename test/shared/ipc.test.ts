import { describe, expect, it } from 'vitest';
import {
  appGetVersion,
  ipcErrorCodeSchema,
  ipcErrorSchema,
  ipcFailure,
  ipcResultSchema,
  isIpcChannelName,
  parseIpcResult,
} from '../../src/shared/ipc';
import { z } from '../../src/shared/zod-setup';
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
