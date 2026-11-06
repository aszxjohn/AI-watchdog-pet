/**
 * The panel window: page navigation on the left, the selected page on the
 * right, and a status bar with the app version and the StageView line.
 *
 * The page comes from the URL fragment (`#/<page id>`, src/shared/panels.ts):
 * main opens the window on a page by loading that fragment, and the links on
 * the left change it. 舞台設定 lists the displays for the canvas; the other
 * pages show 即將推出 for now.
 *
 * Renderer state only ever comes from StageView (AD-20): a setting changes
 * through `settings.patch`, and the page shows the new choice once StageView
 * brings it back, never earlier.
 */
import { useEffect, useMemo, useState } from 'react';
import { PRELOAD_API_KEY, PRODUCT_NAME } from '../shared/constants';
import { PANEL_PAGES, panelPageHash, type PanelPageId } from '../shared/panels';
import type { PanelsApi } from '../shared/preload-api';
import type { StageViewSnapshot } from '../shared/stage-view';
import {
  createDisplayChooser,
  displayChoices,
  IDLE_DISPLAY_CHOICE,
  stageViewStatusText,
  type DisplayChoiceState,
} from './display-options';
import { currentHashPage, followHashPage } from './hash-page';

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
 * 舞台設定: where the canvas goes. The choose logic (patch based on the
 * settings rev in StageView, options disabled until main answers, a failure
 * shown with the choice left as it was) is createDisplayChooser; this only
 * renders it.
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
    </section>
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
