---
title: 'Story 1.6：透明置頂穿透畫布'
type: 'feature'
created: '2026-11-06'
status: 'done'
baseline_commit: '0eb0cf7e3abf42c85d1cd7e22fd364631ea1a263'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 舞台還沒有畫布，之後的角色沒有地方演出。「畫布所在螢幕」這個設定雖然已經存在，但沒有頁面可以選，也沒有任何地方套用它。

**Approach:**
- `main/windows` 建立一張透明、無邊框、置頂、預設點擊穿透的畫布視窗，蓋住所選的螢幕。
- overlay renderer 用 PixiJS（WebGL、透明背景）初始化。
- 換螢幕、螢幕邊界改變、睡眠或鎖定：都經 StageView 告訴畫面。
- renderer 當掉時重建畫布。
- 面板的「舞台設定」頁換成真的頁面，列出接上的螢幕，經 `settings:patch` 寫入。

## Boundaries & Constraints

**Always:**
- main 往畫面只推 StageView（AD-20）。下列三項都放進 StageView 的新區段，由 `main/windows` 擁有，`main/stage-view` 只負責組合，不另開推送通道：
  - 接上的螢幕清單；
  - 畫布實際所在的螢幕與世界座標（該螢幕的 DIP，原點左上）；
  - 睡眠／鎖定狀態。
- 畫布視窗的設定：
  - `transparent`、`frame: false`、置頂、`skipTaskbar`、不可取得焦點（顯示時不搶焦點）、`backgroundThrottling: false`；
  - 大小等於所選螢幕的 `bounds`；
  - macOS 用 `type: 'panel'`，不呼叫 `setVisibleOnAllWorkspaces`；
  - webPreferences 照 AD-24，與面板相同。
- 點擊穿透：macOS 與 Windows 用 `setIgnoreMouseEvents(true, { forward: true })`；Linux 用 `setIgnoreMouseEvents(true)`，整窗穿透。
- overlay 入口第一行是 `import 'pixi.js/unsafe-eval'`。PixiJS 以 `preference: 'webgl'`、透明背景初始化；初始化時就設好 `Assets.setPreferences({ preferCreateImageBitmap: false })`。CSP 與面板相同，任何環境都不含 `'unsafe-eval'`。`src/overlay` 不引入 React。
- 依視窗限制 IPC 通道（關掉 Story 1.3 延後的 B7）：每條通道宣告哪些 renderer（`panels`、`overlay`）可以呼叫，其他 renderer 一律 `sender-rejected`。
- 寫入只走擁有者的 invoke；面板改設定時，不先改本地狀態，等 StageView 回來。

**Never:**
- 不做角色、world 節拍、心跳、hitbox、「游標在角色上才關穿透」（Story 3.x、4.2）。
- 不暫停節拍：還沒有節拍，睡眠或鎖定只記錄並放進 StageView。
- 不做 `pack://` 處理器。
- 不呼叫 `setVisibleOnAllWorkspaces`。
- 不用 `'unsafe-eval'`。
- 不動 `prototypes/`。
- 程式本身不連網。
- 不執行任何 git 指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 啟動 | app 啟動，設定是主螢幕 | 畫布蓋住主螢幕；PixiJS 初始化完成後，overlay 回報一次「就緒」，main 記一行（含 renderer 類型與世界大小） | 初始化失敗：overlay 回報失敗並記一行，app 照常常駐 |
| 點擊 | 畫布上沒有角色，使用者點任何位置 | 點擊穿透到底下的視窗；畫布不搶焦點，也不出現在工作列與 ⌘Tab | — |
| 舞台設定頁 | 從選單打開「舞台設定」 | 列出「主螢幕（跟著系統設定）」與每個接上的螢幕（名稱、解析度，標出目前的主螢幕），選中的就是目前的設定 | — |
| 改選螢幕 | 在設定頁選另一個螢幕 | 經 `settings:patch` 寫入；畫布移到該螢幕；StageView 的世界座標更新；設定頁的選擇跟著 StageView 更新 | patch 失敗：頁面顯示錯誤，選擇維持原值 |
| 螢幕變化 | 加入、移除螢幕，或邊界、縮放比例改變 | 重新決定畫布所在的螢幕並調整大小；StageView 的螢幕清單與世界座標更新 | — |
| 所選螢幕拔掉 | 設定指定的螢幕不在了 | 畫布回到主螢幕，StageView 標示「暫用主螢幕」；設定值不變，螢幕接回來時畫布自動移回 | — |
| renderer 當掉 | 畫布的 renderer 當掉 | 記一行，重建畫布視窗；新的 overlay 重拿 StageView 快照並再次回報就緒 | 60 秒內重建超過 3 次就停止重建並記一行錯誤，app 照常常駐 |
| 睡眠／鎖定 | 系統睡眠、喚醒、鎖定、解鎖 | 記一行；StageView 的睡眠／鎖定狀態更新 | — |
| 跨視窗呼叫 | overlay 呼叫只有面板可用的通道（例如 `settings:patch`），或面板呼叫 overlay 專用的通道 | `sender-rejected`，handler 不執行 | 記一行 |

