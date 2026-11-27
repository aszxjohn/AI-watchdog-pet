---
title: 'Story 3.9 收尾：探針 e2e（當掉、卡死、角色包頁提示）'
type: 'chore'
created: '2026-11-27'
status: 'in-review'
baseline_commit: 'ea3e3165eef0db5fa6ff87f15ed9cae2420c5528'
route: 'dispatch'
review_loop_iteration: 0
user_preview: approved
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.9（中）（下）的實際接線只有單元測試：bootstrap 回報 fault 與 pong、IPC `packs:runtime-failed`、第 4 次標記、角色包頁的失敗提示。現有 e2e 把任何 `sandbox failed` 當故障，沒有案例真的讓包當掉或卡死。「移除 iframe 會連帶終止卡死的 Worker」（AD-7）也還沒實測。

**Approach:** 新增兩個 e2e 檔，各自啟動一次 app：
- `crash.spec.ts`：探針包每收到 `frame` 就製造一個沒處理的 rejection。斷言 4 次失敗、第 4 次標記、失敗期間畫佔位、角色包頁提示；再重新匯入修好的版本，提示消失。
- `stuck.spec.ts`：探針包在 `frame` 裡 `while (true) {}`。斷言 `heartbeat-timeout`、重建成功、沒有殘留的 Worker 持續吃 CPU。

helpers 讓探針包可以換入口與版本；`probeSandboxTrouble` 可以指定這個測試預期的失敗原因，其他原因照舊當故障。

**定案（2026-11-27 使用者）：** spec 太長，拆開。「管理 session」頁的 e2e 記回 deferred-work，之後另開 session。

**定案（規劃時決定，使用者看不出差別）：**
- 當掉用 unhandled rejection。包的 `frame` 同步丟錯只會回 `no-draw`，不算失敗。
- 重新匯入用健康的 1.0.1：stub `dialog.showOpenDialog`，按角色包頁的「匯入角色包…」，再按「取代」。不用同版本，避開 `looks.ts` 只看版本的已知問題（deferred E3）。
- 面板操作一律用 `locator.dispatchEvent('click')`。舞台視窗蓋在面板上，macOS 可能節流面板的 rAF，`click()` 的穩定檢查會卡住。
- 「不吃 CPU」用自我校正量測（見 Design Notes）。如果 CI 上做不到，就寫明原因，只留 Worker 關閉的斷言。

## Boundaries & Constraints

**Always:**
- 只改 `test/e2e/`。每個新檔都是 serial、一次啟動；afterAll 把 run log 複製到 `test.info().project.outputDir` 底下各自的資料夾，再 `removeDirs`。
- 期望的文字與數值從 `src/` import（`runtimeFailedText`、`IMPORT_BUTTON_LABEL`、`REPLACE_LABEL`、`PACK_RESTART_LIMIT` 等），不要手抄。
- log 斷言要看「某個時間點之後」的行或行數增量，不能只看「出現過」（RP-18）。外層逾時要大於內層等待的總和。
- 其他 e2e 仍然把任何 `sandbox failed` 當故障。

**Never:**
- 不在本機跑 e2e，因為會開視窗。e2e 只在 CI 驗證。
- 不改 `src/`、CI 設定、`package.json`。測不過時不要改產品程式遷就，照實回報。
- 不測矩陣以外的邊界（同版本重新匯入、移除包、示範模式等）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 當掉 4 次 | crash 探針 1.0.0、1 個 session | 4 行 `sandbox failed (unhandled-rejection)`；main 3 行 `restarting … (restart N of 3)`，1 行 `not restarting … failure 4 … marked it failed`；之後沒有第 5 行 |
| 失敗期間 | 第 1 次到第 4 次之間 | overlay 記到 `drawnPlaceholders` ≥ 1 |
| 標記後 | 第 4 次之後 | StageView 該包 `runtimeFailed` 為 `unhandled-rejection`、沒有 actor、session 還在清單；角色包頁 `.pack-runtime-failed` 文字＝`runtimeFailedText('unhandled-rejection')`（標記前沒有這個元素） |
| 重新匯入 | 健康的 1.0.1 | 提示消失、沒有 `runtimeFailed`、session 重新有 actor、`sandbox ready (version 1.0.1`，之後沒有 `sandbox failed` |
| 卡死 | stuck 探針 | 每次都是 `heartbeat-timeout`；第 1 次之後有 `restarting` 與新的 `sandbox ready`；共 4 次，第 4 次標記 |
| 沒有殘留 | 第 4 次之後、actor 已收回 | overlay 的沙盒 Worker 全部關閉；CPU 回落 |

