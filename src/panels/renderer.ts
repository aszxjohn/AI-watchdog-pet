/**
 * Panels renderer entry, loaded by Vite. Runs sandboxed with context
 * isolation: it reaches main only through `window.awp`, which
 * src/preload/panels.ts exposes. For now it shows the app version and one
 * StageView line, which together prove the preload loaded and both the
 * invoke and the StageView push paths work end to end.
 */

import './index.css';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { PanelsApi, PreloadHost } from '../shared/preload-api';
import type { StageViewSnapshot } from '../shared/stage-view';

const versionLine = document.createElement('p');
versionLine.id = 'app-version';
versionLine.textContent = '讀取版本中…';

const stageViewLine = document.createElement('p');
stageViewLine.id = 'stage-view';
stageViewLine.textContent = '讀取 StageView 中…';

document.body.append(versionLine, stageViewLine);

function showError(
  line: HTMLElement,
  text: string,
  ...details: unknown[]
): void {
  console.error(`[panels] ${text}`, ...details);
  line.textContent = `錯誤：${text}`;
}

async function showVersion(awp: PanelsApi): Promise<void> {
  try {
    const result = await awp.app.getVersion();
    if (result.ok) {
      versionLine.textContent = `版本 ${result.data}`;
    } else {
      showError(
        versionLine,
        `無法取得版本（${result.error.code}：${result.error.message}）`,
      );
    }
  } catch (error) {
    showError(versionLine, '無法取得版本', error);
  }
}

function showStageView(snapshot: StageViewSnapshot): void {
  const displayId = snapshot.view.settings.values.canvasDisplayId;
  const display = displayId === null ? '主螢幕' : String(displayId);
  stageViewLine.textContent = `StageView rev ${snapshot.rev}｜畫布螢幕：${display}`;
}

function subscribeStageView(awp: PanelsApi): void {
  try {
    awp.stageView.subscribe(showStageView, (error) => {
      showError(
        stageViewLine,
        `無法取得 StageView（${error.code}：${error.message}）`,
      );
    });
  } catch (error) {
    showError(stageViewLine, '無法訂閱 StageView', error);
  }
}

const awp = (window as Window & PreloadHost<PanelsApi>)[PRELOAD_API_KEY];
if (awp === undefined) {
  const reason = `window.${PRELOAD_API_KEY} 不存在，preload 沒有載入`;
  showError(versionLine, reason);
  showError(stageViewLine, reason);
} else {
  void showVersion(awp);
  subscribeStageView(awp);
}
