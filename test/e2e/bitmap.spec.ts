/**
 * Bitmaps (Story 3.6's last part), in real Electron: the production build
 * (`.vite/`, from scripts/e2e-build.mjs) launched by Playwright's
 * `_electron` with a temporary HOME and userData. Two synthetic Claude Code
 * sessions in that HOME get one actor each of the bitmap probe pack: the
 * contract test pack under another id, its probe-one with
 * `advancedBitmap`, and an entry of its own (bitmapProbeEntry):
 * - probe-one's actor draws only a bitmap, painted on `stage.canvas` and
 *   taken with `stage.snapshot` every frame (a new image each frame), its
 *   canvas made larger halfway;
 * - probe-two's actor (no `advancedBitmap`) draws only a sparkle emitter;
 * - along the way the probe tries what a pack may not do and writes the
 *   outcomes back with `stage.log`, and at set frames it puts a bitmap on
 *   probe-two's actor once (bitmap-not-allowed) and sends one image again
 *   (draw-not-cloneable);
 * - at other set frames, once each, it checks the Worker's rules that the
 *   stage sends a copy of plain data (no drop comes of these): a second
 *   `stage.snapshot` in one frame, `stage.fire`, `stage.hold` and
 *   `stage.face` with an image in their arguments, a bitmap command whose
 *   `image` is a getter giving another image at each later read, and an
 *   image whose prototype was changed.
 * - once, with the bitmap shown, the overlay canvas's WebGL context is
 *   lost and restored with the page's own WebGL API (as
 *   stability.spec.ts does).
 * The tests read the run log (what the pack saw), the overlay's body
 * data attributes (what was drawn and what takes the mouse) and, around
 * the context loss, the overlay page's console errors; nothing is read
 * from the screen (no screenshot, no pixel), and nothing connects
 * anywhere but the app itself.
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
import { BITMAP_MAX_SIDE } from '../../src/shared/constants';
import { manifestSchema } from '../../src/shared/pack-api';
import type { PanelsApi } from '../../src/shared/preload-api';
import {
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import {
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

/** The bitmap probe pack's id: no character or series name. */
const BITMAP_PACK_ID = 'bitmap-probe';

/** The character with `advancedBitmap`. */
const BITMAP_CHARACTER = 'probe-one';

/** The character without it. */
const PLAIN_CHARACTER = 'probe-two';

/** What starts each `stage.log` line the probe writes. */
const TELL_PREFIX = 'awp-bitmap ';

/** How long the probe's sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** How long a draw, or a line the probe writes, may take to show. */
const DRAWN_TIMEOUT_MS = 20_000;

/**
 * The bitmap actor's frames (counted from 1) at which the probe does
 * something once: puts its bitmap on probe-two's actor (STUFF_AT), sends
 * the previous frame's image again (RESEND_AT; the image taken in that
 * frame is kept, not sent), and from the frame after RESIZE_AT on paints a
 * canvas of RESIZED instead of FIRST_SIZE; it says so RESIZED_FOR frames
 * later. Each of these sends its image in that frame's draw as usual and
 * says what came of it the frame after: calls `stage.snapshot` a second
 * time (SNAPSHOT_TWICE_AT); calls `stage.fire`, `stage.hold` and
 * `stage.face` with the image (STAGE_CALLS_AT); gives the image kept at
 * RESEND_AT by a getter that gives this frame's image at each later read
 * (GETTER_AT); changes the image's prototype to Object.prototype
 * (PROTOTYPE_AT). All before RESIZE_AT, so each image is FIRST_SIZE.
 */
const SNAPSHOT_TWICE_AT = 10;
const STAGE_CALLS_AT = 15;
const STUFF_AT = 30;
const RESEND_AT = 45;
const GETTER_AT = 50;
const PROTOTYPE_AT = 55;
const RESIZE_AT = 60;
const RESIZED_FOR = 30;
const FIRST_SIZE = { width: 32, height: 32 } as const;
const RESIZED = { width: 48, height: 24 } as const;

