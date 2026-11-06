---
title: 'Story 1.5：選單列／系統匣入口與面板視窗'
type: 'feature'
created: '2026-11-06'
status: 'done'
baseline_commit: '85541c4462f195674c68f2379c7363992880fb62'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** app 目前還是 Forge 模板的樣子：一啟動就開一個視窗，佔著 Dock 和工作列；打包後用 `file://` 載入，所以 IPC 全部被拒絕；沒有單一實例鎖，也沒有 AD-24 的視窗防護（明確的 sandbox、CSP、擋開新視窗、擋導覽、擋權限請求）。使用者沒有常駐的入口。

**Approach:** 建立 `src/main/windows`，負責以下幾件事：
- 選單列／系統匣圖示與選單；
- 面板視窗與 Dock 顯示規則；
- 單一實例；
- `app://` 協定與 scheme 註冊；
- 環境判斷、放行清單與 CSP，以及所有視窗的安全設定。

面板改用 React 19，透過 `window.awp` 訂閱 StageView。頁面目前都顯示「即將推出」。

## Boundaries & Constraints

**Always:**
- 下列各項只在 `src/main/windows` 定義（AD-14、AD-24）：選單內容、視窗建立、環境判斷（是否打包、dev server 來源）、`registerSchemesAsPrivileged`、`app://` 處理器、放行清單與 CSP。
- 所有視窗的安全設定：
  - `sandbox`、`contextIsolation` 開；`nodeIntegration`、`nodeIntegrationInSubFrames`、`nodeIntegrationInWorker` 關。
  - `setWindowOpenHandler` 一律拒絕。
  - `will-frame-navigate` 只允許 `app://`、`pack://`，開發時另外允許 dev server。
  - `setPermissionRequestHandler` 一律拒絕。
- CSP：打包後 `script-src 'self'`。任何環境都不含 `'unsafe-eval'`；開發時只為 Vite dev server 放寬。
- `registerSchemesAsPrivileged` 只在 ready 前呼叫一次：`app` 給 `standard`、`secure`；`pack` 給 `standard`、`secure`、`corsEnabled`。兩者都不給 `bypassCSP`。
- 面板頁的 id 是英文代碼（`sessions`、`packs`、`settings`），中文名稱只在 `src/shared` 定義一次，選單與面板共用。
- 拿不到單一實例鎖，或者是 Squirrel 事件啟動時，直接結束，不初始化運行紀錄、設定與 IPC。
- React 只能出現在 `src/panels`。
- 新套件鎖定確切版本，照架構 Stack 表。

**Never:**
- 不做 Story 1.6、3.2 的範圍：畫布視窗、overlay、舞台設定頁的實際內容、`pack://` 處理器、依視窗限制 IPC 通道。
- 不做開機自動啟動、檔案關聯、自動更新。
- 不用 `'unsafe-eval'`、不用 `bypassCSP`、不用 `file://` 載入。
- 不動 `prototypes/`。
- 程式本身不連網。
- 不執行任何 git 指令。

**Decisions（使用者 2026-11-06 決定）:**
- 圖示：用程式畫的佔位圓環。macOS 用黑色 template 圖示；Windows 用灰色實心圖示，深淺工作列都看得到。之後再換成正式圖示。
- 面板：一個面板視窗，左側切換「管理 session／角色包／舞台設定」。從選單點哪一項，就打開這個視窗並切到那一頁。之後的角色編輯頁也放在同一個視窗。
- 主面板是「管理 session」。第一次啟動不自動開面板，只出現選單列圖示。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 啟動 | 第一次啟動 | 選單列／系統匣出現 app 圖示；macOS Dock 沒有圖示 | 圖示建立失敗：記一行，app 照常常駐 |
| 開頁面 | 從選單點「管理 session」「角色包」或「舞台設定」 | 打開面板並顯示該頁（目前三頁都是「即將推出」）；面板已經開著時切到該頁並帶到前景 | — |
| 有面板開著 | 第一個面板開啟 | macOS 出現 Dock 圖示、可以 ⌘Tab；Windows 工作列有面板按鈕、可以 Alt+Tab | — |
| 面板全關 | 關掉最後一個面板 | macOS 的 Dock 圖示消失；app 繼續常駐，不結束 | — |
| 結束 | 從選單點「結束」 | app 結束，結束前照 Story 1.4 寫完設定 | — |
| 再啟動一次 | app 已在執行，又從應用程式資料夾、Spotlight 或開始選單啟動 | 不開第二個實例，原本的實例打開主面板並帶到前景 | 第二個行程直接結束，不初始化任何東西 |
| Squirrel 事件 | 以 `--squirrel-*` 參數啟動 | 直接結束，不初始化運行紀錄與設定 | — |
| 打包後載入 | 打包版開面板 | 從 `app://panels/` 載入；`app:get-version` 與 StageView 都正常 | — |
| 不合法的 `app://` 請求 | 不存在的檔、含 `..`、未知的 host | 回 404，不讀 renderer 輸出目錄以外的檔 | — |
| 開新視窗 | 頁面呼叫 `window.open`，或點了 `target=_blank` 的連結 | 拒絕 | 記一行 |
| 導覽到不允許的網址 | 框架要導覽到 `app://`、`pack://`（開發時再加 dev server）以外的網址 | 阻止 | 記一行 |
| 權限請求 | 頁面要求通知、相機等權限 | 拒絕 | — |
| 對外請求 | 對不在放行清單上的來源發出 http(s)、ws 等請求 | 取消 | 同一個來源只記一次 |
| 面板出錯 | 面板的 renderer 當掉，或頁面載入失敗 | 記一行並關閉該面板，可以從選單重新打開 | — |