</frozen-after-approval>

## Code Map

- `test/e2e/helpers.ts`：
  - `writeProbePack`（`:402`）：讓入口與版本可替換，檔名依版本區分；`sandbox.spec` 的行為不變。
  - `probeSandboxTrouble`（`:654`）改成工廠 `probeSandboxTrouble(expected = [])`，原因列在 expected 裡的 `sandbox failed` 不算故障。唯一呼叫處是 `sandbox.spec.ts:108`。
  - 可沿用：`makeDirs`、`launchStage`、`closeStage`、`windowAt`、`writeClaudeSession`、`readStageView`（`:482`）、`readOverlayData`（`:515`）、`readRunLog`、`waitForLine`、`probeLine`、`parseReadyLine`（`:728`）。
  - 兩個新檔都會用到的小工具（例如解析失敗原因、算某時間點之後的行）放這裡。
- log 格式：
  - `src/main/packs/sandbox-log.ts:88`：`pack <id>: sandbox failed (<reason>); its iframe was removed…`。
  - `src/main/packs/runtime-failures.ts:53-71`：restarting 與 not restarting 那幾行。
- `src/sandbox/worker-bootstrap.ts`：`:1326-1339` 把 `error`、`unhandledrejection` 回報成 `sandbox.fault`；`:1069-1080` frame 丟錯只回 `no-draw`。
- 常數（`src/shared/constants.ts:294-335`）：`TICK_HZ` 30、`HEARTBEAT_TIMEOUT_TICKS` 150（5 秒）、`DRAW_TIMEOUT_MS` 10 秒、`PACK_RESTART_LIMIT` 3。
- 池子只有探針包時，第 4 次標記後池子變空，session 的 actor 會被收回，session 仍留在清單（epic 3「換角色」）。
- overlay：body data 的 `drawnPlaceholders`、`drawnActors`（`src/overlay/main.ts:240-258`）。troubled 的包畫佔位（`scene.ts:402`）。
- 沙盒 Worker（`src/sandbox/iframe.ts:110-116`）：由不透明來源的文件用 blob 建立，所以 url 開頭是 `blob:null/`。Playwright 的 `page.workers()` 包含子 frame（含 OOPIF）的 Worker，Worker 結束時會發 `close`。PixiJS 可能有自己的 blob Worker，要用 url 篩掉。
- 角色包頁：
  - 啟動參數匯入時，面板會開在「角色包」頁（`src/main/main.ts:62`）。
  - `App.tsx:809` 的 `.pack-runtime-failed`；匯入區在 `:928-975`，有 `.pack-confirm`。
  - `IMPORT_BUTTON_LABEL`、`REPLACE_LABEL` 在 `src/panels/pack-import.ts:43-44`；`runtimeFailedText` 在 `src/panels/pack-list.ts:150`。
  - 匯入對話框：`src/main/main.ts:196-206` 每次都呼叫 `dialog.showOpenDialog`，可以在 `app.evaluate(({ dialog }) => …)` 裡 stub。
- StageView：`view.actors[].sessionKey`、`view.sessions`、`view.packs.installed[]`（`version`、`runtimeFailed`）。

## Tasks & Acceptance

**Execution:**
- [x] `test/e2e/helpers.ts`：探針包可替換入口與版本；`probeSandboxTrouble` 改成工廠；加上共用的小工具。理由：兩個新檔共用，現有檔不受影響。
- [x] `test/e2e/sandbox.spec.ts`：`:108` 改成 `probeSandboxTrouble()`。
- [x] `test/e2e/crash.spec.ts`（新）：矩陣的「當掉 4 次／失敗期間／標記後／重新匯入」。
- [x] `test/e2e/stuck.spec.ts`（新）：矩陣的「卡死／沒有殘留」。

**Acceptance Criteria:**
- Given 這次的改動，when CI 在 macOS 與 Windows 跑 check 與 e2e，then 全部通過，兩個新檔的每個測試都有執行（沒有 skip）。
- Given 本機，when 跑 `npm run typecheck`、`npm run lint` 與 `npx playwright test --list`，then 都通過，而且新檔的測試都列得出來。

## Implementation Notes

