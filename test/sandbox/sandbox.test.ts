/**
 * src/sandbox's pure parts (Story 3.5): the two removal lists, the CSP,
 * putting the document together (escaping included), the iframe's one
 * `load` (with a fake window), and the Worker bootstrap's steps (with fake
 * scopes and a fake SES). The real SES boot is in build.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  bitmapBrandOf,
  boot,
  canvasMakerOf,
  countConsole,
  createStage,
  formatLogArgs,
  type OwnActor,
  removeApi,
  removeIntrinsic,
  run,
  seededRandom,
  type StageBitmaps,
  type StageCallMessage,
} from '../../src/sandbox/worker-bootstrap';
import {
  BITMAP_MAX_SIDE,
  PACK_MESSAGE_MAX_BYTES,
  SANDBOX_OUTBOX_MAX,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import { sandboxReportSchema } from '../../src/shared/sandbox';
import {
  FakeImageBitmap,
  fakeOffscreenCanvas,
  stubImageBitmap,
} from '../helpers/fake-bitmaps';

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

/** Own actors by id, each with its character. */
function ownOf(characters: Record<string, string>): Map<string, OwnActor> {
  return new Map(
    Object.entries(characters).map(([actorId, characterId]) => [
      actorId,
      { characterId },
    ]),
  );
}

/** The stage a pack gets, as far as these tests call it. */
type TestStage = Record<string, unknown> & {
  log(...args: unknown[]): void;
  random(actorId: unknown): number;
  canvas(actorId: unknown, width: unknown, height: unknown): object;
  snapshot(actorId: unknown): unknown;
  fire(actorId: unknown, shot: unknown): void;
  hold(actorId: unknown, on: unknown): void;
  face(actorId: unknown, direction: unknown): void;
};

/** A stage over a recording post, hardened by deep freeze. */
function stageWith(
  post: (call: StageCallMessage) => void = () => {},
  ownActors: ReadonlyMap<string, OwnActor> = new Map(),
  bitmaps?: StageBitmaps,
): TestStage {
  const harden = <T>(value: T): T => Object.freeze(value);
  return createStage(harden, post, ownActors, bitmaps) as TestStage;
}

/** A list nested `depth` lists deep (itself the first): [[[…]]]. */
function nestedLists(depth: number): unknown[] {
  let list: unknown[] = [];
  for (let i = 1; i < depth; i += 1) {
    list = [list];
  }
  return list;
}

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

  it('has the author documentation’s methods, canvas and snapshot among them, and is hardened', () => {
    const stage = stageWith();

    expect(Object.keys(stage)).toStrictEqual([
      'log',
      'random',
      'canvas',
      'snapshot',
      'fire',
      'hold',
      'face',
    ]);
    expect(typeof stage.canvas).toBe('function');
    expect(typeof stage.snapshot).toBe('function');
    expect(Object.isFrozen(stage)).toBe(true);
  });

  it('log, fire, hold and face each send one stage.* call as the pack made it; a fire without its shot leaves target and object undefined, which cannot be copied: a TypeError, nothing sent', () => {
    const posted: StageCallMessage[] = [];
    const stage = stageWith((call) => posted.push(call));

    stage.log('hi', 2);
    stage.fire('a1', { target: 'a2', object: 'spark' });
    expect(() => {
      stage.fire('a1', null);
    }).toThrow(TypeError);
    stage.hold('a1', true);
    stage.face('a1', 'left');

    expect(posted).toStrictEqual([
      { type: 'stage.log', text: 'hi 2' },
      { type: 'stage.fire', actorId: 'a1', target: 'a2', object: 'spark' },
      { type: 'stage.hold', actorId: 'a1', on: true },
      { type: 'stage.face', actorId: 'a1', direction: 'left' },
    ]);
  });

  it('a call post cannot send throws a TypeError of its own, not post’s DOMException; one whose arguments cannot be copied never reaches post', () => {
    const post = vi.fn(() => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    });
    const stage = stageWith(post);

    let thrown: unknown;
    try {
      stage.hold('a1', true);
    } catch (error) {
      thrown = error;
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(DOMException);

    post.mockClear();
    expect(() => stage.hold('a1', () => 1)).toThrow(TypeError);
    expect(post).not.toHaveBeenCalled();
  });

  it("random answers only for the pack's own actors (none before Story 3.6), one seed per actor", () => {
    expect(() => stageWith().random('a1')).toThrow(TypeError);
    expect(() => stageWith().random(1)).toThrow(TypeError);

    const stage = stageWith(() => {}, ownOf({ a1: 'probe-one' }));
    const seeded = seededRandom('a1');
    expect([stage.random('a1'), stage.random('a1')]).toStrictEqual([
      seeded(),
      seeded(),
    ]);
  });
});

