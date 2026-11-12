---
title: 'Story 2.6（前置二）：推測一輪結束'
type: 'feature'
created: '2026-11-11'
status: 'done'
baseline_commit: 'e06dde2f4dfe219b413eba9a48b1a49f65445ae8'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-6-gemini-cli-adapter.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 判斷器只會推測「要你批准」「要你決定」。Gemini CLI 不寫「一輪結束」，只靠紀錄的話，回覆完會一直停在「思考中」。

**Approach:** 事件契約加 `turn.reply`（「寫完一則可能結束這一輪的回覆」），能力表加「一輪結束」欄位，`inference` 對這個欄位為 `none` 的來源推測 `turn.end`。Gemini 轉接器本體在 `spec-2-6-gemini-cli-adapter.md`，這份先做。

**Decisions（2026-11-11）：**
- 使用者選 B：有文字的回覆之後 10 秒（`TURN_END_INFER_MS`，常數，不開放調整）沒有新紀錄，才推測這一輪結束。真的結束時「做完了」晚 10 秒，換來「說完話接著呼叫工具」時不會誤閃「做完了」。
- 10 秒從該 session 最後一個事件算：回覆之後的 `activity` 會往後延，不會取消推測。
- 推測的一輪結束時間是到期那一刻，不是推測當下；不算該 session 的最後事件時間（同推測的請求）。
- 推測結束之後的「做完了」「等你回覆」標「推測」，直到下一個開始或結束一輪、開始工具、結束 session 的事件；`activity` 不清。
- 能力表：加「一輪結束」欄位，gemini 為 `none`，其他來源 `exact`。gemini 這一列同時改正：approval、question 都 `none`（`ask_user` 要等使用者回答後才寫進紀錄），提問類工具 `ask_user`；工具要整批完成才寫，只寫在註解。
- 拆分（使用者 2026-11-11 決定）：這份先做，再做 Gemini 轉接器。

## Boundaries & Constraints

**Always:**
- 推測仍只在 `inference` 產生；轉接器送來的推測事件照舊被 `sessions` 丟掉。同步前不推測。
- 只對「一輪結束」為 `none` 的來源推測；其他來源的行為完全不變，既有 reducer、inference、sessions 測試的斷言不改。

**Never:**
- 不改 8 狀態的條件與優先序；事件契約除了 `turn.reply` 與推測的 `turn.end` 之外不改。
- 不改轉接器（claude-code、demo）送的事件。

## I/O & Edge-Case Matrix

來源的「一輪結束」為 `none`，計時值以預設值為例（`doneMs` 5 秒）。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 有文字的回覆 | `turn.start`、`turn.reply`，之後 10 秒沒有事件 | 「做完了」標「推測」，5 秒後「等你回覆」標「推測」 |
| 接著呼叫工具 | `turn.reply` 後 3 秒 `tool.start` | 「工作中」，不推測結束 |
| 回覆後有 activity | `turn.reply` 後 6 秒 `activity` | 從 `activity` 起再 10 秒才推測 |
| 工具進行中 | 有未結束的 `tool.start` | 不推測結束（照舊推測批准） |
| 不在一輪中 | `turn.reply` 前沒有 `turn.start` | 不推測 |
| 補讀 | 補讀的最後一個事件是 1 小時前的 `turn.reply` | 同步後直接「等你回覆」標「推測」或「休息中」，不出現「做完了」 |
| 推測後下一輪 | 推測結束後 `turn.start` | 「思考中」，不標「推測」 |
| 推測後真的結束 | 推測結束後 `turn.end` | 「做完了」，不標「推測」 |
| 推測後 activity | 推測結束後 `activity` | 仍標「推測」 |
| `exact` 的來源 | claude-code 送 `turn.reply` | 不推測，只更新最後事件時間 |
| 同步前 | 來源還沒送 `sync.ready` | 不推測 |

</frozen-after-approval>

## Code Map

- `src/shared/detection-events.ts:144-152, :203-208`：加 `turnReplyEventSchema`（欄位同 `turn.start`），清單排在 `turn.end` 後。
- `src/shared/sources.ts:48-77`：`SourceCapability` 加 `turnEnd: CapabilityLevel`；`capability()` 的參數多了可改成物件。`:97`、`:118`：gemini 照 Decisions，註解寫明工具整批完成才寫、一輪結束靠推測。
- `src/shared/constants.ts`：`TURN_END_INFER_MS = 10_000`。
- `src/main/detection/reducer.ts`：
  - `SessionConditions` 加 `replyPending`：`turn.reply` 設；`turn.start`、`tool.start`、`turn.end`、`session.end` 清。`turn.reply` 其餘同 `activity`（:235-237）。
  - 加 `turnEndInferred`：推測的 `turn.end` 設；非推測的 `turn.start`、`turn.end`、`tool.start`、`session.end` 清。
  - 推測的 `turn.end` 其餘同 `turn.end`（:242-252），但跟推測的請求一樣不動 `lastEventAt`（:211-228 的 `moves`）。
  - `evaluate`（:321-360）：`turnEndInferred` 時 `done`、`waiting` 的 `confidence` 為 `inferred`；改 :94-96 的註解。
