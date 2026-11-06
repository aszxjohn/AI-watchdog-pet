/**
 * The stage's custom schemes (AD-24): `app` and `pack` are registered here
 * once, before `ready`, and `app://` is served here. `pack://` is served by
 * main/packs (Story 3.2).
 *
 * `app://<host>/<path>` maps a known host to one Vite output folder:
 * `app://panels/index.html` is `.vite/renderer/panels/index.html`, and
 * `app://overlay/index.html` is `.vite/renderer/overlay/index.html`. Anything
 * that does not name an existing file inside that folder, with a known file
 * type, is answered 404 without reading anything: unknown hosts, `..` or `.`
 * segments (raw or percent-encoded), encoded slashes or backslashes, NUL,
 * folders, missing files, unknown extensions. HTML responses carry the CSP
 * from csp.ts.
 */
import { protocol, type CustomScheme } from 'electron';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { APP_SCHEME, PACK_SCHEME } from '../../shared/constants';
import { PACKAGED_CSP } from './csp';

/**
 * The privileges of each scheme: the smallest sets the prototypes proved
 * enough (Story 1.2 for `pack`; `app` loads Vite's module scripts with
 * `standard` and `secure` alone). Neither gets `bypassCSP`.
 */
export const SCHEME_PRIVILEGES: readonly CustomScheme[] = Object.freeze([
  {
    scheme: APP_SCHEME,
    privileges: Object.freeze({ standard: true, secure: true }),
  },
  {
    scheme: PACK_SCHEME,
    privileges: Object.freeze({
      standard: true,
      secure: true,
      corsEnabled: true,
    }),
  },
]);

let schemesRegistered = false;

/**
 * Registers `app` and `pack` as privileged schemes. Electron allows this
 * once, before `ready`; a second call is a bug and throws.
 */
export function registerSchemes(): void {
  if (schemesRegistered) {
    throw new Error('registerSchemes() may be called only once');
  }
  schemesRegistered = true;
  protocol.registerSchemesAsPrivileged(
    SCHEME_PRIVILEGES.map(({ scheme, privileges }) => ({
      scheme,
      privileges: { ...privileges },
    })),
  );
}

/** The `app://` host the panels page is served from. */
export const PANELS_HOST = 'panels';

/** The `app://` host the overlay (canvas) page is served from. */
export const OVERLAY_HOST = 'overlay';

/** `.vite/renderer/<name>` next to the build folder main.cjs runs from. */
function rendererDir(buildDir: string, forgeName: unknown, host: string) {
  const name =
    typeof forgeName === 'string' && forgeName !== '' ? forgeName : host;
  return path.join(buildDir, '..', 'renderer', name);
}

/**
 * Folder of the panels Vite build, given the folder main.cjs runs from
 * (`.vite/build`): `.vite/renderer/<PANELS_VITE_NAME>`.
 */
export function panelsRendererDir(buildDir: string): string {
  return rendererDir(
    buildDir,
    typeof PANELS_VITE_NAME === 'undefined' ? undefined : PANELS_VITE_NAME,
    PANELS_HOST,
  );
}

/**
 * Folder of the overlay Vite build, given the folder main.cjs runs from
 * (`.vite/build`): `.vite/renderer/<OVERLAY_VITE_NAME>`.
 */
export function overlayRendererDir(buildDir: string): string {
  return rendererDir(
    buildDir,
    typeof OVERLAY_VITE_NAME === 'undefined' ? undefined : OVERLAY_VITE_NAME,
    OVERLAY_HOST,
  );
}

/** Content types served, by lower-case extension; others are 404. */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
});

/** The parts of node:fs/promises the handler uses; tests may inject them. */
export interface AppProtocolFs {
  stat(file: string): Promise<{ isFile(): boolean }>;
  readFile(file: string): Promise<Uint8Array>;
}

export interface AppProtocolOptions {
  /** `app://` host -> absolute folder it serves. */
  readonly roots: Readonly<Record<string, string>>;
  readonly fs?: AppProtocolFs;
}

export type AppProtocolHandler = (
  request: Pick<Request, 'url'>,
) => Promise<Response>;

/**
 * The `app://` handler: one file inside the folder of a known host, or 404.
 * Never throws or rejects.
 */
export function createAppProtocolHandler({
  roots,
  fs = nodeFs,
}: AppProtocolOptions): AppProtocolHandler {
  return async (request) => {
    const file = resolveAppFile(request.url, roots);
    if (file === undefined) {
      return notFound();
    }
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (contentType === undefined) {
      return notFound();
    }
    try {
      if (!(await fs.stat(file)).isFile()) {
        return notFound();
      }
      const body = await fs.readFile(file);
      const headers: Record<string, string> = { 'content-type': contentType };
      if (contentType.startsWith('text/html')) {
        headers['content-security-policy'] = PACKAGED_CSP;
      }
      return new Response(new Uint8Array(body), { status: 200, headers });
    } catch {
      return notFound();
    }
  };
}

/**
 * The file `url` names inside its host's folder, or undefined when the URL
 * is not one this handler may serve. Pure; never throws.
 */
export function resolveAppFile(
  url: string,
  roots: Readonly<Record<string, string>>,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${APP_SCHEME}:` ||
    !Object.hasOwn(roots, parsed.hostname)
  ) {
    return undefined;
  }
  const root = roots[parsed.hostname];
  if (root === undefined) {
    return undefined;
  }

  const segments: string[] = [];
  for (const raw of parsed.pathname.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      return undefined;
    }
    if (segment !== '') {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    segments.push('index.html');
  }

  const file = path.join(root, ...segments);
  const relative = path.relative(root, file);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return file;
}

function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Serves `app://` on the default session. Call once, after `ready`;
 * `buildDir` is the folder main.cjs runs from.
 */
export function handleAppProtocol(buildDir: string): void {
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({
      roots: {
        [PANELS_HOST]: panelsRendererDir(buildDir),
        [OVERLAY_HOST]: overlayRendererDir(buildDir),
      },
    }),
  );
}
