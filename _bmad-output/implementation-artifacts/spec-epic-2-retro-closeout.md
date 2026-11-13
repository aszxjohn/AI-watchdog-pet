---
title: 'Epic 2 收尾（回顧行動項目 B1～B4）'
type: 'bugfix'
created: '2026-11-13'
baseline_commit: '49078717460e335413091adb06c2e25d42eefc9b'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-retro-2026-11-13.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 2 回顧找到幾個跨 story 的問題：
- F1：啟動同步逾時，或某個轉接器啟動失敗時，pool 清理會刪掉那個來源已存的釋放紀錄。
- F3：Claude Code 重開補讀時，subagent 檔尾懸空的工具會重新打開已結束的一輪，顯示假的「要你批准（推測）」。
- F6：「管理 session」依名稱排序，名稱在執行中會改變，列會跳動。
- F7：兩處註解與實作不符，pool 借用了名為 settings 的結束 helper。

**Approach:** 四項各自修正，合成一個收尾 story，在 Epic 3 之前做（使用者 2026-11-13 於回顧決定）。

**Decisions（2026-11-13）：**
- B1：沒有確認的來源不清理。這包括同步逾時時還沒送 `sync.ready` 的來源，以及啟動失敗的來源。啟動失敗的轉接器不再讓同步等到逾時。
- B2：一律在判斷層處理，轉接器的補讀順序不變。規則是：某筆會被 `turn.end` 關掉的事件（`tool.start`、`approval.request`、`question.request`），如果日期早於該 session 最後一次 `turn.end`（補讀的也算），就不再開啟。
- B3：排序改成先依來源，再依首次出現的順序（StageView `sessions` 本來的順序）。新 session 排在同來源的最後；名稱、狀態改變或釋放時，列都不動。
- B4：`flushSettingsOnQuit` 改名為 `flushOnQuit`，移到 `main/persist`。

## Boundaries & Constraints

**Always:**
- session key 拆出來源的函式放在 `src/shared/detection-events.ts`。pool 用它；`menu.ts`、`session-rows.ts` 的自寫拆法也改用它，輸出不變。
- log 只寫計數與來源代碼，不寫 key 或路徑。沒有未確認來源時，既有的 log 文字完全不變。
- 既有測試的斷言只在行為本來就要改的地方調整（排序、新增的參數）。每處調整都要在 Implementation Notes 說明。

**Never:**
- 不改轉接器、事件契約的 schema、推測的計時規則。
- 確認過的來源，清理行為不變。
- 不處理延後的 F2、F4、F5、F8～F11。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 全部同步 | 每個轉接器都送了 `sync.ready` | 照舊：只保留被回報過的釋放紀錄 |
| 同步逾時 | `cursor` 到 `syncTimeoutMs` 還沒送 `sync.ready` | 保留所有 `cursor:*` 釋放紀錄；其他來源照舊清理；log 標出未確認的來源 |
| 啟動失敗 | `cursor` 的 `start()` 丟例外 | 同步不等它（其他都 ready 就結束，不等到逾時）；保留 `cursor:*` 釋放紀錄；健康照舊為「部分可用」 |
| 補讀順序 | 補讀先到主檔的 `turn.end`（3 分鐘前），再到 subagent 的 `tool.start`（4 分鐘前），然後 `sync.ready` | 狀態是等你回覆或休息中，不是「要你批准（推測）」 |
| 下一輪的工具 | 補讀的 `tool.start` 日期晚於上一個 `turn.end` | 照常開啟 |
| 補讀的請求 | 補讀的 `approval.request` 日期早於最後的 `turn.end` | 不開啟 |
| 即時事件 | 即時的事件順序 | 行為不變 |
| 名稱改變 | 某 session 的名稱從資料夾名變成標題 | 列的位置不變 |
| 新 session | 同來源多一個 | 排在該來源的最後 |
| 結束時寫檔 | app 結束 | 先寫 settings、再寫 pool，順序照舊 |

