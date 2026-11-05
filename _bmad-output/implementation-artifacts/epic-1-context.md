# Epic 1 Context: 舞台骨架：裝好就能常駐

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

建立舞台主程式（Electron 桌面 app）能常駐的骨架：專案與目錄、共用契約／IPC／CI 規則、可靠的設定與運行紀錄、StageView 訂閱骨架、選單列／系統匣入口與面板視窗，以及一張透明、置頂、不擋操作的畫布。本 epic 不含偵測與角色包，但之後每個 epic 都建在這裡定下的技術棧、行程邊界與資料規則上。沙盒原型閘門緊接專案骨架之後最先完成，四項實測全過，角色包 API 與沙盒（Epic 3）才能照現有架構開工。

## Stories

- Story 1.1: 用 Forge 模板建立專案骨架
- Story 1.2: 沙盒原型驗證（AD-7 閘門）
- Story 1.3: 共用契約、IPC 骨架與 CI
- Story 1.4: 可靠的設定、StageView 與運行紀錄
- Story 1.5: 選單列／系統匣入口與面板視窗
- Story 1.6: 透明置頂穿透畫布

## Requirements & Constraints

- 畫布透明、無邊框、置頂，放在使用者選的單一螢幕；沒有角色時點擊全部穿透到底下的視窗。Linux 次要：整窗穿透、選單走系統匣。
- 入口只在 macOS 選單列／Windows 系統匣，選單項：管理 session、角色包、舞台設定、結束（未實作的頁先顯示「即將推出」）。沒有面板開著時 Dock／工作列沒有圖示；開面板才暫時出現（可 ⌘Tab／Alt+Tab），全部關掉就消失。
- 單一實例：再啟動一次不開第二個，改開主面板。
- 設定檔不能被默默蓋掉：讀不懂或遷移失敗時改名 `settings.json.broken-<時間>`、記一行錯誤、用預設值正常啟動；只有單一欄位型別錯時只有那欄用預設，原檔一樣留備份。
- 運行紀錄：一小時一檔、一行一件事（時間、類別、內容），開新檔時刪掉開始時間超過 24 小時的檔。
- 完全不連網：main 與所有 renderer 不發任何對外請求。
- 平台 macOS 13+、Windows x64／arm64，CI 兩者都跑。`src/` 不得出現任何角色、系列名稱或角色專屬分支；判別值一律英文代碼，中文只在顯示層。

## Technical Decisions

