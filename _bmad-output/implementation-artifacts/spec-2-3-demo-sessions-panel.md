---
title: 'Story 2.3：偵測接線、示範模式與「管理 session」面板'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: 'd5987c20ec4c3bc17a813794b10fcb54a57d736b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-inference.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 2.1、2.2 做好的判斷器與 session 管理還沒接進 app。沒有任何轉接器，面板的「管理 session」頁只顯示「即將推出」，使用者無法確認偵測有在運作。

**Approach:**
- 在 main 建立偵測：`createSessions` 接上設定與睡眠補償，結果經 StageView 的兩個新區段 `sessions`、`adapters` 推給面板。
- 第一個轉接器是 `demo`。使用者指定一種狀態，就產生一個顯示該狀態的假 session，經同一個判斷器運作，並一直維持到改選或關閉。
- 「管理 session」頁列出 session 與轉接器健康。

**Decisions（2026-11-10）：**
- Story 2.3 拆開：端到端測試（Playwright、CI）與第一次使用的引導另做，已記在 deferred-work。
- 示範模式不輪播，改成「指定狀態」：使用者選哪一種，假 session 就顯示哪一種，一直維持。這取代 FR21「示範模式輪播 8 狀態」的寫法。
- 最終的選擇方式是在畫布上對角色按右鍵選狀態。角色要到 Epic 3 才有，所以本 story 先做機制，暫時從系統匣選。Epic 2 驗收前另做一個「方塊角色空殼」放在畫布上，供右鍵選狀態驗收用；已記在 deferred-work。

## Boundaries & Constraints

**Always:**
- 偵測只在 `main/detection`；`main.ts` 只負責接線。轉接器的輸出一律交給 `sessions.receive`。
- 計時值取自設定目前的值；設定改變時呼叫 `retime()`。
- 睡眠補償：系統睡眠期間 `performance.now()` 不前進（macOS）。醒來時，把「牆鐘經過的時間 − 單調時鐘經過的時間」補進偏移量（小於 0 以 0 計），再呼叫 `retime()`。
- StageView 新增兩個區段：
  - `sessions`：每筆有 `sessionKey`、`source`、`displayName`、`state`、`confidence`；
  - `adapters`：每個執行中的轉接器一筆，有 `source` 與 `health`（`ok`／`degraded`／`missing`）。
- StageView 推送增量前，先用 shared schema 驗證。不通過就丟掉這次增量、記一筆錯誤，`rev` 不前進。
- 2.2 留下的兩項防護（deferred-work）：
  - `sessions.receive` 丟掉轉接器送來的 `via: inferred` 事件並記錄；
  - 判斷器忽略 id 不在進行中 tool 裡的推測 request：不開啟，也不改任何條件。
- 示範模式：
  - 只有一個假 session（顯示名稱「示範」）；
  - 只送一般的共用事件，計時值變了也照樣維持所選狀態；
  - 每次啟動 app 都是關閉的，開關不寫進 `settings.json`；
  - 關閉時送 `session.end`。
- 面板只讀 StageView。推測的狀態（`confidence: inferred`）要有明顯不同的標示。

**Never:**
- 不做真實轉接器、顯示／釋放 session、計時值設定 UI、端到端測試、第一次使用的引導、畫布上的角色與右鍵選單。
- 不改判斷器的條件表與優先序。示範模式不得繞過 `sessions` 與判斷器。

## I/O & Edge-Case Matrix

| 情境 | 輸入 | 預期 |
|---|---|---|
| 打開示範模式 | 系統匣「示範模式」選「要你批准」 | 面板出現一個「示範」session，狀態為「要你批准」；`adapters` 有 `demo`，健康為 `ok` |
| 改選狀態 | 從任一狀態改選另一種 | 同一個 session 改成該狀態；8 種之間任意切換都成立 |
| 維持 | 選「做完了」後過了 10 分鐘 | 仍是「做完了」；「出錯了」「等你回覆」「思考中」等其他狀態也一樣維持，session 不會逾時 |
| 休息中 | 選「休息中」 | 假 session 結束後，立刻以同一個 key 重新出現，狀態為「休息中」 |
| 關閉示範模式 | 選「關閉」 | 假 session 從面板消失，`adapters` 不再有 `demo` |
| 沒有 session | 示範模式關閉 | 面板顯示「目前沒有偵測到 session」，並提示可以從選單列打開示範模式 |
| 推測標示 | 某個 session 的 `confidence` 為 `inferred` | 該列的狀態旁有「推測」標示 |
| 改計時值 | 設定的 `doneMs` 改變 | 不必等新事件，立即依新值重算 |
| 睡眠 | 睡了 8 小時，單調時鐘只走了 0 秒 | 醒來後，`idle` 與逾時依實際經過的 8 小時判定 |
| 壞增量 | 某個區段不符合 schema | 不推送、`rev` 不變、記一筆錯誤；之後正常的增量照常推送 |
| 轉接器送推測事件 | `via: inferred` 的事件 | 丟掉並記錄，session 不受影響 |
| 推測 request 對不到 tool | 推測 request 的 id 不在進行中 tool 裡 | 判斷器的條件不變 |

