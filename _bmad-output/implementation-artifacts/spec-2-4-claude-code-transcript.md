---
title: 'Story 2.4（上）：Claude Code 轉接器（transcript）'
type: 'feature'
created: '2026-11-11'
status: 'done'
baseline_commit: '07ea4983fbb813b16357b4ee8d132e88dcdc23ff'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-demo-sessions-panel.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 偵測已經接進 app，但目前只有示範轉接器，使用者自己的 Claude Code session 不會出現在面板。

**Approach:** 新增 `claude-code` 轉接器，以唯讀方式讀 `~/.claude/projects/` 底下的 transcript（`.jsonl`），把紀錄翻譯成共用事件。啟動時補讀最近的紀錄，之後跟著檔案增長即時讀。

**Decisions（2026-11-11）：**
- Story 2.4 拆成兩段，本段只做 transcript。狀態檔那段（精確的「要你批准」、行程結束）要先取得一份「停在批准畫面」的樣本，已記在 deferred-work。
- 在狀態檔那段完成前，`claude-code` 的能力表改為 approval、question 都是 `none`：「要你批准」「要你決定」先靠推測。
- 能力表新增「不推測的工具」清單。這些工具本來就會跑很久，跑再久也不推測成「要你批准」。`claude-code` 的清單沿用原型：`Agent`、`Task`、`Workflow`、`WebSearch`、`Monitor`、`TaskOutput`、`ScheduleWakeup`。
- 審查後（2026-11-11，使用者決定）：
  - `WebFetch` 移出不推測清單，因為它第一次連某個網域會問批准。代價是超過 10 秒的 `WebFetch` 也會被推測成「要你批准」。
  - subagent 的工具開始、結束算在父 session 上，也會推測。代價是 subagent 裡跑很久的 `Bash` 也會被推測成「要你批准」。

## Boundaries & Constraints

**Always:**
- 完全唯讀：只開啟 `~/.claude/projects/` 底下的 `.jsonl` 檔來讀。不寫任何檔、不讀 `*.key`、不連任何 socket、不執行任何指令；`main/detection/adapters` 由 depcruise 禁止 import `child_process`。
- 寬鬆解析：未知欄位放行；壞行跳過並計數，絕不丟例外。連續 20 行壞行就把健康標為 `degraded`，之後讀到好的紀錄恢復 `ok`。
- 原生 id 是 transcript 的檔名（UUID），`sessionKey` 為 `claude-code:<UUID>`。`<UUID>/subagents/` 底下的紀錄歸屬父 session：其中的工具開始、結束送成父 session 的 `tool.start`／`tool.end`，其他紀錄只算 `activity`。紀錄裡的 `sessionId` 不拿來分 session。
- 紀錄與事件的對應照 Design Notes 的表。`ts` 取紀錄的 `timestamp`；沒有 `timestamp` 的紀錄，用同一個檔案目前最新的 `timestamp`。
- 啟動補讀：只補讀最後修改在 `discoveryWindowMs` 內的 transcript，每個檔只讀最後 2 MiB（`REPLAY_TAIL_BYTES`），事件標 `replay: true`。全部補讀完送 `sync.ready`。
- 即時讀：檔案增長時，從上次讀到的位置讀到結尾，不完整的最後一行留到下次。
  - 沒追蹤過的檔：啟動後才新建的，從頭讀；原本就存在的（例如 `--resume` 了舊 session），先補讀最後 2 MiB 再接著讀。
  - 檔案變小時，記一筆紀錄，從最後 2 MiB 重新補讀。
- 一次讀檔產生的事件整批交給偵測，面板只更新一次，不會閃過中間狀態。
- `~/.claude/projects/` 不存在時，健康為 `missing`，不丟例外。

**Never:**
- 不讀 `~/.claude/sessions/`，不偵測行程結束。`/clear` 之後舊 session 照逾時規則結束。
- 測試資料不得含真實內容：fixture 只能由去識別化腳本以白名單產生。開發過程不得讀出或印出真實 transcript 的內容；挑選要轉成 fixture 的檔案時，只能用結構查詢（紀錄種類、欄位名、工具名、數量）。
- 不改判斷器的條件表與優先序。

## I/O & Edge-Case Matrix