</frozen-after-approval>

## Code Map

- `src/main/windows/`（Story 1.5）
  - `environment.ts`：目前只認一個 dev server（`PANELS_VITE_DEV_SERVER_URL`）。它掌管所有網址判斷：IPC 框架、導覽、webRequest。
  - `protocols.ts`：`app://` 的 `roots` 只有 `panels`。
  - `panel-window.ts`：`PRELOAD_BUNDLES` 已列 `overlay.cjs`，`panelWebPreferences` 可重用。
  - `security.ts`：經 `web-contents-created` 為所有 `window` 類型的視窗加防護。
  - `dock.ts`：只計算面板。畫布不能算進去。
- `src/main/main.ts`：ready 之後依序是 session 防護 → application menu → `app://` → Dock → tray。StageView 在 ready 前建立，`createStageView({ settings })`。
- `src/main/stage-view/stage-view.ts`：`StageViewSources` 目前只有 `settings`（`get` 與 `onChange`）。每次來源變更推一個整段取代的增量。
- `src/shared/stage-view.ts`
  - `stageViewSchema` 目前只有 `settings` 區段。`stageViewSectionsSchema` 必須列出所有區段。
  - `src/shared/settings.ts` 的 `canvasDisplayId` 可以是非負整數或 null，null 代表主螢幕。
- `src/main/ipc/register.ts`、`src/main/ipc/origin.ts`：來源檢查只看網址是否允許，不分是哪個 renderer。
- `src/preload/overlay.ts`：目前暴露空的 API；`OverlayApi` 型別在 `src/shared/preload-api.ts`。
- `src/preload/stage-view.ts`：訂閱邏輯，overlay 可直接重用。
- `forge.config.mts`：renderer 只有 `panels`；`vite.renderer.config.mts` 的 root 是 `src/panels`。`src/forge-env.d.ts` 只宣告 `PANELS_VITE_*`。
- `src/panels/App.tsx`、`src/panels/hash-page.ts`：`settings` 頁目前顯示「即將推出」。renderer 端的純邏輯放在不依賴 React 和 DOM 型別的模組，才測得到（Vitest 是 node 環境）。
- `prototypes/sandbox/web/overlay/overlay.js`：在 CSP `script-src 'self'` 下實測可用的 PixiJS 初始化方式（第一行 import、`Assets.setPreferences`）。只能參考，不能 import。
- `.dependency-cruiser.cjs` 已有 `overlay-no-react`；`test/helpers/fake-electron.ts` 有 fake webContents。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/constants.ts`：加 `CANVAS_REBUILD_LIMIT`（3）與 `CANVAS_REBUILD_WINDOW_MS`（60 秒）。
- [x] `src/shared/stage-view.ts`：理由：AD-20，把三項資訊放進 StageView。新增三個區段，每個 schema 都要有往返與拒絕測試：
  - `displays`：每個螢幕的 `id`、`label`、`bounds`、`scaleFactor`、`primary`。
  - `canvas`：實際所在螢幕的 `displayId`、`bounds`、`scaleFactor`，以及 `fallback`（所選螢幕不在、暫用主螢幕）。ready 前是 null。
  - `power`：`suspended`、`locked`。
- [x] `src/shared/ipc.ts`、`src/shared/preload-api.ts`：理由：overlay 的最小 API，就緒才記得到運行紀錄。
  - 新增 `canvas:ready` 通道，參數是 `{ ok: true, renderer, width, height }` 或 `{ ok: false, reason }`，reason 是有長度上限的短字串。
  - `OverlayApi` 提供 `stageView.subscribe`、`canvas.ready`。
- [x] `src/main/ipc/register.ts`、`src/main/ipc/origin.ts`、`src/main/windows/environment.ts`：理由：關掉 B7。
  - `registerIpcHandler` 加必填的 `renderers` 參數，列出可以呼叫的 renderer。
  - 用 `environment.ts` 的 `rendererOfUrl(url, env)` 判斷呼叫者：`app://panels`、`app://overlay`，以及沒打包時兩個 dev server 的來源。
  - 各通道的允許清單：
    - `app:get-version`、`settings:*`：只有 panels。
    - `stage-view:subscribe`：panels 與 overlay。
    - `canvas:ready`：只有 overlay。
  - 推送也用同一個判斷。
