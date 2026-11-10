---
title: 'Story 2.2（下）：抓不到批准與提問時的推測'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: '275378ca8665b764b2acfacee5cb751139380dba'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-session-lifecycle-replay.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Codex、Gemini、Cursor 的紀錄不會寫出「在等你批准」，Codex 也不會寫出「在問你問題」。這類 session 停在批准畫面時，舞台只會顯示 `working`，使用者不知道該切過去。

**Approach:**
- 在 `src/shared` 宣告各來源的能力表。
- 新增 `main/detection/inference`（純函式），由 `sessions` 每次重算時呼叫。
- 規則：能力表標為 `none` 的項目，工具開始後超過 `approvalInferMs` 還沒結束，就產生 `via: inferred` 的 `approval.request`；提問類工具改為 `question.request`。產生的事件交給判斷器。

**Decisions（2026-11-10）：**
- 規格拆開。「擋掉轉接器送來的 `via: inferred`」與「判斷器忽略 id 不在進行中 tool 裡的推測 request」這兩項防護記在 deferred-work，本 story 不做。
- 很久沒有事件的 session（行程被強制結束、終端機被關）留下沒結束的工具時，照常推測成 `approval`，直到 session 逾時。紀錄上分不出「行程已不在」和「真的在等批准」，寧可多報；記為已知限制（審查 E1／B2）。

## Boundaries & Constraints

**Always:**
- 推測規則只寫在 `inference`。`sessions` 只負責三件事：呼叫它、把結果套進判斷器、把下一個推測時間點併入唯一的計時器。
- 推測的對象只限同時符合下列三點的 tool，每個 tool 最多推測一次：
  - 現在還開著；
  - 沒有同 id 的未決 request；
  - 從沒收過同 id 的 request。

  推測被 `approval.resolved` 關掉後，即使 tool 還在跑，也不會再推測一次。
- 依工具種類決定推測哪一種：
  - 提問類工具：能力表的 question 為 `none` 時，推測 `question.request`；
  - 其他工具：approval 為 `none` 時，推測 `approval.request`。
- 推測事件的 `requestId` 等於 `toolCallId`。推測事件不更新最後事件時間。
- 補讀：
  - 未同步的來源不推測；
  - 同步後，補讀的 tool 從回推的開始時間起算，已超過門檻就立即推測。這與上半回推補讀時間的決定一致。
- 半開區間：`now >= 開始時間 + approvalInferMs` 時推測。
- 改 `approvalInferMs` 後，`retime()` 立即依新值重算；已產生的推測不收回。

**Never:**
- 不改 AD-21 的條件表與優先序。
- 不另排第二個計時器。
- 不做下列工作：
  - 轉接器、面板、設定 UI、`main.ts` 接線：由 2.3、2.9 處理；
  - Claude Code 狀態檔失效時改用推測：由 2.4 處理。

## I/O & Edge-Case Matrix

以 `approvalInferMs` = 10 秒為例，來源的 approval 為 `none`（例如 `codex`）。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 推測批准 | `tool.start` 後 10 秒沒結束 | 10 秒前是 `working`；10 秒時變成 `approval`，confidence 為 `inferred` |
| 及時結束 | 9 秒時收到 `tool.end` | 不出現 `approval` |
| 推測後結束 | 推測後收到 `tool.end` | `approval` 消失 |
| exact 取代 | 推測後收到同 id 的 exact `approval.request` | 仍是 `approval`，confidence 改為 `exact` |
| exact 先到 | 10 秒內已收到同 id 的 exact request | 不推測 |
| 批准後繼續跑 | 推測後收到 `approval.resolved`，tool 還開著 | `working`，不再推測 |
| 提問類工具 | question 為 `none`，工具名在提問類清單裡 | 10 秒時變成 `decision`，confidence 為 `inferred` |
| exact 來源 | `claude-code` 的 tool 跑了 10 秒 | 維持 `working` |
| 補讀的長工具 | 補讀的 `tool.start` 在 3 分鐘前、沒有結束，之後收到 `sync.ready` | 發布時就是 `approval`（`inferred`） |
| 同步前 | 未同步來源的 tool 超過 10 秒 | 不推測、不發布 |
| 改門檻 | 第 5 秒把門檻改成 30 秒 | 30 秒時才變成 `approval` |