計時值以預設值為例。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 新 session | 新的 transcript 寫入使用者提示 | 面板出現該 session，名稱為工作資料夾的名字，狀態為「思考中」 |
| 工具 | `tool_use`，之後 `tool_result` | 「工作中」，回到「思考中」 |
| 一輪結束 | `stop_reason: end_turn` | 「做完了」，5 秒後「等你回覆」 |
| 中斷 | 使用者按 Esc 留下的中斷紀錄 | 視為一輪結束 |
| API 錯誤 | `isApiErrorMessage` 的紀錄 | 「出錯了」 |
| 推測批准 | `Bash` 的 `tool_use` 10 秒沒有 `tool_result` | 「要你批准」，標「推測」 |
| 不推測的工具 | `Agent` 跑了 10 分鐘 | 維持「工作中」 |
| 提問工具 | `AskUserQuestion` 10 秒沒有結果 | 「要你決定」，標「推測」 |
| subagent | `subagents/` 底下的檔有新紀錄 | 只更新父 session 的最後事件時間，不另出現 session |
| subagent 的工具 | subagent 裡的 `Bash` 10 秒沒有 `tool_result` | 父 session 顯示「要你批准」，標「推測」 |
| `/clear` | 同一資料夾出現新 UUID 的 transcript | 新的 session；舊的照逾時規則結束 |
| 標題 | `custom-title` 紀錄 | 名稱改為該標題 |
| 啟動補讀 | 1 小時前修改、最後停在 `tool_use` 的 transcript | 同步後發布時就是「要你批准」（推測） |
| 太舊的紀錄 | 3 小時前修改的 transcript | 不出現 |
| 壞行 | 連續 20 行無法解析 | 健康 `degraded`，其他紀錄照常處理 |
| 沒有資料夾 | `~/.claude/projects/` 不存在 | 健康 `missing` |
| 唯讀 | 對 fixture 資料夾跑完整個轉接器 | 前後雜湊完全相同 |

</frozen-after-approval>

## Code Map

- `src/main/detection/adapters/claude-code/`（新資料夾）：
  - 純函式的「紀錄 → 事件」翻譯（可單獨做快照測試）；
  - 讀檔：補讀最後 N bytes、從位置讀到結尾、保留不完整的最後一行；
  - 監看：chokidar 5.0.0（要以 `npm install --save-exact chokidar@5.0.0` 加進 dependencies，架構已指定版本）。
  - 根目錄、fs、watcher、計時器都可注入。測試一律指向 fixture 或暫存資料夾，不碰真實的 `~/.claude`。
  - 寫法比照 `adapters/demo/demo.ts`：只透過注入的 `emit` 送事件，記錄只寫代碼與數量，不寫內容與路徑。
- `src/main/detection/detection.ts`：
  - `DetectionOptions` 加可注入的轉接器清單，預設為空；測試不會啟動真的轉接器。
  - 轉接器回報健康（`ok`／`degraded`／`missing`），寫進 `adapters` 區段。
  - 一批輸出交給 `sessions.receive` 時包在既有的 `batch()` 裡。
- `src/main/main.ts`：建立偵測時傳入以真實 home 目錄建立的 `claude-code` 轉接器；`before-quit` 停止時一併關掉 watcher。
- `src/shared/sources.ts`：
  - `SourceCapability` 加 `noInferTools: readonly string[]`；
  - `claude-code` 改為 approval、question 都是 `none`，提問類工具維持 `AskUserQuestion`、`ExitPlanMode`，不推測的工具照 Decisions。
- `src/main/detection/inference.ts`：在 `noInferTools` 裡的工具不推測。
- `src/shared/constants.ts`：`REPLAY_TAIL_BYTES = 2 * 1024 * 1024`、`BAD_LINE_STREAK_DEGRADED = 20`。
- `.dependency-cruiser.cjs`：比照既有的 `src-no-network-modules`，加一條規則，禁止 `src/main/detection/adapters` import `(node:)?child_process`。
- `src/panels/index.css`：`degraded` 改用另一個警告色，不再與 `missing` 同色（2.3 審查 B13）。
- `scripts/deidentify-claude-code.mjs`（新）：以白名單把真實 transcript 轉成 fixture。
  - 只保留：`type`、`subtype`、`isMeta`、`isCompactSummary`、`isSidechain`、`isApiErrorMessage`、`message.role`、`message.stop_reason`，以及內容區塊的 `type`、`id`、`name`、`tool_use_id`。
  - 中斷紀錄的固定文字保留；`timestamp` 平移到固定起點；`uuid` 與工具 id 重新編號；標題換成「範例標題」；`cwd` 換成 `/fixture/project`。
  - 其他一律丟掉。