- [x] `src/main/windows/environment.ts`、`src/forge-env.d.ts`、`src/main/windows/csp.ts`、`src/main/windows/security.ts`、`src/main/windows/protocols.ts`：理由：overlay 也走同一套環境與防護。
  - 支援第二個 dev server `OVERLAY_VITE_*`；導覽、請求放行與 dev CSP 都涵蓋兩個 dev server。
  - `app://overlay/` 對應到 `.vite/renderer/overlay/`。
- [x] `forge.config.mts`、新增 `vite.overlay.config.mts`：新增 renderer `overlay`，root 是 `src/overlay`，outDir 是 `.vite/renderer/overlay`，不用 React plugin。
- [x] `src/main/windows/displays.ts`：用純函式做兩件事。理由：所選螢幕拔掉時回到主螢幕，接回來時移回。
  - 把 `screen` 的資料轉成 StageView 的 `displays`。
  - 由 `canvasDisplayId` 與螢幕清單決定畫布所在的螢幕：找得到就用它；找不到或是 null 就用主螢幕，找不到時 `fallback: true`。
- [x] `src/main/windows/canvas-window.ts`：理由：畫布的唯一建立點。
  - 依 Always 建立並顯示畫布，但不給焦點。
  - 依平台設定點擊穿透；所在螢幕改變時 `setBounds`。
  - `render-process-gone` 時記一行並重建，套用重建次數上限。
  - `did-fail-load`（主框架、不是 -3）時記一行。
- [x] `src/main/windows/power.ts`：監聽 `powerMonitor` 的 suspend、resume、lock-screen、unlock-screen，更新 `power` 狀態並記一行。
- [x] `src/main/windows/stage-sources.ts`（或併進合適的模組）：理由：AD-3，`main/windows` 是這三個區段的唯一擁有者。
  - 把螢幕清單、畫布、睡眠／鎖定組成一個來源，提供 `get()` 與 `onChange()`，交給 `createStageView`。
  - ready 前是空清單、`canvas: null`、兩個狀態都是 false。
- [x] `src/main/stage-view/stage-view.ts`：`StageViewSources` 加上 windows 來源，每次變更推一個只含變動區段的增量。
- [x] `src/main/main.ts`：理由：AC。
  - ready 後監聽 `screen` 的 display-added、display-removed、display-metrics-changed，以及設定變更，據此重新決定畫布位置。
  - 建立畫布，啟動 power 監聽。
  - 註冊 `canvas:ready`：收到時記一行「畫布就緒」或「畫布初始化失敗」，內容含 renderer 類型與大小。
- [x] `src/preload/overlay.ts`：照 `OverlayApi` 暴露最小 API，重用 `invoke` 與 `subscribeStageView`。
- [x] `src/overlay/index.html`、`src/overlay/main.ts`：理由：AC、AD-24。
  - 第一行 `import 'pixi.js/unsafe-eval'`；`Assets.setPreferences({ preferCreateImageBitmap: false })`。
  - `new Application()` 以 `preference: 'webgl'`、`backgroundAlpha: 0`、`resizeTo: window` 初始化。
  - 訂閱 StageView。完成後呼叫 `canvas.ready`；失敗時回報 reason。
  - body 與 canvas 背景透明，沒有捲軸。
- [x] `src/panels/display-options.ts`、`src/panels/App.tsx`：理由：AC 的舞台設定頁。
  - `display-options.ts` 是純函式，由 StageView 產生選項：
    - 第一項是「主螢幕（跟著系統設定）」（值 null）；
    - 接著是每個螢幕：名稱、寬×高，主螢幕加註「・目前的主螢幕」；
    - 設定的螢幕沒接上時，多一項「螢幕 <id>（未連接，暫用主螢幕）」並選中它。
  - 設定頁用單選列出這些選項。選了就 `settings.patch`，`baseRev` 用 StageView 裡的 `settings.rev`；等回覆時停用選項；失敗時顯示錯誤。
- [x] 測試：理由：I/O 矩陣每一列都要有對應測試。新增或擴充以下測試：
  - `test/shared/stage-view.test.ts`：新區段。
  - `test/main/windows-displays.test.ts`、`windows-canvas.test.ts`、`windows-power.test.ts`：
    - 畫布的視窗設定與各平台的穿透；
    - 重建次數上限；
    - fallback 與移回；
    - power 狀態。
  - `test/main/ipc-register.test.ts`：依 renderer 限制通道的每一種組合。
  - `test/main/stage-view.test.ts`：windows 來源。
  - `test/panels/display-options.test.ts`。
  - 一個守門測試：確認 `src/overlay/main.ts` 的第一行是 `import 'pixi.js/unsafe-eval'`。
  - `test/main/windows-panel-window.test.ts`：forge 設定的 renderer 名稱改成 `panels` 與 `overlay` 兩個。

