---
title: 'Story 2.6：Gemini CLI 轉接器'
type: 'feature'
created: '2026-11-11'
status: 'done'
baseline_commit: 'abcad49596e9d52337d268c32dcf4236d577ec0c'
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
- 能力表：approval、question 都是 `none`。原本 gemini 的 question 標 `exact` 是錯的：`ask_user` 要等使用者回答後才寫進紀錄。提問類工具 `ask_user`，不推測的工具沒有。Gemini 的工具要整批完成才寫進紀錄，寫在 `sources.ts` 的註解，不加能力表欄位（使用者 2026-11-11 決定：沒有程式會讀）。能力表這一列與「一輪結束」欄位由 `spec-2-6-turn-end-inference.md` 先改。
- 拆分（使用者 2026-11-11 決定）：推測一輪結束（`turn.reply`、推測的 `turn.end`、能力表「一輪結束」欄位）拆成 `spec-2-6-turn-end-inference.md` 先做；本規格只做 Gemini 轉接器本體。
- subagent（`chats/<父 session id>/` 底下的檔）只算父 session 的 `activity`：它的工具同樣要完成才寫，算成工具也看不到「工作中」。
- 只有開過、沒有任何對話（只有 `info`）的 session 不顯示，與 Claude Code、Codex 在第一個提示之後才有紀錄一致。
- 一輪結束（使用者 2026-11-11 選 B）：Gemini 不寫「一輪結束」，有文字的回覆寫入後 10 秒（`TURN_END_INFER_MS`，常數，不開放調整）沒有新紀錄，才推測這一輪結束。真的結束時「做完了」會晚 10 秒，換來「說完話接著呼叫工具」時不會誤閃「做完了」。
  - 事件契約加一種事件 `turn.reply`（「寫完一則可能結束這一輪的回覆」），`turn.end` 可以是推測的；推測仍只在 `inference` 一處產生。
  - 能力表加「一輪結束」欄位：gemini 為 `none`（推測），其他來源為 `exact`；只對 `none` 的來源推測。
  - 推測出來的一輪結束，之後的「做完了」「等你回覆」都標「推測」，直到下一個開始或結束一輪、開始工具、結束 session 的事件（照 `spec-2-6-turn-end-inference.md`；使用者 2026-11-11 決定對齊）。

## Boundaries & Constraints

**Always:**
- 完全唯讀：只開啟 `~/.gemini/tmp/*/chats/` 底下的 `.jsonl` 來讀。不寫檔、不執行指令。
- 原生 id 是檔案第一行（header）的 `sessionId`，`sessionKey` 為 `gemini:<sessionId>`；每個檔先讀第一行（最多 1 MiB），之後照 2.4 的規則讀：補讀最後 2 MiB、即時讀、變小重讀、壞行計數（連續 20 行 `degraded`）、`sync.ready`、資料夾不存在為 `missing` 並定期重查。
- 對應照 Design Notes 的表；`ts` 取訊息的 `timestamp`。
- 顯示名稱：最新的 `$set.summary` 優先，否則用專案資料夾名稱（`tmp/` 底下那一層）。
- 擴充共用核心（先讀第一行、依第一行決定 session）時，claude-code 的行為與測試不變。例外（使用者 2026-11-11 決定）：chokidar 會丟掉同一個檔 50 ms 內的第二次 `change`，共用核心在每次因變動讀檔後約 100 ms 再補讀一次該檔，claude-code 一併修正；既有測試的斷言仍不改。

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

- `src/main/detection/adapters/jsonl/log-adapter.ts`（共用核心，`e06dde2`）：
  - 新選項 `startState?(first: Fields | null, context: ReadContext<Where>): State | null`：有給時，檔案第一次追（`files` 裡沒有）先讀開頭最多 `FIRST_LINE_MAX_BYTES` 的第一行交給它，回傳值當初始狀態；回傳 null 就不追、不送事件，下次變動再試。沒給時照舊用 `initialState`（claude-code 不給）。
  - 回呼防護（deferred-work 的 E1～E4）：`follow` 丟→不跟；`scan` 丟→當成沒有檔，照樣送 `sync.ready`；`locate`／`gate.allows`／`startState` 丟→跳過該檔；`translate` 丟→算一行壞行，繼續下一行；`nameEvent`、`gate.read` 丟→已讀到的事件照送。log 只記錯誤代碼。
