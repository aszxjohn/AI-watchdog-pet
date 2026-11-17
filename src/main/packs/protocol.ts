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
 * `%`), and a URL with a user, password or port. The query and fragment
 * are ignored.
 *
 * `pack://_stage/sandbox.html` is the sandbox document (Story 3.5): the
 * file the main build wrote next to main.cjs, served with the CSP the same
 * build wrote (src/sandbox/csp.ts made it; it carries the hash of the
 * document's inline script and `sandbox allow-scripts`). Both come from an
 * injected provider, read once. The document is 404 when they cannot be
 * read, when the CSP does not start with `default-src 'none'`, does not
 * have exactly one `sandbox` directive that is `sandbox allow-scripts`, or
 * has a `frame-ancestors` (directive names in any case), or when the hash
 * does not match; so is every other `pack://_stage/…` path.
 *
 * The content type follows the extension; a pack never gets an HTML type
 * from here, and `nosniff` keeps the browser from guessing one.
 *
 * No CORS header (`Access-Control-Allow-Origin`) is sent yet. Story 3.6
 * decides it when the overlay (`app://overlay`) loads textures from here
 * with PixiJS, together with letting `pack:` into the overlay's CSP.
 */
import { protocol } from 'electron';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import {
  PACK_SCHEME,
  PACK_STAGE_HOST,
  SANDBOX_CSP_FILE,
  SANDBOX_DOCUMENT_FILE,
} from '../../shared/constants';
import { z } from '../../shared/zod-setup';
import { errorCode, logEvent } from '../log/run-log';
import type { PacksStore } from './store';

/** The host the stage serves its own documents from (the sandbox). */
export const STAGE_HOST = PACK_STAGE_HOST;

/** The one path served under STAGE_HOST. */
const SANDBOX_DOCUMENT_PATH = `/${SANDBOX_DOCUMENT_FILE}`;

/** The sandbox document and the CSP it is served with. */
export interface SandboxDocument {
  readonly html: string;
  readonly csp: string;
}

/**
 * Gives the sandbox document, or undefined when there is none to serve.
 * Never rejects.
 */
export type SandboxDocumentProvider = () => Promise<
  SandboxDocument | undefined
>;

/** The directives of a CSP, each trimmed, empty ones left out. */
function cspDirectives(csp: string): string[] {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '');
}

/** A directive's name, lower-cased (names are case-insensitive). */
function directiveName(directive: string): string {
  return (directive.split(/\s+/)[0] ?? '').toLowerCase();
}

/**
 * Whether `csp` sandboxes the document with scripts only, and nothing else
 * can undo it: exactly one directive is named `sandbox` (in any case; a
 * browser would use the first of several), and it is `sandbox
 * allow-scripts` (case and spacing aside); and no directive is named
 * `frame-ancestors`, in any case (the overlay frames the document).
 */
function isSandboxedScriptsOnly(csp: string): boolean {
  const directives = cspDirectives(csp);
  const sandboxes = directives.filter(
    (directive) => directiveName(directive) === 'sandbox',
  );
  return (
    sandboxes.length === 1 &&
    (sandboxes[0] ?? '').toLowerCase().split(/\s+/).join(' ') ===
      'sandbox allow-scripts' &&
    !directives.some(
      (directive) => directiveName(directive) === 'frame-ancestors',
    )
  );
}

/**
 * `sandbox-csp.json` as the build writes it (src/sandbox/csp.ts): a CSP
 * that starts with `default-src 'none'; ` and passes isSandboxedScriptsOnly,
 * and the SHA-256 of the document's inline script.
 */
const sandboxCspFileSchema = z.strictObject({
  csp: z
    .string()
    .startsWith("default-src 'none'; ")
    .refine(isSandboxedScriptsOnly),
  sha256: z.string().min(1),
});

/** The parts of node:fs/promises the provider uses; tests may inject them. */
export interface SandboxDocumentFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
}

/**
 * The provider of the sandbox document the build wrote into `buildDir`
 * (the folder main.cjs runs from): read once, on the first request, and
 * kept. A file that cannot be read, a CSP file that does not fit, or a
 * document whose one inline script does not hash to the CSP file's
 * `sha256` (or whose CSP does not carry it) gives undefined (404) for the
 * rest of the run, with one error line.
 */
export function sandboxDocumentFrom(
  buildDir: string,
  fs: SandboxDocumentFs = nodeFs,
): SandboxDocumentProvider {
  let loaded: Promise<SandboxDocument | undefined> | undefined;
  async function load(): Promise<SandboxDocument | undefined> {
    try {
      const [html, cspFile] = await Promise.all([
        fs.readFile(path.join(buildDir, SANDBOX_DOCUMENT_FILE), 'utf8'),
        fs.readFile(path.join(buildDir, SANDBOX_CSP_FILE), 'utf8'),
      ]);
      const parsed = sandboxCspFileSchema.safeParse(JSON.parse(cspFile));
      if (!parsed.success) {
        logEvent(
          'packs',
          `${SANDBOX_CSP_FILE} does not fit its schema; the sandbox document is not served this run`,
          'error',
        );
        return undefined;
      }
      const { csp, sha256 } = parsed.data;
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      const script = scripts.length === 1 ? scripts[0]?.[1] : undefined;
      const actual =
        script === undefined
          ? undefined
          : createHash('sha256').update(script, 'utf8').digest('base64');
      if (actual !== sha256 || !csp.includes(`'sha256-${sha256}'`)) {
        logEvent(
          'packs',
          `the sandbox document's inline script does not match ${SANDBOX_CSP_FILE} (not from one build?); it is not served this run`,
          'error',
        );
        return undefined;
      }
      return { html, csp };
    } catch (error) {
      logEvent(
        'packs',
        `cannot read the sandbox document (${errorCode(error)}); it is not served this run`,
        'error',
      );
      return undefined;
    }
  }
  return () => {
    loaded ??= load();
    return loaded;
  };
}

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
  /** The sandbox document for `pack://_stage/sandbox.html`. */
  readonly sandbox: SandboxDocumentProvider;
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

/**
 * Whether `url` is `pack://_stage/sandbox.html` (query and fragment
 * ignored; no user, password or port). Never throws.
 */
export function isSandboxDocumentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${PACK_SCHEME}:` &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    parsed.hostname === STAGE_HOST &&
    parsed.pathname === SANDBOX_DOCUMENT_PATH
  );
}

/** The sandbox document's response, or 404 when there is none. */
async function serveSandboxDocument(
  sandbox: SandboxDocumentProvider,
): Promise<Response> {
  const document = await sandbox();
  if (document === undefined) {
    return notFound();
  }
  return new Response(document.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': document.csp,
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The `pack://` handler. Never throws or rejects. */
export function createPackProtocolHandler({
  store,
  sandbox,
  fs = nodeFs,
}: PackProtocolOptions): PackProtocolHandler {
  return async (request) => {
    if (isSandboxDocumentUrl(request.url)) {
      try {
        return await serveSandboxDocument(sandbox);
      } catch {
        return notFound();
      }
    }
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

/**
 * Serves `pack://` on the default session, with the sandbox document the
 * build wrote into `buildDir` (the folder main.cjs runs from). Call once,
 * after `ready`.
 */
export function handlePackProtocol(store: PacksStore, buildDir: string): void {
  protocol.handle(
    PACK_SCHEME,
    createPackProtocolHandler({
      store,
      sandbox: sandboxDocumentFrom(buildDir),
    }),
  );
}