</frozen-after-approval>

## Code Map

- `src/main/main.ts`
  - 目前 `if (started) app.quit()` 不會中止模組執行，後面的 `initRunLog`、`loadSettings` 仍然會跑（Story 1.4 延後的 B8）。
  - 模板的 `createWindow` 用 `MAIN_WINDOW_VITE_*`，打包後走 `loadFile`；`window-all-closed` 在非 macOS 會結束 app。這些都要改寫。
  - Story 1.4 的接線（`initRunLog` → `loadSettings` → `createStageView` → 註冊 handler → `flushSettingsOnQuit`）要保留。
- `src/main/ipc/origin.ts`：裡面的 `devServerOrigin()` 讀 `MAIN_WINDOW_VITE_DEV_SERVER_URL`，註解寫「Story 1.5 搬到 main/windows」。register.ts 與 push.ts 共用它。
- `forge.config.mts`：renderer 的 `name` 是 `main_window`；`packagerConfig` 有 `asar`、`executableName`；preload 入口有 `panels.ts`、`overlay.ts`。
- `src/forge-env.d.ts`：只 reference Forge 的型別；那個型別只宣告 `MAIN_WINDOW_*`。renderer 改名後，要在這裡宣告新的常數。
- `vite.renderer.config.mts`：root 是 `src/panels`，`outDir` 固定在 `.vite/renderer/<name>`。
- `src/panels/`：`index.html` 仍是模板的 Hello World；`renderer.ts` 顯示版本與 StageView 那一行；`env.d.ts` 宣告 `*.css`。
- `tsconfig.web.json`：DOM、`types: []`，沒有 jsx 設定。`.dependency-cruiser.cjs` 已有 `overlay-no-react`。
- `prototypes/sandbox/main.cjs`
  - 第 505–520 行與 740–760 行是實測可用的 `app://` 做法：只給 `standard`、`secure`，就能載入 Vite 打包的 module script。
  - 處理器要擋路徑穿越，並在 HTML 回應帶 CSP header。只能參考，不能 import。
- `src/main/log/run-log.ts`：`RunLogCategory` 是聯集型別，要新增 `windows`。
- `test/helpers/fake-electron.ts`、`test/tooling/guard-rules.test.ts`：Electron 的假物件，以及防護規則的反向測試。
- 安裝套件時，如果遇到 `~/.npm` 權限錯誤（EACCES），就把 `npm_config_cache` 設成暫存目錄。

## Tasks & Acceptance

**Execution:**
- [x] `package.json`：加入以下套件，用 `--save-exact` 安裝，`package-lock.json` 一起更新。理由：架構 Stack；`@types/react-dom` 是 `react-dom/client` 的型別必需品。
  - dependencies：`react`、`react-dom` 19.3.1。
  - devDependencies：`@types/react` 19.3.0、`@types/react-dom` 19.3.0、`@vitejs/plugin-react` 6.2.1。
- [x] `forge.config.mts`、`src/forge-env.d.ts`：理由：一個名稱對應一個 renderer；打包版啟動時不閃 Dock 圖示。
  - renderer 的 `name` 改成 `panels`，宣告 `PANELS_VITE_DEV_SERVER_URL`、`PANELS_VITE_NAME`。
  - `packagerConfig.extendInfo` 設 `LSUIElement: true`。
