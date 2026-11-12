---
title: 'Story 2.7：Cursor 轉接器'
type: 'feature'
created: '2026-11-12'
status: 'done'
baseline_commit: 'b1aa433808708755f383847a535815183cdcbfcb'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-6-gemini-cli-adapter.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 偵測目前讀 Claude Code 與 Gemini CLI；使用者用 Cursor（IDE 或 cursor-agent CLI）時，它的 agent session 不會出現在面板。

**Approach:** 新增 `cursor` 轉接器，唯讀 `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`（與同資料夾 `subagents/` 底下的檔），用 2.6 的共用 JSONL 核心把紀錄翻成共用事件。

**Decisions（2026-11-12，依本機 12 個 transcript 的結構調查與 Story 2.7 的驗收條件）：**
- 能力表：approval、question 都是 `none`。原本 cursor 的 question 標 `exact` 是錯的：`AskQuestion` 的回答不寫進紀錄，下一筆直接是 assistant。提問類工具 `AskQuestion`；一輪結束 `exact`（有 `turn_ended`）。
- `turn_ended` 的 `status` 為 `error`、`error` 剛好是 `User aborted request` 時是使用者中止：一輪結束，不顯示「出錯了」。其他 `error` 字串是「出錯了」。
- 以 step 為單位寫入，延遲數秒到數十秒，列為已知限制，不適用 2 秒目標。
- 檔案變小（整檔重寫）時從頭重讀，已送過事件的紀錄不再送。
- 顯示名稱由 slug 反查專案資料夾（只用 stat 檢查路徑是否存在，不讀內容），用資料夾名稱；反查不到時用 slug。
- subagent（`<id>/subagents/` 底下的檔）只算父 session 的 `activity`，同 2.6 Gemini。
- 不推測的工具（使用者 2026-11-12 選 A）：`Read`、`Glob`、`Grep`、`SearchConversations`、`GetMcpTools`、`WebSearch`、`UpdateCurrentStep`、`Task`（subagent）。Cursor 一個 step 寫完才寫一筆，這些工具之後常常超過 10 秒才有下一筆；只有 `Shell`、`StrReplace`、`Write`、`CallMcpTool`、`WebFetch` 等可能跳批准的工具推測。
- 寫檔方式（使用者 2026-11-12 選 B）：不先實際觀察，照驗收條件做（附加讀；變小時從頭重讀、跳過已送過的），實機驗收時再確認。若 Cursor 其實是整檔重寫、檔案變大而前段改了，接著讀會讀到半行（健康 `degraded`），列為已知風險。

## Boundaries & Constraints

**Always:**
- 完全唯讀：只開啟 `~/.cursor/projects/*/agent-transcripts/` 底下的 `.jsonl` 來讀；反查名稱只 stat。不寫檔、不執行指令。
- 原生 id 是 `<id>` 資料夾名，`sessionKey` 為 `cursor:<id>`；照 2.4 的規則讀：補讀最後 2 MiB、即時讀、壞行計數（連續 20 行 `degraded`）、`sync.ready`、資料夾不存在為 `missing` 並定期重查。
- 紀錄沒有時間戳：`ts` 一律用檔案修改時間（核心的 `fallbackTs`）。
- claude-code、gemini 的行為與既有測試斷言不變。

**Never:**
- 不開 `~/.cursor/` 底下的其他檔（例如 `cli-config.json`、`agent-cli-state.json`、`argv.json`、`statsig-cache.json`、`ai-tracking/`、`agents/`、`sandbox-policies/`，以及 `projects/*/` 的 `canvases`、`mcps`、`assets`、`agent-tools`、`terminals`），不讀專案資料夾的內容。
- 不讀出或印出真實紀錄的內容；fixture 只能由白名單去識別化腳本產生。
- 不改 8 狀態的條件與優先序、事件契約、判斷層。

## I/O & Edge-Case Matrix

