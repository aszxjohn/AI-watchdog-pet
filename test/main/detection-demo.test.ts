import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDemoAdapter,
  DEMO_DISPLAY_NAME,
  DEMO_SESSION_KEY,
  type DemoAdapter,
} from '../../src/main/detection/adapters/demo/demo';
import {
  type AdapterOutput,
  detectionEventSchema,
  syncReadySchema,
} from '../../src/shared/detection-events';
import {
  type DetectionTimings,
  SETTINGS_DEFAULTS,
} from '../../src/shared/settings';
import { STATE_CODES, type StateCode } from '../../src/shared/states';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';

let clock: FakeClock;
let timings: DetectionTimings;
let outputs: AdapterOutput[];
/** Each output as a line, written when it was sent. */
let lines: string[];
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clock = fakeClock();
  timings = { ...SETTINGS_DEFAULTS };
  outputs = [];
  lines = [];
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function start(): DemoAdapter {
  return createDemoAdapter({
    emit: (output) => {
      outputs.push(output);
      lines.push(line(output));
    },
    timings: () => timings,
    wallNow: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

/**
 * One output as a line: its type, then its tool call or request id, its
 * display name, and for a replayed event how long before it was sent it is
 * dated.
 */
function line(output: AdapterOutput): string {
  if (output.type === 'sync.ready') {
    return `sync.ready ${output.source}`;
  }
  const parts: string[] = [output.type];
  if ('toolCallId' in output) {
    parts.push(output.toolCallId);
  }
  if ('requestId' in output) {
    parts.push(output.requestId);
  }
  if (output.type === 'session.meta') {
    parts.push(output.displayName);
  }
  if (output.replay === true) {
    parts.push(`(replayed, ${clock.wall() - output.ts} ms ago)`);
  }
  return parts.join(' ');
}

/** The outputs sent since the last call, as lines. */
function sent(): string[] {
  const result = lines;
  lines = [];
  outputs = [];
  return result;
}

function logLines(): string[] {
  return info.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((text: string) => text.startsWith('[detection] '));
}

const OPEN = ['session.start', 'session.meta 示範'];
const IDLE_AGO = `(replayed, ${SETTINGS_DEFAULTS.idleMs} ms ago)`;

describe('starting', () => {
  it('sends sync.ready at once, and nothing else: it replays nothing', () => {
    const demo = start();
    expect(sent()).toStrictEqual(['sync.ready demo']);
    expect(demo.state()).toBeNull();
    expect(clock.pendingCount()).toBe(0);
    expect(logLines()).toStrictEqual([]);
  });
});

describe('switching (Design Notes table)', () => {
  it.each<[StateCode, string[]]>([
    ['thinking', [...OPEN, 'turn.start']],
    ['working', [...OPEN, 'turn.start', 'tool.start demo-tool-1']],
    [
      'approval',
      [
        ...OPEN,
        'turn.start',
        'tool.start demo-tool-1',
        'approval.request demo-tool-1',
      ],
    ],
    [
      'decision',
      [
        ...OPEN,
        'turn.start',
        'tool.start demo-tool-1',
        'question.request demo-tool-1',
      ],
    ],
    ['error', [...OPEN, 'turn.start', 'error']],
    ['done', [...OPEN, 'turn.start', 'turn.end']],
    ['waiting', [...OPEN, 'turn.start', 'turn.end (replayed, 0 ms ago)']],
    ['idle', [`session.start ${IDLE_AGO}`, `session.meta 示範 ${IDLE_AGO}`]],
  ])('the first switch to %s opens the session and sends', (state, lines) => {
    const demo = start();
    sent();
    demo.setState(state);
    expect(sent()).toStrictEqual(lines);
    expect(demo.state()).toBe(state);
    expect(logLines()).toStrictEqual([`[detection] demo mode on: ${state}`]);
  });

  it('closes the tool call it left open first (its request with it)', () => {
    const demo = start();
    demo.setState('approval');
    sent();

    demo.setState('done');
    expect(sent()).toStrictEqual([
      'tool.end demo-tool-1',
      'turn.start',
      'turn.end',
    ]);

    demo.setState('decision');
    demo.setState('working');
    expect(sent()).toStrictEqual([
      'turn.start',
      'tool.start demo-tool-2',
      'question.request demo-tool-2',
      'tool.end demo-tool-2',
      'turn.start',
      'tool.start demo-tool-3',
    ]);
  });

  it('idle ends the open session and starts it again with the same key, dated idleMs ago', () => {
    const demo = start();
    demo.setState('working');
    sent();

    demo.setState('idle');
    expect(sent()).toStrictEqual([
      'tool.end demo-tool-1',
      'session.end',
      `session.start ${IDLE_AGO}`,
      `session.meta 示範 ${IDLE_AGO}`,
    ]);

    // The session is open again: the next switch does not reopen it.
    demo.setState('thinking');
    expect(sent()).toStrictEqual(['turn.start']);
  });

  it('picking the state shown sends it again', () => {
    const demo = start();
    demo.setState('approval');
    sent();
    demo.setState('approval');
    expect(sent()).toStrictEqual([
      'tool.end demo-tool-1',
      'turn.start',
      'tool.start demo-tool-2',
      'approval.request demo-tool-2',
    ]);
  });

  it('logs one line per switch, with state codes only', () => {
    const demo = start();
    demo.setState('approval');
    demo.setState('idle');
    demo.setState('approval');
    demo.stop();
    expect(logLines()).toStrictEqual([
      '[detection] demo mode on: approval',
      '[detection] demo mode: idle',
      '[detection] demo mode: approval',
      '[detection] demo mode off',
    ]);
  });

  it('sends only shared events of the demo session, each passing the shared schema', () => {
    const demo = start();
    const all: AdapterOutput[] = [];
    const record = () => {
      all.push(...outputs);
      sent();
    };
    record();
    for (const from of STATE_CODES) {
      for (const to of STATE_CODES) {
        demo.setState(from);
        demo.setState(to);
        clock.advance(timings.idleMs);
        record();
      }
    }
    demo.stop();
    record();

    const [first, ...events] = all;
    expect(syncReadySchema.safeParse(first).success).toBe(true);
    expect(events.length).toBeGreaterThan(64 * 2);
    for (const event of events) {
      const parsed = detectionEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(event)).toBe(true);
      expect(event).toMatchObject({
        source: 'demo',
        sessionKey: DEMO_SESSION_KEY,
        via: 'log',
        confidence: 'exact',
      });
    }
    expect(DEMO_SESSION_KEY).toBe('demo:1');
    expect(DEMO_DISPLAY_NAME).toBe('示範');
  });
});

describe('repeats', () => {
  it.each<[StateCode, keyof DetectionTimings, string]>([
    ['thinking', 'idleMs', 'activity'],
    ['working', 'idleMs', 'activity'],
    ['approval', 'idleMs', 'activity'],
    ['decision', 'idleMs', 'activity'],
    ['waiting', 'idleMs', 'activity'],
    ['error', 'errorHoldMs', 'error'],
    ['done', 'doneMs', 'turn.end'],
    ['idle', 'idleMs', `activity ${IDLE_AGO}`],
  ])('%s repeats every %s / 2: %s', (state, timing, repeated) => {
    const demo = start();
    demo.setState(state);
    sent();
    const every = timings[timing] / 2;

    clock.advance(every - 1);
    expect(sent()).toStrictEqual([]);
    clock.advance(1);
    expect(sent()).toStrictEqual([repeated]);
    clock.advance(every * 3);
    expect(sent()).toStrictEqual([repeated, repeated, repeated]);
    expect(clock.pendingCount()).toBe(1);
  });

  it('idle repeats sooner when the back-dated session would expire first: every min(idleMs, sessionExpireMs - idleMs) / 2', () => {
    timings = { ...timings, idleMs: 45 * 60_000, sessionExpireMs: 60 * 60_000 };
    const demo = start();
    demo.setState('idle');
    sent();
    const every = (15 * 60_000) / 2;
    const ago = `(replayed, ${45 * 60_000} ms ago)`;

    clock.advance(every - 1);
    expect(sent()).toStrictEqual([]);
    clock.advance(1);
    expect(sent()).toStrictEqual([`activity ${ago}`]);
    clock.advance(every);
    expect(sent()).toStrictEqual([`activity ${ago}`]);
  });

  it('idle with idleMs not less than sessionExpireMs: the switch is sent, one warning, no repeat', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    timings = { ...timings, idleMs: 3_600_000, sessionExpireMs: 3_600_000 };
    const demo = start();
    sent();

    demo.setState('idle');

    expect(sent()).toStrictEqual([
      'session.start (replayed, 3600000 ms ago)',
      'session.meta 示範 (replayed, 3600000 ms ago)',
    ]);
    expect(warn.mock.calls).toStrictEqual([
      [
        '[detection] demo mode: idle cannot hold while idleMs is not less than sessionExpireMs; not repeating',
      ],
    ]);
    expect(clock.pendingCount()).toBe(0);
    clock.advance(3 * 3_600_000);
    expect(sent()).toStrictEqual([]);

    // Picking another state repeats again, with no warning.
    demo.setState('thinking');
    expect(clock.pendingCount()).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('each repeat reads the timings again', () => {
    const demo = start();
    demo.setState('done');
    sent();

    timings = { ...timings, doneMs: 1000 };
    // The repeat already set still comes at the old interval...
    clock.advance(2500);
    expect(sent()).toStrictEqual(['turn.end']);
    // ...and the next ones at the new one.
    clock.advance(500);
    expect(sent()).toStrictEqual(['turn.end']);
  });

  it('a switch replaces the repeat', () => {
    const demo = start();
    demo.setState('done');
    demo.setState('error');
    sent();
    clock.advance(timings.errorHoldMs / 2);
    expect(sent()).toStrictEqual(['error']);
    expect(clock.pendingCount()).toBe(1);
  });
});

describe('retime and refresh', () => {
  it.each<[StateCode, keyof DetectionTimings]>([
    ['done', 'doneMs'],
    ['error', 'errorHoldMs'],
    ['waiting', 'idleMs'],
    ['idle', 'idleMs'],
    ['approval', 'idleMs'],
  ])(
    'retime sends %s again when %s changed, with the new value',
    (state, timing) => {
      const demo = start();
      demo.setState(state);
      const before = sent();

      demo.retime();
      expect(sent()).toStrictEqual([]);

      timings = { ...timings, [timing]: timings[timing] * 2 };
      demo.retime();
      const again = sent();
      expect(again.length).toBeGreaterThan(0);
      if (state === 'idle') {
        const ago = `(replayed, ${timings.idleMs} ms ago)`;
        expect(again).toStrictEqual([
          'session.end',
          `session.start ${ago}`,
          `session.meta 示範 ${ago}`,
        ]);
      } else {
        // The switching events again (no session.start: it is open).
        expect(again.at(-1)).toBe(before.at(-1)?.replace('-1', '-2'));
      }
      expect(logLines()).toHaveLength(1);
    },
  );

  it('retime sends idle again when sessionExpireMs changed', () => {
    const demo = start();
    demo.setState('idle');
    sent();
    timings = { ...timings, sessionExpireMs: 3_600_000 };
    demo.retime();
    expect(sent()).toStrictEqual([
      'session.end',
      `session.start ${IDLE_AGO}`,
      `session.meta 示範 ${IDLE_AGO}`,
    ]);
  });

  it('retime ignores a timing the state does not repeat by', () => {
    const demo = start();
    demo.setState('idle');
    sent();
    timings = {
      ...timings,
      doneMs: 9000,
      errorHoldMs: 9000,
      approvalInferMs: 9000,
    };
    demo.retime();
    expect(sent()).toStrictEqual([]);
  });

  it('refresh opens the session again and sends the shown state again, unlogged', () => {
    const demo = start();
    demo.setState('done');
    sent();
    demo.refresh();
    expect(sent()).toStrictEqual([...OPEN, 'turn.start', 'turn.end']);

    demo.setState('approval');
    sent();
    demo.refresh();
    expect(sent()).toStrictEqual([
      'tool.end demo-tool-1',
      ...OPEN,
      'turn.start',
      'tool.start demo-tool-2',
      'approval.request demo-tool-2',
    ]);
    expect(logLines()).toStrictEqual([
      '[detection] demo mode on: done',
      '[detection] demo mode: approval',
    ]);
  });

  it('refresh restarts idle as a switch to idle does', () => {
    const demo = start();
    demo.setState('idle');
    sent();
    demo.refresh();
    expect(sent()).toStrictEqual([
      'session.end',
      `session.start ${IDLE_AGO}`,
      `session.meta 示範 ${IDLE_AGO}`,
    ]);
  });

  it('refresh and retime do nothing before the first switch', () => {
    const demo = start();
    sent();
    demo.refresh();
    timings = { ...timings, idleMs: 120_000 };
    demo.retime();
    expect(sent()).toStrictEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('stop', () => {
  it('ends the session and its repeat, and logs demo mode off', () => {
    const demo = start();
    demo.setState('approval');
    sent();

    demo.stop();
    expect(sent()).toStrictEqual(['session.end']);
    expect(clock.pendingCount()).toBe(0);
    expect(demo.state()).toBeNull();
  });

  it('afterwards does nothing', () => {
    const demo = start();
    demo.setState('approval');
    demo.stop();
    sent();
    info.mockClear();

    demo.setState('done');
    demo.refresh();
    timings = { ...timings, idleMs: 120_000 };
    demo.retime();
    demo.stop();
    clock.advance(3_600_000);

    expect(sent()).toStrictEqual([]);
    expect(logLines()).toStrictEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('sends no session.end when no session was opened', () => {
    const demo = start();
    sent();
    demo.stop();
    expect(sent()).toStrictEqual([]);
    expect(logLines()).toStrictEqual(['[detection] demo mode off']);
  });
});