</frozen-after-approval>

## Code Map

- `src/main/main.ts`：
  - 在 `createStageView` 之前建立偵測，把它當成 StageView 的另一個來源（寫法比照 `stageSources`）。
  - `startupStep('power')` 一併把 `powerMonitor` 的 `suspend`／`resume` 接到睡眠補償。
  - `before-quit` 時停止偵測（同 `canvas.stop()`）。
  - 系統匣動作加上示範模式。
- `src/main/detection/`：
  - 新增 `detection.ts`：持有 `sessions`、執行中轉接器的健康狀態、示範模式。對 StageView 提供 `get()`／`onChange()`，介面比照 `src/main/windows/stage-sources.ts` 的 `WindowsStageSource`。
  - 新增 `clock.ts`：睡眠補償的單調時鐘，可注入 `monotonic` 與 `wall` 兩個時鐘。
  - 新增 `adapters/demo/`：示範轉接器，提供 `setState(state)` 與 `stop()`。只透過注入的 `emit` 送事件；計時器、牆鐘、`timings` getter 都可注入。Epic 3 的右鍵選單會呼叫同一個 `setState`。每次開啟、切換、關閉記一行 `detection` 紀錄（只記狀態代碼）。
  - `sessions.ts` 的 `receive`：丟掉 `via: inferred`。
  - `reducer.ts`：推測 request 的 id 不在 `openTools` 時，回傳原物件。
  - 依賴方向：`main/detection` 不得 import `main/windows`，跨模組由 `main.ts` 接線；CI 會跑 `no-circular`。
- `src/main/stage-view/stage-view.ts`：
  - `StageViewSources` 加 `detection`。
  - `publish` 先以 `stageViewSectionsSchema` 驗證：不通過就記 `stage-view` 錯誤（只記區段名與欄位路徑），`rev` 與 `view` 都不變。
