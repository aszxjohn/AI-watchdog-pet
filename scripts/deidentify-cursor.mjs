// @ts-check
/**
 * Turns real Cursor agent transcripts into test fixtures by an allowlist
 * (Story 2.7). The repo is public: a fixture keeps a record's structure and
 * nothing a person wrote, ran or read.
 *
 *   node scripts/deidentify-cursor.mjs --out <projects-root> <transcript.jsonl>...
 *
 * Each input is a session's transcript
 * (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`) or a
 * subagent's (`.../agent-transcripts/<id>/subagents/<sub id>.jsonl`, told
 * apart by the `subagents` folder it is in). The output is a folder of its
 * own, laid out as Cursor's projects folder with one project,
 * FIXTURE_SLUG: `<out>/fixture-project/agent-transcripts/<id>/<id>.jsonl`,
 * and a subagent's under its session's folder,
 * `<out>/fixture-project/agent-transcripts/<id>/subagents/<sub id>.jsonl`.
 * Ids are renumbered (fixtureId): every session's id first, in input
 * order, then every subagent's; a subagent's session keeps the number its
 * own transcript got (or the next one, when that is not an input).
 *
 * Kept, per record:
 * - a message (`role`): `role`; `message.content`, each part with its
 *   `type` only, but for a `text` part its text, replaced by FIXTURE_PROMPT
 *   (a user's) or FIXTURE_REPLY (anyone else's), '' when blank, and for a
 *   `tool_use` part its `name` (Cursor's own tools only, CURSOR_TOOLS; any
 *   other becomes FIXTURE_TOOL) and its `input`, replaced by `{}`; content
 *   that is a string is replaced as a text part's;
 * - a turn end (`type: 'turn_ended'`): `type`; `status`; `error`, kept when
 *   it is USER_ABORTED and replaced by FIXTURE_ERROR otherwise;
 * - any other record: its `role`, `type` and `status` only.
 * Codes (`role`, `type`, `status`) are kept only when they look like codes.
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

export const FIXTURE_SLUG = 'fixture-project';
export const FIXTURE_PROMPT = '範例提示';
export const FIXTURE_REPLY = '範例回覆';
export const FIXTURE_TOOL = 'fixture_tool';
export const FIXTURE_ERROR = 'fixture error';
export const USER_ABORTED = 'User aborted request';

/** Cursor's own tools, whose names are kept. */
export const CURSOR_TOOLS = [
  'ApplyPatch',
  'AskQuestion',
  'CallMcpTool',
  'CreatePlan',
  'Delete',
  'EditNotebook',
  'GetMcpTools',
  'Glob',
  'Grep',
  'LS',
  'Read',
  'ReadLints',
  'SearchConversations',
  'SemanticSearch',
  'Shell',
  'StrReplace',
  'SwitchMode',
  'Task',
  'TodoWrite',
  'UpdateCurrentStep',
  'WebFetch',
  'WebSearch',
  'Write',
];

