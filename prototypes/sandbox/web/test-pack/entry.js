// Test pack for the Story 1.2 sandbox prototype. The Worker bootstrap
// evaluates this file as a script with Compartment#evaluate; `stage` is the
// only endowment. Every network attempt below is expected to throw.
stage.send({ kind: 'hello', sum: [1, 2, 3].reduce((a, b) => a + b, 0) });
stage.send({ kind: 'globals', ...listGlobals() });
stage.send({ kind: 'network', attempts: probeNetwork(stage.targets) });

function listGlobals() {
  const names = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'WebTransport',
    'importScripts',
    'Worker',
    'indexedDB',
    'caches',
    'self',
    'postMessage',
    'console',
    'setTimeout',
  ];
  const types = {};
  for (const name of names) types[name] = typeof globalThis[name];
  return {
    types,
    // The Function constructor evaluates in this Compartment's scope too.
    fetchViaFunctionConstructor: Function('return typeof fetch')(),
  };
}

function probeNetwork(targets) {
  return {
    fetch: attempt('fetch', () =>
      fetch(`${targets.http}/ping?from=pack-fetch`),
    ),
    xhr: attempt('xhr', () => {
      const request = new XMLHttpRequest();
      request.open('GET', `${targets.http}/ping?from=pack-xhr`);
      request.send();
      return request;
    }),
    webSocket: attempt(
      'webSocket',
      () => new WebSocket(`${targets.ws}/ws?from=pack-ws`),
    ),
    eventSource: attempt(
      'eventSource',
      () => new EventSource(`${targets.http}/sse?from=pack-sse`),
    ),
  };
}

function attempt(api, open) {
  try {
    const handle = open();
    watch(api, handle);
    return {
      outcome: 'returned',
      valueType: Object.prototype.toString.call(handle),
    };
  } catch (error) {
    return {
      outcome: 'threw',
      error: { name: String(error?.name), message: String(error?.message) },
    };
  }
}

// Only reached if an API unexpectedly exists: report what happens later.
function watch(api, handle) {
  const report = (connected, detail) => {
    stage.send({
      kind: 'network-late',
      api,
      connected,
      detail: String(detail),
    });
  };
  if (handle && typeof handle.then === 'function') {
    handle.then(
      (response) => report(true, response?.status),
      (error) => report(false, error?.message),
    );
    return;
  }
  if (handle && typeof handle.addEventListener === 'function') {
    for (const type of ['load', 'open', 'message']) {
      handle.addEventListener(type, () => report(true, type));
    }
    handle.addEventListener('error', () => report(false, 'error'));
  }
}
