// Worker prelude: first part of the pack Worker script, evaluated before SES.
// Prototype instrumentation only. It records every console call so the gate
// can show that loading SES and lockdown() printed nothing, and it records
// facts that the bootstrap's API removal erases (e.g. importScripts, which
// only exists in classic Workers). The top-level consts are shared with
// worker-bootstrap.js (same classic script) and are not visible to code
// running inside a Compartment.
const __awpConsoleRecords = [];
const __awpPreRemoval = {
  scope: Object.prototype.toString.call(self),
  locationHref: String(self.location.href),
  origin: String(self.origin),
  isSecureContext: self.isSecureContext,
  importScriptsType: typeof self.importScripts,
};

(() => {
  'use strict';

  const levels = [
    'debug',
    'log',
    'info',
    'warn',
    'error',
    'trace',
    'dir',
    'dirxml',
    'table',
    'group',
    'groupCollapsed',
    'groupEnd',
    'assert',
    'count',
    'time',
    'timeLog',
    'timeEnd',
  ];
  const target = self.console;
  const toText = (value) => {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  for (const level of levels) {
    const original = target[level];
    if (typeof original !== 'function') continue;
    target[level] = function (...args) {
      __awpConsoleRecords.push({
        seq: __awpConsoleRecords.length,
        level,
        text: args.map(toText).join(' ').slice(0, 2000),
      });
      return Reflect.apply(original, target, args);
    };
  }
})();
