// @ts-check
/**
 * Turns real Gemini CLI chat logs into test fixtures by an allowlist
 * (Story 2.6). The repo is public: a fixture keeps a record's structure and
 * nothing a person wrote, ran or read.
 *
 *   node scripts/deidentify-gemini.mjs --out <tmp-root> <session-*.jsonl>...
 *
 * Each input is a session's chat log (`~/.gemini/tmp/<project>/chats/
 * session-*.jsonl`). The output is a temporary folder of its own: every
 * input goes to one project folder, FIXTURE_PROJECT_FOLDER, as
 * `<tmp-root>/fixture-project/chats/session-<start>-<id>.jsonl`, where
 * `<start>` is its shifted start time to the minute and `<id>` the first
 * part of its header's renumbered session id. Every input's header session
 * id is renumbered first, in input order, before any other record: the
 * N-th input's header gets fixtureSessionId(N) (unless an earlier input's
 * header has the same id, whose number it shares).
 *
 * Kept, per record:
 * - the header (the first record, with a `sessionId` and no `type`):
 *   `kind`; `sessionId`, renumbered; `projectHash`, replaced by
 *   FIXTURE_PROJECT_HASH; `startTime` and `lastUpdated`, shifted;
 * - a message: `type`; `id`, renumbered; `timestamp`, shifted so the
 *   earliest time of all inputs is FIXTURE_ORIGIN (the gaps stay);
 *   `content`, reduced to whether it is empty and whether it is a
 *   `functionResponse`: a string stays '' when blank, REQUEST_CANCELLED
 *   when it is that, and becomes FIXTURE_TEXT otherwise; in a part list,
 *   a `functionResponse` part becomes `{ functionResponse: {} }`, a text
 *   part `{ text: '' }`, `{ text: REQUEST_CANCELLED }` or `{ text:
 *   FIXTURE_TEXT }` the same way, and any other part `{}`; `toolCalls`,
 *   each with its `id` renumbered, its `name` (Gemini CLI's own tools
 *   only; any other, an MCP server's for one, becomes FIXTURE_TOOL), its
 *   `status` and its `timestamp`, shifted;
 * - `$set`: its keys only. A `summary` that is a non-blank string becomes
 *   FIXTURE_TITLE, `messages` an empty list, a string `sessionId` is
 *   renumbered, and every other value is null;
 * - `$rewindTo`: the message id, renumbered.
 *
 * Everything else is dropped, and lines that are not JSON objects are
 * skipped. Before writing, every output record must pass fixtureProblems();
 * if one does not, nothing is written. An input that cannot be read is
 * reported as `input <N>: <error code>` (N from 1), and nothing is written.
 * The script prints counts only: never a path it read or anything from a
 * record.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_ORIGIN = Date.parse('2026-01-01T00:00:00.000Z');
export const FIXTURE_PROJECT_FOLDER = 'fixture-project';
export const FIXTURE_PROJECT_HASH = '0'.repeat(64);
export const FIXTURE_TEXT = '範例回覆';
export const FIXTURE_TITLE = '範例標題';
export const FIXTURE_TOOL = 'fixture_tool';
export const REQUEST_CANCELLED = 'Request cancelled.';

/** Gemini CLI's own tools, whose names are kept. */
export const GEMINI_TOOLS = [
  'activate_skill',
  'ask_user',
  'codebase_investigator',
  'complete_task',
  'delegate_to_agent',
  'edit',
  'enter_plan_mode',
  'exit_plan_mode',
  'glob',
  'google_web_search',
  'grep_search',
  'list_directory',
  'read_file',
  'read_many_files',
  'replace',
  'run_shell_command',
  'save_memory',
  'search_file_content',
  'web_fetch',
  'write_file',
  'write_todos',
];