// The bitmap canvases (Story 3.6's last part), over a fake OffscreenCanvas:
// a1 plays probe-one, which has advancedBitmap, a2 probe-two, which has not.
describe('I/O matrix', () => {
  function bitmapStage(fake = fakeOffscreenCanvas()) {
    const ownActors = ownOf({ a1: 'probe-one', a2: 'probe-two' });
    const makeCanvas = canvasMakerOf({ OffscreenCanvas: fake.OffscreenCanvas });
    const stage = stageWith(() => {}, ownActors, {
      characters: new Set(['probe-one']),
      makeCanvas,
    });
    return { stage, fake, ownActors, makeCanvas };
  }

  it('只允許 2d: canvasMakerOf takes the canvas getter off the 2d context, so the context the pack gets leads to no canvas (nor its constructor, nor webgl)', () => {
    const { stage, fake, makeCanvas } = bitmapStage();

    expect(makeCanvas).toBeDefined();
    const context = stage.canvas('a1', 64, 32) as Record<string, unknown>;
    expect(context.canvas).toBeUndefined();
    expect('canvas' in context).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(fake.contextPrototype, 'canvas'),
    ).toBeUndefined();
    // A 1 x 1 probe at boot, then the actor's: both by the kept constructor.
    expect(fake.made.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [1, 1],
      [64, 32],
    ]);
  });

  it.each<[string, () => unknown]>([
    [
      'its canvas getter cannot be taken off',
      () => fakeOffscreenCanvas({ lockedCanvasGetter: true }).OffscreenCanvas,
    ],
    [
      'it gives no 2d context',
      () => fakeOffscreenCanvas({ no2d: true }).OffscreenCanvas,
    ],
    [
      'its constructor throws',
      () =>
        function Throwing() {
          throw new Error('no canvas');
        },
    ],
    ['it is not a constructor', () => 'OffscreenCanvas'],
  ])(
    '只允許 2d: no canvas maker when the OffscreenCanvas is there but %s; then stage.canvas throws a TypeError',
    (_label, make) => {
      const makeCanvas = canvasMakerOf({ OffscreenCanvas: make() });
      expect(makeCanvas).toBeUndefined();

      const stage = stageWith(() => {}, ownOf({ a1: 'probe-one' }), {
        characters: new Set(['probe-one']),
        makeCanvas,
      });
      expect(() => stage.canvas('a1', 8, 8)).toThrow(TypeError);
    },
  );

  it('沒有 OffscreenCanvas: no canvas maker; stage.canvas throws a TypeError even for an actor whose character has advancedBitmap, and snapshot too', () => {
    expect(canvasMakerOf({})).toBeUndefined();

    const stage = stageWith(() => {}, ownOf({ a1: 'probe-one' }), {
      characters: new Set(['probe-one']),
    });
    expect(() => stage.canvas('a1', 8, 8)).toThrow(TypeError);
    expect(() => stage.snapshot('a1')).toThrow(TypeError);
  });

  it('bitmap 出現: stage.canvas makes the actor’s canvas at its first call and gives its context; the same size again gives the same context, uncleared; another size resizes it (cleared)', () => {
    const { stage, fake, ownActors } = bitmapStage();

    const first = stage.canvas('a1', 64, 64);
    const canvas = fake.made[1];
    expect(ownActors.get('a1')?.canvas?.context).toBe(first);
    expect(stage.canvas('a1', 64, 64)).toBe(first);
    expect(canvas?.clears).toBe(0);

    expect(stage.canvas('a1', 128, 32)).toBe(first);
    expect([canvas?.width, canvas?.height]).toStrictEqual([128, 32]);
    expect(canvas?.clears).toBe(2);
    expect(fake.made).toHaveLength(2);
  });

  it('bitmap 出現: stage.snapshot gives the ImageBitmap of what the canvas holds and clears it (once a frame: routing.test.ts has the frames)', () => {
    const { stage, fake } = bitmapStage();
    stage.canvas('a1', 48, 40);
    const canvas = fake.made[1];

    const first = stage.snapshot('a1');

    // By identity: FakeImageBitmaps keep their size private.
    expect(canvas?.bitmaps).toHaveLength(1);
    expect(canvas?.bitmaps[0]).toBe(first);
    expect(first).toMatchObject({ width: 48, height: 40 });
    expect(canvas?.clears).toBe(1);
  });

  it.each<[string, (stage: TestStage) => unknown]>([
    ['canvas for another pack’s actor', (stage) => stage.canvas('b1', 8, 8)],
    ['canvas for no actor id', (stage) => stage.canvas(undefined, 8, 8)],
    ['canvas 0 wide', (stage) => stage.canvas('a1', 0, 8)],
    ['canvas 0 high', (stage) => stage.canvas('a1', 8, 0)],
    [
      `canvas wider than ${BITMAP_MAX_SIDE}`,
      (stage) => stage.canvas('a1', BITMAP_MAX_SIDE + 1, 8),
    ],
    [
      `canvas higher than ${BITMAP_MAX_SIDE}`,
      (stage) => stage.canvas('a1', 8, BITMAP_MAX_SIDE + 1),
    ],
    ['canvas of a fractional size', (stage) => stage.canvas('a1', 8.5, 8)],
    ['canvas of a size as a string', (stage) => stage.canvas('a1', '8', 8)],
    [
      'canvas of no size',
      (stage) => Reflect.apply(stage.canvas, stage, ['a1']),
    ],
    ['snapshot before canvas', (stage) => stage.snapshot('a1')],
    ['snapshot for another pack’s actor', (stage) => stage.snapshot('b1')],
  ])('參數不對: %s throws a TypeError', (_label, call) => {
    const { stage, fake } = bitmapStage();

    expect(() => call(stage)).toThrow(TypeError);
    // Only the probe: nothing was made.
    expect(fake.made).toHaveLength(1);
  });

  it(`參數不對: 1 and ${BITMAP_MAX_SIDE} are sizes it takes`, () => {
    const { stage, fake } = bitmapStage();

    stage.canvas('a1', 1, BITMAP_MAX_SIDE);
    expect([fake.made[1]?.width, fake.made[1]?.height]).toStrictEqual([
      1,
      BITMAP_MAX_SIDE,
    ]);
  });

  it('沒宣告的角色: stage.canvas throws a TypeError for an actor whose character has no advancedBitmap; it has no canvas, so snapshot throws too', () => {
    const { stage, fake } = bitmapStage();

    expect(() => stage.canvas('a2', 8, 8)).toThrow(TypeError);
    expect(() => stage.snapshot('a2')).toThrow(TypeError);
    expect(fake.made).toHaveLength(1);
  });

  it('參數不對: a canvas that cannot be made or read throws a TypeError of the stage’s own', () => {
    const throwing = stageWith(() => {}, ownOf({ a1: 'probe-one' }), {
      characters: new Set(['probe-one']),
      makeCanvas: () => {
        throw new RangeError('out of memory');
      },
    });
    expect(() => throwing.canvas('a1', 8, 8)).toThrow(TypeError);

    const unreadable = stageWith(() => {}, ownOf({ a1: 'probe-one' }), {
      characters: new Set(['probe-one']),
      makeCanvas: () => ({
        canvas: {
          width: 8,
          height: 8,
          transferToImageBitmap: () => {
            throw new DOMException('detached', 'InvalidStateError');
          },
        },
        context: {},
      }),
    });
    unreadable.canvas('a1', 8, 8);
    expect(() => unreadable.snapshot('a1')).toThrow(TypeError);
    try {
      unreadable.snapshot('a1');
    } catch (error) {
      expect(error).not.toBeInstanceOf(DOMException);
    }
  });

  it('snapshot 次數: a snapshot whose canvas cannot be read (transferToImageBitmap throws) is not counted: the next call in the same frame still gives a bitmap, and only the one after that is refused', () => {
    let reads = 0;
    const bitmap = new FakeImageBitmap(8, 8);
    const stage = stageWith(() => {}, ownOf({ a1: 'probe-one' }), {
      characters: new Set(['probe-one']),
      makeCanvas: () => ({
        canvas: {
          width: 8,
          height: 8,
          transferToImageBitmap: () => {
            reads += 1;
            if (reads === 1) {
              throw new DOMException('not now', 'InvalidStateError');
            }
            return bitmap;
          },
        },
        context: {},
      }),
    });
    stage.canvas('a1', 8, 8);

    expect(() => stage.snapshot('a1')).toThrow(TypeError);
    expect(stage.snapshot('a1')).toBe(bitmap);
    expect(() => stage.snapshot('a1')).toThrow(TypeError);
    // The refused third call never reached the canvas.
    expect(reads).toBe(2);
  });
});