- `src/shared/stage-view.ts`：加 `sessions`、`adapters` 的 schema，`sessionKey`、`source` 不得重複；加入 `stageViewSchema`、`stageViewSectionsSchema`，另加 `StageViewDetectionSections` 型別。
- `src/shared/sources.ts`：加來源的中文顯示名（`demo` 為「示範」），以及健康代碼與中文名（`ok` 正常、`degraded` 部分可用、`missing` 找不到）。
- `src/main/windows/menu.ts`：系統匣選單在頁面項目之後、分隔線之前，加子選單「示範模式」。子選單是 radio 項目：「關閉」，以及依 `STATE_CODES` 順序列出的 8 個中文狀態名（`src/shared/states.ts`）。`TrayMenuActions` 加 `setDemo(state | null)`。
- `src/panels/App.tsx`：`page === 'sessions'` 時顯示新的 sessions 頁元件。文字與排序邏輯放進可單獨測試的 `src/panels/session-rows.ts`，比照 `display-options.ts`。`displayName` 為 null 時顯示原生 id。
- 測試：
  - 純邏輯放 `test/main/`、`test/shared/`、`test/panels/`，比照 `windows-stage-sources.test.ts`、`display-options.test.ts`；
  - 沒有 DOM 環境，不要加 jsdom。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/stage-view.ts`、`src/shared/sources.ts`：新區段的 schema 與顯示名。
- [x] `src/main/detection/clock.ts`、`detection.ts`、`adapters/demo/`：偵測、睡眠補償、示範轉接器。
- [x] `src/main/detection/sessions.ts`、`reducer.ts`：兩項防護。
- [x] `src/main/stage-view/stage-view.ts`：偵測來源與推送前驗證。
- [x] `src/main/windows/menu.ts`、`src/main/main.ts`：示範模式子選單與接線。
- [x] `src/panels/session-rows.ts`、`App.tsx`：「管理 session」頁。
- [x] 測試：
  - I/O 矩陣每一列；
  - 示範模式在假時鐘下，8 種狀態兩兩互換（8×8）都成立；選定後過 3 小時仍維持；
  - 新 schema 的往返與拒絕；
  - 系統匣子選單。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when app 啟動完成，then run log 沒有 `detection`、`stage-view` 錯誤。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - 示範 session 的 key 是 `demo:1`；工具名 `demo`，工具 id 每次切換都新產生（`demo-tool-<n>`）；`via` 用 `log`。`sync.ready` 在轉接器建立（每次打開示範模式）時送。
  - 示範轉接器除了 `setState`、`stop`，另有兩個方法，都只送一般共用事件、經 `sessions.receive`：
    - `retime()`：設定改變時由偵測呼叫；只有目前狀態「維持」用的那個計時值變了，才重送該狀態的切換事件。否則像 `doneMs` 從 60 秒改成 1 秒時，下一次重送要等 30 秒，中間會掉成「等你回覆」；「休息中」把 `idleMs` 調大時，最後事件時間只會往前走，也必須重來。
    - `refresh()`：醒來時呼叫；先重送 `session.start`、`session.meta`，再送切換事件。睡眠期間轉接器的計時器不跑，睡超過 `sessionExpireMs` 時示範 session 已逾時；不重開會變成沒有名稱的 session（測試抓到過）。
  - 偵測把「一次切換／一次設定變更／一次醒來」造成的變化合併成一個通知，所以 StageView 每次只推一個增量；「休息中」的結束再開不會讓面板看到中間沒有 session 的狀態。
  - 每次設定改變都呼叫 `sessions.retime()`；示範只在相關計時值變了才重送。
  - 睡眠時鐘：`suspend` 連續兩次保留第一次的讀數；沒有先 `suspend` 的 `resume` 不補；醒來時記一行 `detection`（補了幾毫秒）。
  - 判斷器防護：推測 request 對不到進行中 tool 時回傳原物件；若是該 session 的第一筆事件，回傳全新的空條件（同 `session.meta`）。轉接器送來的 `via: inferred` 記 warn，只記事件類型與來源。
  - StageView 驗證失敗記 `stage-view` error，內容是區段名與欄位路徑；windows 區段也一樣受驗證（順帶處理 deferred R16）。
  - 來源顯示名：Claude Code、Codex CLI、Gemini CLI、Cursor、Copilot CLI、示範。面板排序：來源（`SOURCE_CODES` 順序）→ 名稱 → key，用字碼比較，狀態改變時列不移動；轉接器依來源順序。
  - `watchSleep(powerMonitor, detection)` 放在 `detection.ts`，在 `startupStep('power')` 之後另起 `startupStep('sleep')`；`detection.stop()` 用自己的 `before-quit` listener，`canvas.stop()` 丟例外也不會跳過。
  - 「休息中」的重送間隔是 min(`idleMs`, `sessionExpireMs` − `idleMs`) / 2，否則回推的 session 會在兩次重送之間逾時；`idleMs` 或 `sessionExpireMs` 改變都會重送。`idleMs` ≥ `sessionExpireMs` 時任何 session 都到不了 `idle`：照常送切換事件（session 因而結束），記一行 `detection` warn，不排重送。2.9 做計時值設定時要決定是否擋這種組合。
  - 「示範模式」字樣（`DEMO_MODE_LABEL`）放在 `src/shared/sources.ts`，選單與面板提示共用；示範 session 名稱取自 `SOURCE_DISPLAY_NAMES.demo`。Epic 3 的右鍵選單要呼叫 `detection.setDemo`，不直接呼叫轉接器的 `setState`。
- 驗證：開發代理跑過 typecheck、lint、`npm test`（40 個檔案、1779 個測試）、depcruise（0 違規），全部通過。I/O 矩陣每一列都有測試：偵測端在 `test/main/detection.test.ts`（含 8×8、8 種狀態各維持 3 小時、睡眠、改計時值），壞增量在 `test/main/stage-view.test.ts`，兩項防護在 reducer／sessions 測試，面板文字在 `test/panels/session-rows.test.ts`。用隔離的 `--user-data-dir` 跑 `npm start`，啟動後等過 `syncTimeoutMs`，run log 沒有 `detection`、`stage-view` 錯誤，之後正常結束；系統匣與面板沒有實際操作（無法自動化，由單元測試涵蓋），使用者驗收那一項尚未做。
- 主 session 核對：讀過 `d5987c2` 以來 `src/` 的完整 diff，7 項任務與 2 條驗收條件都已完成。重跑 typecheck、lint、`npm test`（40 個檔案、1779 個測試、0 跳過）、depcruise（0 違規），全部通過；I/O 矩陣 12 列都有對應測試（`detection.test.ts`、`stage-view.test.ts`、`session-rows.test.ts`、`detection-reducer.test.ts`），都有執行並通過。系統匣切換 8 種狀態的人工驗收尚未進行。
- 審查修補（第 1 輪，6 項）：示範「休息中」的重送間隔改為 `min(idleMs, sessionExpireMs − idleMs) / 2`，`sessionExpireMs` 改變時也重送，`idleMs >= sessionExpireMs` 時記 warn、不排計時器；`watchSleep` 改為獨立的 `startupStep('sleep')`，`detection.stop()` 改為獨立的 `before-quit` 監聽；示範轉接器註解改指向 `detection.setDemo`；空狀態提示改為兩個平台都適用的寫法；「示範模式」標籤移到 `src/shared/sources.ts` 的 `DEMO_MODE_LABEL`，`DEMO_DISPLAY_NAME` 改取 `SOURCE_DISPLAY_NAMES.demo`；表格加 `overflow-wrap: anywhere`。主 session 修補後重跑：typecheck、lint、`npm test`（40 個檔案、1788 個測試）、depcruise（0 違規）全部通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-10）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| B1、E1、E5、VG-O1 | `sessionExpireMs` 小於 `idleMs` 的 1.5 倍時，示範的「休息中」撐不住：session 在兩次重送之間逾時、消失，重新出現時沒有顯示名稱 | medium | patch | VG 用真的 `createDetection` 跑 3 小時驗證過；兩個值都在設定範圍內（`idleMs` 最大 1 小時，`sessionExpireMs` 最小 1 小時）。違反「計時值變了也照樣維持所選狀態」。修法：重送間隔改為 `min(idleMs, sessionExpireMs − idleMs) / 2`，`sessionExpireMs` 改變時也重送；`idleMs >= sessionExpireMs` 時任何 session 都不可能 idle，記一筆 warn、不排計時器，兩值的交叉檢查記到 deferred-work 給 2.9 |
| B4、E2 | `watchSleep` 與 `watchPower` 在同一個啟動步驟，`watchPower` 丟例外時睡眠補償就沒接上；`before-quit` 裡 `canvas.stop()` 丟例外時 `detection.stop()` 不會執行 | low | patch | `main.ts:284-286`、`before-quit` 處；拆成獨立的 `startupStep('sleep')` 與兩個 `before-quit` 監聽，屬直接修正 |
| B6 | `demo.ts` 開頭註解說 Epic 3 的右鍵選單會直接呼叫 `setState()`，但直接呼叫會跳過 `detection.setDemo` 的合併通知與健康狀態 | low | patch | 改成指向 `detection.setDemo`；方塊角色空殼的 session 也需要知道 |
| B7、E4 | 空狀態提示寫「選單列圖示」，Windows 上是系統匣（通知區域） | low | patch | `tray.ts` 有 `win32` 分支；改成兩個平台都適用的寫法 |
| B8 | 顯示字串重複：提示寫死「示範模式」，`menu.ts` 另有 `DEMO_MENU_LABEL`；`DEMO_DISPLAY_NAME` 重複 `SOURCE_DISPLAY_NAMES.demo` | low | patch | 違反「中文顯示名只定義一處」；把選單標籤移到 `src/shared`，兩邊共用 |
| B9 | 沒有顯示名稱時，名稱欄顯示的原生 id 最長 256 字元且通常沒有空白，表格會橫向撐開 | low | patch | `index.css` 的 `.session-table` 沒有換行設定；加 `overflow-wrap: anywhere` |
| B5 | 系統匣的示範模式勾選由 Electron 自己管，不跟偵測的實際狀態同步；之後有方塊角色的右鍵選單時兩邊會不一致 | maybe-false（若成立為 medium） | defer | 目前只有系統匣一個入口，不會發生；方塊角色空殼加上第二個入口時要一起處理 |
| B11 | `adapters` 沒有「同步中」狀態，2.4 起補讀期間頁面會顯示沒有 session、轉接器卻是正常 | maybe-false（若成立為 medium） | defer | 示範轉接器不補讀，遇不到；第一個會補讀的是 2.4 |
| VG1 | 「推測」標示與空狀態只在 `session-rows.ts` 測到布林值與字串，`App.tsx` 的渲染沒有任何測試執行到 | medium | defer | 規格明定不加 jsdom；示範模式也產生不了推測狀態，人工驗收看不到標示。留給端到端測試那一項，以測試用的推測 session 驗證渲染 |
| B2 | 被丟掉的增量讓該區段在 StageView 停在舊值，直到那個區段再變動 | low | reject | 要有程式錯誤產生不合 schema 的資料才會發生；區段下次變動時整段取代就恢復，比推出壞資料好 |
| B3 | `publish` 的 `safeParse` 沒有 try/catch | false | reject | 新加的 refine 只對已驗證過型別的陣列與字串運算，沒有會丟例外的路徑 |
| B10 | 「推測」的說明只在 tooltip | low | reject | 「推測」標示本身是看得到的文字，tooltip 只是補充 |
| B12 | `detection.stop()` 後 `get()` 仍回傳舊區段 | low | reject | 只在 app 結束時呼叫，之後沒有使用者 |
| B13 | 面板上 `degraded` 與 `missing` 同色 | low | reject | 目前唯一的轉接器只會是 `ok`；2.4 出現第一個會 `degraded` 的轉接器時再調色 |
| B14 | 丟掉推測事件的警告沒有限流 | low | reject | 同 2.2 審查 B7：要有轉接器的程式錯誤才會發生 |
| E3 | `suspend` 沒有對應的 `resume`、之後牆鐘又被調快，調快的量會被當成睡眠加進時鐘 | low | reject | 要同時漏掉 resume 事件又遇到牆鐘調整；影響以調整量為限 |

## Design Notes

**示範轉接器怎麼產生並維持每一種狀態。** 轉接器記得自己開了什麼（是否在 turn 中、開著的工具 id）。切換時先送 `tool.end` 關掉開著的工具，同 id 的 request 會一起關掉，再送下表的事件。「維持」欄是計時器每隔「該計時值的一半」重送的事件，每次重讀 `timings`。

| 狀態 | 切換時送出 | 維持 |
|---|---|---|
| 思考中 | `turn.start` | 每 `idleMs/2` 送 `activity`，免得逾時 |
| 工作中 | `turn.start`、`tool.start` | 同上 |
| 要你批准 | `turn.start`、`tool.start`、`approval.request`（同 id） | 同上 |
| 要你決定 | `turn.start`、`tool.start`、`question.request`（同 id） | 同上 |
| 出錯了 | `turn.start`、`error` | 每 `errorHoldMs/2` 送 `error` |
| 做完了 | `turn.start`、`turn.end` | 每 `doneMs/2` 送 `turn.end`（判斷器每次都會重設 `turnEndedAt`） |
| 等你回覆 | `turn.start`，再送 `replay: true` 的 `turn.end`（離開 turn，但不進入「做完了」） | 每 `idleMs/2` 送 `activity` |
| 休息中 | `session.end`，再送 `replay: true` 的 `session.start`、`session.meta`，`ts` 為牆鐘減 `idleMs` | 每 `idleMs/2` 送 `replay: true` 的 `activity`，`ts` 同樣回推 |

「休息中」只能靠「最後事件已超過 `idleMs`」產生，而判斷器的最後事件時間只會往前走，所以必須結束再重來。這是示範模式的已知限制：Epic 3 接上角色後，選「休息中」時那隻角色可能換成另一隻。

**偵測放在 StageView 之前建立。** StageView 在 `ready` 之前建立，偵測不需要 Electron API，可以先建立。`syncTimeoutMs` 從那一刻開始算；示範轉接器不補讀，第一次啟動時直接送 `sync.ready`。

2.2 留給 2.3 的「同步是一次性的」與「同步期限過後才到的補讀」兩項，只有會補讀的真實轉接器才會遇到，已改到 2.4 決定。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規

**Manual checks:**
- 開發代理：用 `--user-data-dir` 指向隔離的資料夾執行 `npm start`，確認啟動後 run log 沒有錯誤；不碰使用者的 app，也不截圖。系統匣無法自動操作，示範模式的切換由單元測試涵蓋。
- 使用者驗收：從系統匣的示範模式依序選 8 種狀態，「管理 session」頁跟著顯示；run log 每次切換有一行 `detection` 紀錄。