- `src/main/detection/adapters/gemini/`（新），比照 `claude-code/`：
  - `paths.ts`：root 是 `~/.gemini/tmp`。主檔 `<專案>/chats/session-*.jsonl`；subagent `<專案>/chats/<父 session id>/*.jsonl`。資料夾只跟 `<專案>`、`chats`、`chats/<id>`；`watchedKind`＋共用 `shouldFollow`；`WATCH_DEPTH = 3`（與 claude-code 的 subagent 同深度）。`mtimeMs` 照 2.4 先轉數字。
  - `translate.ts`（純函式，比照 `claude-code/translate.ts`）：狀態記目前 `sessionId`、是否送過 `session.start`、summary、專案資料夾名、最後一則 `gemini` 的 id 與它有沒有送 pending、上一個送出的是不是 `turn.end`、最新的 `ts`。`ts` 取該行 `timestamp`，沒有的行（`$set`）用最新的，再沒有用 `fallbackTs`。header 行的 `sessionId` 與目前相同時不送事件（從頭讀時會再讀到）。
  - `gemini.ts`：`createJsonlLogAdapter` 加 `startState`（第一行是有 `sessionId` 的 header 才追）；`scan` 先主檔、再 subagent；gate 照 claude-code：subagent 等父 session（`gemini:<資料夾名>`）開始過才讀，每行只送父 session 的 `activity`。模組註解寫 Design Notes 的已知限制。
- 已由 `spec-2-6-turn-end-inference.md`（`abcad49`）完成：`turn.reply`、能力表 gemini 那一列與「一輪結束」欄位、推測一輪結束、面板「推測」的提示文字。這裡只送 `turn.reply`。
- `src/shared/constants.ts`：`FIRST_LINE_MAX_BYTES = 1024 * 1024`。
- `src/main/main.ts:172-179`：加 `createGeminiAdapter({ root: ~/.gemini/tmp })`；只提 Claude Code 的註解（:11、:34-35、:172、:243）一併更新。
- `scripts/deidentify-gemini.mjs`（新）：參數是輸入檔與輸出資料夾，只印計數。開發代理對 `~/.gemini/tmp/*/chats/session-*.jsonl` 跑，產生 `test/fixtures/gemini/`（多輪、工具、拒絕批准、只有 `info`）。白名單：header 的 `kind`；訊息的 `type`、`id`、`timestamp`；內容只留「是否為空」「是否為 `functionResponse`」，非空文字換成「範例回覆」，`Request cancelled.` 原樣保留；`toolCalls` 只留 `id`、`name`、`status`、`timestamp`；`$set` 只留鍵名，`summary` 換成「範例標題」，`messages` 換成空陣列。id 重新編號、時間平移、`projectHash` 換固定值、專案資料夾換成 `fixture-project`、檔名重新命名。樣本沒有的情境（錯誤、Esc、subagent、summary、`$set.sessionId`）在翻譯測試用手寫的行。
- 測試 `test/main/detection-gemini*.test.ts`：用 `test/helpers/jsonl-adapter.ts`。

**不要改：** claude-code 的行為與既有測試斷言；8 狀態的條件與優先序；判斷層（reducer、inference、sessions）；`sessions` 丟掉轉接器送來的推測事件。

## Tasks & Acceptance

