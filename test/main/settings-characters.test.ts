/**
 * main/settings' characters (Story 3.6, AD-23): each installed character's
 * effective parameters and fixed parameters, as StageView's `characters`
 * section. First on fake settings, packs and manifest reader; then wired
 * as main.ts wires it, with the contract test pack really installed,
 * replaced and removed in a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { readInstalledManifest } from '../../src/main/packs/manifest';
import { removePack } from '../../src/main/packs/remove';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import { createCharacters } from '../../src/main/settings/characters';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { manifestSchema, type PackManifest } from '../../src/shared/pack-api';
import type {
  InstalledManifestResult,
  StagePack,
} from '../../src/shared/packs';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
  type SettingsValues,
} from '../../src/shared/settings';
import {
  stageCharactersSchema,
  stageViewDeltaSchema,
  type StageViewDelta,
  type StageViewPacksSections,
} from '../../src/shared/stage-view';
import {
  CONTRACT_PACK_ID,
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const ONE = `${CONTRACT_PACK_ID}/probe-one`;
const TWO = `${CONTRACT_PACK_ID}/probe-two`;

/** The stage's fixed parameter defaults, as plain values. */
const STAGE_FIXED = {
  scale: 1,
  inPool: true,
  badges: true,
  wander: {
    enabled: true,
    areas: [6, 7, 8],
    activity: 'medium',
    speed: 'medium',
  },
};

/** The contract pack's two characters, with nothing overridden. */
const CONTRACT_CHARACTERS = {
  [ONE]: {
    params: { glow: true, bob: 2, skin: 'probe-one-plain' },
    fixed: STAGE_FIXED,
  },
  [TWO]: {
    params: { 'blink-every': 3, mood: 'calm' },
    fixed: {
      ...STAGE_FIXED,
      scale: 0.9,
      wander: { ...STAGE_FIXED.wander, speed: 'slow' },
    },
  },
};

type RawManifest = Record<string, unknown> & {
  characters: Record<string, unknown>[];
};

/** The contract manifest, changed by `change`, checked. */
function manifestWith(change: (raw: RawManifest) => void = () => {}) {
  const raw = contractManifest() as RawManifest;
  change(raw);
  return manifestSchema.parse(raw);
}

/** A pack as main/packs' store lists it, for `manifest`. */
function stagePackOf(
  manifest: PackManifest,
  compatibility: StagePack['compatibility'] = { compatible: true },
): StagePack {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    characters: manifest.characters.map(({ id, name, height }) => ({
      id,
      name,
      height,
    })),
    compatibility,
  };
}

