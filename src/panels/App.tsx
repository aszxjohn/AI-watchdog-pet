/**
 * The panel window: page navigation on the left, the selected page on the
 * right, and a status bar with the app version and the StageView line.
 *
 * The page comes from the URL fragment (`#/<page id>`, src/shared/panels.ts):
 * main opens the window on a page by loading that fragment, and the links on
 * the left change it. 管理 session lists the detected sessions (each can be
 * released or shown again) and the running adapters' health; 舞台設定
 * lists the displays for the canvas and the detection timings (計時);
 * 角色包 lists the installed packs (上場, and 加入池子 per character; 匯出…
 * and 移除… per pack, with how the export went and the removal asked on
 * the pack's row) above the import (匯入角色包…, how it went, the replace
 * confirmation).
 *
 * Renderer state only ever comes from StageView (AD-20): a setting changes
 * through `settings.patch` (上場 and 加入池子 too), a release through
 * `pool.setReleased`, an import through `packs.choose` / `packs.confirm`,
 * an export through `packs.export` and a removal through `packs.remove`,
 * and the page shows the outcome once StageView brings it back, never
 * earlier.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PRELOAD_API_KEY, PRODUCT_NAME } from '../shared/constants';
import { PANEL_PAGES, panelPageHash, type PanelPageId } from '../shared/panels';
import type { PanelsApi } from '../shared/preload-api';
import type { SettingsState } from '../shared/settings';
import type { StageViewSnapshot } from '../shared/stage-view';
import {
  createDisplayChooser,
  displayChoices,
  IDLE_DISPLAY_CHOICE,
  stageViewStatusText,
  type DisplayChoiceState,
} from './display-options';
import { currentHashPage, followHashPage } from './hash-page';
import {
  createPackImportActions,
  IDLE_PACK_IMPORT_ACTIONS,
  IMPORT_BUTTON_LABEL,
  PACK_IMPORT_HEADING,
  packImportControls,
  packImportView,
  type PackImportActionState,
} from './pack-import';
import {
  createPackListActions,
  createPackRowActions,
  ENABLED_LABEL,
  IDLE_PACK_LIST_ACTIONS,
  IDLE_PACK_ROW_ACTIONS,
  IN_POOL_LABEL,
  NO_PACKS_TEXT,
  PACK_LIST_HEADING,
  packExportStatus,
  packListDisabled,
  packListView,
  packRowControls,
  type PackListActionState,
  type PackListCheckbox,
  type PackRowActionState,
  type PackRowButton,
  type PackRowPress,
} from './pack-list';
import {
  ADAPTERS_HEADING,
  adapterRows,
  createReleaseToggle,
  DEMO_MODE_HINT,
  IDLE_RELEASE_TOGGLE,
  INFERRED_LABEL,
  inferredTitle,
  NO_ADAPTERS_TEXT,
  NO_SESSIONS_TEXT,
  RELEASED_LABEL,
  SESSION_COLUMNS,
  SESSIONS_HEADING,
  sessionRows,
  type ReleaseToggleState,
} from './session-rows';
import {
  createTimingSaver,
  IDLE_TIMING_SAVE,
  SAVE_LABEL,
  TIMING_HEADING,
  timingForm,
  type TimingDrafts,
  type TimingSaveState,
} from './timing-fields';

interface StatusLine {
  readonly text: string;
  readonly error: boolean;
}

const MISSING_PRELOAD = `window.${PRELOAD_API_KEY} 不存在，preload 沒有載入`;

function pending(text: string): StatusLine {
  return { text, error: false };
}

function failure(text: string, ...details: unknown[]): StatusLine {
  console.error(`[panels] ${text}`, ...details);
  return { text: `錯誤：${text}`, error: true };
}

/** The page the URL fragment selects, following later fragment changes. */
function useHashPage(): PanelPageId {
  const [page, setPage] = useState(() => currentHashPage(window));
  useEffect(() => followHashPage(window, setPage), []);
  return page;
}