- [x] `vite.renderer.config.mts`、`tsconfig.web.json`、`tsconfig.base.json`：加 React plugin、`jsx: 'react-jsx'`，include 要涵蓋 `.tsx`。
- [x] `src/shared/panels.ts`：理由：選單與面板共用同一份頁面清單。
  - `PANEL_PAGES`：`sessions`、`packs`、`settings`，加上各自的中文名稱。
  - `MAIN_PANEL_PAGE`。
  - 頁面 id 的 schema 與往返測試。
- [x] `src/main/windows/environment.ts`：理由：AD-24 規定環境判斷只能有一處。
  - 是否打包、`PANELS` dev server 的來源；判斷網址是否允許。
  - `src/main/ipc/origin.ts` 改用這裡的判斷。
- [x] `src/main/windows/protocols.ts`：理由：關掉 Story 1.3 延後的 E4（打包版的 IPC 全被拒）。
  - `registerSchemes()`：ready 前呼叫一次。
  - `handleAppProtocol()`：`app://panels/<path>` 對應到 `.vite/renderer/panels/`。
  - 擋 `..` 與未知的 host，依副檔名回 content-type，HTML 回應帶 CSP header，其他情況都回 404。
- [x] `src/main/windows/csp.ts`：理由：AD-24 的 CSP 只有一份。
  - 打包版：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。
  - 開發版：只在沒打包時，對 dev server 的回應以 `onHeadersReceived` 套用。在打包版的基礎上，script 與 style 加 `'unsafe-inline'`（React refresh 的前置程式與 Vite 注入的樣式），connect 加 dev server 的 `ws://`。
  - 兩者都不含 `'unsafe-eval'`。如果 Vite 開發模式需要 `'unsafe-eval'`，停下來回報，不要自行加上。
- [x] `src/main/windows/security.ts`：理由：AD-24、NFR5 的動態防線。
  - 對每個 `type` 為 `window` 的 webContents（經 `web-contents-created`）：拒絕開新視窗、`will-frame-navigate` 照放行清單。
  - session 層：權限請求一律拒絕。
  - `webRequest.onBeforeRequest`：只放行 `app:`、`pack:`、`devtools:`，以及沒打包時的 dev server http／ws；其餘取消，同一個來源只記一次。
  - 判斷函式寫成純函式。
- [x] `src/main/windows/dock.ts`：理由：FR7。
  - 依「目前開著的面板數」顯示或隱藏 macOS Dock：啟動時隱藏；從 0 變 1 時顯示；回到 0 時隱藏。
  - 只在 macOS 動作；Windows 靠面板視窗自己的工作列按鈕。
- [x] `src/main/windows/panel-window.ts`：理由：面板的唯一建立點。
  - 視窗設定：寬 960、高 680、置中，`show: false` 等 `ready-to-show` 再顯示；webPreferences 照 Always；preload 是 `panels.cjs`。
  - 載入網址：打包版 `app://panels/index.html#/<page>`，開發版 `<dev server>#/<page>`。
  - 面板已開著時：切到指定頁並帶到前景。
  - 開啟與關閉時通知 dock；`did-fail-load`、`render-process-gone` 時記一行並關閉面板。
  - 開發時 DevTools 以 detach 模式打開。
  - preload bundle 名稱集中在這裡，並加一個測試，比對 `forge.config.mts` 的 preload 入口。這一項關掉 Story 1.3 延後的 VG3。
- [x] `src/main/windows/tray.ts`、`src/main/windows/menu.ts`、`src/main/windows/tray-icon.ts`：理由：AD-14 規定選單只在一處定義。
  - 選單的範本只在 `menu.ts`：「管理 session」「角色包」「舞台設定」、分隔線、「結束」。
  - Tray 的 tooltip 是 `AI Watchdog Pet`；Windows 左鍵點擊也彈出選單。
  - 圖示用 `nativeImage.createFromBitmap` 以程式畫出佔位圓環，16／32px 兩種尺寸：macOS 是黑色加上 `setTemplateImage(true)`；Windows 是灰色實心。
