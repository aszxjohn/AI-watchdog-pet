---
title: 'Story 2.6：Gemini CLI 轉接器'
type: 'feature'
created: '2026-11-11'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-4-claude-code-transcript.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 偵測目前只讀 Claude Code；使用者用 Gemini CLI 時，它的 session 不會出現在面板。

**Approach:** 新增 `gemini` 轉接器，唯讀 `~/.gemini/tmp/<專案>/chats/` 底下的 `session-*.jsonl`，把紀錄翻成共用事件。讀檔、監看、補讀、健康使用前置重構抽出的共用核心 `adapters/jsonl/`（`spec-2-6-jsonl-adapter-core.md`）。

**Decisions（2026-11-11）：**
- 能力表：approval、question 都是 `none`。原本 gemini 的 question 標 `exact` 是錯的：`ask_user` 要等使用者回答後才寫進紀錄。提問類工具 `ask_user`，不推測的工具沒有。能力表新增「工具何時寫入」欄位，gemini 為「完成後才寫」，其他來源為「開始時就寫」。
- subagent（`chats/<父 session id>/` 底下的檔）只算父 session 的 `activity`：它的工具同樣要完成才寫，算成工具也看不到「工作中」。
- 只有開過、沒有任何對話（只有 `info`）的 session 不顯示，與 Claude Code、Codex 在第一個提示之後才有紀錄一致。
- 一輪結束（使用者 2026-11-11 選 B）：Gemini 不寫「一輪結束」，有文字的回覆寫入後 10 秒（`TURN_END_INFER_MS`，常數，不開放調整）沒有新紀錄，才推測這一輪結束。真的結束時「做完了」會晚 10 秒，換來「說完話接著呼叫工具」時不會誤閃「做完了」。
  - 事件契約加一種事件 `turn.reply`（「寫完一則可能結束這一輪的回覆」），`turn.end` 可以是推測的；推測仍只在 `inference` 一處產生。
  - 能力表加「一輪結束」欄位：gemini 為 `none`（推測），其他來源為 `exact`；只對 `none` 的來源推測。
  - 推測出來的一輪結束，之後的「做完了」「等你回覆」都標「推測」，直到下一個事件。

## Boundaries & Constraints

**Always:**
- 完全唯讀：只開啟 `~/.gemini/tmp/*/chats/` 底下的 `.jsonl` 來讀。不寫檔、不執行指令。
- 原生 id 是檔案第一行（header）的 `sessionId`，`sessionKey` 為 `gemini:<sessionId>`；每個檔先讀第一行（最多 1 MiB），之後照 2.4 的規則讀：補讀最後 2 MiB、即時讀、變小重讀、壞行計數（連續 20 行 `degraded`）、`sync.ready`、資料夾不存在為 `missing` 並定期重查。
- 對應照 Design Notes 的表；`ts` 取訊息的 `timestamp`。
- 顯示名稱：最新的 `$set.summary` 優先，否則用專案資料夾名稱（`tmp/` 底下那一層）。
- 擴充共用核心（先讀第一行、依第一行決定 session）時，claude-code 的行為與測試不變。

**Never:**
- 不開 `~/.gemini/` 底下的其他檔：`oauth_creds.json`、`google_accounts.json`、`settings.json`、`projects.json`、`tmp/*/logs.json`、`.project_root`、舊格式的 `session-*.json`。
- 不讀出或印出真實紀錄的內容；fixture 只能由白名單去識別化腳本產生。
- 不改 8 狀態的條件與優先序；事件契約除了 `turn.reply` 與推測的 `turn.end` 之外不改。

## I/O & Edge-Case Matrix

