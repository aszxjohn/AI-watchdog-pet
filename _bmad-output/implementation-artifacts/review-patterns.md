# 本專案缺陷模式表

- 用途：開發代理動手前先讀，對照「常見位置」事先補上「測試或檢查」；Verification Gap 審查時也以此表當參考清單。
- 來源：各 `spec-*.md` 的 `## Review Triage Log`（去向為 patch，或判定 medium 以上的 defer）與 `epic-*-retro-*.md`；駁回（reject、false）的列不計。收錄條件：出現在至少 2 份 spec，或單次但 medium 以上。
- 更新：每段 story 審查後，主流程把新的反覆模式補進來（先找是否已有同類，有就只增補出處）；每列都要能追到出處編號。
- 出處寫法：`spec 檔名 編號`，省略 `.md`；`retro` 指 `epic-1-retro-2026-11-06.md` 的 R 編號、`epic-2-retro-2026-11-13.md` 的 F 編號。

## A. 生命週期與停止後的事件

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-01 | 啟動鏈或收尾鏈某一步丟例外，後面的步驟（防護、電源監看、`detection.stop()`）被跳過，且沒有 `.catch` 與 log | main 的 ready 鏈、`before-quit`、windows 建立 | 對鏈上每一步注入例外，斷言後續步驟仍執行、有一行 log；安全防護排在最前面 | spec-1-5-tray-entry-panel-window E9；spec-1-6-transparent-canvas E5、E10；spec-2-3-demo-sessions-panel B4、E2；spec-epic-1-retro-closeout B4；retro R1 |
| RP-02 | `stop()`、取消訂閱或達重試上限之後，仍處理新事件、設計時器、或呼叫已取消的監聽者；`stop()` 本身丟例外沒處理 | overlay 計時器、adapter `stop()`、listener 通知 | 停止後再送事件，斷言無 log、無計時器；通知前複製清單並檢查仍在清單；`stop()` 注入例外 | spec-3-6-stability B5、E3；spec-2-4-claude-code-transcript VG4；spec-2-8-session-release E5；spec-1-4-settings-stageview-run-log E7 |
| RP-03 | 移除、換版、重啟、資料夾消失再回來之後，舊狀態沒重設（舊沙盒繼續跑、舊 manifest 快取、已讀 gate、已分配角色） | pack 安裝與沙盒、adapter、pool 分配 | 測「先註冊後安裝、換版本、移除、重啟」序列後的實際狀態，不只測初次安裝 | spec-3-2-pack-import-core VG1；spec-3-5-sandbox-chain B1、E1；spec-3-4-pool-assignment B1、E2；spec-2-6-jsonl-adapter-core VG2；spec-2-6-gemini-cli-adapter VG1 |
| RP-04 | 一個動作拆成多個 StageView 增量，中間有新舊不一致的 rev；批次整批驗證時一個壞區段拖垮合法區段 | StageView 增量、settings/packs/actors 發佈 | 把相關增量包進同一批次；測批次中丟例外時只發一個增量、中間 rev 的跨區段一致性 | spec-3-4-pool-assignment VO1、E1；spec-3-6-effective-params B1、B2、B3、E1；retro R10 |

## B. 失敗路徑與例外

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-05 | 例外後旗標或在途標記沒復原（`sending` 卡 true、`synced` 沒設、`reloadWhenGone` 殘留、frame 在途標記不清），之後功能永久失效 | 控制器、sandbox host、crash 恢復 | 復原寫在 `finally`；對每個旗標測「丟例外後仍可再次操作」 | spec-2-8-session-release E6；spec-3-4-pool-assignment B2；spec-3-6-stability B3、E2、VG3；spec-3-6-tick-and-draw B7、VG3；spec-3-6-effective-params B6 |
| RP-06 | 錯誤只記 log，不改健康狀態、不計次、不重試，或被靜默略過；畫面停在「載入中」「空白」「ok」 | adapter 健康、沙盒載入、canvas 重建 | 注入失敗，同時斷言健康／狀態、log、重試計數三者都有變化 | spec-2-4-claude-code-transcript B5、B6、E3、E16；spec-2-6-gemini-cli-adapter B2、E2；spec-3-6-stability B2；spec-3-5-sandbox-chain B2、E1 |
| RP-07 | 外部輸入、來源回呼或子行程丟例外、永不結束、無逾時，未被包住 | IPC handler、schema `safeParse`、adapter 回呼、spawn | 回呼注入 throw 與永不 resolve，斷言有逾時與錯誤碼、不 reject | spec-1-3-shared-contracts-ipc-ci E1、E2；spec-2-6-jsonl-adapter-core E1～E4；spec-1-2-sandbox-prototype-gate B10、E1～E3 |

