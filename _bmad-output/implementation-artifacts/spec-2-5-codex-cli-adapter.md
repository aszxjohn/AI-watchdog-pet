---
title: 'Story 2.5：Codex CLI 轉接器'
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

**Problem:** 偵測目前只讀 Claude Code；使用者同時開 Codex CLI 時，它的 session 不會出現在面板。

**Approach:** 新增 `codex` 轉接器，唯讀 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，把紀錄翻成共用事件；顯示名稱優先取 `~/.codex/session_index.jsonl`。讀檔、監看、補讀、健康這套機制從 2.4 抽成共用模組，兩個轉接器共用。

**Decisions（2026-11-11）：**
- 能力表：approval、question 都是 `none`（Codex 不把批准、提問寫進紀錄）。提問類工具：`request_user_input`。不推測的工具：`wait_agent`、`sleep`。
- subagent 沿用 2.4：subagent 的工具開始、結束算在根 session 上（也會推測），其他紀錄只算根 session 的 `activity`。
- `codex exec`、IDE 擴充開的 session 也顯示（同一個資料夾，不分來源）。
- 不支援 `CODEX_HOME`，理由同 2.4 不支援 `CLAUDE_CONFIG_DIR`。
- 測試資料（使用者 2026-11-11 決定）：使用者安裝 Codex CLI，照清單跑幾個短 session，由去識別化腳本轉成 fixture。Design Notes 的對應表要先以這些樣本做結構核對（只看欄位名、種類、工具名、數量與時間差）再定稿。

## Boundaries & Constraints

**Always:**
- 完全唯讀：只開啟 `~/.codex/sessions/` 底下的 `rollout-*.jsonl` 與 `~/.codex/session_index.jsonl` 來讀。不寫檔、不執行指令。
- 原生 id 是 rollout 檔名裡的 thread id（`rollout-<時間>-<id>.jsonl`；`<id>_<另一個 id>` 時取前段），`sessionKey` 為 `codex:<id>`。
- 每個 rollout 先讀第一行 `session_meta`（最多 1 MiB）判斷是不是 subagent、取 `cwd`；之後照 2.4 的規則讀：補讀最後 2 MiB、即時讀、變小重讀、壞行計數、`sync.ready`、資料夾不存在為 `missing` 並定期重查。
- 對應照 Design Notes 的表；`ts` 取每行的 `timestamp`。
- 顯示名稱：`session_index.jsonl` 裡該 id 最新一行的 `thread_name` 優先，否則用 `cwd` 的資料夾名稱；`session_index.jsonl` 改變時重讀並更新名稱。
- 抽共用模組後，2.4 的 claude-code 行為不變：既有 claude-code 測試的斷言不改、全部通過。

**Never:**
- 不開 `~/.codex/` 底下的其他檔：`auth.json`、`config.toml`、`history.jsonl`、`*.sqlite`、`log/`、`archived_sessions/`、`.jsonl.zst`。
- 不讀出或印出真實紀錄的內容；fixture 只能由白名單去識別化腳本產生。
- 不改判斷器的條件表與優先序。

## I/O & Edge-Case Matrix

計時值以預設值為例。

| 情境 | 輸入 | 預期 |
|---|---|---|
| 新 session | 新 rollout 寫入 `task_started` | 出現 session，名稱為資料夾名稱，「思考中」 |
| 工具 | `function_call`，之後同 `call_id` 的 `function_call_output` | 「工作中」，回「思考中」 |
| 一輪結束 | `task_complete` | 「做完了」，5 秒後「等你回覆」 |
| 中斷 | `turn_aborted` | 一輪結束 |
| 錯誤 | `task_complete` 帶 `error` | 「出錯了」 |
| 推測批准 | `exec_command` 10 秒沒有 output | 「要你批准」，標「推測」 |
| 提問 | `request_user_input` 10 秒沒有 output | 「要你決定」，標「推測」 |
| 不推測 | `wait_agent` 跑 10 分鐘 | 維持「工作中」 |
| subagent | `session_meta.source` 為 subagent 的 rollout | 不另出現 session；工具算在根 session |
| 名稱 | `session_index.jsonl` 新增該 id 的 `thread_name` | 名稱改為它 |
| `/new` | 新 thread id 的 rollout | 新 session；舊的照逾時結束 |
| resume | 3 天前的 rollout 被寫入 | 補讀後出現 |
| 太舊 | 3 小時前修改、沒有再寫 | 不出現 |
| 壞行 | 連續 20 行無法解析 | 健康 `degraded` |
| 沒有資料夾 | `~/.codex/sessions/` 不存在 | 健康 `missing` |
| 唯讀 | 對 fixture 跑完整個轉接器 | 前後雜湊完全相同 |

</frozen-after-approval>

## Code Map

