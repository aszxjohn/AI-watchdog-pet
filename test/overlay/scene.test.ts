/**
 * overlay/renderer (Story 3.6): what is drawn each display frame
 * (buildScene: placing, mapping, the latest draws, clipping, order, the
 * areas that take the mouse), the missing-character log, and the texture
 * store with a fake backend.
 */
import { describe, expect, it, vi } from 'vitest';
import { packLook, type PackLook } from '../../src/overlay/looks';
import type {
  DrawnCommand,
  ParticlesCommand,
  SpriteCommand,
} from '../../src/overlay/pack-host/draw-rules';
import type { PackDraw } from '../../src/overlay/pack-host/host';
import { createMissingLog } from '../../src/overlay/renderer/missing-log';
import {
  buildScene,
  sceneSprite,
  sceneSprites,
  type SceneInput,
} from '../../src/overlay/renderer/scene';
import {
  createTextureStore,
  type TextureBackend,
} from '../../src/overlay/renderer/textures';
import { rowLayout } from '../../src/overlay/world/layout';
import {
  STAGE_ROW_BOTTOM_MARGIN,
  STAGE_ROW_GAP,
  STAGE_ROW_RIGHT_MARGIN,
} from '../../src/shared/constants';
import { manifestSchema, type PackManifest } from '../../src/shared/pack-api';
import type { StagePack } from '../../src/shared/packs';
import type { StageActor } from '../../src/shared/pool';
import type { PackLogEntry } from '../../src/shared/sandbox';
import type {
  StageCharacters,
  StageFixedParams,
  StageView,
} from '../../src/shared/stage-view';
import { contractManifest } from '../helpers/awpet';

const ALPHA = 'alpha-pack';
const BRAVO = 'bravo-pack';
const WORLD = { width: 1512, height: 982 };
const FEET = WORLD.height - STAGE_ROW_BOTTOM_MARGIN;

const SHEET = {
  image: 'img/probe-two-sheet.png',
  data: {
    frames: {
      'eyes-open': { frame: { x: 0, y: 0, w: 2, h: 2 } },
      'eyes-shut': { frame: { x: 2, y: 0, w: 2, h: 2 } },
    },
    meta: {
      image: 'probe-two-sheet.png',
      size: { w: 4, h: 2 },
      scale: 1 as const,
    },
  },
};

function manifestOf(packId: string, version: string): PackManifest {
  return manifestSchema.parse({ ...contractManifest(), id: packId, version });
}

function lookOf(packId: string, version = '1.0.0'): PackLook {
  return packLook(packId, version, manifestOf(packId, version), {
    'probe-two-sheet': SHEET,
  });
}

function stagePack(id: string, version = '1.0.0'): StagePack {
  return {
    id,
    name: id,
    version,
    apiVersion: '1.0',
    characters: [
      { id: 'probe-one', name: '甲', height: 110 },
      { id: 'probe-two', name: '乙', height: 96 },
    ],
    compatibility: { compatible: true },
  };
}

function fixed(scale: number): StageFixedParams {
  return {
    scale,
    inPool: true,
    badges: true,
    wander: {
      enabled: true,
      activity: 'medium',
      speed: 'medium',
      areas: [6, 7, 8],
    },
  };
}

function actor(
  actorId: string,
  characterKey: `${string}/${string}`,
  state: StageActor['state'] = 'working',
  sessionKey: StageActor['sessionKey'] = `claude-code:${actorId}`,
): StageActor {
  return {
    actorId,
    sessionKey,
    characterKey,
    state,
    confidence: 'exact',
    displayName: null,
  };
}

const SPRITE: SpriteCommand = {
  type: 'sprite',
  asset: 'probe-one-plain',
  x: -30,
  y: -110,
  scaleX: 30,
  scaleY: 55,
};

interface Setup {
  actors: StageActor[];
  characters?: StageCharacters;
  installed?: StagePack[];
  looks?: Record<string, PackLook>;
  draws?: Record<string, PackDraw>;
  canvas?: StageView['canvas'];
  /** Whether a texture is there; all are, by default. */
  ready?: SceneInput['ready'];
}

