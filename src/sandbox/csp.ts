/**
 * The sandbox document's Content-Security-Policy (AD-7, Story 3.5), built
 * here and nowhere else. The build calls it with the SHA-256 of the
 * document's one inline script; main serves the result as the
 * `content-security-policy` header of `pack://_stage/sandbox.html`.
 *
 * - `default-src 'none'`: nothing loads unless listed below;
 * - `script-src`: only that inline script (by its hash) runs, and
 *   `'unsafe-eval'` lets SES's Compartment evaluate the pack's entry;
 * - `worker-src blob:`: the Worker is made from a blob of the bootstrap
 *   and the entry (the blob Worker inherits this policy);
 * - `connect-src 'none'`: no fetch, XHR, WebSocket or EventSource, even
 *   if one were left;
 * - `sandbox allow-scripts` (decision of 2026-11-17): the document is
 *   sandboxed with an opaque origin and scripts only, even if it were ever
 *   loaded without the iframe's `sandbox` attribute. No `frame-ancestors`:
 *   the overlay must be able to frame it.
 */

/** A SHA-256 digest in base64: 43 characters and one `=`. */
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The policy for an inline script whose SHA-256 is `sha256` (base64).
 * Throws a TypeError on anything that is not a base64 SHA-256 digest.
 */
export function sandboxCsp(sha256: string): string {
  if (!SHA256_BASE64.test(sha256)) {
    throw new TypeError('not a base64 SHA-256 digest');
  }
  return [
    "default-src 'none'",
    `script-src 'sha256-${sha256}' 'unsafe-eval'`,
    'worker-src blob:',
    "connect-src 'none'",
    'sandbox allow-scripts',
  ].join('; ');
}
