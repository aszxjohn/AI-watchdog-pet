---
title: '插單：管理 session 的全部釋放、全部顯示與鎖定展示'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_commit: 'ace09c39e1aa0edbb0a06be14513b9a6edaa0dac'
route: 'dispatch'
review_loop_iteration: 0
user_preview: approved
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「管理 session」頁只能一列一列「釋放／改回顯示」。session 一多，要整批收起或叫回很麻煩。也沒辦法只留幾個想看的 session，讓其他的和之後新開的都不出角色。

**Approach:** 參考舊版（Demo 分支 `SessionPanel.swift`、`SessionPicks.swift`）：
- 頁面上方加「全部釋放」與「全部顯示」兩個按鈕。
- 每列加「鎖定」勾選框，另有「鎖定展示」開關。開關打開時，只有勾選的 session 有角色；其他 session 和之後新出現的都不出角色。
- 狀態由 `main/pool` 擁有，存在 `assignments.json`，經 StageView 的 `pool` 區段回到面板。

**定案（2026-11-26 使用者）：**
- 鎖定照舊版的「只留勾選的」。
- 在 worktree 分支 `feat/session-bulk-lock` 平行做，避開未 commit 的 3.9（中）。

**定案（規劃時決定，使用者看不太出差別的）：**
- 「全部釋放（N）」：N＝清單上目前沒被釋放的 session 數。
  - 先在頁面上確認「把 N 個 session 的角色全部收起來？」，再送出。
  - 送出的是頁面看到的那批 key，一次請求、一個增量、寫一次檔。
- 「全部顯示（M）」：M＝清單上已釋放的數量，不用確認。
- 勾選框隨時能勾、能取消，立刻生效。
- 鎖定展示開著時：
  - 只看勾選與否，「已釋放」不算。
  - 沒勾的列淡化，標「未鎖定」。
  - 釋放類按鈕全部停用，旁邊說明「鎖定中」。
- 鎖定展示的開關：
  - 一個都沒勾時，開關停用。
  - 取消最後一個勾時，main 自動關掉鎖定。
- 鎖定的 key 跟已釋放一樣：啟動同步後，沒被回報的會被清掉（來源未確認的除外）。清到一個不剩時，鎖定自動關掉。
- 示範模式不受鎖定影響（示範本來就獨佔舞台）。

## Boundaries & Constraints

**Always:**
- 寫入只走 `pool:*` invoke，只開給 panels。面板不先改本地狀態，畫面只依 StageView。
- `assignments.json` 升到 `schemaVersion` 3。2→3 的遷移補上 `locked: []`、`lockOn: false`。其餘讀寫規則照 Story 2.8 的做。
- 角色分配只看一個判斷：鎖定展示開著時，「沒勾」的不給角色；關著時，「已釋放」的不給角色。`assign.ts` 裡所有用到「已釋放」的地方都改用這個判斷。
- log 只寫計數，不寫 session key。

**Never:**
- 不改偵測層：鎖定時仍照常偵測、照常列出所有 session。
- 不改示範模式、池子挑角色的規則。
- 不碰 3.9 的檔案範圍（overlay、sandbox、packs）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 全部釋放 | 按下並確認 | 那批全部變已釋放，角色一起收掉；一個增量 |
| 取消 | 確認時按取消 | 什麼都不變 |
| 全部顯示 | 有已釋放的列 | 全部改回顯示，照池子規則分到角色 |
| 打開鎖定 | 勾了 A（A 已釋放）、B 沒勾 | A 有角色、B 沒有；之後新的 C 也沒有 |
| 取消最後一勾 | 鎖定中把 A 也取消 | 鎖定自動關掉，回到一般規則 |
| 重啟 | 鎖定中，A 沒被回報 | A 被清掉；沒有剩下的勾時，鎖定關掉 |
| 舊檔 | v2 的 `assignments.json` | 遷移成 v3，已釋放與分配都保留 |
| 壞輸入 | 非 panels 呼叫，或 key 不合 schema | 擋下，狀態不變 |

</frozen-after-approval>

## Code Map

- **工作目錄**：worktree `/Users/john_tsai_java/tools/gundam-pet-worktrees/session-bulk-lock`（分支 `feat/session-bulk-lock`），以下路徑與 `{project-root}` 都相對於它；不要改主工作區 `/Users/john_tsai_java/tools/gundam-pet`（那裡有別的 story 未 commit 的改動）。這個 worktree 沒有 `CODEMAP.md`，要查就唯讀看主工作區的 `/Users/john_tsai_java/tools/gundam-pet/CODEMAP.md`。
- `src/shared/pool.ts`：`POOL_SCHEMA_VERSION`（`:25`）升到 3；`poolFileSchema`（`:66`）與 `stagePoolSchema`（`:87`）加 `locked`（排序且不重複）和 `lockOn`；比照 `poolSetReleasedInputSchema`（`:130`）新增三個輸入 schema（批次的 key 陣列要設上限常數）。
- `src/main/pool/store.ts`：
  - 檔頭與 `POOL_MIGRATIONS`（`:99`）加 2→3；`poolFileShapeSchema`（`:107`）。
  - 比照 `setReleased`（`:522`）新增 `setReleasedMany`、`setLocked`、`setLockOn`，沒有變化就不通知、不寫檔。
  - `sweep`（`:551`）一併清鎖定的 key。