- [x] `src/main/main.ts`：理由：NFR10、Story 1.4 延後的 B8。
  - 啟動順序：`started` 或拿不到 `requestSingleInstanceLock()` 就 `app.quit()`，什麼都不初始化；否則先 `registerSchemes()`，再跑 Story 1.4 的接線。
  - ready 後：`app://` 處理器、session 防護、Dock 隱藏、建立 tray。
  - `second-instance` 和 macOS 的 `activate` 都打開主面板。
  - `window-all-closed` 不結束 app。
  - 啟動時不開面板。
- [x] `src/main/log/run-log.ts`：類別加上 `windows`。記錄 tray 建立、面板開關、Dock 顯示與隱藏、被拒絕的導覽、開新視窗、對外請求、載入失敗。
- [x] `src/panels/`：理由：AC 規定面板用 React 19，並訂閱 StageView。
  - `index.html` 換成 app 自己的版本（標題 `AI Watchdog Pet`）。
  - 新增 `main.tsx`、`App.tsx`：一個視窗，左側列出三頁，hash 路由對應頁面 id，三頁都顯示「即將推出」。
  - 底部保留「版本」與「StageView rev N｜畫布螢幕」那一行；`window.awp` 不存在時顯示錯誤。
  - 刪除 `renderer.ts`。
- [x] `.dependency-cruiser.cjs`、`test/tooling/guard-rules.test.ts`：新增規則「`react`、`react-dom` 只能在 `src/panels` 使用」，並加反向測試。
- [x] 測試：理由：I/O 矩陣每一列都要有對應的測試。
  - 新增 `test/main/windows-*.test.ts`，涵蓋：protocol 處理器、CSP、放行與導覽判斷、dock 計數、選單範本、panel 的 webPreferences 與網址、bundle 名稱一致性、單一實例與 Squirrel 時不初始化任何東西。
  - 用 fake electron，不起真的 Electron。

**Acceptance Criteria:**
- Given 完成實作，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過，且 I/O 矩陣每一列都有對應測試。
- Given `npm start`，when app 啟動，then 運行紀錄有 tray 建立、Dock 隱藏兩行，而且沒有開出任何視窗。
- Given app 執行中，when 在 repo 根目錄再執行一次 `npx electron .`，then 第二個行程立刻結束，原本的實例打開主面板並記一行。
- Given `npm run package` 產生的 macOS 打包版，when 啟動並打開主面板，then 頁面從 `app://panels/` 載入，版本與 StageView 那一行正常顯示；確認後立刻結束 app。

## Implementation Notes