- **尚未安裝、要鎖確切版本的套件：** （zod 4.6.7、Vitest 5.1.0、dependency-cruiser 18.7.2 已於 Story 1.3 安裝）React／react-dom 19.3.1、@types/react 19.3.0、@vitejs/plugin-react 6.2.1、@playwright/test 1.64.1。npm，lockfile 必須提交。lint、typecheck、測試、dependency-cruiser 只掃 `src/`、`test/`、`prototypes/`。
- **依賴方向：** `src/shared` 不依賴任何層；其他層只往 `shared` 依賴；overlay／panels 只能經各自 preload 呼叫 main，不得 import `src/main`；preload 只依賴 `shared` 與 Electron renderer API；`src/overlay` 不引入 React。CI 用 dependency-cruiser 強制，並禁止 `src/` 引用 `http`、`https`、`http2`、`net`、`tls`、`dgram`。
- **共用契約：** 跨邊界資料（IPC、設定檔，之後的舞台↔包與 manifest）只在 `src/shared` 定義一次 zod schema，收到就嚴格驗證；`src/shared` 最先載入的 side-effect 模組設 `z.config({ jitless: true })`。運行常數只在 `src/shared/constants`，使用者可調的預設只在設定 schema。8 狀態碼與中文顯示名對照只定義一次。時間戳用 epoch 毫秒。每個 schema 有往返與拒絕測試。
- **IPC：** 通道 `<domain>:<action>`；invoke 回傳 `{ ok: true, data }`／`{ ok: false, error }`；所有 handler 經同一個註冊函式，`senderFrame` 為 null 或不是 `app://` 頂層框架就拒絕。main 往 renderer 只推 StageView。preload 每個 renderer 一支（`overlay.ts`、`panels.ts`），只暴露最小 API，不依賴 Node polyfill（沙盒化 preload 沒有 `Buffer`、`setImmediate`）。
- **檔案與設定：** 只有 main 寫檔、一檔一擁有者，全放 `userData`：`settings.json` 歸 `main/settings`、`logs/` 歸 `main/log`。寫入一律 temp＋rename；持久檔帶 `schemaVersion`，由 `main/<擁有者>/migrations` 只往前遷移，遷移失敗才走壞檔流程。設定 IPC 只有 `settings:get` 與 `settings:patch`（帶 `baseRev` 與欄位操作），沒有整份覆寫；`baseRev` 過舊時以欄位合併、同欄位後到者勝、回傳新 `rev`；patch 立即反映到 StageView，落地以 `flushDebounceMs` 合併。main 寫入時一定再驗證，面板驗證只為 UX。
- **StageView：** `main/stage-view` 只組合、不擁有資料（Epic 1 只有設定），帶單調遞增 `rev`；訂閱 → 完整快照 → 增量，`rev` 不連號或 renderer 重載就重拿快照。renderer 寫入只走擁有者的 invoke，不先改本地狀態。
- **Electron 安全（所有視窗）：** `sandbox`、`contextIsolation` 開；`nodeIntegration`、`nodeIntegrationInSubFrames`、`nodeIntegrationInWorker` 關；`setWindowOpenHandler`、`setPermissionRequestHandler` 一律拒絕；`will-frame-navigate` 只允許 `app://`、`pack://`。overlay／panels 的 CSP 為 `script-src 'self'`、不含 `'unsafe-eval'`。打包後由 `app://` 載入（不用 `file://`）；`!app.isPackaged` 時只對 overlay、panels 放行 Vite dev server 的 `http://localhost:<port>`、`ws://localhost:<port>`。環境判斷與 `webRequest` 放行清單集中在 `main/windows`。
- **自訂協定：** `app`、`pack` 只在 `main/windows` 於 ready 前以 `protocol.registerSchemesAsPrivileged` 註冊一次，都不給 `bypassCSP`；`pack` 為 `standard`、`secure`、`corsEnabled`（原型實測的最小集合），`app` 的最小集合由 Story 1.5 實測決定。`app://` 處理器歸 `main/windows`，`pack://` 處理器歸 `main/packs`。
- **畫布：** overlay 入口第一行 `import 'pixi.js/unsafe-eval'`；PixiJS 以 `preference: 'webgl'`、透明背景初始化，載入任何貼圖前設 `Assets.setPreferences({ preferCreateImageBitmap: false })`（否則預設載入方式建的 blob Worker 被 CSP 擋下，永遠卡住且不報錯）。視窗 `backgroundThrottling: false`；macOS `type: 'panel'` 已在所有桌面空間可見，不另呼叫 `setVisibleOnAllWorkspaces`。穿透用 `setIgnoreMouseEvents(true, { forward: true })`。世界座標＝所選螢幕的 DIP、原點左上，由 `main/windows` 在換螢幕、邊界或縮放改變時通知 overlay；所選螢幕拔掉就回主螢幕。`main/windows` 監聽 `render-process-gone` 重建畫布（overlay 重拿 StageView 快照），並把 `powerMonitor` 的睡眠／鎖定與喚醒／解鎖通知 overlay。選單內容也只在 `main/windows` 一處定義，角色包不能加項目。

## UX & Interaction Patterns

- 面板用 React，經 `src/preload/panels.ts` 訂閱 StageView；畫布不用 React。沒有 UX 設計文件，面板版面在開發時決定。
- 舞台設定頁在 Epic 1 只有「畫布所在螢幕」一個選項：列出目前接上的螢幕，預設主螢幕。

## Cross-Story Dependencies

- 1.1 → 1.2 最先完成；原型程式放 `prototypes/sandbox/`，不進 `src/`。1.2 原型報告標記閘門通過前，不開始 Story 3.1 與 3.5 起的沙盒相關 story；閘門失敗時 1.3～1.6 與 Epic 2 仍可繼續。
- 1.3～1.6 都建在 1.1 上；1.4 的 `settings:*` handler 與 StageView 推送走 1.3 的 IPC 註冊函式與共用 schema；1.5 的面板訂閱 1.4 的 StageView；1.6 的舞台設定頁取代 1.5 的「即將推出」，選擇經 `settings:patch` 寫入。
- 1.6 只送睡眠／鎖定通知並記入運行紀錄；world 節拍與心跳的暫停到 Story 3.6 才生效。
- 後續沿用：Story 2.9 在 1.6 的舞台設定頁加計時欄位；不連網的動態驗證在 Story 2.3 的端到端測試；`pack://` 處理器在 Story 3.2；「游標在角色上才關穿透」在 Story 4.2，屆時穿透狀態由 overlay 擁有、以帶遞增 `seq` 的請求通知 main。
