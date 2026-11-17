/**
 * The Content-Security-Policy of the stage's own pages (AD-24), built here
 * and nowhere else. It reaches a page one of two ways:
 *
 * - packaged: the `app://` handler (protocols.ts) sends it with every HTML
 *   response;
 * - `npm start`: the HTML comes from a Vite dev server (one per renderer),
 *   so the session's `onHeadersReceived` (security.ts) adds it to each dev
 *   server's responses, built for that server's origin.
 *
 * Neither policy ever contains 'unsafe-eval': zod runs jitless, PixiJS in
 * the overlay loads its `pixi.js/unsafe-eval` polyfill, and nothing else
 * needs eval. The overlay and the panels get the same policy, except that
 * the overlay may also frame `pack:` (`frame-src pack:`): each pack's
 * sandbox is an iframe of `pack://_stage/sandbox.html` (Story 3.5), which
 * comes with its own, stricter policy (src/sandbox/csp.ts).
 */

/** The stage's own pages, by renderer name. */
export type CspPage = 'panels' | 'overlay';

/** The directives of the packaged policy, in output order. */
const PACKAGED_DIRECTIVES: readonly (readonly [string, readonly string[]])[] = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
  ['img-src', ["'self'", 'data:']],
  ['connect-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
  ['frame-ancestors', ["'none'"]],
];

function serialize(
  directives: readonly (readonly [string, readonly string[]])[],
): string {
  return directives
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** The packaged directives of `page`: the overlay adds `frame-src pack:`. */
function directivesOf(
  page: CspPage,
): readonly (readonly [string, readonly string[]])[] {
  if (page === 'panels') {
    return PACKAGED_DIRECTIVES;
  }
  return PACKAGED_DIRECTIVES.flatMap((directive) =>
    directive[0] === 'connect-src'
      ? [directive, ['frame-src', ['pack:']] as const]
      : [directive],
  );
}

/** The policy the panels' `app://` pages are served with. */
export const PACKAGED_CSP = serialize(directivesOf('panels'));

/** The policy the overlay's `app://` pages are served with. */
export const OVERLAY_PACKAGED_CSP = serialize(directivesOf('overlay'));

/**
 * The policy for `page` served by the Vite dev server at
 * `devServerOrigin` (`http://localhost:5173`): its packaged policy, plus
 * 'unsafe-inline' for scripts (React Fast Refresh's inline preamble) and
 * styles (the `<style>` tags Vite injects for imported CSS), plus the dev
 * server's HMR WebSocket.
 */
export function devServerCsp(devServerOrigin: string, page: CspPage): string {
  const dev = new URL(devServerOrigin);
  const socket = `${dev.protocol === 'https:' ? 'wss:' : 'ws:'}//${dev.host}`;
  return serialize(
    directivesOf(page).map(([name, sources]) => {
      switch (name) {
        case 'script-src':
        case 'style-src':
          return [name, [...sources, "'unsafe-inline'"]];
        case 'connect-src':
          return [name, [...sources, socket]];
        default:
          return [name, sources];
      }
    }),
  );
}