</frozen-after-approval>

## Code Map

- `src/main/detection/detection.ts`：
  - `DetectionSyncedListener` 改成 `(reported, unconfirmed: ReadonlySet<SourceCode>) => void`。
  - `startAdapter` 的 catch 把該轉接器從 `awaitingSync` 移出，並記為啟動失敗。`running` 不變，`stop()` 仍會呼叫它的 `stop`。
  - `settleSync` 交出逾時時仍在等的來源與啟動失敗的來源；同步結束的 log 加上啟動失敗的來源。
  - 標頭註解 `:19-20` 改成三個轉接器（`main.ts:184-191`）。
- `src/main/pool/store.ts`：`sweep(reported, unconfirmed)` 保留在 `reported` 裡、或來源在 `unconfirmed` 裡的 key；log 照 Boundaries 的規則。
- `src/main/main.ts:201-203`：`detection.onSynced(pool.sweep)` 的參數照著改；`:220-221` 改用 `flushOnQuit`。
- `src/main/detection/reducer.ts`：
  - `SessionConditions` 加一個欄位，記最後一次 `turn.end` 的時間，補讀的也記（現有的 `turnEndedAt` 補讀時不設，不能用）。
  - `tool.start`、`approval.request`、`question.request` 的日期早於它時不開啟，其他欄位照 `activity` 處理。
  - 改完後 `evaluate`、`nextChangeAt` 不變。
- `src/main/detection/sessions.ts:6-7`：註解改成「目前沒有轉接器會送行程結束的 `session.end`；2.4 狀態檔那一半做完後才有」。
- `src/shared/detection-events.ts`：新增 session key 拆出來源的函式。`src/main/windows/menu.ts:171` 的 `sourceOf` 與 `src/panels/session-rows.ts:109` 的拆法改用它。
- `src/panels/session-rows.ts:147-152`：排序改成來源加原順序（穩定排序）；檔頭註解同步更新。
- `src/main/persist/`：新增 `flushOnQuit(app, store)`，內容照 `settings/store.ts:391-398`。舊函式刪除，呼叫端與測試改名。
- 測試：
  - `test/main/detection-synced.test.ts`、`pool-store.test.ts`：逾時與啟動失敗的未確認來源、sweep 的保留。
  - `detection-reducer.test.ts`、`detection-sessions.test.ts`：補讀順序與請求。
  - `detection-claude-code.test.ts`：照驗證缺口角度的情境，主檔結束、subagent 懸空工具、補讀後狀態不是推測的批准。
  - `test/panels/session-rows.test.ts`：名稱改變、新 session。
  - `windows-main.test.ts`、`settings-store.test.ts`：改名。
  - `test/shared/`：拆來源函式的往返。

**不要改：** `src/main/detection/adapters/**`、`src/main/detection/inference.ts`、`src/preload/**`、`src/overlay/**`。

## Tasks & Acceptance

**Execution:**
- [x] `shared/detection-events.ts`、`menu.ts`、`session-rows.ts`：拆來源函式與排序（B3），加測試。
- [x] `detection.ts`、`pool/store.ts`、`main.ts`：未確認的來源（B1），加測試。
- [x] `reducer.ts`：早於最後 `turn.end` 的事件不開啟（B2），加 reducer、sessions、claude-code 測試。
- [x] `persist/`、`settings/store.ts`、`main.ts`、註解：B4。

**Acceptance Criteria:**
- Given 這次改動完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過。判斷層與轉接器的既有斷言不變；排序、sweep 參數、改名以外的既有斷言也不變。

## Implementation Notes

