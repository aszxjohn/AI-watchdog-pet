/**
 * main/packs (Story 3.5): the run log lines the overlay asks for about
 * the packs' sandboxes (`packs:log`). Every line names the pack; the
 * entry has passed its schema already (English codes, ids, versions and
 * removal names only), and the one free text, a pack's `stage.log`, goes
 * through quotedName: control and bidi characters escaped, cut at
 * STAGE_LOG_MAX_LENGTH.
 */
import { SANDBOX_IDLE_MS, STAGE_LOG_MAX_LENGTH } from '../../shared/constants';
import type {
  PackLogEntry,
  SandboxDestroyReason,
  SandboxRemoval,
} from '../../shared/sandbox';
import { logEvent, type ConsoleLevel } from '../log/run-log';
import { quotedName } from './archive';

/** `removed: a, b; absent: c` for the removals' statuses that occur. */
function removalsText(removals: readonly SandboxRemoval[]): string {
  const byStatus = new Map<string, string[]>();
  for (const { name, status } of removals) {
    const names = byStatus.get(status) ?? [];
    names.push(name);
    byStatus.set(status, names);
  }
  return [...byStatus]
    .map(([status, names]) => `${status}: ${names.join(', ')}`)
    .join('; ');
}

/** Why a sandbox went, as its line says it. */
const DESTROY_TEXTS: Readonly<Record<SandboxDestroyReason, string>> =
  Object.freeze({
    idle: `no actor for ${SANDBOX_IDLE_MS} ms`,
    'not-installed': 'its pack is no longer installed',
    'api-incompatible': 'its pack no longer fits the stage API',
    'version-changed': 'its pack is installed at another version now',
  });

function messages(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

/** The run log line for `entry` and the console level it goes at. */
export function packLogLine(entry: PackLogEntry): {
  readonly message: string;
  readonly level: ConsoleLevel;
} {
  const pack = `pack ${entry.packId}`;
  switch (entry.kind) {
    case 'stage-log':
      return {
        message: `${pack}: stage.log: ${quotedName(entry.text, STAGE_LOG_MAX_LENGTH)}`,
        level: 'info',
      };
    case 'sandbox-ready':
      return {
        message: `${pack}: sandbox ready (version ${entry.version}; ${removalsText(entry.removals)}; console ${entry.consoleLines} lines up to the end of lockdown)`,
        level: 'info',
      };
    case 'sandbox-destroyed':
      return {
        message: `${pack}: sandbox destroyed (${DESTROY_TEXTS[entry.reason]})`,
        level: 'info',
      };
    case 'sandbox-failed': {
      const details = [
        entry.removals === undefined || entry.removals.length === 0
          ? undefined
          : removalsText(entry.removals),
        entry.consoleLines === undefined
          ? undefined
          : `console ${entry.consoleLines} lines`,
      ].filter((part) => part !== undefined);
      return {
        message: `${pack}: sandbox failed (${entry.reason}); its iframe was removed${details.length === 0 ? '' : ` (${details.join('; ')})`}`,
        level: 'error',
      };
    }
    case 'sandbox-skipped':
      return {
        message: `${pack}: has an actor but gets no sandbox (${entry.reason})`,
        level: 'info',
      };
    case 'messages-dropped':
      return {
        message: `${pack}: dropped ${messages(entry.count)} from its sandbox (${entry.reason})`,
        level: 'warn',
      };
  }
}

/** Writes `entry`'s line to the run log (category `packs`). */
export function logPackEntry(entry: PackLogEntry): void {
  const { message, level } = packLogLine(entry);
  logEvent('packs', message, level);
}
