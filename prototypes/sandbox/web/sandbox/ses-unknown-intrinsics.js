// Intrinsics that SES does not know yet (AD-7 rule 3, decision 2026-11-05).
// SES 2.3.0 has no permit for these methods that V8 15.6 (Electron 45.2.1)
// added, so lockdown() would remove them itself and print a warning. The
// Worker bootstrap removes them one by one after the API removal and before
// lockdown(); ses-node-check.cjs evaluates this same file. This is the only
// place the list lives. After any Electron upgrade, re-run
// `npm run proto:sandbox`; if lockdown() warns again, extend the list here
// (with user sign-off). Keep this file ASCII-only: it is embedded in the
// hashed sandbox bootstrap.
const __awpSesUnknownIntrinsics = Object.freeze([
  'Iterator.prototype.join',
  'Iterator.prototype.includes',
]);

// Removes each listed property; a missing owner or property is skipped.
function __awpRemoveSesUnknownIntrinsics() {
  return __awpSesUnknownIntrinsics.map((path) => {
    const segments = path.split('.');
    const property = segments.pop();
    let owner = globalThis;
    for (const segment of segments) {
      owner =
        owner === null || owner === undefined ? undefined : owner[segment];
    }
    if (
      owner === null ||
      owner === undefined ||
      !Object.prototype.hasOwnProperty.call(owner, property)
    ) {
      return { path, status: 'absent' };
    }
    return {
      path,
      status: Reflect.deleteProperty(owner, property)
        ? 'removed'
        : 'not-deletable',
    };
  });
}