**實作（2026-11-13）：**
- B3：`src/shared/detection-events.ts` 新增 `splitSessionKey(key) → { source, nativeId }`（在第一個 `:` 拆開，`makeSessionKey` 的反函式）。`menu.ts` 刪掉自寫的 `sourceOf`；`session-rows.ts` 的 `nativeIdOf` 改用它，參數型別從 `string` 收緊成 `SessionKey`（唯一的 src 呼叫端本來就傳 `SessionKey`）。排序改成只比來源的穩定排序，刪掉 `compareText`。
- B1：`detection.ts` 加 `failedToStart`；`startAdapter` 的 catch 把轉接器移出 `awaitingSync` 並記入 `failedToStart`，`running` 不動。`settleSync` 依 `adapters` 順序算出 `unconfirmed`（逾時仍在等的＋啟動失敗的來源），交給 `onSynced` 的第二個參數；之後才訂閱的拿到同一個 Set。`pool/store.ts` 的 `sweep(reported, unconfirmed)` 保留在 `reported` 裡、或來源在 `unconfirmed` 裡的 key（用 `splitSessionKey`）。`unconfirmed` 是必填參數，避免呼叫端漏傳。
- B1 log（只有計數與來源代碼）：
  - detection，沒有啟動失敗時文字不變。有啟動失敗時：
    - 例如 `start-up sync over: every adapter that started sent sync.ready; failed to start: cursor; 1 sessions reported`。
    - 全部啟動失敗時為 `no adapter started; failed to start: codex; …`。
    - 逾時兼啟動失敗為 `syncTimeoutMs passed, still waiting for gemini; failed to start: cursor; …`。
  - pool，`unconfirmed` 為空時文字不變；不為空時括號內追加 `; <n> kept unreported from unconfirmed sources: cursor`。
- B2：`SessionConditions` 加 `lastTurnEndTs?: number`，照 `replyPending` 等旗標的做法「有才出現」，所以空的 conditions 和 `session.end` 後都沒有這個 key。
  - 記的是紀錄本身的日期 `event.ts`，不是回推出來的單調時間。原因：`sessions.ts` 對每筆補讀事件各讀一次整數毫秒的 `wallNow()` 和有小數的單調時鐘，同一批裡 `ts` 相同的兩筆可能被回推成相差約 1 ms，後到的那筆會被誤判為較早（Cursor 的事件常共用同一個 `ts`）。這一點是審查後修正的。
  - 非推測的 `turn.end`（即時或補讀）都會設定，取 `Math.max`（較舊的補讀 `turn.end` 晚到不會往回倒），新的 `turn.start` 不清除。
  - `tool.start`、`approval.request`、`question.request` 的 `ts` 嚴格小於它就回傳 `update({})`，和 `activity` 相同；同一個 `ts` 照常開啟。
  - `evaluate`、`nextChangeAt` 沒改，也沒讀新欄位；計時仍完全不看 `ts`。
- B2 的解讀：推測的 `turn.end` 不記入 `lastTurnEndTs`。理由有兩個：
  - 推測是舞台的猜測，不應壓過紀錄裡的事實（同 `turnEndInferred` 的「事實取代猜測」）。
  - 若記入，`detection-reducer.test.ts` 的「a guessed turn end closes the turn like a real one…」會多出一個欄位，改到判斷層的既有斷言。
  - Decisions 寫的是「最後一次 `turn.end`（補讀的也算）」，沒提推測的；若要連推測的也算，要改這裡和那條斷言。
- B4：新增 `src/main/persist/quit.ts` 的 `flushOnQuit(app, store)`，內容與舊的 `flushSettingsOnQuit` 相同，參數改為結構型別 `{ flushSync(): void }`（persist 不得依賴 settings/pool）。`files.ts` 的模組說明補一句「結束時寫檔在 quit」，兩檔說明一致。刪除 `settings/store.ts` 的舊函式，`main.ts` 兩處改名；註解：`detection.ts` 標頭改成三個轉接器，`sessions.ts:6-7` 改成目前沒有轉接器送行程結束的 `session.end`。
- `src/shared/stage-view.ts` 的 `stageSessionsSchema` 註解寫明：依 main/detection 首次看到的順序列出，名稱、狀態改變不移動，結束後同 key 回來排最後。
- 不改的檔案確認：`adapters/**`、`inference.ts`、`preload/**`、`overlay/**` 都沒動。

