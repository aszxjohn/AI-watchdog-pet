/**
 * The world tick and drawing (Story 3.6), in real Electron: the production
 * build (`.vite/`, from scripts/e2e-build.mjs) launched by Playwright's
 * `_electron` with a temporary HOME and userData. A synthetic Claude Code
 * session in that HOME gets a character of the stage probe pack: the
 * contract test pack under another id, its entry wrapped so that the
 * first message of each type it gets is written back with `stage.log`
 * (no other change: what it draws is the contract pack's). The tests read
 * the run log (what the pack got), the overlay's body data attributes
 * (what was drawn) and the panels' StageView. Nothing is read from the
 * screen, and nothing connects anywhere but the app itself.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { manifestSchema, type StageMessage } from '../../src/shared/pack-api';
import type { PanelsApi } from '../../src/shared/preload-api';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
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
  makeDirs,
  readRunLog,
  removeDirs,
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

/** How long the probe's sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** How long the first draw may take to show once the sandbox is ready. */
const DRAWN_TIMEOUT_MS = 20_000;

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
 * then hands the message on.
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
  return {
    init: pass('init'),
    spawn: pass('spawn'),
    despawn: pass('despawn'),
    params: pass('params'),
    meta: pass('meta'),
    frame: pass('frame'),
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
  return panels.evaluate(
    () =>
      new Promise<StageViewSnapshot>((resolve, reject) => {
        const { awp } = globalThis as unknown as { awp: PanelsApi };
        let done = false;
        let stop: (() => void) | undefined;
        const finish = (): void => {
          done = true;
          queueMicrotask(() => stop?.());
        };
        stop = awp.stageView.subscribe(
          (snapshot) => {
            if (!done) {
              finish();
              resolve(snapshot);
            }
          },
          (error) => {
            if (!done) {
              finish();
              reject(new Error(error.code));
            }
          },
        );
      }),
  );
}

/** The overlay body's data attributes. */
function overlayData(): Promise<Record<string, string | undefined>> {
  return overlay.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: { body: { dataset: Record<string, string | undefined> } };
    };
    return { ...document.body.dataset };
  });
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
    const mapped = character?.states.includes(actor.state)
      ? actor.state
      : character?.fallback?.[actor.state];
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

  test('加入與移出: the session released, its actor leaves: the probe gets its despawn, nothing is drawn any more (no square or anything else) and nothing takes the mouse', async () => {
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
    // The despawn came: the probe wrote it back.
    expect(await told('despawn')).toMatchObject({ type: 'despawn' });
  });
});
