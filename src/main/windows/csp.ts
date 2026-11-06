/**
 * The Content-Security-Policy of the stage's own pages (AD-24), built here
 * and nowhere else. It reaches a page one of two ways:
 *
 * - packaged: the `app://` handler (protocols.ts) sends it with every HTML
 *   response;
 * - `npm start`: the HTML comes from the Vite dev server, so the session's
 *   `onHeadersReceived` (security.ts) adds it to the dev server's responses.
 *
 * Neither policy ever contains 'unsafe-eval': zod runs jitless and nothing
 * else in the panels needs eval.
 */

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

/** The policy `app://` pages are served with. */
export const PACKAGED_CSP = serialize(PACKAGED_DIRECTIVES);

/**
 * The policy for pages served by the Vite dev server at `devServerOrigin`
 * (`http://localhost:5173`): the packaged policy, plus 'unsafe-inline' for
 * scripts (React Fast Refresh's inline preamble) and styles (the `<style>`
 * tags Vite injects for imported CSS), plus the dev server's HMR WebSocket.
 */
export function devServerCsp(devServerOrigin: string): string {
  const dev = new URL(devServerOrigin);
  const socket = `${dev.protocol === 'https:' ? 'wss:' : 'ws:'}//${dev.host}`;
  return serialize(
    PACKAGED_DIRECTIVES.map(([name, sources]) => {
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
