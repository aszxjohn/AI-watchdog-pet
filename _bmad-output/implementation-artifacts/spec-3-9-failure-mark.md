---
title: 'Story 3.9（下）：第 4 次執行失敗的標記與後果'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_commit: 'e89436a145fa88b85cdee30e1255e408961d3ed4'
route: 'dispatch'
review_loop_iteration: 0
user_preview: approved
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.9（中）完成後，同一個包、同一個版本第 4 次執行失敗時，只會停止重啟，角色一直演佔位。但池子照樣把它分給 session，管理頁也看不出發生了什麼。

**Approach:** 第 4 次失敗時，main/packs 把那個版本標為失敗，標記只存在記憶體，並在同一個 StageView 增量發佈出去。發佈後：
- 池子排除這個包，走 3.9（上）的換角色。
- 管理頁顯示失敗原因。
- 重新匯入或移除那個包時，清掉標記與重啟次數；已經停住的沙盒會重建。

**定案（2026-11-26 使用者）：**
- 示範模式照常示範失敗的包：角色留在台上演佔位，示範選單照樣列出它。重新匯入後自動恢復。
- 工作區裡另一個 session 留下、還沒 commit 的檔案不動，也不放進這次 commit：`CODEMAP.md`、`.ignore`、`scripts/gen-codemap.mjs`、`_bmad/custom/bmad-build.toml`、`ci.yml`、`package.json`。
- 管理頁的文字：「執行失敗，這次執行已停用：<原因>。重新匯入或重新啟動 app 後恢復。」<原因> 顯示中文說明；程式裡判別用的值是英文代碼。

## Boundaries & Constraints

**Always:**
- 標記與重啟次數都放在 packs store 的記憶體裡，不寫進 index.json。以 packId 為 key，記錄失敗的版本與原因；只有目前安裝的版本才算數。
- `StagePack` 加一個選填的失敗標記，內容是原因代碼。`packIndexEntrySchema` 不動。
- 標記、`packs` 區段，以及因此換掉的 `actors`，要在同一個 StageView 增量發佈。做法是把 `packs:runtime-failed` 的 handler 包在 `stageView.batch` 裡。
- 「失敗」等同未上場：`poolOf` 排除它。「上場」勾選框和設定值都不動。
- 重新匯入那個包（任何版本，包括同版本），或移除它，就清掉它的標記與次數。
- overlay：main 回「不重啟」時，把那個沙盒記為「停住」。之後如果那個包的 `StagePack` 沒有失敗標記了（重新匯入清掉的），而它仍有 actor，就拆掉沙盒、以 recovering 狀態重建；重建期間角色演佔位，直到第一則有效的 draw。版本改變時照既有規則處理。

**Never:** 不改示範模式的選角邏輯；不寫入角色包檔案或 settings；不做探針 e2e（另一筆 deferred）；不改共用訊息額度（另一筆 deferred）。

## I/O & Edge-Case Matrix

| 情境 | 狀態 | 結果 |
|---|---|---|
| 第 4 次 | 同一個包@版本第 4 次失敗 | main 回不重啟並標記失敗。同一個增量裡有 `packs`（含標記）和 `actors`（被換掉的）。管理頁顯示原因 |
| 池子只剩它 | 失敗的包是池子裡唯一的包 | 角色收回，session 留在清單 |
| 示範中 | 正在示範的角色，它的包被標記 | 示範照舊，角色演佔位；示範選單仍列出它 |
| 同版本重新匯入 | 已標記的包重新匯入同一版本 | 標記與次數清掉、池子恢復；停住的沙盒重建 |
| 新版本 | 已標記的包匯入新版本 | 同上，次數從 0 起算 |
| 移除 | 已標記的包被移除 | 標記清掉，其餘照既有移除流程 |
| 重新啟動 app | — | 沒有標記（只存在記憶體） |

</frozen-after-approval>

## Code Map

- `src/main/packs/store.ts`：
  - `stagePackOf`／`sectionOf`（`:217`、`:235`）：合併失敗標記。
  - `save()`（`:515`）：某個包的項目被換掉或移除時，清掉它的標記與次數，然後才通知 listener。
  - 新增「記錄失敗、標記」的方法：通知 listener，但不寫檔。