計時值以預設值為例。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 新 session | 新檔寫入 user | 出現 session，名稱為專案資料夾名稱，「思考中」 |
| 呼叫工具 | assistant 含 `tool_use` | 「工作中」 |
| 下一步 | 之後再寫入任何一筆 | 上一筆的工具結束；只有文字的 assistant 是「思考中」 |
| 一輪結束 | `turn_ended` 的 `success` | 「做完了」，5 秒後「等你回覆」 |
| 使用者中止 | `turn_ended` 的 `error` 為 `User aborted request` | 一輪結束，不顯示「出錯了」 |
| 錯誤 | `turn_ended` 的 `error` 為其他字串 | 「出錯了」 |
| 重複的結束 | 連續兩筆 `turn_ended` | 只算一次 |
| 推測批准 | `Shell` 的 `tool_use` 之後 10 秒沒有新紀錄 | 「要你批准」，標「推測」 |
| 推測提問 | `AskQuestion` 之後 10 秒沒有新紀錄 | 「要你決定」，標「推測」 |
| subagent | `subagents/` 底下的檔有新紀錄 | 只更新父 session 的最後事件時間 |
| 整檔重寫 | 檔案變小：前面幾筆相同，後面換成新紀錄 | 只送新紀錄的事件，已送過的不重送 |
| 名稱 | slug 對得到存在的資料夾 | 名稱為該資料夾名；對不到時為 slug |
| 太舊 | 3 小時前修改的檔 | 不出現 |
| 壞行 | 連續 20 行無法解析 | 健康 `degraded` |
| 沒有資料夾 | `~/.cursor/projects` 不存在 | 健康 `missing` |
| 唯讀 | 對 fixture 跑完整個轉接器 | 前後雜湊完全相同 |

</frozen-after-approval>

## Code Map

- `src/main/detection/adapters/jsonl/log-adapter.ts`（共用核心）：新選項 `rereadShrunk?: true`。檔案變小、且不超過 `REPLAY_TAIL_BYTES` 時，從頭讀、沿用已有的翻譯狀態、`replay: false`，跳過與已翻譯紀錄「最長相同前段」的那幾筆（每個檔存已翻譯紀錄每一行的短雜湊）；超過時照舊補讀檔尾。claude-code、gemini 不給。
- `src/main/detection/adapters/cursor/`（新），比照 `gemini/`：
  - `paths.ts`：root 是 `~/.cursor/projects`。主檔 `<slug>/agent-transcripts/<id>/<id>.jsonl`（資料夾名與檔名相同）；subagent `<slug>/agent-transcripts/<id>/subagents/*.jsonl`。資料夾只跟 `<slug>`、`agent-transcripts`、`<id>`、`subagents`；`WATCH_DEPTH = 4`；`mtimeMs` 先轉數字。
  - `project-name.ts`：slug → 名稱。每個 `-` 可能是 `/`、`-`、`_`、`.` 或空白。逐層找：從根開始，這一層的資料夾名稱依序試 1、2、3… 個 token，token 之間試每種非 `/` 分隔字元的組合，stat 確認是資料夾才往下一層；token 全部用完、而且是資料夾，就是答案。深度優先（所以兩個資料夾都符合時取較深的）、最多 stat 512 次，結果依 slug 快取；找到時取最後一段的資料夾名稱。`stat` 可注入以便測試。
  - `translate.ts`（純函式）：狀態記是否送過 `session.start`、上一筆 assistant 開著的工具 id、工具流水號、上一個送出的是不是 `turn.end`。對應見 Design Notes。
  - `cursor.ts`：`createJsonlLogAdapter` 加 `rereadShrunk`；`scan` 先主檔、再 subagent；gate 照 gemini：subagent 等父 session 開始過才讀；模組註解寫已知限制。
- `src/shared/sources.ts:119`（註解）、`:149`（cursor 那一列）：cursor 改為 approval、question 都 `none`，`turnEnd: 'exact'`，questionTools `['AskQuestion']`，noInferTools 照 Decisions；更新註解。
- `src/main/main.ts`：加 `createCursorAdapter({ root: ~/.cursor/projects })`，註解一併更新。
- `scripts/deidentify-cursor.mjs`（新）、`test/fixtures/cursor/`：參數是輸入檔與輸出資料夾，只印計數。白名單：`role`、`type`、`status`；content part 的 `type`；文字換成「範例提示」（user）或「範例回覆」（assistant）；`tool_use` 只留 `name`（Cursor 內建工具名，其他換成 `fixture_tool`），`input` 換成 `{}`；`error` 是 `User aborted request` 時原樣保留，其他換成 `fixture error`。id 重新編號、slug 換成 `fixture-project`。樣本要涵蓋：工具、中止、錯誤、`AskQuestion`、subagent。
- 測試 `test/main/detection-cursor*.test.ts`：用 `test/helpers/jsonl-adapter.ts`。

**不要改：** claude-code、gemini 的行為與既有測試斷言；判斷層（reducer、inference、sessions）。

## Tasks & Acceptance

