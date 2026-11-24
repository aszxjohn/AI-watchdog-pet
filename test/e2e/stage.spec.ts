/**
 * The world tick and drawing (Story 3.6) and acting by state (Story 3.7),
 * in real Electron: the production build (`.vite/`, from
 * scripts/e2e-build.mjs) launched by Playwright's `_electron` with a
 * temporary HOME and userData. A synthetic Claude Code session in that
 * HOME gets a character of the stage probe pack: the contract test pack
 * under another id, its entry wrapped so that the first message of each
 * type it gets is written back with `stage.log`, and so is its own
 * actor's state in a `frame` whenever it differs from the one before, as
 * `awp-stage state <state>` (no other change: what it draws is the
 * contract pack's). The tests read the run log (what the pack got), the
 * overlay's body data attributes (what was drawn, the particles and the
 * placeholder included: Story 3.6's second last part, Story 3.7) and the
 * panels' StageView; to change the session's state they append a
 * synthetic record to its transcript. Story 3.7's are 過場 (a turn's end
 * is done for 5 seconds, then waiting) and 佔位 (an API error, a state
 * probe-one neither draws nor maps, is drawn as the stage's placeholder,
 * whose opacity rises and falls, and which is drawn again once a lost
 * WebGL context is back); Story 3.8's name tag is counted with the actor
 * (drawn, in the placeholder, gone); then 加入與移出 starts a new turn, which ends
 * the error (drawn by the pack again, no placeholder opacity), before the
 * session is released. Nothing is read from the screen (no screenshot,
 * no pixel), and nothing connects anywhere but the app itself.
 */
import {
  expect,
  test,
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  PLACEHOLDER_ALPHA_MAX,
  PLACEHOLDER_ALPHA_MIN,
} from '../../src/overlay/renderer/placeholder';
import { manifestSchema, type StageMessage } from '../../src/shared/pack-api';
import type { PanelsApi } from '../../src/shared/preload-api';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import {
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import {
  appendClaudeRecord,
  closeStage,
  LAUNCH_TIMEOUT_MS,
  launchStage,
  loseOverlayContext,
  makeDirs,
  readOverlayData,
  readRunLog,
  readStageView,
  removeDirs,
  restoreOverlayContext,
  waitForLine,
  WINDOW_TIMEOUT_MS,
  windowAt,
  writeClaudeSession,
  type E2eDirs,
  type RunLogLine,
  type SyntheticSession,
} from './helpers';

/** The stage probe pack's id: no character or series name. */
const STAGE_PACK_ID = 'stage-probe';

/** What starts each `stage.log` line the probe writes. */
const TELL_PREFIX = 'awp-stage ';

/** What starts the probe's `stage.log` line of its actor's state. */
const STATE_PREFIX = `${TELL_PREFIX}state `;

/** How long the probe's sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** How long the first draw may take to show once the sandbox is ready. */
const DRAWN_TIMEOUT_MS = 20_000;

/**
 * How long a stopped sparkle emitter may take to be gone once StageView
 * has the new state: the longest a sparkle lives (900 ms) and the new
 * state reaching the pack and its draw coming back. Short on purpose:
 * particles stepped in ticker frames instead of ms would live some 16
 * times as long and miss it.
 */
const PARTICLES_GONE_TIMEOUT_MS = 5_000;

/** How long a turn's end is shown as done: the stage's timing, as set. */
const DONE_MS = SETTINGS_DEFAULTS.doneMs;

/**
 * How late, after the answer was appended, waiting may first show at the
 * latest: DONE_MS and the time the adapter takes to read the answer.
 */
const WAITING_LATEST_MS = 15_000;

/**
 * How much earlier than DONE_MS after the answer was appended waiting may
 * first be seen: the test's and main's clocks and timers. The time checked
 * is when the first read saying waiting came back, so the bound holds only
 * to within one read cycle (STATE_POLL_MS and two IPC round trips): it
 * catches waiting coming well before DONE_MS, not a few ms early.
 */
const WAITING_EARLY_MS = 50;

/** How often the state is read while it changes (過場, 佔位). */
const STATE_POLL_MS = 100;

/** About how far apart the placeholder's opacity is read twice (起伏). */
const ALPHA_GAP_MS = 300;

/** The contract pack's manifest, checked: what the probe declares. */
const MANIFEST = manifestSchema.parse({
  ...contractManifest(),
  id: STAGE_PACK_ID,
  name: 'Stage probe',
});

/**
 * The probe's entry: the contract pack's factory, called with `stage`,
 * inside a factory that writes the first message of each type back with
 * `stage.log` as `awp-stage <type> <JSON>` (non-ASCII written as `\uXXXX`),
 * and, at a `frame` whose own actor's state differs from the one in the
 * `frame` before (any, at the first), writes `awp-stage state <state>`
 * (ASCII: a state code), then hands the message on.
 */
function stageProbeEntry(): string {
  const contract = String(contractPackFiles().get('entry.js'))
    .trimEnd()
    .replace(/;$/, '');
  return `(function (stage) {
  'use strict';
  var inner = (
${contract}
  )(stage);
  var told = {};
  function tell(type, message) {
    if (told[type]) { return; }
    told[type] = true;
    stage.log(${JSON.stringify(TELL_PREFIX)} + type + ' ' + JSON.stringify(message).replace(/[^\\x20-\\x7e]/g, function (c) {
      return '\\\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    }));
  }
  function pass(type) {
    return function (message) {
      tell(type, message);
      return inner[type](message);
    };
  }
  var frame = pass('frame');
  var lastState;
  return {
    init: pass('init'),
    spawn: pass('spawn'),
    despawn: pass('despawn'),
    params: pass('params'),
    meta: pass('meta'),
    frame: function (message) {
      var own = message.actors[0];
      if (own !== undefined && own.state !== lastState) {
        lastState = own.state;
        stage.log(${JSON.stringify(STATE_PREFIX)} + own.state);
      }
      return frame(message);
    },
  };
})
`;
}

/** Writes the probe pack to `<dir>/stage-probe.awpet`. */
async function writeStageProbe(dir: string): Promise<string> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  files.set('manifest.json', manifestBytes(MANIFEST));
  files.set(MANIFEST.entry, stageProbeEntry());
  const file = path.join(dir, `${STAGE_PACK_ID}.awpet`);
  fs.writeFileSync(file, await zipBuffer(itemsOf(files, STAGE_PACK_ID)));
  return file;
}

