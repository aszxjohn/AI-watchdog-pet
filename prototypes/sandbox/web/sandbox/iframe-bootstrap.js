// Sandbox iframe bootstrap (AD-7 rule 1), served inline in
// pack://_stage/sandbox.html. main.cjs prepends `const EMBEDDED = {...}` (SES,
// Worker prelude, Worker bootstrap and probe Worker sources) and puts the
// SHA-256 of the whole inline script into the document CSP. Keep this file
// ASCII-only so the hash does not depend on text encoding.
(() => {
  'use strict';

  const workers = [];
  const pendingDiagnostics = [];
  let diagnostics = null;
  let loaded = false;

  const describeError = (error) => ({
    name: String(error?.name ?? typeof error),
    message: String(error?.message ?? error),
  });
  const report = (message) => {
    if (diagnostics) diagnostics.postMessage(message);
    else pendingDiagnostics.push(message);
  };

  addEventListener('securitypolicyviolation', (event) => {
    report({
      type: 'csp-violation',
      where: 'iframe',
      directive: event.effectiveDirective,
      blockedURI: String(event.blockedURI).slice(0, 200),
    });
  });

  addEventListener('message', (event) => {
    if (loaded || event.source !== parent) return;
    const message = event.data;
    if (!message || message.type !== 'load' || event.ports.length !== 3) {
      return;
    }
    loaded = true;
    const [packPort, diagnosticsPort, probePort] = event.ports;
    diagnostics = diagnosticsPort;
    for (const pending of pendingDiagnostics.splice(0)) {
      diagnostics.postMessage(pending);
    }
    report({ type: 'iframe-info', ...describeIframe() });

    // AD-19: bootstrap + entry become one blob; the entry is embedded as a
    // string and only ever evaluated inside the Compartment.
    const entryPrefix = `const __awpEntrySource = ${JSON.stringify(
      String(message.entry),
    )};`;
    startWorker(
      'pack',
      [
        entryPrefix,
        EMBEDDED.workerPrelude,
        EMBEDDED.sesUnknownIntrinsics,
        EMBEDDED.ses,
        EMBEDDED.workerBootstrap,
      ],
      packPort,
      message.targets,
    );
    // Prototype-only diagnostics Worker: same iframe and CSP, no API removal.
    startWorker('probe', [EMBEDDED.probeWorker], probePort, message.targets);
  });

  function describeIframe() {
    // A non-hashed inline script must not run if the AD-7 CSP is in effect.
    const inline = document.createElement('script');
    inline.textContent = 'window.__awpInlineRan = true;';
    document.head.append(inline);
    return {
      origin: String(self.origin),
      locationHref: String(location.href),
      isSecureContext: self.isSecureContext,
      inlineScriptBlocked: window.__awpInlineRan !== true,
      parentDocumentAccess: attempt(() => parent.document.title),
      cookieAccess: attempt(() => document.cookie),
      localStorageAccess: attempt(() => localStorage.length),
    };
  }

  function attempt(read) {
    try {
      read();
      return 'allowed';
    } catch (error) {
      return `blocked: ${describeError(error).name}`;
    }
  }

  function startWorker(name, parts, port, targets) {
    try {
      const source = parts.join('\n;\n');
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      );
      // Classic Worker on purpose: no { type: 'module' } (AD-7 rule 2).
      const worker = new Worker(url);
      worker.addEventListener('error', (event) => {
        report({
          type: 'worker-error',
          worker: name,
          message: String(event.message),
          lineno: event.lineno,
        });
      });
      worker.postMessage({ type: 'init', targets }, [port]);
      workers.push(worker);
      report({
        type: 'worker-created',
        worker: name,
        url,
        sourceLength: source.length,
      });
    } catch (error) {
      report({
        type: 'worker-create-failed',
        worker: name,
        error: describeError(error),
      });
    }
  }
})();
