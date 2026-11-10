import { describe, expect, it } from 'vitest';
import { createSleepClock } from '../../src/main/detection/clock';
import { fakeClock, MONO_START } from '../helpers/fake-clock';

const HOUR = 3_600_000;

function setup() {
  const fake = fakeClock();
  const clock = createSleepClock({
    monotonic: fake.monotonic,
    wall: fake.wall,
  });
  return { fake, clock };
}

describe('createSleepClock', () => {
  it('is the monotonic clock while nothing has slept', () => {
    const { fake, clock } = setup();
    expect(clock.now()).toBe(MONO_START);
    fake.advance(1234.5);
    expect(clock.now()).toBe(MONO_START + 1234.5);
  });

  it('I/O matrix 睡眠: 8 hours asleep with the monotonic clock still adds 8 hours', () => {
    const { fake, clock } = setup();
    fake.advance(1000);
    clock.suspend();
    fake.sleep(8 * HOUR);
    expect(clock.now()).toBe(MONO_START + 1000);

    expect(clock.resume()).toBe(8 * HOUR);
    expect(clock.now()).toBe(MONO_START + 1000 + 8 * HOUR);
    fake.advance(500);
    expect(clock.now()).toBe(MONO_START + 1500 + 8 * HOUR);
  });

  it('adds only what the monotonic clock missed', () => {
    const { fake, clock } = setup();
    clock.suspend();
    // 2 s awake between suspend and sleep, then 10 min asleep, 3 s awake.
    fake.advance(2000);
    fake.sleep(600_000);
    fake.advance(3000);

    expect(clock.resume()).toBe(600_000);
    expect(clock.now()).toBe(MONO_START + 5000 + 600_000);
  });

  it('adds sleeps up', () => {
    const { fake, clock } = setup();
    for (const ms of [HOUR, 2 * HOUR]) {
      clock.suspend();
      fake.sleep(ms);
      clock.resume();
    }
    expect(clock.now()).toBe(MONO_START + 3 * HOUR);
  });

  it('adds 0 when the wall clock moved less than the monotonic one (set back while asleep)', () => {
    const { fake, clock } = setup();
    clock.suspend();
    fake.advance(10_000);
    fake.sleep(-60_000);

    expect(clock.resume()).toBe(0);
    expect(clock.now()).toBe(MONO_START + 10_000);
  });

  it('a monotonic clock that kept counting through sleep gets nothing added', () => {
    const { fake, clock } = setup();
    clock.suspend();
    fake.advance(HOUR);
    expect(clock.resume()).toBe(0);
    expect(clock.now()).toBe(MONO_START + HOUR);
  });

  it('resume with no suspend before it adds nothing and answers null', () => {
    const { fake, clock } = setup();
    fake.sleep(HOUR);
    expect(clock.resume()).toBeNull();
    expect(clock.now()).toBe(MONO_START);

    clock.suspend();
    fake.sleep(HOUR);
    expect(clock.resume()).toBe(HOUR);
    expect(clock.resume()).toBeNull();
    expect(clock.now()).toBe(MONO_START + HOUR);
  });

  it('a second suspend before resume keeps the first readings', () => {
    const { fake, clock } = setup();
    clock.suspend();
    fake.sleep(HOUR);
    clock.suspend();
    fake.sleep(HOUR);
    expect(clock.resume()).toBe(2 * HOUR);
  });

  it('a wall-clock change while awake moves nothing', () => {
    const { fake, clock } = setup();
    fake.sleep(5 * HOUR);
    fake.advance(1000);
    clock.suspend();
    clock.resume();
    expect(clock.now()).toBe(MONO_START + 1000);
  });

  it('defaults to performance.now and Date.now', () => {
    const clock = createSleepClock();
    const before = performance.now();
    const now = clock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(performance.now());
  });
});