- `test/fixtures/claude-code/`：由上面的腳本產生，要涵蓋：
  - 一般的一輪；
  - 工具；
  - 中斷；
  - subagent；
  - `/clear` 後的兩個 transcript；
  - `AskUserQuestion`；
  - API 錯誤。

  另加一個測試，確認 fixture 裡沒有 `/Users/`、`/home/`、`C:\\Users` 這類路徑。
- 測試：`test/main/detection-claude-code*.test.ts`。
  - 翻譯：fixture → 共用事件的快照；
  - 讀檔與監看：用暫存資料夾與假 watcher；
  - I/O 矩陣每一列；
  - 唯讀：把 fixture 複製到暫存資料夾，跑完轉接器後比對雜湊。

## Tasks & Acceptance

**Execution:**
- [x] `package.json`：加 `chokidar` 5.0.0（確切版本）。
- [x] `src/shared/sources.ts`、`constants.ts`、`src/main/detection/inference.ts`：能力表、不推測的工具、常數。
- [x] `src/main/detection/adapters/claude-code/`：翻譯、讀檔、監看、健康。
- [x] `src/main/detection/detection.ts`、`src/main/main.ts`：注入與接線。
- [x] `.dependency-cruiser.cjs`、`src/panels/index.css`：禁止 `child_process`、警告色。
- [x] `scripts/deidentify-claude-code.mjs`、`test/fixtures/claude-code/`：去識別化 fixture。
- [x] 測試：見 Code Map。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 有正在執行的 Claude Code session，then 啟動後 run log 有 `claude-code` 轉接器啟動與同步的紀錄，沒有 `detection` 錯誤。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - 檔案結構：`adapters/claude-code/` 分成 `translate.ts`（純函式翻譯）、`read.ts`（讀檔、分行、補讀起點）、`paths.ts`（哪些路徑是 transcript、watcher 要跟哪些）、`watcher.ts`（chokidar 包裝，可換成假的）、`claude-code.ts`（轉接器本體）。轉接器與偵測之間的介面另放 `src/main/detection/adapter.ts`（`DetectionAdapter`、`AdapterContext`），避免轉接器 import `detection.ts`。
  - `AdapterContext.emit(outputs, health?)`：一次讀檔的事件與健康變化一起交出，偵測包在一個 `batch()` 裡，面板只收到一次通知。`timings`、`wallNow` 也由偵測提供，與 sessions 用同一個牆鐘。轉接器沒有任何計時器，所以沒有注入 `setTimer`。
  - 只認兩種路徑：`<cwd>/<UUID>.jsonl`（session）與 `<cwd>/<UUID>/subagents/*.jsonl`（subagent）。其他 `.jsonl`（例如非 UUID 檔名）一律不開。
  - 「啟動後才新建」與「原本就存在」的判斷：初次掃描時把所有 transcript 路徑（不論新舊）記下來；之後第一次讀到的檔，在名單裡、或已經大於 2 MiB，就從最後 2 MiB 補讀、標 `replay: true`；其餘才從頭即時讀。沒有用檔案的 birthtime（各平台不一致）。watcher 初次掃描完成前報的變化一律忽略，由補讀涵蓋。
  - 之後才補讀的檔（`--resume`、檔案變小）事件也標 `replay: true`；這是 Design Notes「批次內推測先發生又被 tool.end 關掉」成立的前提。
  - watcher 只跟「最後修改在 `discoveryWindowMs` 內」的 transcript（資料夾一律跟）。舊檔不佔 watch handle；它被寫入時，所在資料夾的 watcher 會重新列出內容，chokidar 以 `add` 回報，轉接器照「原本就存在」補讀。實測本機 778 個 transcript：全跟要約 800 個 fd，只跟近期的只要個位數。
  - 根目錄：先以 realpath 解析（支援以符號連結指向別處的 projects 資料夾）再監看。啟動時不存在：健康 `missing`、立刻送 `sync.ready`；執行中被刪除（chokidar 會報 `unlinkDir`，之後就不再有事件）：關掉 watcher、健康 `missing`。兩種情況都每 `RECORDS_FOLDER_RECHECK_MS`（30 秒，計時器由偵測經 `AdapterContext` 提供）檢查一次，出現後重新監看，並照啟動時的方式掃描、補讀（`replay: true`，不再送第二次 `sync.ready`）。不監看 `~/.claude` 本身。
  - 健康由三個條件組成：根目錄不存在 → `missing`；最近連續 20 行壞行（跨檔累計），或 watcher 無法啟動、或執行中回報錯誤（到重新監看為止）→ `degraded`；否則 `ok`。`ok` 在 watcher 啟動成功後才回報；watcher 無法啟動時記 error、仍做一次補讀並送 `sync.ready`。`start()` 丟例外的轉接器，偵測把它的健康記為 `degraded`。
  - 壞行＝不是 JSON 物件的行。空行、補讀起點被切掉的半行不算壞行。
  - subagent（使用者 2026-11-11 決定）：`tool_use`／`tool_result` 送成父 session 的 `tool.start`／`tool.end`（同樣會推測）；其他紀錄是父 session 的 `activity`；subagent 的一輪開始、結束、錯誤與標題都不送。subagent 的紀錄只在父 session 的 transcript 已讀過後才算；在那之前跳過、不追蹤（避免父 session 以沒有名稱的方式出現）。啟動補讀先補 session，再補 subagent。
  - 沒有 `timestamp` 而且同檔也還沒讀到任何 `timestamp` 時，`ts` 用該檔的修改時間。
  - 對應表裡「沒有產生任何事件、但帶 `timestamp`」的紀錄送 `activity`（例如只有 thinking 的 assistant、`isMeta` 的 user）。同一紀錄內的順序：`session.start` → 資料夾名稱的 `session.meta` → `error` → `tool.start`／`tool.end` → `turn.start`／`turn.end`。工具區塊沒有可用的 `id`、`name`（或 `tool_use_id`）就不送事件。標題去頭尾空白、截到 256 字元。
  - `turn.end`：`stop_reason` 為 `end_turn`、`stop_sequence`、`max_tokens`、`refusal` 都算一輪結束。同一個 transcript 上一個送出的「一輪」事件已經是 `turn.end` 時，不再送（之間有 `turn.start` 或 `tool.start` 才重置），避免同一則訊息拆成多筆紀錄時重設「做完了」；不追蹤一輪是否進行中（補讀可能從一輪中間開始）。被略過的 `turn.end` 所在紀錄若沒有其他事件、且帶 `timestamp`，送 `activity`。
  - 名稱：一次讀取 session 自己的 transcript 有產生事件時，結尾再送一次目前的顯示名稱（`session.meta`，`ts` 為該檔目前最新的 timestamp），讓逾時後或 `--resume` 回來的 session 保有名稱。
  - 去識別化腳本：字串型的 `message.content` 換成空字串（保留「內容是字串」這個結構，否則一般的一輪會失去 `turn.start`）；`mcp__<server>__<tool>` 的工具名換成 `mcp__fixture__tool`（伺服器名可能是公司內部名稱）。寫出前每筆都要通過 `fixtureProblems()`，否則不寫。
  - fixture 對應：`…0001` 一般的一輪＋工具＋API 錯誤；`…0002` 中斷；`…0003`＋`subagents/agent-fixture-1` subagent；`…0004` AskUserQuestion；`…0005`→`…0006` 同資料夾前後兩個 transcript（`/clear`）。挑選只用結構查詢（紀錄種類、工具名、數量、檔與檔之間的時間差），沒有讀出內容。
  - 翻譯快照用 vitest 的 `toMatchSnapshot()`，檔案在 `test/main/__snapshots__/detection-claude-code-translate.test.ts.snap`，要一起提交（CI 不會自動產生）。
