/**
 * overlay/looks (Story 3.6): each pack's manifest and spritesheets at the
 * version installed, asked for once it has an actor, kept per version and
 * released when that version goes; a failure logged once.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLooks, packLook } from '../../src/overlay/looks';
import type { IpcResult } from '../../src/shared/ipc';
import { manifestSchema } from '../../src/shared/pack-api';
import type { PackManifestResult, StagePack } from '../../src/shared/packs';
import type { StageActor } from '../../src/shared/pool';
import type { PackLogEntry } from '../../src/shared/sandbox';
import type { StageView } from '../../src/shared/stage-view';
import { contractManifest } from '../helpers/awpet';

const PACK = 'alpha-pack';
const MANIFEST = manifestSchema.parse({
  ...contractManifest(),
  id: PACK,
});
const SHEET = {
  image: 'img/probe-two-sheet.png',
  data: {
    frames: {
      'eyes-open': { frame: { x: 0, y: 0, w: 2, h: 2 } },
      'eyes-shut': { frame: { x: 2, y: 0, w: 2, h: 2 } },
    },
    meta: { image: 'probe-two-sheet.png' },
  },
};

function stagePack(version = '1.0.0', compatible = true): StagePack {
  return {
    id: PACK,
    name: PACK,
    version,
    apiVersion: '1.0',
    characters: [{ id: 'probe-one', name: '甲', height: 110 }],
    compatibility: compatible
      ? { compatible: true }
      : { compatible: false, reason: 'pack-newer', required: '1.9' },
  };
}

function view(
  withActor: boolean,
  installed: readonly StagePack[] = [stagePack()],
): Pick<StageView, 'actors' | 'packs'> {
  const actors: StageActor[] = withActor
    ? [
        {
          actorId: 'a1',
          sessionKey: 'demo:1',
          characterKey: `${PACK}/probe-one`,
          state: 'working',
          confidence: 'exact',
          displayName: null,
        },
      ]
    : [];
  return { actors, packs: { installed: [...installed] } };
}

function setup(
  answer: (packId: string, version: string) => IpcResult<PackManifestResult> = (
    packId,
    version,
  ) => ({
    ok: true,
    data: {
      ok: true,
      packId,
      version,
      manifest: { ...MANIFEST, version },
      spritesheets: { 'probe-two-sheet': SHEET },
    },
  }),
) {
  const asked: string[][] = [];
  const logs: PackLogEntry[] = [];
  const looks = createLooks({
    api: {
      getManifest: vi.fn(async (packId: string, version: string) => {
        asked.push([packId, version]);
        return answer(packId, version);
      }),
    },
    log: (entry) => {
      logs.push(entry);
    },
    logError: () => {},
  });
  return { looks, asked, logs };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('createLooks', () => {
  it("asks for a pack's look once it has an actor, once per version, and keeps it", async () => {
    const t = setup();
    t.looks.onView(view(false));
    expect(t.asked).toStrictEqual([]);

    t.looks.onView(view(true));
    t.looks.onView(view(true));
    expect(t.looks.get(PACK)).toBeUndefined();
    await settle();

    const look = t.looks.get(PACK);
    expect(look?.version).toBe('1.0.0');
    expect(look?.character('probe-one')?.bounds).toStrictEqual({
      x: -40,
      y: -130,
      width: 80,
      height: 130,
    });
    expect(look?.character('nobody')).toBeUndefined();
    expect([...(look?.frames('probe-two-sheet') ?? [])]).toStrictEqual([
      'eyes-open',
      'eyes-shut',
    ]);
    expect(look?.frames('probe-one-plain')).toBeUndefined();
    // Kept with no actor any more.
    t.looks.onView(view(false));
    expect(t.looks.get(PACK)).toBe(look);
    expect(t.asked).toStrictEqual([[PACK, '1.0.0']]);
  });

  it('a pack removed or no longer fitting the stage releases its look; an answer for a released version is thrown away', async () => {
    const t = setup();
    t.looks.onView(view(true));
    await settle();
    t.looks.onView(view(true, []));
    expect(t.looks.get(PACK)).toBeUndefined();

    t.looks.onView(view(true, [stagePack('1.0.0', false)]));
    expect(t.looks.get(PACK)).toBeUndefined();

    t.looks.onView(view(true));
    t.looks.onView(view(true, []));
    await settle();
    expect(t.looks.get(PACK)).toBeUndefined();
  });

  it('an answer for another pack or version than asked is not taken', async () => {
    const t = setup((packId) => ({
      ok: true,
      data: {
        ok: true,
        packId,
        version: '9.9.9',
        manifest: MANIFEST,
        spritesheets: {},
      },
    }));
    t.looks.onView(view(true));
    await settle();

    expect(t.looks.get(PACK)).toBeUndefined();
    expect(t.logs).toHaveLength(1);
  });

  it('packLook gives the characters by id and the frames of each spritesheet', () => {
    const look = packLook(PACK, '1.0.0', MANIFEST, {
      'probe-two-sheet': SHEET,
    });
    expect(look.character('probe-two')?.states).toStrictEqual([
      'working',
      'done',
      'error',
    ]);
    expect(look.frames('probe-two-sheet')?.has('eyes-shut')).toBe(true);
  });
});

describe('I/O matrix', () => {
  it('素材快取: another version installed releases the old look and asks for the new one', async () => {
    const t = setup();
    t.looks.onView(view(true));
    await settle();

    t.looks.onView(view(true, [stagePack('1.1.0')]));
    expect(t.looks.get(PACK)).toBeUndefined();
    await settle();

    expect(t.looks.get(PACK)?.version).toBe('1.1.0');
    expect(t.asked).toStrictEqual([
      [PACK, '1.0.0'],
      [PACK, '1.1.0'],
    ]);
  });

  it.each<[string, IpcResult<PackManifestResult>]>([
    [
      'main says why not',
      { ok: true, data: { ok: false, code: 'read-failed' } },
    ],
    [
      'the call fails',
      { ok: false, error: { code: 'invoke-failed', message: 'x' } },
    ],
  ])(
    '找不到: when %s, one not-drawn line names the pack; it is asked for again only once its actors have left',
    async (_label, answer) => {
      const t = setup(() => answer);
      t.looks.onView(view(true));
      await settle();
      t.looks.onView(view(true));
      await settle();

      expect(t.looks.get(PACK)).toBeUndefined();
      expect(t.logs).toStrictEqual([
        { kind: 'not-drawn', packId: PACK, reason: 'manifest-unavailable' },
      ]);
      expect(t.asked).toHaveLength(1);

      t.looks.onView(view(false));
      t.looks.onView(view(true));
      expect(t.asked).toHaveLength(2);
    },
  );
});