**Acceptance Criteria:**
- Given 完成實作，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過，且 I/O 矩陣每一列都有對應測試。
- Given `npm start`，when app 啟動，then：
  - 運行紀錄有畫布建立、「畫布就緒」（renderer 是 `webgl`，大小等於主螢幕）兩行；
  - 畫布視窗的 `getBounds()` 等於主螢幕的 `bounds`，且忽略滑鼠事件；
  - 再啟動一次時打開的面板，切到「舞台設定」後列出目前的螢幕。
- Given `npm run package` 後的打包版，when 啟動，then 畫布從 `app://overlay/` 載入並回報就緒；確認後立刻結束 app。

## Implementation Notes

- 四項檢查實際通過：`npm run typecheck`（兩份 tsconfig）、`npm run lint`、`npm test`（31 個檔、924 個測試）、`npm run depcruise`（115 個模組無違規）。I/O 矩陣對應測試：啟動＝`windows-stage-sources`（開機版面）、`windows-canvas`（建立與載入）、`overlay/start`（就緒／失敗回報）、`preload/overlay`（main 記「畫布就緒」／失敗）；點擊＝`windows-canvas`（視窗設定、各平台穿透）；舞台設定頁與改選螢幕＝`panels/display-options`；螢幕變化與所選螢幕拔掉＝`windows-stage-sources`、`windows-displays`；renderer 當掉＝`windows-canvas`（重建、上限、滑動窗口）；睡眠／鎖定＝`windows-power`；跨視窗呼叫＝`ipc-register`（3 種允許清單 × 4 種來源，加上 4 條實際通道 × 兩個 renderer）、`preload/overlay`、`ipc-push`。守門測試（第一行 `import 'pixi.js/unsafe-eval'`、`Assets.setPreferences` 在 `new Application` 之前）在 `test/tooling/guard-rules.test.ts`。
- `npm start`（未截圖）：本機已有一個 Story 1.5 打包版在跑（`out/` 下，PID 45719，持有真實 userData 的單一實例鎖），沒有關掉它，改用 `--user-data-dir=<scratchpad>` 隔離執行（也不碰使用者的 settings.json 與運行紀錄），加 `--inspect-electron` 讀 main、`--remote-debugging-port` 讀頁面。結果：
  - 運行紀錄依序 `displays: 2 connected (ids 3, 1; primary 3)`、`canvas on display 3, 1920x1080 at 0,0, scale 1`、`canvas window created on …`、`stage-view webContents 1 subscribed`、`canvas ready (renderer webgl, 1920x1080)`。
  - main 端：畫布 `getBounds()` = `{0,0,1920,1080}` = 主螢幕 bounds；`isAlwaysOnTop()` true、`isFocusable()` false、`getFocusedWindow()` null、`isVisibleOnAllWorkspaces()` true（`type: 'panel'` 本身帶來，沒有呼叫 `setVisibleOnAllWorkspaces`）。穿透沒有 getter，只能靠單元測試與使用者確認。
  - overlay 頁面：html／body／canvas 背景 `rgba(0,0,0,0)`、`overflow: hidden`、捲動尺寸等於視窗、`window.awp` 只有 `stageView`、`canvas`，沒有 `require`／`process`／React；dev 回應帶 dev CSP；頁面自己的 task 裡 `eval`／`new Function` 都是 EvalError（DevTools 同步求值本身可繞過 CSP，要等到下一個 task 才測得準）。
  - 再執行一次 `npx electron .`（同一個 userData）：第二個行程 exit 0，面板開啟；切到「舞台設定」列出「主螢幕（跟著系統設定）」、`LS27C31x 1920×1080・目前的主螢幕`、`EK271 P6 1920×1080`，選中主螢幕。點選 EK271：等回覆期間選項停用且勾選不變，StageView 回來後才勾上（rev 1→3），畫布移到 `{1920,0,1920,1080}`，overlay 看到 rev 3。以 `settings.patch` 設成不存在的 999：多出「螢幕 999（未連接，暫用主螢幕）」並選中，畫布回主螢幕且紀錄寫明暫用主螢幕；再點主螢幕回到 null。
  - 從 main inspector `powerMonitor.emit()` 模擬鎖定／睡眠／喚醒／解鎖：各記一行，overlay 收到 `power: { suspended: true, locked: true }`。實機睡眠沒有測。
  - 以 `forcefullyCrashRenderer()` 讓畫布當掉：記 `canvas renderer gone (killed, exit code 2)`、`rebuilding the canvas window (1 of 3 within 60 s)`，新 overlay 在目前 rev 重新訂閱並再次回報就緒；連續當掉到第 4 次（60 秒內）記 `canvas renderer gone 4 times within 60 s; not rebuilding it again …`，app 照常（面板仍可用），結束時記 `app quit`。