- 審查修補（第 1 輪，開發代理）：subagent 的工具、`WebFetch` 移出不推測清單、`max_tokens`／`refusal`、重複 `turn.end`、名稱重送、根目錄重新檢查與 realpath、watcher 錯誤與啟動失敗的健康、新檔超過 2 MiB 改補讀、depcruise 規則改為 `adapters-no-processes-or-electron`（再禁 `worker_threads`、`cluster`、`electron`）、移除 `birthtimeMs`、log 的大小改由 `REPLAY_TAIL_BYTES` 推出。開發代理只跑了受影響的測試檔（翻譯、讀檔、轉接器、fixture 含真 chokidar 的四項、偵測、推測、sessions、sources、guard-rules）與 typecheck、lint，全部通過；完整驗證由主 session 執行。其後的「驗證」「實機」「主 session 核對」三項是修補前的紀錄。
- 驗證（開發代理）：typecheck、lint、`npm test`（47 個檔案、2113 個測試，含 `CI=true` 下的快照檢查）、depcruise（0 違規）全部通過。I/O 矩陣 16 列都有測試：前 15 列在 `test/main/detection-claude-code.test.ts`（經 `createDetection`、假時鐘、暫存資料夾、假 watcher），唯讀在 `test/main/detection-claude-code-fixtures.test.ts`（fixture 複製到暫存資料夾、用真的 chokidar 跑完整個轉接器，前後比對每個檔的大小、修改時間與 sha256，並檢查只以 `'r'` 開過根目錄下的 `.jsonl`）。補讀效能：5 個 2.2 MiB 的合成 transcript（約 8.4 萬筆紀錄）補讀約 0.2 秒。
- 實機（開發代理）：`npm start -- -- --user-data-dir=<scratchpad>` 隔離執行約 20 秒，未截圖、未碰使用者的 app。run log 依序有 `claude-code: started; watching the projects folder` 與 `claude-code: replayed 8 transcripts … (7 sessions, 1 subagents; 778 transcripts in all); sync.ready`，沒有 `detection` 錯誤或警告；之後停止，沒有殘留行程。執行前後只比對 `~/.claude/projects/` 的 metadata（3370 個項目）：沒有新增、刪除、變小的檔；唯一變化是一個 subagent transcript 變大，應是開發代理自己這個執行中的 subagent session 在寫入（只比 metadata，未讀內容確認）。面板與「管理 session」頁未實際操作，使用者驗收尚未進行。
- 主 session 核對：讀過翻譯與轉接器的原始碼；fixture 的每個字串值都在白名單內（工具名、紀錄種類、中斷固定文字、「範例標題」、`/fixture/project`），6 個 UUID 都與本機真實檔名不同，快照沒有路徑。重跑 typecheck、lint、`CI=true npm test`（47 個檔案、2113 個測試、0 跳過）、depcruise（0 違規），全部通過；I/O 矩陣 16 列都有對應測試並有執行（`detection-claude-code.test.ts` 的 `I/O matrix`，唯讀列在 `detection-claude-code-fixtures.test.ts`）。開一個真實 Claude Code session 看面板的人工驗收尚未進行。
- 審查修補（第 1 輪，14 項，含使用者決定的兩項）完成後，主 session 重跑：typecheck、lint、`CI=true npm test`（47 個檔案、2125 個測試、0 跳過）、depcruise（0 違規），全部通過；fixture 與快照再查一次，沒有任何 home 路徑。
- CI（`05111fa`）：Windows 上三個用真 chokidar 的測試在 5 秒內等不到 `sync.ready`（macOS 通過）。CI 的完整 log 要登入才看得到，原因未確定；先把這三個測試的單項等待加長到 20 秒、整個測試 60 秒，失敗訊息附上平台、健康、各類輸出數量與 `detection` 紀錄（公開的 annotations 看得到），下一輪 CI 再判斷是 Windows 慢還是根本沒有觸發。
- CI（`0f9ed0c`）的診斷訊息找到 Windows 的原因：chokidar 的 readdirp 在 Windows 上給 BigInt 的檔案資訊，`shouldWatch` 把 BigInt 的 `mtimeMs` 和數字相減，丟出 `TypeError`，第一次掃描中斷、`sync.ready` 永遠不送，轉接器在 Windows 上完全讀不到。修正：`mtimeMs` 先轉成數字；加一個以 BigInt 模擬 Windows 的測試，拿掉修正時會重現同一個 `TypeError`。

