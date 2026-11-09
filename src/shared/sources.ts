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