**Execution:**
- [x] `jsonl/log-adapter.ts`、`constants.ts`：`startState` 與回呼防護，各加測試（每種回呼丟例外一個）。
- [x] `adapters/gemini/`、`main.ts`：轉接器與接線。
- [x] `scripts/deidentify-gemini.mjs`、`test/fixtures/gemini/`：去識別化 fixture，並測試裡面沒有 home 路徑、沒有白名單以外的文字。
- [x] 測試：翻譯快照、I/O 矩陣每一列（接 `createSessions` 看狀態）、唯讀雜湊、真 chokidar（append、同 id 重寫、舊檔被寫入、subagent 資料夾）、BigInt `mtimeMs`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，claude-code 的測試數不減少。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 本機有 `~/.gemini/tmp`，then run log 有 `gemini` 轉接器啟動與同步的紀錄，沒有 `detection` 錯誤，`~/.gemini/tmp` 的檔案清單、大小、修改時間前後相同。

## Implementation Notes

- 2026-11-11：使用者決定拆開，先做前置重構 `spec-2-6-jsonl-adapter-core.md`；已完成（`e06dde2`，CI macOS／Windows 通過）。
- 2026-11-11：使用者決定再拆一次：推測一輪結束拆成 `spec-2-6-turn-end-inference.md` 先做，已完成（`abcad49`）；能力表「工具何時寫入」欄位不加。
- 2026-11-11：規格約 4400 tokens（字數粗估），使用者選擇保留全文，不再拆出回呼防護。

- 2026-11-11 開發代理的解讀（規格沒寫明的部分）：
  - 空回覆的佔位工具（`pending:<id>`）除了同 id 帶 `toolCalls` 重寫，遇到另一個 id 的 `gemini`、新的使用者提示、一輪結束也會關掉，避免永遠「工作中」。
  - 第一則 `user`／`gemini` 之前的 `info`、`error` 等都不送（「只開沒問」不出現）；檔案中間出現 `sessionId` 不同的 header 當成 `$set.sessionId`。
  - subagent 檔也要有 header 才追；除了自己的 header，每一行（含 `$set`）都算父 session 的 `activity`。
  - 去識別化腳本：`$set` 除了 `summary`、`messages`、`sessionId` 一律換成 null；工具名只留 Gemini 內建清單，其他換成 `fixture_tool`；非文字的內容 part 換成 `{}`。log 把 root 叫做 `tmp folder`。