## Spec Change Log

- 2026-11-11，審查第 1 輪 B1／E10、B2／E9（intent_gap）：subagent 裡停在批准畫面的工具、`WebFetch` 第一次連新網域的批准，都不會出現「要你批准」。使用者決定兩個都改：frozen 區塊的 Decisions、原生 id 那條規則、I/O 矩陣加一列，Design Notes 的對應表跟著改。程式不回退重做，改以修補方式送回開發代理，因為只動到翻譯表與能力表兩處，其餘實作不受影響。KEEP：翻譯維持純函式、整批交給偵測、記錄只寫代碼與數量。

## Review Triage Log

第 1 輪（2026-11-11）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| B1、E10 | subagent 裡的工具停在批准畫面，父 session 只顯示「工作中」 | medium | intent_gap → 使用者決定改，patch | fixture 的 subagent 檔就有這種情形；見 Spec Change Log |
| B2、E9 | `WebFetch` 在不推測清單，第一次連新網域的批准不會出現 | medium | intent_gap → 使用者決定改，patch | 同上 |
| VG-O1、VG1、E1、E2、B8 | projects 資料夾啟動時不存在、或執行中被刪掉再建立，之後永遠是 `missing`，要重開 app；資料夾回來時也不會重新補讀 | medium | patch | VG 用 chokidar 5.0.0 實測：刪掉 root 後不會再有任何事件，`folderAdded(root)` 永遠不會觸發；既有測試用假 watcher 手動觸發，等於沒測到。修法：root 不存在時定期檢查，出現後重新開始監看並照啟動流程補讀；root 先取 realpath（E14） |
| B3、E7 | `stop_reason` 為 `max_tokens`、`refusal` 時不送 `turn.end`，session 停在「思考中」 | low | patch | 這兩個值也代表這一輪已結束；加進結束原因即可 |
| B4 | 同一則回覆拆成多筆紀錄時，每筆都送 `turn.end`，「做完了」重新計時 | maybe-false（若成立為 low） | patch | 快照確實有兩個 `turn.end`；連續的 `turn.end` 只送第一個即可，不需追蹤 turn 是否開著（補讀從檔案中間開始時無從得知） |
| E6、開發代理回報 | 逾時或 `--resume` 後同一個 session 重新出現時沒有名稱，面板顯示 UUID | low | patch | 已有測試記錄此行為；每次讀檔產生事件時，在批次最後重送該 session 目前的名稱 |
| B5、E16 | 轉接器 `start()` 丟例外時，`adapters` 沒有這一列，面板看不出壞了 | low | patch | `detection.ts` 只記 log；改為標 `degraded` |
| B6、E3 | watcher 執行中出錯只記 log，健康仍是 `ok`；watcher 起不來時先報 `ok` 再報 `degraded` | low | patch | 出錯時標 `degraded`；等 watcher 成功後才報 `ok` |
| E5 | 啟動後才出現、但已經很大的檔（例如複製來的 session）會從頭整個同步讀，舊紀錄當成即時事件 | low | patch | 超過 `REPLAY_TAIL_BYTES` 時改為從尾端補讀 |
| B10、E15 | depcruise 只禁 `child_process`，`worker_threads`、`cluster`、`electron` 仍可 import | low | patch | 規則補上這幾個；fs 寫入 API 的部分見 reject |
| VG2、B7 | 真的 chokidar 在 ready 之後的事件（append、深度 3 的 subagent、視窗外的舊檔被寫入）沒有測試 | medium | patch | VG 證明刪掉 `change` 處理、改 `depth` 或反轉 `ignored`，既有測試照樣通過 |
| VG3 | 大檔從尾端補讀後再 append，接著讀的位置沒有測試 | medium | patch | VG 證明 offset 漏加 `from` 時既有測試照樣通過，實際會重送舊紀錄 |
| VG4 | 轉接器 `stop()` 丟例外時的處理沒有測試 | low | patch | 拿掉 try/catch 既有測試照樣通過 |
| B14 | `TranscriptStats.birthtimeMs` 必填但沒用到；log 寫死「2 MiB」 | low | patch | 直接修正 |
| B9 | 同步讀檔沒有上限：啟動補讀檔數不限、沒有換行的資料一直累積、尾端 2 MiB 都在同一行時補讀不到任何紀錄 | low | reject | 開發代理實測 5 個 2.2 MiB 的檔約 0.2 秒；transcript 每行都以換行結尾；最後一行超過 2 MiB 時，下一筆紀錄寫入後就會出現 |
| B10（fs 部分） | `claude-code.ts` import 整個 `node:fs`，寫入 API 仍在作用域內 | low | reject | 讀檔都經 `TranscriptFs` 型別；唯讀測試會比對雜湊與開啟模式 |
| B11、E13 | 不支援 `CLAUDE_CONFIG_DIR` | low | reject | 從 Finder 開的 app 本來就拿不到 shell 的環境變數；有人反映再加設定 |
| B12 | 開頭沒有 `timestamp` 的紀錄用檔案修改時間，比之後的紀錄還晚 | false | reject | 修改時間就是最後一次寫入，和最後一筆紀錄幾乎相同；最後事件時間只會往前走，不影響 idle 與逾時 |
| B13、E8 | 行程被強制結束時，開著的工具會被推測成「要你批准」，最久 2 小時 | medium | reject | carried：使用者 2026-11-10 在 2.2 推測審查 E1／B2 已決定照現在，記為已知限制；狀態檔那段會補上行程結束 |
| E4 | transcript 被另一個不小於原位置的檔取代時，從舊位置接著讀 | low | reject | Claude Code 只會附加寫入 transcript |
| E12 | chokidar 合併事件時，最後一筆可能要等下一次寫入才讀到 | maybe-false（若成立為 low） | reject | 每次都讀到檔案結尾；FSEvents 對每次寫入都會再發事件 |
| E14 | projects 本身是 symlink 時，chokidar 不會往下讀 | low | patch | 併入 VG-O1 那項：root 先取 realpath |
| E17、E18 | 去識別化腳本讀不到輸入時印出路徑；重跑不清舊檔 | low | reject | 開發用工具，只在開發者自己的終端機輸出 |
| E19 | 沒產生事件的標題紀錄不送 `activity` | false | reject | 本機調查顯示標題紀錄都沒有 `timestamp`，本來就不送 `activity` |

