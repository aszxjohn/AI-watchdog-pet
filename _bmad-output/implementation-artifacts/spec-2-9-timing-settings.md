---
title: 'Story 2.9：調整計時值'
type: 'feature'
created: '2026-11-12'
baseline_commit: '8db00feb49af7cac2f8348445c57e37165101021'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「做完了」過場、轉休息中、推測要你批准這三個計時值只能手改 `settings.json`。另外，面板送出設定後，即使 `settings.json` 寫不進去也照樣顯示成功，重開後卻回到舊值（Epic 1 retro R15）。

**Approach:**
- 舞台設定頁在螢幕選項下加「計時」區，三個欄位用秒或分鐘輸入，加一個「儲存」按鈕。面板依共用 schema 的範圍先檢查，再經既有的 `settings:patch` 寫入，main 會再驗一次。
- `settings:patch` 的回覆加上「有沒有存到檔案」，沒存到時面板要提示；螢幕選項也套用這個提示。
- 判斷器與推測在設定變更時立即重算，Story 2.2 已經做好，這裡只補測試。

**Decisions（2026-11-12）：**
- 三個欄位：
  - 做完了過場：秒，預設 5，範圍 1～60。
  - 無動靜轉休息中：分鐘，預設 5，範圍 1～60。
  - 推測要你批准：秒，預設 10，範圍 1～600。
  - 都只接受整數。範圍只取自 `src/shared/settings.ts` 的 schema，面板不另外寫數字。
- 檔案裡手改成非整數單位的值（例如 `doneMs: 1500`）照實顯示成小數（1.5）。沒改的欄位不送出。
- 一個「儲存」按鈕送出所有改過的欄位。儲存成功後，輸入框回到 StageView 的值。
- 面板不擋卸載：關閉面板或切頁時，沒按儲存的輸入直接丟掉（依 epic 2 context：面板不得阻擋卸載）。
- 「沒存到檔案」的定義：這次執行無法寫 `settings.json`（`canWrite` 為 false），或上一次寫檔失敗、之後還沒成功過。
  - 這時值仍在記憶體生效，所以面板提示「已套用，但無法存到設定檔，重新啟動後會回到原本的值」，不當成失敗。
  - 有存到時顯示「已儲存」。
  - 回覆之後才發生的寫檔失敗只記 log：寫檔有 debounce，回覆時還沒寫。
- 範圍重疊（使用者 2026-11-12 選 B）：`sessionExpireMs` 的下限從 60 分鐘改成 61 分鐘，讓休息中（最長 60 分鐘）一定比逾時短。手改成 60 分鐘的檔案，啟動時這一欄回到預設的 2 小時。
- 規格約 2700 token，使用者選擇保留全文。

## Boundaries & Constraints

**Always:**
- 寫入只走 `settings:patch`：一次儲存只送改過的欄位，全部放在同一個 patch 的多個 op 裡。畫面上的目前值只依 StageView 的 settings 區段。
- 面板檢查用的是 main 同一份 `settingsFieldSchemas`。main 照舊在 `registerIpcHandler` 與 `store.patch` 再驗證。
- 面板的純邏輯放在 `src/panels/*.ts`，不用 React、不碰 DOM，做法照 `display-options.ts` 的 `createDisplayChooser`：送出中停用欄位與按鈕，結束後一律復原，永不 reject。