function input({
  actors,
  characters = {
    [`${ALPHA}/probe-one`]: { params: {}, fixed: fixed(1) },
    [`${ALPHA}/probe-two`]: { params: {}, fixed: fixed(0.9) },
    [`${BRAVO}/probe-one`]: { params: {}, fixed: fixed(1.5) },
  },
  installed = [stagePack(ALPHA), stagePack(BRAVO)],
  looks = { [ALPHA]: lookOf(ALPHA), [BRAVO]: lookOf(BRAVO) },
  draws = {},
  canvas = {
    displayId: 1,
    bounds: { x: 0, y: 0, ...WORLD },
    scaleFactor: 2,
    fallback: false,
  },
  ready = () => true,
}: Setup): SceneInput {
  return {
    view: { actors, characters, packs: { installed }, canvas },
    look: (packId) => looks[packId],
    draw: (packId) => draws[packId],
    ready,
  };
}

const SPARKLE: ParticlesCommand = {
  type: 'particles',
  emitterId: 'glow',
  preset: 'sparkle',
  x: 0,
  y: -120,
};

function drawOf(
  actors: Record<string, DrawnCommand[]>,
  version = '1.0.0',
): PackDraw {
  return { version, actors: new Map(Object.entries(actors)) };
}

describe('I/O matrix', () => {
  it('出現: an actor whose pack drew it stands at the bottom right, at its 大小, clipped to its bounds, with its sprites', () => {
    const scene = buildScene(
      input({
        actors: [actor('a1', `${ALPHA}/probe-one`)],
        draws: { [ALPHA]: drawOf({ a1: [SPRITE] }) },
      }),
    );

    const right = WORLD.width - STAGE_ROW_RIGHT_MARGIN;
    expect(scene.actors).toStrictEqual([
      {
        actorId: 'a1',
        sessionKey: 'claude-code:a1',
        packId: ALPHA,
        version: '1.0.0',
        x: right - 80 + 40,
        y: FEET,
        scale: 1,
        bounds: { x: -40, y: -130, width: 80, height: 130 },
        sprites: [
          {
            asset: 'probe-one-plain',
            frame: undefined,
            x: -30,
            y: -110,
            rotation: 0,
            scaleX: 30,
            scaleY: 55,
            alpha: 1,
          },
        ],
        emitters: [],
      },
    ]);
    expect(scene.missing).toStrictEqual(new Set());
  });

  it('加入與移出: an actor that left is not drawn; the others keep their place', () => {
    const draws = {
      [ALPHA]: drawOf({ a1: [SPRITE], a2: [SPRITE] }),
    };
    const both = buildScene(
      input({
        actors: [
          actor('a1', `${ALPHA}/probe-one`),
          actor('a2', `${ALPHA}/probe-one`),
        ],
        draws,
      }),
    );
    const one = buildScene(
      input({ actors: [actor('a1', `${ALPHA}/probe-one`)], draws }),
    );

    expect(both.actors.map((each) => each.actorId)).toStrictEqual(['a1', 'a2']);
    expect(one.actors.map((each) => each.actorId)).toStrictEqual(['a1']);
    expect(one.actors[0]?.x).toBe(
      both.actors.find((each) => each.actorId === 'a1')?.x,
    );
  });

  it('狀態對應不到: an actor whose state is in neither states nor fallback is not drawn and takes no mouse (its slot stays)', () => {
    const draws = { [ALPHA]: drawOf({ a1: [SPRITE], a2: [SPRITE] }) };
    const scene = buildScene(
      input({
        actors: [
          actor('a1', `${ALPHA}/probe-one`, 'approval'),
          actor('a2', `${ALPHA}/probe-one`, 'done'),
        ],
        draws,
      }),
    );

    expect(scene.actors.map((each) => each.actorId)).toStrictEqual(['a2']);
    expect(scene.areas.map((area) => area.key)).toStrictEqual([
      'claude-code:a2',
    ]);
    // a2 is in the second slot: a1's stays empty.
    expect(scene.actors[0]?.x).toBe(
      WORLD.width - STAGE_ROW_RIGHT_MARGIN - 80 - STAGE_ROW_GAP - 80 + 40,
    );
  });

  it('大小與排序: each actor takes its bounds width × 大小, 大小 scales it, and they are drawn by y (lower on top)', () => {
    const scene = buildScene(
      input({
        actors: [
          actor('a1', `${ALPHA}/probe-one`),
          actor('a2', `${ALPHA}/probe-two`),
          actor('b1', `${BRAVO}/probe-one`),
        ],
        draws: {
          [ALPHA]: drawOf({ a1: [SPRITE], a2: [] }),
          [BRAVO]: drawOf({ b1: [SPRITE] }),
        },
      }),
    );
    const placed = rowLayout(WORLD, [
      { key: 'a1', bounds: { x: -40, width: 80 }, scale: 1 },
      { key: 'a2', bounds: { x: -40, width: 80 }, scale: 0.9 },
      { key: 'b1', bounds: { x: -40, width: 80 }, scale: 1.5 },
    ]);

    expect(
      scene.actors.map(({ actorId, x, y, scale }) => [actorId, x, y, scale]),
    ).toStrictEqual(
      ['a1', 'a2', 'b1'].map((id) => [
        id,
        placed.get(id)?.x,
        placed.get(id)?.y,
        { a1: 1, a2: 0.9, b1: 1.5 }[id],
      ]),
    );
  });

  it('大小與排序: actors are drawn by y, lower on top (and so take the mouse first), ties keeping StageView’s order', () => {
    const ys: Record<string, number> = { a1: 500, a2: 400, a3: 500, a4: 450 };
    const scene = buildScene({
      ...input({
        actors: ['a1', 'a2', 'a3', 'a4'].map((id) =>
          actor(id, `${ALPHA}/probe-one`),
        ),
        draws: {
          [ALPHA]: drawOf({
            a1: [SPRITE],
            a2: [SPRITE],
            a3: [SPRITE],
            a4: [SPRITE],
          }),
        },
      }),
      place: (_world, members) =>
        new Map(
          members.map((member) => [
            member.key,
            { x: 100, y: ys[member.key] ?? 0 },
          ]),
        ),
    });

    expect(scene.actors.map((each) => each.actorId)).toStrictEqual([
      'a2',
      'a4',
      'a1',
      'a3',
    ]);
    expect(scene.areas.map((area) => area.key)).toStrictEqual([
      'claude-code:a2',
      'claude-code:a4',
      'claude-code:a1',
      'claude-code:a3',
    ]);
  });

  it('裁切: each drawn actor carries its manifest bounds (its clip), in its own local coordinates, scaled with it', () => {
    const scene = buildScene(
      input({
        actors: [actor('b1', `${BRAVO}/probe-one`)],
        draws: { [BRAVO]: drawOf({ b1: [{ ...SPRITE, x: -500, y: -900 }] }) },
      }),
    );
    expect(scene.actors[0]).toMatchObject({
      scale: 1.5,
      bounds: { x: -40, y: -130, width: 80, height: 130 },
      sprites: [{ x: -500, y: -900 }],
    });
  });

  it('spritesheet: a sprite keeps its frame name; z orders the sprites (ties keep the pack’s order) and left-out fields take their defaults', () => {
    const framed: SpriteCommand = {
      type: 'sprite',
      asset: 'probe-two-sheet',
      frame: 'eyes-shut',
      x: -25,
      y: -96,
      z: 2,
    };
    const sprites = sceneSprites([
      framed,
      { ...SPRITE, z: -1 },
      { ...SPRITE, alpha: 0.5, rotation: 0.1, scaleX: -1 },
    ]);
    expect(sprites).toStrictEqual([
      sceneSprite({ ...SPRITE, z: -1 }),
      sceneSprite({ ...SPRITE, alpha: 0.5, rotation: 0.1, scaleX: -1 }),
      sceneSprite(framed),
    ]);
    expect(sprites[2]).toStrictEqual({
      asset: 'probe-two-sheet',
      frame: 'eyes-shut',
      x: -25,
      y: -96,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
    });
  });

  it('漏回: an actor its pack’s latest draw leaves out is not drawn, and takes no mouse; one with an empty list is there with no sprite, and takes no mouse either', () => {
    const scene = buildScene(
      input({
        actors: [
          actor('a1', `${ALPHA}/probe-one`),
          actor('a2', `${ALPHA}/probe-one`),
          actor('a3', `${ALPHA}/probe-one`),
        ],
        draws: { [ALPHA]: drawOf({ a1: [SPRITE], a3: [] }) },
      }),
    );
    expect(
      scene.actors.map((each) => [each.actorId, each.sprites.length]),
    ).toStrictEqual([
      ['a1', 1],
      ['a3', 0],
    ]);
    expect(scene.areas.map((area) => area.key)).toStrictEqual([
      'claude-code:a1',
    ]);
  });

  it.each<[string, (asset: string, frame: string | undefined) => boolean]>([
    ['still loading or failed (no texture for any)', () => false],
    [
      'loaded for one of its sprites only',
      (asset) => asset === 'probe-one-dots',
    ],
  ])(
    '滑鼠: an actor whose sprites’ textures are %s takes the mouse only with a sprite on screen',
    (label, has) => {
      const scene = buildScene(
        input({
          actors: [actor('a1', `${ALPHA}/probe-one`)],
          draws: {
            [ALPHA]: drawOf({
              a1: [SPRITE, { ...SPRITE, asset: 'probe-one-dots' }],
            }),
          },
          ready: (packId, version, asset, frame) => {
            expect([packId, version]).toStrictEqual([ALPHA, '1.0.0']);
            return has(asset, frame);
          },
        }),
      );

      expect(scene.actors.map((each) => each.actorId)).toStrictEqual(['a1']);
      expect(scene.areas.map((area) => area.key)).toStrictEqual(
        label.startsWith('loaded') ? ['claude-code:a1'] : [],
      );
    },
  );

  it('滑鼠: a spritesheet sprite takes the mouse once its frame’s texture is there', () => {
    const asked: unknown[][] = [];
    buildScene(
      input({
        actors: [actor('a2', `${ALPHA}/probe-two`)],
        draws: {
          [ALPHA]: drawOf({
            a2: [
              {
                type: 'sprite',
                asset: 'probe-two-sheet',
                frame: 'eyes-shut',
                x: 0,
                y: 0,
              },
            ],
          }),
        },
        ready: (...args) => {
          asked.push(args);
          return true;
        },
      }),
    );
    expect(asked).toStrictEqual([
      [ALPHA, '1.0.0', 'probe-two-sheet', 'eyes-shut'],
    ]);
  });

  it('漏回: no draw yet, or a draw by another version than the one installed, draws nothing of the pack', () => {
    const actors = [actor('a1', `${ALPHA}/probe-one`)];
    expect(buildScene(input({ actors })).actors).toStrictEqual([]);
    expect(
      buildScene(
        input({
          actors,
          draws: { [ALPHA]: drawOf({ a1: [SPRITE] }, '0.9.0') },
        }),
      ).actors,
    ).toStrictEqual([]);
  });

  it('找不到: an actor whose character is not in characters, or not in its manifest, is not drawn and its pack is reported missing; one of a pack not installed is skipped (pack-host logs that)', () => {
    const draws = {
      [ALPHA]: drawOf({ a1: [SPRITE], a2: [SPRITE], a3: [SPRITE] }),
    };
    const scene = buildScene(
      input({
        actors: [
          actor('a1', `${ALPHA}/probe-one`),
          actor('a2', `${ALPHA}/gone-character`),
          actor('b1', `${BRAVO}/probe-two`),
          actor('c1', 'charlie-pack/probe-one'),
        ],
        characters: {
          [`${ALPHA}/gone-character`]: { params: {}, fixed: fixed(1) },
          [`${ALPHA}/probe-one`]: { params: {}, fixed: fixed(1) },
        },
        draws,
      }),
    );

    expect(scene.actors.map((each) => each.actorId)).toStrictEqual(['a1']);
    expect(scene.missing).toStrictEqual(new Set([ALPHA, BRAVO]));
  });

  it('滑鼠: each drawn actor takes the mouse over its hitbox × 大小 at its place, named by its session; the one on top last', () => {
    const scene = buildScene(
      input({
        actors: [actor('b1', `${BRAVO}/probe-one`)],
        draws: { [BRAVO]: drawOf({ b1: [SPRITE] }) },
      }),
    );
    const [drawn] = scene.actors;
    expect(scene.areas).toStrictEqual([
      {
        key: 'claude-code:b1',
        x: (drawn?.x ?? 0) - 30 * 1.5,
        y: (drawn?.y ?? 0) - 110 * 1.5,
        width: 60 * 1.5,
        height: 110 * 1.5,
      },
    ]);
  });

  it('示範方塊: the demo session’s actor is drawn like any other, and nothing else is: no square', () => {
    const scene = buildScene(
      input({
        actors: [actor('d1', `${ALPHA}/probe-two`, 'waiting', 'demo:1')],
        draws: {
          [ALPHA]: drawOf({
            d1: [
              {
                type: 'sprite',
                asset: 'probe-two-sheet',
                frame: 'eyes-open',
                x: -25,
                y: -96,
              },
            ],
          }),
        },
      }),
    );
    expect(scene.actors).toHaveLength(1);
    expect(scene.actors[0]).toMatchObject({
      sessionKey: 'demo:1',
      scale: 0.9,
      sprites: [{ asset: 'probe-two-sheet', frame: 'eyes-open' }],
    });
    expect(scene.areas.map((area) => area.key)).toStrictEqual(['demo:1']);
    // No demo session's actor, nothing at all.
    expect(buildScene(input({ actors: [] }))).toMatchObject({
      actors: [],
      areas: [],
    });
  });

  it('粒子出現: a drawn actor carries its particles commands as its emitters, in the pack’s order; its sprites are as without them', () => {
    const smoke: ParticlesCommand = {
      ...SPARKLE,
      emitterId: 'puff',
      preset: 'smoke',
      params: { rate: 2 },
    };
    const scene = buildScene(
      input({
        actors: [actor('a1', `${ALPHA}/probe-one`)],
        draws: { [ALPHA]: drawOf({ a1: [SPARKLE, SPRITE, smoke] }) },
      }),
    );
    const plain = buildScene(
      input({
        actors: [actor('a1', `${ALPHA}/probe-one`)],
        draws: { [ALPHA]: drawOf({ a1: [SPRITE] }) },
      }),
    );

    expect(scene.actors[0]?.emitters).toStrictEqual([SPARKLE, smoke]);
    expect(scene.actors[0]?.sprites).toStrictEqual(plain.actors[0]?.sprites);
    expect(plain.actors[0]?.emitters).toStrictEqual([]);
  });

  it('hit area: an actor with only particles takes no mouse; particles do not change the area of an actor with a sprite', () => {
    const actors = [
      actor('a1', `${ALPHA}/probe-one`),
      actor('a2', `${ALPHA}/probe-one`),
    ];
    const scene = buildScene(
      input({
        actors,
        draws: {
          [ALPHA]: drawOf({
            a1: [SPARKLE],
            a2: [SPRITE, { ...SPARKLE, x: 200, y: -400 }],
          }),
        },
      }),
    );
    const plain = buildScene(
      input({
        actors,
        draws: { [ALPHA]: drawOf({ a1: [], a2: [SPRITE] }) },
      }),
    );

    expect(scene.actors.map((each) => each.actorId)).toStrictEqual([
      'a1',
      'a2',
    ]);
    expect(scene.areas).toStrictEqual(plain.areas);
    expect(scene.areas.map((area) => area.key)).toStrictEqual([
      'claude-code:a2',
    ]);
  });

  it('no canvas placed yet: nothing is drawn', () => {
    expect(
      buildScene(
        input({
          actors: [actor('a1', `${ALPHA}/probe-one`)],
          draws: { [ALPHA]: drawOf({ a1: [SPRITE] }) },
          canvas: null,
        }),
      ).actors,
    ).toStrictEqual([]);
  });
});

