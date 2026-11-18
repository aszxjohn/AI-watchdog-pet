import { describe, expect, it } from 'vitest';
import {
  packsGetEntry,
  packsGetManifest,
  packsLog,
} from '../../src/shared/ipc';
import { isIpcChannelName } from '../../src/shared/ipc';
import {
  SANDBOX_REMOVALS_MAX,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import {
  isSandboxFrameNotice,
  PACK_MESSAGE_DROP_REASONS,
  PACK_NOT_DRAWN_REASONS,
  SANDBOX_NO_DRAW_REASONS,
  SKIPPED_DRAW_COMMANDS,
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

describe('Story 3.6: no-draw reports and the drawing lines', () => {
  it('round-trips a no-draw report of each reason, and rejects a bad one', () => {
    for (const reason of SANDBOX_NO_DRAW_REASONS) {
      expectRoundTrip(sandboxReportSchema, {
        type: 'sandbox.no-draw',
        seq: 7,
        reason,
      });
    }
    expectRejected(sandboxReportSchema, {
      type: 'sandbox.no-draw',
      seq: -1,
      reason: 'frame-threw',
    });
    expectRejected(sandboxReportSchema, {
      type: 'sandbox.no-draw',
      seq: 1,
      reason: 'bored',
    });
    expectRejected(sandboxReportSchema, {
      type: 'sandbox.no-draw',
      seq: 1,
      reason: 'frame-threw',
      error: 'x',
    });
  });

  it('a draw is not a report (its type has no sandbox. prefix)', () => {
    expectRejected(sandboxReportSchema, { type: 'draw', seq: 0, actors: {} });
  });

  it("the drop reasons add the draw's own and the no-draw reasons, each once", () => {
    expect(PACK_MESSAGE_DROP_REASONS).toStrictEqual([
      'rate-limited',
      'too-large',
      'invalid',
      'not-own-actor',
      'log-rate-limited',
      'not-ready',
      'too-many-commands',
      'unknown-asset',
      'unknown-frame',
      'stale-draw',
      'too-many-emitters',
      ...SANDBOX_NO_DRAW_REASONS,
    ]);
    for (const codes of [
      PACK_MESSAGE_DROP_REASONS,
      SKIPPED_DRAW_COMMANDS,
      PACK_NOT_DRAWN_REASONS,
    ]) {
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it.each<[string, unknown]>([
    [
      'a skipped command type',
      { kind: 'commands-skipped', packId: 'sample-pack', command: 'bitmap' },
    ],
    [
      'a pack not drawn',
      { kind: 'not-drawn', packId: 'sample-pack', reason: 'character-missing' },
    ],
    [
      'an asset that failed',
      {
        kind: 'not-drawn',
        packId: 'sample-pack',
        reason: 'asset-failed',
        asset: 'body-dots',
      },
    ],
    [
      'a draw dropped as stale',
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'stale-draw',
        count: 2,
      },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(packLogEntrySchema, value);
  });

  it.each<[string, unknown]>([
    [
      'a sprite command skipped',
      { kind: 'commands-skipped', packId: 'sample-pack', command: 'sprite' },
    ],
    [
      'a particles command skipped (drawn since Story 3.6)',
      { kind: 'commands-skipped', packId: 'sample-pack', command: 'particles' },
    ],
    [
      'an unknown reason',
      { kind: 'not-drawn', packId: 'sample-pack', reason: 'shy' },
    ],
    [
      'an asset that is not an id',
      {
        kind: 'not-drawn',
        packId: 'sample-pack',
        reason: 'asset-failed',
        asset: 'img/a.png',
      },
    ],
    [
      'a session key',
      {
        kind: 'not-drawn',
        packId: 'sample-pack',
        reason: 'character-missing',
        sessionKey: 'demo:1',
      },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(packLogEntrySchema, value);
  });
});

describe('packs:get-manifest (Story 3.6)', () => {
  it('is an overlay channel named <domain>:<action>', () => {
    expect(packsGetManifest.channel).toBe('packs:get-manifest');
    expect(isIpcChannelName(packsGetManifest.channel)).toBe(true);
  });
});