## C. 持久化與資源釋放

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-08 | 持久化與啟動清理不安全：缺 fsync、BOM、資料夾被刪；索引缺失或讀不到時被當權威而刪光；回復途中失敗讓舊版永久遺失 | settings 與 pack 寫檔、`persist/`、啟動清理 | 注入「索引不存在、讀不到、資料夾被刪、回復中刪除失敗」，斷言不刪資料；寫檔用 `flush: true` | spec-1-4-settings-stageview-run-log B2、E5、E6；spec-3-2-pack-import-core VG2、B8、B6、E9、E12；spec-2-8-session-release B8；epic-2-retro F1 |

## D. 上限與限速

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-09 | 外來輸入的數量、深度、長度沒有上限（zip 條目、路徑段、名稱、draw 集合、version 位數），或上限寫了卻沒有邊界測試 | pack 匯入、pack-api schema、draw 解析 | 每個新集合或字串欄位都要有上限常數；補「剛好等於」與「超過一」兩個案例 | spec-3-2-pack-import-core B1、E3、E4、VG3；spec-3-1-pack-api-contract E3、B12；spec-3-6-tick-and-draw B6 |
| RP-10 | 上限只算單次輸入，不含殘留或在途項（淡出中的發射器、無人消費的 events、port 前的 outbox），造成無上限累積 | particles、tick 的 events、sandbox outbox | 連續送 N 格（每格換 id、或長時間無消費），斷言容器與記憶體量有界 | spec-3-6-particles B1、E1；spec-3-6-tick-and-draw B1；spec-3-5-sandbox-chain B5 |
| RP-11 | 輪詢或 render loop 沒限速；被限速的分支沒清在途標記 | overlay render loop、draw 節拍 | 斷言 `maxFPS`（等於 `TICK_HZ`）；測「被限速的 draw」之後包仍收得到下一個 frame | spec-3-6-tick-and-draw B5、VG3 |

## E. 時間與計時器

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-12 | 時鐘來源問題：浮點在 `start+d` 邊界、`Date.now` 跳動或倒退、睡眠期間 `performance.now` 不前進、`deltaMS` 與 `deltaTime` 單位混用 | reducer 計時、Dock 延遲隱藏、particles 時間 | 用注入時鐘測恰好等於期限、時鐘倒退與跳變；以測試釘住單位 | spec-2-1-detection-event-contract-reducer E1、E11；spec-1-5-tray-entry-panel-window E6；spec-2-2-session-lifecycle-replay B4、E6；spec-3-6-particles VG2；spec-epic-2-retro-closeout B1 |
| RP-13 | 事件到達順序與時間戳假設：補讀晚於即時事件、逾時後的事件仍併進舊條件、`ts` 回推與即時收到時間混用、重送相同內容被當舊行 | detection sessions、JSONL adapter 補讀 | 做「補讀先到、後到、逾時後到」的交錯矩陣；測資的 `ts` 不要一律等於當下 | spec-2-2-session-lifecycle-replay VG1、VG-O1、E4；spec-2-7-cursor-adapter E1、B1、VG-O2；spec-2-6-gemini-cli-adapter B5 |