- 四項檢查實際通過：`npm run typecheck`（兩份 tsconfig）、`npm run lint`、`npm test`（23 個檔、647 個測試）、`npm run depcruise`（97 個模組無違規）。I/O 矩陣每一列都有對應測試，分在 `test/main/windows-{main,environment,protocols,csp,security,dock,panel-window,tray}.test.ts` 與 `test/shared/panels.test.ts`；`windows-main` 以假的 electron 與各模組記錄器載入真的 `main.ts`，驗 Squirrel／第二實例什麼都不初始化、primary 的初始化順序、啟動不開窗。
- `npm start`（加 `--remote-debugging-port`，未截圖）：運行紀錄依序 `app start`、`windows dock icon hidden (startup)`、`windows tray icon created`，DevTools 目標清單為空（沒有視窗）。再跑 `npx electron .`：第二個行程 0.73 秒、exit 0 結束，沒寫任何紀錄；原實例記 `second instance launched: opening the main panel`、`panel opened on sessions`、`dock icon shown`、`stage-view … subscribed`。從本機 DevTools 讀 DOM：`http://localhost:5173/#/sessions`、標題 `AI Watchdog Pet`、「管理 session / 即將推出」、「版本 1.0.0」、「StageView rev 0｜畫布螢幕：主螢幕」，`window.require`／`process` 不存在。頁內探測：`eval`、`new Function` 被 CSP 擋（EvalError，開發版也不需要 `'unsafe-eval'`）；對外 fetch 被 `connect-src` 擋；`window.open` 與 `target=_blank` 被拒並記 `new window denied`；`location.href` 外連被擋並記 `navigation blocked`；通知權限 `denied`；側欄連結切到 `#/packs`。以 CDP `Page.navigate` 繞過 `will-frame-navigate` 外連：webRequest 取消並記一次 `request blocked`，`did-fail-load`（-20）關閉面板並記錯誤、Dock 隱藏。停止 Forge 後紀錄有 `app quit`。第一次開的面板約 3.6 秒後走一般 `closed`（非錯誤路徑），原因未確認，之後兩次都穩定開著。
- `npm run package`：`Info.plist` 的 `LSUIElement` 為 true。啟動打包版：紀錄 `packaged=true`、Dock 隱藏、tray 建立，沒有視窗；再啟動一次後面板從 `app://panels/index.html#/sessions` 載入，script 為 `app://panels/assets/…`，版本與 StageView 那一行正常，`stage-view` 訂閱成功（IPC 對 `app://` 放行，E4 關閉）；`eval` 被擋；`app://panels/..%2f..%2fbuild%2fmain.cjs`、不存在的檔回 404，`app://overlay/` 被 CSP 擋。確認後立即結束，紀錄有 `app quit`。
- spec 以外的決定：
  - macOS `activate` 與 `second-instance` 一律開主面板（照 I/O 矩陣「再啟動一次」：從 Finder、Spotlight 再啟動在 macOS 只觸發 `activate`）；面板已開著時切到「管理 session」並帶到前景，點 Dock 圖示也一樣。
  - `did-fail-load` 只處理主框架，略過 `ERR_ABORTED`（-3，被新的載入取代，不是失敗）；出錯時用 `destroy()` 關閉面板。
  - Electron 已知問題：距上次 Dock 變更不到約 1 秒的 `dock.hide()` 會無效，因此隱藏會延後到 `DOCK_HIDE_MIN_INTERVAL_MS`（1100，放 `src/shared/constants`）之後，期間若又開面板就取消。
  - Windows 圖示的「灰色實心」解讀為不透明的中灰色（128）圓環，不是實心圓；待使用者確認。
  - `app://` 未知副檔名也回 404；空路徑回 `index.html`。開新視窗、導覽、對外請求的紀錄只寫來源（origin），不寫路徑與查詢字串。
  - 所有網址放行判斷（IPC 框架、導覽、webRequest）都在 `environment.ts`，`security.ts` 只負責接線，`ipc/origin.ts` 改用它。新增 `PACK_SCHEME` 常數。
  - `PRELOAD_BUNDLES` 同時列 `panels`、`overlay`，測試直接 import `forge.config.mts`，雙向比對 preload 入口，並檢查 renderer 名稱與 `LSUIElement`。
  - `jsx: 'react-jsx'` 放在 `tsconfig.base.json`；`tsconfig.web.json` 的 `src/panels/**/*` 已涵蓋 `.tsx`（`tsc --listFilesOnly` 確認），沒有改。
  - 新規則 `react-only-in-panels`；保留 `overlay-no-react`。反向測試加了假的 `react` 套件，所以 overlay 那一列的目標改為 `node_modules/react/index.js`。
  - 權限請求、權限檢查（`setPermissionCheckHandler`）與 HID／serial／USB 裝置權限（`setDevicePermissionHandler`）一律拒絕。
  - `app` 沒有 `supportFetchAPI`，面板內 `fetch('app://…')` 會失敗；目前面板不需要，之後需要時再評估。