**既有測試的調整（只在行為本來就要改的地方）：**
- `detection-synced.test.ts`「an adapter that throws on start is waited for until the deadline」：改名並改成建立時就同步結束、沒有截止計時器（B1：啟動失敗不再等到逾時）。
- `pool-store.test.ts`：
  - 「I/O matrix 同步逾時」：逾時時 codex 未確認，預期由 `['codex:b']` 改成兩筆都保留，並斷言新的 log 文字（B1）。
  - 四個 start-up sweep 測試的 5 次 `sweep(...)` 呼叫補上第二個參數 `new Set()`；`wire()` 改傳 `(reported, unconfirmed)`（新增的參數，斷言不變）。
  - `flushSettingsOnQuit` → `flushOnQuit`，改從 `persist/quit` 匯入（改名）。
- `settings-store.test.ts`：`describe('flushSettingsOnQuit')` 整組搬到新檔 `test/main/persist-quit.test.ts`（改名＋搬到 persist），連同不再使用的 `EventEmitter` 匯入一起刪掉。
- `windows-main.test.ts`：
  - `flushOnQuit` 的 mock 從 `settings/store` 移到 `persist/quit`，順序字串改名。
  - `pool.sweep` mock 多記第二個參數；「sweeps the pool…」改成傳入並斷言未確認的來源（sweep 參數）。
- `session-rows.test.ts`：
  - 「orders rows by source, then name, then key…」改成依來源、再依 StageView 順序，預期 codex 變成 `z, y, x`（B3 排序）。
  - 「keeps the order when a state changes」的 `after` 不再把輸入順序反過來：StageView 依首次出現順序列出，狀態改變不會改順序；在新規則下反轉輸入本來就會反轉輸出（B3 排序）。
  - `nativeIdOf` 的 `it.each` 加上型別 `<[SessionKey, string]>`，配合參數收緊；斷言不變。

**新增測試：**
- `test/shared/detection-events.test.ts`：`splitSessionKey` 對每個來源、含 `:` 與最長 id 的往返。
- `test/main/persist-quit.test.ts`：`flushOnQuit` 只註冊一個 `will-quit` listener；觸發時只呼叫 `flushSync`；多次呼叫照加入先後執行，且早於之後加的 listener。
- `detection-sessions.test.ts` 的 `describe('the list')`：同步後 a、b、c 都已發佈，對 a 送新的 `session.meta`，順序仍是 a、b、c，a 的名稱是新的。
- `detection-synced.test.ts`：
  - `describe('I/O matrix')` 的全部同步、同步逾時、啟動失敗（含 health、`stop()` 仍呼叫）。
  - 啟動失敗時，同步前訂閱與同步後訂閱的 listener 拿到同一組 `reported`、`unconfirmed`（內容相同，也是同一個物件）。
  - 三條 log 測試（含全部啟動失敗的 `no adapter started`）。
- `pool-store.test.ts`：
  - sweep 單元測試：保留未確認來源；沒有未確認來源時 log 不變。
  - `describe('I/O matrix')`：全部同步、同步逾時、啟動失敗，接真的 `createDetection`。
- `detection-reducer.test.ts`：
  - I/O matrix 加補讀順序、下一輪的工具、補讀的請求、即時事件。補讀事件的 `ts` 與回推時間一致。
  - 另一個補讀順序案例：兩筆 `ts` 相同、後到的回推早 1 ms 的 `turn.end` 與 `tool.start`，工具照常開啟。
  - 新 describe「the last turn end」：
    - 欄位的設定與清除，記的是 `ts` 而不是回推時間。
    - 較早的事件等同 `activity`。
    - 去掉欄位後 `evaluate`、`nextChangeAt` 結果相同。
