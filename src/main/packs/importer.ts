/**
 * main/packs (Story 3.2's second half): the import flow every entry point
 * goes through: the 角色包 page's 匯入角色包… button (main opens the file
 * dialog), a `.awpet` a second launch or the first launch was given, and a
 * macOS `open-file`. It owns StageView's `packImport` section and offers it
 * the way the store offers `packs` (get() and onChange()); the panel only
 * shows it and calls `packs:choose` / `packs:confirm`, which answer at once.
 *
 * One import at a time; `phase` says where it is:
 * - `idle` → `reading`: choose() opens the file dialog (cancelling it goes
 *   back to the phase before, with no error), or start(file) begins; the
 *   pack is checked (inspect, i.e. inspectPack).
 * - A refused pack → `result` `rejected`. A pack of an id not installed is
 *   installed at once (install, i.e. installPack) → `result` `installed`
 *   or `failed`. A pack of an installed id, even the same version, →
 *   `confirm`, the plan held in memory (up to PACK_IMPORT_MAX_TOTAL_BYTES
 *   of files) until confirm(): false → `result` `cancelled`; true →
 *   `reading` while it installs (on the next task, so the IPC answer goes
 *   out first) → `installed` or `failed` (`stale-plan` when another
 *   version was installed meanwhile). The plan is let go either way.
 * - While `reading`, a new import is ignored (one line); choose() and
 *   start() do nothing. While `confirm`, start(file) cancels the waiting
 *   pack and begins the new one; choose() does nothing (the button is
 *   disabled then). confirm() outside `confirm` does nothing.
 * - A check or install that throws (a bug: neither does for a pack) is
 *   logged as an error and the phase goes back to `idle`.
 *
 * A rejection is published as inspect gave it, except that every quoted
 * name and every manifest path segment goes through quotedName (cut, with
 * control and bidi characters escaped) and an `invalid-manifest` keeps its
 * first PACK_IMPORT_REPORTED_ISSUES_MAX issues, `moreIssues` counting the
 * rest. Log lines carry codes and pack ids only, never a path on the
 * user's disk.
 */
import { PACK_IMPORT_REPORTED_ISSUES_MAX } from '../../shared/constants';
import {
  IDLE_PACK_IMPORT,
  type PackManifestIssue,
  type PackRejection,
  type StagePackImport,
} from '../../shared/packs';
import type { StageViewPackImportSections } from '../../shared/stage-view';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import { quotedName } from './archive';
import type { PackInspection, PackInstallPlan } from './inspect';
import type { PackInstallResult } from './install';

export interface PackImporterOptions<Store> {
  /** main/packs' store: where inspect looks up the installed version and install writes. */
  readonly store: Store;
  /** inspectPack. */
  readonly inspect: (file: string, installed: Store) => Promise<PackInspection>;
  /** installPack. */
  readonly install: (store: Store, plan: PackInstallPlan) => PackInstallResult;
  /**
   * Opens the file dialog and answers the file picked, or null when it was
   * cancelled.
   */
  readonly chooseFile: () => Promise<string | null>;
  /**
   * Runs `run` on a later task (default `setTimeout(run, 0)`), so a
   * confirmed install starts after `packs:confirm` has answered.
   */
  readonly defer?: (run: () => void) => void;
}

export type PackImportListener = (
  sections: StageViewPackImportSections,
) => void;

export interface PackImporter {
  /** The `packImport` section. */
  get(): StageViewPackImportSections;
  /** Called after every change. Returns an unsubscribe. */
  onChange(listener: PackImportListener): () => void;
  /**
   * Opens the file dialog and imports the file picked (the 匯入角色包…
   * button). Settles once that import is done or waits for confirmation;
   * never rejects.
   */
  choose(): Promise<void>;
  /**
   * Imports the `.awpet` at `file` (a second launch, the first launch,
   * `open-file`). Settles once that import is done, waits for
   * confirmation, or was ignored; never rejects.
   */
  start(file: string): Promise<void>;
  /** Replaces the installed version with the waiting pack (true), or not. */
  confirm(replace: boolean): void;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
}

/** A manifest problem with each named path segment quoted. */
function quotedIssue(issue: PackManifestIssue): PackManifestIssue {
  return {
    ...issue,
    path: issue.path.map((part) =>
      typeof part === 'string' ? quotedName(part) : part,
    ),
  };
}

