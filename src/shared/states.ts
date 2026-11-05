import { z } from './zod-setup';

/**
 * The 8 stage state codes (AD-6), in AD-6's listing order. This is not the
 * priority order; the reducer owns that (AD-5).
 */
export const STATE_CODES = [
  'waiting',
  'thinking',
  'working',
  'approval',
  'decision',
  'done',
  'idle',
  'error',
] as const;

export const stateCodeSchema = z.enum(STATE_CODES);

export type StateCode = z.infer<typeof stateCodeSchema>;

/**
 * Chinese display names, defined only here. Code compares state codes; these
 * strings are for the display layer only.
 */
export const STATE_DISPLAY_NAMES: Readonly<Record<StateCode, string>> =
  Object.freeze({
    waiting: '等你回覆',
    thinking: '思考中',
    working: '工作中',
    approval: '要你批准',
    decision: '要你決定',
    done: '做完了',
    idle: '休息中',
    error: '出錯了',
  });
