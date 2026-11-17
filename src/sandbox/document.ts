/**
 * Puts the sandbox document together at build time (AD-7, Story 3.5):
 * pure string work, so it is unit-tested under Node. The build (the main
 * Vite build's sandbox plugin, scripts/sandbox-plugin.ts) bundles
 * iframe.ts and worker-bootstrap.ts as classic scripts, reads SES's
 * `dist/ses.umd.min.js`, and passes all three here; it then hashes the
 * inline script for the CSP (csp.ts). Nothing here reads files at run time.
 *
 * The document has one inline script:
 *
 *     const __awpWorkerScript = "<the Worker script, as a JSON string>";
 *     <the iframe bundle, defining __awpSandboxIframe>
 *     __awpSandboxIframe.startIframe(self, __awpWorkerScript);
 *
 * and the Worker script, which the iframe puts after the entry source
 * (`const __awpEntrySource = "<entry>";`) in a blob, is
 *
 *     <the Worker bootstrap bundle, defining __awpSandboxWorker>
 *     __awpSandboxWorker.countConsole();
 *     <SES>
 *     __awpSandboxWorker.run(__awpEntrySource);
 *
 * so console output is counted from before SES loads. The top-level names
 * live in the Worker's own global scope; code in a Compartment never sees
 * them.
 *
 * The checks are the Story 1.2 prototype's: the embedded parts are JSON
 * with `<`, `>`, `&` and every non-ASCII character written as `\uXXXX`;
 * the script must be ASCII (so its hash does not depend on an encoding)
 * and must not hold `</script` or `<!--`. Line endings become `\n` first,
 * so a Windows checkout hashes the same.
 */

/** The global the Worker bootstrap bundle defines. */
export const WORKER_BUNDLE_GLOBAL = '__awpSandboxWorker';

/** The global the iframe bundle defines. */
export const IFRAME_BUNDLE_GLOBAL = '__awpSandboxIframe';

/** The Worker script's global holding the pack's entry source. */
export const ENTRY_SOURCE_GLOBAL = '__awpEntrySource';

/** The inline script's global holding the Worker script. */
export const WORKER_SCRIPT_GLOBAL = '__awpWorkerScript';

/** What the document is made of. */
export interface SandboxDocumentParts {
  /** The Worker bootstrap, bundled as a classic script. */
  readonly workerBootstrap: string;
  /** SES's `dist/ses.umd.min.js`. */
  readonly ses: string;
  /** The iframe code, bundled as a classic script. */
  readonly iframe: string;
}

export interface SandboxDocument {
  /** The whole document. */
  readonly html: string;
  /** Its one inline script, as hashed for the CSP. */
  readonly script: string;
}

/** `text` with every line ending as `\n`. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * `value` as JSON that is safe inside an inline `<script>` and ASCII:
 * `<`, `>`, `&` and every character from U+007F up written as `\uXXXX`
 * (an astral character as its two escaped halves).
 */
export function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Throws when `script` could not stay inside its inline `<script>` (it has
 * `</script` or `<!--`, any case) or is not ASCII (tab, newline and
 * U+0020 to U+007E only).
 */
export function checkInlineScript(script: string): void {
  if (/<\/script|<!--/i.test(script)) {
    throw new Error(
      'the sandbox script would break out of its inline <script>',
    );
  }
  if (/[^\t\n\x20-\x7e]/.test(script)) {
    throw new Error('the sandbox script must be ASCII so its hash is stable');
  }
}

/** The Worker script, without the entry the iframe puts before it. */
export function workerScript(workerBootstrap: string, ses: string): string {
  return [
    normalizeNewlines(workerBootstrap),
    `${WORKER_BUNDLE_GLOBAL}.countConsole();`,
    normalizeNewlines(ses),
    `${WORKER_BUNDLE_GLOBAL}.run(${ENTRY_SOURCE_GLOBAL});`,
  ].join('\n;\n');
}

/** The document's inline script. Throws as checkInlineScript does. */
export function inlineScript(parts: SandboxDocumentParts): string {
  const script = [
    `const ${WORKER_SCRIPT_GLOBAL} = ${toInlineScriptJson(
      workerScript(parts.workerBootstrap, parts.ses),
    )};`,
    normalizeNewlines(parts.iframe),
    `${IFRAME_BUNDLE_GLOBAL}.startIframe(self, ${WORKER_SCRIPT_GLOBAL});`,
    '',
  ].join('\n;\n');
  checkInlineScript(script);
  return script;
}

/** The whole document around `script`. */
export function sandboxHtml(script: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"><title>sandbox</title></head>',
    `<body><script>${script}</script></body>`,
    '</html>',
    '',
  ].join('\n');
}

/** The sandbox document for `parts`. Throws as checkInlineScript does. */
export function composeSandboxDocument(
  parts: SandboxDocumentParts,
): SandboxDocument {
  const script = inlineScript(parts);
  return { html: sandboxHtml(script), script };
}
