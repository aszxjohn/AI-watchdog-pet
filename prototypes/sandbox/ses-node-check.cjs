'use strict';

// Supplementary evidence for (b). The orchestrator runs this file with
// ELECTRON_RUN_AS_NODE=1, i.e. on the same V8 as the sandbox Worker but
// without any iframe or Worker. It removes the list in
// web/sandbox/ses-unknown-intrinsics.js (skipped with --proto-remove=off,
// which reproduces the first-round warning), then runs require('ses') and
// lockdown(). It prints nothing itself and writes its result to --proto-out,
// so any byte on stdout or stderr is SES output.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readArg = (name) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg === undefined ? null : arg.slice(prefix.length);
};

const out = readArg('proto-out');
const removeList = readArg('proto-remove') !== 'off';
const describeError = (error) => ({
  name: String(error?.name),
  message: String(error?.message),
});
const result = {
  electron: process.versions.electron ?? null,
  v8: process.versions.v8,
  removeList,
  removal: null,
  intrinsicRemoval: null,
  lockdown: null,
};

// Reading/applying the list and lockdown() are reported separately.
if (removeList) {
  try {
    const file = path.join(
      __dirname,
      'web',
      'sandbox',
      'ses-unknown-intrinsics.js',
    );
    const removeIntrinsics = vm.runInThisContext(
      `${fs.readFileSync(file, 'utf8')}\n;__awpRemoveSesUnknownIntrinsics;`,
      { filename: file },
    );
    result.intrinsicRemoval = removeIntrinsics();
    result.removal = { ok: true };
  } catch (error) {
    result.removal = { ok: false, error: describeError(error) };
  }
}

try {
  require('ses');
  lockdown();
  result.lockdown = { ok: true };
} catch (error) {
  result.lockdown = { ok: false, error: describeError(error) };
}

fs.writeFileSync(out, JSON.stringify(result));