/** The contract pack's manifest under the probe's id, probe-one with advancedBitmap. */
const MANIFEST = (() => {
  const contract = manifestSchema.parse(contractManifest());
  return manifestSchema.parse({
    ...contract,
    id: BITMAP_PACK_ID,
    name: 'Bitmap probe',
    characters: contract.characters.map((character) =>
      character.id === BITMAP_CHARACTER
        ? { ...character, advancedBitmap: true }
        : character,
    ),
  });
})();

/**
 * The probe's entry: a classic script whose value is the factory (see the
 * file comment). Each report is written once, as `awp-bitmap <kind>
 * <JSON>` (ASCII only); a handful of lines, well within what `stage.log`
 * allows. ASCII only, no `import(`, `eval(` or `require(`, so the import
 * check takes it.
 */
function bitmapProbeEntry(): string {
  return `(function (stage) {
  'use strict';
  var TELL = ${JSON.stringify(TELL_PREFIX)};
  var BITMAP_CHARACTER = ${JSON.stringify(BITMAP_CHARACTER)};
  var MAX_SIDE = ${BITMAP_MAX_SIDE};
  var characters = {};
  var frames = {};
  var last = {};
  var once = {};
  var told = {};
  // Writes make()'s report of kind once.
  function tell(kind, make) {
    if (told[kind]) { return; }
    told[kind] = true;
    stage.log(TELL + kind + ' ' + JSON.stringify(make()));
  }
  function errorName(error) {
    try { return String(error && error.name); } catch (ignored) { return 'unreadable'; }
  }
  // What run() comes to: returned:<its type> or threw:<error name>.
  function outcome(run) {
    try {
      var value = run();
      return 'returned:' + (value === null ? 'null' : typeof value);
    } catch (error) {
      return 'threw:' + errorName(error);
    }
  }
  // What run() returns, as a string, or threw:<error name>.
  function read(run) {
    try { return String(run()); } catch (error) { return 'threw:' + errorName(error); }
  }
  function sizeOf(image) { return image.width + 'x' + image.height; }
  // Whether value is a canvas or the OffscreenCanvas constructor.
  function isCanvas(value) {
    try {
      if (typeof value === 'function') { return value.name === 'OffscreenCanvas'; }
      if (typeof value === 'object' && value !== null) {
        return typeof value.getContext === 'function' ||
          (typeof value.constructor === 'function' && value.constructor.name === 'OffscreenCanvas');
      }
    } catch (ignored) {}
    return false;
  }
  // What a 2d context leads to: every name on its prototype chain, every
  // getter's value for it and every other value, checked for a canvas.
  function reach(context) {
    var found = [];
    var getters = 0;
    var depth = 0;
    for (var o = context; o !== null && depth < 16; o = Object.getPrototypeOf(o)) {
      depth += 1;
      var names = Object.getOwnPropertyNames(o);
      for (var i = 0; i < names.length; i += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(o, names[i]);
        var value;
        if (names[i] === 'canvas') { found.push('name:canvas'); }
        if (typeof descriptor.get === 'function') {
          getters += 1;
          try { value = descriptor.get.call(context); } catch (ignored) { value = undefined; }
        } else {
          value = descriptor.value;
        }
        if (isCanvas(value)) { found.push(names[i]); }
      }
    }
    return {
      canvas: typeof context.canvas,
      canvasIn: 'canvas' in context,
      found: found,
      getters: getters,
      global: read(function () { return typeof OffscreenCanvas; }),
      webgl: outcome(function () { return context.canvas.getContext('webgl'); }),
      webgl2: outcome(function () { return new OffscreenCanvas(1, 1).getContext('webgl2'); }),
      construct: outcome(function () { return new context.constructor(1, 1); })
    };
  }
  // stage.canvas and stage.snapshot with wrong arguments, before the
  // actor has a canvas; then the largest size, which is taken.
  function args(actorId) {
    return {
      snapshotFirst: outcome(function () { return stage.snapshot(actorId); }),
      notOwn: outcome(function () { return stage.canvas('no-such-actor', 8, 8); }),
      zero: outcome(function () { return stage.canvas(actorId, 0, 8); }),
      tooWide: outcome(function () { return stage.canvas(actorId, MAX_SIDE + 1, 8); }),
      tooHigh: outcome(function () { return stage.canvas(actorId, 8, MAX_SIDE + 1); }),
      fraction: outcome(function () { return stage.canvas(actorId, 8.5, 8); }),
      largest: outcome(function () { return stage.canvas(actorId, MAX_SIDE, MAX_SIDE); })
    };
  }
  // stage.canvas and stage.snapshot for an actor without advancedBitmap.
  function undeclared(actorId) {
    var typeError = false;
    try { stage.canvas(actorId, 8, 8); } catch (error) { typeError = error instanceof TypeError; }
    return {
      canvas: outcome(function () { return stage.canvas(actorId, 8, 8); }),
      typeError: typeError,
      snapshot: outcome(function () { return stage.snapshot(actorId); })
    };
  }
  function bitmapCommand(image, size) {
    return { type: 'bitmap', image: image, x: -size.width / 2, y: -size.height, width: size.width, height: size.height };
  }
  // A bitmap command whose image is a getter: the first read gives first,
  // each later one other; it counts its reads.
  function gotten(first, other, size, reads) {
    var command = bitmapCommand(first, size);
    Object.defineProperty(command, 'image', {
      enumerable: true,
      configurable: true,
      get: function () { reads.count += 1; return reads.count === 1 ? first : other; }
    });
    return command;
  }
  // The size of image by the getters of its prototype now, read later
  // whatever its prototype is then.
  function sizeLater(image) {
    var prototype = Object.getPrototypeOf(image);
    var width = Object.getOwnPropertyDescriptor(prototype, 'width').get;
    var height = Object.getOwnPropertyDescriptor(prototype, 'height').get;
    return function () { return width.call(image) + 'x' + height.call(image); };
  }
  function drawBitmap(actorId, plainActor, draw) {
    var n = (frames[actorId] || 0) + 1;
    frames[actorId] = n;
    if (n === 1) { tell('args', function () { return args(actorId); }); }
    var size = n > ${RESIZE_AT} ? ${JSON.stringify(RESIZED)} : ${JSON.stringify(FIRST_SIZE)};
    var context = stage.canvas(actorId, size.width, size.height);
    if (n === 1) { tell('reach', function () { return reach(context); }); }
    var previous = last[actorId];
    if (n === ${RESEND_AT + 1}) { tell('after-resend', function () { return { frame: n }; }); }
    context.fillStyle = n % 2 === 0 ? '#2f6fd0' : '#d0702f';
    context.fillRect(0, 0, size.width, size.height);
    var image = stage.snapshot(actorId);
    if (n === ${RESEND_AT}) {
      // This frame's image is kept for GETTER_AT; the previous one goes.
      once.held = image;
      tell('resend', function () { return { frame: n, previous: sizeOf(previous) }; });
      draw[actorId] = [bitmapCommand(previous, size)];
      return;
    }
    if (n === 2) { tell('transfer', function () { return { sent: sizeOf(previous), fresh: sizeOf(image) }; }); }
    last[actorId] = image;
    if (n === ${SNAPSHOT_TWICE_AT}) {
      once.twice = {
        first: image,
        second: outcome(function () { return stage.snapshot(actorId); })
      };
    }
    if (n === ${SNAPSHOT_TWICE_AT + 1}) {
      tell('snapshot-twice', function () {
        return { frame: n - 1, second: once.twice.second, first: sizeOf(once.twice.first), next: sizeOf(image) };
      });
    }
    if (n === ${STAGE_CALLS_AT}) {
      once.calls = {
        fire: outcome(function () { return stage.fire(actorId, { target: actorId, object: image }); }),
        hold: outcome(function () { return stage.hold(actorId, image); }),
        face: outcome(function () { return stage.face(actorId, image); }),
        kept: sizeOf(image),
        image: image
      };
    }
    if (n === ${STAGE_CALLS_AT + 1}) {
      tell('stage-calls', function () {
        var calls = once.calls;
        return { frame: n - 1, fire: calls.fire, hold: calls.hold, face: calls.face, kept: calls.kept, sent: sizeOf(calls.image) };
      });
    }
    if (n === ${GETTER_AT}) {
      once.getter = { reads: { count: 0 }, sent: once.held, unread: image };
      draw[actorId] = [gotten(once.held, image, size, once.getter.reads)];
      return;
    }
    if (n === ${GETTER_AT + 1}) {
      tell('getter', function () {
        var getter = once.getter;
        return { frame: n - 1, reads: getter.reads.count, sent: sizeOf(getter.sent), unread: sizeOf(getter.unread) };
      });
    }
    if (n === ${PROTOTYPE_AT}) {
      var sizeOfImage = sizeLater(image);
      var changed = Reflect.setPrototypeOf(image, Object.prototype);
      once.prototype = { changed: changed, width: typeof image.width, size: sizeOfImage };
    }
    if (n === ${PROTOTYPE_AT + 1}) {
      tell('prototype', function () {
        var reshaped = once.prototype;
        return { frame: n - 1, changed: reshaped.changed, width: reshaped.width, sent: reshaped.size() };
      });
    }
    if (n === ${STUFF_AT} && plainActor !== undefined) {
      tell('stuffed', function () { return { frame: n }; });
      draw[plainActor] = [bitmapCommand(image, size)];
      return;
    }
    draw[actorId] = [bitmapCommand(image, size)];
    if (n === ${RESIZE_AT + RESIZED_FOR}) {
      tell('resized', function () { return { frame: n, fresh: sizeOf(image) }; });
    }
  }
  function remember(actor) { characters[actor.actorId] = actor.characterId; }
  return {
    init: function (message) {
      characters = {};
      for (var i = 0; i < message.actors.length; i += 1) {
        if (message.actors[i].own) { remember(message.actors[i]); }
      }
    },
    spawn: function (message) { remember(message); },
    despawn: function (message) { delete characters[message.actorId]; },
    params: function () {},
    meta: function () {},
    frame: function (message) {
      var draw = {};
      var bitmapActor;
      var plainActor;
      for (var i = 0; i < message.actors.length; i += 1) {
        var actorId = message.actors[i].actorId;
        draw[actorId] = [];
        if (characters[actorId] === BITMAP_CHARACTER) {
          bitmapActor = actorId;
        } else if (characters[actorId] !== undefined) {
          plainActor = actorId;
        }
      }
      if (plainActor !== undefined) {
        tell('undeclared', function () { return undeclared(plainActor); });
        draw[plainActor] = [{ type: 'particles', emitterId: 'only', preset: 'sparkle', x: 0, y: -40 }];
      }
      if (bitmapActor !== undefined) {
        drawBitmap(bitmapActor, plainActor, draw);
      }
      return draw;
    }
  };
})
`;
}