/** A rejection as the `packImport` section carries it (see the module comment). */
function publishedRejection(rejection: PackRejection): StagePackImport {
  let published: PackRejection = rejection;
  let moreIssues = 0;
  if (rejection.code === 'invalid-manifest') {
    const kept = rejection.issues.slice(0, PACK_IMPORT_REPORTED_ISSUES_MAX);
    moreIssues = rejection.issues.length - kept.length;
    published = { code: rejection.code, issues: kept.map(quotedIssue) };
  } else if (rejection.code === 'root-folder-mismatch') {
    published = { ...rejection, folder: quotedName(rejection.folder) };
  } else if ('path' in rejection && rejection.path !== undefined) {
    published = { ...rejection, path: quotedName(rejection.path) };
  }
  return {
    phase: 'result',
    outcome: 'rejected',
    rejection: published,
    moreIssues,
  };
}

export function createPackImporter<Store>({
  store,
  inspect,
  install,
  chooseFile,
  defer = (run) => {
    setTimeout(run, 0);
  },
}: PackImporterOptions<Store>): PackImporter {
  let state: StagePackImport = IDLE_PACK_IMPORT;
  /** The plan of the pack waiting for confirmation; only while `confirm`. */
  let pending: PackInstallPlan | undefined;
  const listeners = new Set<PackImportListener>();

  function set(next: StagePackImport): void {
    state = next;
    const sections = { packImport: next };
    for (const listener of listeners) {
      try {
        listener(sections);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  /** A bug: logged, and the import is over. */
  function broke(step: string, error: unknown): void {
    pending = undefined;
    log(
      `the import failed unexpectedly while ${step} (${errorCode(error)})`,
      'error',
    );
    set(IDLE_PACK_IMPORT);
  }

  function installNow(plan: PackInstallPlan): void {
    let result: PackInstallResult;
    try {
      result = install(store, plan);
    } catch (error) {
      broke('installing', error);
      return;
    }
    set(
      result.ok
        ? {
            phase: 'result',
            outcome: 'installed',
            packId: plan.packId,
            name: plan.name,
            version: plan.version,
          }
        : { phase: 'result', outcome: 'failed', code: result.code },
    );
  }

  /** Checks `file` while `reading`, then installs it or asks to confirm. */
  async function read(file: string): Promise<void> {
    let inspection: PackInspection;
    try {
      inspection = await inspect(file, store);
    } catch (error) {
      broke('checking the file', error);
      return;
    }
    if (!inspection.ok) {
      set(publishedRejection(inspection.rejection));
      return;
    }
    const { plan } = inspection;
    if (plan.previous === null) {
      installNow(plan);
      return;
    }
    pending = plan;
    log(`pack ${plan.packId} is installed already; waiting for confirmation`);
    set({
      phase: 'confirm',
      packId: plan.packId,
      name: plan.name,
      version: plan.version,
      previous: { name: plan.previous.name, version: plan.previous.version },
      downgrade: plan.downgrade,
    });
  }

  return {
    get: () => ({ packImport: state }),

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async choose() {
      if (state.phase === 'reading' || state.phase === 'confirm') {
        log(`the file dialog was not opened: an import is ${state.phase}`);
        return;
      }
      const before = state;
      set({ phase: 'reading' });
      let file: string | null;
      try {
        file = await chooseFile();
      } catch (error) {
        log(`the file dialog failed (${errorCode(error)})`, 'error');
        set(before);
        return;
      }
      if (file === null) {
        log('the file dialog was cancelled');
        set(before);
        return;
      }
      await read(file);
    },

    async start(file) {
      if (state.phase === 'reading') {
        log('ignored a .awpet to import: another import is being read');
        return;
      }
      if (state.phase === 'confirm') {
        log(
          `pack ${state.packId}: no longer waiting for confirmation; a new import came in`,
        );
        pending = undefined;
      }
      set({ phase: 'reading' });
      await read(file);
    },

    confirm(replace) {
      const plan = pending;
      if (state.phase !== 'confirm' || plan === undefined) {
        log('ignored a confirmation: no pack waits for one');
        return;
      }
      pending = undefined;
      if (!replace) {
        log(
          `pack ${plan.packId}: the user did not replace the installed version`,
        );
        set({ phase: 'result', outcome: 'cancelled' });
        return;
      }
      set({ phase: 'reading' });
      defer(() => {
        installNow(plan);
      });
    },
  };
}