function useVersionLine(awp: PanelsApi | undefined): StatusLine {
  const [line, setLine] = useState(() => pending('讀取版本中…'));
  useEffect(() => {
    if (awp === undefined) {
      setLine(failure(MISSING_PRELOAD));
      return undefined;
    }
    let active = true;
    awp.app.getVersion().then(
      (result) => {
        if (!active) {
          return;
        }
        setLine(
          result.ok
            ? pending(`版本 ${result.data}`)
            : failure(
                `無法取得版本（${result.error.code}：${result.error.message}）`,
              ),
        );
      },
      (error: unknown) => {
        if (active) {
          setLine(failure('無法取得版本', error));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [awp]);
  return line;
}

interface StageViewState {
  /** The latest StageView, or null until the first snapshot arrives. */
  readonly snapshot: StageViewSnapshot | null;
  readonly line: StatusLine;
}

/** The StageView subscription, shared by the status bar and the pages. */
function useStageView(awp: PanelsApi | undefined): StageViewState {
  const [state, setState] = useState<StageViewState>(() => ({
    snapshot: null,
    line: pending('讀取 StageView 中…'),
  }));
  useEffect(() => {
    if (awp === undefined) {
      setState({ snapshot: null, line: failure(MISSING_PRELOAD) });
      return undefined;
    }
    try {
      return awp.stageView.subscribe(
        (snapshot) => {
          setState({ snapshot, line: pending(stageViewStatusText(snapshot)) });
        },
        (error) => {
          const line = failure(
            `無法取得 StageView（${error.code}：${error.message}）`,
          );
          setState((previous) => ({ snapshot: previous.snapshot, line }));
        },
      );
    } catch (error) {
      setState({ snapshot: null, line: failure('無法訂閱 StageView', error) });
      return undefined;
    }
  }, [awp]);
  return state;
}

function Status({ id, line }: { id: string; line: StatusLine }) {
  return (
    <p id={id} className={line.error ? 'status-line is-error' : 'status-line'}>
      {line.text}
    </p>
  );
}

/**
 * 舞台設定 › 計時: the three timings a user may change, each with its unit
 * and range. The logic (what the fields show, which drafts are changes or
 * invalid, the one patch 儲存 sends, the fields and 儲存 disabled until
 * main answers) is in timing-fields.ts; this keeps the drafts and renders
 * it. The drafts are dropped once main applied them, and whenever the page
 * goes away unsaved (nothing holds the panel open).
 */
function TimingSettings({
  awp,
  settings,
}: {
  awp: PanelsApi | undefined;
  settings: SettingsState;
}) {
  const [drafts, setDrafts] = useState<TimingDrafts>({});
  const [state, setState] = useState<TimingSaveState>(IDLE_TIMING_SAVE);
  const saver = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createTimingSaver((patch) => awp.settings.patch(patch), setState),
    [awp],
  );
  const form = timingForm(settings, drafts);
  const disabled = state.saving || saver === undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saver?.save(settings, drafts).then((applied) => {
      if (applied) {
        setDrafts({});
      }
    });
  }

  return (
    <section className="setting timing">
      <form onSubmit={submit} noValidate>
        <fieldset disabled={disabled}>
          <legend>{TIMING_HEADING}</legend>
          {form.fields.map((field) => {
            const id = `timing-${field.field}`;
            return (
              <div key={field.field} className="timing-field">
                <label htmlFor={id}>{field.label}</label>
                <input
                  id={id}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={field.text}
                  aria-invalid={field.error !== null}
                  aria-describedby={`${id}-unit ${id}-range${field.error === null ? '' : ` ${id}-error`}`}
                  onChange={(event) => {
                    const text = event.target.value;
                    setDrafts((previous) => ({
                      ...previous,
                      [field.field]: text,
                    }));
                    // A new edit: the last save's outcome no longer
                    // describes the fields. A save on its way keeps its state.
                    setState((previous) =>
                      previous.saving ? previous : IDLE_TIMING_SAVE,
                    );
                  }}
                />
                <span id={`${id}-unit`} className="timing-unit">
                  {field.unit}
                </span>
                <span id={`${id}-range`} className="hint">
                  {field.range}
                </span>
                {field.error === null ? null : (
                  <p id={`${id}-error`} className="timing-error">
                    {field.error}
                  </p>
                )}
              </div>
            );
          })}
          <button type="submit" disabled={disabled || form.patch === null}>
            {SAVE_LABEL}
          </button>
        </fieldset>
      </form>
      {state.outcome === null ? null : state.outcome.kind === 'error' ? (
        <p className="setting-error" role="alert">
          {state.outcome.text}
        </p>
      ) : (
        <p
          className={
            state.outcome.kind === 'saved'
              ? 'setting-status'
              : 'setting-status is-warning'
          }
          role="status"
        >
          {state.outcome.text}
        </p>
      )}
    </section>
  );
}

/**
 * 舞台設定: where the canvas goes, then 計時 (TimingSettings). The choose
 * logic (patch based on the settings rev in StageView, options disabled
 * until main answers, a failure shown with the choice left as it was, a
 * notice when main applied it without keeping settings.json) is
 * createDisplayChooser; this only renders it.
 */
function StageSettings({
  awp,
  snapshot,
}: {
  awp: PanelsApi | undefined;
  snapshot: StageViewSnapshot | null;
}) {
  const [state, setState] = useState<DisplayChoiceState>(IDLE_DISPLAY_CHOICE);
  const chooser = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createDisplayChooser((patch) => awp.settings.patch(patch), setState),
    [awp],
  );

  if (snapshot === null) {
    return <p className="coming-soon">讀取中…</p>;
  }
  const { options, selected } = displayChoices(snapshot.view);
  const current = { selected, settingsRev: snapshot.view.settings.rev };

  return (
    <>
      <section className="setting">
        <fieldset disabled={state.saving || chooser === undefined}>
          <legend>畫布所在螢幕</legend>
          {options.map((option) => (
            <label key={option.key} className="setting-option">
              <input
                type="radio"
                name="canvas-display"
                value={option.key}
                checked={option.key === selected}
                onChange={() => {
                  void chooser?.choose(option, current);
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        {state.error === null ? null : (
          <p className="setting-error" role="alert">
            {state.error}
          </p>
        )}
        {state.notice === null ? null : (
          <p className="setting-status is-warning" role="status">
            {state.notice}
          </p>
        )}
      </section>
      <TimingSettings awp={awp} settings={snapshot.view.settings} />
    </>
  );
}

/**
 * 管理 session: the sessions main/detection publishes and the health of
 * each running adapter, read from StageView only. Text and order come from
 * session-rows.ts; an inferred state carries a 推測 mark, a released
 * session is faded and marked 已釋放. The 釋放 / 改回顯示 logic (buttons
 * disabled until main answers, a failure shown with the rows left as
 * StageView has them) is createReleaseToggle; this only renders it.
 */
function Sessions({
  awp,
  snapshot,
}: {
  awp: PanelsApi | undefined;
  snapshot: StageViewSnapshot | null;
}) {
  const [release, setRelease] =
    useState<ReleaseToggleState>(IDLE_RELEASE_TOGGLE);
  const toggle = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createReleaseToggle(
            (sessionKey, released) =>
              awp.pool.setReleased(sessionKey, released),
            setRelease,
          ),
    [awp],
  );

  if (snapshot === null) {
    return <p className="coming-soon">讀取中…</p>;
  }
  const rows = sessionRows(snapshot.view);
  const adapters = adapterRows(snapshot.view);

  return (
    <>
      <section className="sessions" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">{SESSIONS_HEADING}</h2>
        {rows.length === 0 ? (
          <div className="sessions-empty">
            <p>{NO_SESSIONS_TEXT}</p>
            <p className="hint">{DEMO_MODE_HINT}</p>
          </div>
        ) : (
          <table className="session-table">
            <thead>
              <tr>
                {SESSION_COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  data-state={row.stateCode}
                  className={row.released ? 'is-released' : undefined}
                >
                  <td>{row.source}</td>
                  <td>
                    {row.name}
                    {row.released ? (
                      <span className="released-mark">{RELEASED_LABEL}</span>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={
                        row.inferred
                          ? 'session-state is-inferred'
                          : 'session-state'
                      }
                    >
                      {row.state}
                    </span>
                    {row.inferred ? (
                      <span
                        className="inferred-mark"
                        title={inferredTitle(row.stateCode)}
                      >
                        {INFERRED_LABEL}
                      </span>
                    ) : null}
                  </td>
                  <td className="session-action">
                    <button
                      type="button"
                      aria-label={`${row.action} ${row.name}`}
                      disabled={release.sending || toggle === undefined}
                      onClick={() => {
                        void toggle?.toggle(row);
                      }}
                    >
                      {row.action}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {release.error === null ? null : (
          <p className="setting-error" role="alert">
            {release.error}
          </p>
        )}
      </section>
      <section className="adapters" aria-labelledby="adapters-heading">
        <h2 id="adapters-heading">{ADAPTERS_HEADING}</h2>
        {adapters.length === 0 ? (
          <p className="coming-soon">{NO_ADAPTERS_TEXT}</p>
        ) : (
          <ul className="adapter-list">
            {adapters.map((adapter) => (
              <li key={adapter.key} data-health={adapter.healthCode}>
                <span>{adapter.source}</span>
                <span className="adapter-health">{adapter.health}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * One checkbox of the installed list, labelled `label`; `describedBy` is
 * the id of the element that describes it (the height hint), if any.
 */
function PackListCheckboxField({
  checkbox,
  label,
  disabled,
  onToggle,
  describedBy = null,
}: {
  checkbox: PackListCheckbox;
  label: string;
  disabled: boolean;
  onToggle: (checkbox: PackListCheckbox) => void;
  describedBy?: string | null;
}) {
  return (
    <label className="pack-checkbox">
      <input
        id={checkbox.id}
        type="checkbox"
        checked={checkbox.checked}
        disabled={disabled}
        aria-label={checkbox.ariaLabel}
        aria-describedby={describedBy ?? undefined}
        onChange={() => {
          onToggle(checkbox);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/** One of a row's buttons (匯出…, 移除…, or 移除 / 取消 on its question). */
function PackRowButtonField({
  button,
  onPress,
}: {
  button: PackRowButton;
  onPress: (press: PackRowPress) => void;
}) {
  return (
    <button
      type="button"
      disabled={button.disabled}
      aria-label={button.ariaLabel}
      onClick={() => {
        onPress(button.press);
      }}
    >
      {button.label}
    </button>
  );
}

/**
 * 角色包 › 已安裝: every installed pack with its name, version, 上場,
 * 匯出… and 移除…, and under it its characters, each with 加入池子 and the
 * height hint; under the list, how the last export went.
 * What each shows and the one op each checkbox sends is packListView,
 * from StageView's `packs` and `settings` sections; when the checkboxes
 * are disabled is packListDisabled; the send logic (a failure or the
 * not-saved notice shown, the checkboxes left as StageView has them) is
 * createPackListActions. A row's buttons and its removal question are
 * packRowControls (from StageView's `packExport` section and which row
 * asks, the page's own state), what pressing one does is
 * createPackRowActions, and the export status line is packExportStatus.
 * This only renders them. A checkbox is controlled by StageView, so a
 * click shows only once main applied it; a removed pack's row goes once
 * StageView's `packs` section drops it.
 */
function PackList({
  awp,
  snapshot,
}: {
  awp: PanelsApi | undefined;
  snapshot: StageViewSnapshot;
}) {
  const [state, setState] = useState<PackListActionState>(
    IDLE_PACK_LIST_ACTIONS,
  );
  const actions = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createPackListActions(
            { patch: (patch) => awp.settings.patch(patch) },
            setState,
          ),
    [awp],
  );

  const [rowState, setRowState] = useState<PackRowActionState>(
    IDLE_PACK_ROW_ACTIONS,
  );
  const rowActions = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createPackRowActions(
            {
              export: (packId) => awp.packs.export(packId),
              remove: (packId) => awp.packs.remove(packId),
            },
            setRowState,
          ),
    [awp],
  );

  const { settings, packs, packExport } = snapshot.view;
  const list = packListView(packs, settings.values);
  const disabled = packListDisabled(state.saving, actions !== undefined);
  const toggle = (checkbox: PackListCheckbox) => {
    void actions?.toggle(checkbox.toggle, settings.rev);
  };
  const press = (rowPress: PackRowPress) => {
    void rowActions?.press(rowPress);
  };
  const exportStatus = packExportStatus(packExport);

  return (
    <section className="pack-list" aria-labelledby="pack-list-heading">
      <h2 id="pack-list-heading">{PACK_LIST_HEADING}</h2>
      {list.length === 0 ? (
        <p className="coming-soon">{NO_PACKS_TEXT}</p>
      ) : (
        <ul className="pack-list-items">
          {list.map((pack) => {
            const controls = packRowControls(
              pack,
              packExport,
              rowState,
              rowActions !== undefined,
            );
            return (
              <li
                key={pack.id}
                className={
                  pack.enabled.checked ? 'pack-item' : 'pack-item is-benched'
                }
              >
                <div className="pack-item-header">
                  <bdi className="pack-name">{pack.name}</bdi>
                  <span className="pack-version">{pack.version}</span>
                  <PackListCheckboxField
                    checkbox={pack.enabled}
                    label={ENABLED_LABEL}
                    disabled={disabled}
                    onToggle={toggle}
                  />
                  <span className="pack-item-actions">
                    {controls.buttons.map((button) => (
                      <PackRowButtonField
                        key={button.key}
                        button={button}
                        onPress={press}
                      />
                    ))}
                  </span>
                </div>
                {controls.confirm === null ? null : (
                  <div
                    className="pack-remove-confirm"
                    role="group"
                    aria-labelledby={controls.confirm.id}
                  >
                    <p id={controls.confirm.id}>{controls.confirm.text}</p>
                    <div className="pack-remove-confirm-actions">
                      {controls.confirm.buttons.map((button) => (
                        <PackRowButtonField
                          key={button.key}
                          button={button}
                          onPress={press}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <ul className="pack-characters">
                  {pack.characters.map((character) => (
                    <li key={character.key} className="pack-character">
                      <bdi className="pack-character-name">
                        {character.name}
                      </bdi>
                      <PackListCheckboxField
                        checkbox={character.inPool}
                        label={IN_POOL_LABEL}
                        disabled={disabled}
                        onToggle={toggle}
                        describedBy={character.heightHintId}
                      />
                      {character.heightHint === null ? null : (
                        <span
                          id={character.heightHintId ?? undefined}
                          className="pack-height-hint"
                        >
                          {character.heightHint}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {exportStatus === null ? null : (
        <p
          className={`pack-export-status is-${exportStatus.tone}`}
          role={exportStatus.tone === 'error' ? 'alert' : 'status'}
        >
          {exportStatus.text}
        </p>
      )}
      {rowState.error === null ? null : (
        <p className="setting-error" role="alert">
          {rowState.error}
        </p>
      )}
      {state.error === null ? null : (
        <p className="setting-error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice === null ? null : (
        <p className="setting-status is-warning" role="status">
          {state.notice}
        </p>
      )}
    </section>
  );
}

/**
 * 角色包 › 匯入: the 匯入角色包… button, the status line (with the manifest
 * problems of a refusal under it) and, while a pack of an installed id
 * waits, the replace confirmation (取代 / 取消, with the downgrade
 * warning). What each shows is packImportView, from StageView's
 * `packImport` section; which buttons are disabled and what each sends is
 * packImportControls; the send logic (a failure shown with the section
 * left as it is) is createPackImportActions. This only renders them.
 */
function PackImport({
  awp,
  snapshot,
}: {
  awp: PanelsApi | undefined;
  snapshot: StageViewSnapshot;
}) {
  const [state, setState] = useState<PackImportActionState>(
    IDLE_PACK_IMPORT_ACTIONS,
  );
  const actions = useMemo(
    () =>
      awp === undefined
        ? undefined
        : createPackImportActions(
            {
              choose: () => awp.packs.choose(),
              confirm: (replace) => awp.packs.confirm(replace),
            },
            setState,
          ),
    [awp],
  );

  const view = packImportView(snapshot.view.packImport);
  const controls = packImportControls(
    view,
    state.sending,
    actions !== undefined,
  );

  return (
    <section className="pack-import" aria-labelledby="pack-import-heading">
      <h2 id="pack-import-heading">{PACK_IMPORT_HEADING}</h2>
      <button
        type="button"
        disabled={controls.importDisabled}
        onClick={() => {
          void actions?.choose();
        }}
      >
        {IMPORT_BUTTON_LABEL}
      </button>
      {view.status === null ? null : (
        <div
          className={`pack-import-status is-${view.status.tone}`}
          role={view.status.tone === 'error' ? 'alert' : 'status'}
        >
          <p>{view.status.text}</p>
          {view.status.details.length === 0 ? null : (
            <ul>
              {view.status.details.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {view.confirm === null ? null : (
        <div
          className="pack-confirm"
          role="group"
          aria-labelledby="pack-confirm-question"
        >
          <p id="pack-confirm-question">{view.confirm.question}</p>
          {view.confirm.downgradeWarning === null ? null : (
            <p className="pack-confirm-warning">
              {view.confirm.downgradeWarning}
            </p>
          )}
          <div className="pack-confirm-actions">
            {controls.confirmButtons.map((button) => (
              <button
                key={button.key}
                type="button"
                disabled={button.disabled}
                onClick={() => {
                  void actions?.confirm(button.replace);
                }}
              >
                {button.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {state.error === null ? null : (
        <p className="setting-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

/** 角色包: the installed list (PackList), then the import (PackImport). */
function Packs({
  awp,
  snapshot,
}: {
  awp: PanelsApi | undefined;
  snapshot: StageViewSnapshot | null;
}) {
  if (snapshot === null) {
    return <p className="coming-soon">讀取中…</p>;
  }
  return (
    <>
      <PackList awp={awp} snapshot={snapshot} />
      <PackImport awp={awp} snapshot={snapshot} />
    </>
  );
}

export function App({ awp }: { awp: PanelsApi | undefined }) {
  const page = useHashPage();
  const version = useVersionLine(awp);
  const stageView = useStageView(awp);
  const current = PANEL_PAGES.find((entry) => entry.id === page);

  return (
    <div className="panel">
      <nav className="panel-nav" aria-label="面板頁面">
        <p className="panel-brand">{PRODUCT_NAME}</p>
        <ul>
          {PANEL_PAGES.map((entry) => (
            <li key={entry.id}>
              <a
                href={panelPageHash(entry.id)}
                aria-current={entry.id === page ? 'page' : undefined}
              >
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="panel-page" data-page={page}>
        <h1>{current?.label}</h1>
        {page === 'settings' ? (
          <StageSettings awp={awp} snapshot={stageView.snapshot} />
        ) : page === 'sessions' ? (
          <Sessions awp={awp} snapshot={stageView.snapshot} />
        ) : (
          <Packs awp={awp} snapshot={stageView.snapshot} />
        )}
      </main>
      <footer className="panel-status">
        <Status id="app-version" line={version} />
        <Status id="stage-view" line={stageView.line} />
      </footer>
    </div>
  );
}