/** main/settings with only what the characters read; set() notifies. */
function fakeSettings(initial: Partial<SettingsValues> = {}) {
  let state: SettingsState = {
    rev: 0,
    values: { ...SETTINGS_DEFAULTS, ...initial },
  };
  const listeners = new Set<(next: SettingsState) => void>();
  return {
    get: () => state,
    onChange(listener: (next: SettingsState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(changed: Partial<SettingsValues>) {
      state = { rev: state.rev + 1, values: { ...state.values, ...changed } };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

/** main/packs' store: the installed packs, sorted by id. */
function fakePacks(initial: readonly StagePack[]) {
  const sorted = (list: readonly StagePack[]) =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let sections: StageViewPacksSections = {
    packs: { installed: sorted(initial) },
  };
  const listeners = new Set<(next: StageViewPacksSections) => void>();
  return {
    get: () => sections,
    onChange(listener: (next: StageViewPacksSections) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(installed: readonly StagePack[]) {
      sections = { packs: { installed: sorted(installed) } };
      for (const listener of listeners) {
        listener(sections);
      }
    },
  };
}

/**
 * main/packs' manifest reader over `manifests` (by `<id>@<version>`; a
 * missing one is unreadable). `calls` records each read; set() changes
 * what a version reads as (the same version installed again).
 */
function fakeReader(manifests: readonly PackManifest[]) {
  const table = new Map<string, InstalledManifestResult>(
    manifests.map((manifest) => [
      `${manifest.id}@${manifest.version}`,
      { ok: true, manifest },
    ]),
  );
  const calls: string[] = [];
  return {
    calls,
    set(packId: string, version: string, result: InstalledManifestResult) {
      table.set(`${packId}@${version}`, result);
    },
    read(packId: string, version: string): InstalledManifestResult {
      calls.push(`${packId}@${version}`);
      return (
        table.get(`${packId}@${version}`) ?? {
          ok: false,
          code: 'unreadable',
          detail: 'ENOENT',
        }
      );
    },
  };
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith('[settings] '));
}

/** The characters source on fakes, watching, with what it told. */
function wire({
  installed = [manifestWith()],
  readable = installed,
  settings: initial = {},
  watch = true,
}: {
  installed?: readonly PackManifest[];
  readable?: readonly PackManifest[];
  settings?: Partial<SettingsValues>;
  watch?: boolean;
} = {}) {
  const settings = fakeSettings(initial);
  const packs = fakePacks(installed.map((manifest) => stagePackOf(manifest)));
  const reader = fakeReader(readable);
  const characters = createCharacters({
    settings,
    packs,
    readManifest: (packId, version) => reader.read(packId, version),
  });
  const heard: unknown[] = [];
  characters.onChange((sections) => {
    heard.push(sections.characters);
  });
  if (watch) {
    characters.watch();
  }
  return { settings, packs, reader, characters, heard };
}

describe('the characters source', () => {
  it('starts with every character of every installed pack that fits, keys sorted, whether or not it is 上場 or in the pool', () => {
    const another = manifestWith((raw) => {
      raw.id = 'another-pack';
    });
    const { characters } = wire({
      installed: [manifestWith(), another],
      settings: {
        packEnabled: { [CONTRACT_PACK_ID]: false },
        fixedOverrides: { [ONE]: { inPool: false } },
      },
    });

    const section = characters.get().characters;
    expect(Object.keys(section)).toStrictEqual([
      'another-pack/probe-one',
      'another-pack/probe-two',
      ONE,
      TWO,
    ]);
    expect(stageCharactersSchema.safeParse(section).success).toBe(true);
    expect(section[ONE]?.fixed.inPool).toBe(false);
  });

  it('is empty with no pack installed', () => {
    const { characters } = wire({ installed: [] });
    expect(characters.get()).toStrictEqual({ characters: {} });
  });

  it('hands out frozen values', () => {
    const { characters } = wire();
    const section = characters.get().characters;
    const one = section[ONE];

    expect(Object.isFrozen(section)).toBe(true);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one?.params)).toBe(true);
    expect(Object.isFrozen(one?.fixed.wander.areas)).toBe(true);
  });

  it('reads the manifests once at start, and again on every packs change, not on a settings change', () => {
    const { settings, packs, reader } = wire();
    expect(reader.calls).toStrictEqual([`${CONTRACT_PACK_ID}@1.0.0`]);

    settings.set({ fixedOverrides: { [TWO]: { inPool: false } } });
    expect(reader.calls).toHaveLength(1);

    packs.update(packs.get().packs.installed);
    expect(reader.calls).toStrictEqual([
      `${CONTRACT_PACK_ID}@1.0.0`,
      `${CONTRACT_PACK_ID}@1.0.0`,
    ]);
  });

  it('tells nothing when a change leaves the section as it was: a setting it does not read, or the packs listed again', () => {
    const { settings, packs, heard } = wire();

    settings.set({ canvasDisplayId: 5, doneMs: 2000 });
    settings.set({ packEnabled: { [CONTRACT_PACK_ID]: false } });
    packs.update(packs.get().packs.installed);

    expect(heard).toStrictEqual([]);
    expect(
      lines(info).filter((line) => line.includes('changed')),
    ).toStrictEqual([]);
  });

  it('follows nothing until watch(); watch() first catches up with what changed since creation, then follows settings and packs; a second watch() changes nothing', () => {
    const { settings, packs, reader, characters, heard } = wire({
      watch: false,
    });

    settings.set({ fixedOverrides: { [ONE]: { inPool: false } } });
    packs.update([]);
    expect(heard).toStrictEqual([]);
    expect(characters.get()).toStrictEqual({ characters: CONTRACT_CHARACTERS });

    characters.watch();
    expect(heard).toStrictEqual([{}]);
    expect(characters.get()).toStrictEqual({ characters: {} });

    characters.watch();
    packs.update([stagePackOf(manifestWith())]);

    // Heard once more (one subscription), with the values caught up.
    expect(heard).toHaveLength(2);
    expect(characters.get().characters[ONE]?.fixed.inPool).toBe(false);
    expect(characters.get().characters[TWO]?.fixed.inPool).toBe(true);
    expect(reader.calls).toStrictEqual([
      `${CONTRACT_PACK_ID}@1.0.0`,
      `${CONTRACT_PACK_ID}@1.0.0`,
    ]);
  });

  it('watch() reads no manifest again when the installed packs did not change since creation', () => {
    const { reader, characters, heard } = wire({ watch: false });

    characters.watch();

    expect(reader.calls).toStrictEqual([`${CONTRACT_PACK_ID}@1.0.0`]);
    expect(heard).toStrictEqual([]);
  });

  it('sorts the keys even when a manifest lists its characters out of id order; the schema takes the section', () => {
    const { characters } = wire({
      installed: [
        manifestWith((raw) => {
          raw.characters.reverse();
        }),
      ],
    });

    const section = characters.get().characters;
    expect(Object.keys(section)).toStrictEqual([ONE, TWO]);
    expect(stageCharactersSchema.safeParse(section).success).toBe(true);
  });

  it('sorts the keys by the whole key: pack mech-two comes before pack mech (`-` sorts before `/`)', () => {
    const mech = manifestWith((raw) => {
      raw.id = 'mech';
    });
    const mechTwo = manifestWith((raw) => {
      raw.id = 'mech-two';
    });
    const { characters } = wire({ installed: [mech, mechTwo] });

    const section = characters.get().characters;
    expect(Object.keys(section)).toStrictEqual([
      'mech-two/probe-one',
      'mech-two/probe-two',
      'mech/probe-one',
      'mech/probe-two',
    ]);
    expect(stageCharactersSchema.safeParse(section).success).toBe(true);
  });

  it('leaves out, with one line, a pack whose manifest read throws; the others stay', () => {
    const another = manifestWith((raw) => {
      raw.id = 'another-pack';
    });
    const settings = fakeSettings();
    const packs = fakePacks([
      stagePackOf(manifestWith()),
      stagePackOf(another),
    ]);
    const characters = createCharacters({
      settings,
      packs,
      readManifest: (packId) => {
        if (packId === 'another-pack') {
          throw Object.assign(new Error('boom'), { code: 'EIO' });
        }
        return { ok: true, manifest: manifestWith() };
      },
    });

    expect(Object.keys(characters.get().characters)).toStrictEqual([ONE, TWO]);
    expect(lines(error)).toStrictEqual([
      '[settings] pack another-pack: left out of characters (manifest read failed: EIO)',
    ]);
  });

  it('survives a listener that throws; the others still hear', () => {
    const { settings, characters } = wire();
    const later = vi.fn();
    characters.onChange(() => {
      throw new Error('listener bug');
    });
    characters.onChange(later);

    settings.set({ fixedOverrides: { [ONE]: { inPool: false } } });

    expect(later).toHaveBeenCalledOnce();
    expect(lines(error)).toContain(
      '[settings] a change listener failed (Error)',
    );
  });

  it('stops telling a listener once unsubscribed', () => {
    const { settings, characters } = wire();
    const listener = vi.fn();
    const stop = characters.onChange(listener);
    stop();

    settings.set({ fixedOverrides: { [ONE]: { inPool: false } } });

    expect(listener).not.toHaveBeenCalled();
  });

  it('logs counts and pack ids only, never a character or a value', () => {
    const { settings } = wire();
    settings.set({ fixedOverrides: { [ONE]: { inPool: false } } });

    expect(lines(info)).toStrictEqual([
      '[settings] characters: 2 characters of 1 pack',
      '[settings] characters changed: 2 characters of 1 pack',
    ]);
    expect(lines(info).join('\n')).not.toMatch(/probe|glow|calm|inPool/);
  });
});

describe('I/O matrix', () => {
  it('包預設: an installed pack that fits, with no override: each character has exactly its declared keys, each with its default', () => {
    const { characters } = wire();
    const section = characters.get().characters;

    expect(section[ONE]?.params).toStrictEqual({
      glow: true,
      bob: 2,
      skin: 'probe-one-plain',
    });
    expect(section[TWO]?.params).toStrictEqual({
      'blink-every': 3,
      mood: 'calm',
    });
    expect(characters.get()).toStrictEqual({ characters: CONTRACT_CHARACTERS });
  });

  it('固定參數預設: a character with no defaults: scale 1, inPool on, badges on, the stage wander', () => {
    const { characters } = wire();
    expect(characters.get().characters[ONE]?.fixed).toStrictEqual(STAGE_FIXED);
  });

  it('manifest 預設: defaults.scale 1.5 and a wander giving only areas: scale 1.5, areas from the manifest, the other wander fields from the stage', () => {
    const { characters } = wire({
      installed: [
        manifestWith((raw) => {
          raw.characters[0]!.defaults = {
            scale: 1.5,
            wander: { areas: [0, 1] },
          };
        }),
      ],
    });

    expect(characters.get().characters[ONE]?.fixed).toStrictEqual({
      ...STAGE_FIXED,
      scale: 1.5,
      wander: { ...STAGE_FIXED.wander, areas: [0, 1] },
    });
  });

  it('加入池子覆蓋: inPool false in fixedOverrides turns that character’s inPool off; its other fixed parameters, and the other character, stay', () => {
    const { settings, characters, heard } = wire();

    settings.set({ fixedOverrides: { [TWO]: { inPool: false } } });

    expect(heard).toStrictEqual([
      {
        ...CONTRACT_CHARACTERS,
        [TWO]: {
          ...CONTRACT_CHARACTERS[TWO],
          fixed: { ...CONTRACT_CHARACTERS[TWO].fixed, inPool: false },
        },
      },
    ]);
    expect(characters.get().characters[ONE]).toStrictEqual(
      CONTRACT_CHARACTERS[ONE],
    );
  });

  it('參數與固定分開: a declared parameter keyed scale stays among the parameters; the fixed scale follows its own rule', () => {
    const { characters } = wire({
      installed: [
        manifestWith((raw) => {
          raw.characters[0]!.params = [
            {
              key: 'scale',
              label: '縮放',
              type: 'int',
              min: 1,
              max: 9,
              default: 4,
            },
          ];
        }),
      ],
    });

    expect(characters.get().characters[ONE]).toStrictEqual({
      params: { scale: 4 },
      fixed: STAGE_FIXED,
    });
  });

  it('換版本: another version that declares other parameters: the characters follow its manifest', () => {
    const { packs, reader, characters, heard } = wire();
    const next = manifestWith((raw) => {
      raw.version = '1.1.0';
      raw.characters[1]!.params = [
        { key: 'shy', label: '害羞', type: 'bool', default: false },
      ];
      delete raw.characters[1]!.defaults;
    });
    reader.set(CONTRACT_PACK_ID, '1.1.0', { ok: true, manifest: next });

    packs.update([stagePackOf(next)]);

    expect(reader.calls.at(-1)).toBe(`${CONTRACT_PACK_ID}@1.1.0`);
    expect(characters.get().characters[TWO]).toStrictEqual({
      params: { shy: false },
      fixed: STAGE_FIXED,
    });
    expect(heard).toHaveLength(1);
  });

  it('換版本: the same version installed again over a changed manifest: read again and worked out again', () => {
    const { packs, reader, characters } = wire();
    reader.set(CONTRACT_PACK_ID, '1.0.0', {
      ok: true,
      manifest: manifestWith((raw) => {
        raw.characters = [raw.characters[0]!];
      }),
    });

    packs.update(packs.get().packs.installed);

    expect(Object.keys(characters.get().characters)).toStrictEqual([ONE]);
  });

  it('移除: a removed pack’s characters leave the section', () => {
    const another = manifestWith((raw) => {
      raw.id = 'another-pack';
    });
    const { packs, characters, heard } = wire({
      installed: [manifestWith(), another],
    });

    packs.update([stagePackOf(another)]);

    expect(Object.keys(characters.get().characters)).toStrictEqual([
      'another-pack/probe-one',
      'another-pack/probe-two',
    ]);
    expect(heard).toHaveLength(1);
  });

  it.each<[string, InstalledManifestResult, string]>([
    [
      'cannot be read',
      { ok: false, code: 'unreadable', detail: 'ENOENT' },
      'manifest unreadable: ENOENT',
    ],
    ['is not JSON', { ok: false, code: 'not-json' }, 'manifest not-json'],
    [
      'fails the schema',
      { ok: false, code: 'invalid-manifest' },
      'manifest invalid-manifest',
    ],
    [
      'is not that pack’s (another id or version)',
      { ok: false, code: 'mismatch' },
      'manifest mismatch',
    ],
  ])(
    '讀不到: a pack whose installed manifest %s is left out with one line naming it; the other pack stays',
    (_label, result, said) => {
      const another = manifestWith((raw) => {
        raw.id = 'another-pack';
      });
      const settings = fakeSettings();
      const packs = fakePacks([
        stagePackOf(manifestWith()),
        stagePackOf(another),
      ]);
      const reader = fakeReader([manifestWith()]);
      reader.set('another-pack', '1.0.0', result);

      const characters = createCharacters({
        settings,
        packs,
        readManifest: (packId, version) => reader.read(packId, version),
      });

      expect(characters.get()).toStrictEqual({
        characters: CONTRACT_CHARACTERS,
      });
      expect(lines(error)).toStrictEqual([
        `[settings] pack another-pack: left out of characters (${said})`,
      ]);
    },
  );

  it('讀不到: a pack that does not fit this stage’s API is left out, unread, with one line naming it; the other pack stays', () => {
    const another = manifestWith((raw) => {
      raw.id = 'another-pack';
    });
    const settings = fakeSettings();
    const packs = fakePacks([
      stagePackOf(manifestWith()),
      stagePackOf(another, {
        compatible: false,
        reason: 'pack-newer',
        required: '1.4',
      }),
    ]);
    const reader = fakeReader([manifestWith(), another]);

    const characters = createCharacters({
      settings,
      packs,
      readManifest: (packId, version) => reader.read(packId, version),
    });

    expect(characters.get()).toStrictEqual({ characters: CONTRACT_CHARACTERS });
    expect(reader.calls).toStrictEqual([`${CONTRACT_PACK_ID}@1.0.0`]);
    expect(lines(warn)).toStrictEqual([
      '[settings] pack another-pack: left out of characters (api-incompatible: pack-newer, needs API 1.4)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wired as main.ts wires it.

describe('with main/packs and StageView, as main.ts wires them', () => {
  let dir: string;

  beforeEach(() => {
    fake.resetFakeElectron();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-characters-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Installs the contract pack, its manifest changed by `change`. */
  async function install(
    packs: PacksStore,
    change: (raw: RawManifest) => void = () => {},
  ): Promise<void> {
    const raw = contractManifest() as RawManifest;
    change(raw);
    const files = contractPackFiles();
    files.set('manifest.json', manifestBytes(raw));
    const awpet = path.join(dir, `contract-${Math.random()}.awpet`);
    fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
    const inspection = await inspectPack(awpet, packs);
    if (!inspection.ok) {
      throw new Error(JSON.stringify(inspection.rejection));
    }
    const installed = installPack(packs, inspection.plan);
    if (!installed.ok) {
      throw new Error(JSON.stringify(installed));
    }
  }

  /**
   * Real settings, packs store, manifest reader and StageView, in main.ts's
   * order: the characters watch right after createStageView.
   */
  function wireStage() {
    const settings = loadSettings({ file: path.join(dir, 'settings.json') });
    const packs = loadPacks({ dir: path.join(dir, 'packs') });
    const characters = createCharacters({
      settings,
      packs,
      readManifest: (packId, version) =>
        readInstalledManifest(packs.dir, packId, version),
    });
    const hub = createStageView({
      settings,
      windows: createWindowsStageSource(),
      assigner: {
        get: () => ({
          sessions: [],
          adapters: [],
          pool: { released: [] },
          actors: [],
        }),
        onChange: () => () => {},
      },
      packs,
      packImport: {
        get: () => ({ packImport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      packExport: {
        get: () => ({ packExport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      characters,
    });
    characters.watch();
    const subscriber = fake.createFakeWebContents(
      1,
      'app://panels/index.html',
      false,
    );
    hub.subscribe(subscriber);
    const deltas = () =>
      subscriber.sent.map(({ args }) => args[0] as StageViewDelta);
    return { settings, packs, hub, deltas };
  }

  /** The rev of the first delta in `deltas` that carries `section`. */
  function revOf(
    deltas: readonly StageViewDelta[],
    section: 'packs' | 'characters',
  ): number | undefined {
    return deltas.find((delta) => delta.sections[section] !== undefined)?.rev;
  }

  describe('I/O matrix', () => {
    it('安裝順序: a new pack’s characters come in a delta after the packs delta that lists it, never before', async () => {
      const { settings, packs, hub, deltas } = wireStage();
      expect(hub.snapshot().view.characters).toStrictEqual({});

      await install(packs);

      const packsRev = revOf(deltas(), 'packs');
      const charactersRev = revOf(deltas(), 'characters');
      expect(packsRev).toBeDefined();
      expect(charactersRev).toBeDefined();
      expect(packsRev as number).toBeLessThan(charactersRev as number);
      expect(hub.snapshot().view.characters).toStrictEqual(CONTRACT_CHARACTERS);
      for (const delta of deltas()) {
        expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
      }
      settings.flushSync();
    });

    it('換版本: installing another version, then the same version again over a changed manifest: the characters follow each manifest', async () => {
      const { settings, packs, hub } = wireStage();
      await install(packs);

      await install(packs, (raw) => {
        raw.version = '1.1.0';
        (raw.characters[0]!.params as Record<string, unknown>[])[0]!.default =
          false;
      });
      expect(hub.snapshot().view.characters[ONE]?.params.glow).toBe(false);

      await install(packs, (raw) => {
        raw.version = '1.1.0';
        raw.characters[1]!.defaults = { scale: 1.8 };
      });
      expect(hub.snapshot().view.characters[ONE]?.params.glow).toBe(true);
      expect(hub.snapshot().view.characters[TWO]?.fixed).toStrictEqual({
        ...STAGE_FIXED,
        scale: 1.8,
      });
      settings.flushSync();
    });

    it('移除: removing the pack takes its characters out of StageView', async () => {
      const { settings, packs, hub, deltas } = wireStage();
      await install(packs);
      const before = deltas().length;

      expect(removePack(packs, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });

      const after = deltas().slice(before);
      expect(after.map((delta) => Object.keys(delta.sections))).toStrictEqual([
        ['packs'],
        ['characters'],
      ]);
      expect(hub.snapshot().view.characters).toStrictEqual({});
      settings.flushSync();
    });
  });
});