計時值以預設值為例。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 新 session | 新檔寫入 header，再寫入使用者訊息 | 出現 session，名稱為專案資料夾名稱，「思考中」 |
| 只開沒問 | 檔案只有 header 與 `info` | 不出現 |
| 呼叫工具 | 內容為空的 `gemini` 訊息 | 「工作中」 |
| 工具做完 | 同一個 id 的 `gemini` 帶 `toolCalls` 重寫 | 回「思考中」 |
| 有文字的回覆 | 有內容的 `gemini` 之後 10 秒沒有新紀錄 | 「做完了」標「推測」，5 秒後「等你回覆」標「推測」 |
| 說完話接著呼叫工具 | 有內容的 `gemini` 之後 10 秒內有新紀錄 | 一直是「思考中」或「工作中」，不出現「做完了」 |
| 下一輪 | 推測結束後使用者送出新訊息 | 「思考中」，不再標「推測」 |
| 補讀 | 1 小時前最後一則是有文字的回覆 | 同步後是「等你回覆」標「推測」（或已「休息中」） |
| 推測批准 | 內容為空的 `gemini` 之後 10 秒沒有新紀錄 | 「要你批准」，標「推測」 |
| 拒絕批准 | `toolCalls` 全是 `cancelled`，接著 `info` 的 `Request cancelled.` | 一輪結束 |
| 中斷 | 串流中按 Esc（只有 `info` 的 `Request cancelled.`） | 一輪結束 |
| 錯誤 | `error` 訊息 | 「出錯了」 |
| 標題 | `$set.summary` | 名稱改為它 |
| `/clear` | 同一專案資料夾出現新 `sessionId` 的檔 | 新 session；舊的照逾時結束 |
| subagent | `chats/<父 id>/` 底下的檔有新紀錄 | 只更新父 session 的最後事件時間 |
| 太舊 | 3 小時前修改的檔 | 不出現 |
| 壞行 | 連續 20 行無法解析 | 健康 `degraded` |
| 沒有資料夾 | `~/.gemini/tmp/` 不存在 | 健康 `missing` |
| 唯讀 | 對 fixture 跑完整個轉接器 | 前後雜湊完全相同 |

</frozen-after-approval>

## Code Map

- `src/main/detection/adapters/jsonl/`（前置重構產生）：加「先讀第一行（最多 `FIRST_LINE_MAX_BYTES`）、交給轉接器決定 session id」的參數；claude-code 不用。
- `src/main/detection/adapters/gemini/`（新）：`paths`（`<專案>/chats/session-*.jsonl`、`<專案>/chats/<uuid>/*.jsonl`、`shouldWatch`，`mtimeMs` 照 2.4 先轉數字）、`translate`（純函式，每個檔一份狀態：目前 session id、最後一則 `gemini` 的 id、上一個「一輪」事件）、`gemini.ts`。
- `src/shared/sources.ts`：`SourceCapability` 加工具寫入時機、一輪結束兩個欄位；gemini 照 Decisions；更新 :95-99 的註解。
- `src/shared/detection-events.ts`：加 `turn.reply`（欄位同 `turn.start`），放進 `DETECTION_EVENT_TYPES` 與 `detectionEventSchema`，排在 `turn.end` 後面。
- `src/main/detection/reducer.ts`：
  - `turn.reply` 像 `activity` 一樣更新最後事件時間，另外記下 `replyAt`（補讀時以 `ts` 回推，同 AD-22）；之後該 session 任何會更新最後事件時間的事件都清掉它。
  - 推測的 `turn.end` 照一般 `turn.end` 處理，另記下「這次結束是推測的」，下一個 `turn.start`、`tool.start` 或 `session.end` 清掉；記著時，`done` 與 `waiting` 的 `confidence` 為 `inferred`（目前只有 :95-96 的 `approval`／`decision` 會是）。
- `src/main/detection/inference.ts`：能力表一輪結束為 `none` 的來源，session 在一輪中、有 `replyAt`、沒有進行中的工具與未決請求，到 `replyAt + TURN_END_INFER_MS` 產生 `via: 'inferred'` 的 `turn.end`；`nextInferenceAt` 一併算進去；同步前不推測（同既有規則）。
- `src/shared/constants.ts`：`FIRST_LINE_MAX_BYTES = 1024 * 1024`、`TURN_END_INFER_MS = 10_000`。
- `src/main/main.ts:172-179`：加 `createGeminiAdapter({root: ~/.gemini/tmp})`；只提 Claude Code 的註解（:11、:34-35、:172、:243）一併更新。
- `scripts/deidentify-gemini.mjs`（新）、`test/fixtures/gemini/`：由本機 3 個 session 檔產生（一般的多輪、工具、拒絕批准、只有 `info`）。白名單：header 的 `kind`；訊息的 `type`、`id`、`timestamp`；內容只保留「是否為空」「是否為 `functionResponse`」，非空文字換成「範例回覆」，`Request cancelled.` 原樣保留；`toolCalls` 只留 `id`、`name`、`status`、`timestamp`；`$set` 只留鍵名，`summary` 換成「範例標題」，`messages` 換成空陣列。id 重新編號、時間平移、`projectHash` 換成固定值、專案資料夾換成 `fixture-project`。樣本沒有的情境（錯誤、Esc、subagent、summary）在翻譯測試用手寫的行。
- 測試 `test/main/detection-gemini*.test.ts`：重用前置重構搬到 `test/helpers/` 的輔助函式。