- `npm run package`：同樣因為 PID 45719 從 `out/AI Watchdog Pet-darwin-arm64` 執行，沒有覆寫 repo 的 `out/`，改在 scratchpad 複製一份原始碼（`node_modules` 用 symlink）跑同一個 `npm run package`。打包版（`packaged=true`，隔離 userData）：畫布從 `app://overlay/index.html` 載入，script／CSS 為 `app://overlay/assets/…`，記 `canvas ready (renderer webgl, 1920x1080)`，頁內 `new Function` 為 EvalError；再啟動一次後面板從 `app://panels/index.html` 載入，舞台設定頁列出兩個螢幕。確認後以 SIGTERM 只結束這個 scratchpad 版，紀錄有 `app quit`。
- 實機驗證時抓到並修正的兩個問題：
  - macOS 上無邊框的畫布仍被 AppKit 推到選單列下方（要求 y 0，實際 y 30），`getBounds()` 不等於螢幕 bounds。Design Notes「macOS 選單列」說「macOS 不會把它的位置限制在選單列下方」與實測不符。修正：macOS 加 `enableLargerThanScreen: true`（Electron 對無邊框視窗會照給定的 frame 放），之後 `getBounds()` 等於螢幕 bounds；選單列仍畫在畫布上面（`alwaysOnTop` 預設層級低於選單列）。
  - `npm start` 時兩個 Vite dev server 共用預設的 `node_modules/.vite`，互相覆蓋預先打包的依賴，overlay 載 PixiJS 得到 `504 Outdated Optimize Dep`，`main.ts` 沒有執行（三次啟動裡出現一次）。修正：`vite.overlay.config.mts` 設 `cacheDir: node_modules/.vite-overlay`；之後啟動正常。
- spec 以外的決定：
  - `registerIpcHandler(contract, renderers, handler)`、`pushToRenderer(target, contract, renderers, payload)`；`renderers` 型別 `ChannelRenderers`（至少一個）放在 `src/main/ipc/origin.ts`。`app:get-version` 在 `main.ts` 傳 `['panels']`、`settings:*` 用 `SETTINGS_RENDERERS`、`stage-view:subscribe` 與 `stage-view:delta` 用 `STAGE_VIEW_RENDERERS`、`canvas:ready` 用 `CANVAS_RENDERERS`。拒絕時記 `renderer <name> may not use this channel`。
  - `environment.ts` 的 `isAllowedFrameUrl` 換成 `rendererOfUrl`；`app://` 只認 `panels`、`overlay` 兩個 host（以前任何 `app://` host 都放行）。`WindowsEnvironment` 改成 `{ packaged, devServers: { panels, overlay } }`，各自 `{ url, origin }`。
  - `canvas:ready` 回 `null`；`renderer` 限 `webgl`／`webgpu`／`canvas`（PixiJS 的 `renderer.name`）；`reason` 最多 200 字（`CANVAS_READY_REASON_MAX_LENGTH`）。
  - `displays` schema：id 規則同 `canvasDisplayId`、id 不重複、最多一個 primary、label 最多 200 字。Electron 給的 id 若不是非負安全整數（Linux 以 EDID 產生的 id 可能超過 2^53）就不列入，避免一個螢幕讓整份 StageView 無效；沒有任何螢幕時 `canvas` 為 null 並記一行錯誤。
  - 螢幕與設定的監聽（`watchDisplays`）放在 `stage-sources.ts`：`displays` 與 `canvas` 同一次增量更新；改設定會先推 `settings`、再推 `canvas` 兩個增量。只有 workArea 變動（例如 Dock 顯示／隱藏）時不推、不記。
  - 重建：`render-process-gone` 後延到下一個 task 才 `destroy()` 舊窗、建新窗（不在該事件 listener 內銷毀自己）；`before-quit` 呼叫 `canvas.stop()`，結束時不重建。畫布不交給 Dock 控制器，所以不影響 Dock 計數。
  - overlay：`autoStart: false`，初始化後 `render()` 一次就不跑渲染迴圈（還沒有角色與節拍，全螢幕空畫布每秒 60 次渲染沒有意義；Story 3.x 加節拍時再開）；`autoDensity: true`、`resolution: devicePixelRatio`。就緒在 PixiJS 初始化完成後回報，不等第一份 StageView 快照。`document.body.dataset` 記最後看到的 StageView rev 與世界大小，方便 DevTools 驗證。overlay 的 CSP 與面板相同（dev 版一樣含 `'unsafe-inline'`）。
  - `.dependency-cruiser.cjs` 加 `enhancedResolveOptions`（`exportsFields: ['exports']`）：`pixi.js/unsafe-eval` 只存在於套件的 `exports`，dependency-cruiser 預設忽略 `exports`，會報 `not-to-unresolvable`。守門反向測試仍全過。
  - 刪除 `src/overlay/.gitkeep`。面板頁面的純邏輯在 `src/panels/display-options.ts`，overlay 的啟動流程在 `src/overlay/start.ts`（都不依賴 DOM 型別與 PixiJS，Node 下可測）。
  - `deferred-work.md`：Story 1.3 的 B7 註記為已解決，另加本 story 的兩條延後項目。