/** Writes the probe pack to `<dir>/bitmap-probe.awpet`. */
async function writeBitmapProbe(dir: string): Promise<string> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  files.set('manifest.json', manifestBytes(MANIFEST));
  files.set(MANIFEST.entry, bitmapProbeEntry());
  const file = path.join(dir, `${BITMAP_PACK_ID}.awpet`);
  fs.writeFileSync(file, await zipBuffer(itemsOf(files, BITMAP_PACK_ID)));
  return file;
}

/** A run log line of the probe starting with `text` (after `pack <id>: `). */
function bitmapLine(text: string): (line: RunLogLine) => boolean {
  const prefix = `pack ${BITMAP_PACK_ID}: ${text}`;
  return (line) => line.category === 'packs' && line.message.startsWith(prefix);
}

/** Whether `line` says the probe's sandbox failed or was never made. */
function bitmapTrouble(line: RunLogLine): boolean {
  return (
    bitmapLine('sandbox failed')(line) ||
    bitmapLine('has an actor but gets no sandbox')(line)
  );
}

/** A run log line of main/windows that starts with `message`. */
function windowsLine(message: string): (line: RunLogLine) => boolean {
  return (line) =>
    line.category === 'windows' && line.message.startsWith(message);
}

/** How many run log lines `match` takes now. */
function countLines(match: (line: RunLogLine) => boolean): number {
  return readRunLog(dirs.logs).filter(match).length;
}