- `src/main/packs/runtime-failures.ts`（3.9 中）：
  - 計次：現在是自己用 Map 計，改用 store 的計次。
  - 第 4 次：請 store 標記失敗。
  - log：拿掉「角色回來會再開機」的說法。
- `src/main/main.ts`：在 `:384` 一帶，把 handler 包進 `stageView.batch`；`batch<T>` 會回傳 run 的結果。
- `src/shared/packs.ts`：
  - `stagePackSchema`（`:171`）加選填的標記。
  - `:120` 的舊註解要改，它寫標記放在 index 項目裡。
  - 注意：`shared/sandbox.ts` 已經 import `shared/packs.ts`，原因的 enum 不要造成循環引用（depcruise 會擋）。
- `src/main/pool/assign.ts`：`poolOf`（`:137`）排除失敗的包，檔頭註解補一句。不要動的：示範用的 `isInstalled`，以及 `src/main/pool/demo-mode.ts` 的 `demoCharactersOf`（`:138`）。
- `src/overlay/pack-host/host.ts`（3.9 中）：
  - `askRestart`：main 回 no 時，把沙盒標為停住。
  - `onView`（`:800` 一帶）：遇到停住的沙盒，若標記已經不見而且仍有 actor，就 `destroy` 再 `start(packId, true)`。
- `src/panels/pack-list.ts`：
  - 在 `incompatibleText`（`:105`）旁加失敗文字，以及原因代碼對中文說明的對照表。
  - `PackListPack`（`:182`）加一個欄位。
- `src/panels/App.tsx`：比照 `:664` 的 `pack-incompatible` 那段 note 顯示失敗文字。
- `docs/pack-api-v1.md`：8.4 第 3 點改寫成最終行為。
- 測試沿用現有的：
  - `test/main/pool-assign.test.ts`（用 `fakePacks`）
  - `test/main/packs-store.test.ts`
  - `test/main/packs-runtime-failures.test.ts`
  - `test/main/settings-patch-batch.test.ts`（真的 StageView 增量）
  - `test/overlay/pack-host.test.ts`
  - `test/panels/pack-list.test.ts`

## Tasks & Acceptance

**Execution:**
- [x] shared、store、runtime-failures、main.ts batch。測試：標記與清除；第 4 次的標記和 `actors` 在同一個增量。
- [x] pool `poolOf`。測試：標記後換角色、池子空了就收回、示範不受影響。
- [x] overlay：停住與重建。測試：同版本重新匯入後重建，角色先演佔位、畫出第一格後恢復。
- [x] panels：失敗文字與原因對照。測試：`packListView` 的輸出。
- [x] 文件 8.4。

## Verification

- 預覽前：`npm run typecheck`，加上改到的測試檔。
- 預覽之後：`npm test`、`npm run lint`、`npm run depcruise` 各跑一次；e2e 只在 CI 跑。

## Implementation Notes

- 分兩層實作（2026-11-26）：第 1 層 shared、main/packs store、runtime-failures、main.ts batch、`poolOf`；第 2 層 overlay、panels、文件。
- 原因代碼從 `shared/sandbox.ts` 搬到新檔 `src/shared/sandbox-failures.ts`（沒有任何 import），`sandbox.ts` 原樣 re-export；這樣 `shared/packs.ts` 用得到原因 enum，又不會跟 `sandbox.ts` 循環引用。
- 標記的形狀：`StagePack.runtimeFailed?: SandboxFailureReason`，沒標記時沒有這個 key。計次與標記放在 packs store 的記憶體 Map（以 packId 為 key、帶版本）；`save()` 用物件 identity 判斷「被換掉」，所以同版本重新匯入也會清掉。
- overlay：沙盒多 `stopped` 與 `mark`（none → seen → gone）。只在「停住期間看過標記、之後標記消失」才重建，避免增量與 IPC 回覆順序互換、或版本不符（永遠不會有標記）時誤重建；`onView` 對所有沙盒追蹤標記，因為被換掉的角色和標記在同一個增量離場。
- 已知：示範的角色全部離場超過 `sandboxIdleMs` 後再示範被標記的包，沙盒會重新開機一次（文件 8.4 已寫明）；IPC 失敗時沙盒不算停住，標記消失也不重建（跟 3.9 中相同）。
- 檢查（2026-11-26，預覽前）：`npm run -s typecheck` 通過；改到的 10 個測試檔、678 個測試通過。
- 預覽（2026-11-27）：使用者選擇跳過實機預覽、直接進審查；畫面上的行為尚未有人實際看過。
- 檢查（2026-11-27，審查修正後）：`npm run typecheck`、`npm run lint`、`npm run depcruise` 通過；完整 `npm test` 118 個測試檔、5640 個測試通過（2 個略過）。e2e 交給 CI。