## F. 測試驗不到真的行為

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-14 | 接線只寫在 `main.ts`、`App.tsx`、overlay `main.ts`，沒有測試跑到；刪掉該行全部測試仍綠 | main/overlay 接線、React 面板 | 每條新接線至少一個「拿掉該行就變紅」的測試；UI 邏輯抽成純函式或控制器再測 | spec-1-4-settings-stageview-run-log VG1、VG2、B11；spec-1-5-tray-entry-panel-window VG1、VG3、B7；spec-3-6-stability VG1、VG2；spec-epic-2-demo-square-shell VG1、B8；spec-3-3-pack-list VG1、B10；spec-3-2-pack-import-entry VG1；spec-1-3-shared-contracts-ipc-ci VG1；retro R7、R8 |
| RP-15 | 驗證用的值來自模擬或計數，不是真實輸出（e2e 讀模擬的 dataset、pixi 沒畫、沙盒只比字串或手寫 details） | e2e、pixi-stage、sandbox 正向對照 | e2e 斷言取自真實渲染或真實請求路徑；至少一個案例走完整鏈（Worker 字串、webRequest） | spec-3-6-particles VG1；spec-3-6-tick-and-draw VG1、B9、VG5；spec-3-5-sandbox-security VG1、B9；spec-3-5-sandbox-chain B10 |
| RP-16 | 斷言空洞：預設值等於新值、斷言對象是已排好序的 fixture、被斷言的項目本來就不存在、速率過大分辨不出上限 | params、list、particles、reducer 測試 | 測試資料取「換不出就會退回預設」的值；先確認前提成立再斷言消失；做突變自檢 | spec-3-1-contract-pack VG1、VG2、VO1；spec-3-3-pack-list B9、B7；spec-3-6-particles B5、VG3；spec-1-5-tray-entry-panel-window B11；spec-2-1-detection-event-contract-reducer VG1、VG2 |
| RP-17 | 新增的 depcruise 或 lint 規則沒有反向測試（違規 fixture），或警告不擋 CI | `.dependency-cruiser.cjs`、`guard-rules.test.ts`、lint 腳本 | `RULES` 條數須等於設定檔條數；每條規則有一個違規 fixture 會失敗；lint 加 `--deny-warnings` | spec-1-1-forge-project-scaffold VG3；spec-1-3-shared-contracts-ipc-ci VG2、B12；spec-2-6-jsonl-adapter-core VG1；spec-3-1-pack-api-contract VG1、B1；spec-epic-1-retro-closeout VG1、B11 |
| RP-18 | e2e 與 CI 不穩：撿到上一個測試殘留的 log、外層逾時比內層短、`if: failure()` 在逾時時不上傳 artifact、Windows 路徑與檔案鎖 | `test/e2e`、`.github` workflow | 斷言「行數增量」而非「出現過」；外層逾時大於內層總和；artifact 用 `always()`；路徑正規化 | spec-3-6-stability B9；spec-3-5-sandbox-security B14、E4、E5、B11、E3；spec-3-5-sandbox-chain E6 |

## G. 輸入驗證與安全

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-19 | 入口檢查與下游實際解析不一致：路徑正規化、大小寫、Windows 保留名、URL 主機正規化、SES 禁字串、bidi 控制字元 | pack manifest、pack 匯入、`pack://` | 對抗樣本表（`con.png`、`sub//x.png`、`entry.jſ`、純數字包 id、U+202E）同時跑檢查器與真實下游 | spec-3-1-pack-api-contract E1、B2、B3、E4；spec-3-2-pack-import-core B2、E1、B3、E6、B4、B12；spec-3-1-contract-pack E14～E16；spec-3-2-pack-import-entry B1 |
| RP-20 | 安全預設沒明寫或沒被鎖住：Electron 預設選單與權限檢查、webview、打包版 DevTools、dev 放行規則、vm realm 逃逸、log 寫入 error.message 或路徑 | windows 建立、session 防護、沙盒、run log | 明寫設定並加反向案例；沙盒用探針驗逃逸；log 只寫代碼，不寫原始訊息與路徑 | spec-1-5-tray-entry-panel-window B2、B3、B4；spec-1-1-forge-project-scaffold B13a、E2；spec-1-3-shared-contracts-ipc-ci B2、B3、B4；spec-3-1-contract-pack E19；spec-3-5-sandbox-security B5、E6；spec-1-4-settings-stageview-run-log B7 |

