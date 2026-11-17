'use strict';

// The sandbox's positive control (Story 3.5), run by test/sandbox/build.test.ts
// in a child process: with ELECTRON_RUN_AS_NODE=1 it is the same V8 as the
// pack Worker, without the iframe or the Worker. It evaluates the built
// Worker bootstrap, starts its console count, evaluates SES (the same
// dist/ses.umd.min.js the sandbox document inlines), boots the entry and
// writes what happened as JSON to <out.json>. It prints nothing itself, so
// any byte on stdout or stderr came from SES or the bootstrap. With the
// optional last argument `print`, it prints one console line after SES has
// loaded (a negative control: the boot must then fail).
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
  const outcome = worker.boot(fs.readFileSync(entryFile, 'utf8'), {
    counter,
    post: (call) => {
      posted.push(call);
    },
  });
  result = {
    report: outcome.report,
    handlerKeys:
      outcome.handlers === undefined ? null : Object.keys(outcome.handlers),
    posted,
    consoleLines: counter.lines(),
    electron: process.versions.electron ?? null,
  };
} catch (error) {
  result = { error: describe(error) };
}
fs.writeFileSync(outFile, JSON.stringify(result));
