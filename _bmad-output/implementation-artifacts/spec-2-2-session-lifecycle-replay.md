---
title: 'Story 2.2（上）：session 生命週期、啟動補讀與計時設定'
type: 'feature'
created: '2026-11-09'
status: 'done'
baseline_commit: 'c8dd04efaf8bfeadfedaf8e0ce80b22734b16740'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-detection-event-contract-reducer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.1 的判斷器只會算單一 session 的狀態，沒有人管 session 何時出現、何時結束、何時重算。app 剛啟動時補讀的舊紀錄也會讓狀態亂跳。計時值也還沒有地方設定。

**Approach:**
- 新增 `main/detection/sessions`，接收轉接器的事件，負責三件事：
  - 依 AD-22 決定 session 何時結束，結束後丟掉；
  - 依 `nextChangeAt` 排計時器重算狀態；
  - 啟動補讀期間不排計時器、不對外發布。
- 計時值加進設定 schema，判斷器從設定取值。

**Decisions（2026-11-09）：**
- Story 2.2 拆成兩個。本 story 不做推測，推測記在 deferred-work。
- `errorHoldMs` 預設 30 秒（Story 2.1 決定）。
- 補讀事件的時間用紀錄的 `ts` 回推：單調時間 =（收到時的單調時間）−（收到時的牆鐘 − `ts`）。差值為負，也就是 `ts` 在未來時，以 0 計。即時事件仍用收到的時間。AD-22 為此加上補讀例外。
- `sessionExpireMs`、`discoveryWindowMs` 預設都是 2 小時。
- 規格約 2,400 token，保留完整規格。

## Boundaries & Constraints

**Always:**
- session 只在三種情況結束：
  - 收到 `session.end`；
  - 有 pid 的來源發現行程已不存在，這時轉接器發 `session.end`，因為這是事實，不是逾時；
  - 最後事件之後超過 `sessionExpireMs`，由 `sessions` 判定。
- 結束的 session 立刻從清單移除；之後同一個 key 再有事件，就當成新的 session。
- 補讀事件（`replay: true`）只重建條件，不產生 `done`、不保持 `error`。
- 每個來源在收到自己的 `sync.ready` 之前，或在 `sessions` 建立後 `syncTimeoutMs` 到期之前：
  - 不排計時器、不判逾時；
  - 該來源的 session 不對外發布。
- 計時只用注入的單調時鐘；計時器可注入，測試一律用假時鐘。
- 計時設定改變時，不必等新事件，立即重算並重排計時器。
- 驗證失敗的事件丟掉，記一筆不含內容的紀錄（只記欄位路徑，不記值）。

**Never:**
- 不做推測、能力表、`approvalInferMs`。
- 不做轉接器、StageView 區段、面板、計時值設定 UI。
- 不接進 `main.ts`；由 Story 2.3 接上。
- 不改判斷器既有的條件表與優先序。

## I/O & Edge-Case Matrix

計時值以預設值為例。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 正常結束 | `session.end` | 從清單移除並通知訂閱者 |
| 逾時 | 最後事件之後到 `sessionExpireMs` | 結束並移除 |
| 結束後重用 key | 結束後同一個 key 收到 `turn.start` | 新的 session，狀態為 `thinking` |
| 一輪結束 | 已同步的來源收到 `turn.end` | 立即 `done`；5 秒後計時器觸發，轉 `waiting` |
| 補讀的一輪結束 | `replay: true` 的 `turn.end` | 不出現 `done` |
| 補讀的錯誤 | `replay: true` 的 `error` | 不出現 `error` |
| 補讀的舊 session | 補讀事件的 `ts` 是 10 分鐘前，之後收到 `sync.ready` | 發布時就是 `idle` |
| 補讀的過期 session | 補讀事件的 `ts` 是 3 小時前，之後收到 `sync.ready` | 判定逾時並移除，不發布 |
| 未來的 `ts` | 補讀事件的 `ts` 比牆鐘晚 | 視為剛收到 |
| 同步前 | 來源還沒送 `sync.ready` | 該來源的 session 不在 `list()` 裡，也沒有排計時器 |
| 同步 | 收到 `sync.ready` | 該來源的 session 一次發布，開始計時 |
| 同步逾時 | 某來源一直沒送 `sync.ready` | `syncTimeoutMs` 到期後視為已同步 |
| 改計時值 | `doneMs` 從 5 秒改成 10 秒，當時正處於 `done` | 立即重排，過了 10 秒才轉 `waiting` |
| 壞事件 | 不符合 schema | 丟掉並記錄，其他 session 不受影響 |