- `src/main/pool/ipc.ts`：比照現有 handler 新增 `pool:set-released-many`、`pool:set-locked`、`pool:set-lock-on`；`src/main/main.ts:378` 的呼叫照舊。
- 契約：`src/shared/ipc.ts`（`poolSetReleased` 在 `:161`）、`src/shared/preload-api.ts` 的 panels `pool`、`src/preload/panels.ts:30`。
- `src/main/pool/assign.ts` `reconcile`：live 迴圈、parked、restored、`due` 裡用 `released` 的地方，都改用「鎖定或釋放」的判斷；同步改檔頭說明。
- `src/panels/session-rows.ts`：
  - 列加 `locked`，以及「鎖定中未勾」的標示。
  - 新增工具列的計數與文字常數。
  - 批次與鎖定的送出邏輯比照 `createReleaseToggle`（`:242`）：一次只送一個請求、錯誤文字、永不 reject。
- `src/panels/App.tsx` `Sessions`（`:373`）：表格上方放工具列（兩個按鈕、鎖定開關與說明）、每列加鎖定勾選框，行內確認比照角色包移除的 `pack-remove-confirm`（`:668` 一帶）；樣式在 `src/panels/index.css`。
- 測試：`test/main/pool-store.test.ts`、`test/main/pool-assign.test.ts`、`test/panels/session-rows.test.ts`、`test/shared/ipc.test.ts`、panels preload 的測試，只寫矩陣主路徑。

## Tasks & Acceptance

**Execution:**
- [x] shared：schema、v3 遷移、三個 IPC 契約與 preload。
- [x] main/pool：store 的三個寫入與清理、ipc handler、assign 的判斷；寫測試。
- [x] panels：工具列、確認、勾選框、鎖定開關與說明、淡化標示；寫 session-rows 測試。

**Acceptance Criteria:**
- Given 鎖定展示關著，when 勾選某列，then 畫面上的角色不變。
- Given 管理 session 頁，when 看工具列，then 按鈕上的數字跟清單一致，鎖定開關有一行說明現在的效果。

## Verification

- 預覽前：跑改到的測試檔與 `npm run typecheck`。
- 審查後：`npx vitest run --reporter=dot`、`npm run lint`、`npm run depcruise` 一次；e2e 交給 CI。

## Implementation Notes

- 判斷只有一條：`src/shared/pool.ts` 的 `heldBackBy(pool)`。`assign.ts` 與面板的淡化標示都用它。
- `assignments.json` 升 v3（2→3 補 `locked: []`、`lockOn: false`）；`stagePoolSchema` 擋「`lockOn` 開著但沒有鎖定的 key」。批次上限 `POOL_SET_RELEASED_MANY_MAX_KEYS` 1000。
- 面板：`createReleaseToggle` 改名為 `createSessionActions`（所有按鈕共用一個送出中狀態），新增 `sessionToolbar()`；CSS 類名 `is-released`／`released-mark` 改為 `is-held-back`／`held-back-mark`。主工作區的 `CODEMAP.md` 合併後要重新產生。
- `stagePoolSchema` 的新欄位是必填，所以 6 個 packs／overlay 測試的 StageView 假資料各補了一行；3.9（中）合進 main 後，合併這個分支時可能要解衝突。
- 已知邊緣情況：鎖定的 session 在本次執行中結束後，key 留到下次啟動才清；這時把畫面上的勾全部取消，鎖定不會自動關（跟舊版一樣：舊版也是鎖定清單整份清空才關），要手動關開關。審查後（2026-11-27）開關下的說明在這種狀態改成明確提示「開著，但清單上沒有勾選鎖定的 session…關掉開關就恢復」。
- 檢查（2026-11-26，預覽前）：`npm run -s typecheck` 通過；改到的 20 個測試檔、1035 個測試通過。完整測試、lint、depcruise 等預覽核可、審查後一次跑。
- 檢查（2026-11-27，審查修正後，在 worktree）：typecheck、lint 通過；完整 `npm test` 117 個測試檔、5647 個測試通過（2 個略過）。depcruise 的 4 個錯誤都是 worktree 的 `node_modules` 是捷徑、electron 被解析到 repo 外造成的誤判，合進 main 後在主工作區重跑。e2e 交給 CI。