- 本 story 關掉的延後項目：E4（打包版 IPC）、VG3 的 bundle 名稱一致性（CI 建置檢查仍在 Story 2.3）、Story 1.1 的 B8（renderer 命名）與 B13b～d／E1／E3／E5～E7、Story 1.4 的 B8／E1（Squirrel 時仍初始化）。Story 1.3 的 B7 只完成來源判斷搬到 `main/windows`，依視窗限制通道仍延後。`deferred-work.md` 沒有改。
- 安裝套件遇到 `~/.npm` 的 EACCES，改用暫存的 `npm_config_cache`。
- 開發代理違反「不執行任何 git 指令」一次：開工時跑了唯讀的 `git status --short`。
- 審查修補（第 1 輪）：
  - `activate` 改為一律開主面板（見上），移除 `PanelWindows.bringToFront()`。
  - 拿不到單一實例鎖時在 console 印一行說明（不初始化運行紀錄）；Squirrel 維持安靜。
  - ready 後順序改為：session 防護、應用程式選單、`app://` 處理器、Dock、tray，`app://` 處理器出錯也不會少掉 session 防護。
  - 新增應用程式選單（`menu.ts`）：macOS 只有 app 選單（隱藏、隱藏其他、顯示全部、結束）、Edit、Window（最小化、縮放、關閉 ⌘W、全部移到最前面），沒有 View／重新載入／DevTools；Windows、Linux 設為 `null`，面板視窗沒有選單列。
  - `panelWebPreferences` 加 `webviewTag: false`；`will-attach-webview` 一律 `preventDefault()` 並記一行。
  - Dock：`show()` 同步丟例外也記錄、不中斷建立面板；預設時鐘改為單調的 `performance.now()`。
  - tray 圖示另加 1.25x（20 px）、1.5x（24 px）兩種大小。
  - 產品名稱集中為 `PRODUCT_NAME`（`src/shared/constants.ts`），tray tooltip、視窗標題、面板標頭與錯誤對話框共用；`index.html` 的 `<title>` 維持字面值。
  - hash 路由抽成 `src/panels/hash-page.ts`（不依賴 React 與 DOM 型別），`useHashPage` 包裝它，並有 `test/panels/hash-page.test.ts`。
  - `jsx: 'react-jsx'` 從 `tsconfig.base.json` 移到 `tsconfig.web.json`；guard 測試檢查 `src/` 只有 `src/panels/` 底下有 `.tsx`。
  - 測試補上：macOS `focusApp` 呼叫 `app.focus({ steal: true })`、其他平台沒有 `focusApp`；`currentTray()`；權限檢查與裝置權限；webview；Dock `show()` 同步丟例外；`app://` 只處理 app 的測試自行呼叫 `handleAppProtocol`；`PANELS_VITE_NAME` 改用與預設不同的值；`forge.config.mts` 改在 `beforeAll` 載入一次（30 秒逾時）。
  - 修補後只跑了涵蓋修改檔案的 8 個測試檔（232 個測試全過）與 typecheck；上面的總數是修補前的結果，完整驗證由協調者執行。macOS 的 Window 選單改為明列：最小化、縮放、關閉（`close` role，⌘W 可關閉面板）、分隔線、全部移到最前面；`windowMenu` role 在 macOS 不含 close，又沒有 File 選單，所以不用它（審查修補第 2 輪）。
- 仍需使用者手動確認：選單列圖示外觀與選單四項、開面板時 Dock 圖示與 ⌘Tab、從 Spotlight 再啟動只帶出面板、Windows 系統匣左鍵選單與深淺工作列的圖示。

