---
title: 'Story 1.4：可靠的設定、StageView 與運行紀錄'
type: 'feature'
created: '2026-11-05'
status: 'done'
baseline_commit: 'c938ea4e009010420b2c70ca5e1c895a0b170497'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 舞台還沒有任何持久設定與運行紀錄。設定檔壞掉時怎麼處理沒有規則，出問題時也沒有紀錄可查；renderer 也還沒有從 main 取得狀態的管道。

**Approach:** 建立三個 main 模組，再加上 panels preload 的訂閱：
- `main/log`：運行紀錄，每小時一檔，保留 24 小時。
- `main/settings`：讀取 `settings.json`、保護壞檔、遷移框架、`settings:get` 與 `settings:patch`，寫入用 temp＋rename 並延遲落地。
- `main/stage-view`：組合設定，推送帶 `rev` 的快照與增量。

設定目前只有一欄「畫布所在螢幕」（`canvasDisplayId`），給 Story 1.6 用。

## Boundaries & Constraints

**Always:**
- 設定與 StageView 的 schema、invoke 契約、推送契約，都只在 `src/shared` 定義。收到資料就嚴格驗證：main 驗證收到的 patch，preload 驗證收到的快照與增量。
- 只有 main 寫檔。`settings.json` 只由 `main/settings` 寫，`logs/` 只由 `main/log` 寫。設定一律先寫 temp 再 rename。
- 原檔沒保住就不寫。如果壞檔改名、備份或讀檔失敗，這次執行就不寫 `settings.json`，只記紀錄。
- 設定 IPC 只有 `settings:get` 和 `settings:patch`。patch 由欄位操作組成，對目前的值逐欄套用，同一欄位後到者勝。`baseRev` 只用來回報這次是否合併過。
- patch 立即反映到 StageView。落地會合併：從第一筆未落地的變更起算，`SETTINGS_FLUSH_DEBOUNCE_MS` 後寫一次。app 結束前，同步寫完所有未落地的變更。
- 運行紀錄寫入不會丟出例外。寫不了的時候只印到 console。紀錄只寫欄位名和原因，不寫設定值，也不寫檔案內容。
- main 往 renderer 只推 StageView 增量，而且只經一個推送函式。送出前先驗證 payload，並確認對方的頂層框架仍是允許的來源。

**Never:**
- 不做 Story 1.5、1.6 的範圍：單一實例、視窗、選單、`app://`、畫布，以及實際套用「畫布所在螢幕」。
- 面板不改成 React。
- overlay preload 不加 API。
- 不做整份覆寫設定的 IPC。
- 不動 `prototypes/`。
- 不連網。
- 不執行任何 git 指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 沒有設定檔 | 首次啟動 | 用預設值；不建檔、不備份 | — |
| 整檔壞掉 | 不是 JSON、不是物件，或 `schemaVersion` 缺少、不是正整數 | 改名為 `settings.json.broken-<時間>`，記一行，用預設值正常啟動 | 改名失敗：記一行，這次不寫設定檔 |
| 無法遷移 | `schemaVersion` 大於目前版本，或遷移函式丟錯 | 同「整檔壞掉」 | 同「整檔壞掉」 |
| 單一欄位錯 | 某一欄型別錯，或有不認得的欄位 | 只有那一欄用預設值，不認得的欄位丟掉；原檔複製一份 `broken-<時間>`，記一行並列出欄位名，再寫回修正後的檔 | 複製失敗：記一行，這次不寫設定檔 |
| 缺欄位 | 舊檔少了新欄位 | 該欄用預設值，不算錯、不備份 | — |
| 讀檔失敗 | 檔案存在但讀不到（例如權限） | 用預設值，記一行，這次不寫設定檔 | — |
| patch 正常 | `baseRev` 等於目前的 rev | 套用、rev＋1，StageView 推一個增量，回傳 `{ rev, merged: false }` | — |
| patch 過舊 | `baseRev` 小於目前的 rev | 逐欄套用到目前的值，回傳 `{ rev, merged: true }` | `baseRev` 大於目前的 rev 時，同樣處理並記一行警告 |
| patch 沒有改變 | 設成相同的值 | 不加 rev、不推送、不寫檔，回傳目前的 rev | — |
| patch 不合法 | 未知欄位、值型別錯、沒有任何操作 | `invalid-input`，設定不變 | — |
| 連續 patch | 落地等待時間內有多筆 | 只寫一次檔 | 寫檔失敗：記一行、刪掉 temp、保留記憶體中的值，下一次落地時重試 |
| 結束 app | 還有未落地的變更 | 同步寫完再結束 | 失敗只記紀錄 |
| 訂閱 | renderer 訂閱 StageView | 先收到含 `rev` 的快照，之後收到連號的增量 | — |
| 增量不連號或格式錯 | 漏收或資料壞掉 | preload 重拿快照；listener 只會看到一致的狀態 | console.error |
| renderer 重載 | 再訂閱一次 | 拿到新的快照；main 不會重複登記同一個 webContents | — |
| 推送對象失效 | webContents 已銷毀，或頂層框架已不是允許的來源 | 不送出；已銷毀的移出訂閱名單 | — |
| 紀錄跨小時 | 新的一小時寫第一筆 | 寫到新檔，並刪除開始時間超過 24 小時的紀錄檔（只刪符合檔名格式的檔） | 刪不掉就略過 |

