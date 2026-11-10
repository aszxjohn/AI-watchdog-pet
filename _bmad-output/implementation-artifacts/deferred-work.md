- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: preload 檔名寫錯時沒有任何驗證會發現（VG2、E4）（已解決）
  evidence: preload 目前為空；Story 1.3 讓 preload 暴露 API 時，加上對 API 存在的斷言。Epic 1 回顧確認：Story 1.5 的 `PRELOAD_BUNDLES` 與 `forge.config.mts` 一致性測試（`test/main/windows-main.test.ts`）已涵蓋。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: oxlint 不展開 glob，新增根目錄 .mts 不會被 lint（B7、E14）（已解決）
  evidence: Story 1.3 新增 vitest／dependency-cruiser 設定並建 CI 時，一併調整 lint 範圍的維護方式。Epic 1 回顧確認：`scripts/lint.mjs` 已由 Story 1.3 改成動態列出根目錄設定檔（第 5、26 行）。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: renderer 名稱仍是模板的 main_window（B8）（已解決）
  evidence: Story 1.5／1.6 建立 panels 與 overlay 兩個 renderer 時決定命名與 `*_VITE_*` 宣告。已由 Story 1.5 改名為 `panels`。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: main、preload、renderer 共用一份 tsconfig，型別檢查擋不住跨 process 誤用（B10a）（部分解決）
  evidence: Story 1.3 建 preload API 時決定是否拆分各 process 的 tsconfig。Epic 1 回顧確認：renderer 已拆到 `tsconfig.web.json`（含 DOM）；main 與 preload 仍共用 `tsconfig.node.json`。
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
- source_spec: `_bmad-output/implementation-artifacts/epic-1-acceptance.md`
  summary: 選單列的佔位圖示（空心圓圈）很難認出來，使用者驗收時在選單列找不到 app（A1）
  evidence: 2026-11-06 打包版實機驗收：圖示確實存在（副螢幕選單列 x=3186），但要由 Claude 指出位置才找得到。正式圖示設計前，至少換成較容易辨認的佔位圖，或在第一次啟動時提示 app 在選單列。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-acceptance.md`
  summary: 使用者以為關掉面板就是結束 app，目前沒有任何提示說明 app 會繼續留在選單列
  evidence: 2026-11-06 驗收時，使用者回報「結束了」，紀錄卻只有 `panel closed`。常駐是 FR7 的預期行為；可考慮在第一次關掉面板時提示一次，或在面板上標示「關閉後仍在選單列執行」。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: 開發模式放行 dev server 時只看目標 URL，不看發起者；違反 AD-24「沙盒 iframe 與 pack:// 在任何環境都沒有例外」（R4）
  evidence: `src/main/windows/environment.ts:158-182`。現在還沒有沙盒，所以沒有實際暴露。Story 3.5 的驗收條件必須加上：只放行 overlay 或 panels 頂層框架發出的 dev server 請求，`pack://` 發出的一律 cancel，並附測試。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: 一次 settings:patch 產生兩個 StageView 增量（先 settings、後 canvas），中間有不一致的狀態；settings → StageView → watchDisplays → canvas 這條鏈沒有整合測試（R10）
  evidence: `src/main/stage-view/stage-view.ts:96-101`、`src/main/windows/stage-sources.ts:187`。Story 3.6 讓 overlay 同時讀 settings 與 canvas 之前，要先合併同一次變更的增量；整合測試可以提早到 Story 2.3。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: Windows 關機或登出不觸發 will-quit，500 ms 內的設定變更會遺失，紀錄也沒有結束行（R11，重提 1.4 E3）
  evidence: `src/` 沒有 `session-end`。1.4 當時拒絕的理由「視窗由 1.5 重寫」已經不成立。在 Windows 實機驗證時，於畫布視窗掛 `session-end`，同步寫設定、停止畫布並記一行。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: before-quit 時 canvas.stop() 之後無法恢復；若結束被取消，桌寵會消失（R12）
  evidence: `src/main/main.ts:153-156`、`src/main/windows/canvas-window.ts:251-252`。目前沒有任何東西會取消結束。Epic 2 加入編輯頁時二選一：面板不得阻擋卸載，或畫布提供恢復的方法。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: StageView 的 canvas 區段發佈的是要求的位置，不是實際位置；偏差只記一行（R13）
  evidence: `src/shared/stage-view.ts:62-76`、`src/main/windows/canvas-window.ts:213-234`。Story 3.x 開始畫角色時，和 DPI、setBounds 偏差的延後項目一起處理：把實際 bounds 寫回，或在契約加上偏差欄位。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: 設定只存 Display.id，換接埠或接擴充座後 id 可能改變（R14）
  evidence: `src/shared/settings.ts:28-34`，平台行為沒有實測。Epic 5 舞台設定時決定要不要存輔助資訊（名稱、尺寸）；在那之前，規格寫明「id 改變時退回主螢幕，需要使用者重選」。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: settings.json 無法寫入時改選螢幕，畫面顯示成功，重啟後卻回到舊值（R15，重提 1.4 B4）
  evidence: `src/panels/display-options.ts:154-167`。Epic 2 處理面板錯誤提示時，patch 結果回報是否已保存，沒保存就提示使用者。