- 2026-11-27 一個開發代理完成，改 `test/e2e/helpers.ts`、`sandbox.spec.ts`（`:108`），新增 `crash.spec.ts`、`stuck.spec.ts`。
- helpers：`writeProbePack(dir, entry, version = '1.0.0')`，`entry` 可傳 `ProbeServer`（逃逸探針，文字與原本相同）或入口原始碼，檔名改成 `sandbox-probe-<version>.awpet`；新增 `probeEntryWithFrame` 與 `HEALTHY_FRAME`／`CRASHING_FRAME`／`STUCK_FRAME`；`probeSandboxTrouble(expected = [])` 改成工廠；共用工具 `linesSince`、`writtenSince`、`pause`、`probeFailureReason`、`probeRuntimeAnswer`、`restartAnswers`（上限取自 `PACK_RESTART_LIMIT`）、`probeState`。
- crash：除了佔位記錄器，面板端另裝一個記錄器，記「包的列第一次出現且沒有提示」與「提示第一次出現」的時間，用來斷言提示是標記之後才出現。dialog stub 沒生效時直接丟錯，不會開出真的對話框。
- stuck：beforeAll 掛 overlay 的 `worker` 事件，追蹤 url 開頭 `blob:null/` 的 Worker 與它們的 `close`。CPU 以 pid＋creationTime 對應行程；收回後的量測方式必須與對照相同。
- 本機驗證：`npm run typecheck` 通過；`npx playwright test --list` 列出新檔 6 個測試（全部 40 個、6 個檔）。e2e 未在本機執行，要靠 CI。
- 風險：CI 若沒有 GPU，GPU 行程可能仍吃 CPU，使「CPU 回落」誤判；`blob:null/` 這個 url 前綴只靠推論，未實測。若 CI 證實做不到，依定案寫明原因並只留 Worker 關閉的斷言。
- 2026-11-27 審查後修補 6 條（見 Review Triage Log：B3、B4、B5、B9、B12、V1），CPU 判定的誤判風險記進 deferred-work。全套 `npx vitest run`（5719 通過、2 skip）、`npm run lint`、`npm run typecheck`、`npx playwright test --list`（新檔 6 個測試）都通過；e2e 仍只在 CI 跑。

## Spec Change Log

## Review Triage Log

2026-11-27 第 1 輪（review_loop_iteration 0）。B＝盲審，E＝邊界案例，V＝驗證缺口（沒有正式缺口，4 條其他發現）。

