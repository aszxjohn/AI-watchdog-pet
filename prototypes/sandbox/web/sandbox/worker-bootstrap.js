// Worker bootstrap (AD-7 rule 3). Runs after the prelude, the SES unknown
// intrinsics list and SES in the same classic Worker script, in this fixed
// order: remove network / storage / worker APIs -> remove the intrinsics SES
// does not know yet -> lockdown() -> evaluate the pack entry in a Compartment
// that only gets the stage API. The stage end of the MessageChannel arrives with
// the first 'init' message (AD-7 rule 5); the iframe never relays afterwards.
(() => {
  'use strict';

  const REMOVED_APIS = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'WebTransport',
    'importScripts',
    'Worker',
    'SharedWorker',
    'indexedDB',
    'caches',
  ];
  const EVALUATE_PROBE = '[1, 2, 3].reduce((a, b) => a + b, 0)';
  const outbox = [];
  let port = null;

  const describeError = (error) => ({
    name: String(error?.name ?? typeof error),
    message: String(error?.message ?? error),
  });
  const send = (message) => {
    if (port) port.postMessage(message);
    else outbox.push(message);
  };

  send({ type: 'worker-started', info: __awpPreRemoval });

  // 1. Remove APIs before lockdown().
  const removal = {};
  for (const name of REMOVED_APIS) removal[name] = removeGlobal(name);

  // 2. Remove the intrinsics SES does not know yet, one by one (the list is
  // in ses-unknown-intrinsics.js). Nothing hides SES output: any warning
  // during lockdown() still fails (b).
  const intrinsicRemoval = __awpRemoveSesUnknownIntrinsics();

  // 3. lockdown()
  const consoleRecordsBeforeLockdown = __awpConsoleRecords.length;
  let lockdownResult;
  try {
    lockdown();
    lockdownResult = { ok: true };
  } catch (error) {
    lockdownResult = { ok: false, error: describeError(error) };
  }

  // 4. new Compartment().evaluate(...)
  let evaluateResult;
  try {
    evaluateResult = {
      ok: true,
      source: EVALUATE_PROBE,
      value: new Compartment().evaluate(EVALUATE_PROBE),
    };
  } catch (error) {
    evaluateResult = {
      ok: false,
      source: EVALUATE_PROBE,
      error: describeError(error),
    };
  }

  send({
    type: 'ses',
    lockdown: lockdownResult,
    evaluate: evaluateResult,
    intrinsicsFrozen: [
      Object.prototype,
      Array.prototype,
      Function.prototype,
      Promise.prototype,
    ].every((intrinsic) => Object.isFrozen(intrinsic)),
    consoleRecords: __awpConsoleRecords.slice(),
    consoleRecordsBeforeLockdown,
    removal,
    intrinsicRemoval,
  });

  self.addEventListener('message', (event) => {
    if (port !== null) return;
    if (event.data?.type !== 'init' || event.ports.length !== 1) return;
    port = event.ports[0];
    for (const message of outbox.splice(0)) port.postMessage(message);
    runPack(event.data.targets);
  });

  function runPack(targets) {
    // Prototype stage API: `send` plus the 127.0.0.1 targets for test (c).
    const stage = harden({
      targets: { http: String(targets.http), ws: String(targets.ws) },
      send(payload) {
        port.postMessage({
          type: 'pack',
          payload: JSON.parse(JSON.stringify(payload)),
        });
      },
    });
    const consoleRecordsBeforePack = __awpConsoleRecords.length;
    let result;
    try {
      const compartment = new Compartment({
        __options__: true,
        globals: { stage },
      });
      compartment.evaluate(__awpEntrySource);
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: describeError(error) };
    }
    port.postMessage({
      type: 'pack-evaluated',
      result,
      consoleRecords: __awpConsoleRecords.slice(consoleRecordsBeforePack),
    });
    // Pack code has no timers; give its promise/event callbacks a moment.
    setTimeout(() => {
      port.postMessage({
        type: 'done',
        consoleRecords: __awpConsoleRecords.slice(),
      });
    }, 500);
  }

  function removeGlobal(name) {
    const owners = [];
    for (
      let object = self;
      object !== null;
      object = Object.getPrototypeOf(object)
    ) {
      if (Object.prototype.hasOwnProperty.call(object, name)) {
        owners.push(object);
      }
    }
    const deleted = owners.map((owner) => Reflect.deleteProperty(owner, name));
    let shadowed = false;
    if (name in self) {
      Object.defineProperty(self, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      shadowed = true;
    }
    return {
      owners: owners.map((owner) =>
        owner === self ? 'global' : Object.prototype.toString.call(owner),
      ),
      deleted,
      shadowed,
      typeofAfter: typeof self[name],
    };
  }
})();