/** The run log line of a drop of the probe's messages for `reason`. */
function dropLine(reason: string): (line: RunLogLine) => boolean {
  const match = bitmapLine('dropped ');
  return (line) => match(line) && line.message.endsWith(`(${reason})`);
}

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let sessions: readonly SyntheticSession[];
let app: ElectronApplication;
let overlay: Page;
let panels: Page;
let readyLine: RunLogLine;

test.beforeAll(async () => {
  test.setTimeout(
    LAUNCH_TIMEOUT_MS + READY_TIMEOUT_MS + 2 * WINDOW_TIMEOUT_MS + 30_000,
  );
  dirs = makeDirs();
  sessions = [writeClaudeSession(dirs.home), writeClaudeSession(dirs.home)];
  app = await launchStage(dirs, await writeBitmapProbe(dirs.root));
  readyLine = await waitForLine(
    dirs.logs,
    bitmapLine('sandbox ready'),
    READY_TIMEOUT_MS,
    bitmapTrouble,
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
        path.join(test.info().project.outputDir, 'bitmap-run-log'),
        { recursive: true },
      );
    }
    removeDirs(dirs);
  }
});

/** The report of `kind` the probe wrote back, parsed. */
async function told(kind: string): Promise<Record<string, unknown>> {
  const prefix = `pack ${BITMAP_PACK_ID}: stage.log: ${TELL_PREFIX}${kind} `;
  const line = await waitForLine(
    dirs.logs,
    (each) => each.category === 'packs' && each.message.startsWith(prefix),
    DRAWN_TIMEOUT_MS,
    bitmapTrouble,
  );
  return JSON.parse(line.message.slice(prefix.length)) as Record<
    string,
    unknown
  >;
}