**Never:**
- 不改判斷層、推測、sessions 的計時邏輯，只加測試。
- `errorHoldMs`、`sessionExpireMs`、`discoveryWindowMs`、`syncTimeoutMs` 不放上面板。
- settings 寫檔不改成同步，也不拿掉 debounce。
- 面板不加 `beforeunload`。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 顯示 | 打開舞台設定 | 三欄顯示 StageView 的目前值，並標出單位與範圍 |
| 送一欄 | 做完了改成 8，按儲存 | patch 只帶 `doneMs: 8000`；StageView 更新後欄位顯示 8 |
| 送多欄 | 三欄都改 | 一個 patch，三個 op |
| 沒改 | 沒改任何欄位 | 儲存按鈕停用，不送 |
| 超出範圍 | 休息中輸入 0、61、2.5、空白、`abc` | 該欄顯示範圍提示，整次儲存都不送 |
| 繞過面板 | patch 直接帶 `idleMs: 3_600_001` | main 回 `invalid-input`，值不變 |
| 存不到 | `canWrite` 為 false，或上次寫檔失敗 | 值照常生效；顯示「已套用，但無法存到設定檔…」；螢幕選項也顯示同一段文字 |
| 送出失敗 | patch 回 `ok: false` 或丟例外 | 顯示錯誤，保留輸入，可以再送 |
| 送出中 | 還在等 main 回覆 | 欄位與按鈕停用 |
| 推測改值 | 工具已跑 8 秒，推測門檻從 10 秒改成 5 秒 | 立即推測為要你批准 |
| 休息中改值 | 最後事件在 3 分鐘前，休息中從 5 分鐘改成 2 分鐘 | 立即轉為休息中 |

</frozen-after-approval>

## Code Map

- `src/shared/settings.ts`：
  - `settingsPatchResultSchema` 加 `saved: z.boolean()`。
  - `sessionExpireMs` 的下限改成 `3_660_000`，欄位註解寫明理由（大於 `idleMs` 的上限）。
  - 面板可以直接讀 `settingsFieldSchemas.<field>.minValue` / `.maxValue`（zod 4.6.7 有這兩個屬性），不要另外存一份數字。
- `src/main/settings/store.ts`：
  - `patch` 的回覆加 `saved: canWrite && !lastWriteFailed`。
  - `writeNow` 寫檔失敗時設 `lastWriteFailed`，成功時清掉。
  - 沒變化的 patch 也回同樣的 `saved`。
  - 既有的 log 文字不變。
- `src/panels/timing-fields.ts`（新）：
  - 三個欄位的定義：欄位名、標籤、單位、`unitMs`。
  - 從 StageView 取顯示值。
  - 把輸入文字解析成毫秒，或回傳錯誤文字。
  - 只把改過的欄位組成 patch。
  - `createTimingSaver(patch, onState, logError)`。
- `src/panels/display-options.ts`：`createDisplayChooser` 在 `result.ok && !result.data.saved` 時顯示「沒存到」提示。這段文字是兩個模組共用的同一個常數。
- `src/panels/App.tsx`：
  - `StageSettings` 在螢幕選項的 fieldset 之後加「計時」fieldset：三個輸入框，各帶單位、範圍與該欄的錯誤。
  - 加儲存按鈕。
  - 結果行：已儲存或沒存到用 `role="status"`，失敗用 `role="alert"`。
- `src/panels/index.css`：「計時」區的最少樣式。
- 測試：
  - `test/shared/settings.test.ts`：回覆 schema 的往返與拒絕；`sessionExpireMs` 範圍那一列改成新下限。另外加一個斷言：`idleMs` 的上限小於 `sessionExpireMs` 的下限，以後改範圍時會被抓到。
  - `test/main/settings-store.test.ts`：`saved` 在正常時為 true；`canWrite` 為 false 時為 false；寫檔失敗後為 false，直到下次寫成功。
  - `test/panels/timing-fields.test.ts`（新）、`test/panels/display-options.test.ts`。
  - `test/main/detection.test.ts`：透過假 settings 改 `approvalInferMs`、`idleMs`，確認立即生效。

**不要改：** `src/main/detection/**`、`src/preload/stage-view.ts`、IPC 註冊與 sender 檢查。

## Tasks & Acceptance

**Execution:**
- [x] `shared/settings.ts`、`main/settings/store.ts`：加 `saved`，調 `sessionExpireMs` 下限，並補 schema 與 store 測試。
- [x] `test/main/detection.test.ts`：補「推測改值」「休息中改值」兩列的測試。
- [x] `panels/timing-fields.ts`、`display-options.ts`：寫面板邏輯與測試，I/O 矩陣的面板列都要涵蓋。
- [x] `App.tsx`、`index.css`：畫出「計時」區。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過；detection 與 inference 的既有斷言不變；settings 回覆的既有斷言只多一個 `saved`。