- 已知限制：PixiJS 的 `resolution` 只在初始化時取 `devicePixelRatio`，畫布換到縮放比例不同的螢幕時不會跟著變（目前沒有內容，Story 3.x 處理）；Windows 跨不同 DPI 螢幕的 `setBounds`、Windows／Linux 的穿透與透明只有單元測試。
- 仍需使用者手動確認：桌面看不到畫布且點擊照常傳到底下的視窗；畫布不出現在 ⌘Tab 與工作列；Windows 上畫布不出現在 Alt+Tab（加了 `type: 'toolbar'`，只有單元測試）；多螢幕改選後畫布實際換到那個螢幕（開發代理只讀了 `getBounds()`）；選單列畫在畫布上面。
- 審查修補（第 1 輪；只跑了涵蓋修改檔案的測試，完整驗證由協調者執行）：
  - Windows 的畫布加 `type: 'toolbar'`（工具視窗）：只靠 `skipTaskbar` 與 `focusable: false`，全螢幕視窗仍可能出現在 Alt+Tab。macOS 維持 `type: 'panel'`，Linux 不加。Alt+Tab 仍需在 Windows 實機確認。
  - `CanvasWindowHandle` 加 `getBounds`：`ready-to-show` 顯示後與每次 `setBounds` 後，比對實際位置與要求的位置，不同時記一行 warn（兩者都寫），讓 macOS 選單列、Windows 跨 DPI 這類偏移出現在運行紀錄。
  - `watchPower` 啟動時讀一次 `getSystemIdleState(0)`：`locked` 時更新 `power.locked` 並記 `screen locked at startup`；丟錯當作未鎖定。
  - `watchDisplays` 裡 `canvas.place()` 包 try/catch 並記一行錯誤，避免 BrowserWindow 建構或 `setBounds` 丟錯時中斷 ready 後的啟動（`watchPower`）或讓螢幕事件丟出未捕捉的例外。
  - 舞台設定頁的選擇邏輯抽成 `createDisplayChooser`（`src/panels/display-options.ts`，不依賴 React 與 DOM 型別）：已選中的不送、送出中再選忽略、回覆前回報 saving、`{ ok: false }` 顯示 `patchErrorText`、呼叫失敗顯示通用錯誤、成功清掉 saving 與先前的錯誤；選擇本身只由 StageView 決定。`StageSettings` 只負責呈現；`displayPatch` 改收 settings rev。
  - 狀態列改由 StageView 的 `canvas` 區段產生（`stageViewStatusText`）：主螢幕顯示「主螢幕」、其他顯示螢幕名稱，fallback 加「（暫用主螢幕）」，還沒放好畫布時「尚未就緒」；不再顯示設定值（以前 fallback 時會顯示「畫布螢幕：999」）。
  - overlay 的 `failureReport` 轉字串時加防護：null-prototype 物件或會丟錯的 `toString` 改回報 `unknown error`，`startOverlay` 維持不會 reject。
  - 測試補上：畫布 `loadURL` 被拒時不產生 `unhandledRejection` 且保留視窗（確認拿掉 `.catch` 時會失敗）；`windows-main` 的 `currentEnvironment` mock 改成新的 `devServers` 結構；`.dependency-cruiser.cjs` 的註解改為照實說明（所有層共用同一組 condition，含 `node`；規則只看 import 落在哪個套件或資料夾，所以足夠）。
- 開發代理違反「不執行任何 git 指令」一次：開工時跑了唯讀的 `git status`。