/** The session id of the N-th input. */
export function fixtureSessionId(/** @type {number} */ n) {
  return `${String(n + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

const HEADER_KEYS = new Set([
  'sessionId',
  'projectHash',
  'startTime',
  'lastUpdated',
  'kind',
]);
const MESSAGE_KEYS = new Set([
  'type',
  'id',
  'timestamp',
  'content',
  'toolCalls',
]);
const TOOL_CALL_KEYS = new Set(['id', 'name', 'status', 'timestamp']);
const CODE = /^[a-z][a-z0-9_-]*$/;
const SET_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const SESSION_ID = /^\d{8}-0000-4000-8000-000000000000$/;
const MESSAGE_ID = /^20000000-0000-4000-8000-\d{12}$/;
const TOOL_CALL_ID = /^fixture_call_\d{4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The texts a fixture's content may hold. */
const TEXTS = ['', FIXTURE_TEXT, REQUEST_CANCELLED];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} record */
function isHeader(record) {
  return (
    record.type === undefined &&
    record.$set === undefined &&
    record.$rewindTo === undefined &&
    typeof record.sessionId === 'string'
  );
}

/**
 * Renumbering for one run: session, message and tool call ids, and the
 * time shift.
 */
export function createRenumbering(/** @type {number} */ earliestMs) {
  /** @type {Map<string, string>} */
  const sessions = new Map();
  /** @type {Map<string, string>} */
  const messages = new Map();
  /** @type {Map<string, string>} */
  const calls = new Map();
  /**
   * @param {Map<string, string>} map
   * @param {string} value
   * @param {(n: number) => string} make
   */
  const renumber = (map, value, make) => {
    let mapped = map.get(value);
    if (mapped === undefined) {
      mapped = make(map.size);
      map.set(value, mapped);
    }
    return mapped;
  };
  return {
    shiftMs: FIXTURE_ORIGIN - earliestMs,
    /** @param {string} value */
    sessionId: (value) => renumber(sessions, value, fixtureSessionId),
    /** @param {string} value */
    messageId: (value) =>
      renumber(
        messages,
        value,
        (n) => `20000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
      ),
    /** @param {string} value */
    toolCallId: (value) =>
      renumber(
        calls,
        value,
        (n) => `fixture_call_${String(n + 1).padStart(4, '0')}`,
      ),
  };
}

/** @typedef {ReturnType<typeof createRenumbering>} Renumbering */

/**
 * `value`, an ISO time, shifted; undefined when it is not one.
 * @param {unknown} value
 * @param {Renumbering} renumber
 */
function shifted(value, renumber) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms)
    ? new Date(ms + renumber.shiftMs).toISOString()
    : undefined;
}

/** @param {string} text */
function textOf(text) {
  if (text.trim() === '') {
    return '';
  }
  return text.trim() === REQUEST_CANCELLED ? REQUEST_CANCELLED : FIXTURE_TEXT;
}

/**
 * One part of a content list, by the allowlist.
 * @param {unknown} part
 */
function deidentifyPart(part) {
  if (typeof part === 'string') {
    return { text: textOf(part) };
  }
  if (!isObject(part)) {
    return {};
  }
  if (isObject(part.functionResponse)) {
    return { functionResponse: {} };
  }
  return typeof part.text === 'string' ? { text: textOf(part.text) } : {};
}

/**
 * A message's content, by the allowlist; undefined when it has none.
 * @param {unknown} content
 */
function deidentifyContent(content) {
  if (typeof content === 'string') {
    return textOf(content);
  }
  if (Array.isArray(content)) {
    return content.map(deidentifyPart);
  }
  return isObject(content) ? deidentifyPart(content) : undefined;
}

/** @param {unknown} name */
function toolName(name) {
  return typeof name === 'string' && GEMINI_TOOLS.includes(name)
    ? name
    : FIXTURE_TOOL;
}

/**
 * One record, by the allowlist (see the module comment). `first`: it is the
 * chat log's first record (where the header is).
 * @param {Record<string, unknown>} record
 * @param {Renumbering} renumber
 * @param {boolean} first
 */
export function deidentifyRecord(record, renumber, first) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (first && isHeader(record)) {
    out.sessionId = renumber.sessionId(String(record.sessionId));
    if (record.projectHash !== undefined) {
      out.projectHash = FIXTURE_PROJECT_HASH;
    }
    for (const key of ['startTime', 'lastUpdated']) {
      const time = shifted(record[key], renumber);
      if (time !== undefined) {
        out[key] = time;
      }
    }
    if (typeof record.kind === 'string' && CODE.test(record.kind)) {
      out.kind = record.kind;
    }
    return out;
  }
  if (isObject(record.$set)) {
    /** @type {Record<string, unknown>} */
    const set = {};
    for (const [key, value] of Object.entries(record.$set)) {
      if (!SET_KEY.test(key)) {
        continue;
      }
      set[key] =
        key === 'summary'
          ? typeof value === 'string' && value.trim() !== ''
            ? FIXTURE_TITLE
            : null
          : key === 'messages'
            ? []
            : key === 'sessionId' && typeof value === 'string'
              ? renumber.sessionId(value)
              : null;
    }
    out.$set = set;
    return out;
  }
  if (record.$rewindTo !== undefined) {
    out.$rewindTo =
      typeof record.$rewindTo === 'string'
        ? renumber.messageId(record.$rewindTo)
        : null;
    return out;
  }
  if (typeof record.type === 'string' && CODE.test(record.type)) {
    out.type = record.type;
  }
  if (typeof record.id === 'string') {
    out.id = renumber.messageId(record.id);
  }
  const timestamp = shifted(record.timestamp, renumber);
  if (timestamp !== undefined) {
    out.timestamp = timestamp;
  }
  const content = deidentifyContent(record.content);
  if (content !== undefined) {
    out.content = content;
  }
  if (Array.isArray(record.toolCalls)) {
    out.toolCalls = record.toolCalls.filter(isObject).map((call) => {
      /** @type {Record<string, unknown>} */
      const kept = {};
      if (typeof call.id === 'string') {
        kept.id = renumber.toolCallId(call.id);
      }
      kept.name = toolName(call.name);
      if (typeof call.status === 'string' && CODE.test(call.status)) {
        kept.status = call.status;
      }
      const time = shifted(call.timestamp, renumber);
      if (time !== undefined) {
        kept.timestamp = time;
      }
      return kept;
    });
  }
  return out;
}