- `src/main/detection/inference.ts`：「一輪結束」為 `none`、`inTurn`、`replyPending`、沒有進行中的工具與未決請求時，到期時間 = `lastEventAt + TURN_END_INFER_MS`。推測的 `turn.end`：`via`、`confidence` 都是 `inferred`。回傳的每個推測事件附上到期時間；`nextInferenceAt` 算進去。模組註解補上這一種推測。
- `src/main/detection/sessions.ts:323-345`（`infer`）：推測的 `turn.end` 以 `min(at, 到期時間)` 交給 reducer，`ts` 回推同樣的差距；推測的請求照舊用 `at`。
- 面板對任何 `inferred` 狀態已標「推測」（`src/panels/session-rows.ts:101`），不用改。

## Tasks & Acceptance

**Execution:**
- [x] `detection-events.ts`、`sources.ts`、`constants.ts`：事件、能力表欄位、常數；`test/shared/detection-events.test.ts`、`sources.test.ts` 加對應。
- [x] `reducer.ts`：兩個新條件與 `confidence`；`test/main/detection-reducer.test.ts` 加表格列。
- [x] `inference.ts`、`sessions.ts`：推測一輪結束與時間；`detection-inference.test.ts`、`detection-sessions.test.ts` 用 `capabilityOf` 注入「一輪結束」為 `none` 的來源，涵蓋 I/O 矩陣每一列。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有測試的斷言沒改、測試數不減少。
- Given 一個「一輪結束」為 `none` 的來源在一輪中送了 `turn.reply`，when 10 秒沒有新事件，then 該 session 依序是「做完了」「等你回覆」，兩者 `confidence` 都是 `inferred`。

## Implementation Notes