## Review Triage Log

2026-11-27 三層審查（Blind Hunter 14 條、Edge Case Hunter 7 條、Verification Gap 4 個缺口加 1 條其他發現），合併重複後逐條核對：

- B2／E1／VG-其他 「全部釋放」的確認問題開著時，按其他按鈕（例如打開鎖定展示）不會清掉 `confirming`；之後關掉鎖定或又有沒釋放的列，問題會自己冒出來，全部釋放鈕也跟著停用。**medium**，屬實（`createSessionActions` 的 `send()` 只有 `releaseAll` 傳 `stopAsking`）。**patch**：任何一次送出都結束問題，拿掉 `stopAsking` 參數；補測試。
- B1／E2／E3／E6／E7 鎖定的 session 在這次執行中全部結束（或來源每次啟動都未確認）時，鎖定展示一直開著，其他 session 都沒角色，說明文字卻寫「只有勾選鎖定的 0 個 session 有角色」，看起來像正常狀態。**low**，屬實；行為跟 Intent 指名的舊版一致（舊版 `SessionPicks.swift` 的 `lockOn` 也是鎖定清單整份清空才關），開關在這時仍顯示、可按。**patch**：這種狀態的說明改成明確提示。E2／E3 提議「鎖定的 session 都不在時自動關」會改掉舊版行為，不採用；E7「開著時開關沒停用」是刻意的，停用會讓使用者關不掉。
- VG-4 工具列「沒有列但鎖定展示開著時仍顯示」沒有測試。**medium**（主路徑的退路）。**patch**：補 `sessionToolbar([], …)` 兩種狀態的測試，連同新提示文字。
- VG-3／B7 讀檔時「`lockOn` 開著但鎖定的 key 全是壞的」沒有測試；拿掉 `lockedKeys.length > 0` 會讓整個舞台沒角色、snapshot 違反 refine。**medium**。**patch**：`pool-store.test.ts` 補一例（讀成關著、備份、寫回、warn 計數）。B7 其餘（`lockOn: true` 但 `locked: []` 靜默讀成關著）屬同一個保護，**reject**。
- VG-2 鎖定展示開著時，assigner 對上次存的分配（restored）沒有測試。**medium**。**patch**：補「沒鎖定的 session 的存檔分配被丟掉、關掉鎖定後拿新的 actorId」。VG-2 的 parked（示範中）部分不是主路徑，**reject**。
- B5 新 log 一次只有 1 個時寫「1 sessions」。**low**，直接改字。**patch**。
- B13 `assign.ts` 檔頭一行超過 80 字元。**low**。**patch**：重新換行。
- B14 測試名稱寫「確定」，按鈕實際是「全部釋放」。**low**。**patch**。
- B10／VG-1 `App.tsx` 的工具列、鎖定勾選框、釋放鈕停用的接線沒有任何測試跑到（repo 沒有 React 渲染測試，e2e 只直接呼叫 `awp.pool.*`）。**medium**。使用者 2026-11-26 實機預覽已手動確認過。**defer**：補一個在「管理 session」頁實際按工具列與勾選框的 e2e。
- B3 鎖定展示關掉後，沒勾的 session 重新挑角色、拿新的 `actorId`。**false**：跟「已釋放→改回顯示」同一條規則（檔頭寫明），Intent 定案不改池子挑角色的規則。**reject**。
- B4 鎖定展示開著時，「已鎖定又已釋放」的列看不出已釋放；確認文字沒說會連已鎖定的一起釋放。**low**；Intent 定案鎖定中「已釋放」不算，修法要加新標示。**reject**。
- B6 啟動清理的 log 沒記鎖定 key 有幾個是因來源未確認而保留。**low**，只是 log 細節。**reject**。
- B8 面板的送出中、沒有 API、全部釋放失敗等分支沒有測試。不是主路徑。**reject**。
- B9 `pool-assign.test.ts` 有十幾個測資還寫 `schemaVersion: 2`。**low**；這些測試照樣通過，也順帶走過遷移。**reject**。
- B11 工具列動作的錯誤訊息顯示在表格下方。**low**，只有 IPC 失敗才會出現。**reject**。
- B12 `schemaVersion` 升到 3 後，舊版程式讀到會把檔案改名成 `.broken-`。**low**；每次升 schema 都一樣（Story 2.8 的規則），只影響在兩個開發分支間共用 userData。**reject**。
- E4 示範模式與鎖定展示同時開著時，沒勾的示範列被淡化、標「未鎖定」，但它其實有角色。**low**，兩個模式同時開很少見；修法要多一個條件。**reject**。
- E5 清單上超過 1000 個 session 時，全部釋放／全部顯示會被 main 擋下。**low**，實際不會有這麼多 session。**reject**。