## Design Notes

**紀錄 → 事件。** 依 2026-11-10 對本機紀錄做的結構調查（只看欄位名與代碼）：

| 紀錄 | 事件 |
|---|---|
| 某個 transcript 第一次讀到的紀錄 | 先送 `session.start` |
| `user`，不是 `isMeta`、不是 `isCompactSummary`，內容是字串，或是不含 `tool_result` 的區塊清單 | `turn.start` |
| `user`，唯一的文字是 `[Request interrupted by user]` 或 `[Request interrupted by user for tool use]` | `turn.end` |
| `assistant`，`message.stop_reason` 為 `end_turn` 或 `stop_sequence` | `turn.end` |
| `assistant` 內容中的每個 `tool_use` | `tool.start`（`toolCallId` = `id`，`toolName` = `name`） |
| `user` 內容中的每個 `tool_result` | `tool.end`（`toolCallId` = `tool_use_id`） |
| `assistant`，`isApiErrorMessage: true` | `error` |
| `custom-title`（優先）、`ai-title` | `session.meta`；沒有標題前，以第一個帶 `cwd` 紀錄的資料夾名稱送 `session.meta` |
| `subagents/` 底下的 `tool_use`／`tool_result` | 父 session 的 `tool.start`／`tool.end` |
| `subagents/` 底下的其他紀錄 | 父 session 的 `activity` |
| 其他帶 `timestamp` 的紀錄 | `activity` |
| 其他 | 不送 |