/**
 * What in a content part breaks the allowlist.
 * @param {unknown} part
 * @returns {string[]}
 */
function partProblems(part) {
  if (!isObject(part)) {
    return ['a content part that is not an object'];
  }
  const keys = Object.keys(part);
  if (keys.length === 0) {
    return [];
  }
  if (keys.length > 1) {
    return ['a content part with more than one field'];
  }
  if (keys[0] === 'text') {
    return TEXTS.includes(/** @type {string} */ (part.text))
      ? []
      : ['content part text'];
  }
  if (keys[0] === 'functionResponse') {
    return isObject(part.functionResponse) &&
      Object.keys(part.functionResponse).length === 0
      ? []
      : ['content part functionResponse'];
  }
  return [`content part ${keys[0]}`];
}

/**
 * What in a message's content breaks the allowlist.
 * @param {unknown} content
 * @returns {string[]}
 */
function contentProblems(content) {
  if (typeof content === 'string') {
    return TEXTS.includes(content) ? [] : ['value of content'];
  }
  if (Array.isArray(content)) {
    return content.flatMap(partProblems);
  }
  return partProblems(content);
}

/**
 * What in a tool call breaks the allowlist.
 * @param {unknown} call
 * @returns {string[]}
 */
function toolCallProblems(call) {
  if (!isObject(call)) {
    return ['a tool call that is not an object'];
  }
  /** @type {string[]} */
  const problems = [];
  for (const [key, value] of Object.entries(call)) {
    const ok = !TOOL_CALL_KEYS.has(key)
      ? false
      : key === 'id'
        ? typeof value === 'string' && TOOL_CALL_ID.test(value)
        : key === 'name'
          ? value === FIXTURE_TOOL ||
            (typeof value === 'string' && GEMINI_TOOLS.includes(value))
          : key === 'status'
            ? typeof value === 'string' && CODE.test(value)
            : typeof value === 'string' && ISO.test(value);
    if (!ok) {
      problems.push(`tool call ${key}`);
    }
  }
  return problems;
}

/**
 * What in a fixture record breaks the allowlist; empty when nothing does.
 * Strings are checked by value too: only codes, fixture ids, shifted times
 * and the fixed texts may appear.
 * @param {unknown} record
 * @returns {string[]}
 */
export function fixtureProblems(record) {
  if (!isObject(record)) {
    return ['not an object'];
  }
  /** @type {string[]} */
  const problems = [];
  if (isHeader(record)) {
    for (const [key, value] of Object.entries(record)) {
      const ok = !HEADER_KEYS.has(key)
        ? false
        : key === 'sessionId'
          ? typeof value === 'string' && SESSION_ID.test(value)
          : key === 'projectHash'
            ? value === FIXTURE_PROJECT_HASH
            : key === 'kind'
              ? typeof value === 'string' && CODE.test(value)
              : typeof value === 'string' && ISO.test(value);
      if (!ok) {
        problems.push(`header ${key}`);
      }
    }
    return problems;
  }
  if (record.$set !== undefined) {
    if (Object.keys(record).length !== 1 || !isObject(record.$set)) {
      return ['$set record'];
    }
    for (const [key, value] of Object.entries(record.$set)) {
      const ok = !SET_KEY.test(key)
        ? false
        : key === 'summary'
          ? value === FIXTURE_TITLE || value === null
          : key === 'messages'
            ? Array.isArray(value) && value.length === 0
            : key === 'sessionId'
              ? typeof value === 'string' && SESSION_ID.test(value)
              : value === null;
      if (!ok) {
        problems.push(`$set ${key}`);
      }
    }
    return problems;
  }
  if (record.$rewindTo !== undefined) {
    return Object.keys(record).length === 1 &&
      (record.$rewindTo === null ||
        (typeof record.$rewindTo === 'string' &&
          MESSAGE_ID.test(record.$rewindTo)))
      ? []
      : ['$rewindTo record'];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!MESSAGE_KEYS.has(key)) {
      problems.push(`field ${key}`);
      continue;
    }
    if (key === 'content') {
      problems.push(...contentProblems(value));
      continue;
    }
    if (key === 'toolCalls') {
      if (Array.isArray(value)) {
        problems.push(...value.flatMap(toolCallProblems));
      } else {
        problems.push('value of toolCalls');
      }
      continue;
    }
    const ok =
      key === 'type'
        ? typeof value === 'string' && CODE.test(value)
        : key === 'id'
          ? typeof value === 'string' && MESSAGE_ID.test(value)
          : typeof value === 'string' && ISO.test(value);
    if (!ok) {
      problems.push(`value of ${key}`);
    }
  }
  return problems;
}

