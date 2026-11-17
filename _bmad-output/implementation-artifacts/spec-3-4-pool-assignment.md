---
title: 'Story 3.4：池子與 session 分配'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: 'c2517f7e473337880cdccd5f2b2f3c1e8967cf65'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-3-pack-list.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「角色包」頁已經能決定上場與加入池子，但還沒有人用這兩個值：session 不會分到角色，StageView 也沒有 actors，3.5 之後的沙盒與繪圖無從開始（FR3、FR4 角色部分、FR21 示範模式）。

**Approach:** 由 `main/pool` 負責分配：
- **池子：** 上場的包（依 id 排序）× 加入池子的角色（manifest 順序）。
- **分配：** 每個顯示中、沒被釋放的 session 分到一隻角色，帶一個新的 `actorId`。
- **持久化：** 分配寫進 `assignments.json`（schemaVersion 升到 2）。
- **StageView：** 新增 `actors` 區段。session 的變化與它造成的分配，在同一個增量裡發佈。
- **面板：** 「管理 session」每列顯示分到的角色名稱。

**Decisions（2026-11-16）：**
- **挑哪一隻：**
  - 先從「目前畫面上沒有的角色」裡挑；全都在畫面上了，才從整個池子挑。
  - 都挑本次執行出場次數最少的；同樣少時，依池子順序挑第一隻。這是架構文件的預設（「出場次數最少者」）。
- **重新啟動後保留：**
  - 同步完成時，session 還在、角色也還在池子裡，就沿用原本的角色與 `actorId`。
  - 其他的丟掉，再依規則重新分配。
- **池子在執行中變小時，已分配的不動：** 停用包、取消加入池子、移除包，都只影響之後的新分配。換角色是 3.9 的範圍。
- **池子在執行中變大時（從空變有，或多了角色），補分配：** 還沒分到角色的顯示中 session，立刻依規則補上。
- **`assignments.json` 改成逐筆驗證：** 壞的那一筆丟掉，其他保留，原檔留 `.broken-` 備份，跟 settings 的逐欄做法一致。寫檔失敗照舊只記 log，不回報面板；分配會自動重建，釋放的選擇最多少掉最後一次。
- **示範方塊不變：** 每個 session 一個方塊的草稿（`spec-epic-2-session-squares.md`）仍然不做，角色在 3.6 上畫布。

## Boundaries & Constraints

**Always:**
- **`actorId`：**
  - 由 `main/pool` 產生，不透明，同一次執行內不重用（用 `randomUUID`，可注入）。
  - `actorIdSchema` 一併拒絕 `__proto__`。
- **分配單位：** 一筆分配＝一個 session × 一個角色＝一個 `actorId`。換角色就是舊的那筆結束、新的那筆產生。
- **同步前不分配：** 所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）之前不建新分配；同步完成時，一次補齊所有該分配的 session。
- **同一個增量：**
  - `actors` 每筆帶 `actorId`、`sessionKey`、`characterKey`、`state`、`confidence`、`displayName`。
  - session 狀態變化，和它造成的 `actors` 變化，在同一個 StageView 增量裡。
  - 新分配與該 actor 的第一個狀態，也在同一個增量裡。
- **釋放與結束：**
  - 被釋放的 session 不分配角色，已有的收回；仍留在 `sessions` 與管理清單。
  - session 結束或過期，角色收回。
- **一致的規則：** 示範 session 照同一套規則分配。
- **有效值：** 上場與加入池子只用 `isPackEnabled`、`isInPool` 讀。
- **`assignments.json` 遷移：** 1 → 2 只往前，原本的 `released` 保留，`assignments` 為空。