/** The N-th id given out (N from 0). */
export function fixtureId(/** @type {number} */ n) {
  return `${String(n + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

const CODE = /^[a-z][a-z0-9_-]*$/;
const FIXTURE_ID = /^\d{8}-0000-4000-8000-000000000000$/;
/** The texts a fixture's content may hold. */
const TEXTS = ['', FIXTURE_PROMPT, FIXTURE_REPLY];
const TURN_ENDED = 'turn_ended';
const SUBAGENTS = 'subagents';
const TRANSCRIPTS = 'agent-transcripts';
const JSONL = '.jsonl';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isCode(value) {
  return typeof value === 'string' && CODE.test(value);
}

/**
 * Renumbering for one run: transcript ids, each given the next fixtureId
 * the first time it is seen.
 */
export function createRenumbering() {
  /** @type {Map<string, string>} */
  const ids = new Map();
  return {
    /** @param {string} value */
    id(value) {
      let mapped = ids.get(value);
      if (mapped === undefined) {
        mapped = fixtureId(ids.size);
        ids.set(value, mapped);
      }
      return mapped;
    },
  };
}

/**
 * A text, by the allowlist: '' when blank, else the fixed text of `role`.
 * @param {unknown} text
 * @param {unknown} role
 */
function textOf(text, role) {
  if (typeof text !== 'string' || text.trim() === '') {
    return '';
  }
  return role === 'user' ? FIXTURE_PROMPT : FIXTURE_REPLY;
}

/** @param {unknown} name */
function toolName(name) {
  return typeof name === 'string' && CURSOR_TOOLS.includes(name)
    ? name
    : FIXTURE_TOOL;
}

/**
 * One part of a message's content, by the allowlist.
 * @param {unknown} part
 * @param {unknown} role
 */
function deidentifyPart(part, role) {
  if (!isObject(part)) {
    return {};
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  if (isCode(part.type)) {
    out.type = part.type;
  }
  if (part.type === 'text') {
    out.text = textOf(part.text, role);
  } else if (part.type === 'tool_use') {
    out.name = toolName(part.name);
    out.input = {};
  }
  return out;
}

/**
 * One record, by the allowlist (see the module comment).
 * @param {Record<string, unknown>} record
 */
export function deidentifyRecord(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (record.type === TURN_ENDED) {
    out.type = TURN_ENDED;
    if (isCode(record.status)) {
      out.status = record.status;
    }
    if (record.error !== undefined) {
      out.error = record.error === USER_ABORTED ? USER_ABORTED : FIXTURE_ERROR;
    }
    return out;
  }
  for (const key of ['role', 'type', 'status']) {
    if (isCode(record[key])) {
      out[key] = record[key];
    }
  }
  if (typeof record.role === 'string' && isObject(record.message)) {
    const content = record.message.content;
    if (Array.isArray(content)) {
      out.message = {
        content: content.map((part) => deidentifyPart(part, record.role)),
      };
    } else if (typeof content === 'string') {
      out.message = { content: textOf(content, record.role) };
    } else {
      out.message = {};
    }
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
  /** @type {string[]} */
  const problems = [];
  for (const [key, value] of Object.entries(part)) {
    const ok =
      key === 'type'
        ? isCode(value)
        : key === 'text'
          ? part.type === 'text' &&
            TEXTS.includes(/** @type {string} */ (value))
          : key === 'name'
            ? part.type === 'tool_use' &&
              (value === FIXTURE_TOOL ||
                (typeof value === 'string' && CURSOR_TOOLS.includes(value)))
            : key === 'input'
              ? part.type === 'tool_use' &&
                isObject(value) &&
                Object.keys(value).length === 0
              : false;
    if (!ok) {
      problems.push(`content part ${key}`);
    }
  }
  return problems;
}

/**
 * What in a fixture record breaks the allowlist; empty when nothing does.
 * Strings are checked by value too: only codes, the kept error and the
 * fixed texts may appear.
 * @param {unknown} record
 * @returns {string[]}
 */
export function fixtureProblems(record) {
  if (!isObject(record)) {
    return ['not an object'];
  }
  /** @type {string[]} */
  const problems = [];
  if (record.type === TURN_ENDED) {
    for (const [key, value] of Object.entries(record)) {
      const ok =
        key === 'type' || key === 'status'
          ? isCode(value)
          : key === 'error'
            ? value === USER_ABORTED || value === FIXTURE_ERROR
            : false;
      if (!ok) {
        problems.push(`turn end ${key}`);
      }
    }
    return problems;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'role' || key === 'type' || key === 'status') {
      if (!isCode(value)) {
        problems.push(`value of ${key}`);
      }
      continue;
    }
    if (key !== 'message') {
      problems.push(`field ${key}`);
      continue;
    }
    if (!isObject(value)) {
      problems.push('value of message');
      continue;
    }
    for (const [field, content] of Object.entries(value)) {
      if (field !== 'content') {
        problems.push(`message field ${field}`);
      } else if (typeof content === 'string') {
        if (!TEXTS.includes(content)) {
          problems.push('value of content');
        }
      } else if (Array.isArray(content)) {
        problems.push(...content.flatMap(partProblems));
      } else {
        problems.push('value of content');
      }
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
 * What input `file` is, by its path: a session's transcript (its id) or a
 * subagent's (its own id and its session's).
 * @param {string} file
 */
export function inputKindOf(file) {
  const own = path.basename(file, JSONL);
  const folder = path.dirname(file);
  if (path.basename(folder) === SUBAGENTS) {
    return {
      kind: /** @type {const} */ ('subagent'),
      id: own,
      sessionId: path.basename(path.dirname(folder)),
    };
  }
  return { kind: /** @type {const} */ ('main'), id: own, sessionId: own };
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
      'usage: node scripts/deidentify-cursor.mjs --out <projects-root> <transcript.jsonl>...',
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

  const kinds = inputs.map(inputKindOf);
  const renumber = createRenumbering();
  // Every session's id first, in input order; then every subagent's.
  for (const where of kinds) {
    if (where.kind === 'main') {
      renumber.id(where.id);
    }
  }
  const transcripts = path.join(out, FIXTURE_SLUG, TRANSCRIPTS);
  const outputs = logs.map(({ records, bad }, n) => {
    const where = kinds[n] ?? inputKindOf('');
    const session = renumber.id(where.sessionId);
    const file =
      where.kind === 'main'
        ? path.join(transcripts, session, `${session}${JSONL}`)
        : path.join(
            transcripts,
            session,
            SUBAGENTS,
            `${renumber.id(`${where.sessionId}/${where.id}`)}${JSONL}`,
          );
    return {
      file,
      lines: records.map((record) => JSON.stringify(deidentifyRecord(record))),
      bad,
    };
  });

  let problems = 0;
  for (const { file, lines } of outputs) {
    for (const part of path.relative(out, file).split(path.sep).slice(2)) {
      if (part !== SUBAGENTS && !FIXTURE_ID.test(path.basename(part, JSONL))) {
        problems += 1;
      }
    }
    for (const line of lines) {
      problems += fixtureProblems(JSON.parse(line)).length;
    }
  }
  if (problems > 0) {
    console.error(`${problems} allowlist problems; nothing written`);
    return 1;
  }
  for (const { file, lines, bad } of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
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