- source_spec: `_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md`
  summary: windows 區段只要一筆不合 schema，StageView 就會一直推不出去（R16，重提 1.6 B2／E7／E8）
  evidence: `src/main/stage-view/stage-view.ts:76-94`。觸發條件（重複的螢幕 id）沒有實際證據；之後新增區段時，改成先驗證再前進 rev。
- source_spec: `_bmad-output/implementation-artifacts/spec-epic-1-retro-closeout.md`
  summary: 面板開著、Dock 圖示出現時，Dock 圖示右鍵選單的「隱藏」，以及別的 app 的「隱藏其他」，仍會把整個 app 連同畫布藏起來（R2 同類，收尾 story 只處理本 app 選單的 ⌘H）
  evidence: 兩者都走 macOS 的整個 app 隱藏（NSApplication hide），所有視窗都會被藏；收尾 story 審查 E5／B8 指出，沒有實測。Epic 3 角色上台前決定做法，例如偵測 app 被隱藏後讓畫布重新出現，並在實機確認。
- source_spec: `_bmad-output/implementation-artifacts/spec-epic-1-retro-closeout.md`
  summary: 「關閉面板」（⌘H）與 ⌘W 都走 win.close()，之後若有頁面擋下卸載（Epic 2 編輯頁），關閉可能被取消或丟掉未存內容
  evidence: `src/main/windows/panel-window.ts` 的 `close()`；目前沒有任何頁面會擋。與 R12 同一類，Epic 2 編輯頁一起決定「未存內容時關閉面板」的規則。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-detection-event-contract-reducer.md`
  summary: 把 `doneMs`（預設 5 秒）、`idleMs`（預設 5 分鐘）、`errorHoldMs`（預設 30 秒，使用者 2026-11-09 決定）加進 `src/shared/settings.ts` 的設定 schema，含合理範圍，並修正測試裡寫死的完整設定值；判斷器改由設定取值
  evidence: Story 2.1 規格約 2,700 token，使用者 2026-11-09 選擇拆開；判斷器已改成由呼叫端傳入計時值，不依賴設定。建議併入 Story 2.2，與 `approvalInferMs`、`discoveryWindowMs`、`sessionExpireMs`、`syncTimeoutMs` 一起加，那時計時器才真正開始運作。Story 2.1 驗收條件中「設定 schema 的預設值」這一段隨之移過去。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-detection-event-contract-reducer.md`
  summary: 已結束的 session 在判斷器裡仍評估為 `waiting`、`nextChangeAt` 照常回報時間，同一個 key 之後的事件（含 `session.start`）都被忽略；Story 2.2 的 `sessions` 要丟掉已結束的條件物件，讓重用同一原生 id 的 session 從頭建立，也不顯示、不替它排計時器
  evidence: Story 2.1 審查 B6／E3／E4（`src/main/detection/reducer.ts` 的 `reduceSession`、`evaluate`、`nextChangeAt`）。未驗證，若呼叫端保留已結束的條件物件則為 medium：恢復的 session 永遠停在 `waiting`→`idle`。要確認的是 2.2 的 `sessions` 怎麼處理 `ended: true`，以及各工具恢復對話時是否重用原生 id。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-detection-event-contract-reducer.md`
  summary: 推測的 `approval.request`／`question.request` 若在同 id 的 `tool.end` 之後才送到判斷器，或 id 不在進行中的 tool 裡，會開出只有 `turn.end`／`session.end` 才能關的未決項目
  evidence: Story 2.1 審查 B4／E6（`src/main/detection/reducer.ts` 的 `withRequest`）。未驗證，若成立為 medium：沒有 turn 標記的來源會一直顯示「要你批准」。要在 Story 2.2 確認推測模組只對還開著的 tool 發出推測，且推測與 `tool.end` 的處理順序不會競態；否則在判斷器忽略 id 不在 `openTools` 裡的推測 request。
- source_spec: none
  summary: Story 2.2 的推測部分：各來源的能力表、`main/detection/inference`、`approvalInferMs`（預設 10 秒）設定欄位，以及推測 request 晚於 `tool.end` 送到的競態（上面 Story 2.1 審查 B4／E6 那一項）
  evidence: 使用者 2026-11-09 選擇把 Story 2.2 拆成兩個：先做 session 生命週期、啟動補讀與計時設定，推測是獨立模組，接著另做；兩者都完成，Story 2.2 才算全部完成。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-session-lifecycle-replay.md`
  summary: 同一個 session 的補讀事件若晚於即時事件送到，較舊的 `turn.start`／`tool.start` 會清掉即時的 `done`／`error`，較舊的 `session.end` 會結束正在跑的 session，較舊的 `session.meta` 會蓋掉新名稱
  evidence: Story 2.2 審查 B1／E1／E2／E3（`src/main/detection/reducer.ts`、`src/main/detection/sessions.ts` 的 `apply`）。未驗證，若成立為 medium。Story 2.4 Claude Code 轉接器要合併狀態檔（即時）與 transcript（補讀），屆時二選一：約定每個來源先送完補讀再送即時事件，或由 `sessions` 忽略比該 session 最後一筆即時事件還舊的補讀。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-session-lifecycle-replay.md`
  summary: 同步是一次性的，`syncTimeoutMs` 從 `createSessions` 起算；補讀超過期限、轉接器重啟或較晚啟動時，同步後才到的補讀會逐筆發布，狀態會亂跳
  evidence: Story 2.2 審查 B2（`src/main/detection/sessions.ts` 的 `startedAt`、`syncDeadlinePassed`；`test/main/detection-sessions.test.ts` 有一個測試把逐筆發布定為預期）。未驗證，若成立為 medium。Story 2.3 接線時確認：`createSessions` 要在轉接器啟動前一刻建立，並決定轉接器重啟或同步後仍送補讀時要怎麼處理。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-session-lifecycle-replay.md`
  summary: macOS 睡眠期間 `performance.now()` 與 Node 計時器都不前進，闔上筆電一整晚後，`idle`、逾時、`done`、`error` 都會晚一整晚
  evidence: Story 2.2 審查 B4／E6。libuv 的 `uv_hrtime` 在 macOS 用 `mach_absolute_time`，睡眠時不增加。`sessions` 的 `now` 是注入的，所以 Story 2.3 接線時處理：`now` 用 `performance.now()` 加上睡眠偏移量，偏移量在 `powerMonitor` 的 resume 時以牆鐘差補上（`src/main/windows/power.ts` 已有 suspend／resume），然後呼叫 `retime()`；並在實機闔蓋確認。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 擋掉轉接器送來的 `via: inferred` 事件（推測只能由 `main/detection/inference` 產生），並讓判斷器忽略 id 不在進行中 tool 裡的推測 request
  evidence: Story 2.2 推測部分的規格約 2,500 token，使用者 2026-11-10 選擇拆開。這兩項是防護：推測放在 `sessions` 的重算裡、只對還開著的 tool 推測，所以 2.1 審查 B4／E6 的競態在推測模組這邊不會發生；剩下的風險只有轉接器自己送出 `via: inferred`。目前沒有任何轉接器，建議在 Story 2.3 接上第一個轉接器（`demo`）時一起做。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 上一輪的 `turn.end` 漏寫、工具還開著時收到新的 `turn.start`，舊工具會被推測，新的一輪顯示 `approval` 而不是 `thinking`
  evidence: Story 2.2 推測部分審查 E2。判斷器依 AD-21 只在 `turn.end` 清空工具。未驗證，若成立為 medium。在轉接器 story（2.4～2.7）以真實紀錄確認各來源會不會寫出沒有 `turn.end` 的下一個 `turn.start`；會的話，決定 `turn.start` 是否清掉上一輪的工具，或推測略過 `turn.start` 之前開始的工具。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 同步期限過後才補讀到的 `tool.start`，在它的 `tool.end` 補讀到之前就被推測，發布 `approval` 後又撤回
  evidence: Story 2.2 推測部分審查 E3。與 2.2 上半審查 B2（同步是一次性的）同源。未驗證，若成立為 medium。Story 2.3 接線時一起決定補讀超過期限時的處理。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 推測 `approval` 之後，同 id 的 exact `question.request` 才到，推測的 `approval` 優先序較高，仍顯示 `approval`（`inferred`）
  evidence: Story 2.2 推測部分審查 E4。要同時滿足 approval 為 `none`、question 為 `exact`、工具不在提問類清單、question 晚於門檻才寫入（例如 cursor 延遲寫入）。未驗證，若成立為 medium。Story 2.6／2.7 依真實紀錄補提問類清單並確認時機；若會發生，依 AD-22「同 id 的 exact 事件取代推測」，讓 exact 的另一種 request 關掉同 id 的推測。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 能力表沒有「本來就會跑很久的工具」排除清單；`claude-code` 退回推測時，subagent、WebFetch 等都會被推測成 `approval`
  evidence: Story 2.2 推測部分審查 B1。原型（shelved 的 SessionWatcher）有 `Agent`、`Task`、`WebSearch`、`WebFetch` 等慢工具清單。未驗證，若成立為 medium；只有 Story 2.4 讓 `claude-code` 在狀態檔失效時退回推測才會遇到，由 2.4 決定是否在能力表加排除清單。
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-inference.md`
  summary: 能力表沒有表達「讀不到每個工具的結束」與「寫入延遲」；cursor 若只在 `turn.end` 關工具，幾乎每個超過 10 秒的 turn 都會被推測成 `approval`
  evidence: Story 2.2 推測部分審查 B4。AD-4 寫 cursor 沒有 tool_result、以 step 為單位延遲寫入。未驗證，若成立為 medium。Story 2.7 確認 cursor 轉接器能否發出每個工具的 `tool.end`；不能的話，能力表加欄位、或該來源改用較長的門檻或不推測。