- 修補後重跑（含第 2 輪 ⌘W）：typecheck、lint、`npm test`（24 個檔、681 個測試）、depcruise 全部通過。實機：`npm start` 的運行紀錄依序為 `app start`、Dock 隱藏、tray 建立；再執行 `npx electron .` 時，第二個行程印一行 console 後 exit 0，原實例記 `second instance launched`、`panel opened on sessions`、`dock icon shown`、`stage-view webContents 1 subscribed at rev 0`，結束時 `dock icon hidden (no panel open)`、`panel closed`、`app quit`。`npm run package` 後的打包版（`packaged=true`）同樣流程全部通過，面板從 `app://` 載入且 StageView 訂閱成功。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 main.ts 的 macOS `focusApp`（`app.focus({ steal: true })`）接線沒有測試 | medium | patch | 預檢後送來的缺口：`windows-main` 的 mock 丟掉 `focusApp`，刪掉它或寫反平台判斷全部測試仍過；面板可能停在其他 app 後面。 |
| VG2 Tray 參考防 GC 沒有測試、`currentTray()` 沒有呼叫者 | low | patch | `tray = created` 是 Tray 唯一的強參考，刪掉全部測試仍過；補 `currentTray()` 回傳同一個 Tray 的測試，保留這個 export。 |
| VG3 面板依 hash 切頁（`useHashPage`）與 React UI 沒有自動化測試 | medium | patch | 預檢後送來的缺口：拿掉 `hashchange` 監聽，main 端與 shared 測試全過，但面板開著時從選單切頁會失效；把跟隨 hash 的邏輯抽成不依賴 React／DOM 型別的函式並測試。其餘 React 元件測試需要 DOM 測試環境（新套件），另列延後。 |
| VG 其他 第一次開的面板約 3.6 秒後自行關閉，原因未確認 | maybe-false | defer | 只在開發代理的一次 `npm start` 出現，之後沒有重現；要確認需在出現時保留運行紀錄與 DevTools 狀態，判斷是誰觸發 `closed`。若屬實為 medium。 |
| B1 `jsx` 放在 tsconfig.base，main／overlay 的 `.tsx` 可繞過 React 依賴規則 | low | patch | `react/jsx-runtime` 是編譯器插入的 import，depcruise 看不到；把 `jsx` 移到 `tsconfig.web.json`，並加一條守門測試禁止 `src/panels` 以外出現 `.tsx`。 |
| B2 沒有設定 application menu，Electron 預設選單仍在 | medium | patch | 沒有 `Menu.setApplicationMenu` 時，Electron 會在 ready 時裝上預設選單：Windows 面板視窗顯示 File／Edit／View，打包版也能從 View 開 DevTools、Reload；違反 AD-14「選單只在一處定義」。 |
| B3 只擋權限請求，沒擋權限檢查與裝置權限 | low | patch | 只設了 `setPermissionRequestHandler`；權限檢查與 HID／serial／USB 裝置權限沒有 handler 時走 Electron 預設；兩個 handler 一律回 false 即可。 |
| B4 `webviewTag` 沒明寫，也沒攔 `will-attach-webview` | low | patch | `installWebContentsGuards` 刻意不處理 webview，只靠預設的 `webviewTag: false`；明寫 false 並在 `will-attach-webview` 一律 `preventDefault`。 |
| B5 面板主框架可以導覽到 `pack://` | low | reject | AD-24 的導覽放行清單本來就包含 `pack://`；面板目前不載入任何角色包內容，而 `pack://` 頁面的 IPC 會被來源檢查拒絕；要分主框架與子框架是新增分支。 |
| B6 `ready-to-show` 前再次 `open()` 會提早顯示白窗並重新載入 | low | reject | 要在面板建立後約 200ms 內再觸發一次開啟（選單點一下就關閉，無法連點）；修正需要加狀態旗標。 |
| B8b deferred-work 沒有更新本 story 關掉與新增的項目 | low | patch | E4、Story 1.1 的 B8 與模板 main.ts 那條、Story 1.4 的 Squirrel 那條都已解決，VG3、B7 部分解決；直接註記。 |
| B9 spec 與 sprint-status 狀態不一致 | false | reject | step-05 會把 story 設為 `review`。 |
| B10 環境判斷沒有完全集中、也沒有機制強制 | low | reject | `main.ts` 只在啟動紀錄讀 `app.isPackaged`；`currentEnvironment()` 每次重算的結果在執行期間不變，不會分歧；Forge 型別宣告的 `MAIN_WINDOW_*` 誤用屬開發期問題，移除型別參照會連帶影響 vite 設定的型別。 |
| B11 幾個測試本身的問題（順序相依、stub 值等於 fallback、forge.config 載入逾時） | low | patch | 'only handles app' 依賴前一個測試先註冊；`PANELS_VITE_NAME` 的 stub 測不出是否真的讀了常數；第一次載入 `forge.config.mts` 用預設 5 秒逾時，Windows CI 可能偶發失敗；都是測試內的直接修正。 |
| B12a 產品名稱散在多處 | low | patch | `TRAY_TOOLTIP`、`PANEL_WINDOW_TITLE`、面板品牌文字、錯誤對話框標題各寫一次；改用 `src/shared/constants` 的一個常數（`index.html` 的 `<title>` 維持字面值）。 |
| B13 Windows 系統匣圖示只有 16／32px | low | patch | Windows 125%／150% 縮放時用 20／24px，常見的縮放比例下圓環會模糊；`drawRingBitmap` 本來就能畫任意尺寸，多加兩個 representation 即可。 |
| E1 loadURL 失敗卻沒有 did-fail-load 時，面板永遠隱藏 | low | reject | 面板網址由程式組出，`app://` 處理器在 ready 時就註冊；沒有觀察到不觸發 did-fail-load 的失敗；處理需要新增分支。 |
| E3 `live()` 先丟掉已銷毀的視窗，Dock 計數永遠回不到 0 | false | reject | `closed` 事件的處理一律呼叫 `dock.panelClosed()`，與 `current` 是否已被 `live()` 清掉無關；`destroy()` 也會觸發 `closed`。 |
| E4 `macDock.show()` 同步丟錯時 `create()` 中斷 | low | patch | `hide()` 已經包 try/catch，`show()` 沒有；包起來是直接修正。 |
| E5 renderer 以 clean-exit 結束時被記成錯誤並關閉面板 | low | reject | renderer 已經不在，面板無法顯示任何內容，關閉是正確處理；只是紀錄層級，影響很小。 |
| E6 Dock 延遲隱藏用 `Date.now`，系統時鐘跳動時會延後或提早 | low | patch | 時鐘往回調時，隱藏會延後整段跳動的時間；預設改用單調時鐘 `performance.now()` 是一行修正。 |
| E7 打包版在跑時 `npm start` 會無聲結束 | low | patch | dev 與打包版共用 userData，也共用單一實例鎖，dev 行程拿不到鎖就直接結束、沒有任何輸出；拿不到鎖時在 console 印一行即可（不初始化運行紀錄）。 |
| E8 Tray 建立失敗時 Windows 沒有結束 app 的方法 | low | reject | Tray 建立失敗極少見，且已記錄；要加「沒有 tray 時關閉最後一個視窗就結束」是新增分支。 |
| E9 `handleAppProtocol` 丟錯時 session 防護會被跳過 | low | patch | ready 後的步驟依序執行，前一步丟錯，後面的 `installSessionGuards` 就不會跑，面板仍能開；把 session 防護排在最前面是直接修正。 |
| E12 `getVersion` 同步丟錯時會讓面板卸載 | false | reject | `getVersion` 是 `() => invoke(...)`，`invoke` 是 async 函式，只會回傳被拒絕的 promise，不會同步丟錯。 |
| E13 macOS `activate` 在面板開著時沒有切回主面板 | medium | patch | 凍結的 I/O 矩陣「再啟動一次」要求打開主面板；macOS 從 Finder／Spotlight 再啟動只會觸發 `activate`，目前面板開著時只帶到前景、不切頁，與規格不符；照規格一律開主面板。 |
| B12b `currentTray()` 沒有呼叫者 | low | patch | 與 VG2 同一根因；保留並以測試鎖住它的用途（防 GC 的參考）。 |
| B7 面板的 React UI 完全沒有自動測試 | medium | patch | hash 切頁部分與 VG3 同一根因一起修；其餘元件層級測試需要 DOM 測試環境，已追加到 deferred-work。 |
| B8a spec 記錄的面板自行關閉原因不明 | maybe-false | defer | 與 VG 其他 同一項；已追加到 deferred-work 並連到 Story 1.1 的「沒有 renderer」條目。 |
| E11 `.tsx` 在 panels 以外使用 JSX 時 React 規則擋不到 | low | patch | 與 B1 同一根因。 |
| E10 權限檢查沒有 handler | low | patch | 與 B3 同一根因。 |
| E2 首次導覽 commit 前再 `open()` 會多載入一次並提早顯示 | low | reject | 與 B6 同一根因。 |
| B8c `app` 沒有 `supportFetchAPI` | low | reject | 面板目前不需要 `fetch('app://…')`；需要時再依原型實測加最小權限。 |