- 審查後加的共用核心補讀（D1，使用者選 A）：每次因變動讀檔後 `TRAILING_READ_MS`（100 ms）再補讀一次，每個檔一個計時器、停止與資料夾消失時取消；拿掉補讀時，新的真 chokidar 測試（兩次寫入相隔數 ms）停在「工作中」。claude-code 的測試檔與 `test/helpers/` 從 `abcad49` 起沒有改動。
- 主 session 驗證（全部修補後）：typecheck、lint、depcruise（0 違規）、`CI=true npm test`（53 個檔案、2376 個測試）全過；diff 沒有刪掉的 `expect(`。fixture 的所有值逐一列出確認只有佔位值。
- 開發代理實機：隔離 `--user-data-dir` 跑 `npm start`，run log 有 `gemini: started`、`replayed 0 transcripts … (0 sessions, 0 subagents; 3 transcripts in all); sync.ready`、`gemini: stopped`，沒有 `detection` 錯誤；`~/.gemini/tmp` 的 metadata 前後相同。本機 3 個 chat log 都在補讀時間範圍外，即時讀只有測試驗證過。
- 使用者驗收（開一個 Gemini CLI session 看「管理 session」頁）還沒做。
- sprint 狀態：Story 2.6 三份規格（前置重構、推測一輪結束、本份）都完成，`2-6-gemini-cli-轉接器` 設為 `review`，等 commit 後 CI 通過再設 `done`。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-11）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap，D＝開發代理自己回報。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| D1 | chokidar 對同一個檔 50 ms 內的第二次 `change` 直接丟掉，該次寫入要等下一次寫入才讀到 | medium | patch | `node_modules/chokidar/index.js:525` 的 `_throttle(EV.CHANGE, path, 50)`，被節流的事件不補送；開發代理重現 3 次。fixture 裡快速工具的重寫只比空 `gemini` 晚 17～20 ms，矩陣「工具做完 → 回思考中」實際會停在「工作中」。claude-code 也受影響（2.4 審查 E12 當時駁回）；修共用核心會改到 claude-code 的行為，與 Boundaries 衝突，交使用者決定：使用者選 A（核心補讀，兩個來源都修），寫進 Boundaries 的例外。 |
| VG1 | Gemini 的 `gate.reset` 沒有測試 | low | patch | 預先驗證的缺口：把 `reset` 改成空函式，Gemini 與核心測試都不會失敗；照 `detection-claude-code.test.ts:865` 補一個。 |
| B2／E2 | 第一行完整但 `startState` 回 null 的檔被默默略過，沒有 log、健康仍是 `ok` | medium | patch | `log-adapter.ts` 的 `startState` 分支直接 `return`；Gemini CLI 改了 header 格式時整個轉接器什麼都不顯示，也查不出原因。每個檔記一次（只記代碼）。 |
| B5 | 工具結果的事件用訊息的 `timestamp`，不用 `toolCalls[].timestamp` | low | patch | 補讀時 `lastEventAt` 依 `ts` 回推；長工具（build）的重寫帶的是模型訊息的時間，session 會被回推得太早而提早變「休息中」。改用呼叫裡最晚的時間是直接修正。 |
| B9 | 沒有文字也沒有工具的模型回覆，佔位工具一直開著，已知限制沒寫 | low | patch | 只補模組註解的已知限制（`gemini.ts`）：「工作中」→ 推測「要你批准」，直到下一個提示。 |
| B10／E9 | 去識別化腳本的 header id 依出現順序編號，檔名用第 n 個；註解引用不存在的常數 | low | patch | 前面的輸入有 `$set.sessionId` 或兩個輸入 id 相同時，重產的 fixture 檔名與 header 不一致，測試會莫名失敗；先把每個輸入的 header id 依序編號。 |
| E12 | 去識別化腳本讀不到輸入檔時，未捕捉的錯誤會印出路徑 | low | patch | 與「只印計數」矛盾，路徑含專案資料夾名；改成印 `input N: 代碼`。 |
| E11 | 去識別化腳本把空白或非字串的 `$set.summary` 也換成「範例標題」 | low | patch | fixture 會多出真實紀錄沒有的改名；只替換非空字串。 |
| B4／VG-O1 | 只補讀檔尾 2 MiB 時，檔尾之前的 `$set.summary`、`$set.sessionId` 讀不到 | medium | defer | 名稱退回專案資料夾名；`$set.sessionId` 之後的事件掛在舊 id。來自 2.4 起的「補讀最後 2 MiB」規則，claude-code 檔尾之前的名稱紀錄同樣讀不到；真正的修法要另外掃 `$set` 行。這次在 `gemini.ts` 已知限制補一句（併入 B9 的 patch）。 |
| B7 | `error` 一定結束這一輪，可能與 Gemini CLI 的自動重試衝突 | maybe-false（若成立 medium） | defer | 本機樣本沒有 `error`；要一筆「出錯後自動重試」的真實紀錄才能確定 `error` 之後還會不會有同一輪的回覆。 |
| B1 | `firstRecord` 每次讀到 1 MiB、新檔重讀一次 | low | reject | 只在檔案第一次被追時讀，或 header 永遠無效的檔每次變動時讀；一般 header 只有幾百 bytes，影響可忽略，改成漸進讀要加迴圈。 |
| B3 | 回呼丟例外時健康不變、只記一次；`scan` 丟時舊檔會從頭讀；`gate.read` 丟時 subagent 被擋 | low | reject | 照 deferred-work E1～E4 的決定（記代碼、跳過）；Gemini 的 `scan` 只用不會丟的 `list`，`gate.read` 不會丟，後兩種走不到。 |
| B6 | 沒有真實的 subagent fixture | low | reject | 本機沒有 subagent 樣本；subagent 的 header 依 Gemini CLI 原始碼，規格指定用手寫的行。 |
| B8 | `$rewindTo` 什麼都不送 | low | reject | Design Notes 的表指定「不送」；rewind 後使用者的下一個提示會送 `turn.start`。 |
| B11 | 去識別化腳本的 `main()` 沒有測試 | low | reject | 提交的 fixture 每次 CI 都用白名單檢查（`fixtureProblems`），洩漏會被擋下；腳本只在本機手動跑。 |
| B12／E7 | 父 session 結束後 subagent 再寫入，會重建沒有名字的父 session | low | reject | subagent 的 activity 會讓父 session 一直不逾時；換了 session id 之後舊 session 的 subagent 不會再跑。 |
| E1 | 第一行前有空行或 BOM 時永遠不追 | low | reject | Gemini CLI 以 JSON Lines 附加寫入、第一行就是 header；本機 3 個檔都是。 |
| E3／E4 | 檔案變小或被重寫時不重跑 `startState`；從頭重讀 header 會切回舊 id | low | reject | Gemini CLI 只附加寫入，沒有觀察到檔案變小；只有刪檔（空 session、30 天清理）。 |
| E6 | `toolCalls` 的狀態不是結束狀態時也當成已結束 | false | reject | 依原始碼，`toolCalls` 只在整批結束後才寫；樣本裡只有 `success`、`cancelled`。 |
| E8 | `session-*.jsonl` 的 header `kind` 不是 `main` 時仍當主 session | low | reject | subagent 的檔在 `chats/<父 id>/` 底下、檔名不同；`session-*.jsonl` 都是主檔。 |
| E10 | 去識別化腳本把不在第一行的 header 變成 `{}` | low | reject | 樣本沒有檔案中間的 header；`fixtureProblems` 會擋下不合白名單的行。 |
| E13 | 10 秒延遲擋不住工具超過 10 秒時的「做完了」 | false | reject | 已列在 Design Notes 與 `gemini.ts` 的已知限制，是使用者選 B 時接受的取捨。 |

