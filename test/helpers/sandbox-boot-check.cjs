'use strict';

// The sandbox's positive control (Story 3.5), run by test/sandbox/build.test.ts
// in a child process: with ELECTRON_RUN_AS_NODE=1 it is the same V8 as the
// pack Worker, without the iframe or the Worker. It evaluates the built
// Worker bootstrap, starts its console count, evaluates SES (the same
// dist/ses.umd.min.js the sandbox document inlines), boots the entry and
// writes what happened as JSON to <out.json>. It prints nothing itself, so
// any byte on stdout or stderr came from SES or the bootstrap. With the
// optional last argument `print`, it prints one console line after SES has
// loaded (a negative control: the boot must then fail). Once booted, it
// also hands the pack an `init` with one own actor and one other pack's,
// then a `frame`, through the bootstrap's own routing (Story 3.6, after
// lockdown, as in the Worker) and records what it answered (`replies`).
//
//   <electron or node> sandbox-boot-check.cjs <bootstrap.js> <ses.js> <entry.js> <out.json> [print]
const fs = require('node:fs');
const vm = require('node:vm');

const [bootstrapFile, sesFile, entryFile, outFile, mode] =
  process.argv.slice(2);
const describe = (error) => ({
  name: String(error && error.name),
  message: String(error && error.message),
});

let result;
try {
  vm.runInThisContext(fs.readFileSync(bootstrapFile, 'utf8'), {
    filename: 'worker-bootstrap.js',
  });
  const worker = globalThis.__awpSandboxWorker;
  const counter = worker.countConsole();
  vm.runInThisContext(fs.readFileSync(sesFile, 'utf8'), {
    filename: 'ses.umd.min.js',
  });
  if (mode === 'print') {
    console.log('a line before lockdown');
  }
  const posted = [];
  const ownActors = new Set();
  const outcome = worker.boot(fs.readFileSync(entryFile, 'utf8'), {
    counter,
    ownActors,
    post: (call) => {
      posted.push(call);
    },
  });
  const consoleLines = counter.lines();
  const replies = [];
  if (outcome.handlers !== undefined) {
    const reply = (message) => {
      replies.push(structuredClone(message));
    };
    worker.routeStageMessage(
      {
        type: 'init',
        actors: [
          {
            own: true,
            actorId: 'a1',
            characterId: 'probe-two',
            params: { 'blink-every': 3, mood: 'busy' },
            state: 'working',
            displayName: 'check',
          },
          { own: false, actorId: 'b1', state: 'idle' },
        ],
      },
      outcome.handlers,
      ownActors,
      reply,
    );
    worker.routeStageMessage(
      {
        type: 'frame',
        seq: 0,
        t: 1000,
        dt: 0,
        actors: [{ actorId: 'a1', state: 'working' }],
        events: [],
      },
      outcome.handlers,
      ownActors,
      reply,
    );
  }
  result = {
    report: outcome.report,
    handlerKeys:
      outcome.handlers === undefined ? null : Object.keys(outcome.handlers),
    posted,
    consoleLines,
    replies,
    ownActors: [...ownActors],
    electron: process.versions.electron ?? null,
  };
} catch (error) {
  result = { error: describe(error) };
}
fs.writeFileSync(outFile, JSON.stringify(result));