- 2026-11-11 開發代理的寫法：`replyPending`、`turnEndInferred` 只在為真時存在（`?: true`，同事件的 `replay`），既有 reducer 測試對整個 conditions 的比對不用改；`inferEvents` 回傳 `{ event, dueAt }`，`sessions.infer` 照原樣交給 reducer（一輪結束在 `dueAt`、請求在當下）。
- shared 的兩個既有斷言照 Decisions 改了：事件清單多 `turn.reply`、gemini 那一列改為 approval／question `none`、`ask_user`。與 AC「既有斷言沒改」字面衝突，是規格本身的矛盾（審查 E6）；reducer、inference、sessions 的既有斷言沒改。
- 審查修補後主 session 重跑：typecheck、lint、depcruise（0 違規）、`CI=true npm test`（48 個檔案、2219 個測試）全過；diff 裡沒有刪掉的 `expect(`。
- 沒有手動驗收：還沒有會送 `turn.reply` 的來源，Gemini 轉接器完成時一起驗。
- CI：使用者 commit `abcad49`（2026-11-11）後，GitHub Actions 的 macOS、Windows 都通過（run 42992047967）。
- sprint 狀態：`2-6-gemini-cli-轉接器` 維持 `in-progress`，Gemini 轉接器本體（`spec-2-6-gemini-cli-adapter.md`）還沒做。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-11）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| VG1 | 一輪結束推測的 `openQuestions` 擋板沒有測試 | low | patch | 預先驗證的缺口：`inference.ts` 刪掉 `openQuestions.size > 0` 時現有測試全綠；補一列「回覆後有未決提問 → 不推測、`nextInferenceAt` 為 null」。 |
| VG2 | 面板「推測」的提示文字寫死「工具執行太久」，推測的「做完了」「等你回覆」也會用它 | medium | patch | `session-rows.ts:45-46`、`App.tsx:247` 對所有 `inferred` 狀態用同一句；Gemini 轉接器上線後每個推測的一輪結束都顯示錯的說明。Code Map 說面板不用改，只看了標記沒看提示文字。 |
| B8／E5 | `inferRequests` 只剩測試在用 | low | patch | `sessions` 已改用 `inferEvents`；正式程式留一個只為測試存在的 export。改成測試檔內的輔助函式，斷言不變。 |
| B7＋B9b | 推測一輪結束的 `ts` 回推分在兩個模組；`Math.min(at, dueAt)` 多餘 | low | patch | `inferEvents` 有 `now`、`dueAt`、`wallNow` 卻蓋 `wallNow`，再由 `sessions.infer` 依事件類型重蓋，`sessions` 因此要 `vi.mock` reducer 才測得到；`inferEvents` 只回傳 `now >= dueAt` 的推測。 |
| B4 | inference 模組的已知限制沒寫一輪結束的誤判 | low | patch | 規格 Design Notes 有，程式註解只寫了工具跑太久會被推測成批准；補一句：回覆之後的工具（或等批准）超過 10 秒、而來源要完成才寫工具時，會被推測成一輪結束。 |
| B10a | `SessionsOptions.wallNow` 註解只說蓋推測請求的 `ts` | low | patch | `sessions.ts:96-99`，一輪結束的推測也用它。 |
| B10c | 架構文件 AD-21／AD-22 還沒加 `turn.reply` 與推測一輪結束，沒有追蹤項目 | low | defer | Design Notes 說 Epic 2 回顧時對齊，deferred-work 沒有對應項目。 |
| B1／B2／E3／E4 | 推測結束後 session 接著工作（`tool.start`、`turn.reply`）不會重新打開這一輪；工具結束後的「做完了」用推測的時間、標 `exact` | low | reject | 依 Gemini 規格的對應表，工具整批寫入時只要有一個不是 `cancelled` 就送 `turn.start` 重開這一輪；全部 `cancelled` 時緊接著是 `Request cancelled.` 的真 `turn.end`，中間的狀態不會被看到。沒有樣本顯示推測後會出現沒有 `turn.start` 的新回覆；補救要加分支。 |
| B6／E2 | 補讀的最後回覆在同步前 10～15 秒時，同步後會出現 0～5 秒的「做完了（推測）」 | low | reject | 照 Decisions「推測的一輪結束時間是到期那一刻」的字面結果；只在 app 剛啟動、Gemini 剛好 15 秒內回覆過時發生，補救要加分支（到期早於啟動時當補讀）。 |
| B3 | reducer 收推測的 `turn.end` 不檢查條件 | false | reject | 唯一的來源是 `inferEvents`，它在同一個 `sessions.infer` 呼叫裡用同一份 conditions 判斷；轉接器送的推測事件在 `sessions.ts:406` 被丟掉。 |
| B5 | gemini 的 approval、question `none` 與 `ask_user` 不會觸發 | false | reject | Gemini 規格的對應表讓內容為空的 `gemini` 送 pending 的 `tool.start`，批准推測會觸發；`ask_user` 分不出來、說完話接著工具會被推測結束，都已列在 Gemini 規格的已知限制，轉接器上線時寫進註解。 |
| B9a | `settlesGuess` 放過推測的 `turn.start`／`tool.start`，走不到 | false | reject | 對所有走得到的事件結果相同，沒有錯誤的行為。 |
| B10b | 測試標題寫 13 種、斷言 14 種 | false | reject | 標題是「AD-21 的 13 種，加上排在 `turn.end` 後的 `turn.reply`」，與斷言一致。 |
| B11 | 較舊的補讀 `turn.reply` 晚於較新的事件到達時仍設 `replyPending` | low | reject | 同一個來源的事件依檔案順序送出；跨來源的亂序是 Story 2.2 已記在 deferred-work 的既有問題。 |
| E1 | 計時器晚到時，先到的新事件會讓到期的推測被跳過或延後 | low | reject | 與既有的請求推測相同；只在電腦睡眠喚醒的瞬間發生，結果是晚 10 秒或少一個已過去的「做完了」。 |
| E6 | AC 寫「既有測試的斷言沒改」，shared 的兩個斷言改了 | low | reject | Decisions 要求的改動（gemini 那一列、事件清單）；修正方式是改本規格的 AC，依規則不處理，在結果說明。 |

## Design Notes

**對架構的補充。** AD-21 的事件清單多一種 `turn.reply`，AD-22 推測的範圍從「要你批准」「要你決定」擴大到「一輪結束」，仍只由 `inference` 產生、只對能力表為 `none` 的項目。架構文件留到 Epic 2 回顧時一起對齊。

**為什麼用最後事件時間算 10 秒。** 只看 `turn.reply` 的時間的話，回覆之後若有 `activity`（例如 subagent 的紀錄）就得選擇「取消推測」或「照舊推測」：取消會讓這一輪一直停在「思考中」，照舊會在 subagent 還在跑時說結束了。用 `lastEventAt` 就是字面上的「10 秒沒有新紀錄」。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。

**Manual checks:**
- 這份沒有使用者看得到的變化（還沒有來源的「一輪結束」為 `none` 且會送 `turn.reply`），不需要手動驗收；Gemini 轉接器完成時一起驗。
