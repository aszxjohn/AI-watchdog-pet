/**
 * The panel window: page navigation on the left, the selected page on the
 * right, and a status bar with the app version and the StageView line.
 *
 * The page comes from the URL fragment (`#/<page id>`, src/shared/panels.ts):
 * main opens the window on a page by loading that fragment, and the links on
 * the left change it. 管理 session lists the detected sessions (each can be
 * released or shown again) and the running adapters' health; 舞台設定
 * lists the displays for the canvas and the detection timings (計時);
 * 角色包 shows 即將推出 for now.
 *
 * Renderer state only ever comes from StageView (AD-20): a setting changes
 * through `settings.patch` and a release through `pool.setReleased`, and
 * the page shows the outcome once StageView brings it back, never earlier.
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
          <p className="coming-soon">即將推出</p>
        )}
      </main>
      <footer className="panel-status">
        <Status id="app-version" line={version} />
        <Status id="stage-view" line={stageView.line} />
      </footer>
    </div>
  );
}