</frozen-after-approval>

## Code Map

- `src/main/main.ts`
  - 目前有 preload 檢查、`registerIpcHandler(appGetVersion)` 和模板視窗。
  - 在這裡初始化 log、載入設定、建 StageView、註冊新的 handler，並在 `will-quit` 落地。
  - 視窗部分不要動，Story 1.5 會重寫。
- `src/main/ipc/register.ts`
  - 唯一的註冊函式；handler 收得到 `event`，訂閱要用 `event.sender`。
  - 拒絕和錯誤目前用 console 記。改走 `main/log`，但仍要輸出到 console，因為 `test/main/ipc-register.test.ts` 有 spy `console.warn`／`console.error`。
  - `isAllowedSenderUrl`、`devServerOrigin` 是私有函式，推送也要用，所以抽出來共用。
- `src/shared/ipc.ts`
  - 有 `IpcContract`、`parseIpcResult`、`ipcFailure`、`isIpcChannelName`。
  - 新的契約加在檔尾的 Channels 區。
- `src/shared/constants.ts`：運行常數的唯一位置。`src/shared/preload-api.ts`：`PanelsApi` 的型別。
- `src/preload/invoke.ts`：preload 唯一的 invoke 入口，不會 reject。`src/preload/panels.ts`：用 `Object.freeze` 暴露 API。
- `.oxlintrc.json`
  - `ipcRenderer` 目前只准在 `src/preload/invoke.ts` 用。
  - 同一條規則若有後面的 override，會整份取代前面的設定（檔頭註解有寫），所以每個 override 都要列完整清單。
- `test/helpers/fake-electron.ts`
  - 模擬 invoke 往返，目前沒有推送。
  - 要加 `ipcRenderer.on`，並讓事件帶 `sender`：`id`、`send`、`isDestroyed`、`once('destroyed')`、`mainFrame.url`。
