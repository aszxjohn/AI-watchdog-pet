---
title: 'Story 2.1：偵測事件契約與 8 狀態判斷器'
type: 'feature'
created: '2026-11-09'
status: 'done'
baseline_commit: 'b1dd565b51d743cea34614b25d54280eeaffddd0'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 舞台還沒有偵測層。如果沒有先定好共用事件和唯一的判斷器，各轉接器會把同樣的情況判成不同狀態，新增工具時也得改判斷規則。

**Approach:**
- `src/shared` 定義來源代碼與共用事件 schema（AD-5、AD-21）。
- `src/main/detection/reducer` 是純函式：依事件更新單一 session 的條件，再依當下時間和呼叫端傳入的計時值，算出 8 狀態與信心度。

**Decisions（2026-11-09）：**
- 拆開：三個計時值加進設定 schema 的工作移出本 story，記在 deferred-work，建議併入 Story 2.2。本 story 的判斷器只接受傳入的計時值，不讀設定，也不定義預設值。
- `errorHoldMs` 預設 30 秒。本 story 不寫進程式，由拆出去的工作在設定 schema 套用。

## Boundaries & Constraints

**Always:**
- 條件只依 AD-21 條件表成立或解除。優先序為 `approval` > `decision` > `error` > `working` > `thinking` > `done` > `waiting` > `idle`。
- 進行中 tool、未決 approval、未決 question 都用以 id 為 key 的集合，不用計數。
- 計時只用呼叫端給的單調時鐘 `now`；事件的 `ts` 不參與計時。
- 持續時間採半開區間：
  - `done`：`turn.end` 之後經過的時間 `< doneMs`；
  - `error`：收到 `error` 之後經過的時間 `< errorHoldMs`；
  - `waiting`：最後事件之後經過的時間 `< idleMs`，`>= idleMs` 就是 `idle`。
- 每個新 schema 都有往返與拒絕測試。判斷器用「事件序列 → 狀態序列」表格測試。

**Never:**
- 不做以下各項（屬於 Story 2.2、2.3、2.9 或拆出的工作）：
  - 設定 schema 的計時欄位；
  - session 生命週期與逾時結束；
  - 補讀（`replay`、`sync.ready`）；
  - 推測、能力表、轉接器；
  - StageView、面板。
- 判斷器不讀設定、不用計時器、不寫紀錄，也不 import Electron 或 Node 內建模組。

## I/O & Edge-Case Matrix

計時值以 `doneMs` 5000、`idleMs` 300000、`errorHoldMs` 30000 為例；時間為單調毫秒。

| 情境 | 事件序列 | 預期狀態 |
|---|---|---|
| 一輪結束 | `turn.start`@0，`turn.end`@1000 | @1000～5999 為 `done`，@6000 為 `waiting`，@301000 為 `idle` |
| 平行工具 | 依序 `tool.start` a、`tool.start` b、`tool.end` a | `working`，直到 b 也結束 |
| 工具觸發批准 | 依序 `tool.start` a、`approval.request` a、`tool.end` a | `approval`；`tool.end` a 之後解除 |
| 提問與錯誤並存 | 未決 question 與 `error` 同時成立 | `decision` |
| 錯誤保持 | `error`@0，之後沒有事件 | @29999 前為 `error`，之後退回下一個成立的條件 |
| 錯誤解除 | `error` 之後收到 `turn.start` 或 `tool.start` | 立即解除 `error` |
| 漏寫結束 | 有未關的 tool 和 approval 時收到 `turn.end` | 全部清空，進入 `done` |
| 只有心跳 | `activity` | 只更新最後事件時間，不開任何條件 |
| 未知 id | `tool.end` 或 `*.resolved` 對不到 id | 忽略，不丟例外 |
| 推測與確定 | 同一個 `requestId` 先收到 `inferred`，再收到 `exact` | 該項信心度升為 `exact` |
| session 結束後 | `session.end` 之後又有事件 | 條件全部清空並標為已結束，之後的事件忽略 |

</frozen-after-approval>

## Code Map

