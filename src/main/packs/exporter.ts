/**
 * main/packs (Story 3.3's second half): the export flow behind each
 * installed pack's 匯出… button. It owns StageView's `packExport` section
 * and offers it the way the importer offers `packImport` (get() and
 * onChange()); the panel only shows it and calls `packs:export`, which
 * answers at once (the save dialog may stay open far longer than the IPC
 * timeout).
 *
 * One export at a time; `phase` says where it is:
 * - `idle` (or an earlier result) → `saving`: start(packId) opens the save
 *   dialog (chooseTarget), named exportFileName(packId, version) to start
 *   with. Cancelling it, or a dialog that fails, goes back to the phase
 *   before, with no error.
 * - Once a place is picked, exportPack writes the pack there → `result`
 *   `exported` (the name and version written) or `failed` (its code;
 *   `not-installed` when the pack was removed while the dialog was open).
 * - While `saving`, start() does nothing but log one line (the buttons are
 *   disabled then). A pack that is not installed when start() comes is a
 *   `failed` `not-installed` result at once, with no dialog.
 * - An exportPack that rejects (a bug: it never does) is logged as an error
 *   and the phase goes back to `idle`.
 *
 * Removing and importing are not held up by an export. Log lines carry
 * codes and pack ids only, never the place picked.
 */
import { IDLE_PACK_EXPORT, type StagePackExport } from '../../shared/packs';
import type { StageViewPackExportSections } from '../../shared/stage-view';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import { exportFileName, type PackExportResult } from './export';

/** The installed pack of one id, as far as the exporter needs it. */
export interface ExportablePackLookup {
  find(packId: string): { readonly version: string } | undefined;
}

export interface PackExporterOptions<Store extends ExportablePackLookup> {
  /** main/packs' store: where the pack is looked up and read from. */
  readonly store: Store;
  /**
   * Opens the save dialog with `defaultName` as the file name to start
   * with, and answers the place picked, or null when it was cancelled.
   */
  readonly chooseTarget: (defaultName: string) => Promise<string | null>;
  /** export.ts' exportPack. */
  readonly exportPack: (
    store: Store,
    packId: string,
    target: string,
  ) => Promise<PackExportResult>;
}

export type PackExportListener = (
  sections: StageViewPackExportSections,
) => void;

export interface PackExporter {
  /** The `packExport` section. */
  get(): StageViewPackExportSections;
  /** Called after every change. Returns an unsubscribe. */
  onChange(listener: PackExportListener): () => void;
  /**
   * Opens the save dialog and exports the installed pack `packId` to the
   * place picked (the 匯出… button). Settles once that export is done,
   * cancelled or ignored; never rejects.
   */
  start(packId: string): Promise<void>;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('packs', message, level);
}

export function createPackExporter<Store extends ExportablePackLookup>({
  store,
  chooseTarget,
  exportPack,
}: PackExporterOptions<Store>): PackExporter {
  let state: StagePackExport = IDLE_PACK_EXPORT;
  const listeners = new Set<PackExportListener>();

  function set(next: StagePackExport): void {
    state = next;
    const sections = { packExport: next };
    for (const listener of listeners) {
      try {
        listener(sections);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  return {
    get: () => ({ packExport: state }),

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start(packId) {
      if (state.phase === 'saving') {
        log(
          `ignored an export of pack ${packId}: pack ${state.packId} is being exported`,
        );
        return;
      }
      const installed = store.find(packId);
      if (installed === undefined) {
        log(`could not export pack ${packId}: not-installed`, 'warn');
        set({
          phase: 'result',
          outcome: 'failed',
          packId,
          code: 'not-installed',
        });
        return;
      }
      const before = state;
      set({ phase: 'saving', packId });
      let target: string | null;
      try {
        target = await chooseTarget(exportFileName(packId, installed.version));
      } catch (error) {
        log(`the save dialog failed (${errorCode(error)})`, 'error');
        set(before);
        return;
      }
      if (target === null) {
        log('the save dialog was cancelled');
        set(before);
        return;
      }
      let result: PackExportResult;
      try {
        result = await exportPack(store, packId, target);
      } catch (error) {
        log(`the export failed unexpectedly (${errorCode(error)})`, 'error');
        set(IDLE_PACK_EXPORT);
        return;
      }
      set(
        result.ok
          ? {
              phase: 'result',
              outcome: 'exported',
              packId,
              name: result.name,
              version: result.version,
            }
          : { phase: 'result', outcome: 'failed', packId, code: result.code },
      );
    },
  };
}
