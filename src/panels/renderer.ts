/**
 * Panels renderer entry, loaded by Vite. Runs sandboxed with context
 * isolation: it reaches main only through `window.awp`, which
 * src/preload/panels.ts exposes. Story 1.3 only shows the app version, which
 * also proves the preload loaded and the IPC path works end to end.
 */

import './index.css';
import { PRELOAD_API_KEY } from '../shared/constants';
import type { PanelsApi, PreloadHost } from '../shared/preload-api';

const versionLine = document.createElement('p');
versionLine.id = 'app-version';
versionLine.textContent = '讀取版本中…';
document.body.append(versionLine);

function showError(text: string, ...details: unknown[]): void {
  console.error(`[panels] ${text}`, ...details);
  versionLine.textContent = `錯誤：${text}`;
}

async function showVersion(): Promise<void> {
  const awp = (window as Window & PreloadHost<PanelsApi>)[PRELOAD_API_KEY];
  if (awp === undefined) {
    showError(`window.${PRELOAD_API_KEY} 不存在，preload 沒有載入`);
    return;
  }
  try {
    const result = await awp.app.getVersion();
    if (result.ok) {
      versionLine.textContent = `版本 ${result.data}`;
    } else {
      showError(
        `無法取得版本（${result.error.code}：${result.error.message}）`,
      );
    }
  } catch (error) {
    showError('無法取得版本', error);
  }
}

void showVersion();