所有事件都是 `via: log`、`confidence: exact`。

**同步與補讀（2.2、2.3 留給 2.4 的決定）。**
- 啟動補讀每個檔最多 2 MiB；本機 2 小時內修改過的 transcript 通常只有幾個，補讀會遠早於 `syncTimeoutMs` 完成，所以不另加「同步中」狀態。
- 之後才補讀的檔（`--resume`、檔案變小），整批交給偵測。批次內即使有推測先發生又被 `tool.end` 關掉，面板也只看到最後結果。
- 2.2 審查 E2（`turn.end` 漏寫）的主要情形是中斷，已由中斷紀錄對應 `turn.end` 處理。

**已知限制。**
- 在 auto 模式或略過權限時，`Bash` 跑超過 10 秒也會被推測成「要你批准」。
- `/clear` 之後舊 session 要等 `sessionExpireMs`（預設 2 小時）才消失。
- 這兩項都等狀態檔那段改善。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規

**Manual checks:**
- 開發代理：用 `--user-data-dir` 指向隔離的資料夾執行 `npm start`，確認 run log；不碰使用者的 app，也不截圖。執行前後比對 `~/.claude/projects/` 的檔案清單、大小與修改時間，確認完全不變。只能比對 metadata，不可讀出或印出 transcript 的內容。
- 使用者驗收：開一個 Claude Code session，「管理 session」頁會出現它，狀態跟著思考中、工作中、做完了變化。