- `detection-sessions.test.ts`：I/O matrix 加補讀順序、下一輪的工具、補讀的請求、即時事件。
- `detection-claude-code.test.ts`：I/O matrix 加「補讀順序」。用真的暫存 transcript：主檔 3 分鐘前結束，subagent 檔尾是 4 分鐘前懸空的 Bash，補讀後是 `waiting`、2 分鐘後 `idle`，從未發佈推測的批准。
- `session-rows.test.ts`：`describe('I/O matrix')` 的名稱改變、新 session；另加「釋放、改回顯示時列不動」。
- 驗證新測試抓得到原本的缺陷：
  - 暫時拿掉 reducer 的判斷，B2 的 9 個測試失敗。
  - 暫時拿掉 catch 的 `awaitingSync.delete`，加上 sweep 的未確認保留，B1 的 9 個測試失敗。
  - 都已還原後重跑通過。

**驗證（本機，2026-11-13）：**
- `npm run typecheck`、`npm run lint`、`npm run depcruise`（189 modules，無違規）、`CI=true npm test`（64 files、2850 tests）全部通過。
- 審查修正後，只重跑涵蓋改動檔案的 12 個測試檔（800 tests），加上 typecheck、lint，都通過；全套驗證由協調者執行。
- 沒有啟動 app，也沒有實機驗證；Verification 的 Manual checks 留給使用者。

**風險與未處理：**
- B2 比的是紀錄的 `ts`，即時事件也一樣比。即時事件正常會照日期到達；只有不同檔案的紀錄時鐘不一致（例如 subagent 檔的時間早於主檔的 `turn.end`）才會不開啟，而依規則這本來就算已關閉的一輪。