// What a stage.* call may carry (Story 3.6's last part, review 2): the
// call is copied into plain data, and an ImageBitmap is told by the brand
// check of ImageBitmap's `width` getter (bitmapBrandOf). FakeImageBitmap
// keeps its size private, so its `width` getter checks the brand too.
describe('I/O matrix', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs `change` with FakeImageBitmap's prototype changed as a pack could. */
  function withForgedGetter(change: () => void): void {
    const width = Object.getOwnPropertyDescriptor(
      FakeImageBitmap.prototype,
      'width',
    ) as PropertyDescriptor;
    try {
      // A getter that answers for anything, and an instanceof that says no.
      Object.defineProperty(FakeImageBitmap.prototype, 'width', {
        get: () => 8,
        configurable: true,
      });
      Object.defineProperty(FakeImageBitmap, Symbol.hasInstance, {
        value: () => false,
        configurable: true,
      });
      change();
    } finally {
      Object.defineProperty(FakeImageBitmap.prototype, 'width', width);
      Reflect.deleteProperty(FakeImageBitmap, Symbol.hasInstance);
    }
  }

  it('藏圖的寫法: bitmapBrandOf tells an ImageBitmap by its width getter, kept when it is called: one whose prototype was changed (to Object.prototype, to null) or that was closed is one, even once the getter on the prototype and instanceof are forged; a look-alike on its prototype, a Proxy of one, a plain object or a primitive is not', () => {
    stubImageBitmap();
    const isBitmap = bitmapBrandOf(globalThis);
    const image = new FakeImageBitmap();
    const plain = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Object.prototype,
    );
    const bare = Object.setPrototypeOf(new FakeImageBitmap(), null);
    const closed = new FakeImageBitmap();
    closed.close();

    withForgedGetter(() => {
      const lookAlike = Object.create(FakeImageBitmap.prototype) as object;
      expect(image instanceof FakeImageBitmap).toBe(false);
      expect((lookAlike as { width: number }).width).toBe(8);
      for (const value of [image, plain, bare, closed]) {
        expect(isBitmap(value)).toBe(true);
      }
      for (const value of [
        lookAlike,
        new Proxy(image, {}),
        { width: 8, height: 8, close() {} },
        {},
        [],
        null,
        undefined,
        8,
        'ImageBitmap',
      ]) {
        expect(isBitmap(value)).toBe(false);
      }
    });
  });

  it.each<[string, () => object]>([
    ['no ImageBitmap', () => ({})],
    ['an ImageBitmap that is not a function', () => ({ ImageBitmap: {} })],
    [
      'an ImageBitmap without a width getter',
      () => ({ ImageBitmap: class NoWidth {} }),
    ],
  ])('藏圖的寫法: a scope with %s tells no ImageBitmap', (_label, scope) => {
    stubImageBitmap();
    const isBitmap = bitmapBrandOf(scope());

    expect(isBitmap(new FakeImageBitmap())).toBe(false);
    expect(isBitmap({})).toBe(false);
  });

  it('stage.* 帶圖: fire, hold or face with an ImageBitmap among its arguments (its prototype changed or not), or with a value that cannot be copied (undefined, a function, a Map, a cycle, nested too deep, too large, also in UTF-8 bytes only), throws a TypeError of the stage’s own at the call, and nothing is posted', () => {
    stubImageBitmap();
    const posted: StageCallMessage[] = [];
    const stage = stageWith((call) => posted.push(call), new Map(), {
      characters: new Set(),
      isBitmap: bitmapBrandOf(globalThis),
    });
    const image = new FakeImageBitmap();
    const disguised = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Object.prototype,
    ) as object;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const calls: [string, () => void][] = [
      ['fire, image as target', () => stage.fire('a1', { target: image })],
      [
        'fire, disguised image as object',
        () => stage.fire('a1', { target: 'a2', object: disguised }),
      ],
      ['hold, image as on', () => stage.hold('a1', image)],
      ['hold, image as actorId', () => stage.hold(image, true)],
      ['face, disguised image', () => stage.face('a1', disguised)],
      ['face, image deep in a list', () => stage.face('a1', [{ image }])],
      ['hold, undefined', () => stage.hold('a1', undefined)],
      ['hold, a function', () => stage.hold('a1', () => true)],
      ['face, a Map', () => stage.face('a1', new Map([['x', image]]))],
      ['hold, a cycle', () => stage.hold('a1', cycle)],
      [
        'face, too large',
        () => stage.face('a1', 'x'.repeat(PACK_MESSAGE_MAX_BYTES)),
      ],
      [
        // 40000 characters, under the limit; 80000 bytes in UTF-8, over it.
        'face, too large in UTF-8 bytes only',
        () => stage.face('a1', 'é'.repeat(40_000)),
      ],
      ['hold, nested too deep', () => stage.hold('a1', nestedLists(30_000))],
    ];

    for (const [label, call] of calls) {
      let thrown: unknown;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(TypeError);
      expect(thrown, label).not.toBeInstanceOf(DOMException);
    }
    expect(posted).toStrictEqual([]);
    expect(image.closes).toBe(0);
  });

  it('stage.* 帶圖: what is posted is a copy, read once: a getter runs once, and the argument changed after the call changes nothing posted', () => {
    const posted: StageCallMessage[] = [];
    const stage = stageWith((call) => posted.push(call));
    let reads = 0;
    const shot = {
      get target() {
        reads += 1;
        return reads === 1 ? 'a2' : 'a3';
      },
      object: 'spark',
    };
    const on = { deep: [1, 'two'] };

    stage.fire('a1', shot);
    stage.hold('a1', on);
    on.deep.push(3);

    expect(reads).toBe(1);
    expect(posted).toStrictEqual([
      { type: 'stage.fire', actorId: 'a1', target: 'a2', object: 'spark' },
      { type: 'stage.hold', actorId: 'a1', on: { deep: [1, 'two'] } },
    ]);
    expect(posted[1]?.on).not.toBe(on);
  });

  it('stage.* 帶圖: boot keeps the brand check before lockdown(), and gives it to the stage and in its outcome: a width getter forged after (as the pack could, once its code runs) fools neither', () => {
    const width = Object.getOwnPropertyDescriptor(
      FakeImageBitmap.prototype,
      'width',
    ) as PropertyDescriptor;
    const disguised = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Object.prototype,
    ) as object;
    const posted: StageCallMessage[] = [];
    let thrown: unknown;
    try {
      const ses = fakeSes({
        lockdown: () => {
          Object.defineProperty(FakeImageBitmap.prototype, 'width', {
            get: () => 8,
            configurable: true,
          });
        },
        evaluate: () => (stage: TestStage) => {
          try {
            stage.hold('a1', disguised);
          } catch (error) {
            thrown = error;
          }
          return {};
        },
      });
      ses.scope.ImageBitmap = FakeImageBitmap;

      const outcome = boot('ENTRY', {
        scope: ses.scope,
        counter: { lines: () => 0 },
        post: (call) => posted.push(call),
      });

      expect(outcome.report).toMatchObject({ type: 'sandbox.ready' });
      expect(thrown).toBeInstanceOf(TypeError);
      expect(posted).toStrictEqual([]);
      expect(outcome.isBitmap?.(disguised)).toBe(true);
      expect(
        outcome.isBitmap?.(Object.create(FakeImageBitmap.prototype) as object),
      ).toBe(false);
    } finally {
      Object.defineProperty(FakeImageBitmap.prototype, 'width', width);
    }
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

// The boot with a 2d canvas (Story 3.6's last part), over a fake SES.
describe('I/O matrix', () => {
  const counter = () => ({ lines: () => 0 });

  it('只允許 2d: boot takes the 2d context’s canvas getter off before lockdown(), not as one of the removals; the factory’s stage makes canvases for an actor whose character has advancedBitmap', () => {
    const fake = fakeOffscreenCanvas();
    let getterAtLockdown: boolean | undefined;
    let made: unknown;
    const ses = fakeSes({
      lockdown: () => {
        getterAtLockdown = 'canvas' in fake.contextPrototype;
      },
      evaluate: () => (stage: TestStage) => {
        made = stage.canvas('a1', 16, 16);
        return {};
      },
    });
    ses.scope.OffscreenCanvas = fake.OffscreenCanvas;

    const outcome = boot('ENTRY', {
      scope: ses.scope,
      counter: counter(),
      post: () => {},
      ownActors: ownOf({ a1: 'probe-one' }),
      bitmapCharacters: new Set(['probe-one']),
    });

    expect(getterAtLockdown).toBe(false);
    expect(outcome.report).toMatchObject({ type: 'sandbox.ready' });
    expect(
      (
        outcome.report as unknown as { removals: { name: string }[] }
      ).removals.map((removal) => removal.name),
    ).toStrictEqual([...REMOVED_WORKER_APIS, ...SES_UNKNOWN_INTRINSICS]);
    expect(made).toBeDefined();
    expect('canvas' in (made as object)).toBe(false);
  });

  it.each<[string, (scope: Record<string, unknown>) => void]>([
    ['no OffscreenCanvas', () => {}],
    [
      'a canvas getter that cannot be taken off',
      (scope) => {
        scope.OffscreenCanvas = fakeOffscreenCanvas({
          lockedCanvasGetter: true,
        }).OffscreenCanvas;
      },
    ],
  ])(
    '沒有 OffscreenCanvas: a Worker with %s boots as before (ready, same removals); its stage.canvas throws a TypeError',
    (_label, prepare) => {
      let thrown: unknown;
      const ses = fakeSes({
        evaluate: () => (stage: TestStage) => {
          try {
            stage.canvas('a1', 16, 16);
          } catch (error) {
            thrown = error;
          }
          return {};
        },
      });
      prepare(ses.scope);

      const outcome = boot('ENTRY', {
        scope: ses.scope,
        counter: counter(),
        post: () => {},
        ownActors: ownOf({ a1: 'probe-one' }),
        bitmapCharacters: new Set(['probe-one']),
      });

      expect(outcome.report).toMatchObject({
        type: 'sandbox.ready',
        consoleLines: 0,
      });
      expect(thrown).toBeInstanceOf(TypeError);
    },
  );
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

  it('a call nested too deep to clone throws a TypeError at the call, before the port is there, and is not kept for it: only the calls after it are sent', () => {
    let thrown: unknown;
    const worker = fakeWorker(
      () =>
        (stage: {
          hold(actorId: string, on: unknown): void;
          log(text: string): void;
        }) => {
          try {
            stage.hold('a1', nestedLists(30_000));
          } catch (error) {
            thrown = error;
          }
          stage.log('after');
          return {};
        },
    );
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    const sent: unknown[] = [];

    worker.emit('message', {
      data: { type: 'port' },
      ports: [{ postMessage: (message: unknown) => sent.push(message) }],
    });

    expect(thrown).toBeInstanceOf(TypeError);
    expect(sent).toStrictEqual([
      expect.objectContaining({ type: 'sandbox.ready' }),
      { type: 'stage.log', text: 'after' },
    ]);
  });

  it('a call made before the port waits as the copy made at the call: its getter is not read again, and a change to its argument after the call is not sent', () => {
    let reads = 0;
    const on = { deep: [1] };
    const worker = fakeWorker(
      () => (stage: { hold(actorId: string, on: unknown): void }) => {
        stage.hold('a1', {
          get on() {
            reads += 1;
            return on;
          },
        });
        on.deep.push(2);
        return {};
      },
    );
    countConsole(worker.scope);
    run('ENTRY', worker.scope);
    on.deep.push(3);
    const sent: unknown[] = [];

    worker.emit('message', {
      data: { type: 'port' },
      ports: [{ postMessage: (message: unknown) => sent.push(message) }],
    });

    expect(reads).toBe(1);
    expect(sent.slice(1)).toStrictEqual([
      { type: 'stage.hold', actorId: 'a1', on: { on: { deep: [1] } } },
    ]);
  });
});