- `test/tooling/guard-rules.test.ts`：每條防護規則的反向測試。允許清單改了，這裡要同步改。
- 測試慣例：每個 schema 都要有往返與拒絕測試，參考 `test/shared/schema-helpers.ts`。檔案相關的測試在 `os.tmpdir()` 底下建暫存目錄，不碰真的 userData。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/constants.ts`：加 `SETTINGS_FLUSH_DEBOUNCE_MS`（500）、`RUN_LOG_RETENTION_MS`（24 小時）、`RUN_LOG_MAX_LINE_LENGTH`（4000 字元）。理由：運行常數只放一處。
- [x] `src/shared/settings.ts`：理由：設定契約只有這一份。
  - `SETTINGS_SCHEMA_VERSION = 1`。
  - 每一欄的 schema 和預設值：`canvasDisplayId` 是非負整數或 null，預設 null（主螢幕）。
  - 完整設定的 schema。
  - patch 的 schema：`{ baseRev, ops }`，`ops` 是 1～64 筆 `{ op: 'set', field, value }`，依欄位產生，值用該欄的 schema 驗證。
  - patch 回應的 schema：`{ rev, merged }`。
- [x] `src/shared/stage-view.ts`：StageView 的 schema（目前只有 `settings: { rev, values }`）、快照 `{ rev, view }`、增量 `{ rev, sections }`。增量裡出現的區段整段取代，至少要有一個區段。
- [x] `src/shared/ipc.ts`：理由：關掉 Story 1.3 延後的 B6（推送契約）。
  - 新增推送契約型別：`channel` 加 `payload` schema，通道名規則同 invoke。
  - invoke 契約：`settings:get`、`settings:patch`（input `[patch]`）、`stage-view:subscribe`（output 是快照）。
  - 推送契約：`stage-view:delta`。
- [x] `src/main/log/run-log.ts`：理由：FR22。
  - 提供 `createRunLog({ dir, now, fs? })`，以及模組層級的 `initRunLog(dir)`、`logEvent(category, message, consoleLevel?)`。
  - 檔名用本地時間 `YYYY-MM-DD-HH.log`。
  - 每行格式：`<本地時間 ISO，含時差>\t<類別>\t<內容>`，類別是英文代碼（如 `app`、`settings`、`ipc`）；內容中的換行與 tab 要跳脫，並截到長度上限。
  - 同步 append。開新檔時清理舊檔。
  - 每筆都輸出到 console；還沒初始化或寫入失敗時，只輸出到 console。
- [x] `src/main/settings/store.ts`、`src/main/settings/migrations.ts`：理由：FR23、AD-23。
  - 讀檔流程照 I/O 矩陣。
  - 遷移表：目前是空的，每一項是 n→n+1 的函式。
  - patch 套用、rev、變更通知、延遲落地、`flushSync()`。
  - 用同步 fs。fs、時鐘、遷移表都可以注入，給測試用。
- [x] `src/main/settings/ipc.ts`：註冊 `settings:get`、`settings:patch`。
- [x] `src/main/ipc/origin.ts`、`src/main/ipc/push.ts`：理由：推送與 invoke 共用同一份來源規則。
  - `origin.ts`：從 register.ts 抽出的來源判斷。
  - `push.ts`：唯一的推送函式，用契約驗證 payload，檢查 `isDestroyed()` 和 `mainFrame.url` 後才 `send`。
  - lint 擋不住 `webContents.send`，在檔內註明。
- [x] `src/main/ipc/register.ts`：改用 `origin.ts`，記錄改走 `logEvent('ipc', …)`。
- [x] `src/main/stage-view/stage-view.ts`：理由：AD-20。
  - 從設定組合 StageView，維護它自己的 rev。
  - 每次設定變更就推一個增量。
  - 維護訂閱名單：以 webContents id 為 key，銷毀時移除。
  - 提供 `stage-view:subscribe` 的 handler。
- [x] `src/main/main.ts`：理由：AC。
  - 啟動順序：`initRunLog(userData/logs)` → 記一行 `app` 啟動（版本、平台、arch、是否打包）→ 載入設定 → 建 StageView → 註冊 handler → 開視窗。
  - `will-quit` 時 `flushSync()`，並記一行結束。
- [x] `src/preload/stage-view.ts`：理由：AD-20。
  - 所有 listener 共用一個訂閱。
  - 拿到快照前收到的增量先暫存；丟掉 rev 小於等於快照 rev 的增量。
  - 增量不連號或驗證失敗就重拿快照。
  - 回傳取消訂閱的函式。
- [x] `src/preload/panels.ts`、`src/shared/preload-api.ts`：暴露 `settings.get()`、`settings.patch(patch)`、`stageView.subscribe(listener, onError?)`。
- [x] `src/panels/renderer.ts`：多顯示一行「StageView rev N｜畫布螢幕：主螢幕／<id>」。理由：手動驗證整條管道。
- [x] `.oxlintrc.json`、`test/tooling/guard-rules.test.ts`：允許用 `ipcRenderer` 的檔案加上 `src/preload/stage-view.ts`（要有它自己的完整 override），反向測試同步更新。
- [x] 測試：理由：I/O 矩陣每一列都要有對應的測試。
  - 新增 `test/shared/settings.test.ts`、`test/shared/stage-view.test.ts`、`test/main/run-log.test.ts`、`test/main/settings-store.test.ts`、`test/main/stage-view.test.ts`、`test/preload/stage-view.test.ts`。
  - 擴充 `test/helpers/fake-electron.ts`。
  - 在 `test/preload/panels.test.ts` 加一個從 patch 到 listener 的往返測試。
  - 計時用 fake timers。

**Acceptance Criteria:**
- Given 完成實作，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過，且 I/O 矩陣每一列都有對應測試。
- Given panels 往返測試（fake electron），when 經 `window.awp.settings.patch` 改 `canvasDisplayId`，then listener 收到新值，StageView rev 加 1，且 patch 回傳的 rev 等於 StageView 中的 `settings.rev`。
- Given 執行 `npm start`，when 視窗開出來，then：
  - 頁面顯示 StageView rev 和「主螢幕」；
  - `userData/logs/` 有目前這個小時的紀錄檔，裡面有啟動那一行；
  - 確認後立刻關閉。

## Implementation Notes

- 四項檢查實際通過：`npm run typecheck`（兩份 tsconfig）、`npm run lint`、`npm test`（14 個檔、393 個測試）、`npm run depcruise`（72 個模組無違規）。I/O 矩陣每一列都有對應測試；「結束 app」那列由 `flushSync` 的測試涵蓋，`main.ts` 的 `will-quit` 接線沒有單元測試。
- `npm start`：以 `--remote-debugging-port` 啟動、從本機 DevTools 讀頁面文字（未截圖），頁面顯示「版本 1.0.0」與「StageView rev 0｜畫布螢幕：主螢幕」；`userData/logs/2026-11-05-17.log` 有 `app start`、`stage-view webContents 1 subscribed at rev 0`、`app quit` 三行；沒有 patch，所以沒有建立 `settings.json`。
- spec 以外的決定：`SETTINGS_PATCH_MAX_OPS` 放在 `shared/settings.ts`（契約的一部分）；`loadSettings` 可注入 `schemaVersion`，讓遷移失敗在 store 層測得到；只遷移、沒有欄位錯時不立即寫回，等下一次寫檔；紀錄另外跳脫其他控制字元與 U+2028／2029，截斷時加 `…[truncated]`、不切斷 surrogate pair；紀錄寫不了時 console 每段連續失敗只提示一次；IPC handler 失敗記 error 的 name 加 message，檔案相關只記 error code；寫檔失敗不自動排重試，等下一次 patch 或結束時的 `flushSync`；推送遇到來源不允許的 webContents 只略過、不移出名單；快照拿取失敗通知 `onError`，等下一個增量再重試。新增 `src/main/log/local-time.ts` 與 `test/main/ipc-push.test.ts`。
- 開發代理違反「不執行任何 git 指令」一次：跑了唯讀的 `git diff --stat` 與 `git status --short`。
- 本 story 處理了 Story 1.3 延後的 B6（main→renderer 推送契約）。
- 審查修補（第 1 輪，未觸發 loopback）：`will-quit` 落地抽成 `flushSettingsOnQuit(app, store)` 並補測試（`app quit` 那行仍在落地之後）；`register.ts` 移除 `errorSummary`，handler 失敗只記 error code，測試改為檢查紀錄檔內容；`writeFileSync` 加 `flush: true`；讀設定前去掉開頭的 UTF-8 BOM；紀錄寫入失敗時清掉 `currentFile`，資料夾被刪後下一筆起恢復（刪除後的第一筆仍會失敗）；preload 在快照通知後再檢查一次 generation；補上 DEL／C1／U+2029 跳脫、遷移後又有欄位錯、resync 快照失敗三項測試。
- 修補後重跑：typecheck、lint、`npm test`（14 個檔、400 個測試）、depcruise 全部通過。`npm start` 重跑：運行紀錄依序有 `app start`、`stage-view webContents 1 subscribed at rev 0`、`app quit`，Electron 已正常結束。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 main.ts 的 will-quit 落地與啟動順序沒有任何測試執行 | medium | patch | 預檢後送來的缺口：刪掉 `main.ts` 的 `settings.flushSync()` 全部測試仍通過；`flushSync` 在 `src/` 唯一的呼叫點就是 `will-quit`。把掛 `will-quit` 的動作抽成 store 旁可測的函式並補測試；啟動順序留手動檢查。 |
| VG2 register.ts 改寫進運行紀錄沒有測試 | medium | patch | 預檢後送來的缺口：`ipc-register.test.ts` 只 spy console，把 `logEvent` 改回 `console.warn` 測試仍過；補一個 sender 被拒、一個 handler 失敗寫進紀錄檔的斷言。 |
| B11 main.ts 的接線沒有測試、panels 測試另寫一份接線 | medium | patch | 與 VG1 同一根因；`will-quit` 掛勾抽出後由同一個測試涵蓋，panels 測試的手寫接線不另行合併。 |
| B1 遷移成功後第一次寫檔沒有先備份舊版原檔 | low | reject | 目前 `SETTINGS_SCHEMA_VERSION` 是 1、遷移表是空的，沒有人會走到；降版時新版檔會被改名保留而不是遺失；要加備份分支是新增複雜度。 |
| B2 temp＋rename 前沒有 fsync | low | patch | `writeNow` 只 `writeFileSync` 就 rename，斷電時可能留下 0 byte 的 `settings.json`；Node 24 的 `writeFileSync` 支援 `flush: true`，一個選項即可。 |
| B3／E4 落地寫檔失敗後只在下一次 patch 或結束時重試 | low | reject | 符合矩陣「下一次落地時重試」；記憶體值在結束時仍會 `flushSync`，只有中途當機才遺失；改成自動重試需要退避，否則持續失敗會每 500ms 記一行。 |
| B4 canWrite 為 false 時 renderer 不知道設定不會保存 | low | reject | 凍結的 intent 明定這種情況「只記紀錄」；面板提示屬於新需求。 |
| B5 快照拿取失敗或推送失敗後只能等下一個增量恢復 | low | reject | subscribe 失敗多半是永久性的（sender 被拒），重試幫不上；`send` 丟錯極少見；加退避重試是新增複雜度。 |
| B6 紀錄檔沒有嚴重程度欄位 | low | reject | 每行格式「時間、類別、內容」由 epic AC 與 spec 定死；修正要改 spec。 |
| B7／E8／VG 其他 errorSummary 把 error.message 寫進紀錄檔 | medium | patch | `register.ts` 的 `errorSummary` 寫入 `error.message`，與 `errorCode` 自己的註解衝突；之後的 handler（例如解析 manifest）丟出的 SyntaxError 會引用檔案內容、fs 錯誤會帶使用者路徑；改成只記 `errorCode`。sender 被拒時記完整 URL 保留，診斷需要。 |
| B8／E1 Squirrel 安裝事件路徑現在也會初始化紀錄與設定 | low | defer | `if (started) app.quit()` 不會中止模組執行，安裝／解除安裝時也會 `initRunLog`、`loadSettings`；Squirrel 處理已排在 Story 1.5，屆時要一併跳過這些初始化。 |
| B9／E2 dev 與打包版共用 userData、沒有單一實例鎖，兩個行程會互相覆寫設定 | low | reject | 單一實例鎖已排在 Story 1.5；同時跑 dev 和打包版只發生在開發時；共用 userData 是 Design Notes 已接受的決定。 |
| B10 一檔一擁有者與唯一推送點只靠慣例 | low | reject | 之後 `main/pool`、`main/packs` 也要用 fs，限制 `node:fs` 的規則每個 story 都得改；目前沒有違反。 |
| B12 運行紀錄沒有大小上限或限速 | low | reject | Epic 1 只有設定變更與 IPC 錯誤會寫紀錄，量很低；限速是新增複雜度，角色包的 `stage.log` 限速由 AD-16 處理。 |
| B13a spec 與 sprint-status 狀態不一致 | false | reject | step-05 會把 story 設為 `review`。 |
| B13b deferred-work 的 B6、B7、CI 條目過時 | low | patch | B6 已由本 story 解決、B7 的來源判斷已搬到 `src/main/ipc/origin.ts`、CI 條目有兩句；直接註記。 |
| B14 部分宣稱的行為沒有測試 | low | patch | 只補三項：DEL／C1／U+2029 跳脫、遷移後又有欄位錯的組合、resync 時快照失敗要保留舊狀態並通知 onError；備份名稱用完、舊 temp 檔、失敗後恢復再失敗的提示不補。 |
| E3 Windows 關機或登出時沒有 will-quit | low | reject | 要在設定改動後 500ms 內關機才會遺失；處理要掛視窗的 `session-end`，而視窗由 Story 1.5 重寫。 |
| E5 帶 UTF-8 BOM 的設定檔被當成壞檔 | low | patch | `JSON.parse` 遇到開頭的 BOM 會丟錯，用記事本存檔的合法設定會被改名、重設；去掉開頭 BOM 是一行修正。 |
| E6 紀錄資料夾被刪掉後，這個小時都寫不進檔 | low | patch | `currentFile` 在寫入成功後才設定，之後資料夾消失時不會再 `mkdirSync`；寫入失敗時清掉 `currentFile` 即可。 |
| E7 最後一個 listener 在快照通知中取消時，暫存的增量會觸發沒人用的訂閱 | low | patch | `fetchSnapshot` 在 `notify` 後直接處理暫存增量，`current` 已被清成 null，會再發一次 subscribe 並留下過期快照給下一個訂閱者；`notify` 後再檢查一次 generation 即可。 |

## Design Notes

**同步 fs：** 設定檔很小，紀錄量也低，所以用同步 fs。好處是順序固定、不需要排隊，結束前的落地也只要直接呼叫。

**patch 與增量範例：**
```json
{ "baseRev": 3, "ops": [{ "op": "set", "field": "canvasDisplayId", "value": 69733632 }] }
{ "rev": 8, "sections": { "settings": { "rev": 4, "values": { "canvasDisplayId": 69733632 } } } }
```

**兩個 rev 分開：** 設定的 rev 和 StageView 的 rev 是兩個計數器。每次執行都從 0 開始，只存在記憶體裡；main 重啟後，renderer 本來就會重新訂閱。之後的 story 可以替 actors 改成更細的增量，現在先整段取代。

**單欄修正後立刻寫回：** 備份完就寫回修正後的檔，否則每次啟動都會再產生一份備份。

**時間格式：**
- 紀錄檔名用本地小時。
- 備份的時間後綴是本地 `YYYYMMDD-HHmmss`；同一秒撞名時加 `-2`、`-3`。
- 夏令時間切換的那一小時會寫進同一個檔，可以接受。

**dev 與打包版共用 userData：** `npm start` 和打包版用同一個 `AI Watchdog Pet` 資料夾，所以 `npm start` 會寫進真的 `logs/`。

## Verification

**Commands:**
- `npm run typecheck`：expected 兩個 tsconfig 都沒有錯誤。
- `npm run lint`：expected 沒有錯誤。
- `npm test`：expected 全部通過。
- `npm run depcruise`：expected 沒有違規。
- `npm start`：expected 頁面顯示 StageView rev 和「主螢幕」，`userData/logs/` 有啟動那一行。確認後立刻關閉。