/**
 * The JSON objects on the lines of `text`, and how many lines were not one.
 * @param {string} text
 */
function parseLines(text) {
  /** @type {Record<string, unknown>[]} */
  const records = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (isObject(value)) {
        records.push(value);
      } else {
        bad += 1;
      }
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

/**
 * The earliest time in `records`, epoch ms; Infinity when none.
 * @param {Record<string, unknown>[]} records
 */
function earliestOf(records) {
  let earliest = Number.POSITIVE_INFINITY;
  /** @param {unknown} value */
  const see = (value) => {
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ms) && ms < earliest) {
      earliest = ms;
    }
  };
  for (const record of records) {
    see(record.timestamp);
    see(record.startTime);
    if (Array.isArray(record.toolCalls)) {
      for (const call of record.toolCalls) {
        see(isObject(call) ? call.timestamp : undefined);
      }
    }
  }
  return earliest;
}

/**
 * The output file name of a chat log whose header is `header`
 * (de-identified) and whose renumbered session id is `sessionId`.
 * @param {Record<string, unknown> | undefined} header
 * @param {string} sessionId
 */
function fileNameOf(header, sessionId) {
  const start =
    typeof header?.startTime === 'string' ? header.startTime : undefined;
  const minute = (start ?? new Date(FIXTURE_ORIGIN).toISOString())
    .slice(0, 16)
    .replace(':', '-');
  return `session-${minute}-${sessionId.slice(0, 8)}.jsonl`;
}

/**
 * An error's code (`ENOENT`), else its name; never its message, which may
 * hold a path.
 * @param {unknown} error
 */
function codeOf(error) {
  if (isObject(error) && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/** @param {string[]} argv */
function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  const inputs = argv.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (out === undefined || inputs.length === 0) {
    console.error(
      'usage: node scripts/deidentify-gemini.mjs --out <tmp-root> <session-*.jsonl>...',
    );
    return 2;
  }

  /** @type {ReturnType<typeof parseLines>[]} */
  const logs = [];
  let unreadable = 0;
  inputs.forEach((file, n) => {
    try {
      logs.push(parseLines(readFileSync(file, 'utf8')));
    } catch (error) {
      unreadable += 1;
      console.error(`input ${n + 1}: ${codeOf(error)}`);
    }
  });
  if (unreadable > 0) {
    console.error(`${unreadable} inputs unreadable; nothing written`);
    return 1;
  }
  const earliest = Math.min(...logs.map(({ records }) => earliestOf(records)));
  const renumber = createRenumbering(
    Number.isFinite(earliest) ? earliest : FIXTURE_ORIGIN,
  );
  // Every header's session id first, in input order, before any other
  // record can take a number: the N-th header gets the N-th id.
  const sessionIds = logs.map(({ records }, n) => {
    const header = records[0];
    return renumber.sessionId(
      header !== undefined && isHeader(header)
        ? String(header.sessionId)
        : `(no header ${n})`,
    );
  });

  const folder = path.join(out, FIXTURE_PROJECT_FOLDER, 'chats');
  const outputs = logs.map(({ records, bad }, n) => {
    const kept = records.map((record, i) =>
      deidentifyRecord(record, renumber, i === 0),
    );
    return {
      file: path.join(
        folder,
        fileNameOf(kept[0], sessionIds[n] ?? fixtureSessionId(n)),
      ),
      lines: kept.map((record) => JSON.stringify(record)),
      bad,
    };
  });

  let problems = 0;
  for (const { lines } of outputs) {
    for (const line of lines) {
      problems += fixtureProblems(JSON.parse(line)).length;
    }
  }
  if (problems > 0) {
    console.error(`${problems} allowlist problems; nothing written`);
    return 1;
  }
  mkdirSync(folder, { recursive: true });
  for (const { file, lines, bad } of outputs) {
    writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
    console.log(
      `${path.relative(out, file)}: ${lines.length} records${bad > 0 ? `, ${bad} bad lines skipped` : ''}`,
    );
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
