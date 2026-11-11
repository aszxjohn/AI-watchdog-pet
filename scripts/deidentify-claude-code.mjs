// @ts-check
/**
 * Turns real Claude Code transcripts into test fixtures by an allowlist
 * (Story 2.4). The repo is public: a fixture keeps a record's structure and
 * nothing a person wrote, ran or read.
 *
 *   node scripts/deidentify-claude-code.mjs --out <projects-root> <transcript.jsonl>...
 *
 * Each input is a session's transcript (`<cwd>/<id>.jsonl`); its subagent
 * transcripts (`<cwd>/<id>/subagents/*.jsonl`) come along. The output is a
 * projects folder of its own: the N-th input becomes
 * `<projects-root>/-fixture-project/<FIXTURE_SESSION_IDS[N]>.jsonl`, its
 * subagents `…/<id>/subagents/agent-fixture-<k>.jsonl`.
 *
 * Kept, per record:
 * - `type`, `subtype`, `isMeta`, `isCompactSummary`, `isSidechain`,
 *   `isApiErrorMessage`;
 * - `timestamp`, shifted so the earliest one of all inputs is
 *   FIXTURE_ORIGIN (the gaps between records stay);
 * - `uuid`, renumbered;
 * - `cwd`, replaced by FIXTURE_CWD; `customTitle` and `aiTitle`, replaced
 *   by FIXTURE_TITLE;
 * - `message.role`, `message.stop_reason`, and `message.content`: a string
 *   becomes '' (it stays a string), unless it is one of the interrupt texts
 *   Claude Code writes, which is kept; each block keeps its `type`, `id`,
 *   `name` and `tool_use_id`, ids renumbered (a tool_use and its
 *   tool_result keep matching), and a text block keeps its `text` only when
 *   it is an interrupt text. MCP tool names (`mcp__<server>__<tool>`) name
 *   private servers and become FIXTURE_MCP_TOOL.
 *
 * Everything else is dropped, and lines that are not JSON objects are
 * skipped. Before writing, every output record must pass fixtureProblems();
 * if one does not, nothing is written. The script prints counts only:
 * never a path it read or anything from a record.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_ORIGIN = Date.parse('2026-01-01T00:00:00.000Z');
export const FIXTURE_CWD = '/fixture/project';
export const FIXTURE_TITLE = '範例標題';
export const FIXTURE_MCP_TOOL = 'mcp__fixture__tool';
export const FIXTURE_PROJECT_FOLDER = '-fixture-project';
export const INTERRUPT_TEXTS = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
];

/** The session id of the N-th input. */
export function fixtureSessionId(/** @type {number} */ n) {
  return `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
}

const RECORD_FLAGS = [
  'isMeta',
  'isCompactSummary',
  'isSidechain',
  'isApiErrorMessage',
];
const RECORD_KEYS = new Set([
  'type',
  'subtype',
  ...RECORD_FLAGS,
  'timestamp',
  'uuid',
  'cwd',
  'customTitle',
  'aiTitle',
  'message',
]);
const MESSAGE_KEYS = new Set(['role', 'stop_reason', 'content']);
const BLOCK_KEYS = new Set(['type', 'id', 'name', 'tool_use_id', 'text']);
const CODE = /^[a-z][a-z0-9_-]*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const RECORD_UUID = /^10000000-0000-4000-8000-\d{12}$/;
const TOOL_ID = /^toolu_fixture_\d{4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renumbering for one run: record uuids and tool ids, and the time shift.
 */
export function createRenumbering(/** @type {number} */ earliestMs) {
  /** @type {Map<string, string>} */
  const uuids = new Map();
  /** @type {Map<string, string>} */
  const toolIds = new Map();
  return {
    shiftMs: FIXTURE_ORIGIN - earliestMs,
    /** @param {string} value */
    uuid(value) {
      let mapped = uuids.get(value);
      if (mapped === undefined) {
        mapped = `10000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`;
        uuids.set(value, mapped);
      }
      return mapped;
    },
    /** @param {string} value */
    toolId(value) {
      let mapped = toolIds.get(value);
      if (mapped === undefined) {
        mapped = `toolu_fixture_${String(toolIds.size + 1).padStart(4, '0')}`;
        toolIds.set(value, mapped);
      }
      return mapped;
    },
  };
}

/** @typedef {ReturnType<typeof createRenumbering>} Renumbering */

/** @param {unknown} value */
function isInterruptText(value) {
  return typeof value === 'string' && INTERRUPT_TEXTS.includes(value);
}

/** @param {unknown} name */
function toolName(name) {
  if (typeof name !== 'string') {
    return undefined;
  }
  if (name.startsWith('mcp__')) {
    return FIXTURE_MCP_TOOL;
  }
  return TOOL_NAME.test(name) ? name : 'fixture_tool';
}

/**
 * One content block, by the allowlist.
 * @param {Record<string, unknown>} block
 * @param {Renumbering} renumber
 */
function deidentifyBlock(block, renumber) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (typeof block.type === 'string' && CODE.test(block.type)) {
    out.type = block.type;
  }
  if (typeof block.id === 'string') {
    out.id = renumber.toolId(block.id);
  }
  const name = toolName(block.name);
  if (name !== undefined) {
    out.name = name;
  }
  if (typeof block.tool_use_id === 'string') {
    out.tool_use_id = renumber.toolId(block.tool_use_id);
  }
  if (block.type === 'text' && isInterruptText(block.text)) {
    out.text = block.text;
  }
  return out;
}

/**
 * One record, by the allowlist (see the module comment).
 * @param {Record<string, unknown>} record
 * @param {Renumbering} renumber
 */
export function deidentifyRecord(record, renumber) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (typeof record.type === 'string' && CODE.test(record.type)) {
    out.type = record.type;
  }
  if (typeof record.subtype === 'string' && CODE.test(record.subtype)) {
    out.subtype = record.subtype;
  }
  for (const flag of RECORD_FLAGS) {
    if (typeof record[flag] === 'boolean') {
      out[flag] = record[flag];
    }
  }
  if (typeof record.timestamp === 'string') {
    const ms = Date.parse(record.timestamp);
    if (Number.isFinite(ms)) {
      out.timestamp = new Date(ms + renumber.shiftMs).toISOString();
    }
  }
  if (typeof record.uuid === 'string') {
    out.uuid = renumber.uuid(record.uuid);
  }
  if (typeof record.cwd === 'string') {
    out.cwd = FIXTURE_CWD;
  }
  if (typeof record.customTitle === 'string') {
    out.customTitle = FIXTURE_TITLE;
  }
  if (typeof record.aiTitle === 'string') {
    out.aiTitle = FIXTURE_TITLE;
  }
  if (isObject(record.message)) {
    const { role, stop_reason: stopReason, content } = record.message;
    /** @type {Record<string, unknown>} */
    const message = {};
    if (typeof role === 'string' && CODE.test(role)) {
      message.role = role;
    }
    if (
      stopReason === null ||
      (typeof stopReason === 'string' && CODE.test(stopReason))
    ) {
      message.stop_reason = stopReason;
    }
    if (typeof content === 'string') {
      message.content = isInterruptText(content) ? content : '';
    } else if (Array.isArray(content)) {
      message.content = content
        .filter(isObject)
        .map((block) => deidentifyBlock(block, renumber));
    }
    out.message = message;
  }
  return out;
}

/**
 * What in a fixture record breaks the allowlist; empty when nothing does.
 * Strings are checked by value too: only codes, fixture ids and the fixed
 * texts may appear.
 * @param {unknown} record
 * @returns {string[]}
 */
export function fixtureProblems(record) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(record)) {
    return ['not an object'];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!RECORD_KEYS.has(key)) {
      problems.push(`field ${key}`);
      continue;
    }
    const ok =
      key === 'type' || key === 'subtype'
        ? typeof value === 'string' && CODE.test(value)
        : RECORD_FLAGS.includes(key)
          ? typeof value === 'boolean'
          : key === 'timestamp'
            ? typeof value === 'string' && ISO.test(value)
            : key === 'uuid'
              ? typeof value === 'string' && RECORD_UUID.test(value)
              : key === 'cwd'
                ? value === FIXTURE_CWD
                : key === 'customTitle' || key === 'aiTitle'
                  ? value === FIXTURE_TITLE
                  : isObject(value);
    if (!ok) {
      problems.push(`value of ${key}`);
    }
  }
  if (isObject(record.message)) {
    for (const [key, value] of Object.entries(record.message)) {
      if (!MESSAGE_KEYS.has(key)) {
        problems.push(`field message.${key}`);
      } else if (key === 'role' || key === 'stop_reason') {
        if (
          !(value === null || (typeof value === 'string' && CODE.test(value)))
        ) {
          problems.push(`value of message.${key}`);
        }
      } else if (typeof value === 'string') {
        if (value !== '' && !isInterruptText(value)) {
          problems.push('value of message.content');
        }
      } else if (Array.isArray(value)) {
        for (const block of value) {
          problems.push(...blockProblems(block));
        }
      } else {
        problems.push('value of message.content');
      }
    }
  }
  return problems;
}

/** @param {unknown} block */
function blockProblems(block) {
  if (!isObject(block)) {
    return ['a content block that is not an object'];
  }
  /** @type {string[]} */
  const problems = [];
  for (const [key, value] of Object.entries(block)) {
    const ok = !BLOCK_KEYS.has(key)
      ? false
      : key === 'type'
        ? typeof value === 'string' && CODE.test(value)
        : key === 'id' || key === 'tool_use_id'
          ? typeof value === 'string' && TOOL_ID.test(value)
          : key === 'name'
            ? typeof value === 'string' && TOOL_NAME.test(value)
            : block.type === 'text' && isInterruptText(value);
    if (!ok) {
      problems.push(`content block ${key}`);
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
 * The subagent transcripts of the session whose transcript is `file`.
 * @param {string} file
 */
function subagentFiles(file) {
  const dir = path.join(
    path.dirname(file),
    path.basename(file, '.jsonl'),
    'subagents',
  );
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** @param {string[]} argv */
function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  const inputs = argv.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (out === undefined || inputs.length === 0) {
    console.error(
      'usage: node scripts/deidentify-claude-code.mjs --out <projects-root> <transcript.jsonl>...',
    );
    return 2;
  }

  const sessions = inputs.map((file) => ({
    own: parseLines(readFileSync(file, 'utf8')),
    subagents: subagentFiles(file).map((sub) =>
      parseLines(readFileSync(sub, 'utf8')),
    ),
  }));
  let earliest = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    for (const { records } of [session.own, ...session.subagents]) {
      for (const record of records) {
        const ms =
          typeof record.timestamp === 'string'
            ? Date.parse(record.timestamp)
            : NaN;
        if (Number.isFinite(ms) && ms < earliest) {
          earliest = ms;
        }
      }
    }
  }
  const renumber = createRenumbering(
    Number.isFinite(earliest) ? earliest : FIXTURE_ORIGIN,
  );

  /** @type {{ file: string; lines: string[]; bad: number }[]} */
  const outputs = [];
  sessions.forEach((session, n) => {
    const id = fixtureSessionId(n);
    const folder = path.join(out, FIXTURE_PROJECT_FOLDER);
    const toLines = (/** @type {Record<string, unknown>[]} */ records) =>
      records.map((record) =>
        JSON.stringify(deidentifyRecord(record, renumber)),
      );
    outputs.push({
      file: path.join(folder, `${id}.jsonl`),
      lines: toLines(session.own.records),
      bad: session.own.bad,
    });
    session.subagents.forEach((sub, k) => {
      outputs.push({
        file: path.join(
          folder,
          id,
          'subagents',
          `agent-fixture-${k + 1}.jsonl`,
        ),
        lines: toLines(sub.records),
        bad: sub.bad,
      });
    });
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
