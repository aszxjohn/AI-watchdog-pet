import { z } from './zod-setup';

/**
 * Detection source codes (AD-5, AD-21): one per AI tool the stage reads, plus
 * `demo`. Each source has exactly one kind of native id, and a session's key
 * is `<source>:<native id>` (see `sessionKeySchema` in detection-events.ts):
 *
 * - `claude-code`: the session UUID, which is the transcript's file name
 *   (`~/.claude/projects/<cwd>/<id>.jsonl`, where `<cwd>` is the working
 *   directory encoded as a folder name: `/Users/me/proj` becomes
 *   `-Users-me-proj`). A status file whose `sessionId` matches no transcript
 *   UUID produces no events.
 * - `codex`: the session id in its rollout log
 *   (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * - `gemini`: the session id in its chat log
 *   (`~/.gemini/tmp/<project>/chats/session-*.jsonl`).
 * - `cursor`: the transcript id
 *   (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`).
 * - `copilot`: the session id in Copilot CLI's log (Epic 6).
 * - `demo`: the id the demo adapter gives each of its fake sessions.
 *
 * An adapter merges its probes so each session has one key; a new native id
 * (`/clear`, a new conversation) is a new session.
 */
export const SOURCE_CODES = [
  'claude-code',
  'codex',
  'gemini',
  'cursor',
  'copilot',
  'demo',
] as const;

export const sourceCodeSchema = z.enum(SOURCE_CODES);

export type SourceCode = z.infer<typeof sourceCodeSchema>;

/**
 * How much of a kind of request a source's records show (AD-4): `exact` when
 * they say the session is waiting on the user, `none` when they never do and
 * main/detection/inference has to guess it.
 */
export type CapabilityLevel = 'exact' | 'none';

/** What a source's adapter can and cannot read (AD-4, AD-22). */
export interface SourceCapability {
  /** Whether its records show a tool call waiting for the user's approval. */
  readonly approval: CapabilityLevel;
  /** Whether its records show the AI asking the user a question. */
  readonly question: CapabilityLevel;
  /**
   * Tools that ask the user something by design, matched by exact
   * `toolName`. A long-running one is guessed to be a question, not an
   * approval.
   */
  readonly questionTools: readonly string[];
}

function capability(
  approval: CapabilityLevel,
  question: CapabilityLevel,
  questionTools: readonly string[] = [],
): SourceCapability {
  return Object.freeze({
    approval,
    question,
    questionTools: Object.freeze([...questionTools]),
  });
}

/**
 * Each source's capability, from AD-4's table of what is known to be
 * unreadable. A `none` here is what main/detection/inference guesses at.
 *
 * - `claude-code`: both exact. Its question tools are the two that wait on
 *   the user by design: `AskUserQuestion` asks a question, `ExitPlanMode`
 *   asks the user to accept a plan. They matter once its status file is
 *   unusable and it falls back to inference (Story 2.4).
 * - `codex`: neither is written to its log. Question tools are filled in
 *   from real records by Story 2.5.
 * - `gemini`, `cursor`: approvals are not written; questions are.
 * - `copilot`: questions are not written. Question tools come with its
 *   adapter (Epic 6).
 * - `demo`: the demo adapter emits every request itself.
 */
export const SOURCE_CAPABILITIES: Readonly<
  Record<SourceCode, SourceCapability>
> = Object.freeze({
  'claude-code': capability('exact', 'exact', [
    'AskUserQuestion',
    'ExitPlanMode',
  ]),
  codex: capability('none', 'none'),
  gemini: capability('none', 'exact'),
  cursor: capability('none', 'exact'),
  copilot: capability('exact', 'none'),
  demo: capability('exact', 'exact'),
});

/**
 * Display names of the sources, defined only here. Code compares source
 * codes; these strings are for the display layer only.
 */
export const SOURCE_DISPLAY_NAMES: Readonly<Record<SourceCode, string>> =
  Object.freeze({
    'claude-code': 'Claude Code',
    codex: 'Codex CLI',
    gemini: 'Gemini CLI',
    cursor: 'Cursor',
    copilot: 'Copilot CLI',
    demo: '示範',
  });

/**
 * What demo mode (the `demo` source's adapter) is called wherever the user
 * turns it on: the tray menu and the panel's hint.
 */
export const DEMO_MODE_LABEL = '示範模式';

/**
 * How a running adapter is doing (AD-21), published by main/detection in
 * StageView's `adapters` section:
 *
 * - `ok`: it reads what it should;
 * - `degraded`: it runs but reads less than it should (records it cannot
 *   parse, a status file it cannot use), and fills in what it can;
 * - `missing`: the AI tool's records are not where they should be.
 */
export const ADAPTER_HEALTH_CODES = ['ok', 'degraded', 'missing'] as const;

export const adapterHealthSchema = z.enum(ADAPTER_HEALTH_CODES);

export type AdapterHealth = z.infer<typeof adapterHealthSchema>;

/** Chinese display names of the health codes, defined only here. */
export const ADAPTER_HEALTH_DISPLAY_NAMES: Readonly<
  Record<AdapterHealth, string>
> = Object.freeze({
  ok: '正常',
  degraded: '部分可用',
  missing: '找不到',
});