- `src/main/detection/adapters/jsonl/`（新）：從 `claude-code/` 搬出 `read.ts`、`watcher.ts`（`depth` 改為參數）、`WatchedStats`、`partsBelow`，以及 `claude-code.ts` 裡與格式無關的核心（`health`、`deliver`、`readOpen`、補讀／即時讀／變小、root realpath 與重查、watcher 世代、`sync.ready`，約 :166-575）。核心以參數接收 `source`、路徑判斷、掃描、翻譯、名稱事件、讀檔前的閘門（claude-code 的「subagent 等父 session 讀過」）、讀第一行的需求。放在 `adapters/` 底下，depcruise 規則照樣涵蓋。
- `src/main/detection/adapters/claude-code/`：只留 `paths`、`translate` 與提供參數的薄層；`commonFields` 的 `source` 不再寫死。
- `src/main/detection/adapters/codex/`（新）：`paths`（`YYYY/MM/DD/rollout-*.jsonl`、id 解析、`shouldWatch`，`mtimeMs` 照 2.4 先轉數字）、`translate`（純函式）、`session-index`（讀名稱）、`codex.ts`。
- `src/shared/sources.ts:119`：codex 能力表照 Decisions；更新 :95-96 的註解。
- `src/shared/constants.ts`：`SESSION_META_MAX_BYTES = 1024 * 1024`。
- `src/main/main.ts:172-179`：加 `createCodexAdapter`（root `~/.codex/sessions`、index `~/.codex/session_index.jsonl`）；只提 Claude Code 的註解（:11、:34-35、:172、:243）一併更新。
- `scripts/deidentify-codex.mjs`（新）、`test/fixtures/codex/`：白名單只留 `timestamp`、`type`、`payload.type`、`role`、`name`、`call_id`、`reason`、`error` 是否存在、`session_meta` 的 `id`／`session_id`／`parent_thread_id`／`source` 種類；`cwd` 換成 `/fixture/project`，id 重新編號，名稱換成「範例標題」，其他丟掉。
- 測試 `test/main/detection-codex*.test.ts`：重用 claude-code 測試的 `fakeWatcher`、`startDetection`、`fingerprint`、`diagnose`、`startReal`，要共用就搬到 `test/helpers/`。

## Tasks & Acceptance

**Execution:**
- [ ] `src/main/detection/adapters/jsonl/`、`claude-code/`：抽共用核心，claude-code 改用；既有測試只改 import。
- [ ] `src/main/detection/adapters/codex/`、`sources.ts`、`constants.ts`、`main.ts`：轉接器與接線。
- [ ] `scripts/deidentify-codex.mjs`、`test/fixtures/codex/`：由使用者跑的樣本去識別化成 fixture。
- [ ] 測試：翻譯快照、I/O 矩陣每一列、唯讀雜湊、真 chokidar（`YYYY/MM/DD` 深度 3、append、舊日期資料夾的檔被寫入）、BigInt `mtimeMs`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過，claude-code 的測試數不減少。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 本機沒有 `~/.codex`，then 面板的轉接器健康中 Codex CLI 為 `missing`，run log 沒有 `detection` 錯誤。

## Implementation Notes

- 2026-11-11：共用的 JSONL 讀檔核心已由 Story 2.6 前置重構抽出（`src/main/detection/adapters/jsonl/`，`createJsonlLogAdapter`）。本規格 Code Map 與 Tasks 裡「從 claude-code 抽共用核心」的部分已不適用，回來做時改成直接使用並擴充它。

- 2026-11-11：使用者決定先做 2.6 Gemini，本規格留在 draft，等 Codex 樣本（已記在 deferred-work）。樣本清單：一般的一輪＋工具；`curl` 跳批准時等 15 秒再同意；Esc 中斷；`/rename`；`/plan` 提問時等 15 秒再回答；`/new` 後再問一句；可選的兩個 subagent；`/quit`。

## Spec Change Log

## Review Triage Log

## Design Notes

**紀錄 → 事件。** 依 `openai/codex` 公開原始碼 commit `5228d94a27b7f84cae4854acbb5ea3b3e90dfeaf`（2026-11-11）：每行是 `{timestamp, type, payload}`；`rollout/src/policy.rs` 決定哪些事件寫進紀錄，批准、提問、`error`、`stream_error` 都不寫。

| 紀錄 | 事件 |
|---|---|
| 第一行 `session_meta` | `session.start`；以 `cwd` 資料夾名稱送 `session.meta` |
| `event_msg` 的 `task_started`／`turn_started` | `turn.start` |
| `event_msg` 的 `task_complete`／`turn_complete`、`turn_aborted` | 帶 `error` 時先 `error`；再 `turn.end`（連續的只送第一個，同 2.4） |
| `response_item` 的 `function_call`、`custom_tool_call`、`local_shell_call` | `tool.start`（`toolCallId` = `call_id`，`toolName` = `name`；`local_shell_call` 為 `local_shell`） |
| `response_item` 的 `function_call_output`、`custom_tool_call_output` | `tool.end` |
| subagent rollout 的上兩列 | 根 session（`session_meta.session_id`，沒有就用 `parent_thread_id`）的 `tool.start`／`tool.end`；找不到根就整個檔不讀 |
| 其他帶 `timestamp` 的行 | `activity` |

**監看。** 年、月、日資料夾一律跟（resume 會寫回舊日期資料夾裡的檔），檔案只跟 `discoveryWindowMs` 內修改過的；每個日期資料夾佔一個監看。

**已知限制。**
- `exec_command` 跑超過 10 秒會被推測成「要你批准」（同 Claude 的 `Bash`）。
- Codex 在第一個使用者訊息之後才建 rollout，剛開、還沒輸入的 session 不會出現。
- 沒有 session 結束訊號，關掉終端後照逾時結束。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。

**Manual checks:**
- 開發代理：`--user-data-dir` 隔離執行 `npm start`，看 run log；不截圖、不碰使用者的 app。
- 使用者驗收（有裝 Codex 時）：開一個 Codex session，「管理 session」頁出現它，狀態跟著變化。
