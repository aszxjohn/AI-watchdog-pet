import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reduceSession } from '../../src/main/detection/reducer';
import { createSessions } from '../../src/main/detection/sessions';
import {
  type DetectionEvent,
  detectionEventSchema,
} from '../../src/shared/detection-events';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import { SOURCE_CAPABILITIES } from '../../src/shared/sources';

/**
 * What main/detection/sessions hands the reducer for a guessed turn end
 * (Story 2.6): the event as inference dated it, at the moment it fell due.
 * Neither shows in the published list, so the reducer is wrapped (it still
 * does its work) and its calls are read.
 */
vi.mock('../../src/main/detection/reducer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/main/detection/reducer')>();
  return { ...actual, reduceSession: vi.fn(actual.reduceSession) };
});

const MONO_START = 50_000;
const WALL_START = 1_762_675_200_000;

let mono: number;
let wall: number;

beforeEach(() => {
  mono = MONO_START;
  wall = WALL_START;
  vi.mocked(reduceSession).mockClear();
});

function ev(type: 'turn.start' | 'turn.reply'): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source: 'gemini',
    sessionKey: 'gemini:g1',
    ts: wall,
    via: 'log',
    confidence: 'exact',
  });
}

/** Every [event, time] the reducer got for a guessed turn end. */
function guessedTurnEnds(): [DetectionEvent, number][] {
  return vi
    .mocked(reduceSession)
    .mock.calls.filter(
      ([, event]) => event.type === 'turn.end' && event.via === 'inferred',
    )
    .map(([, event, at]) => [event, at]);
}

describe('a guessed turn end, as the reducer gets it', () => {
  it.each([
    ['on time', 10_000],
    ['noticed 15 seconds late', 25_000],
    ['noticed an hour late', 3_610_000],
  ])(
    '%s: at the moment it fell due, its ts back-dated as far',
    (_label, noticedAfter) => {
      const sessions = createSessions({
        timings: () => SETTINGS_DEFAULTS,
        now: () => mono,
        wallNow: () => wall,
        // Never fires: the test settles by hand, as a late timer would.
        setTimer: () => 0,
        clearTimer: () => {},
        capabilityOf: (source) => SOURCE_CAPABILITIES[source],
      });
      sessions.receive({ type: 'sync.ready', source: 'gemini' });
      sessions.receive(ev('turn.start'));
      sessions.receive(ev('turn.reply'));

      mono += noticedAfter;
      wall += noticedAfter;
      sessions.retime();

      expect(guessedTurnEnds()).toStrictEqual([
        [
          {
            type: 'turn.end',
            source: 'gemini',
            sessionKey: 'gemini:g1',
            ts: WALL_START + 10_000,
            via: 'inferred',
            confidence: 'inferred',
          },
          MONO_START + 10_000,
        ],
      ]);
      const [[event] = []] = guessedTurnEnds();
      expect(detectionEventSchema.parse(event)).toStrictEqual(event);
    },
  );
});
