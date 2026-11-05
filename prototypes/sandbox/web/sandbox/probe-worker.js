// Probe Worker (prototype diagnostics only). Created by the same sandbox
// iframe, so it runs under the same inherited CSP, but WITHOUT the
// bootstrap's API removal, SES or Compartment. It shows whether CSP
// (connect-src 'none') and the main-process webRequest allowlist block the
// four network APIs on their own, and whether the blob Worker inherited the
// iframe's CSP at all.
(() => {
  'use strict';

  const ATTEMPT_TIMEOUT_MS = 3000;
  const violations = [];
  let started = false;

  const describeError = (error) => ({
    name: String(error?.name ?? typeof error),
    message: String(error?.message ?? error),
  });

  self.addEventListener('securitypolicyviolation', (event) => {
    violations.push({
      directive: event.effectiveDirective,
      blockedURI: String(event.blockedURI).slice(0, 200),
    });
  });

  self.addEventListener('message', (event) => {
    if (started) return;
    if (event.data?.type !== 'init' || event.ports.length !== 1) return;
    started = true;
    const port = event.ports[0];
    run(event.data.targets)
      .then((results) => {
        port.postMessage({
          type: 'probe-result',
          results,
          violations,
          info: {
            locationHref: String(location.href),
            origin: String(self.origin),
          },
        });
      })
      .catch((error) => {
        port.postMessage({
          type: 'probe-result',
          fatal: describeError(error),
          violations,
        });
      });
  });

  async function run(targets) {
    const results = {
      cspInheritance: {
        importScriptsBlob: tryImportScriptsBlob(),
        fetchBlob: await tryFetch(blobUrl('probe')),
      },
      fetch: await tryFetch(`${targets.http}/ping?from=probe-fetch`),
      xhr: await tryXhr(`${targets.http}/ping?from=probe-xhr`),
      webSocket: await tryWebSocket(`${targets.ws}/ws?from=probe-ws`),
      eventSource: await tryEventSource(`${targets.http}/sse?from=probe-sse`),
    };
    // Let securitypolicyviolation events for the last attempts arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return results;
  }

  function blobUrl(text) {
    return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  }

  function withTimeout(promise) {
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ outcome: 'timeout' }), ATTEMPT_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]);
  }

  function tryImportScriptsBlob() {
    self.__awpProbeImported = false;
    try {
      importScripts(blobUrl('self.__awpProbeImported = true;'));
      return { outcome: self.__awpProbeImported ? 'loaded' : 'not-run' };
    } catch (error) {
      return { outcome: 'blocked', error: describeError(error) };
    }
  }

  function tryFetch(url) {
    return withTimeout(
      (async () => {
        try {
          const response = await fetch(url);
          return { outcome: 'connected', status: response.status };
        } catch (error) {
          return { outcome: 'blocked', error: describeError(error) };
        }
      })(),
    );
  }

  function tryXhr(url) {
    return withTimeout(
      new Promise((resolve) => {
        try {
          const request = new XMLHttpRequest();
          request.addEventListener('load', () => {
            resolve({ outcome: 'connected', status: request.status });
          });
          request.addEventListener('error', () => {
            resolve({
              outcome: 'blocked',
              error: {
                name: 'error event',
                message: `status ${request.status}`,
              },
            });
          });
          request.open('GET', url);
          request.send();
        } catch (error) {
          resolve({ outcome: 'blocked', error: describeError(error) });
        }
      }),
    );
  }

  function tryWebSocket(url) {
    return withTimeout(
      new Promise((resolve) => {
        try {
          const socket = new WebSocket(url);
          socket.addEventListener('open', () => {
            resolve({ outcome: 'connected' });
            socket.close();
          });
          socket.addEventListener('error', () => {
            resolve({
              outcome: 'blocked',
              error: {
                name: 'error event',
                message: `readyState ${socket.readyState}`,
              },
            });
          });
        } catch (error) {
          resolve({ outcome: 'blocked', error: describeError(error) });
        }
      }),
    );
  }

  function tryEventSource(url) {
    return withTimeout(
      new Promise((resolve) => {
        try {
          const source = new EventSource(url);
          source.addEventListener('open', () => {
            resolve({ outcome: 'connected' });
            source.close();
          });
          source.addEventListener('error', () => {
            resolve({
              outcome: 'blocked',
              error: {
                name: 'error event',
                message: `readyState ${source.readyState}`,
              },
            });
            source.close();
          });
        } catch (error) {
          resolve({ outcome: 'blocked', error: describeError(error) });
        }
      }),
    );
  }
})();