**Never:**
- 不在執行中替已分配的 actor 換角色（3.9）。
- 不畫角色，不建沙盒（3.5、3.6）；不改示範方塊與 overlay。
- 不改偵測的判斷規則與 session 生命週期（`main/detection/**`）。
- 不把 `sessionKey`、`source` 給包；這個 story 也還沒有任何東西送給包。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 新 session | 已同步，池子有角色，出現新 session | 分到一隻角色與新的 `actorId`；`actors` 那筆與 session 的第一個狀態在同一個增量 |
| 不重複 | session 數 ≤ 池子大小 | 每個 session 的角色都不同 |
| 用完重複 | session 數 > 池子大小 | 多出的 session 拿本次出場次數最少的角色；同樣少依池子順序 |
| 輪替 | 有角色的 session 結束後，又來一個新 session | 從畫面上沒有的角色裡挑出場次數最少的 |
| 結束 | session 結束或過期 | 那筆分配與 actor 一起消失，角色回到池子 |
| 釋放 | 釋放一個有角色的 session | actor 消失，session 留在清單；`pool` 與 `actors` 在同一個增量 |
| 取消釋放 | 再顯示 | 分到角色與新的 `actorId` |
| 同步前 | 還有來源沒同步、還沒逾時 | 不分配；同步完成時一次補齊 |
| 池子空 | 沒有上場的包，或角色都沒加入池子 | session 照常列出，沒有 actor |
| 池子變大 | 從空變有，或多了角色 | 還沒有角色的顯示中 session 補分配 |
| 池子變小 | 停用包、取消加入池子、移除包 | 已分配的不動；之後的新分配不再挑那些角色 |
| 狀態變 | 有角色的 session 狀態改變 | `sessions` 與 `actors` 在同一個增量更新 |
| 示範 | 打開示範模式 | 示範 session 照同一套規則分配 |
| 重新啟動 | 上次有分配，session 還在、角色還在池子 | 同步完成時沿用原本的角色與 `actorId` |
| 重啟後換掉 | 上次的 session 不見了，或它的角色已不在池子 | 那筆丟掉；session 還在的就重新分配 |
| 舊檔 | `assignments.json` 是 schemaVersion 1 | 遷移成 2，`released` 保留，沒有分配 |
| 壞資料 | 其中一筆分配或釋放不合法 | 丟掉那一筆，其他保留，原檔留 `.broken-` 備份 |
| 面板 | 打開「管理 session」 | 每列顯示分到的角色名稱；沒有角色的列顯示沒有角色；已釋放的照舊標示 |

</frozen-after-approval>

## Code Map

- **`src/shared/pack-api/messages.ts`：** `actorIdSchema` 拒絕 `__proto__`。這是 deferred-work 指定的 3.4 項目，`pack-api` 只改這一處。
- **`src/shared/pool.ts`：**
  - `POOL_SCHEMA_VERSION` 改為 2。
  - 檔案 schema 加 `assignments: [{ sessionKey, actorId, characterKey }]`，同一個 `sessionKey`、同一個 `actorId` 都只能出現一次。
  - StageView `pool` 區段照舊（`released`）。
  - 新增 `stageActorsSchema`：依 `sessions` 的順序，每筆是 `{ actorId, sessionKey, characterKey, state, confidence, displayName }`。`state`、`confidence` 沿用 `stage-view.ts` 的 session 欄位 schema。
- **`src/shared/stage-view.ts`：** 加 `actors` 區段，先驗證再前進 `rev`。
- **`src/main/pool/`：**
  - **`store.ts`：**
    - 載入改成逐筆驗證（壞的那一筆丟掉、其他保留，原檔留備份並寫回修正後的檔），讀寫 `assignments`。
    - `POOL_MIGRATIONS[1]` 加上空的 `assignments`。
  - **新的分配器：**
    - 例如 `assign.ts`，放挑角色的純函式，加上把它接起來的部分。
    - 輸入：detection 的 `sessions`、`onSynced`；settings 的值；packs 的已安裝清單；released。
    - 輸出：`{ sessions, adapters, pool, actors }` 的 `get()` 與 `onChange()`。
    - detection 的變化經它轉發，連同算好的 `pool`、`actors`，在同一次 `onChange` 裡送出。
    - 出場次數只放記憶體，重新啟動時，沿用的分配各算一次。
  - **`sweep(reported, unconfirmed)`：** 同步完成時，也要處理分配：沒回報且來源已確認的 session 的那筆丟掉；角色不在池子裡的那筆丟掉。之後補齊所有該分配的 session。
- **`src/main/stage-view/stage-view.ts`：** detection 與 pool 這兩個來源，改成接上面那一個合併來源。`StageViewSources` 的型別跟著改，其他來源不動。
- **`src/main/main.ts`：**
  - 建立分配器時，接上 detection、pool、settings、packs。
  - `onSynced` 改接分配器。
  - `flushOnQuit` 照舊。