**Execution:**
- [x] `jsonl/log-adapter.ts`：`rereadShrunk` 與測試（相同前段跳過、前段不同時之後全送、超過 2 MiB 照舊補讀檔尾）。
- [x] `adapters/cursor/`、`sources.ts`、`main.ts`：轉接器、名稱反查、能力表、接線。
- [x] `scripts/deidentify-cursor.mjs`、`test/fixtures/cursor/`：去識別化 fixture，測試裡面沒有 home 路徑、沒有白名單以外的文字。
- [x] 測試：翻譯快照、I/O 矩陣每一列（接 `createDetection` 看狀態）、名稱反查（假的 `stat`）、唯讀雜湊、真 chokidar（append、整檔重寫變小、subagent 資料夾）、BigInt `mtimeMs`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，claude-code、gemini 的測試數不減少。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 本機有 `~/.cursor/projects`，then run log 有 `cursor` 轉接器啟動與同步的紀錄，沒有 `detection` 錯誤，`~/.cursor/projects` 的檔案清單、大小、修改時間前後相同。

## Implementation Notes

- 2026-11-12：規格約 3700 tokens（字數粗估），使用者選擇保留全文；不推測的工具選 A；寫檔方式選 B（不先觀察）。
- 2026-11-12 實作時規格沒寫明、開發代理自行決定的部分：
  - `rereadShrunk` 只在知道檔頭時從頭重讀；第一次就從檔尾讀（超過 2 MiB）的檔，變小時照舊補讀檔尾。每行短雜湊是 sha256 取 12 字元。
  - 重讀時每一行都跟舊的相同，下一次讀還會接著比對（應付「先清空再寫」被讀到中間狀態）。
  - 工具 id `step<n>:<k>`：n 只算有 `tool_use` 的 assistant 筆數，k 是這筆裡第幾個，都從 1 起算；名稱不能用的工具不送事件但保留位置，全部不能用時送 `activity`。
  - `turn_ended`：`status` 是 `error`（中止以外），或不是 `success` 而帶非空白錯誤字串，都算出錯；重複的 `turn_ended` 不再送 `turn.end`，但帶其他錯誤時 `error` 照送。第一筆 user 或 assistant 之前的紀錄不送；不認得的紀錄送 `activity`。
  - 名稱反查依 `/`、`-`、`_`、`.`、空白的順序試，深度優先，所以兩個資料夾都符合時取較深的。Windows 把 slug 第一段當磁碟代號，沒有實際樣本。轉接器多了 `stat`、`platform` 兩個選項給測試注入。