| # | 位置 | 發現 | 判定 | 去向與證據 |
|---|---|---|---|---|
| B1 | stuck `沒有殘留` CPU 判定 | 收回後每個行程拿去比對照最忙行程的一半；GPU 行程一直忙會誤判，對照最忙的也可能不是 Worker | maybe-false | defer（若成立為 medium）。誤判要 CI 上有非 Worker 行程在兩段都 ≥ busiest/2 才會發生，靜態看不出；「對照證明不了 Worker 在吃 CPU」不成立：Worker 沒卡住就不會 heartbeat-timeout，第 1 個測試先失敗。已在斷言訊息附兩段量測，CI 失敗時可判斷 |
| B2 | stuck 對照量測時間窗 | 量測可能跨過第 2 個沙盒失敗 | low | 駁回。輪詢延遲 ≤250ms，量測約在 ready 後 2.6 秒結束，心跳 5 秒才逾時；就算跨過，重建的沙盒馬上又卡住，只會讓門檻更嚴，不會漏抓殘留 |
| B3 | stuck `sandboxWorkers.size ≥ 1` | 應該等於建過的沙盒數 | low | patch：改成 `toBe(FAILURES)`。`iframe.ts:115` 每個沙盒一個 Worker，共 4 個 |
| B4 | crash `HEALTHY_QUIET_MS` | 觀察 7 秒，蓋不到 10 秒的 draw-timeout | low | patch：改成 `max(心跳, DRAW_TIMEOUT_MS) + 2 秒`，`host.ts:971` 確認 draw-timeout 存在 |
| B5 | crash 重新匯入後的觀察期 | 只看 `sandbox failed`，沒看 `has an actor but gets no sandbox` | low | patch：改用 `probeSandboxTrouble()`，與等待時的 failOn 一致 |
| B6 | crash `失敗期間` | 最大佔位數沒限定時間窗 | low | 駁回。合約包兩個角色都對得到 thinking、session 一直 inTurn、首次建置不算 troubled，標記後 actor 收回，佔位只可能來自失敗期間；補時間戳要加記錄邏輯 |
| B7 | crash `標記後` | 沒檢查 overlay 的 drawn 數歸零 | low | 駁回：矩陣沒有這列，frozen 的 Never 寫「不測矩陣以外的邊界」 |
| B8 | 兩個新檔的測試標題 | 標題寫死 4 次、版本、按鈕字 | low | 駁回。「期望值從 src import」管的是斷言，標題照慣例抄矩陣列名；改成組字要處理序數（4th、5th），常數極少變 |
| B9 | helpers `CRASHING_FRAME` 註解 | 說 frame 丟錯只回 no-draw、不算失敗 | low | patch：`host.ts:91-93` 說 no-draw 不是有效 draw，10 秒後 draw-timeout；註解改正 |
| B10 | 兩個新檔重複的常數與 afterAll | `HEARTBEAT_TIMEOUT_MS` 等各算一次 | low | 駁回。都由共用常數算出，不會分歧；afterAll 是既有 4 個 spec 的寫法 |
| B11 | helpers 型別 | 失敗原因用 string；`ProbeState.actors` 沒篩探針包 | false | 駁回。未知原因會讓 `toStrictEqual` 對不上而失敗，不會默默通過；池子只有探針包，全部 actor 都是它的 |
| B12 | stuck CPU 斷言訊息 | 失敗時看不到對照數據 | low | patch：兩個 CPU 斷言的訊息附上 control 與 after 的 JSON，CI 失敗時才判斷得了要不要走定案的退路 |
| E1 | 同 B4 | — | low | 併 B4 |
| E2 | crash 記錄器 | overlay／panels 重新載入會讓記錄器消失 | false | 駁回。這個流程沒有任何會重新載入頁面的動作；真的發生也是讀到 null 而大聲失敗 |
| E3 | stuck Worker 追蹤 | overlay 視窗重建後 `workers()` 變空，斷言空洞通過 | false | 駁回。流程沒有觸發重建；B3 改成等於 4 之後，重建會讓數量對不上而失敗 |
| E4 | 同 B2 | — | low | 併 B2，駁回 |
| E5 | stuck 對照 | 兩個 Worker 同時在轉會讓門檻變成一核 | low | 駁回。要第 1 個 Worker 沒被關掉才會兩個同時轉，那正是殘留，Worker 關閉的斷言會先抓到 |
| E6 | stuck `after.cumulative` | 某行程只在一段缺 cumulativeCPUUsage 會誤判 | false | 駁回。這是 Design Notes「兩邊單位一致」的刻意檢查，不一致就該大聲失敗 |
| E7 | helpers `probeSandboxTrouble` | 讀到寫一半的行，原因解析不出來被當故障 | low | 駁回。log 是同步單次寫入，250ms 輪詢碰上的機率可忽略；修法要改既有的 `readRunLog`，影響所有 e2e |
| E8 | 同 B9 | — | low | 併 B9 |
| V1 | crash `重新匯入` 標題 | 寫「clears the mark」，但換成 1.0.1 後不管有沒有清除，斷言都會通過 | low | patch：標題與檔頭改成只講看得到的結果（提示消失、session 重新有 actor）；清除本身有單元測試（`packs-store.test.ts:640`、`:666`） |
| V2 | crash `當掉 4 次` | 「沒有第 5 次」跟 overlay 是否遵守不重啟幾乎無關 | false | 駁回。標題只說沒有第 5 行失敗，這正是斷言的內容，沒有宣稱 overlay 遵守 `restart: false`（那有 `pack-host.test.ts:597`） |
| V3 | 同 B1 | — | maybe-false | 併 B1 |
| V4 | 同 B3 | — | low | 併 B3 |

## Design Notes

**佔位記錄器：** beforeAll 一拿到 overlay 就在頁面裝 MutationObserver，盯 body 的 `data-drawn-placeholders`，記下出現過的最大值（含裝的當下的值），存在 `window.awpE2e…`（比照 `awpE2eLoseContext`）。之後才等 `sandbox ready`。失敗期間很短，輪詢可能錯過。

**探針入口：** 當掉：`frame: function () { Promise.reject(new Error('awp-crash')); }`，不回 draw，重建後也一直維持 troubled。卡死：`frame: function () { while (true) {} }`。健康：`frame` 回 `{}`。

**CPU 自我校正：** 用 `app.evaluate` 讀 `app.getAppMetrics()`，算每個 pid 在一段時間內的 CPU 秒數增量。優先用 `cumulativeCPUUsage`；沒有的話，在區間頭尾各呼叫一次，取 `percentCPUUsage`。
- 對照：某次 `sandbox ready` 之後約 0.3 秒起，量 2 秒，這時 Worker 正卡在迴圈裡（心跳 5 秒才逾時）。最大速率要明顯大於 0。
- 收回後：同樣量 2 秒，每個 pid 的速率都要小於對照最大值的一半。
- 這樣兩邊單位一致，不依賴 Windows 的計法。

## Verification

**Commands:**
- `npm run typecheck`：通過。
- `npx playwright test --list`：列出兩個新檔的測試，不啟動 app。
- e2e：只在 CI 跑（push 後看 check 與 e2e 在 mac、Windows 的結果）。