## Design Notes

**紀錄 → 事件。** 依本機 3 個檔的結構調查（只看欄位名、種類、數量）與 Gemini CLI v0.52.0 原始碼（`packages/core/src/services/chatRecordingService.ts`、`cli/src/ui/hooks/useGeminiStream.ts`）：`gemini` 訊息在模型串流結束後才寫一次；工具只有整批完成（`success`／`error`／`cancelled`）後，才以同一個 id 重寫該訊息並加上 `toolCalls`；等批准、執行中都不寫；沒有「一輪結束」的紀錄。

| 紀錄 | 事件 |
|---|---|
| header（第一行） | 不送；`startState` 記下 `sessionId` |
| 第一則 `user` 或 `gemini` 訊息 | 先送 `session.start` 與名稱的 `session.meta` |
| `user`，內容不是 `functionResponse` | `turn.start` |
| `gemini`，沒有 `toolCalls`、內容為空 | `tool.start`（`toolCallId` = `pending:<訊息 id>`，`toolName` = `pending`） |
| `gemini`，沒有 `toolCalls`、內容不是空的 | `turn.reply` |
| `gemini` 帶 `toolCalls`（同 id 重寫） | 有 pending 時先送它的 `tool.end`；每個呼叫送 `tool.start`＋`tool.end`；有任一個不是 `cancelled` 時再送 `turn.start`（模型會接著回應；推測已結束這一輪時以此重新開始，一輪中重送無副作用） |
| `info` 的 `Request cancelled.` | `turn.end` |
| `error` | `error`＋`turn.end` |
| `$set.summary` | `session.meta` |
| `$set.sessionId` 與目前不同 | 舊 session `session.end`，新 session 從下一則訊息開始 |
| 其他訊息（`user` 的 `functionResponse`、其他 `info`、`warning`） | `activity` |
| 其他 `$set`、`$rewindTo` | 不送 |

連續的 `turn.end` 只送第一個（同 2.4）。轉接器送的事件都是 `via: log`、`confidence: exact`。

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