## H. 平台與外部依賴

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-21 | 只在 macOS 實測，Windows 行為（保留名、DPI、Alt+Tab、工作列、檔案鎖、路徑分隔）靠推測 | windows、pack 路徑、e2e 建置 | 平台差異點在 CI 的 windows-latest 跑，或在 spec 明列「未實測」 | spec-1-2-sandbox-prototype-gate B15；spec-1-6-transparent-canvas B12、B5；spec-1-5-tray-entry-panel-window B13；spec-3-1-pack-api-contract B2；spec-3-5-sandbox-security E3 |
| RP-22 | 外部函式庫或檔案系統的真實行為沒實測（chokidar 節流與 symlink、資料夾缺席、預設 stat、pixi 在 node） | JSONL adapter、project-name 反查、watcher | 至少一個用真實 chokidar 與預設 stat 的整合案例，涵蓋 ready 後事件、資料夾後建、symlink | spec-2-4-claude-code-transcript VG2、B7、VG-O1、E14；spec-2-6-gemini-cli-adapter D1；spec-2-7-cursor-adapter VG1、B5 |

## I. overlay 輸入與 UI

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-23 | hit area 與實際繪製不一致：未繪製或空 draw 仍接住滑鼠；選單關閉、overlay 卡住時仍不穿透；被工作列或 Dock 蓋住 | overlay scene、canvas-input、右鍵選單 | 斷言「hit area 數」等於實際繪製的 actor 數；overlay 無回應時回到穿透；測選單關閉後的狀態 | spec-epic-2-demo-square-shell B1、B2、B3、E7；spec-3-6-tick-and-draw B3 |
| RP-24 | UI 可存取性不足：按鈕名稱沒帶對象、對比度不足 | panels 的 session 列、pack 清單、狀態色 | 無障礙名稱含對象名；狀態色的對比度用計算值測 | spec-2-8-session-release B10；spec-3-3-pack-list B8；spec-epic-2-demo-square-shell B7 |

## J. 文件與實作不一致

| ID | 模式 | 常見位置 | 事先要補的測試或檢查 | 出處 |
|---|---|---|---|---|
| RP-25 | 註解、常數說明、測試標題、作者文件與實際行為不符（過時、寫太肯定、範例錯誤） | `src/` 註解、`docs/pack-api-v1.md`、測試檔頭 | 改行為的同一個變更內，grep 該函式或常數名在註解、文件、測試標題的出現處並更新 | spec-2-1-detection-event-contract-reducer B7、E5；spec-2-2-inference B5、B6；spec-2-6-turn-end-inference B10a、B4；spec-2-7-cursor-adapter B4、E9；spec-3-6-stability B7、B15；spec-3-6-tick-and-draw B2；spec-3-1-contract-pack B18、B11 |
| RP-26 | 需求、驗收、deferred-work 沒跟著更新（已解決沒標、需求文件仍寫舊行為） | `epics.md`、`SPEC.md`、`epic-*-acceptance.md`、`deferred-work.md` | story 收尾逐條對照 deferred-work 標「已解決」，並檢查 epics 與驗收條目 | spec-epic-1-retro-closeout B6、B7；spec-1-3-shared-contracts-ipc-ci B8、B10；spec-1-4-settings-stageview-run-log B13b；spec-1-5-tray-entry-panel-window B8b；spec-3-2-pack-import-entry B6；spec-3-4-pool-assignment B5；spec-3-6-effective-params B8 |
| RP-27 | 顯示字串或型別重複定義，或平台用語寫死（選單列 vs 系統匣） | `shared/constants`、menu、panels 文案 | 中文顯示名與型別只定義一處；文案測試涵蓋兩個平台分支 | spec-1-5-tray-entry-panel-window B12a；spec-2-3-demo-sessions-panel B7、B8；spec-2-6-turn-end-inference VG2；spec-epic-2-demo-square-shell B12 |