- **`src/panels/session-rows.ts`、`App.tsx`：** 每列加角色名稱。從 `actors` 依 `sessionKey` 找 `characterKey`，再從 `packs` 找角色名；找不到名稱時顯示 key。沒有角色時顯示「沒有角色」。
- **測試：**
  - `test/main/pool-assign.test.ts`：純函式與接線，用 `fake-clock`、注入的 `randomUUID`。
  - `test/main/pool-store.test.ts`：遷移、逐筆驗證、讀寫分配。
  - `stage-view`、`session-rows`、shared schema 的往返與拒絕。
  - 既有快照只補 `actors` 區段。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/main/detection/**`、`src/overlay/**`、`src/main/packs/**`、`src/main/settings/**`；`src/shared/pack-api/**` 只改 `actorIdSchema`。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/pool.ts`、`stage-view.ts`、`pack-api/messages.ts`：檔案 schema v2、`actors` 區段、`actorIdSchema`。
- [x] `src/main/pool/store.ts` 與分配器：遷移、逐筆驗證、挑角色、同步、釋放、結束、合併來源。
- [x] `src/main/stage-view/stage-view.ts`、`main.ts`：接線。
- [x] `src/panels/session-rows.ts`、`App.tsx`：角色名稱。
- [x] 測試，涵蓋 I/O 矩陣。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言只因新的 `actors` 區段與合併來源補值。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`、匯入契約測試包、打開示範模式，when 打開「管理 session」，then run log 沒有錯誤，示範 session 那列顯示分到的角色名稱（其他情境由使用者實機驗收）。

## Implementation Notes

- 2026-11-16 開發代理自行決定的部分：
  - 分配器在 `src/main/pool/assign.ts`：純函式 `poolOf`、`pickCharacter`、`actorsOf`，加上 `createAssigner`。StageView 的合併來源鍵名是 `assigner`，型別 `StageViewAssignerSections`（`sessions`、`adapters`、`pool`、`actors`）；store 自己的型別 `StageViewPoolSections` 照舊只有 `pool`。
  - `sweep` 的分工：store 的 `sweep` 照舊只掃 `released`（log 文字不變）；分配器的 `sync(reported, unconfirmed)` 先呼叫它，再掃分配（沒回報且來源已確認的丟掉、角色不在池子的丟掉），之後補齊，整段只送一次變化。
  - 同步時「session 還在」但還沒顯示的分配（來源未確認、晚到的 session）先留著；session 出現時若角色仍在池子就沿用原 `actorId`，否則丟掉重新分配。已釋放 session 的舊分配一律丟掉。出場次數在分配真的上場時才加一（沿用的各算一次）。
  - store 新增 `assignments()`、`setAssignments()`（不通知 listener，由分配器發佈 actors）。檔案形狀錯（缺 `released`／`assignments`、不是陣列、多欄位）照舊整檔改名 `.broken-`；只有個別項目錯才逐筆丟掉、複製備份並立刻寫回。重複的 released key 照舊視為合法、讀檔時去重；重複的 `sessionKey`／`actorId` 分配算壞項目（先出現者保留）。
  - `actorId` 用注入的 `token`（預設 `randomUUID`）；同一次執行用過的（含上次存的）或不合 `actorIdSchema` 的會重抽，最多 16 次，仍不行就讓該 session 暫時沒有角色並記 error。
  - `sessionDisplayNameSchema` 從 `stage-view.ts` 內嵌的寫法移到 `detection-events.ts`，session 與 actor 共用（`pool.ts` 不能 import `stage-view.ts`，會循環）。
  - 面板「角色」欄放在「狀態」與「操作」之間；角色名用 `<bdi>`，「沒有角色」淡化。
  - log 只寫數量：`start-up sync: kept N saved assignments, dropped M (...)`、`assignments: N new, …`。
- 2026-11-16 審查修補：
  - 分配器的 settings／packs 監聽改由 `watchPool()` 訂閱，`main.ts` 在 `createStageView` 之後立刻呼叫，池子也改用分配器最後聽到的值計算，所以 `actors` 增量不會比它依賴的 `settings`／`packs` 增量早送出。
  - 沿用的分配：角色已經在畫面上、而池子裡還有不在畫面上的角色時，丟掉並重新分配（同步時與晚到的 session 都適用）。
  - `sync()` 用 `finally` 設定同步完成，sweep 丟錯也照常分配。
  - 壞項目 log 改用同一個單複數函式。
  - `deferred-work.md` 的 `__proto__` 條目標為已解決；`docs/pack-api-v1.md` 補上 `actorId` 不會是 `__proto__`、重新啟動後可能沿用。
- 既有斷言改動（不是只補 `actors`／合併來源的部分）：檔案升到 schemaVersion 2 後，pool-store、shared pool 測試裡寫出的檔案內容與輸入改成 v2；「較新版本」壞檔改用 3；`loaded assignments.json` 那行多了分配數；「未知來源的 key」從整檔改名移到逐筆驗證；`stageViewSchema`／delta 的「未知區段」改用 `characters`（`actors` 已是合法區段）；`SESSION_COLUMNS` 多了「角色」；windows-main 的啟動順序因分配器需要 packs，`loadPacks` 移到 `detection.onSynced` 前。
- 2026-11-16 開發代理驗證：四項檢查全過（89 檔通過、1 檔跳過；4506 個測試通過、2 個跳過；depcruise 249 個模組、0 違規）。隔離 `--user-data-dir` 的 `npm start`，啟動參數帶契約測試包 `.awpet`，經主行程 inspector 點系統匣選單的 `demo-approval` 打開示範模式，再用本機 DevTools port 讀「管理 session」DOM 文字（只讀示範那列）：欄位「來源／名稱／狀態／角色／操作」，示範列「示範／示範／要你批准／探針一／釋放」；按釋放後該列「沒有角色」並標已釋放，再按改回顯示分到「探針二」（新 actor）。run log 沒有 error／warn 行，也沒有 fail、cannot、unusable 字樣；`assignments.json` 是 schemaVersion 2。

- 2026-11-16 主流程重跑：四項檢查全過（89 檔通過、1 檔跳過；4506 個測試通過、2 個跳過；depcruise 249 個模組、0 違規）；I/O 矩陣 18 列都有測試且都跑過；diff 裡 12 行被改寫的既有 `expect(` 都是 `assignments.json` 升到 v2 的直接改寫（v2 檔案內容、遷移表、`POOL_SCHEMA_VERSION`、`sessionRows` 的新輸入），沒有放寬。

- 2026-11-16 審查修補後驗證（主流程重跑）：四項檢查全過（89 檔通過、1 檔跳過；4516 個測試通過、2 個跳過；depcruise 0 違規）；I/O 矩陣 18 列都有測試且都跑過；被改寫的既有 `expect(` 仍是那 12 行 v2 改寫。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-16）：Blind Hunter 15 條（B1–B15）、Edge Case Hunter 5 條（E1–E5）、Verification Gap 1 個缺口（VG1）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VO1、E1 | 有顯示中的 session 還沒角色時，安裝包、改回上場或加入池子，`actors` 會比 `packs`／`settings` 早一個 rev 發佈，那個 rev 的 actor 指向 StageView 還沒列出的包 | medium | patch | 已確認 `main.ts` 先建分配器（`assign.ts` 訂閱 settings、packs），StageView 之後才訂閱，listener 依加入順序執行；面板會短暫顯示原始 key，3.5 依 actor 載入包時會找不到包。讓分配器對 settings、packs 的訂閱排在 StageView 之後，並補真實接線的順序測試 |
| B1、E2 | 重新啟動沿用分配時只檢查角色還在池子，沒檢查畫面上是否已有同一隻；上次池子用完、或晚到的 session 原角色已分給別人時，池子還沒用完就重複 | medium | patch | 已確認 `assign.ts` 沿用分配的迴圈沒有 on-stage 檢查；違反凍結矩陣「不重複」列（矩陣優先於沿用）。沿用前若角色已在畫面上、而池子還有畫面上沒有的角色，就丟掉重新分配 |
| VG1、B9(a)(e)(f) | 啟動清理 `released` 改經 `assigner.sync` 呼叫 `store.sweep`，但測試仍直接接 `store.sweep`；晚到 session 的原角色已離開池子、同步前改設定或包，都沒有測試 | medium | patch | 驗證缺口已附證據（刪掉 `store.sweep` 或改壞未確認來源的參數都不會有測試失敗）；經分配器補測試 |
| B2 | `sync()` 中途丟例外時 `synced` 不會設成 true，這次執行從此不再分配 | low | patch | 只有 bug 才會走到；修法是直接修正（`finally` 設定），避免一次例外讓整個執行沒有角色 |
| B5 | `deferred-work.md` 中 `actorIdSchema` 拒絕 `__proto__` 那筆已完成，沒標（已解決） | low | patch | 已確認；照既有格式標記 |
| B6 | 作者文件 `docs/pack-api-v1.md` 的 `actorId` 說明沒提到拒絕 `__proto__`，也沒說重新啟動後可能沿用同一個 `actorId`（影響 `stage.random(actorId)` 的預期） | low | patch | 已確認文件仍寫「本次執行期間不重複使用」；直接修正文件 |
| B8 | log 寫「1 assignments」，單複數錯，測試把錯字鎖住 | low | patch | 直接改用既有的 `assigned()` helper 並修測試 |
| B12 | 3.9 之前，`actors` 可能指向已移除、停用的包或已不存在的角色，沒有留給 3.5、3.6 的交接條件 | low | defer | 池子變小不換角色是本規格的決定；記進 deferred-work，提醒 3.5、3.6 要能處理找不到包的 actor |
| B3 | 合併來源後，`actors` 有一筆壞資料會連 `sessions`、`pool` 一起被 StageView 丟掉 | low | reject | `actors` 由已驗證的資料組成，只有 bug 才會不合 schema；StageView 丟掉增量時已記 log |
| B4 | `actors` 與 `sessions` 的跨區段規則（順序、對應、欄位一致）沒有 schema 或測試檢查 | false | reject | `actorsOf` 依 `sessions` 順序、從同一份 session 資料組出 actor，沒有找到會不一致的路徑 |
| B7 | spec 是 in-review，sprint 是 in-progress | false | reject | 流程照常：step-05 才把 sprint 改成 review |
| B10 | 「沒有角色」同時代表已釋放、池子空、等待同步 | low | reject | 已釋放另有標示；凍結矩陣「面板」列指定顯示「沒有角色」；分辨同步狀態要把同步狀態加進 StageView |
| B11 | 包被移除後角色欄顯示原始 key | low | reject | Code Map 指定找不到名稱時顯示 key；換角色是 3.9 |
| B13 | Verification 的手動檢查缺池子變大、變小、壞資料恢復 | low | reject | 修法是改本規格；實機驗收時一併列出 |
| B14 | `epic-3-acceptance.md` L2 記錄「勾選框要等 StageView 回來才變」卻標通過 | false | reject | 這是 AD-20 規定的行為（面板不先改本地狀態），不是缺陷 |
| B15 | 遷移 1 → 2 會把 v1 檔裡不合法的 `assignments` 欄位靜默覆寫成 `[]` | low | reject | 只有手動編輯才會出現；要檢查並警告會多一個分支 |
| E3 | 逐筆驗證時，未知的頂層欄位或缺清單仍整檔改名，和 settings 逐欄丟掉未知欄位不同 | low | reject | 凍結矩陣「壞資料」指的是其中一筆；頂層形狀錯只有手動編輯或更新版本才會出現（更新版本會升 schemaVersion，本來就會整檔改名） |
| E4 | 「既有斷言只因 `actors` 與合併來源補值」不精確：v2 改寫與移除整檔改名的測試 | false | reject | 已逐一看過 12 行改寫，都是 v2 的直接結果；整檔改名改成逐筆驗證是凍結的決定，已記在 Implementation Notes |
| E5 | 同一次 detection 變化同時新增 session 又完成同步時，session 先發佈、actor 下一個 rev 才到 | false | reject | 同步前的 session 本來就沒有 actor；規則要求的是 actor 與它的第一個狀態同一個增量，`actors` 那筆本身帶狀態，已滿足 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 匯入契約測試包（2 個角色），開著 3 個以上 AI session 與示範模式：前 2 個 session 角色不同，第 3 個起重複。
  - 釋放一個 session，那列的角色消失；再顯示，分到角色。
  - 重新啟動後，同一個 session 的角色不變。
