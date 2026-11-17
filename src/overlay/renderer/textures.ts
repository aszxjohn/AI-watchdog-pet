/**
 * overlay/renderer (Story 3.6): the packs' textures, kept apart by
 * `<packId>@<version>`. Generic over the image and texture types, with the
 * loading and texture making passed in (pixi-stage.ts gives PixiJS's), so
 * it is unit-tested under Node with fakes.
 *
 * - sync() takes the looks of the packs installed now. Each version not
 *   seen before starts loading every asset of its manifest, once: an image
 *   asset from its `pack://<packId>/<version>/<path>`, a spritesheet from
 *   its image's URL (`meta.image`, from main) and the frames of its JSON.
 *   A version no longer there (the pack removed, or installed at another
 *   version) is released: its textures are destroyed, and a load still on
 *   its way is destroyed when it arrives.
 * - A PNG two assets of one version share is loaded once.
 * - The textures are the store's own: nothing goes into PixiJS's global
 *   cache, so two packs' frames of one name never meet.
 * - An asset that does not load, or a spritesheet with a frame outside its
 *   image, fails: it has no texture (its sprites are not drawn) and
 *   onFailed hears it once, with its pack and key.
 */
import {
  spritesheetFitsImage,
  type PackSpritesheet,
} from '../../shared/pack-api';
import { packFileUrl } from '../../shared/packs';
import type { PackLook } from '../looks';

/** How textures are made (PixiJS in the overlay, fakes in tests). */
export interface TextureBackend<I, T> {
  /** Loads the image at `url`; rejects when it cannot. */
  loadImage(url: string): Promise<I>;
  /** The image's size in pixels. */
  sizeOf(image: I): { readonly width: number; readonly height: number };
  /** A texture of the whole image, cached nowhere. */
  imageTexture(image: I): T;
  /** The frames of `sheet` over `texture`, by name, cached nowhere. */
  sheetTextures(texture: T, sheet: PackSpritesheet): ReadonlyMap<string, T>;
  /** Frees `texture`; `base` frees its image's data too. */
  destroy(texture: T, base: boolean): void;
}

export interface TextureStoreOptions<I, T> {
  readonly backend: TextureBackend<I, T>;
  /** Hears an asset that failed (once per pack version and asset). */
  readonly onFailed?: (packId: string, asset: string) => void;
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

export interface TextureStore<T> {
  /** Follows the looks of the packs installed now (see the module comment). */
  sync(looks: readonly PackLook[]): void;
  /**
   * The texture of `asset` (its `frame`, for a spritesheet) of version
   * `version` of `packId`; undefined while it loads, when it failed, or
   * when there is no such asset or frame.
   */
  get(
    packId: string,
    version: string,
    asset: string,
    frame: string | undefined,
  ): T | undefined;
  /** How many pack versions it holds (for tests). */
  size(): number;
}

/** One asset of a version. */
interface Asset<T> {
  /** Its texture (an image) or its sheet's base texture. */
  base: T | undefined;
  /** A spritesheet's frames. */
  frames: ReadonlyMap<string, T> | undefined;
  failed: boolean;
}

/** One version of one pack. */
interface Version<I, T> {
  readonly assets: Map<string, Asset<T>>;
  /** Each PNG's load, by URL. */
  readonly images: Map<string, Promise<I>>;
  released: boolean;
}

/** `<packId>@<version>`. */
function versionKey(packId: string, version: string): string {
  return `${packId}@${version}`;
}

export function createTextureStore<I, T>({
  backend,
  onFailed = () => {},
  logError = console.error,
}: TextureStoreOptions<I, T>): TextureStore<T> {
  const versions = new Map<string, Version<I, T>>();

  function destroyAsset(asset: Asset<T>): void {
    try {
      for (const texture of asset.frames?.values() ?? []) {
        backend.destroy(texture, false);
      }
      if (asset.base !== undefined) {
        backend.destroy(asset.base, true);
      }
    } catch (error) {
      logError('[overlay] could not free a texture', error);
    }
    asset.base = undefined;
    asset.frames = undefined;
  }

  function image(entry: Version<I, T>, url: string): Promise<I> {
    let load = entry.images.get(url);
    if (load === undefined) {
      load = backend.loadImage(url);
      entry.images.set(url, load);
    }
    return load;
  }

  async function load(
    entry: Version<I, T>,
    look: PackLook,
    key: string,
    asset: Asset<T>,
  ): Promise<void> {
    const declared = look.manifest.assets[key];
    const sheet = look.spritesheets[key];
    try {
      if (declared === undefined) {
        throw new Error('not an asset');
      }
      const path =
        declared.kind === 'spritesheet' ? sheet?.image : declared.path;
      if (path === undefined) {
        throw new Error('no spritesheet');
      }
      const loaded = await image(
        entry,
        packFileUrl(look.packId, look.version, path),
      );
      if (entry.released) {
        return;
      }
      if (sheet === undefined) {
        asset.base = backend.imageTexture(loaded);
        return;
      }
      const { width, height } = backend.sizeOf(loaded);
      if (!spritesheetFitsImage(sheet.data, width, height)) {
        throw new Error('a frame lies outside its image');
      }
      asset.base = backend.imageTexture(loaded);
      asset.frames = backend.sheetTextures(asset.base, sheet.data);
    } catch (error) {
      if (entry.released) {
        return;
      }
      destroyAsset(asset);
      asset.failed = true;
      logError(`[overlay] pack ${look.packId}: asset ${key} failed`, error);
      onFailed(look.packId, key);
    }
  }

  function start(look: PackLook): Version<I, T> {
    const entry: Version<I, T> = {
      assets: new Map(),
      images: new Map(),
      released: false,
    };
    for (const key of Object.keys(look.manifest.assets)) {
      const asset: Asset<T> = {
        base: undefined,
        frames: undefined,
        failed: false,
      };
      entry.assets.set(key, asset);
      void load(entry, look, key, asset);
    }
    return entry;
  }

  return {
    sync(looks) {
      const wanted = new Map(
        looks.map((look) => [versionKey(look.packId, look.version), look]),
      );
      for (const [key, entry] of versions) {
        if (!wanted.has(key)) {
          entry.released = true;
          for (const asset of entry.assets.values()) {
            destroyAsset(asset);
          }
          versions.delete(key);
        }
      }
      for (const [key, look] of wanted) {
        if (!versions.has(key)) {
          versions.set(key, start(look));
        }
      }
    },

    get(packId, version, assetKey, frame) {
      const asset = versions
        .get(versionKey(packId, version))
        ?.assets.get(assetKey);
      if (asset === undefined || asset.failed) {
        return undefined;
      }
      if (asset.frames !== undefined) {
        return frame === undefined ? undefined : asset.frames.get(frame);
      }
      return frame === undefined ? asset.base : undefined;
    },

    size: () => versions.size,
  };
}