- `src/shared/states.ts`：8 狀態碼 `StateCode`。沿用，不改。
- `src/shared/zod-setup.ts`：所有 schema 都從這裡取 `z`（oxlint 強制）。
- `src/shared/settings.ts`：本 story 不改。
- `test/shared/schema-helpers.ts`：提供 `expectRoundTrip`、`expectRejected`。
- `test/shared/states.test.ts`：表格測試寫法的範例。
- `.dependency-cruiser.cjs`：現有的 `no-circular` 與分層規則已涵蓋新資料夾，不加規則。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/sources.ts`：`SOURCE_CODES`（`claude-code`、`codex`、`gemini`、`cursor`、`copilot`、`demo`）及其 schema。註解列出各來源的原生 id（AD-21）。
- [x] `src/shared/detection-events.ts`：
  - `via` 與 `confidence` 列舉，以及 `confidenceFor(via)`。
  - `sessionKey` schema（`<source>:<原生 id>`，原生 id 1～256 字元、不含控制字元）與 `makeSessionKey`。
  - 13 種事件的 strict schema 聯集，以 `type` 區分。
  - 共同欄位：
    - `source`；
    - `sessionKey`：前綴必須等於 `source`；
    - `ts`：非負整數，epoch 毫秒；
    - `via`；
    - `confidence`：必須等於 `confidenceFor(via)`。
  - 各事件的專屬欄位：
    - `tool.start`：`toolCallId`、`toolName`；
    - `tool.end`：`toolCallId`；
    - `approval.*`、`question.*`：`requestId`；
    - `session.meta`：`displayName`。
  - 以上 id 與名稱都是 1～256 字元。
- [x] `src/main/detection/reducer.ts`：
  - `DetectionTimings`：包含 `doneMs`、`idleMs`、`errorHoldMs`。
  - 唯讀的 session 條件物件。
  - `reduceSession(conditions | undefined, event, now)`：傳入 `undefined` 時建立新的條件物件。
  - `evaluate(conditions, now, timings) → { state, confidence }`。
  - `nextChangeAt(conditions, now, timings) → number | null`：下一個可能改變狀態的時間點。
- [x] `test/shared/sources.test.ts`、`test/shared/detection-events.test.ts`：
  - 每種事件都要往返。
  - 要拒絕：未知 `type`、未知來源、前綴不符、`via` 與 `confidence` 矛盾、缺 `toolCallId` 或 `requestId`、多餘欄位、負數或小數的 `ts`。
- [x] `test/main/detection-reducer.test.ts`：
  - I/O 矩陣每一列，以及優先序兩兩組合的表格測試。
  - 三段持續時間的邊界：到期前 1 毫秒與到期當下。
  - `nextChangeAt`。
  - 換一組計時值時，同一份條件立即改用新值。

**Acceptance Criteria:**
- Given 某個 approval 只有 `via: inferred` 的請求，when 評估，then 狀態為 `approval`、信心度為 `inferred`；其他情況信心度一律為 `exact`。
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - 只有 inferred 的 question 讓 `decision` 的信心度也是 `inferred`，與 approval 相同（AD-22 的推測也會產生 `question.request`）；同類請求中只要有一筆 exact，就是 `exact`。
  - `session.meta` 在判斷器裡什麼都不改，連最後事件時間也不動（AD-21「只更新顯示名稱等中繼資料」，顯示名稱歸 Story 2.2 的 `sessions`）。它是 session 的第一個事件時，建立空條件，最後事件時間設為當下。
  - 對不到 id 的 `tool.end`、`*.resolved` 不改任何條件，但會更新最後事件時間。
  - 已結束的 session 評估為 `waiting`，再轉 `idle`；`reduceSession` 對之後的事件回傳同一個物件。
  - 原生 id 可以含 `:`，session key 以第一個 `:` 分開；來源代碼都不含 `:`。
- `sessionKeySchema` 用 `z.templateLiteral`，型別是 `` `codex:${string}` `` 這類樣板字串；前綴等於 `source`、`confidence` 等於 `confidenceFor(via)` 這兩項檢查，放在事件聯集的 refine。
- 驗證：開發代理與主 session 各自跑過 typecheck、lint、`npm test`（34 個檔案、1216 個測試）、depcruise（0 違規）。開發代理在複本上逐一破壞 3 個區間邊界、`turn.start`／`turn.end` 的清除、`tool.end` 關閉 approval、信心度升級、`session.end` 後忽略事件、`session.meta`、`nextChangeAt` 的比較、兩個 refine 與控制字元檢查，新測試每次都失敗；原始檔已還原並以 `cmp` 確認。
- `nextChangeAt` 的逐步測試加了步數上限，避免回歸時變成無窮迴圈卡住 vitest。
- 審查修補（第 1 輪，8 項）：
  - `evaluate` 改用與 `nextChangeAt` 相同的和來比較（`now < start + duration`），避免帶小數的時鐘因減法捨入而錯過邊界；新增小數時鐘測試（start = 522329.21094547195），三段時間都驗證在 `nextChangeAt` 回傳的時間點剛好改變。
  - 補測試：`tool.end` 關掉同 id 的推測 question；「其他事件不清 error」加入 `question.*`、`session.start`、`session.meta`；`eventTsSchema` 的直接拒絕案例。
  - 補註解：`DetectionTimings` 的前提、Set／Map 在快照之間共用不得修改、`session.meta` 是第一個事件時的例外、Claude Code transcript 資料夾名是編碼過的 cwd。
  - 主 session 修補後重跑：typecheck、lint、`npm test`（34 個檔案、1225 個測試）、depcruise（0 違規）全部通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-09）。審查員代號：VG＝verification-gap，B＝blind-hunter，E＝edge-case-hunter。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| VG1、B3 | 沒有測試驗證 `tool.end` 會關掉同 id 的 question | medium | patch | gap 預先驗證；刪掉 `reducer.ts` 的 `openQuestions` 那行，所有測試仍通過。推測出的 question 卡住時，整輪都會顯示「要你決定」 |
| VG2 | 「other events do not clear error」沒有涵蓋 `question.*`、`session.start`、`session.meta` | low | patch | gap 預先驗證；只要在這幾個分支誤清 `errorAt`，現有測試都抓不到 |
| E1、E11 | 時鐘值帶小數時，`now - start < d` 在 `start + d` 那一刻仍成立，`nextChangeAt` 會跳過那個邊界 | medium | patch | 用 node 實測，`t = 129902.61953427563` 時 `(t + 5000) - t = 4999.999999999985`。專案的單調時鐘是 `performance.now()`（`canvas-window.ts:242`），帶小數；`done`→`waiting` 會錯過，要等到 idle 的時間點才更新 |
| B7、E5 | `lastEventAt` 註解寫 `session.meta` 不算，但 meta 是 session 第一個事件時會設成當下 | low | patch | 程式確認（`reducer.ts:128-135`）；修正註解即可 |
| B8、E13 | `Object.freeze` 只凍結外層，各份快照共用同一個 Set／Map | low | patch | 程式確認（`reducer.ts:64-66,82-102`）；只有型別轉型後去改才會出事，在註解寫明 |
| B14、E9 | `DetectionTimings` 沒寫前提，傳入 NaN 時一律 `idle`，而且不報錯 | low | patch | 程式確認；目前沒有呼叫端，之後由設定 schema 驗證，在註解寫明前提 |
| B12 | `eventTsSchema` 只有往返測試，沒有自己的拒絕測試 | low | patch | 測試確認（`detection-events.test.ts:193-200`），違反規格「每個新 schema 都有拒絕測試」 |
| B15b | `sources.ts` 寫 `~/.claude/projects/<cwd>/`，實際資料夾名是編碼過的 cwd | low | patch | 本專案在 `~/.claude/projects/` 下的資料夾名是 `-Users-john-tsai-java-tools-gundam-pet`（`/`、`_` 都換成 `-`）；修正註解 |
| B6、E3、E4 | 已結束的 session 仍評估為 `waiting`，`nextChangeAt` 照常回報時間；同 key 的 `session.start` 被永久忽略 | E3 maybe-false（若成立為 medium），B6、E4 low | defer | 規格要求結束後忽略事件。實際影響取決於 Story 2.2 的 `sessions` 是否丟掉已結束的條件物件，要等 2.2 確認 |
| B4、E6 | 推測的 request 在 `tool.end` 之後才到，或 id 不在進行中的 tool 裡，會開出卡住的 approval／decision | maybe-false（若成立為 medium） | defer | 推測模組在 Story 2.2 才有；要等 2.2 確認推測只對還開著的 tool 發出，或由判斷器忽略這類推測 |
| B1 | 13 種事件都能標 `via: inferred`，範圍比 AD-22 寬 | low | reject | 目前沒有任何來源會發這些事件；而且 epic context 寫明 Gemini 的 `working` 可能要靠推測補上，先限制反而可能錯 |
| B2 | 關閉條件時不看 `via`，推測的 resolve 會關掉確定的 approval | low | reject | AD-22 的推測只產生 request，不會產生推測的 resolve；registry > log 的採信由轉接器合併 probe 時處理（AD-21） |
| B5 | 同 id 的推測 approval 會蓋過確定的 question | low | reject | 要先有「推測當成批准、紀錄卻寫成提問」的錯配才會發生；取代歸 2.2 的推測模組 |
| B9 | 優先序兩兩組合測試的前提，用的是測試自己重寫的條件表 | low | reject | 每個條件各自都有 I/O 矩陣與區間邊界的測試，優先序表只負責驗證比較順序 |
| B10 | `sessionKeySchema` 重寫了原生 id 的長度規則 | low | reject | `templateLiteral` 不能放帶 refine 的 schema；長度常數與控制字元檢查已共用 |
| B11、E10 | `toolName`、`displayName` 等欄位不擋控制字元，也沒有截斷工具 | low | reject | 若擋控制字元，整筆事件會被丟掉，比原樣顯示更糟；截斷屬於轉接器（2.4 起） |
| B13 | 不在 turn 中收到的 `turn.end` 會重新開始 `done`；連續兩次 `error` 會重新開始保持時間 | low | reject | 照條件表字面實作；重複事件由轉接器去重（epic context：Cursor 整檔重寫要去重） |
| B15a | 拒絕 `replay` 的測試把它寫成了永久契約 | low | reject | 2.2 刻意擴充契約時本來就要改這個測試 |
| E2 | 13 種以外的事件類型進入 switch 時會回傳 undefined | low | reject | TS strict 會檢查 switch 是否窮盡；執行時的事件都先經過 schema 驗證 |
| E7 | 前一輪漏寫 `turn.end` 時，新的 `turn.start` 不會清掉舊的 tool 和 request | low | reject | AD-21 的關閉清單沒有 `turn.start`；最多影響到下一個 `turn.end` |
| E8 | `now` 比已存的 `lastEventAt` 早時，最後事件時間會倒退 | false | reject | 呼叫端依收到順序以單調時鐘標時間（AD-22）；單執行緒依序處理，不會倒退 |
| E12 | 驗收條件寫「其他情況一律 exact」，實作卻讓只有推測 question 的 `decision` 也是 `inferred` | low | reject | 這項要改的是規格措辭，不是程式：AD-22 的推測也會產生 question，Implementation Notes 已記錄這個解讀 |

## Design Notes

**只保存事實，狀態每次重算。** 判斷器只存事實：
- 開著的集合；
- 是否在 turn 中；
- 最後一次 `turn.end`、`error` 與最後事件的時間。

狀態每次由 `evaluate` 依當下時間算出，所以計時值改變時不必重算歷史。

**`nextChangeAt`。** 取 `turnEnd + doneMs`、`error + errorHoldMs`、`lastEvent + idleMs` 中晚於 `now` 的最小值，給 Story 2.2 排計時器用。

**turn 開始與結束。**
- `turn.start` 清掉上一輪 `done` 的起點和 `error`。
- `turn.end` 清空三個集合，但不清 `error`。
- turn 進行中長時間沒有事件時，依條件表 `thinking` 高於 `idle`，所以維持 `thinking`。卡住的 turn 由 Story 2.2 的 `sessionExpireMs` 處理。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規