## Implementation Notes

- 2026-11-13 實作時規格沒寫明、開發代理自行決定的部分：
  - 欄位標籤由 `STATE_DISPLAY_NAMES` 組出（做完了過場、無動靜轉休息中、推測要你批准），沒有另寫狀態名。
  - 輸入框用 `type="text"`、`inputMode="numeric"`，只收半形數字；前後空白與前導零（`05`）可以，全形數字（`８`）會被擋。
  - 錯誤邊打邊顯示；有任何一欄有誤時儲存按鈕停用。
  - 儲存成功（含「沒存到」）後清掉輸入，欄位回到 StageView 的值；若 StageView 的更新比回覆晚到，會短暫顯示舊值。
  - 無法整除的手改值照實顯示完整小數（例如 `idleMs: 100000` 顯示 1.6666666666666667）。
  - `writeNow` 的「值不符 schema 不寫」分支沒有設 `lastWriteFailed`（規格只要求寫檔失敗時設，該分支實際走不到）。
- 2026-11-13 驗證：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`、`CI=true npm test`（64 檔、2786 個測試）全過。刪掉的 `expect(` 都改寫成多驗 `saved` 或 `notice` 的版本；`src/main/detection/**`、`src/preload/stage-view.ts`、IPC 註冊沒有改動。I/O 矩陣 11 列都有測試且都有跑。開發代理另在 scratchpad 用 `react-dom/server` 把 `StageSettings` 渲染成 HTML，確認三欄、單位、範圍與停用狀態（專案檔案沒動）；打字與送出的互動只有純邏輯測試，沒有實際操作過面板。
- 這次一併處理的延後項目：Epic 1 retro R15（存不到也顯示成功）、Story 2.3 審查 B1／E1 與方塊空殼審查 E5／E6（`idleMs` 不小於 `sessionExpireMs`）。
- 2026-11-13 審查修補後：改欄位時清掉上一次的儲存結果（送出中不動）；草稿先 `normalize('NFKC')` 再解析與比較，全形數字等同半形，並補測試。我重跑四項檢查全過（64 檔、2795 個測試）；刪掉的 9 行 `expect(` 都是改寫成多驗 `saved`／`notice` 的版本。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-13）：Blind Hunter 14 條（B1–B14）、Edge Case Hunter 11 條（E1–E11）、Verification Gap 1 個缺口（VG1）與 2 條其他發現（VO1、VO2）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B4、E4 | 存完後再改欄位，上一次的「已儲存」或錯誤仍與新的未儲存草稿並列 | low | patch | `state.outcome` 只在下一次 `save` 開始時歸零；每次存完再改都會遇到，修正是 `onChange` 裡一行 |
| B5、E1 | 全形數字（「８」）被當成錯誤，錯誤文字沒說原因，也沒有測試 | low | patch | `WHOLE_NUMBER` 只收 `[0-9]`；中文輸入法全形模式會打出全形數字。解析前 `normalize('NFKC')` 是直接修正 |
| VG1、B12 | `App.tsx` 的「計時」區與兩區的提示渲染（沒存到提示、`role`、成功後清草稿）沒有任何自動測試 | medium | defer | 驗證缺口已附證據：`vitest` 是 node 環境，沒有測試 import `App.tsx`；拿掉 `state.notice` 那段 CI 仍全綠。與 2.8 的延後項目同一類，需要 DOM 測試環境 |
| B1、E5、E6 | `saved` 只反映回覆當下：第一次寫檔失敗仍顯示「已儲存」；之後寫成功，「沒存到」提示也不會消失；兩區各自只顯示自己那次的結果 | low | reject | 定案區塊明寫「回覆之後才發生的寫檔失敗只記 log（debounce，回覆時還沒寫）」，以回覆為準是核准過的取捨；改成經 StageView 推送存檔狀態是新功能 |
| B2、E7 | 寫檔失敗後，沒變化的 patch 不會排重試，使用者也點不出重試 | low | reject | 面板對沒變化的值根本不送 patch，只改 store 也到不了使用者；下一次改值或 `will-quit` 的 `flushSync` 會重試（1.4 既有行為） |
| B3、E3 | 儲存後先清草稿，若 StageView 更新比回覆晚到，欄位會閃回舊值 | low | reject | `store.patch` 內同步 `notify` → `stage-view` `publish` → `pushToRenderer`，增量早於 handler 回覆送出；只有 rev 斷號、preload 重新同步時才會晚到。修正要多傳 rev、加比較 |
| B6 | 清空欄位重打時立刻顯示範圍提示 | low | reject | 定案的 I/O 矩陣「超出範圍」列就規定空白要顯示範圍提示 |
| B7 | 送出時 `fieldset disabled` 讓焦點掉到 body，鍵盤使用者要重新 Tab | low | reject | 面板以滑鼠操作為主，螢幕選項（1.6）與釋放按鈕（2.8）是同一寫法；修正要加 ref 與還原焦點，不是直接修正 |
| B8、E10 | `role="status"`／`role="alert"` 的段落與文字一起掛上，螢幕閱讀器可能不念 | low | reject | 支援度因閱讀器而異、這個面板少有閱讀器使用者；改成常駐容器要處理空容器的版面，不是直接修正。`setting-error` 從 1.6 起就是同一寫法 |
| B9 | 做完了 60 秒且休息中 1 分鐘時，「做完了」直接轉「休息中」，不出現「等你」 | low | reject | 兩個都要調到極端值；結果符合兩個值的定義（最後事件 1 分鐘後就是休息中）。要避免得改定案的做完了範圍 1～60 |
| B10、E11、VO2 | detection 測試仍用 60 分鐘的 `sessionExpireMs`，demo 的「`idleMs` 不小於 `sessionExpireMs`」防護經過驗證的設定已走不到 | low | reject | 定案的 Never 不改判斷層；detection 不驗證輸入，防護與測試仍是有效的防禦性涵蓋，沒有使用者可見的影響 |
| B11 | `deferred-work.md` 的 R15、B1／E1、E5／E6 沒有結案 | false | reject | `deferred-work.md` 依流程只附加、不改既有項目；結案記錄在本規格 Implementation Notes |
| B13 | `timingRange` 在 schema 沒有上下限時退回 `0`／`MAX_SAFE_INTEGER` | low | reject | 三個欄位的 schema 都有上下限，`settings.test.ts` 的範圍表鎖住；退回值只是型別上的 `number \| null`，沒有能走到的情況 |
| B14 | `NOT_SAVED_TEXT` 放在 `display-options.ts`、兩區的結果模型不同、螢幕選項成功時不顯示「已儲存」 | low | reject | 螢幕選項成功時選取點立即移動，本身就是回饋；計時區是明確按儲存，需要「已儲存」。共用常數只有一個，沒有指名的分歧點 |
| E2 | 手改成無法整除的值（`idleMs: 70000`）顯示很長的小數 | low | reject | 定案「照實顯示成小數」；只發生在手改檔案時，輸入框內文字可捲動 |
| E8 | `createDisplayChooser` 的 `onState({ saving: true … })` 在 `try` 外，丟例外會卡住 | false | reject | 1.6 既有寫法，這次只多一個欄位；`onState` 是 React 的 `setState`，不會丟例外 |
| E9 | 送出中切頁再切回來，結果不會顯示、可能同時送出第二個 patch | low | reject | 要在回覆前的毫秒內切頁；第二個 patch 由 `baseRev` 合併，值不會錯。定案已說切頁丟掉未存內容 |
| VO1 | 手動驗收步驟寫「唯讀資料夾後儲存就看到沒存到」，但第一次會顯示「已儲存」 | low | reject | 修正是改本規格；正確步驟改在交付說明告訴使用者（存一次、等 0.5 秒以上、再存一次） |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：改做完了秒數並儲存，看示範模式「做完了」停留的時間；輸入超出範圍時被擋下；用隔離的 `--user-data-dir` 啟動，把那個資料夾設成唯讀後儲存，應該看到「沒存到」的提示。
