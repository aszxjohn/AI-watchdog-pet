- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: preload 檔名寫錯時沒有任何驗證會發現（VG2、E4）
  evidence: preload 目前為空；Story 1.3 讓 preload 暴露 API 時，加上對 API 存在的斷言。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: oxlint 不展開 glob，新增根目錄 .mts 不會被 lint（B7、E14）
  evidence: Story 1.3 新增 vitest／dependency-cruiser 設定並建 CI 時，一併調整 lint 範圍的維護方式。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: renderer 名稱仍是模板的 main_window（B8）（已解決）
  evidence: Story 1.5／1.6 建立 panels 與 overlay 兩個 renderer 時決定命名與 `*_VITE_*` 宣告。已由 Story 1.5 改名為 `panels`。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: main、preload、renderer 共用一份 tsconfig，型別檢查擋不住跨 process 誤用（B10a）
  evidence: Story 1.3 建 preload API 時決定是否拆分各 process 的 tsconfig。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: 模板 main.ts 尚未符合 AD-24／NFR10：file:// 載入、未明寫 sandbox 等設定、沒有 CSP、沒有單一實例鎖、沒擋 window.open 與外部導覽、Squirrel 事件與載入失敗沒處理（B13b～d、E1、E3、E5～E7）（已解決）
  evidence: 這些都在 Story 1.5（選單列／面板視窗）的驗收條件內，屆時改寫視窗建立流程。已由 Story 1.5 的 `src/main/windows` 處理：`app://` 載入、明寫 webPreferences、CSP、單一實例鎖、擋開新視窗與導覽、Squirrel 時直接結束、載入失敗時記錄並關閉面板。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: README 還寫 main 沒有程式碼，缺開發入口說明（B17a）
  evidence: 本 story 禁止覆蓋 README；另開文件更新：`nvm use`／`npm ci`／`npm start`、lint 範圍、`npm_config_cache` 繞道。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: package.json 宣告 MIT 但 repo 沒有 LICENSE 檔（B17c）
  evidence: LICENSE 需要著作權人名稱，由使用者決定後新增。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: preload bundle 名稱與 main 的期待沒有 CI 一致性檢查，CI 也沒有 build 步驟（VG3、B14）
  evidence: Story 1.5 新增 overlay 視窗時集中 bundle 名稱；Story 2.3 建 Playwright `_electron` 端到端測試時在 CI 一併建置並檢查 preload 產物只 require `electron`。Story 1.5 已加 `PRELOAD_BUNDLES` 與 `forge.config.mts` 的一致性測試；CI 建置與端到端仍在 Story 2.3。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: IPC 只有 invoke，沒有 main→renderer 推送的契約與驗證（B6）（已解決）
  evidence: Story 1.4 建 StageView 推送時，以 `src/shared` 同一套 schema 加 main 端 send 與 preload 端 subscribe。已由 Story 1.4 的 `IpcPushContract`、`src/main/ipc/push.ts` 與 `src/preload/stage-view.ts` 完成。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: IPC 允許清單不分通道、dev server 來源只認 main_window 且暫放在 register.ts（B7）（已解決）
  evidence: Story 1.5／1.6 建立 overlay 視窗時，把來源判斷搬到 `main/windows`，並依視窗限制可呼叫的通道。Story 1.4 已先把來源判斷從 `register.ts` 抽到 `src/main/ipc/origin.ts`，invoke 與推送共用。Story 1.5 已把環境判斷與來源規則集中到 `src/main/windows/environment.ts`。Story 1.6 完成依視窗限制：`registerIpcHandler`／`pushToRenderer` 必填 `renderers`，`environment.ts` 的 `rendererOfUrl` 認 `app://panels`、`app://overlay` 與兩個 dev server，其他 renderer 一律 `sender-rejected`。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: preload 以不含 DOM 的 lib 做型別檢查（B18a）
  evidence: preload 開始使用 DOM API 時，為 preload 開獨立 tsconfig（DOM＋Electron 型別）。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: 打包版以 file:// 載入，IPC 一律被拒（E4）（已解決）
  evidence: Story 1.5 改用 `app://` 後恢復；在那之前打包版面板顯示錯誤是預期行為。Story 1.5 改用 `app://` 後，打包版實測 IPC 正常。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: 第一次 `npm start` 曾出現沒有 renderer 的情況，原因未查明
  evidence: 之後 3 次都正常；再發生時保留當下的主程式輸出再追查。Story 1.5 開發時另觀察到一次「第一次開的面板約 3.6 秒後自行關閉」，可能相關，見下方新條目。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: CI 尚未實際執行（已解決）
  evidence: 2026-11-05 推送 c938ea4 後，CI 在 macOS 與 Windows 都通過。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-settings-stageview-run-log.md`
  summary: Squirrel 安裝／更新／解除安裝事件時，main 仍會初始化運行紀錄並載入設定（B8、E1）（已解決）
  evidence: `if (started) app.quit()` 不會中止模組往下執行，`initRunLog`、`loadSettings`（可能改名、複製或寫回 `settings.json`）都會跑；Story 1.5 處理 Squirrel 事件時，要讓這些初始化在 `started` 時一律跳過。Story 1.5 在 `started` 或拿不到單一實例鎖時直接結束，不初始化任何東西。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-tray-entry-panel-window.md`
  summary: 第一次開的面板曾在約 3.6 秒後走一般 `closed` 路徑自行關閉，原因未確認（未驗證，若屬實為 medium）
  evidence: 只在開發代理的一次 `npm start` 出現，之後沒有重現；再發生時保留運行紀錄的 `windows` 行與 DevTools 狀態，確認是誰觸發關閉。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-tray-entry-panel-window.md`
  summary: 面板的 React 元件（錯誤訊息、訂閱的掛載與卸載、`aria-current`）沒有元件層級的自動測試
  evidence: Vitest 目前是 node 環境，元件測試需要 jsdom 或 happy-dom 等新套件；Epic 2 面板有實際內容時決定是否引入。hash 切頁邏輯已抽成純函式並測試。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-transparent-canvas.md`
  summary: 畫布換到縮放比例不同的螢幕時，PixiJS 的 `resolution` 不會跟著變
  evidence: overlay 只在初始化時取 `devicePixelRatio`；目前畫布沒有內容，看不出差別。Story 3.x 開始畫角色時，依 StageView `canvas.scaleFactor` 調整 renderer 的 resolution。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-transparent-canvas.md`
  summary: Windows／Linux 的穿透、透明與跨 DPI 螢幕 `setBounds` 只有單元測試
  evidence: 開發代理只能在 macOS 實測；Windows 上 Electron 在不同 DPI 螢幕間 `setBounds` 有已知的大小偏差問題。需在 Windows 實機確認，Story 2.3 的端到端測試可補 `getBounds()` 檢查。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-transparent-canvas.md`
  summary: 畫布沒有處理 GPU 行程當掉、WebGL context lost／restored、renderer 無回應（B6）
  evidence: 目前只處理 renderer 行程當掉；overlay 以 `autoStart: false` 只畫一次，context 恢復後也不會重畫。Story 3.x 有節拍與繪製時，一起設計這些情況的偵測、記錄與重建。