- 修補後重跑：typecheck、lint、`npm test`（31 個檔、948 個測試）、depcruise 全部通過。實機（`npm start` 加隔離的 `--user-data-dir`，因為使用者的 Story 1.5 打包版仍在執行並持有真實 userData 的單一實例鎖）：運行紀錄依序 `displays: 2 connected`、`canvas on display 3, 1920x1080 at 0,0`、`canvas window created`、overlay 訂閱、`canvas ready (renderer webgl, 1920x1080)`，沒有位置不符的警告；再啟動一次後面板開啟並訂閱，結束時畫布與面板都關閉、`app quit`。打包版未在修補後重跑（重建會覆寫使用者正在執行的 `out/`）；修補前的打包版驗證已通過，這一輪改動的 macOS 行為只有新增的位置比對與啟動鎖定讀取。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 畫布 `loadURL` 被拒絕的路徑沒有測試 | low | patch | 預檢後送來的缺口：假視窗的 `loadURL` 永遠 resolve，拿掉 `.catch` 測試仍過；面板那邊已有同樣的測試，照做即可。 |
| VG2 舞台設定頁的 patch 失敗、等回覆時停用、不先改本地狀態沒有測試 | medium | patch | 預檢後送來的缺口：I/O 矩陣「改選螢幕」的錯誤處理沒有行為測試；把 `choose` 的邏輯抽成不依賴 React 的控制器再測，比引入 DOM 測試環境便宜。 |
| VG 其他 1 `render-process-gone` 後、延後的重建執行前若 `place()` 先跑，這次當掉不計入重建上限 | low | reject | 重建延後到 `setTimeout(0)`，中間要剛好遇到螢幕或設定變更才會發生；修正要加狀態旗標。 |
| VG 其他 2 `windows-main` 測試的環境 mock 仍是舊結構 | low | patch | mock 回傳 `devServerUrl`／`devServerOrigin`，與新的 `devServers` 不符；直接改成新結構。 |
| B1 被過濾掉的螢幕也不能放畫布 | low | reject | 只有 Linux 以 EDID 產生超過安全整數的 id 才會被過濾，Linux 是次要平台；改成用原始資料放置是新增分支。 |
| B2 windows 區段進 StageView 前沒有驗證，壞區段會卡住整份 StageView | low | reject | Electron 不會回報重複的螢幕 id 或 NaN 的大小；沒有能觸發的輸入，加防護是沒有實證狀態的守衛。 |
| B3 畫布停止重建後 StageView 仍說它在某個螢幕上，也沒有手動恢復 | low | reject | 目前沒有任何程式依賴畫布實際存在；要加畫布狀態需要改 schema，等 Story 3.x 有節拍與繪製時再設計。 |
| B4 沒有就緒逾時，preload 沒載入或 `app://` 404 時運行紀錄看不出來 | low | reject | 這時運行紀錄有「canvas window created」卻沒有「canvas ready」，缺少的那行本身就看得出來；404 只會在打包內容壞掉時出現；加逾時與重載是新增計時器。 |
| B5 `place()` 不看視窗實際的 `getBounds()` | low | patch | macOS 被推到選單列下方就是靠人工比對 `getBounds()` 才發現，Windows 跨 DPI 也可能偏移，而我們在本機測不到 Windows；建立後與 `setBounds` 後比對，不一致就記一行，讓使用者在 Windows 上看紀錄就知道。 |
| B6 GPU 行程當掉、WebGL context lost、renderer 無回應都沒處理 | medium | defer | I/O 矩陣只涵蓋 renderer 行程當掉；目前畫布沒有內容，這些情況的影響要等 Story 3.x 有繪製後才看得出來，屆時一起設計。 |
| B7 `power` 的初始值寫死為未鎖定 | low | patch | app 在鎖定中啟動時，`locked` 會一直是 false 直到下次事件；ready 時讀一次 `powerMonitor.getSystemIdleState` 是一行修正。 |
| B8 renderer 身分看網址，overlay 導到 `app://panels` 就會被當成 panels | low | reject | overlay 的 preload 不暴露任何設定 API，頁面也拿不到 `ipcRenderer`，所以就算身分被當成 panels 也呼叫不到 `settings:*`（E9 說的後果不成立）；沙盒 iframe 不能導覽頂層框架；要把每個視窗綁到自己的 host 是新增規則。 |
| B9 面板狀態列讀設定值，不是畫布實際所在 | low | patch | fallback 時會顯示「畫布螢幕：999」，但畫布其實在主螢幕；改讀 `canvas` 區段的 `displayId` 與 `fallback`。 |
| B10 舞台設定頁的互動沒有測試，錯誤訊息要等下一次選擇才清掉 | low | patch | 與 VG2 同一根因，抽出控制器時一起處理。 |
| B11 overlay 的 dev CSP 多了不需要的 script `'unsafe-inline'` | low | reject | 只有在 overlay 加 inline script 時才會出現「開發版正常、打包版壞」，而打包版驗證就會抓到；分 renderer 產生 CSP 是新增參數。 |
| B12 Windows 的 Alt+Tab 會不會出現畫布沒有處理 | low | patch | `skipTaskbar` 與 `focusable: false` 不保證畫布不出現在 Alt+Tab；Windows 上加 `type: 'toolbar'`（WS_EX_TOOLWINDOW）是一行修正，需要使用者在 Windows 上確認。 |
| B13 spec 與 sprint-status 狀態不一致 | false | reject | step-05 會把 story 設為 `review`。 |
| B14 Design Notes 的 macOS 選單列說法已被實測推翻，Spec Change Log 是空的 | low | reject | 修正方式是改這份 spec；實測結果與 `enableLargerThanScreen` 已記在 Implementation Notes。 |
| B15 `.dependency-cruiser.cjs` 的註解說「as Vite does」，條件與 Vite 不同 | low | patch | 條件含 `node` 且全域套用，與 Vite 解析 renderer 的條件不同；改正註解即可。 |
| E2 畫布不經 `render-process-gone` 就被關閉時不會重建 | low | reject | 畫布不能取得焦點、沒有邊框，使用者關不掉它；只有結束 app 時才會關閉，那時本來就不該重建。 |
| E5 `canvas.place` 在 `layout()` 裡丟錯，會跳過 `watchPower` 並讓螢幕事件丟出未處理的錯誤 | low | patch | `BrowserWindow` 建構或 `setBounds` 丟錯時，ready 之後的 `watchPower` 不會執行；包 try/catch 並記一行是直接修正。 |
| E6 沒有任何螢幕時畫布留在舊位置 | low | reject | Electron 一律至少回報一個螢幕。 |
| E10 `String(error)` 丟錯時 `startOverlay` 會 reject | low | patch | 違反「never rejects」；包 try/catch 是直接修正。 |
| E1 重建延後期間 `place()` 建立的新視窗不計入重建上限 | low | reject | 與 VG 其他 1 同一項。 |
| E3 停止重建後 StageView 的 `canvas` 區段仍有位置 | low | reject | 與 B3 同一項。 |
| E4 overlay 頁 404 或永遠不回報就緒時沒有紀錄 | low | reject | 與 B4 同一項。 |
| E7 螢幕 id 重複或大小是 NaN 時 schema 驗證失敗 | low | reject | 與 B2 同一項。 |
| E8 區段驗證失敗時 rev 與 view 仍然前進 | low | reject | 與 B2 同一項。 |
| E9 overlay 導到 `app://panels` 後可以呼叫 `settings:*` | false | reject | overlay 的 preload 不暴露設定 API，頁面也拿不到 `ipcRenderer`，所以呼叫不到；見 B8。 |
| E11 `windows-main` 測試的環境 mock 是舊結構 | low | patch | 與 VG 其他 2 同一項。 |
| E12 運行紀錄寫英文，spec 寫「畫布就緒」 | false | reject | 所有運行紀錄的內容都是英文；spec 裡的中文是在描述這一行的意思，不是指定字面內容。 |