- 2026-11-12 驗證：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`、`CI=true npm test`（58 檔、2528 個測試）全過；刪掉的 `expect(` 為 0；I/O 矩陣 16 列都有測試且都有跑。隔離 `--user-data-dir` 的 `npm start` 由開發代理執行：run log 有 cursor 啟動與 `sync.ready`、沒有 detection 錯誤，`~/.cursor/projects` 前後 470 個項目的 metadata 相同。
- 2026-11-12 審查修補後：名稱反查改為逐層找（代價：單一資料夾名稱有 7 段以上會用完 512 次 stat、退回 slug，已寫進模組註解）；重讀只有清空後才跨讀比對；兩處註解更正；補預設 stat 的真實資料夾測試（win32 跳過）。我重跑四項檢查全過（58 檔、2533 個測試），claude-code、gemini 與判斷層沒有改動。

## Spec Change Log

- 2026-11-12，第 1 輪審查 B5（bad_spec）：
  - **改了什麼：** Code Map 的 `project-name.ts` 搜尋法，從「只在選 `/` 時 stat、深度優先」改成逐層找。
  - **避開的壞狀態：** 選 `-` 之後整棵子樹都在葉子 stat，路徑中段有 `_`、`.`、空白時常超過 512 次，結果顯示 slug。
  - **處理方式（使用者選局部修）：** 不退回全部程式碼重做，只請原開發代理改 `project-name.ts` 與它的測試，同時套用這一輪的 patch。
  - **KEEP：** 其餘已實作並通過檢查的部分，包括共用核心 `rereadShrunk`、translate、paths、cursor、能力表、接線、去識別化腳本與 fixture、測試。

## Review Triage Log

第 1 輪（2026-11-12）：Blind Hunter 11 條（B1–B11）、Edge Case Hunter 9 條（E1–E9）、Verification Gap 1 個缺口＋2 條其他（VG1、VG-O1、VG-O2）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B5 | 名稱反查成本是指數級，路徑中段有 `_`、`.`、空白時常超過 512 次 stat，退回顯示 slug | medium | bad_spec（使用者選局部修，見 Spec Change Log） | 用 `findProjectFolder` 加假 stat 模擬：`/Users/me/code/gundam-pet` 5 次；home 為 `a_b_c` 時 `.../code/my-app` 433 次，`.../code/xx-yyyy-parent` 用完 512 次找不到，`/Users/a.b/work/x-y-z` 也找不到。違反矩陣「名稱」列。根因是 Code Map 指定的搜尋法（選 `-` 後整棵子樹在葉子 stat，`_` 排在 `-` 後面） |
| VG1 | 正式環境用的預設 `stat`／`platform` 沒有測試解析出真實資料夾名稱 | medium | patch | 已預先驗證的缺口：所有名稱測試都注入假 stat；唯一用預設值的 fixture 測試預期的是退回的 slug |
| E1、B1、VG-O2 | 重讀時全部比中後跨讀延續比對：之後內容相同的新行（例如還原後重送同一句提示）被當成舊行跳過，`turn.start` 漏送，沿用的 `turnEnded` 也讓下一個 `turn.end` 漏掉 | low | patch | `readBefore` 在 `before` 非 null 時依位置比對；`before` 只有遇到不同的行才清掉。最小修正：重讀當下檔案不是空的（size > 0）時，重讀結束就停止比對，只有「清空」才跨讀延續 |
| B4 | `SourceCapability.noInferTools` 的註解寫「run long by design」，Cursor 把 `Read`、`Glob`、`Grep` 列進去的理由不同，下一個來源的作者會照錯的定義填 | low | patch | `src/shared/sources.ts` 欄位註解；只改註解（判定層 `inference.ts` 不改） |
| E9 | 已知限制寫「整檔重寫變大、前段改了會讀到半行，健康 `degraded`」，實際只有那半行算壞行，健康通常仍是 `ok`，之後的舊行可能被當新紀錄再送 | low | patch | 壞行要連續 20 行才 `degraded`；半行之後是完整的行。修正 `cursor.ts` 的已知限制說明 |
| B2 | 推測批准／提問假設 assistant 那筆在工具執行、跳批准、`AskQuestion` 被回答之前就寫入；若「step 寫完」包含工具跑完，推測會兩個方向都錯 | maybe-false（若成立 medium） | defer | 結構調查看不出寫入時機。要在 Cursor 觸發一次需批准的 `Shell` 與一次 `AskQuestion`，確認回答前面板就顯示「要你批准」／「要你決定」 |
| B3 | 腳本的 `CURSOR_TOOLS` 有 `TodoWrite`、`ReadLints`、`SemanticSearch`、`LS`（不會跳批准）、`CreatePlan`、`SwitchMode`（可能是提問），不在不推測清單或提問清單 | maybe-false（若成立 medium） | defer | 本機 12 個 transcript 都沒出現這些工具名；名單是開發代理依一般知識列的。實機驗收看到這些工具時，再請使用者決定是否加進清單 |
| B6 | watcher 跟住所有歷史 session 資料夾，數量沒有上限 | maybe-false（若成立 medium） | defer | 共用 `shouldFollow` 對資料夾不看新舊，claude-code 的 `<id>/`、`subagents/` 也一樣（2.4 起），不是這個 story 造成的。要量幾百個資料夾時的 watch handle 數才知道是否有問題 |
| B7 | 補讀到停在 step 中間、最後是可推測工具的 transcript（Cursor 當掉），會一直顯示「要你批准（推測）」直到 session 過期 | low | defer | 2.6 推測機制的既有設計（`inference.ts` 註解：補讀的工具呼叫從回填的開始時間算，同步時就推測），gemini 相同 |
| VG-O1 | 超過 2 MiB 的 transcript 被清空重寫、長回超過 2 MiB 後，2 MiB 以後的舊行會當即時事件再送 | low | reject | 情境成立，但本機 12 個 transcript 最大約 162 KiB、中位數約 12 KiB，離 2 MiB 很遠；修正要改雜湊上限或逐行 replay，不是直接修正 |
| E2 | 整檔重寫時第一行就不同（格式改了），整段歷史當即時事件重送 | low | reject | 照規格「最長相同前段」比對；同一個寫入程式改變序列化方式的機率很低，修正要多一條分支 |
| E3 | 以刪掉再建立的方式重寫，超過 chokidar 合併時間就被當新檔，整檔事件重送 | maybe-false（若成立 low） | reject | 寫檔方式未觀察；即使成立，事件同一批送出，最後狀態仍是最後一筆紀錄的狀態。實機驗收觀察寫檔方式時一併確認 |
| E4 | 整檔重寫後大小剛好等於原位移、內容不同，讀不到 | low | reject | 一直變長的 transcript 重寫後大小剛好相同屬巧合；修正要多記 mtime 或雜湊 |
| E5 | 前 2 MiB 有上百萬行時，每個檔要存上百萬個雜湊 | low | reject | 真實紀錄每行至少約 40 bytes，上限約 5 萬個；本機檔案中位數約 12 KiB，只有數十個雜湊 |
| E6 | 反查名稱碰到網路磁碟時 stat 卡住主程序 | low | reject | 需要專案在斷線的網路磁碟上；提議的時間預算擋不住單一次卡住的 stat |
| E7 | `turn_ended` 的 `error` 是物件、`status` 不是 `error` 時不算出錯 | low | reject | 結構調查 14 筆 `error` 都是字串且 `status` 為 `error` |
| E8 | 第一次從檔尾讀（超過 2 MiB）的檔縮小後整檔以 replay 再送，與「不再送」的說法不符 | low | reject | replay 事件只當歷史套用，最後狀態一致；本機沒有超過 2 MiB 的檔；不知道檔頭就無法比對，修正不是直接修正 |
| B8 | 檔案被截短又沒有新行時，被截掉那筆開著的工具不會關 | maybe-false（若成立 low） | reject | 截短是否發生未觀察；通常截短（還原）發生在一輪結束後，沒有開著的工具 |
| B9 | 舊版 `<id>.txt` transcript 被靜默忽略 | low | reject | 意圖只讀 `.jsonl`（Boundaries） |
| B10 | 去識別化腳本沒有檢查 `--out`、不清舊輸出、同 id 會覆蓋 | low | reject | 開發者手動執行、參數明確；加防護是新增分支 |
| B11 | 重複的 `turn_ended` 帶非中止錯誤時，做完了的一輪會翻成「出錯了」 | maybe-false（若成立 low） | reject | 照 2.4／2.6 的規則（重複的結束不再送 `turn.end`，但錯誤照送）；本機 6 次連續結束都是 success 接中止，沒有樣本說明哪種處理才對 |

## Design Notes

**結構調查（2026-11-12，本機 12 個 transcript、320 行，只看欄位名、種類、數量）。** 每行是 `{role, message: {content: [...]}}`（user 57 行、assistant 207 行）或 `{type: 'turn_ended', status, error?}`（56 行）。user 的 content 只有 `text`；assistant 有 `text`、`tool_use`（`{type, name, input}`，沒有 id），一筆最多 8 個 `tool_use`。沒有 tool_result、沒有時間戳、沒有權限紀錄。`turn_ended` 的 `error` 14 筆，12 筆是 `User aborted request`。每個檔第一筆是 user、最後一筆是 `turn_ended`；連續兩筆 `turn_ended` 出現 6 次。`AskQuestion` 之後是 assistant，回答不寫進紀錄。subagent 在 `<id>/subagents/<另一個 id>.jsonl`。slug 是路徑把非英數字元換成 `-`，3 個 slug 有 2 個反查得到。

| 紀錄 | 事件 |
|---|---|
| 第一筆 user 或 assistant | 先送 `session.start` 與名稱的 `session.meta` |
| user | 上一筆 assistant 開著的工具 `tool.end`；`turn.start` |
| assistant | 上一筆 assistant 開著的工具 `tool.end`；每個 `tool_use` 送 `tool.start`（`toolCallId` = `step<流水號>:<第幾個>`，`toolName` = `name`）；沒有 `tool_use` 時送 `activity` |
| `turn_ended` 的 `success`、或 `error` 為 `User aborted request` | `turn.end`（同時關掉開著的工具） |
| `turn_ended` 的其他 `error` | `error`＋`turn.end` |
| subagent 檔的每一行 | 父 session（`cursor:<id>`）的 `activity` |

連續的 `turn.end` 只送第一個（同 2.4）。轉接器送的事件都是 `via: log`、`confidence: exact`。

**已知限制。**
- 以 step 為單位寫入，狀態延遲數秒到數十秒。
- 可能跳批准的工具之後，模型想超過 10 秒也會被推測成「要你批准」。
- 紀錄沒有時間戳：補讀時同一個檔的事件都算在檔案的修改時間。
- 沒有 session 結束訊號，關掉 Cursor 後照逾時結束。
- 寫檔方式沒有實際觀察過：若是整檔重寫且檔案變大、前段改了，接著讀會讀到半行。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。

**Manual checks:**
- 開發代理：`--user-data-dir` 隔離執行 `npm start`，看 run log；執行前後比對 `~/.cursor/projects` 的檔案清單、大小與修改時間；不截圖、不碰使用者的 app，只比 metadata。
- 使用者驗收：在 Cursor 開一個 agent session，「管理 session」頁出現它，狀態跟著變化。
