/**
 * src/sandbox's pure parts (Story 3.5): the two removal lists, the CSP,
 * putting the document together (escaping included), the iframe's one
 * `load` (with a fake window), and the Worker bootstrap's steps (with fake
 * scopes and a fake SES). The real SES boot is in build.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { sandboxCsp } from '../../src/sandbox/csp';
import {
  checkInlineScript,
  composeSandboxDocument,
  ENTRY_SOURCE_GLOBAL,
  IFRAME_BUNDLE_GLOBAL,
  inlineScript,
  normalizeNewlines,
  sandboxHtml,
  toInlineScriptJson,
  WORKER_BUNDLE_GLOBAL,
  WORKER_SCRIPT_GLOBAL,
  workerScript,
} from '../../src/sandbox/document';
import {
  type IframeMessageEvent,
  type IframeScope,
  loadMessageSource,
  startIframe,
  workerSource,
} from '../../src/sandbox/iframe';
import {
  REMOVED_WORKER_APIS,
  SES_UNKNOWN_INTRINSICS,
} from '../../src/sandbox/lists';
import {
  boot,
  countConsole,
  createStage,
  formatLogArgs,
  removeApi,
  removeIntrinsic,
  run,
  seededRandom,
  type StageCallMessage,
} from '../../src/sandbox/worker-bootstrap';
import {
  SANDBOX_OUTBOX_MAX,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import { sandboxReportSchema } from '../../src/shared/sandbox';

const SHA = Buffer.alloc(32, 1).toString('base64');

describe('the removal lists', () => {
  it('are the ten network, storage and Worker APIs, and the two intrinsics SES 2.3.0 does not know, frozen', () => {
    expect(REMOVED_WORKER_APIS).toStrictEqual([
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
    ]);
    expect(SES_UNKNOWN_INTRINSICS).toStrictEqual([
      'Iterator.prototype.join',
      'Iterator.prototype.includes',
    ]);
    expect(Object.isFrozen(REMOVED_WORKER_APIS)).toBe(true);
    expect(Object.isFrozen(SES_UNKNOWN_INTRINSICS)).toBe(true);
  });
});

describe('sandboxCsp', () => {
  it("is the prototype's policy around the script's hash, sandboxed with scripts only, exactly", () => {
    expect(sandboxCsp(SHA)).toBe(
      `default-src 'none'; script-src 'sha256-${SHA}' 'unsafe-eval'; worker-src blob:; connect-src 'none'; sandbox allow-scripts`,
    );
  });

  it('has no frame-ancestors: the overlay frames the document', () => {
    expect(sandboxCsp(SHA)).not.toContain('frame-ancestors');
  });

  it.each([
    ['an empty string', ''],
    ['a hex digest', 'ab'.repeat(32)],
    ['a digest with a quote', `${SHA.slice(0, 42)}'=`],
    ['a digest followed by a source', `${SHA} *`],
  ])('throws on %s', (_label, sha) => {
    expect(() => sandboxCsp(sha)).toThrow(TypeError);
  });
});

describe('putting the document together', () => {
  const PARTS = {
    workerBootstrap: 'var __awpSandboxWorker = {};',
    ses: 'globalThis.lockdown = () => {}; // </script> <!-- é',
    iframe: 'var __awpSandboxIframe = { startIframe() {} };',
  };

  it('toInlineScriptJson writes <, >, & and every character from U+007F as \\uXXXX, and parses back', () => {
    const value = { text: '</script><!-- & é \u2028 😀 \u007f ok' };
    const json = toInlineScriptJson(value);

    expect(json).toMatch(/^[\x20-\x7e]*$/);
    expect(json).not.toMatch(/[<>&]/);
    expect(json).toContain('\\u003c/script\\u003e');
    expect(json).toContain('\\ud83d\\ude00');
    expect(JSON.parse(json)).toStrictEqual(value);
  });

  it('the Worker script is the bootstrap, then the console count, SES, and the run of the entry', () => {
    expect(workerScript('A\r\nB', 'S\rT')).toBe(
      [
        'A\nB',
        `${WORKER_BUNDLE_GLOBAL}.countConsole();`,
        'S\nT',
        `${WORKER_BUNDLE_GLOBAL}.run(${ENTRY_SOURCE_GLOBAL});`,
      ].join('\n;\n'),
    );
  });

  it('the inline script holds the Worker script as escaped JSON, then the iframe bundle and its start', () => {
    const script = inlineScript(PARTS);
    const [first, ...rest] = script.split('\n;\n');

    expect(first).toBe(
      `const ${WORKER_SCRIPT_GLOBAL} = ${toInlineScriptJson(
        workerScript(PARTS.workerBootstrap, PARTS.ses),
      )};`,
    );
    expect(rest).toStrictEqual([
      PARTS.iframe,
      `${IFRAME_BUNDLE_GLOBAL}.startIframe(self, ${WORKER_SCRIPT_GLOBAL});`,
      '',
    ]);
    expect(() => checkInlineScript(script)).not.toThrow();
  });

  it('a Windows checkout (CRLF) gives the same script', () => {
    const crlf = {
      workerBootstrap: 'a;\r\nb;',
      ses: 'c;\r\nd;',
      iframe: 'e;\r\nf;',
    };
    const lf = { workerBootstrap: 'a;\nb;', ses: 'c;\nd;', iframe: 'e;\nf;' };

    expect(inlineScript(crlf)).toBe(inlineScript(lf));
    expect(normalizeNewlines('x\r\ny\rz')).toBe('x\ny\nz');
  });

  it.each([
    ['</script', 'x </script> y'],
    ['</SCRIPT', 'x </SCRIPT y'],
    ['<!--', 'x <!-- y'],
    ['a non-ASCII character', 'x é y'],
    ['a carriage return left in the script', 'x \r y'],
  ])('checkInlineScript refuses %s', (_label, script) => {
    expect(() => checkInlineScript(script)).toThrow(Error);
  });

  it('refuses an iframe bundle that would break out of the script', () => {
    expect(() =>
      inlineScript({ ...PARTS, iframe: 'x = "</script>";' }),
    ).toThrow(/break out/);
    expect(() => inlineScript({ ...PARTS, iframe: 'x = "é";' })).toThrow(
      /ASCII/,
    );
  });

  it('the document is the skeleton around the script', () => {
    const { html, script } = composeSandboxDocument(PARTS);

    expect(html).toBe(sandboxHtml(script));
    expect(html).toBe(
      `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>sandbox</title></head>\n<body><script>${script}</script></body>\n</html>\n`,
    );
  });
});

/** A fake iframe window: what startIframe saw and did. */
function fakeIframe() {
  const parent = { postMessage: vi.fn() };
  const listeners: ((event: IframeMessageEvent) => void)[] = [];
  const blobs: { parts: string[]; type: string }[] = [];
  const workers: {
    url: string;
    argumentCount: number;
    posted: [unknown, unknown[]][];
    onError: (() => void)[];
  }[] = [];
  let workerThrows = false;
  const scope: IframeScope = {
    parent,
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    Blob: class {
      constructor(parts: string[], options: { type: string }) {
        blobs.push({ parts, type: options.type });
      }
    },
    URL: { createObjectURL: () => `blob:null/${blobs.length}` },
    Worker: class {
      readonly record;
      constructor(url: string, ...more: unknown[]) {
        if (workerThrows) {
          throw new Error('blocked by CSP');
        }
        this.record = {
          url,
          argumentCount: 1 + more.length,
          posted: [] as [unknown, unknown[]][],
          onError: [] as (() => void)[],
        };
        workers.push(this.record);
      }
      postMessage(message: unknown, transfer: unknown[]) {
        this.record.posted.push([message, transfer]);
      }
      addEventListener(_type: 'error', listener: () => void) {
        this.record.onError.push(listener);
      }
    },
  };
  return {
    scope,
    parent,
    blobs,
    workers,
    failWorkers() {
      workerThrows = true;
    },
    send(event: IframeMessageEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('the iframe', () => {
  const SCRIPT = '/* the Worker script */';
  const PORT = { port: 1 };

  it('loadMessageSource takes only exactly { type: "load", source }', () => {
    expect(loadMessageSource({ type: 'load', source: 'x' })).toBe('x');
    expect(loadMessageSource({ type: 'load', source: 1 })).toBeUndefined();
    expect(
      loadMessageSource({ type: 'load', source: 'x', packId: 'p' }),
    ).toBeUndefined();
    expect(loadMessageSource({ type: 'port', source: 'x' })).toBeUndefined();
    expect(loadMessageSource(null)).toBeUndefined();
    expect(loadMessageSource('load')).toBeUndefined();
  });

  it('the blob is the entry as a JSON string constant, then the Worker script', () => {
    const entry = '(function (stage) { return { "a": "</script>" }; });\u2028';
    const source = workerSource(SCRIPT, entry);

    expect(source).toBe(
      `const ${ENTRY_SOURCE_GLOBAL} = ${JSON.stringify(entry)};\n${SCRIPT}`,
    );
  });

  it('on the first load from its parent with one port: a classic Worker from a blob of the entry and the script, handed the port', () => {
    const iframe = fakeIframe();
    startIframe(iframe.scope, SCRIPT);

    iframe.send({
      source: iframe.parent,
      data: { type: 'load', source: 'ENTRY' },
      ports: [PORT],
    });

    expect(iframe.blobs).toStrictEqual([
      { parts: [workerSource(SCRIPT, 'ENTRY')], type: 'text/javascript' },
    ]);
    expect(iframe.workers).toHaveLength(1);
    expect(iframe.workers[0]?.url).toBe('blob:null/1');
    // Classic: the constructor gets the URL and no options.
    expect(iframe.workers[0]?.argumentCount).toBe(1);
    expect(iframe.workers[0]?.posted).toStrictEqual([
      [{ type: 'port' }, [PORT]],
    ]);
    expect(iframe.parent.postMessage).not.toHaveBeenCalled();
  });

  it('ignores messages from anyone but its parent, and from its parent anything but a load', () => {
    const iframe = fakeIframe();
    startIframe(iframe.scope, SCRIPT);

    iframe.send({
      source: {},
      data: { type: 'load', source: 'x' },
      ports: [PORT],
    });
    iframe.send({
      source: null,
      data: { type: 'load', source: 'x' },
      ports: [PORT],
    });
    iframe.send({
      source: iframe.parent,
      data: { type: 'ping' },
      ports: [PORT],
    });
    expect(iframe.workers).toHaveLength(0);

    iframe.send({
      source: iframe.parent,
      data: { type: 'load', source: 'ok' },
      ports: [PORT],
    });
    expect(iframe.workers).toHaveLength(1);
  });

  it.each<[string, unknown, unknown[]]>([
    ['no port', { type: 'load', source: 'x' }, []],
    ['two ports', { type: 'load', source: 'x' }, [PORT, PORT]],
    ['more than the source', { type: 'load', source: 'x', extra: 1 }, [PORT]],
    ['no source', { type: 'load' }, [PORT]],
  ])(
    'takes only the first load: a first one with %s is used up and nothing starts, and a good one after it is ignored',
    (_label, data, ports) => {
      const iframe = fakeIframe();
      startIframe(iframe.scope, SCRIPT);

      iframe.send({ source: iframe.parent, data, ports });
      iframe.send({
        source: iframe.parent,
        data: { type: 'load', source: 'late' },
        ports: [PORT],
      });

      expect(iframe.workers).toHaveLength(0);
      expect(iframe.blobs).toHaveLength(0);
    },
  );

  it('starts one Worker only, however many loads come', () => {
    const iframe = fakeIframe();
    startIframe(iframe.scope, SCRIPT);
    const load = {
      source: iframe.parent,
      data: { type: 'load', source: 'x' },
      ports: [PORT],
    };

    iframe.send(load);
    iframe.send(load);

    expect(iframe.workers).toHaveLength(1);
  });

  it('tells its parent, with nothing else, when the Worker cannot be made or fires error', () => {
    const failing = fakeIframe();
    failing.failWorkers();
    startIframe(failing.scope, SCRIPT);
    failing.send({
      source: failing.parent,
      data: { type: 'load', source: 'x' },
      ports: [PORT],
    });
    expect(failing.parent.postMessage.mock.calls).toStrictEqual([
      [{ type: 'worker-error' }, '*'],
    ]);

    const erroring = fakeIframe();
    startIframe(erroring.scope, SCRIPT);
    erroring.send({
      source: erroring.parent,
      data: { type: 'load', source: 'x' },
      ports: [PORT],
    });
    for (const listener of erroring.workers[0]?.onError ?? []) {
      listener();
    }
    expect(erroring.parent.postMessage.mock.calls).toStrictEqual([
      [{ type: 'worker-error' }, '*'],
    ]);
  });
});

describe('the Worker bootstrap: console count', () => {
  it('counts every console call from countConsole on, and still prints', () => {
    const printed: unknown[][] = [];
    const scope = {
      console: {
        log: (...args: unknown[]) => printed.push(['log', ...args]),
        warn: (...args: unknown[]) => printed.push(['warn', ...args]),
        groupCollapsed: (...args: unknown[]) =>
          printed.push(['groupCollapsed', ...args]),
      },
    };
    const counter = countConsole(scope);

    expect(counter.lines()).toBe(0);
    scope.console.warn('SES', 'Removing');
    scope.console.groupCollapsed('x');
    scope.console.log();

    expect(counter.lines()).toBe(3);
    expect(printed).toStrictEqual([
      ['warn', 'SES', 'Removing'],
      ['groupCollapsed', 'x'],
      ['log'],
    ]);
  });

  it('counts nothing on a scope without a console', () => {
    expect(countConsole({}).lines()).toBe(0);
  });
});

describe('the Worker bootstrap: removals', () => {
  it('removeApi deletes along the prototype chain: own, inherited, both', () => {
    const proto = { fetch: () => 1, both: 1 };
    const scope = Object.assign(Object.create(proto) as object, {
      XMLHttpRequest: class {},
      both: 2,
    });

    expect(removeApi(scope, 'fetch')).toStrictEqual({
      name: 'fetch',
      status: 'removed',
    });
    expect(removeApi(scope, 'XMLHttpRequest')).toStrictEqual({
      name: 'XMLHttpRequest',
      status: 'removed',
    });
    expect(removeApi(scope, 'both')).toStrictEqual({
      name: 'both',
      status: 'removed',
    });
    expect('fetch' in scope || 'XMLHttpRequest' in scope).toBe(false);
    expect('both' in scope || 'both' in proto).toBe(false);
  });

  it('removeApi reports absent when nothing had the name', () => {
    expect(removeApi({}, 'caches')).toStrictEqual({
      name: 'caches',
      status: 'absent',
    });
  });

  it('removeApi shadows with undefined what cannot be deleted from the chain', () => {
    const proto = {};
    Object.defineProperty(proto, 'Worker', {
      value: class {},
      configurable: false,
    });
    const scope = Object.create(proto) as Record<string, unknown>;

    expect(removeApi(scope, 'Worker')).toStrictEqual({
      name: 'Worker',
      status: 'removed',
    });
    expect(scope.Worker).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(scope, 'Worker')).toStrictEqual({
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  });

  it('removeApi fails when the name stays: a non-configurable own property', () => {
    const scope = {};
    Object.defineProperty(scope, 'indexedDB', {
      value: {},
      configurable: false,
    });

    expect(removeApi(scope, 'indexedDB')).toStrictEqual({
      name: 'indexedDB',
      status: 'failed',
    });
  });

  it('removeIntrinsic deletes a path from the root, skips one that is not there, and fails on one it cannot delete', () => {
    class Iterator {}
    Object.assign(Iterator.prototype, { join() {}, includes() {} });
    Object.defineProperty(Iterator.prototype, 'stuck', {
      value: 1,
      configurable: false,
    });
    const root = { Iterator };

    expect(removeIntrinsic(root, 'Iterator.prototype.join')).toStrictEqual({
      name: 'Iterator.prototype.join',
      status: 'removed',
    });
    expect('join' in Iterator.prototype).toBe(false);
    expect(removeIntrinsic(root, 'Iterator.prototype.join')).toStrictEqual({
      name: 'Iterator.prototype.join',
      status: 'absent',
    });
    expect(removeIntrinsic(root, 'Missing.prototype.join')).toStrictEqual({
      name: 'Missing.prototype.join',
      status: 'absent',
    });
    expect(removeIntrinsic(root, 'Iterator.prototype.stuck')).toStrictEqual({
      name: 'Iterator.prototype.stuck',
      status: 'failed',
    });
  });
});

describe('the Worker bootstrap: stage', () => {
  it('formatLogArgs: strings as they are, other values as text or JSON, errors as name: message, joined by spaces', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const loud = {
      toJSON() {
        throw new Error('no');
      },
    };

    expect(
      formatLogArgs([
        'a',
        1,
        true,
        null,
        undefined,
        { b: [2] },
        new RangeError('bad'),
        () => 1,
        Symbol('s'),
        10n,
      ]),
    ).toBe(
      'a 1 true null undefined {"b":[2]} RangeError: bad [function] Symbol(s) 10',
    );
    expect(formatLogArgs([circular, loud])).toBe('[unprintable] [unprintable]');
    expect(formatLogArgs([])).toBe('');
  });

  it('formatLogArgs cuts to STAGE_LOG_MAX_LENGTH, ending with …', () => {
    const text = formatLogArgs(['x'.repeat(STAGE_LOG_MAX_LENGTH + 10)]);

    expect(text).toHaveLength(STAGE_LOG_MAX_LENGTH);
    expect(text.endsWith('…')).toBe(true);
  });

  it('seededRandom: the same seed gives the same numbers, in [0, 1)', () => {
    const a = seededRandom('actor-1');
    const b = seededRandom('actor-1');
    const c = seededRandom('actor-2');
    const first = Array.from({ length: 50 }, () => a());

    expect(Array.from({ length: 50 }, () => b())).toStrictEqual(first);
    expect(Array.from({ length: 50 }, () => c())).not.toStrictEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  /** A stage over a recording post, hardened by deep freeze. */
  function stageWith(
    post: (call: StageCallMessage) => void = () => {},
    ownActors: ReadonlySet<string> = new Set(),
  ) {
    const harden = <T>(value: T): T => Object.freeze(value);
    return createStage(harden, post, ownActors) as Record<string, unknown> & {
      log(...args: unknown[]): void;
      random(actorId: unknown): number;
      fire(actorId: unknown, shot: unknown): void;
      hold(actorId: unknown, on: unknown): void;
      face(actorId: unknown, direction: unknown): void;
    };
  }

  it('has the author documentation’s methods, a null canvas, and is hardened', () => {
    const stage = stageWith();

    expect(Object.keys(stage)).toStrictEqual([
      'log',
      'random',
      'canvas',
      'fire',
      'hold',
      'face',
    ]);
    expect(stage.canvas).toBeNull();
    expect(Object.isFrozen(stage)).toBe(true);
  });

  it('log, fire, hold and face each send one stage.* call as the pack made it', () => {
    const posted: StageCallMessage[] = [];
    const stage = stageWith((call) => posted.push(call));

    stage.log('hi', 2);
    stage.fire('a1', { target: 'a2', object: 'spark' });
    stage.fire('a1', null);
    stage.hold('a1', true);
    stage.face('a1', 'left');

    expect(posted).toStrictEqual([
      { type: 'stage.log', text: 'hi 2' },
      { type: 'stage.fire', actorId: 'a1', target: 'a2', object: 'spark' },
      {
        type: 'stage.fire',
        actorId: 'a1',
        target: undefined,
        object: undefined,
      },
      { type: 'stage.hold', actorId: 'a1', on: true },
      { type: 'stage.face', actorId: 'a1', direction: 'left' },
    ]);
  });

  it('a call whose arguments cannot be sent throws a TypeError of its own', () => {
    const stage = stageWith(() => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    });

    expect(() => stage.hold('a1', () => 1)).toThrow(TypeError);
    try {
      stage.hold('a1', () => 1);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DOMException);
    }
  });

  it("random answers only for the pack's own actors (none before Story 3.6), one seed per actor", () => {
    expect(() => stageWith().random('a1')).toThrow(TypeError);
    expect(() => stageWith().random(1)).toThrow(TypeError);

    const stage = stageWith(() => {}, new Set(['a1']));
    const seeded = seededRandom('a1');
    expect([stage.random('a1'), stage.random('a1')]).toStrictEqual([
      seeded(),
      seeded(),
    ]);
  });
});

/** A fake SES on a scope: lockdown puts harden and a fresh Compartment. */
function fakeSes(
  options: {
    lockdown?: (scope: Record<string, unknown>) => void;
    evaluate?: (source: string) => unknown;
  } = {},
) {
  const order: string[] = [];
  const scope: Record<string, unknown> = {
    fetch: () => 1,
    Iterator: Object.assign(function Iterator() {}, {
      prototype: { join() {}, includes() {} },
    }),
  };
  scope.Compartment = class Untamed {
    constructor() {
      order.push('untamed Compartment');
    }
  };
  scope.lockdown = () => {
    order.push('lockdown');
    if ('fetch' in scope) {
      order.push('fetch still there');
    }
    scope.harden = <T>(value: T): T => Object.freeze(value);
    scope.Compartment = class Tamed {
      constructor(compartmentOptions: unknown) {
        order.push(`Compartment ${JSON.stringify(compartmentOptions)}`);
      }
      evaluate(source: string) {
        order.push('evaluate');
        return (options.evaluate ?? (() => () => ({})))(source);
      }
    };
    options.lockdown?.(scope);
  };
  return { scope, order };
}

// The Worker bootstrap's boot, over a fake SES.
describe('I/O matrix', () => {
  const counter = (lines = 0) => ({ lines: () => lines });

  it('移除清單: removes the lists before lockdown(), then evaluates the entry in a Compartment made after it, and calls the factory with stage', () => {
    const factory = vi.fn(() => ({ frame() {} }));
    const ses = fakeSes({ evaluate: () => factory });

    const outcome = boot('ENTRY', {
      scope: ses.scope,
      counter: counter(),
      post: () => {},
    });

    expect(ses.order).toStrictEqual([
      'lockdown',
      'Compartment {"__options__":true}',
      'evaluate',
    ]);
    expect(outcome.report).toStrictEqual({
      type: 'sandbox.ready',
      removals: [
        ...REMOVED_WORKER_APIS.map((name) => ({
          name,
          status: name === 'fetch' ? 'removed' : 'absent',
        })),
        { name: 'Iterator.prototype.join', status: 'removed' },
        { name: 'Iterator.prototype.includes', status: 'removed' },
      ],
      consoleLines: 0,
    });
    expect(sandboxReportSchema.safeParse(outcome.report).success).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen((factory.mock.calls[0] as unknown[])[0])).toBe(true);
    expect(outcome.handlers).toStrictEqual({ frame: expect.any(Function) });
    expect('fetch' in ses.scope).toBe(false);
  });

  it('lockdown: a console line up to the end of lockdown() fails the boot before the entry runs', () => {
    const ses = fakeSes();

    const outcome = boot('ENTRY', {
      scope: ses.scope,
      counter: counter(3),
      post: () => {},
    });

    expect(outcome.report).toMatchObject({
      type: 'sandbox.failed',
      reason: 'lockdown-output',
      consoleLines: 3,
    });
    expect(ses.order).toStrictEqual(['lockdown']);
    expect(outcome.handlers).toBeUndefined();
  });

  it('lockdown: lockdown() throwing fails the boot', () => {
    const ses = fakeSes({
      lockdown: () => {
        throw new TypeError('no');
      },
    });

    expect(
      boot('ENTRY', { scope: ses.scope, counter: counter(), post: () => {} })
        .report,
    ).toMatchObject({ type: 'sandbox.failed', reason: 'lockdown-threw' });
  });

  it('lockdown: fails as ses-missing without lockdown, or without harden or Compartment after it', () => {
    expect(
      boot('ENTRY', { scope: {}, counter: counter(), post: () => {} }).report,
    ).toMatchObject({ type: 'sandbox.failed', reason: 'ses-missing' });

    const ses = fakeSes({
      lockdown: (scope) => {
        delete scope.harden;
      },
    });
    expect(
      boot('ENTRY', { scope: ses.scope, counter: counter(), post: () => {} })
        .report,
    ).toMatchObject({ type: 'sandbox.failed', reason: 'ses-missing' });
  });

  it('移除清單: an API that stays fails the boot before lockdown()', () => {
    const ses = fakeSes();
    Object.defineProperty(ses.scope, 'WebSocket', {
      value: class {},
      configurable: false,
    });

    const outcome = boot('ENTRY', {
      scope: ses.scope,
      counter: counter(),
      post: () => {},
    });

    expect(outcome.report).toMatchObject({
      type: 'sandbox.failed',
      reason: 'api-removal-failed',
    });
    expect(
      (outcome.report as unknown as { removals: unknown[] }).removals,
    ).toContainEqual({ name: 'WebSocket', status: 'failed' });
    expect(ses.order).toStrictEqual([]);
  });

  it('移除清單: an intrinsic that stays fails the boot before lockdown()', () => {
    const ses = fakeSes();
    Object.defineProperty(
      (ses.scope.Iterator as { prototype: object }).prototype,
      'includes',
      { value: () => false, configurable: false },
    );

    expect(
      boot('ENTRY', { scope: ses.scope, counter: counter(), post: () => {} })
        .report,
    ).toMatchObject({
      type: 'sandbox.failed',
      reason: 'intrinsic-removal-failed',
    });
    expect(ses.order).toStrictEqual([]);
  });

  it.each<[string, (source: string) => unknown, string]>([
    [
      'evaluating throws',
      () => {
        throw new SyntaxError('x');
      },
      'entry-threw',
    ],
    [
      'the value is not a function',
      () => ({ frame() {} }),
      'entry-not-factory',
    ],
    [
      'the factory throws',
      () => () => {
        throw new Error('x');
      },
      'factory-threw',
    ],
    [
      'the factory returns no object',
      () => () => 'handlers',
      'handlers-not-object',
    ],
    ['the factory returns null', () => () => null, 'handlers-not-object'],
    ['the factory returns an array', () => () => [], 'handlers-not-object'],
    [
      'the factory is async (it returns a promise)',
      () => async () => ({ frame() {} }),
      'handlers-not-object',
    ],
    // A pack's factory may hand back a thenable; that is what these test.
    [
      'the factory returns a thenable',
      // oxlint-disable-next-line unicorn/no-thenable
      () => () => ({ then() {}, frame() {} }),
      'handlers-not-object',
    ],
    [
      'the factory returns an object whose then getter throws',
      () => () => ({
        // oxlint-disable-next-line unicorn/no-thenable
        get then() {
          throw new Error('no');
        },
      }),
      'handlers-not-object',
    ],
  ])('入口: not ready when %s', (_label, evaluate, reason) => {
    const ses = fakeSes({ evaluate });

    const outcome = boot('ENTRY', {
      scope: ses.scope,
      counter: counter(),
      post: () => {},
    });

    expect(outcome.report).toMatchObject({ type: 'sandbox.failed', reason });
    expect(outcome.handlers).toBeUndefined();
  });
});

/** A fake Worker global scope for run(): listeners and a console. */
function fakeWorker(evaluate?: (source: string) => unknown) {
  const ses = fakeSes({ evaluate });
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  Object.assign(ses.scope, {
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    console: { log: () => {} },
  });
  const emit = (type: string, event: unknown = {}) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  return { scope: ses.scope, emit };
}

describe('the Worker bootstrap: run', () => {
  it('keeps the report until the port comes, then sends it first, before the calls the factory made; later calls go straight out', () => {
    const worker = fakeWorker(() => (stage: { log(text: string): void }) => {
      stage.log('in the factory');
      return {};
    });
    countConsole(worker.scope);
    const outcome = run('ENTRY', worker.scope);
    const sent: unknown[] = [];
    const port = { postMessage: (message: unknown) => sent.push(message) };

    // Not the port message: ignored.
    worker.emit('message', { data: { type: 'load' }, ports: [port] });
    worker.emit('message', { data: { type: 'port' }, ports: [] });
    expect(sent).toStrictEqual([]);

    worker.emit('message', { data: { type: 'port' }, ports: [port] });
    expect(sent).toStrictEqual([
      outcome.report,
      { type: 'stage.log', text: 'in the factory' },
    ]);
    expect(outcome.report).toMatchObject({ type: 'sandbox.ready' });

    // A second port is ignored; uncaught trouble is reported once.
    const other = { postMessage: vi.fn() };
    worker.emit('message', { data: { type: 'port' }, ports: [other] });
    worker.emit('error');
    worker.emit('unhandledrejection');
    worker.emit('error');
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(sent.slice(2)).toStrictEqual([
      { type: 'sandbox.fault', fault: 'error' },
    ]);
  });

  it('reports a fault only once, also while the port has not come', () => {
    const worker = fakeWorker();
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    for (let i = 0; i < 1000; i += 1) {
      worker.emit(i % 2 === 0 ? 'unhandledrejection' : 'error');
    }
    const sent: { type: string }[] = [];

    worker.emit('message', {
      data: { type: 'port' },
      ports: [
        { postMessage: (message: { type: string }) => sent.push(message) },
      ],
    });

    expect(sent).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.ready' }),
      { type: 'sandbox.fault', fault: 'unhandled-rejection' },
    ]);
  });

  it(`keeps at most ${SANDBOX_OUTBOX_MAX} calls before the port, but always the reports`, () => {
    const worker = fakeWorker(() => (stage: { log(text: string): void }) => {
      for (let i = 0; i < SANDBOX_OUTBOX_MAX + 10; i += 1) {
        stage.log(String(i));
      }
      return {};
    });
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    worker.emit('error');
    const sent: { type: string }[] = [];

    worker.emit('message', {
      data: { type: 'port' },
      ports: [
        { postMessage: (message: { type: string }) => sent.push(message) },
      ],
    });

    expect(sent.filter((m) => m.type === 'stage.log')).toHaveLength(
      SANDBOX_OUTBOX_MAX,
    );
    expect(sent[0]?.type).toBe('sandbox.ready');
    expect(sent.filter((m) => m.type.startsWith('sandbox.'))).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.ready' }),
      { type: 'sandbox.fault', fault: 'error' },
    ]);
  });

  it('a call whose arguments cannot be cloned throws at the call, before the port is there', () => {
    let thrown: unknown;
    const worker = fakeWorker(
      () => (stage: { hold(actorId: string, on: unknown): void }) => {
        try {
          stage.hold('a1', () => true);
        } catch (error) {
          thrown = error;
        }
        return {};
      },
    );
    countConsole(worker.scope);
    run('ENTRY', worker.scope);

    expect(thrown).toBeInstanceOf(TypeError);
  });
});