/** A run log line of the probe starting with `text` (after `pack <id>: `). */
function stageLine(text: string): (line: RunLogLine) => boolean {
  const prefix = `pack ${STAGE_PACK_ID}: ${text}`;
  return (line) => line.category === 'packs' && line.message.startsWith(prefix);
}

/** Whether `line` says the probe's sandbox failed or was never made. */
function stageTrouble(line: RunLogLine): boolean {
  return (
    stageLine('sandbox failed')(line) ||
    stageLine('has an actor but gets no sandbox')(line)
  );
}

/** The first message of `type` the probe got, as it wrote it back. */
async function told(type: StageMessage['type']): Promise<StageMessage> {
  const prefix = `pack ${STAGE_PACK_ID}: stage.log: ${TELL_PREFIX}${type} `;
  const line = await waitForLine(
    dirs.logs,
    (each) => each.category === 'packs' && each.message.startsWith(prefix),
    DRAWN_TIMEOUT_MS,
  );
  return JSON.parse(line.message.slice(prefix.length)) as StageMessage;
}

/** Every key anywhere in `value`. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysIn);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [
      key,
      ...keysIn(inner),
    ]);
  }
  return [];
}

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let session: SyntheticSession;
let app: ElectronApplication;
let overlay: Page;
let panels: Page;

test.beforeAll(async () => {
  test.setTimeout(
    LAUNCH_TIMEOUT_MS + READY_TIMEOUT_MS + 2 * WINDOW_TIMEOUT_MS + 30_000,
  );
  dirs = makeDirs();
  session = writeClaudeSession(dirs.home);
  app = await launchStage(dirs, await writeStageProbe(dirs.root));
  await waitForLine(
    dirs.logs,
    stageLine('sandbox ready'),
    READY_TIMEOUT_MS,
    stageTrouble,
  );
  overlay = await windowAt(app, 'app://overlay/');
  panels = await windowAt(app, 'app://panels/');
});

// The run log goes with the test results (CI uploads them when a test
// fails) before the temporary folders are removed.
test.afterAll(async () => {
  if (app !== undefined) {
    await closeStage(app);
  }
  if (dirs !== undefined) {
    if (fs.existsSync(dirs.logs)) {
      fs.cpSync(
        dirs.logs,
        path.join(test.info().project.outputDir, 'stage-run-log'),
        { recursive: true },
      );
    }
    removeDirs(dirs);
  }
});

/** The StageView snapshot the panels see. */
function panelsSnapshot(): Promise<StageViewSnapshot> {
  return readStageView(panels);
}