/** The overlay's body data attributes. */
function overlayData(): Promise<Record<string, string | undefined>> {
  return readOverlayData(overlay);
}

/** The actor of `characterId` in StageView now, once there is one. */
async function actorOf(characterId: string) {
  const key = `${BITMAP_PACK_ID}/${characterId}`;
  await expect
    .poll(
      async () =>
        (await readStageView(panels)).view.actors.some(
          (actor) => actor.characterKey === key,
        ),
      { timeout: DRAWN_TIMEOUT_MS },
    )
    .toBe(true);
  const { view } = await readStageView(panels);
  const actor = view.actors.find((each) => each.characterKey === key);
  if (actor === undefined) {
    throw new Error(`no actor of ${key}`);
  }
  return actor;
}

test.describe('I/O matrix', () => {
  test("bitmap 出現: the two sessions get one actor of each character; probe-one's actor, drawing only a bitmap painted on stage.canvas and taken with stage.snapshot, has it drawn (and no sprite)", async () => {
    // The premise: only probe-one has advancedBitmap.
    expect(
      MANIFEST.characters.map((character) => [
        character.id,
        character.advancedBitmap === true,
      ]),
    ).toStrictEqual([
      [BITMAP_CHARACTER, true],
      [PLAIN_CHARACTER, false],
    ]);
    const bitmapActor = await actorOf(BITMAP_CHARACTER);
    const plainActor = await actorOf(PLAIN_CHARACTER);
    expect(
      [bitmapActor.sessionKey, plainActor.sessionKey].sort(),
    ).toStrictEqual(sessions.map((session) => session.sessionKey).sort());

    await expect
      .poll(async () => (await overlayData()).drawnBitmaps, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    expect((await overlayData()).drawnSprites).toBe('0');
  });

  test("hit area: the actor with only a bitmap takes the mouse once its texture is up (drawnBitmaps and hitAreas both above 0); probe-two's actor, with only particles, does not", async () => {
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [data.drawnBitmaps, data.drawnEmitters, data.hitAreas];
        },
        { timeout: DRAWN_TIMEOUT_MS },
      )
      .toStrictEqual(['1', '1', '1']);
    const data = await overlayData();
    expect(Number(data.drawnBitmaps)).toBeGreaterThan(0);
    expect(Number(data.hitAreas)).toBeGreaterThan(0);
    // No sprite anywhere, so the one area is the bitmap's, and the
    // particles-only actor has none.
    expect(data.drawnSprites).toBe('0');
  });

  test("transfer: once its draw is sent, the probe's ImageBitmap is 0x0 in the Worker (it was the canvas's size before)", async () => {
    expect(await told('transfer')).toStrictEqual({
      sent: '0x0',
      fresh: `${FIRST_SIZE.width}x${FIRST_SIZE.height}`,
    });
  });

  test('位元組: draws with an ImageBitmap pass the byte check (none dropped as too large or invalid)', async () => {
    await expect
      .poll(async () => (await overlayData()).drawnBitmaps, {
        timeout: DRAWN_TIMEOUT_MS,
      })
      .toBe('1');
    expect(
      readRunLog(dirs.logs).filter(
        (line) => dropLine('too-large')(line) || dropLine('invalid')(line),
      ),
    ).toStrictEqual([]);
  });

  test('只允許 2d: the context has no canvas, nothing on its prototype chain leads to an OffscreenCanvas, and webgl cannot be opened; the Worker wrote nothing to the console up to the end of lockdown', async () => {
    const reach = await told('reach');
    expect(reach.canvas).toBe('undefined');
    expect(reach.canvasIn).toBe(false);
    expect(reach.found).toStrictEqual([]);
    // The premise: the walk did read the context's getters.
    expect(reach.getters).toBeGreaterThan(10);
    expect(reach.global).toMatch(/^(?:undefined|threw:ReferenceError)$/);
    expect(reach.webgl).toMatch(/^threw:/);
    expect(reach.webgl2).toMatch(/^threw:/);
    expect(reach.construct).toBe('threw:TypeError');
    expect(readyLine.message).toMatch(
      / console 0 lines up to the end of lockdown\)$/,
    );
  });

  test("沒宣告的角色: stage.canvas throws a TypeError for probe-two's actor; a bitmap put on that actor drops its whole draw (bitmap-not-allowed), once", async () => {
    expect(await told('undeclared')).toStrictEqual({
      canvas: 'threw:TypeError',
      typeError: true,
      snapshot: 'threw:TypeError',
    });
    expect(await told('stuffed')).toStrictEqual({ frame: STUFF_AT });
    const line = await waitForLine(
      dirs.logs,
      dropLine('bitmap-not-allowed'),
      DRAWN_TIMEOUT_MS,
      bitmapTrouble,
    );
    expect(line.message).toBe(
      `pack ${BITMAP_PACK_ID}: dropped 1 message from its sandbox (bitmap-not-allowed)`,
    );
  });

  test(`參數不對: stage.canvas for an actor not the pack's, with a side of 0, ${BITMAP_MAX_SIDE + 1} or not whole, and stage.snapshot before stage.canvas throw a TypeError; a side of ${BITMAP_MAX_SIDE} is taken`, async () => {
    expect(await told('args')).toStrictEqual({
      snapshotFirst: 'threw:TypeError',
      notOwn: 'threw:TypeError',
      zero: 'threw:TypeError',
      tooWide: 'threw:TypeError',
      tooHigh: 'threw:TypeError',
      fraction: 'threw:TypeError',
      largest: 'returned:object',
    });
  });

  test("重複送: the previous frame's image sent again: that frame gets no draw (draw-not-cloneable), once, and the next frame comes as before", async () => {
    expect(await told('resend')).toStrictEqual({
      frame: RESEND_AT,
      previous: '0x0',
    });
    await waitForLine(
      dirs.logs,
      dropLine('draw-not-cloneable'),
      DRAWN_TIMEOUT_MS,
      bitmapTrouble,
    );
    expect(await told('after-resend')).toStrictEqual({ frame: RESEND_AT + 1 });
    expect(
      readRunLog(dirs.logs)
        .filter(dropLine('draw-not-cloneable'))
        .map((line) => line.message),
    ).toStrictEqual([
      `pack ${BITMAP_PACK_ID}: dropped 1 message from its sandbox (draw-not-cloneable)`,
    ]);
  });

  test('snapshot 次數: in the real Worker, a second stage.snapshot for the same actor in one frame throws a TypeError; the first image goes out in that frame as usual (0x0 after), and the next frame takes a new one', async () => {
    expect(await told('snapshot-twice')).toStrictEqual({
      frame: SNAPSHOT_TWICE_AT,
      second: 'threw:TypeError',
      first: '0x0',
      next: `${FIRST_SIZE.width}x${FIRST_SIZE.height}`,
    });
  });

  test("stage.* 帶圖: stage.fire, stage.hold and stage.face with an ImageBitmap in their arguments throw a TypeError at the call and send nothing: the image is still the pack's (its size) after, and goes out in that frame's draw as usual (0x0 after)", async () => {
    expect(await told('stage-calls')).toStrictEqual({
      frame: STAGE_CALLS_AT,
      fire: 'threw:TypeError',
      hold: 'threw:TypeError',
      face: 'threw:TypeError',
      kept: `${FIRST_SIZE.width}x${FIRST_SIZE.height}`,
      sent: '0x0',
    });
  });

  test('藏圖的寫法: a bitmap command whose image is a getter (one image at the first read, another at each later one) is read once: the first image is sent and transferred (0x0 in the Worker), the other is never sent (still its size)', async () => {
    expect(await told('getter')).toStrictEqual({
      frame: GETTER_AT,
      reads: 1,
      sent: '0x0',
      unread: `${FIRST_SIZE.width}x${FIRST_SIZE.height}`,
    });
  });

  test('藏圖的寫法: an image whose prototype was changed to Object.prototype (so it has no width of its own to read) is still told an ImageBitmap and transferred: 0x0 in the Worker, read with the width and height getters kept from before', async () => {
    expect(await told('prototype')).toStrictEqual({
      frame: PROTOTYPE_AT,
      changed: true,
      width: 'undefined',
      sent: '0x0',
    });
  });

  test('釋放: after its canvas changed size (and a new image every frame), the bitmap is still drawn and takes the mouse; the only drops are the two the probe asked for', async () => {
    expect(await told('resized')).toStrictEqual({
      frame: RESIZE_AT + RESIZED_FOR,
      fresh: `${RESIZED.width}x${RESIZED.height}`,
    });
    // Over about a second (some 30 images replaced): drawn every time.
    for (let sample = 0; sample < 5; sample += 1) {
      const data = await overlayData();
      expect([data.drawnBitmaps, data.hitAreas]).toStrictEqual(['1', '1']);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The once-only checks add no drop: the overlay took the draws of
    // SNAPSHOT_TWICE_AT, STAGE_CALLS_AT, GETTER_AT and PROTOTYPE_AT (a
    // drop of one would be the first of its reason, logged at once), and
    // the stage.* calls sent nothing. (One the Worker did not send would
    // share the resend's line, but would leave its image its size, which
    // the tests above see.)
    expect(
      readRunLog(dirs.logs)
        .filter(bitmapLine('dropped '))
        .map((line) => line.message)
        .sort(),
    ).toStrictEqual(
      [
        `pack ${BITMAP_PACK_ID}: dropped 1 message from its sandbox (bitmap-not-allowed)`,
        `pack ${BITMAP_PACK_ID}: dropped 1 message from its sandbox (draw-not-cloneable)`,
      ].sort(),
    );
    expect(
      readRunLog(dirs.logs).filter(
        (line) => bitmapLine('not drawn')(line) || bitmapTrouble(line),
      ),
    ).toStrictEqual([]);
  });

  test('context 還原: with the bitmap shown, the WebGL context lost and restored: while lost nothing is drawn; once restored the bitmap is drawn again and takes the mouse (drawnBitmaps and hitAreas back to 1); the overlay logs no error in between, and nothing is dropped or reloaded', async () => {
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [data.context, data.drawnBitmaps, data.hitAreas];
        },
        { timeout: DRAWN_TIMEOUT_MS },
      )
      .toStrictEqual(['ok', '1', '1']);
    const lost = windowsLine(
      'canvas WebGL context lost; nothing is drawn until it is restored',
    );
    const restored = windowsLine('canvas WebGL context restored after ');
    const reloaded = windowsLine('reloading the canvas page');
    const lostBefore = countLines(lost);
    const restoredBefore = countLines(restored);
    const reloadedBefore = countLines(reloaded);
    const packLines = (): string[] =>
      readRunLog(dirs.logs)
        .filter(
          (line) =>
            bitmapLine('dropped ')(line) ||
            bitmapLine('not drawn')(line) ||
            bitmapTrouble(line),
        )
        .map((line) => line.message);
    const packLinesBefore = packLines();
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
      expect([whileLost.drawnBitmaps, whileLost.hitAreas]).toStrictEqual([
        '0',
        '0',
      ]);

      await restoreOverlayContext(overlay);

      await expect
        .poll(() => countLines(restored), { timeout: DRAWN_TIMEOUT_MS })
        .toBe(restoredBefore + 1);
      await expect
        .poll(
          async () => {
            const data = await overlayData();
            return [data.context, data.drawnBitmaps, data.hitAreas];
          },
          { timeout: DRAWN_TIMEOUT_MS },
        )
        .toStrictEqual(['ok', '1', '1']);
      // Over about a second (some 30 new images, each uploaded to the
      // restored context): drawn every time.
      for (let sample = 0; sample < 5; sample += 1) {
        const data = await overlayData();
        expect([data.drawnBitmaps, data.hitAreas]).toStrictEqual(['1', '1']);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      overlay.off('console', onConsole);
      overlay.off('pageerror', onPageError);
    }
    expect(errors).toStrictEqual([]);
    expect(countLines(reloaded)).toBe(reloadedBefore);
    expect(packLines()).toStrictEqual(packLinesBefore);
  });

  test("釋放: probe-one's session released, its actor leaves: its bitmap is gone and nothing takes the mouse (probe-two's particles-only actor still drawn)", async () => {
    const bitmapActor = await actorOf(BITMAP_CHARACTER);
    const result = await panels.evaluate(
      (key) =>
        (globalThis as unknown as { awp: PanelsApi }).awp.pool.setReleased(
          key,
          true,
        ),
      bitmapActor.sessionKey,
    );
    expect(result.ok).toBe(true);
    await expect
      .poll(
        async () => {
          const data = await overlayData();
          return [data.drawnBitmaps, data.hitAreas];
        },
        { timeout: DRAWN_TIMEOUT_MS },
      )
      .toStrictEqual(['0', '0']);
    const data = await overlayData();
    expect([data.drawnActors, data.drawnEmitters]).toStrictEqual(['1', '1']);
  });
});