## Review Triage Log

2026-11-27 三層審查（Blind Hunter 11 條、Edge Case Hunter 5 條、Verification Gap 2 個缺口），合併重複後逐條核對：

- B1／B2／E1／E4 標記出現之後才建的沙盒（示範角色離場超過 `sandboxIdleMs` 再示範）：`start()` 把 `mark` 設成 `'none'`，標記所在的 StageView 已經過去，之後若沒有別的增量，被停住後同版本重新匯入不會重建，示範角色一直演佔位。**medium**，屬實（`onView` 的 `followMark` 在 `start()` 之前跑，版本要等 `getEntry` 回來才有）。**patch**：`onView` 記下最新的 installed，`start()` 拿到版本後對它跑一次 `followMark`；`pack-host.test.ts` 補這條路徑。
- VG-1 「新版本」清除的測試被版本比對遮住：把 `save()` 改成換版本不清，兩個「新版本」測試仍會通過。**medium**（驗證缺口，主路徑）。**patch**：`packs-store.test.ts` 的「新版本」案例斷言清除的 log，並換回原版本確認沒有舊標記、次數從 0 算起。
- B7 清除的 log 在 1 次時寫「1 sandbox failures」，換版本也寫「installed again」看不出新版本。**low**，屬實，直接改字。**patch**：單複數，並帶出新版本號。
- B9 文件 8.4 寫「顯示…與原因」，沒說明只有第 4 次的原因、前幾次在哪。**low**，屬實。**patch**：8.4 補一句。
- B10a `src/main/packs/ipc.ts` 的 `runtimeFailed` 註解沒提第 4 次起會標記。**low**，屬實。**patch**。
- B10b `test/main/windows-main.test.ts` 的註解寫「會標記的那次」，但案例是回 yes 的那次。**low**，屬實。**patch**：改成說明每次回報都包在 batch 裡。
- VG-2／B11 管理頁的失敗提示（`App.tsx` 的 `.pack-runtime-failed`）沒有渲染測試或 e2e，實機預覽也跳過了。**medium**，屬實；repo 沒有 React 渲染測試（vitest 只跑 node 環境）。**defer**：交給 3.9 的探針 e2e 一起驗角色包頁的提示。
- E3 同版本重新匯入、manifest 或素材有改時，overlay 的 `looks.ts` 只以版本為 key，不會重讀外觀；這次新增的重建會用舊外觀檢查新沙盒的 `draw`，可能全部丟棄、再判 `draw-timeout`。**medium**，屬實，但根因（外觀只看版本）是 3.6 起就有的。**defer**。
- E2／E5 同版本重新匯入清掉次數之後，才到達的舊沙盒失敗回報會算在新安裝上，新安裝少一次重建機會。**low**，屬實但要在匯入當下剛好失敗才會遇到；修法要替每次安裝發代號。**reject**。
- B3 `packs:runtime-failed` 的 IPC 失敗時沙盒不算停住，之後重新匯入不重建；文件 8.4 寫成一律重建。**low**，屬實但要 main 的 handler 本身出錯才會遇到，行為與 3.9（中）的 IPC 失敗測試一致，已記在 Implementation Notes。**reject**。
- B4 標記也是 packs 變更，`main/settings/characters` 每次都重讀所有 manifest。**low**，屬實；一包一次執行最多標記一次，成本可忽略；避免要加項目版本號。**reject**。
- B5 `save()` 用物件 identity 判斷「重新安裝」是隱性契約。**low**；目前唯一的寫入路徑 `install.ts`／移除都正確，沒有會出錯的呼叫端；改成明確 API 要加參數。**reject**。
- B6 `markFailed()` 不要求先有計次。**low**；唯一呼叫端 `runtime-failures.ts` 一定先計次。**reject**。
- B8 被標記的包在列表上沒有淡化，上場勾選框沒有 `aria-describedby` 連到提示。**low**；規格定案「上場」不動，現有的不相容提示也是同樣寫法。**reject**。