## Design Notes

**Dock 的做法：**
- macOS 用 `app.dock.hide()`／`show()`。
- 打包版另外設 `LSUIElement`，避免啟動瞬間閃一下 Dock 圖示。`LSUIElement` 的 app 仍然可以用 `dock.show()` 切成一般 app，才能 ⌘Tab。
- Windows 不需要額外處理：tray 本身不佔工作列，面板視窗關掉後工作列按鈕就消失。

**CSP 的兩條路徑：**
- 打包版由 `app://` 處理器在 HTML 回應帶 header。
- 開發版的 HTML 來自 Vite dev server，所以由 session 的 `onHeadersReceived` 補上 header。
- 兩條路徑都由 `csp.ts` 產生字串，不會有第二份。

**單一實例的順序：** 一定要先拿鎖，拿到才初始化運行紀錄與設定。否則第二個行程會在被擋下前，就去改名壞掉的設定檔，或者寫進同一個紀錄檔。

**驗證限制：**
- 開發代理不截圖，選單列圖示和 Dock 的實際外觀由使用者手動確認。開發代理用運行紀錄，以及本機 DevTools 讀頁面 DOM 來驗證。
- Windows 的系統匣行為只能靠 CI 的單元測試和使用者在 Windows 上確認。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`：expected 全部通過。
- `npm start`：expected 運行紀錄有 tray 建立與 Dock 隱藏；再執行一次 `npx electron .` 時，原本的實例打開主面板。確認後結束 app。
- `npm run package` 之後啟動打包版：expected 面板從 `app://panels/` 載入，版本與 StageView 那一行正常。確認後結束。

**Manual checks (if no CLI):**
- 使用者確認：
  - 選單列圖示看得清楚；選單有四項。
  - 開面板時 Dock 出現圖示、可以 ⌘Tab；關掉後圖示消失。
  - 從 Spotlight 再啟動一次，只會把面板帶出來，不會出現第二個圖示。