/** The overlay body's data attributes. */
function overlayData(): Promise<Record<string, string | undefined>> {
  return readOverlayData(overlay);
}

/** One of the probe's state lines: when it was logged, and the state. */
interface StateLine {
  /** In ms since the epoch, as the run log has it. */
  readonly at: number;
  readonly state: string;
}

/**
 * The probe's state lines in the run log (`awp-stage state <state>`), in
 * order: all of them, or those logged after `since` (ms since the epoch).
 */
function probeStates(since = Number.NEGATIVE_INFINITY): StateLine[] {
  const prefix = `pack ${STAGE_PACK_ID}: stage.log: ${STATE_PREFIX}`;
  return readRunLog(dirs.logs).flatMap((line) =>
    line.category === 'packs' &&
    line.message.startsWith(prefix) &&
    line.at > since
      ? [{ at: line.at, state: line.message.slice(prefix.length) }]
      : [],
  );
}

/**
 * Once the probe's last state line says `state`, when it was logged: the
 * lines after it are what a change made from now on brings.
 */
async function lastStateAt(state: string): Promise<number> {
  // The very line the poll took: one written after it would give its time.
  let last: StateLine | undefined;
  await expect
    .poll(
      () => {
        last = probeStates().at(-1);
        return last?.state;
      },
      { timeout: DRAWN_TIMEOUT_MS },
    )
    .toBe(state);
  return last?.at ?? Number.NEGATIVE_INFINITY;
}

/** A run log line of main/windows starting with `message`. */
function windowsLine(message: string): (line: RunLogLine) => boolean {
  return (line) =>
    line.category === 'windows' && line.message.startsWith(message);
}

/** How many run log lines `match` takes now. */
function countLines(match: (line: RunLogLine) => boolean): number {
  return readRunLog(dirs.logs).filter(match).length;
}