</frozen-after-approval>

## Code Map

- `src/shared/sources.ts`：
  - 加 `SourceCapability` 型別：`approval`、`question` 各為 `'exact' | 'none'`，另有 `questionTools: readonly string[]`。
  - 加凍結的 `SOURCE_CAPABILITIES`，值依 AD-4 的「已知抓不到」表：

    | 來源 | approval | question | 提問類工具 |
    |---|---|---|---|
    | `claude-code` | exact | exact | `AskUserQuestion`、`ExitPlanMode`（出處：`shelved/thinking-puppet-v1-2026-10-28/Sources/SessionWatcher.swift:58`） |
    | `codex` | none | none | 空，2.5 依真實紀錄補上 |
    | `gemini`、`cursor` | none | exact | 空 |
    | `copilot` | exact | none | 空，Epic 6 補上 |
    | `demo` | exact | exact | 空 |

- `src/shared/settings.ts:28-95`：加 `approvalInferMs`，整數，範圍 1000～600000，預設 10000；併入 `DetectionTimings`。
- `src/main/detection/reducer.ts`：
  - `openTools` 從 Set 改成 Map：`toolCallId` → `{ startedAt, toolName, requested }`。
    - 收到同 id 的 approval／question request 時，不論 confidence，`requested` 設為 true，之後不會再變回 false。
    - 重複收到 `tool.start` 時保留原本的項目。
    - `evaluate`、`nextChangeAt` 只看 `size`，不受影響。
  - `confidence: 'inferred'` 的 request 不更新 `lastEventAt`。
- `src/main/detection/inference.ts`（新檔）：純函式，不讀設定、不排計時器、不寫紀錄。
  - `inferRequests`：某個 session 在 `now` 這一刻應產生的推測事件。`ts` 用呼叫端提供的牆鐘。
  - `nextInferenceAt`：下一個會推測的時間點，沒有則回傳 null。
- `src/main/detection/sessions.ts`：
  - `settle`（`:296-335`）：對已同步、未逾時的 session，先套用 `inferRequests` 的結果，再 `evaluate`；`wakeAt` 併入 `nextInferenceAt`。
  - `createSessions` 加可選參數 `capabilityOf(source)`，預設查 `SOURCE_CAPABILITIES`。測試用它注入帶提問類工具的能力表。
