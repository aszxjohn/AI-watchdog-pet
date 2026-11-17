import { describe, expect, it } from 'vitest';
import { packsGetEntry, packsLog } from '../../src/shared/ipc';
import { isIpcChannelName } from '../../src/shared/ipc';
import {
  SANDBOX_REMOVALS_MAX,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import {
  isSandboxFrameNotice,
  PACK_MESSAGE_DROP_REASONS,
  packLogEntrySchema,
  packsLogInputSchema,
  SANDBOX_BOOT_FAILURES,
  SANDBOX_DESTROY_REASONS,
  SANDBOX_DOCUMENT_URL,
  SANDBOX_FAILURE_REASONS,
  SANDBOX_REPORT_PREFIX,
  SANDBOX_SKIP_REASONS,
  sandboxLoadMessage,
  sandboxRemovalSchema,
  sandboxReportSchema,
} from '../../src/shared/sandbox';
import { expectRejected, expectRoundTrip } from './schema-helpers';

const REMOVALS = [
  { name: 'fetch', status: 'removed' },
  { name: 'caches', status: 'absent' },
  { name: 'Iterator.prototype.join', status: 'removed' },
];

describe('the load chain messages (Story 3.5)', () => {
  it('the sandbox document is pack://_stage/sandbox.html', () => {
    expect(SANDBOX_DOCUMENT_URL).toBe('pack://_stage/sandbox.html');
  });

  it('the load message carries the entry source and nothing else', () => {
    expect(sandboxLoadMessage('SOURCE')).toStrictEqual({
      type: 'load',
      source: 'SOURCE',
    });
  });

  it("isSandboxFrameNotice takes exactly { type: 'worker-error' }", () => {
    expect(isSandboxFrameNotice({ type: 'worker-error' })).toBe(true);
    expect(isSandboxFrameNotice({ type: 'worker-error', why: 'x' })).toBe(
      false,
    );
    expect(isSandboxFrameNotice({ type: 'ready' })).toBe(false);
    expect(isSandboxFrameNotice('worker-error')).toBe(false);
    expect(isSandboxFrameNotice(null)).toBe(false);
  });
});

describe('sandboxReportSchema', () => {
  it.each<[string, unknown]>([
    [
      'a ready report',
      { type: 'sandbox.ready', removals: REMOVALS, consoleLines: 0 },
    ],
    [
      'a failed report',
      {
        type: 'sandbox.failed',
        reason: 'lockdown-output',
        removals: REMOVALS,
        consoleLines: 3,
      },
    ],
    [
      'a failed report before any removal',
      {
        type: 'sandbox.failed',
        reason: 'ses-missing',
        removals: [],
        consoleLines: 0,
      },
    ],
    ['a fault', { type: 'sandbox.fault', fault: 'unhandled-rejection' }],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(sandboxReportSchema, value);
  });

  it.each<[string, unknown]>([
    [
      'a ready report with console lines',
      { type: 'sandbox.ready', removals: REMOVALS, consoleLines: 1 },
    ],
    [
      'a ready report with a failed removal',
      {
        type: 'sandbox.ready',
        removals: [{ name: 'fetch', status: 'failed' }],
        consoleLines: 0,
      },
    ],
    [
      'a ready report with no removal',
      { type: 'sandbox.ready', removals: [], consoleLines: 0 },
    ],
    [
      'too many removals',
      {
        type: 'sandbox.failed',
        reason: 'api-removal-failed',
        removals: Array.from(
          { length: SANDBOX_REMOVALS_MAX + 1 },
          () => REMOVALS[0],
        ),
        consoleLines: 0,
      },
    ],
    [
      'an unknown failure',
      {
        type: 'sandbox.failed',
        reason: 'tired',
        removals: [],
        consoleLines: 0,
      },
    ],
    ['an unknown fault', { type: 'sandbox.fault', fault: 'oops' }],
    ['a stage call', { type: 'stage.log', text: 'x' }],
    ['an extra field', { type: 'sandbox.fault', fault: 'error', stack: 'x' }],
  ])('rejects %s', (_label, value) => {
    expectRejected(sandboxReportSchema, value);
  });

  it('every report type starts with SANDBOX_REPORT_PREFIX', () => {
    for (const option of sandboxReportSchema.options) {
      expect(option.shape.type.value.startsWith(SANDBOX_REPORT_PREFIX)).toBe(
        true,
      );
    }
  });

  it.each([
    ['a space', 'fetch x'],
    ['a semicolon', 'fetch;'],
    ['an empty segment', 'Iterator..join'],
    ['a leading digit', '1fetch'],
    ['a long name', 'a'.repeat(65)],
  ])('a removal name with %s is refused', (_label, name) => {
    expectRejected(sandboxRemovalSchema, { name, status: 'removed' });
  });
});

describe('packLogEntrySchema', () => {
  it.each<[string, unknown]>([
    ['a stage.log', { kind: 'stage-log', packId: 'sample-pack', text: 'x\ny' }],
    [
      'a ready line',
      {
        kind: 'sandbox-ready',
        packId: 'sample-pack',
        version: '1.0.0',
        removals: REMOVALS,
        consoleLines: 0,
      },
    ],
    [
      'a destroyed line',
      { kind: 'sandbox-destroyed', packId: 'sample-pack', reason: 'idle' },
    ],
    [
      'a destroyed line for a new version',
      {
        kind: 'sandbox-destroyed',
        packId: 'sample-pack',
        reason: 'version-changed',
      },
    ],
    [
      'a boot timeout',
      { kind: 'sandbox-failed', packId: 'sample-pack', reason: 'boot-timeout' },
    ],
    [
      'a failed line',
      { kind: 'sandbox-failed', packId: 'sample-pack', reason: 'bad-report' },
    ],
    [
      'a failed line with details',
      {
        kind: 'sandbox-failed',
        packId: 'sample-pack',
        reason: 'lockdown-output',
        removals: REMOVALS,
        consoleLines: 2,
      },
    ],
    [
      'a skipped line',
      {
        kind: 'sandbox-skipped',
        packId: 'sample-pack',
        reason: 'request-failed',
      },
    ],
    [
      'a dropped line',
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'too-large',
        count: 3,
      },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(packLogEntrySchema, value);
    expectRoundTrip(packsLogInputSchema, [value]);
  });

  it.each<[string, unknown]>([
    [
      'a stage.log over its length',
      {
        kind: 'stage-log',
        packId: 'sample-pack',
        text: 'x'.repeat(STAGE_LOG_MAX_LENGTH + 1),
      },
    ],
    [
      'a session key',
      {
        kind: 'sandbox-destroyed',
        packId: 'sample-pack',
        reason: 'idle',
        sessionKey: 'demo:1',
      },
    ],
    ['no pack id', { kind: 'sandbox-destroyed', reason: 'idle' }],
    ['no destroy reason', { kind: 'sandbox-destroyed', packId: 'sample-pack' }],
    [
      'an unknown destroy reason',
      { kind: 'sandbox-destroyed', packId: 'sample-pack', reason: 'bored' },
    ],
    [
      'a reserved host as the pack',
      { kind: 'sandbox-destroyed', packId: '_stage', reason: 'idle' },
    ],
    [
      'an unknown drop reason',
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'rude',
        count: 1,
      },
    ],
    [
      'a fractional count',
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'invalid',
        count: 1.5,
      },
    ],
    [
      'an undefined optional field',
      {
        kind: 'sandbox-failed',
        packId: 'sample-pack',
        reason: 'bad-report',
        removals: undefined,
      },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(packLogEntrySchema, value);
  });

  it('the failure reasons are the boot failures and the host’s own, each once', () => {
    expect(SANDBOX_FAILURE_REASONS).toStrictEqual([
      ...SANDBOX_BOOT_FAILURES,
      'worker-error',
      'unhandled-rejection',
      'bad-report',
      'boot-timeout',
    ]);
    for (const codes of [
      SANDBOX_FAILURE_REASONS,
      SANDBOX_SKIP_REASONS,
      SANDBOX_DESTROY_REASONS,
      PACK_MESSAGE_DROP_REASONS,
    ]) {
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      }
    }
  });
});

describe('the sandbox channels', () => {
  it('are packs:get-entry and packs:log', () => {
    expect(packsGetEntry.channel).toBe('packs:get-entry');
    expect(packsLog.channel).toBe('packs:log');
    expect(isIpcChannelName(packsGetEntry.channel)).toBe(true);
    expect(isIpcChannelName(packsLog.channel)).toBe(true);
  });
});