/** Waits `ms`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('I/O matrix', () => {
  test("出現: the probe gets init (its actor's character, full parameters, mapped state, display name), then frames; its draw is drawn at the bottom of the canvas", async () => {
    const { view } = await panelsSnapshot();
    expect(view.actors.map((actor) => actor.sessionKey)).toStrictEqual([
      session.sessionKey,
    ]);
    const [actor] = view.actors;
    if (actor === undefined) {
      return;
    }
    const characterId = actor.characterKey.slice(STAGE_PACK_ID.length + 1);
    const character = MANIFEST.characters.find(
      (each) => each.id === characterId,
    );
    expect(character).toBeDefined();
    // Neither drawn nor mapped: the state itself (Story 3.7).
    const mapped = character?.states.includes(actor.state)
      ? actor.state
      : (character?.fallback?.[actor.state] ?? actor.state);
    const defaults = Object.fromEntries(
      (character?.params ?? []).map((param) => [param.key, param.default]),
    );

    const init = await told('init');
    expect(init).toStrictEqual({
      type: 'init',
      actors: [
        {
          own: true,
          actorId: actor.actorId,
          characterId,
          params: defaults,
          state: mapped,
          displayName: actor.displayName,
        },
      ],
    });

    const frame = await told('frame');
    expect(frame).toMatchObject({
      type: 'frame',
      seq: 0,
      dt: 0,
      actors: [{ actorId: actor.actorId, state: mapped }],
    });
    // init came first.
    const lines = readRunLog(dirs.logs).map((line) => line.message);
    const at = (type: string) =>
      lines.findIndex((message) =>
        message.includes(`stage.log: ${TELL_PREFIX}${type} `),
      );
    expect(at('init')).toBeGreaterThanOrEqual(0);
    expect(at('init')).toBeLessThan(at('frame'));

    // Its draws are taken and drawn: one actor, with its sprite.
    await expect
      .poll(async () => (await overlayData()).drawnActors, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    // With its texture, loaded from pack:// (a sprite without one is hidden).
    await expect
      .poll(async () => Number((await overlayData()).drawnSprites), {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(1);
    // And it takes the mouse: its hit area went to canvas-input.
    await expect
      .poll(async () => (await overlayData()).hitAreas, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    // With its name tag and state badge (Story 3.8: badges on by default).
    expect((await overlayData()).drawnBadges).toBe('1');
    expect(
      readRunLog(dirs.logs).filter(
        (line) =>
          stageLine('dropped')(line) ||
          stageLine('not drawn')(line) ||
          stageTrouble(line),
      ),
    ).toStrictEqual([]);
  });

  test('隱私: what the probe got has no session key, source, confidence, fixed parameter or motion', async () => {
    const messages = [await told('init'), await told('frame')];
    const keys = new Set(messages.flatMap(keysIn));
    for (const key of [
      'sessionKey',
      'source',
      'confidence',
      'motion',
      'fixed',
      'scale',
      'inPool',
      'wander',
      'characterKey',
    ]) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(JSON.stringify(messages)).not.toContain(session.sessionId);
    expect(JSON.stringify(messages)).not.toContain('claude-code');
  });

  test("換螢幕: PixiJS draws at the canvas display's scaleFactor", async () => {
    const { view } = await panelsSnapshot();
    expect(view.canvas).not.toBeNull();
    await expect
      .poll(async () => (await overlayData()).resolution)
      .toBe(String(view.canvas?.scaleFactor));
  });

  /** The probe actor's state as StageView has it now. */
  async function stateNow(): Promise<string | undefined> {
    return (await panelsSnapshot()).view.actors[0]?.state;
  }

  test("粒子出現: the probe's actor (probe-one, glow on by default) thinking has its sparkle emitter drawn, with live particles; it still takes the mouse as before", async () => {
    const { view } = await panelsSnapshot();
    expect(view.actors.map((actor) => actor.characterKey)).toStrictEqual([
      `${STAGE_PACK_ID}/probe-one`,
    ]);

    appendClaudeRecord(dirs.home, session, 'prompt');
    await expect.poll(stateNow, { timeout: DRAWN_TIMEOUT_MS }).toBe('thinking');
    await expect
      .poll(async () => (await overlayData()).particleEmitters, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    await expect
      .poll(async () => Number((await overlayData()).liveParticles), {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    // And they are on screen: what pixi-stage put there, not only what
    // particles.ts runs.
    await expect
      .poll(async () => (await overlayData()).drawnEmitters, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    await expect
      .poll(async () => Number((await overlayData()).drawnParticles), {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const data = await overlayData();
    expect([data.drawnActors, data.hitAreas]).toStrictEqual(['1', '1']);
  });

  test('粒子停止: its turn done (probe-one shows it as waiting, without particles), the emitter stops and is gone once its particles ran out', async () => {
    appendClaudeRecord(dirs.home, session, 'answer');
    await expect
      .poll(stateNow, { timeout: DRAWN_TIMEOUT_MS })
      .toMatch(/^(?:done|waiting)$/);
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [data.particleEmitters, data.drawnEmitters];
        },
        { timeout: PARTICLES_GONE_TIMEOUT_MS },
      )
      .toStrictEqual(['0', '0']);
    const data = await overlayData();
    expect([
      data.liveParticles,
      data.drawnParticles,
      data.drawnActors,
    ]).toStrictEqual(['0', '0', '1']);
    // Its draws were taken whole, and particles are not skipped any more.
    expect(
      readRunLog(dirs.logs).filter(
        (line) =>
          stageLine('dropped')(line) ||
          stageLine('its draws have particles')(line) ||
          stageTrouble(line),
      ),
    ).toStrictEqual([]);
  });

  test('過場: a turn ended is done for 5 seconds, then waiting: StageView has done before T + 5000 and first has waiting no earlier than T + 5000 (T: just before the answer was appended); the probe (probe-one maps done to waiting) gets thinking, then waiting, never done; one actor drawn all along, never the placeholder', async () => {
    // The previous turn's end has reached the probe, as waiting.
    const since = await lastStateAt('waiting');
    /** What was drawn each time the state was read. */
    const drawn = new Set<string>();
    async function sample(): Promise<string | undefined> {
      const data = await overlayData();
      drawn.add(
        `placeholders ${data.drawnPlaceholders}, actors ${data.drawnActors}`,
      );
      return stateNow();
    }

    appendClaudeRecord(dirs.home, session, 'prompt');
    await expect
      .poll(sample, { intervals: [STATE_POLL_MS], timeout: DRAWN_TIMEOUT_MS })
      .toBe('thinking');
    // The probe has had a frame with thinking before the turn ends.
    await lastStateAt('thinking');

    const answeredAt = Date.now();
    appendClaudeRecord(dirs.home, session, 'answer');
    // Each state read, with when it was back (so the state was there by
    // then): until waiting, or the latest it may come.
    const seen: { readonly state: string | undefined; readonly at: number }[] =
      [];
    while (Date.now() <= answeredAt + WAITING_LATEST_MS) {
      const state = await sample();
      seen.push({ state, at: Date.now() });
      if (state === 'waiting') {
        break;
      }
      await pause(STATE_POLL_MS);
    }
    const doneAt = seen.find((each) => each.state === 'done')?.at;
    const waitingAt = seen.find((each) => each.state === 'waiting')?.at;
    expect(doneAt, 'done seen').toBeDefined();
    expect(doneAt ?? Number.POSITIVE_INFINITY).toBeLessThan(
      answeredAt + DONE_MS,
    );
    expect(waitingAt, 'waiting seen').toBeDefined();
    expect(waitingAt ?? 0).toBeGreaterThanOrEqual(
      answeredAt + DONE_MS - WAITING_EARLY_MS,
    );
    expect(waitingAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      answeredAt + WAITING_LATEST_MS,
    );
    // done held until waiting: nothing else in between.
    const states = seen
      .map((each) => each.state)
      .filter((state, index, all) => index === 0 || state !== all[index - 1]);
    expect(
      [
        ['done', 'waiting'],
        ['thinking', 'done', 'waiting'],
      ],
      `states seen after the answer: ${states.join(', ')}`,
    ).toContainEqual(states);
    expect([...drawn]).toStrictEqual(['placeholders 0, actors 1']);
    await expect
      .poll(() => probeStates(since).map((line) => line.state))
      .toStrictEqual(['thinking', 'waiting']);
  });

  test('佔位: an API error while thinking (its sparkle drawn) is error, which probe-one neither draws nor maps: drawn as the stage’s placeholder, at once without the sparkle or any sprite, one actor that takes the mouse; the probe still gets error itself; the placeholder’s opacity rises and falls; with the WebGL context lost it is not drawn (no opacity), and once restored it is drawn and takes the mouse again, the overlay logging no error', async () => {
    appendClaudeRecord(dirs.home, session, 'prompt');
    await expect.poll(stateNow, { timeout: DRAWN_TIMEOUT_MS }).toBe('thinking');
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [data.particleEmitters, data.drawnEmitters];
        },
        { timeout: DRAWN_TIMEOUT_MS },
      )
      .toStrictEqual(['1', '1']);
    const since = await lastStateAt('thinking');
    // Its draws dropped, or its sandbox in trouble, from here on.
    const dropped = stageLine('dropped');
    const droppedBefore = countLines(dropped);
    const troubleBefore = countLines(stageTrouble);

    // Everything below has to be done within errorHoldMs of this.
    const errorAt = Date.now();
    appendClaudeRecord(dirs.home, session, 'error');
    // The first data drawn with the placeholder: its particles went at once.
    let first: Record<string, string | undefined> = {};
    await expect
      .poll(
        async () => {
          first = await overlayData();
          return first.drawnPlaceholders;
        },
        { intervals: [STATE_POLL_MS], timeout: DRAWN_TIMEOUT_MS },
      )
      .toBe('1');
    expect({
      particleEmitters: first.particleEmitters,
      drawnEmitters: first.drawnEmitters,
      drawnSprites: first.drawnSprites,
      hitAreas: first.hitAreas,
      drawnActors: first.drawnActors,
      drawnBadges: first.drawnBadges,
    }).toStrictEqual({
      particleEmitters: '0',
      drawnEmitters: '0',
      drawnSprites: '0',
      hitAreas: '1',
      drawnActors: '1',
      // Its name tag and state badge, as any actor's (Story 3.8).
      drawnBadges: '1',
    });
    expect(await stateNow()).toBe('error');
    // Unmapped, the probe gets the state itself.
    await expect
      .poll(() => probeStates(since).map((line) => line.state))
      .toStrictEqual(['error']);

    /**
     * 起伏: read about ALPHA_GAP_MS apart, the opacity has moved (the
     * render loop runs), both within its range. Two times mirrored about
     * the top or the bottom of its wave give the same opacity, so the
     * second read is made again, STATE_POLL_MS on, until it differs.
     */
    async function expectRiseAndFall(): Promise<void> {
      const alphaNow = async (): Promise<string | undefined> =>
        (await overlayData()).placeholderAlpha;
      const one = await alphaNow();
      await pause(ALPHA_GAP_MS);
      let two: string | undefined;
      await expect
        .poll(
          async () => {
            two = await alphaNow();
            return two;
          },
          { intervals: [STATE_POLL_MS], timeout: DRAWN_TIMEOUT_MS },
        )
        .not.toBe(one);
      for (const alpha of [one, two]) {
        expect(alpha).toMatch(/^\d\.\d{3}$/);
        expect(Number(alpha)).toBeGreaterThanOrEqual(PLACEHOLDER_ALPHA_MIN);
        expect(Number(alpha)).toBeLessThanOrEqual(PLACEHOLDER_ALPHA_MAX);
      }
    }
    await expectRiseAndFall();

    // context 還原 (as bitmap.spec.ts does), the placeholder shown.
    const lost = windowsLine(
      'canvas WebGL context lost; nothing is drawn until it is restored',
    );
    const restored = windowsLine('canvas WebGL context restored after ');
    const reloaded = windowsLine('reloading the canvas page');
    const lostBefore = countLines(lost);
    const restoredBefore = countLines(restored);
    const reloadedBefore = countLines(reloaded);
    const errors: string[] = [];
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    };
    const onPageError = (error: Error): void => {
      errors.push(error.message);
    };
    overlay.on('console', onConsole);
    overlay.on('pageerror', onPageError);
    try {
      await loseOverlayContext(overlay);

      await expect
        .poll(() => countLines(lost), { timeout: DRAWN_TIMEOUT_MS })
        .toBe(lostBefore + 1);
      await expect.poll(async () => (await overlayData()).context).toBe('lost');
      const whileLost = await overlayData();
      expect([
        whileLost.drawnPlaceholders,
        whileLost.placeholderAlpha,
        whileLost.drawnActors,
        whileLost.hitAreas,
        whileLost.drawnBadges,
      ]).toStrictEqual(['0', 'none', '0', '0', '0']);

      await restoreOverlayContext(overlay);

      await expect
        .poll(() => countLines(restored), { timeout: DRAWN_TIMEOUT_MS })
        .toBe(restoredBefore + 1);
      await expect
        .poll(
          async () => {
            const data = await overlayData();
            return [
              data.context,
              data.drawnPlaceholders,
              data.hitAreas,
              data.drawnBadges,
            ];
          },
          { timeout: DRAWN_TIMEOUT_MS },
        )
        .toStrictEqual(['ok', '1', '1', '1']);
      expect(
        await stateNow(),
        `still error ${Date.now() - errorAt} ms after the error (errorHoldMs ${SETTINGS_DEFAULTS.errorHoldMs})`,
      ).toBe('error');
      // Not one frame drawn: the render loop runs again.
      await expectRiseAndFall();
    } finally {
      overlay.off('console', onConsole);
      overlay.off('pageerror', onPageError);
    }
    expect(errors).toStrictEqual([]);
    expect(countLines(reloaded)).toBe(reloadedBefore);
    expect([countLines(dropped), countLines(stageTrouble)]).toStrictEqual([
      droppedBefore,
      troubleBefore,
    ]);
  });

  test('加入與移出: a new turn ends the error (drawn by its pack again: sprites, no placeholder, placeholderAlpha none); then the session released, its actor leaves: the probe gets its despawn, nothing is drawn any more (no square or anything else, placeholderAlpha still none) and nothing takes the mouse', async () => {
    // A turn starting clears the error: thinking, drawn by the pack again.
    appendClaudeRecord(dirs.home, session, 'prompt');
    await expect.poll(stateNow, { timeout: DRAWN_TIMEOUT_MS }).toBe('thinking');
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [
            data.drawnPlaceholders,
            data.placeholderAlpha,
            data.drawnSprites !== '0',
          ];
        },
        { timeout: DRAWN_TIMEOUT_MS },
      )
      .toStrictEqual(['0', 'none', true]);

    const result = await panels.evaluate(
      (key) =>
        (globalThis as unknown as { awp: PanelsApi }).awp.pool.setReleased(
          key,
          true,
        ),
      session.sessionKey,
    );
    expect(result.ok).toBe(true);

    await expect
      .poll(async () => (await overlayData()).drawnActors, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('0');
    expect((await overlayData()).drawnSprites).toBe('0');
    expect((await overlayData()).hitAreas).toBe('0');
    expect((await overlayData()).placeholderAlpha).toBe('none');
    // Its name tag went with it (Story 3.8).
    expect((await overlayData()).drawnBadges).toBe('0');
    // The despawn came: the probe wrote it back.
    expect(await told('despawn')).toMatchObject({ type: 'despawn' });
  });
});