- `test/main/detection-reducer.test.ts:127-134`：`snapshot` 的 `openTools` 改成展開 Map。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/sources.ts`、`src/shared/settings.ts`：加能力表與 `approvalInferMs`。
- [x] `src/main/detection/reducer.ts`：`openTools` 改成 Map；推測 request 不更新 `lastEventAt`。
- [x] `src/main/detection/inference.ts`：寫推測規則。
- [x] `src/main/detection/sessions.ts`：在 `settle` 呼叫推測，並可注入能力表。
- [x] 測試：
  - `test/main/detection-inference.test.ts`：推測規則的表格測試；
  - `test/main/detection-sessions.test.ts`：新增 `describe('inference I/O matrix')`，涵蓋 I/O 矩陣每一列；
  - reducer、settings、sources 的測試補上新欄位與新規則，並確認能力表涵蓋所有來源。

**Acceptance Criteria:**
- Given 舊版 `settings.json` 沒有 `approvalInferMs`，when 載入，then 取預設值 10000，不視為壞檔。
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - 介面：`inferRequests(session, now, timings, wallNow)`、`nextInferenceAt(session, now, timings)`。`session` 是 `InferenceSubject`（`sessionKey`、`source`、`conditions`、`capability`）；`timings` 只讀 `approvalInferMs`，任何 `DetectionTimings` 都能直接傳。參數順序比照 `evaluate`。
  - `nextInferenceAt` 只回傳晚於 `now` 的時間點，與 `nextChangeAt` 一致。`sessions` 先套用推測再算，已到期的不會漏掉。
  - `requested`：`tool.start` 時若已有同 id 的未決 request（request 比 tool 先到），也設為 true，所以「從沒收過同 id 的 request」在這種順序下也成立。tool 開始前就已 resolved 的 request 不算。`inference` 本身仍檢查未決 request，測試用手組的條件覆蓋這一層。
  - 推測事件以 `settle` 當下的 `at` 交給判斷器，`ts` 是該次 `settle` 讀一次的牆鐘。
  - 提問類工具的來源若 question 為 `exact`，就不推測，也不改推 `approval`（照 Always 第三點字面）。`questionTools` 以完全相同的 `toolName` 比對，大小寫有別。
  - 「不更新最後事件時間」只限 `confidence: 'inferred'` 的 `approval.request`／`question.request`；其他 `inferred` 事件（目前沒有來源會送）照舊更新。推測 request 是 session 第一筆事件時，條件從那一刻開始，與 `session.meta` 相同。
  - 推測不延後逾時：逾時仍從最後一筆真實事件起算（I/O 矩陣外另有測試）。
  - 能力表另匯出 `CapabilityLevel`（`'exact' | 'none'`）型別。`approvalInferMs` 排在 `errorHoldMs` 之後，`SETTINGS_FIELDS` 的順序隨之改變。
- 2.1 deferred B4／E6（推測晚於 `tool.end` 送到）在推測模組這邊不會發生：推測在 `settle` 裡、只看判斷器當下還開著的 tool。轉接器自送 `via: inferred` 的防護仍在 deferred-work（本 story 不做）。`deferred-work.md` 未改。
- 驗證：開發代理跑過 typecheck、lint、`npm test`（36 個檔案、1489 個測試）、depcruise（0 違規），全部通過。I/O 矩陣 11 列各有對應測試（`test/main/detection-sessions.test.ts` 的 `describe('inference I/O matrix')`）。另在原始檔上逐一做 22 個破壞（閉區間、略過 `requested`／未決 approval／未決 question、無視能力表、approval 與 question 對調、無提問類工具、`ts` 錯、`nextInferenceAt` 含 `now`、推測更新最後事件時間、重複 `tool.start` 覆蓋、request 先到不標 `requested`、request 不標／question 不標 `requested`、不排推測計時器、不推測、同步前就推測、預設能力表錯、推測結果沒存回、能力表值錯、預設值錯、範圍錯），新測試每次都失敗；原始檔已還原並以 `cmp` 確認。
- 主 session 核對：讀過 `275378c` 以來的完整 diff（含未追蹤檔），5 項任務與 2 條驗收條件都已完成。重跑 typecheck、lint、`npm test`（36 個檔案、1489 個測試、0 跳過）、depcruise（0 違規），全部通過；I/O 矩陣 11 列的測試都有執行並通過。
- 審查修補（第 1 輪，4 項，都是 low）：`SessionsOptions.wallNow` 的說明補上「也當作推測事件的 `ts`」；能力表註解拿掉被 git 排除的 `shelved/` 路徑，改寫依據（兩個工具都會停下來等使用者）；`openTools` 與 `inferRequests` 的順序說明改為「依 `tool.start` 送到的順序」；推測規則表格測試把 gemini、cursor 拆成兩列。使用者對審查 E1／B2 選擇照現在，寫進 Decisions。主 session 修補後重跑：typecheck、lint、`npm test`（36 個檔案、1490 個測試）、depcruise（0 違規）全部通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-10）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap（回報沒有測試缺口）。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| E1、B2 | 很久沒有事件的 session（行程被強制結束、終端機分頁被關，或補讀到的孤兒 `tool.start`）留下沒結束的工具，會被推測成 `approval`，一直到 `sessionExpireMs` 逾時（預設 2 小時） | medium | reject：使用者 2026-11-10 選擇照現在，記為已知限制 | 程式確認：`inference` 只看工具是否開著、是否超過門檻，不看 session 是否閒置；`detection-sessions.test.ts` 的「a guess does not keep a session from expiring」顯示推測維持到 2 小時。紀錄上分不出「行程已不在」和「真的在等批准」，要使用者取捨 |
| E2 | 上一輪的 `turn.end` 漏寫、工具還開著時收到新的 `turn.start`，舊工具會被推測，新的一輪顯示 `approval` 而不是 `thinking` | maybe-false（若成立為 medium） | defer | 判斷器依 AD-21 只在 `turn.end` 清空工具；要看各來源會不會寫出沒有 `turn.end` 的下一個 `turn.start`，在轉接器 story（2.4～2.7）以真實紀錄確認 |
| E3 | 同步期限過後才補讀到的 `tool.start`，在它的 `tool.end` 補讀到之前就被推測，發布後又撤回 | maybe-false（若成立為 medium） | defer | 與 2.2 上半審查 B2（同步是一次性的）同源，2.3 接線時一起決定 |
| E4 | 推測 `approval` 之後，同 id 的 exact `question.request` 才到，推測的 `approval` 優先序較高，仍顯示 `approval`（`inferred`） | maybe-false（若成立為 medium） | defer | 要同時滿足：approval 為 `none`、question 為 `exact`、工具不在提問類清單、question 晚於門檻才寫入（例如 cursor 延遲寫入）。2.6／2.7 依真實紀錄補提問類清單並確認時機；AD-22「同 id 的 exact 事件取代推測」也適用 |
| E5 | `approvalInferMs` 為 NaN 時每個工具立即被推測 | false | reject | 計時值只來自設定 schema（整數 1000～600000）；判斷器的模組說明已載明計時值必須是有限正數 |
| B1 | 能力表沒有「本來就會跑很久的工具」排除清單（原型有 `slowTools`） | maybe-false（若成立為 medium） | defer | 只有 2.4 讓 `claude-code` 在狀態檔失效時退回推測，才會遇到 subagent、WebFetch 等被推測；由 2.4 決定是否加排除清單 |
| B3 | approval 為 `none` 的來源，使用者批准後，工具執行期間仍顯示 `approval`；矩陣「批准後繼續跑」用的 `approval.resolved` 是 codex 送不出來的事件 | low | reject | 這就是 FR2／AD-22 的規則與已列的已知限制；該列驗的是「每個 tool 最多推測一次」，能力表可注入，不限 codex |
| B4 | 能力表沒有表達「讀不到每個工具的結束」與「寫入延遲」；cursor 若只在 `turn.end` 關工具，幾乎每個超過 10 秒的 turn 都會被推測 | maybe-false（若成立為 medium） | defer | 取決於 2.7 的 cursor 轉接器能否發出每個工具的 `tool.end`；2.7 確認，必要時能力表加欄位或該來源不推測 |
| B5、VG-O1 | `SessionsOptions.wallNow` 的說明「only dates replays」已過時 | low | patch | `sessions.ts:93`；現在 `settle` 每次都讀，也當作推測事件的 `ts` |
| B6 | 原始碼註解指向 `shelved/...`，這個資料夾被 `.git/info/exclude` 排除，其他人打不開 | low | patch | 已確認 `.git/info/exclude` 有 `/shelved/`；改成把依據直接寫進註解 |
| B7 | 推測沒有寫 run-log，事後無從追查 | low | reject | `DetectedSession.confidence` 已區分推測與確定，2.3 的面板會顯示推測標記 |
| B8 | 「依開始順序」的說法不精確：Map 保留的是到達順序，不是 `startedAt` 順序 | low | patch | `reducer.ts:43-44` 與 `inference.ts` 的同類說明；順序不影響結果，改說明即可 |
| B9 | 推測規則表格測試的標題寫 gemini 和 cursor，實際只測 gemini | low | patch | `detection-inference.test.ts:163`；補 cursor 一列 |

## Design Notes

**推測放在 `settle` 裡，而不是另做一層。** 架構圖畫的流程是「轉接器 → 推測 → 判斷器」，但 AD-22 的規則只要求推測寫在 `inference` 一處。

如果推測是前面獨立的一層，它得自己再記一份進行中的 tool、同步狀態、逾時與計時器。兩份狀態一旦對不上，就會在 `tool.end` 之後才推測（2.1 審查 B4／E6）。

放在 `settle` 裡，推測看的就是判斷器當下的條件，不可能對已結束的 tool 推測。同步閘門、計時器與 `retime` 也都共用同一套。

**已知限制：**
- 跑很久的工具，例如 build、測試，會被推測成 `approval`（AD-22）。
- 行程已不在、但沒有結束訊號的 session，工具會被推測成 `approval`，直到 `sessionExpireMs` 逾時（使用者 2026-11-10 決定）。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規