- 2026-11-13 主 session 核對：開發代理問「推測的 `turn.end` 要不要記進 `lastTurnEndAt`」，我決定不記（推測不壓過紀錄裡的事實；推測只在同步後發生，之後的事件都是即時的，不受影響），維持現狀。我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`（189 個模組、0 違規）、`CI=true npm test`（64 檔、2850 個測試）全過。刪掉的 2 行 `expect(` 都是規格要改的行為（啟動失敗不再等逾時、逾時保留未確認來源的紀錄），改寫成更嚴格的斷言並驗 log 文字。`src/main/detection/adapters/**`、`inference.ts`、`src/preload/**`、`src/overlay/**` 沒有改動。I/O 矩陣 10 列都有測試且都有跑。開發代理回報：harness 把它一次指令輸出存到 `~/.claude/projects/.../tool-results/` 後它讀回了那個檔，內容只有 repo 裡的文件。

- 2026-11-13 審查修補後：B2 改比紀錄日期 `ts`（欄位 `lastTurnEndTs`，同日期照常開啟）；`session.meta` 後 `list()` 順序不變的 sessions 層測試，`stageSessionsSchema` 註解寫明順序保證；全部轉接器啟動失敗時 log 寫 `no adapter started`；同步前後訂閱拿到同一組 Set 的測試改寫；`flushOnQuit` 測試搬到 `test/main/persist-quit.test.ts`，persist 模組說明統一。我重跑四項檢查全過（65 檔、2855 個測試；depcruise 190 個模組、0 違規）。相對 baseline 刪掉的 4 行 `expect(`：2 行是規格要改的行為（前一筆已說明），2 行是 `settings-store` 裡搬走的結束寫檔測試，改由 `persist-quit.test.ts`（will-quit 呼叫 `flushSync`）、`settings-store.test.ts:780`（`flushSync` 寫檔）與 `pool-store` 的 I/O matrix「結束」涵蓋。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-13）：Blind Hunter 10 條（B1–B10）、Edge Case Hunter 5 條（E1–E5）、Verification Gap 1 個缺口（VG1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B1 | B2 的規則比較回推出來的時間：同一批補讀裡 `ts` 相同的兩筆事件，`Date.now()` 剛好跳一格時，後到的那筆被算成早約 1 ms，懸空的工具被丟掉（Cursor 的事件常共用同一個 `ts`） | medium | patch | `sessions.ts:249-254` 每筆事件各讀一次 `wallNow()`（整數）與單調時鐘（有小數）。定案寫的是「日期早於」，改成比紀錄本身的日期 `ts` 即可，嚴格小於，同日期照常開啟 |
| VG1、B4 | 「名稱改變時列不動」只在面板層用手寫的清單驗；`sessions.list()` 在 `session.meta` 後保持順序沒有測試；共用契約也沒寫明 StageView `sessions` 依首次出現排序 | low | patch | 驗證缺口已附證據：`detection-sessions.test.ts:1030` 沒有 `session.meta`。補 sessions 層測試，並在 `src/shared/stage-view.ts` 的 `stageSessionsSchema` 註解寫明順序保證 |
| B7、E3 | 所有轉接器都啟動失敗時，同步結束的 log 寫「every adapter that started sent sync.ready」，沒有任何轉接器啟動時這句話等於沒說 | low | patch | `detection.ts` 的 `outcome` 少一個分支；直接修正並補 log 斷言 |
| B8 | 「a subscriber after sync gets the same sets」只比了兩個同步後才訂閱的 listener，沒有比同步前、同步後訂閱的是不是同一組，也沒驗 `reported` | low | patch | 只有一個壞轉接器時同步在建立當下就結束；改成正常轉接器加壞轉接器，先訂閱一個、`sync.ready` 後再訂閱一個 |
| B10 | `flushOnQuit` 已搬到 `main/persist/quit.ts`，測試還留在 `settings-store.test.ts`；`persist/files.ts` 的模組說明沒提到結束時寫檔 | low | patch | 測試搬到 persist 自己的測試檔並直接驗三件事（只呼叫 `flushSync`、註冊在 will-quit、照加入先後執行）；統一模組說明 |
| B2、E2、B3 | 截止後才送的 `sync.ready` 不會讓 pool 補清那個來源；每次都慢或都失敗的來源，過期的釋放紀錄一直留著，使用者也看不到 | low | reject | 定案「沒有確認的來源不清理」；下一次準時同步就會清。紀錄只來自使用者按過的釋放，數量有限 |
| B5 | 前面來源多了 session、或上方的 session 結束時，後面的列仍會移動 | low | reject | 定案 B3 只保證名稱、狀態改變與釋放時不動，新 session 排在同來源最後；session 結束本來就會讓列減少 |
| B6 | 規則沒有包含 `turn.start`：補讀的 `turn.start` 日期較早時仍會重新打開一輪 | low | reject | 定案只列會被 `turn.end` 關掉的事件；目前只有主檔會送 `turn.start`，subagent 轉譯不送 |
| B9 | `pool-store.test.ts` 新的 I/O matrix 又宣告一份 `settings()` 與 `wire()`，兩個「同步逾時」整合測試重疊 | low | reject | 測試輔助的重複，沒有使用者影響；合併要改寫既有測試，不是直接修正。記作派工規則「先找既有寫法」的反例 |
| E1 | 最後一個轉接器在 `start()` 裡先送了 `sync.ready` 再丟例外，會被算成已確認 | false | reject | 它送了 `sync.ready`，表示補讀已完整回報，清理依據正確；之後收不到即時更新是健康狀態的事 |
| E4 | 驗收條件說既有斷言只在排序、參數、改名處調整，實際有兩條行為斷言被反轉 | low | reject | Boundaries 允許「行為本來就要改的地方」，兩條對應 I/O 矩陣的「啟動失敗」「同步逾時」列，Implementation Notes 已逐條說明 |
| E5 | 最後一次 `turn.end` 是推測的時候，日期較早的補讀 `tool.start` 仍會開啟 | low | reject | 推測只在同步後、對即時資料發生；主 session 核對時已決定推測不記入 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機（選做）：釋放一個 session 後重開，確認仍是已釋放；有用過 subagent 的 Claude Code session 重開後，不會出現推測的「要你批准」。