describe('I/O matrix', () => {
  it('找不到: logs a pack once while it stays missing, and again only after it was gone from the list', () => {
    const logs: PackLogEntry[] = [];
    const report = createMissingLog((entry) => {
      logs.push(entry);
    });

    report(new Set([ALPHA]));
    report(new Set([ALPHA, BRAVO]));
    report(new Set([ALPHA, BRAVO]));
    report(new Set([BRAVO]));
    report(new Set([ALPHA]));

    expect(logs).toStrictEqual([
      { kind: 'not-drawn', packId: ALPHA, reason: 'character-missing' },
      { kind: 'not-drawn', packId: BRAVO, reason: 'character-missing' },
      { kind: 'not-drawn', packId: ALPHA, reason: 'character-missing' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The texture store.

interface FakeImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

interface FakeTexture {
  readonly of: string;
  destroyed: boolean | 'base';
}

function fakeBackend(sizes: Record<string, [number, number]> = {}) {
  const loads: string[] = [];
  const pending = new Map<
    string,
    { resolve: () => void; reject: () => void }
  >();
  const made: FakeTexture[] = [];
  const backend: TextureBackend<FakeImage, FakeTexture> = {
    loadImage: (url) => {
      loads.push(url);
      return new Promise((resolve, reject) => {
        const [width, height] = sizes[url] ?? [4, 2];
        pending.set(url, {
          resolve: () => resolve({ url, width, height }),
          reject: () => reject(new Error('404')),
        });
      });
    },
    sizeOf: (image) => ({ width: image.width, height: image.height }),
    imageTexture: (image) => {
      const texture = { of: image.url, destroyed: false as boolean | 'base' };
      made.push(texture);
      return texture;
    },
    sheetTextures: (texture, sheet) =>
      new Map(
        Object.keys(sheet.frames).map((name) => {
          const frame = {
            of: `${texture.of}#${name}`,
            destroyed: false as boolean | 'base',
          };
          made.push(frame);
          return [name, frame];
        }),
      ),
    destroy: (texture, base) => {
      texture.destroyed = base ? 'base' : true;
    },
  };
  async function finish(url: string, ok = true): Promise<void> {
    const load = pending.get(url);
    if (ok) {
      load?.resolve();
    } else {
      load?.reject();
    }
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }
  async function finishAll(): Promise<void> {
    for (const url of pending.keys()) {
      await finish(url);
    }
  }
  return { backend, loads, made, finish, finishAll };
}

describe('I/O matrix', () => {
  const URL_ONE = `pack://${ALPHA}/1.0.0/img/probe-one-plain.png`;
  const URL_SHEET = `pack://${ALPHA}/1.0.0/img/probe-two-sheet.png`;

  it('素材快取: every asset of a version is loaded once, from its versioned pack:// URL, however many frames use it', async () => {
    const fake = fakeBackend();
    const store = createTextureStore({ backend: fake.backend });
    const look = lookOf(ALPHA);

    store.sync([look]);
    expect(
      store.get(ALPHA, '1.0.0', 'probe-one-plain', undefined),
    ).toBeUndefined();
    await fake.finishAll();
    for (let frame = 0; frame < 100; frame += 1) {
      store.sync([look]);
      expect(store.get(ALPHA, '1.0.0', 'probe-one-plain', undefined)?.of).toBe(
        URL_ONE,
      );
    }

    expect([...fake.loads].sort()).toStrictEqual(
      [
        URL_ONE,
        `pack://${ALPHA}/1.0.0/img/probe-one-dots.png`,
        URL_SHEET,
        `pack://${ALPHA}/1.0.0/img/spark.png`,
      ].sort(),
    );
  });

  it('素材快取: a new version is loaded from its own URLs and the old one released (its textures destroyed)', async () => {
    const fake = fakeBackend();
    const store = createTextureStore({ backend: fake.backend });
    store.sync([lookOf(ALPHA)]);
    await fake.finishAll();
    const old = store.get(ALPHA, '1.0.0', 'probe-one-plain', undefined);

    store.sync([lookOf(ALPHA, '1.1.0')]);
    await fake.finishAll();

    expect(old?.destroyed).toBe('base');
    expect(
      store.get(ALPHA, '1.0.0', 'probe-one-plain', undefined),
    ).toBeUndefined();
    expect(store.get(ALPHA, '1.1.0', 'probe-one-plain', undefined)?.of).toBe(
      `pack://${ALPHA}/1.1.0/img/probe-one-plain.png`,
    );
    expect(store.size()).toBe(1);
  });

  it('素材快取: a pack removed releases its textures; a load still on its way is thrown away when it arrives', async () => {
    const fake = fakeBackend();
    const store = createTextureStore({ backend: fake.backend });
    store.sync([lookOf(ALPHA)]);
    await fake.finish(URL_ONE);

    store.sync([]);
    await fake.finishAll();

    expect(store.size()).toBe(0);
    expect(fake.made.map((texture) => texture.destroyed)).toStrictEqual([
      'base',
    ]);
  });

  it('spritesheet: its frames by name; no frame (or a frame of an image) gives nothing; two packs’ frames of one name are their own', async () => {
    const fake = fakeBackend();
    const store = createTextureStore({ backend: fake.backend });
    store.sync([lookOf(ALPHA), lookOf(BRAVO)]);
    await fake.finishAll();

    const alpha = store.get(ALPHA, '1.0.0', 'probe-two-sheet', 'eyes-open');
    const bravo = store.get(BRAVO, '1.0.0', 'probe-two-sheet', 'eyes-open');
    expect(alpha?.of).toBe(`${URL_SHEET}#eyes-open`);
    expect(bravo?.of).toBe(
      `pack://${BRAVO}/1.0.0/img/probe-two-sheet.png#eyes-open`,
    );
    expect(alpha).not.toBe(bravo);
    expect(
      store.get(ALPHA, '1.0.0', 'probe-two-sheet', undefined),
    ).toBeUndefined();
    expect(
      store.get(ALPHA, '1.0.0', 'probe-two-sheet', 'nope'),
    ).toBeUndefined();
    expect(
      store.get(ALPHA, '1.0.0', 'probe-one-plain', 'eyes-open'),
    ).toBeUndefined();

    // Releasing ALPHA destroys its frames and its sheet; BRAVO's stay.
    store.sync([lookOf(BRAVO)]);
    expect(alpha?.destroyed).toBe(true);
    expect(bravo?.destroyed).toBe(false);
  });

  it('an image that does not load, or a sheet with a frame outside its image, fails once: no texture, onFailed names the pack and asset', async () => {
    const fake = fakeBackend({ [URL_SHEET]: [3, 2] });
    const onFailed = vi.fn();
    const store = createTextureStore({
      backend: fake.backend,
      onFailed,
      logError: () => {},
    });
    store.sync([lookOf(ALPHA)]);

    await fake.finish(URL_ONE, false);
    await fake.finishAll();
    store.sync([lookOf(ALPHA)]);

    expect(
      store.get(ALPHA, '1.0.0', 'probe-one-plain', undefined),
    ).toBeUndefined();
    expect(
      store.get(ALPHA, '1.0.0', 'probe-two-sheet', 'eyes-open'),
    ).toBeUndefined();
    expect(onFailed.mock.calls.sort()).toStrictEqual(
      [
        [ALPHA, 'probe-one-plain'],
        [ALPHA, 'probe-two-sheet'],
      ].sort(),
    );
    // Only the two other images have textures; the failed ones made none.
    expect(
      fake.made.filter((texture) => texture.destroyed === false),
    ).toHaveLength(2);
  });
});