## Design Notes

**為什麼放進 StageView：** AD-20 規定 main 往畫面只推 StageView，而 AD-14 要 `main/windows` 在換螢幕或縮放改變時「通知 overlay」。兩者合起來，唯一一致的做法就是把畫布的世界座標放進 StageView。面板的螢幕清單和睡眠／鎖定狀態同理，overlay 和面板都只看 StageView。

**區段範例：**
```json
{ "displays": [{ "id": 1, "label": "Built-in Retina Display", "bounds": { "x": 0, "y": 0, "width": 1512, "height": 982 }, "scaleFactor": 2, "primary": true }],
  "canvas": { "displayId": 1, "bounds": { "x": 0, "y": 0, "width": 1512, "height": 982 }, "scaleFactor": 2, "fallback": false },
  "power": { "suspended": false, "locked": false } }
```
世界座標是 `canvas.bounds` 的寬高，原點在左上角（0, 0）。`bounds` 的 x、y 只是給 main 放視窗用的。

**macOS 選單列：** 畫布沒有邊框，macOS 不會把它的位置限制在選單列下方，所以畫布蓋住整個螢幕，選單列畫在畫布上面。這一點不另外處理。

**驗證限制：** 開發代理不截圖。透明、置頂、穿透的實際外觀要由使用者確認；開發代理用運行紀錄、`getBounds()`、`isAlwaysOnTop()`，以及 DevTools 讀頁面來驗證。Windows 與 Linux 的穿透只能靠單元測試和使用者確認。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`：expected 全部通過。
- `npm start`：expected 運行紀錄有畫布建立與「畫布就緒（webgl）」，畫布的 bounds 等於主螢幕；確認後結束 app。
- `npm run package` 後啟動打包版：expected 畫布從 `app://overlay/` 載入並回報就緒；確認後結束。

**Manual checks (if no CLI):**
- 使用者確認：
  - 桌面看不到畫布，但點擊照常傳到底下的視窗；
  - 畫布不出現在 ⌘Tab 和工作列；
  - 舞台設定頁列出螢幕，改選後畫布換到那個螢幕（多螢幕時確認）。