## Tasks & Acceptance

**Execution:**
- [ ] `src/main/detection/adapters/jsonl/`：加讀第一行的參數。
- [ ] `src/shared/detection-events.ts`、`sources.ts`、`constants.ts`、`src/main/detection/reducer.ts`、`inference.ts`：`turn.reply`、能力表欄位、推測一輪結束；判斷器與推測的表格測試加對應列（含補讀、推測後下一輪、10 秒內有新事件）。
- [ ] `src/main/detection/adapters/gemini/`、`main.ts`：轉接器與接線。
- [ ] `scripts/deidentify-gemini.mjs`、`test/fixtures/gemini/`：去識別化 fixture，並測試裡面沒有 home 路徑。
- [ ] 測試：翻譯快照、I/O 矩陣每一列、唯讀雜湊、真 chokidar（append、同 id 重寫、舊檔被寫入）、BigInt `mtimeMs`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 本機有 `~/.gemini/tmp`，then run log 有 `gemini` 轉接器啟動與同步的紀錄，沒有 `detection` 錯誤。

## Implementation Notes

- 2026-11-11：使用者決定拆開，先做前置重構 `spec-2-6-jsonl-adapter-core.md`；本規格等重構完成後再定稿、核准。

## Spec Change Log

## Review Triage Log

## Design Notes

**紀錄 → 事件。** 依本機 3 個檔的結構調查（只看欄位名、種類、數量）與 Gemini CLI v0.52.0 原始碼（`packages/core/src/services/chatRecordingService.ts`、`cli/src/ui/hooks/useGeminiStream.ts`）：`gemini` 訊息在模型串流結束後才寫一次；工具只有整批完成（`success`／`error`／`cancelled`）後，才以同一個 id 重寫該訊息並加上 `toolCalls`；等批准、執行中都不寫；沒有「一輪結束」的紀錄。

| 紀錄 | 事件 |
|---|---|
| header（第一行） | 不送；記下 `sessionId` |
| 第一則 `user` 或 `gemini` 訊息 | 先送 `session.start` 與名稱的 `session.meta` |
| `user`，內容不是 `functionResponse` | `turn.start` |
| `gemini`，內容為空 | `tool.start`（`toolCallId` = `pending:<訊息 id>`，`toolName` = `pending`） |
| `gemini`，內容不是空的 | `turn.reply` |
| 同 id 的 `gemini` 帶 `toolCalls` | `pending:<id>` 的 `tool.end`；每個呼叫送 `tool.start`＋`tool.end`；有任一個不是 `cancelled` 時再送 `turn.start`（模型會接著回應；若推測已結束這一輪，以此重新開始，一輪中重送無副作用） |
| `info` 的 `Request cancelled.` | `turn.end` |
| `error` | `error`＋`turn.end` |
| `$set.summary` | `session.meta` |
| `$set.sessionId` 與目前不同 | 舊 session `session.end`，新 session 從下一則訊息開始 |
| 其他訊息（`user` 的 `functionResponse`、其他 `info`、`warning`） | `activity` |
| 其他 `$set`、`$rewindTo` | 不送 |

連續的 `turn.end` 只送第一個（同 2.4）。轉接器送的事件都是 `via: log`、`confidence: exact`。

**對架構的補充。** AD-21 的事件清單多一種 `turn.reply`，推測的範圍從「要你批准」「要你決定」擴大到「一輪結束」，仍只由 `inference` 產生、只對能力表為 `none` 的項目。架構文件留到 Epic 2 回顧時一起對齊。

**已知限制。**
- `ask_user` 等你回答時，紀錄裡看不出是提問，會被推測成「要你批准」而不是「要你決定」。
- 工具跑超過 10 秒（例如 build）也會被推測成「要你批准」。
- 先說一段話再呼叫的工具，若停在批准畫面或跑超過 10 秒，會被推測成一輪結束：「做完了」→「等你回覆」（都標「推測」），工具紀錄寫入後回「思考中」。
- 沒有 session 結束訊號；Gemini 結束時刪掉的空 session 檔也照逾時結束。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。

**Manual checks:**
- 開發代理：`--user-data-dir` 隔離執行 `npm start`，看 run log；執行前後比對 `~/.gemini/tmp` 的檔案清單、大小與修改時間；不截圖、不碰使用者的 app，只比 metadata。
- 使用者驗收：開一個 Gemini CLI session，「管理 session」頁出現它，狀態跟著變化。