</frozen-after-approval>

## Code Map

- `src/main/detection/reducer.ts`：
  - `reduceSession`、`evaluate`、`nextChangeAt`，沿用。
  - 補讀的 `turn.end` 不設 `turnEndedAt`，補讀的 `error` 不設 `errorAt`。
  - `lastEventAt` 改取 `max(舊值, now)`。2.1 審查 E8 當時判為不會發生，但補讀回推之後就會發生。
  - 已結束的條件物件由 `sessions` 丟掉（2.1 deferred B6／E3／E4）。
- `src/shared/detection-events.ts`：
  - 共同欄位加 `replay`，型別為 `z.literal(true).exactOptional()`。
  - 另加 `syncReadySchema`（`type: 'sync.ready'`、`source`），不放進 `detectionEventSchema` 聯集。
  - `test/shared/detection-events.test.ts:345` 目前拒絕 `replay`，要改成接受。
- `src/shared/settings.ts`：
  - 在 `settingsFieldSchemas`、`SETTINGS_DEFAULTS` 加欄位；file、patch、StageView 的 schema 會自動跟著擴充。
  - 舊的 `settings.json` 缺欄位時取預設值，不視為壞檔（`store.ts:215-235`）。
- `src/main/settings/store.ts:80-84`：`get()` 與 `onChange()`，`sessions` 的計時值從這裡取，透過注入的 getter。
- `src/main/log/run-log.ts:30-35`：`RunLogCategory` 加 `'detection'`。
- `src/main/windows/canvas-window.ts:176-183,242-245`：注入 `now`、`defer` 的寫法，可以照著做。
- 測試裡寫死 `{ canvasDisplayId: null }` 的完整設定值，改用 `...SETTINGS_DEFAULTS` 展開。這些寫法散在約 12 個測試檔，以 `grep -rln canvasDisplayId test` 找出。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/settings.ts`：加入下列欄位（整數毫秒），並匯出 `DetectionTimings` 型別；`reducer.ts` 改用這個型別。

  | 欄位 | 範圍 | 預設 |
  |---|---|---|
  | `doneMs` | 1000～60000 | 5000 |
  | `idleMs` | 60000～3600000 | 300000 |
  | `errorHoldMs` | 1000～600000 | 30000 |
  | `sessionExpireMs` | 3600000～86400000 | 7200000 |
  | `discoveryWindowMs` | 600000～86400000 | 7200000 |
  | `syncTimeoutMs` | 1000～60000 | 10000 |

- [x] `src/shared/detection-events.ts`：加 `replay` 欄位與 `syncReadySchema`，以及 `AdapterOutput` 型別（事件或 `sync.ready`）。
- [x] `src/main/detection/reducer.ts`：處理補讀事件，規則見 Code Map。
- [x] `src/main/log/run-log.ts`：加 `'detection'` 類別。
- [x] `src/main/detection/sessions.ts`：`createSessions({ timings, now, wallNow, setTimer, clearTimer })`，回傳：
  - `receive(output)`：驗證後套用；
  - `list()`：只含已同步、未結束的 session，每筆有 `sessionKey`、`source`、`displayName`（來自 `session.meta`，沒有時為 null）、`state`、`confidence`；
  - `onChange(listener)`：回傳取消訂閱的函式；
  - `retime()`：計時設定改變時呼叫；
  - `stop()`：清掉所有計時器。
  
  只排一個計時器，時間點取所有已同步 session 的 `nextChangeAt` 與逾時時間中最早者。
- [x] `test/main/detection-sessions.test.ts`：I/O 矩陣每一列，用假時鐘與假計時器。
- [x] `test/shared/settings.test.ts`、`test/shared/detection-events.test.ts`，以及寫死設定值的測試：
  - 新欄位的預設值、範圍邊界的接受與拒絕；
  - `replay` 與 `sync.ready` 的往返與拒絕。

**Acceptance Criteria:**
- Given 舊版 `settings.json` 只有 `canvasDisplayId`，when 載入，then 新欄位都取預設值、檔案不搬到備份。
- Given `onChange` 的某個訂閱者丟出例外，when 狀態改變，then 其他訂閱者照常收到通知，並記一筆 `detection` 錯誤。
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - `DetectionTimings` 是 `SettingsValues` 取 6 個計時欄位的 `Pick`；判斷器只讀其中 3 個。任何 `SettingsValues` 都可以直接當 `DetectionTimings` 傳，Story 2.3 可寫成 `timings: () => store.get().values`。
  - 補讀的 `turn.end`／`error` 不改 `turnEndedAt`／`errorAt`（保留原值，不清成 null）：較舊的補讀不會蓋掉已先到的即時事件。
  - 同步期限也走同一個計時器：有未同步來源的 session 時，計時器排在「建立時間＋`syncTimeoutMs`」；未同步的 session 本身不排計時器（I/O 矩陣「同步前」列的解讀）。沒有未同步的 session 時不排，期限在下一次重算時才判定。
  - 逾時採半開區間：`now >= lastEventAt + sessionExpireMs` 即結束，與判斷器的三段時間一致。
  - `onChange` 傳整份凍結清單，只在清單有變（成員、`state`、`confidence`、`displayName`）時通知；一次 `receive`、一次計時器觸發最多通知一次。訂閱者在回呼裡又呼叫 `receive` 時，外層不再把舊清單發給後面的訂閱者。
  - `receive` 的參數型別是 `AdapterOutput`，執行時仍以 schema 驗證：`type === 'sync.ready'` 用 `syncReadySchema`，其他用 `detectionEventSchema`，讓紀錄的欄位路徑準確。紀錄層級 `warn`；欄位路徑含 strict object 的未知欄位名（與 settings store 記未知欄位名一致），根層記為 `(root)`。
  - `stop()` 之後 `receive`、`retime` 都不做事，不只是清計時器，避免結束流程中又排計時器或發通知。
  - `list()` 依首次出現的順序；結束後同 key 再出現排在最後。
  - 計時器延遲取 `Math.ceil`，避免帶小數的單調時鐘讓計時器早觸發一點後又排一次。
- 2.1 deferred B6／E3／E4：判斷器回傳 `ended` 時 `sessions` 立即丟掉條件物件，同 key 之後的事件成為新 session，已有測試。`deferred-work.md` 未改，留給主 session 處理。
- 驗證：開發代理跑過 typecheck、lint、`npm test`（35 個檔案、1400 個測試）、depcruise（0 違規），全部通過。另在原始檔上逐一做 18 個破壞（補讀仍設 `turnEndedAt`／`errorAt`、`lastEventAt` 可倒退、不回推補讀時間、未來 `ts` 不歸零、來源一律或永不同步、不判逾時、逾時改成開區間、留下已結束條件、遺失顯示名稱、拿掉舊清單防護、不排同步期限、`retime` 無效、訂閱者例外未攔、每次都通知、`stop` 後仍收事件、壞事件照用），新測試每次都失敗；原始檔已還原並以 `cmp` 確認。
- 主 session 核對：重跑四項檢查全部通過（35 個檔案、1400 個測試、0 跳過）；I/O 矩陣 14 列各有對應測試（`test/main/detection-sessions.test.ts` 的 `describe('I/O matrix')`），都已執行並通過。`deferred-work.md` 依規則只增不改，B6／E3／E4 那一筆由本 story 解決，記錄在此。
- 審查修補（第 1 輪，4 項）：
  - `apply`：事件時間已到或超過舊條件的逾時點（`lastEventAt + sessionExpireMs`）時，不沿用舊條件和顯示名稱，視為新的 session。即時事件比逾時計時器先到，或未同步來源的補讀中間斷超過逾時，都走這條。
  - 補測試：即時事件即使 `ts` 很舊，也從收到時開始計時；「同步前」延長到期限，驗證屆時發布的狀態；逾時後、計時器觸發前收到事件，舊的 tool／approval 不會帶過去（假時鐘加了 `skipTo`，模擬計時器晚觸發）。
  - 補註解：`discoveryWindowMs` 應不小於 `sessionExpireMs`。
  - 主 session 修補後重跑：typecheck、lint、`npm test`（35 個檔案、1402 個測試）、depcruise（0 違規）全部通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-09）。審查員代號：VG＝verification-gap，B＝blind-hunter，E＝edge-case-hunter。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| VG-O1、E4 | 事件的時間已經超過舊條件的逾時點，仍會併進已逾時的條件，舊的未關 tool／approval 被帶進新的一段 | medium | patch | 程式確認：`apply` 不檢查逾時，逾時只在之後的 `settle` 判定（`sessions.ts:224-243,305-306`）。即時事件比逾時計時器先到，或未同步來源補讀的紀錄中間斷超過 `sessionExpireMs`，都會走到。違反「結束後同一個 key 再有事件就是新的 session」 |
| VG1 | 沒有測試釘住「即時事件用收到時間，不依 `ts` 回推」 | medium | patch | gap 預先驗證：測試輔助函式一律把 `ts` 設成當下的牆鐘，所以改成全部回推後測試照樣通過 |
| B10d | 「同步前」的測試停在 9999 毫秒，沒有驗證期限到時發布出來的狀態 | low | patch | 測試確認（`detection-sessions.test.ts:323`）；延長到期限就能補上 |
| B6、E7 | `discoveryWindowMs` 小於 `sessionExpireMs` 時，重啟前還沒逾時的 session 不會被找回 | low | patch | 兩者各自可改，沒有約束也沒有說明；兩者都不在設定頁，改註解即可 |
| B1、E1、E2、E3、B10a | 同一個 session 的補讀事件晚於即時事件送到時，舊的 `turn.start`／`tool.start` 會清掉即時的 `done`／`error`，舊的 `session.end` 會結束正在跑的 session，舊的 `session.meta` 會蓋掉新名稱 | maybe-false（若成立為 medium） | defer | 要有轉接器在補讀完成前就送出即時事件才會發生；目前沒有轉接器。Claude Code 會合併狀態檔與 transcript，要在 2.4 決定順序約定，或由 `sessions` 忽略比最後即時事件還舊的補讀 |
| B2 | 同步是一次性的，期限從 `createSessions` 起算；同步後才到的補讀會逐筆發布，造成狀態亂跳 | maybe-false（若成立為 medium） | defer | 取決於轉接器補讀要多久、會不會重啟、何時啟動；要等 2.3 接線時確認 |
| B4、E6 | macOS 睡眠期間 `performance.now()` 不前進，睡過一整晚後 `idle` 和逾時都晚一整晚 | medium | defer | libuv 的 `uv_hrtime` 在 macOS 用 `mach_absolute_time`，睡眠時不增加。`now` 是注入的，修正點在 2.3 接線：用 `powerMonitor` 的 suspend／resume 牆鐘差補一個偏移量，再呼叫 `retime()` |
| B3 | `main/pool` 拿不到「所有來源都已同步」的訊號 | low | reject | pool 是 Story 2.8；該 story 會依需要加查詢 |
| B5 | 判斷器的 `DetectionTimings` 收 6 個欄位，實際只讀 3 個 | low | reject | 只讓測試多展開一次預設值；換來的好處是 2.3 可以直接傳設定值 |
| B7、E5 | 丟棄壞事件的警告不記 `source`／`type`，也不限流 | low | reject | 壞事件代表轉接器有 bug，轉接器自己會先跳過壞行；而且未驗證的 `source` 可能是任意字串，不宜寫進紀錄 |
| B8 | 補讀期間每筆事件都完整 `settle` 一次 | low | reject | session 數十個、紀錄數千筆時成本可以忽略 |
| B9 | `detection` 類別缺少同步期限到期、逾時移除等診斷紀錄 | low | reject | 2.3 的轉接器健康狀態會呈現；沒有實際需要的證據 |
| B10b | 計時器回呼裡的 `if (!stopped)` 沒被測到 | low | reject | `stop()` 會先清掉計時器，這只是額外的防護 |
| B10c | 沒測訂閱者在通知過程中取消訂閱、新增訂閱或 `stop()` | low | reject | 照 JS 走訪 Set 的語意即可，沒有實際情境 |
| E8 | 沒有任何程式呼叫 `createSessions`，改設定不會生效 | low | reject | 規格明定不接進 `main.ts`，由 2.3 接上 |
| E9 | 補讀期間仍會排同步期限的計時器，與「不排計時器」不符 | low | reject | 期限需要計時器觸發；「不排計時器」指的是每個 session 自己的計時器，Implementation Notes 已記這個解讀 |

## Design Notes

**一個計時器。** `sessions` 只排一個計時器。觸發時重算所有已同步的 session，只對狀態或清單有變的部分通知訂閱者，再依新的最早時間點重排。這樣計時器數量不會隨 session 增加。

**時間的兩種來源。** 即時事件的時間一律是收到時的單調時間。補讀事件的時間用 `ts` 回推（見 Decisions），所以傳給 `reduceSession` 的 `now` 會早於收到時間。

同一個 session 的條件物件，最後事件時間只能往前走，不能倒退：較舊的補讀事件不能把較新的時間蓋掉。

**哪裡要改 AD-22。** 原文「所有計時以收到事件時的單調時鐘為準；事件 `ts` 只用於排序與顯示」，2026-11-09 已加上補讀例外。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規
