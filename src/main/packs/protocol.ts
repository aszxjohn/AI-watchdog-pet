/**
 * main/packs (Story 3.2, AD-24): the `pack://` handler. main/windows
 * registers the scheme (standard, secure, corsEnabled) before `ready`; this
 * serves it once ready.
 *
 * `pack://<packId>/<version>/<path>` answers the file only when that pack
 * is installed at that version and `<path>` is one of the paths its install
 * worked out (index.json's `servedPaths`: the entry, the `assets` paths,
 * the spritesheets' images), compared exactly, case included. Everything
 * else is 404 without reading anything: a pack or version not installed, a
 * path the manifest did not declare (the URL parser has already resolved
 * `..`; a percent-encoded name never matches, since pack paths have no
 * `%`), a URL with a user, password or port, and `pack://_stage/…`, which
 * Story 3.5 serves. The query and fragment are ignored.
 *
 * The content type follows the extension; a pack never gets an HTML type
 * from here, and `nosniff` keeps the browser from guessing one.
 *
 * No CORS header (`Access-Control-Allow-Origin`) is sent yet. Story 3.6
 * decides it when the overlay (`app://overlay`) loads textures from here
 * with PixiJS, together with letting `pack:` into the overlay's CSP.
 */
import { protocol } from 'electron';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { PACK_SCHEME } from '../../shared/constants';
import type { PacksStore } from './store';

/** The host Story 3.5 serves the sandbox from; 404 until then. */
export const STAGE_HOST = '_stage';

/** Content types served, by lower-case extension; others are binary. */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
});

const BINARY = 'application/octet-stream';

/** The parts of node:fs/promises the handler uses; tests may inject them. */
export interface PackProtocolFs {
  stat(file: string): Promise<{ isFile(): boolean }>;
  readFile(file: string): Promise<Uint8Array>;
}

export interface PackProtocolOptions {
  readonly store: Pick<PacksStore, 'dir' | 'find'>;
  readonly fs?: PackProtocolFs;
}

export type PackProtocolHandler = (
  request: Pick<Request, 'url'>,
) => Promise<Response>;

/**
 * The file `url` names in the packs folder, or undefined when it is not one
 * this handler may serve. Never throws.
 */
export function resolvePackFile(
  url: string,
  store: Pick<PacksStore, 'dir' | 'find'>,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${PACK_SCHEME}:` ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hostname === STAGE_HOST
  ) {
    return undefined;
  }
  const installed = store.find(parsed.hostname);
  const [first, version, ...rest] = parsed.pathname.split('/');
  if (
    installed === undefined ||
    first !== '' ||
    version !== installed.version
  ) {
    return undefined;
  }
  const served = rest.join('/');
  if (!installed.servedPaths.includes(served)) {
    return undefined;
  }
  return path.join(store.dir, installed.id, installed.version, ...rest);
}

function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** The `pack://` handler. Never throws or rejects. */
export function createPackProtocolHandler({
  store,
  fs = nodeFs,
}: PackProtocolOptions): PackProtocolHandler {
  return async (request) => {
    const file = resolvePackFile(request.url, store);
    if (file === undefined) {
      return notFound();
    }
    try {
      if (!(await fs.stat(file)).isFile()) {
        return notFound();
      }
      const body = await fs.readFile(file);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type':
            CONTENT_TYPES[path.extname(file).toLowerCase()] ?? BINARY,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return notFound();
    }
  };
}

/** Serves `pack://` on the default session. Call once, after `ready`. */
export function handlePackProtocol(store: PacksStore): void {
  protocol.handle(PACK_SCHEME, createPackProtocolHandler({ store }));
}
