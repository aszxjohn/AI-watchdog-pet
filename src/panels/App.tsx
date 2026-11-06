/**
 * The panel window: page navigation on the left, the selected page on the
 * right, and a status bar with the app version and the StageView line.
 *
 * The page comes from the URL fragment (`#/<page id>`, src/shared/panels.ts):
 * main opens the window on a page by loading that fragment, and the links on
 * the left change it. Every page shows 即將推出 for now.
 *
 * The status lines prove the preload loaded and both IPC paths (invoke and
 * the StageView push) work end to end; renderer state only ever comes from
 * StageView (AD-20).
 */
import { useEffect, useState } from 'react';
import { PRELOAD_API_KEY, PRODUCT_NAME } from '../shared/constants';
import { PANEL_PAGES, panelPageHash, type PanelPageId } from '../shared/panels';
import type { PanelsApi } from '../shared/preload-api';
import type { StageViewSnapshot } from '../shared/stage-view';
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

function stageViewText(snapshot: StageViewSnapshot): string {
  const displayId = snapshot.view.settings.values.canvasDisplayId;
  const display = displayId === null ? '主螢幕' : String(displayId);
  return `StageView rev ${snapshot.rev}｜畫布螢幕：${display}`;
}

function useStageViewLine(awp: PanelsApi | undefined): StatusLine {
  const [line, setLine] = useState(() => pending('讀取 StageView 中…'));
  useEffect(() => {
    if (awp === undefined) {
      setLine(failure(MISSING_PRELOAD));
      return undefined;
    }
    try {
      return awp.stageView.subscribe(
        (snapshot) => {
          setLine(pending(stageViewText(snapshot)));
        },
        (error) => {
          setLine(
            failure(`無法取得 StageView（${error.code}：${error.message}）`),
          );
        },
      );
    } catch (error) {
      setLine(failure('無法訂閱 StageView', error));
      return undefined;
    }
  }, [awp]);
  return line;
}

function Status({ id, line }: { id: string; line: StatusLine }) {
  return (
    <p id={id} className={line.error ? 'status-line is-error' : 'status-line'}>
      {line.text}
    </p>
  );
}

export function App({ awp }: { awp: PanelsApi | undefined }) {
  const page = useHashPage();
  const version = useVersionLine(awp);
  const stageView = useStageViewLine(awp);
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
        <p className="coming-soon">即將推出</p>
      </main>
      <footer className="panel-status">
        <Status id="app-version" line={version} />
        <Status id="stage-view" line={stageView} />
      </footer>
    </div>
  );
}
