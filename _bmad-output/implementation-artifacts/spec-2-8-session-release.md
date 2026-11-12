---
title: 'Story 2.8：顯示與釋放 session'
type: 'feature'
created: '2026-11-12'
status: 'done'
baseline_commit: 'a28e06ffe3dcc6eb3054ace3915bcdfdaa2f541e'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「管理 session」頁只能看，不能指定哪些 session 不追蹤。Epic 3 起每個 session 會分到一隻角色，使用者不關心的 session 也會佔畫面。

**Approach:** 新增 `main/pool`，擁有 `userData/assignments.json`，記住哪些 session 已釋放。面板每列可「釋放」／「改回顯示」，寫入只走 `pool:*` invoke，結果經 StageView 新的 `pool` 區段回到面板。啟動後所有來源同步完（或 `syncTimeoutMs` 到期），丟掉這段期間沒被回報的 session 的釋放紀錄。

**Decisions（2026-11-12）：**
- 已釋放的 session 照常偵測狀態（判斷層不變），只在 pool 記一筆。Epic 2 的效果只有面板標示；Story 3.4 才據此不分配角色。
- 釋放紀錄在 session 結束後保留到下次啟動的清理：同一次執行中 session 結束又回來，仍是已釋放。
- 示範 session（`demo:*`）跟其他來源一樣可釋放、會存檔；示範模式啟動時是關的，下次啟動清理就丟掉。
- 寫檔失敗只記 log（同 settings 現況），面板不提示；記憶體中的狀態本次執行有效。
- 清單順序不因釋放而改變（按下去那一列不會跳走）。
- 已釋放的列（使用者 2026-11-12 選 A）：照常顯示狀態，整列淡化、名稱旁標「已釋放」，按鈕變「改回顯示」。

## Boundaries & Constraints

**Always:**
- `assignments.json` 只有 `main/pool` 寫：帶 `schemaVersion`、temp＋rename（寫前 fsync）、debounce 合併、`will-quit` 時同步寫完。讀不懂的檔照 settings 的規則改名 `.broken-<時間>`、記一行錯誤、從空的開始；改名失敗則這次執行不寫檔。
- renderer 寫入只走 `pool:*` invoke（只開給 panels），不先改本地狀態；畫面只依 StageView。
- 清理只做一次：detection 回報「啟動時的轉接器都送過 `sync.ready`，或 `syncTimeoutMs` 到期」之後，保留這段期間被回報過的 session key，其餘丟掉。
- log 只寫計數與錯誤碼，不寫 session key 或路徑。

**Never:**
- 不改判斷層（reducer、inference、sessions 的狀態判定）、事件契約、各轉接器。
- 不做角色分配、`actorId`、池子（Story 3.4）。
- detection 不依賴 pool；釋放不併進 detection 擁有的 sessions 區段。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 釋放 | 面板對某列按「釋放」 | `pool` 區段含該 key；該列標已釋放、按鈕變「改回顯示」；狀態照常更新 |
| 改回顯示 | 對已釋放的列按「改回顯示」 | 從 `pool` 區段移除，標示消失 |
| 沒有變化 | 釋放已釋放的 key | 回成功；不發增量、不寫檔 |
| 合併寫入 | debounce 內連續切換幾次 | 只寫一次，內容為最後狀態 |
| 結束 | 切換後馬上結束 app | `will-quit` 時寫完 |
| 啟動恢復 | 檔內 A、B 已釋放，啟動後補讀回報 A | A 一出現就是已釋放 |
| 啟動清理 | 同上，同步完時 B 沒被回報 | B 從記憶體與檔案丟掉，A 保留 |
| 同步逾時 | 某轉接器一直沒送 `sync.ready` | `syncTimeoutMs` 到期時清理一次 |
| 執行中回來 | 已釋放的 session 結束，之後同 key 又出現 | 仍是已釋放 |
| 壞檔 | 不是 JSON、`schemaVersion` 不對或比這版新 | 改名 `.broken-<時間>`，從空的開始 |
| 寫入失敗 | rename 失敗 | 記 log、刪 temp、保留記憶體狀態，下次 flush 再試 |
| 壞輸入 | 非 panels 呼叫，或 key 不合 `sessionKeySchema` | 被擋下，狀態不變 |

</frozen-after-approval>

## Code Map

- `src/main/detection/detection.ts`：`Detection` 加 `onSynced(listener: (reported: ReadonlySet<SessionKey>) => void): () => void`。等 `options.adapters` 的來源都送過 `sync.ready`，或建立後 `syncTimeoutMs`（建立時的設定值，用 `setTimer`）到期，只通知一次。`reported` 是建立後到那時所有轉接器事件的 `sessionKey`（同步後不再收集）；在同一批的區段發佈之後才通知；同步後才訂閱的立刻以同一個集合呼叫；沒有轉接器時建立當下就同步；`stop` 清 timer。`setDemo` 開的 demo 不算要等的來源。
- `src/main/persist/`（新）：從 `src/main/settings/store.ts` 抽出 temp＋rename 寫入（`writeNow` 裡的 mkdir、`writeFileSync(flush)`、rename、失敗刪 temp）與 `.broken-` 改名（`backupPath`、`setAside` 的改名部分）。settings 改用它們，log 文字與既有斷言不變。
- `src/shared/pool.ts`（新）：檔案 schema `{ schemaVersion: 1, released: SessionKey[] }`；StageView `pool` 區段 schema `{ released: SessionKey[] }`（排序、不重複）；`pool:set-released` 的 input `[sessionKey, released: boolean]`。
- `src/shared/ipc.ts`（加 contract）、`src/shared/stage-view.ts`（`stageViewSchema`、`stageViewSectionsSchema` 加 `pool`，新增 `StageViewPoolSections`）、`src/shared/constants.ts`（`POOL_FLUSH_DEBOUNCE_MS = 500`）。
- `src/main/pool/`（新）：`store.ts` 載入照 settings 的 `load`（BOM、JSON、plain object、`schemaVersion` 正整數、`POOL_MIGRATIONS` 目前空、比這版新當壞檔），提供 `get`、`onChange`、`setReleased`、`sweep(reported)`、`flushSync`；`ipc.ts` 的 `registerPoolHandlers`（`POOL_RENDERERS = ['panels']`，照 `settings/ipc.ts`）。
- `src/main/log/run-log.ts:29`：`RunLogCategory` 加 `'pool'`。
- `src/main/stage-view/stage-view.ts`：`StageViewSources` 加 `pool`，初始 view 與 onChange 照其他區段。
- `src/main/main.ts`：detection 之後 `loadPool({ file: userData/assignments.json })`、`detection.onSynced(pool.sweep)`；`createStageView` 加 pool；settings 之後註冊 pool handler；`will-quit` 在 settings 之後 flush pool（`flushSettingsOnQuit` 吃 `{ flushSync }`，可直接用）；註解一併更新。
- `src/preload/panels.ts`、`src/shared/preload-api.ts`：`awp.pool.setReleased(sessionKey, released)`。
- `src/panels/session-rows.ts`：列加 `released` 與按鈕文字。`App.tsx` 的 `Sessions` 拿 `awp`，加按鈕欄；送出中停用、失敗顯示錯誤，照 `display-options.ts` 的 `createDisplayChooser` 把邏輯放在純 `.ts`（面板測試是 node 環境，沒有 DOM）。
- 測試：`test/main/pool-*.test.ts`、`detection` 的 `onSynced`、`test/shared/stage-view.test.ts`、`test/main/stage-view.test.ts`、`test/shared/ipc.test.ts`、`test/preload/panels.test.ts`、`test/panels/`、`test/main/windows-main.test.ts`（啟動與 `will-quit` 順序）。

**不要改：** 判斷層、事件契約、各轉接器、`src/preload/stage-view.ts` 的重新同步。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/persist/`、`settings/store.ts`：抽出寫檔與改名，settings 測試全不改仍通過。
- [x] `detection.ts`：`onSynced` 與測試（全部同步、逾時、沒有轉接器、晚訂閱、通知在區段發佈之後）。
- [x] `shared/pool.ts`、`ipc.ts`、`stage-view.ts`、`constants.ts`：schema、contract、區段，含往返與拒絕測試。
- [x] `main/pool/`、`run-log.ts`、`stage-view.ts`、`main.ts`、preload：pool 本體與接線，I/O 矩陣每一列都有測試。
- [x] `session-rows.ts`、`App.tsx`、面板邏輯：按鈕、標示、送出中與失敗。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，settings 與 detection 既有斷言不變。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 等過同步，then run log 有 pool 載入與清理的計數，沒有 `pool` 錯誤；結束後 `assignments.json` 不存在或內容合 schema。

## Implementation Notes

- 2026-11-12：規格約 2950 tokens（字數粗估），使用者選擇保留全文；已釋放的列選 A。
- 2026-11-12 實作時規格沒寫明、開發代理自行決定的部分：
  - 通用遷移執行器也從 `settings/migrations.ts` 搬到 `persist/migrate.ts`（避免 pool import settings），settings 原本的匯出名稱保留。
  - 檔內 `released` 不合 schema 或有未知欄位都當壞檔（改名、從空的開始）；重複或沒排序的 key 默默整理。
  - `pool:set-released` 一律回 `null`；送出中所有釋放按鈕都停用；新欄位標題「操作」；淡化時按鈕那一格不淡化。
  - 示範 session 的事件也算進 `reported`：同步前打開示範並釋放的話，紀錄保留到下次啟動才清掉。
- 2026-11-12 驗證：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`、`CI=true npm test`（62 檔、2680 個測試）全過；刪掉的 5 行 `expect(` 都是改寫成多驗 `released`、`action` 與 pool 寫檔順序；判斷層、轉接器與 settings、detection 原有測試檔沒有改動；I/O 矩陣 12 列都有測試且都有跑。隔離 `--user-data-dir` 的 `npm start` 由開發代理執行兩次：全新 userData 時 run log 有載入、清理（kept 0、dropped 0）與結束，沒有錯誤；預先放 `demo:1` 時清理 dropped 1，結束後檔案為 `{"schemaVersion":1,"released":[]}`。面板點擊與淡化沒有實際操作過。
- 2026-11-12 審查修補後：同步改為依轉接器追蹤、結束時記一行原因與計數（沒有轉接器時不記，避免改 detection 既有的 log 斷言；`main.ts` 一律帶三個轉接器）；新增 depcruise 規則 `detection-not-to-pool`、`persist-not-to-owners`；補 `persist-files` 測試；按鈕加 `aria-label`；`createReleaseToggle` 不再 reject；已釋放的列整列（含按鈕）淡化；修正 rev 的註解與 log 文字。我重跑四項檢查全過（63 檔、2700 個測試），判斷層、轉接器與 detection、settings 既有測試檔沒有改動。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-12）：Blind Hunter 14 條（B1–B14）、Edge Case Hunter 10 條（E1–E10）、Verification Gap 1 個缺口（VG1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| E2、B2（來源部分） | 等待清單用輸出的 `source` 刪除：轉接器送出別的來源的 `sync.ready`，或兩個轉接器同來源時，會停止等錯的那個 | low | patch | `noteForSync` 用 `output.source`；改成依送出的轉接器追蹤，且只認 `source` 等於該轉接器的 `sync.ready`。只有轉接器出錯時才會發生，修正是直接修正 |
| B3 | 同步結束沒有 log，看不出是全部同步完還是逾時、逾時時在等哪個來源 | low | patch | `settleSync` 沒有記錄；日後查「重開後釋放不見」只能靠這行。加一行，只寫原因、來源代碼與計數 |
| B7 | 新的模組邊界沒有 depcruise 規則：detection 不依賴 pool、persist 不依賴 settings 與 pool 都只靠慣例 | low | patch | `.dependency-cruiser.cjs` 沒有對應規則；規格 Never 明寫 detection 不依賴 pool |
| B8 | `main/persist` 沒有直接測試：備份後綴用完丟出、資料夾不存在時建立、刪 temp 也失敗時仍丟出原本錯誤 | low | patch | 全 repo 找不到 `no free backup name` 的測試；這些程式現在由兩個 store 共用 |
| B10 | 每列按鈕的可存取名稱只有「釋放」／「改回顯示」，螢幕閱讀器分不出是哪個 session；錯誤訊息不帶名稱；淡化後對比度可能不足 | low | patch（只修按鈕名稱） | 按鈕加帶 session 名稱的 `aria-label` 是直接修正；錯誤訊息只出現在按下之後、淡化是使用者選的樣式，這兩部分駁回 |
| B11 | `stage-view.ts` 註解「both come with the same rev」與測試標題「a session and its release share it」讓人以為兩區段一起到 | low | patch | 實際是兩個不同 rev 的增量；成立的是「任一快照都是同一 rev 的一致畫面」。Story 3.4 若照字面設計會出錯 |
| B14 | 清理 log「kept 1 released sessions … dropped 1 that were not」文法不對；`settings/store.ts:20` 註解超過行寬 | low | patch | 直接修正文字 |
| E5 | 通知途中某個 `onSynced` 監聽者取消另一個，被取消的仍會被呼叫一次 | low | patch | `settleSync` 先複製清單再逐一呼叫；呼叫前檢查是否仍在清單是直接修正 |
| E6 | `createReleaseToggle` 的 `onState` 或 `logError` 丟例外時 `sending` 一直是 true，之後按鈕都沒反應，也違反「Never rejects」 | low | patch | 復原不在 `finally` 裡；改成 `finally` 是直接修正 |
| E10 | 已釋放的列按鈕那格不淡化，與使用者選的「整列淡化」不符 | low | patch | `index.css` 用 `td:not(.session-action)` 排除操作欄；照凍結的決定整列淡化 |
| VG1、B9 | `App.tsx` 的 `Sessions` 把釋放狀態畫到畫面上的部分（class、標記、停用、點擊、錯誤區）沒有自動或人工驗證 | low | defer | 已預先驗證的缺口。repo 沒有 DOM 測試環境，`StageSettings` 搭 `createDisplayChooser` 同樣只測純 `.ts`（既有做法）；由使用者驗收目視確認 |
| B1、E3 | 逾時或轉接器啟動失敗時，清理會丟掉那個來源的釋放紀錄 | low | reject | 照凍結的意圖與 AD-22（「其餘丟掉」、矩陣「同步逾時」列）；`syncTimeoutMs` 預設 10 秒，轉接器只補讀 discovery window 內的檔，通常遠低於此；被丟的只是釋放標記，再按一次即可。改法要新增 API 並改意圖。B3 的 log 讓這種情況查得出來 |
| E1、B2（未驗證部分） | `noteForSync` 在 sessions 驗證前就記 key：被 sessions 丟掉的輸出（schema 不合、`via: inferred`）也算 reported | low | reject | 轉接器只送 `via: log`、`confidence: exact`，輸出有 schema 測試；即使多記，也只是某筆釋放標記多留到下次啟動 |
| B4、E7 | `released` 沒有數量上限，panels 可釋放任意合法 key，檔案與增量會變大 | low | reject | 只有 `app://panels` 能呼叫，面板只送清單上的 key；每個 key 已限長度與字元。加上限要定義額滿行為，不是直接修正 |
| B5 | 版本化 JSON 的載入流程（BOM、parse、plain object、`schemaVersion`、遷移、改名）在 pool 與 settings 各一份，`failedFields` 也從 sessions 複製 | low | reject | 照 Code Map「載入照 settings 的 load」；抽成共用載入器要再動 settings 的載入，不是直接修正。Story 3.4 升版 pool 時一併抽出 |
| B6 | pool 借用 `flushSettingsOnQuit`，名稱與依賴方向不對 | low | reject | 照 Code Map 的明確選擇，行為正確；改名要搬移匯出並改兩個測試檔的 mock，只為名稱 |
| B12 | 釋放示範 session 後，畫布上的示範方塊還在 | low | reject | 凍結的決定：Epic 2 的效果只有面板標示；`demo-square.ts` 只看 `sessions`。驗收時方塊留著是預期行為，已在交付說明告知使用者 |
| B13 | `reported` 整個執行期間都留著，且以參照交出 | low | reject | 型別是 `ReadonlySet`、只有 main.ts 一個訂閱者；數量是 discovery window 內的 session 數，可忽略 |
| E4、E9 | 補讀提到、但已結束或逾期而不發佈的 session，釋放紀錄會被保留，面板沒有那一列可改回 | low | reject | 照凍結的意圖（保留被回報過的 key）；紀錄看不見也沒有作用，transcript 超過 discovery window 後的下次啟動就會丟掉 |
| E8 | 啟動後同步前就打開示範模式，示範的釋放紀錄會被保留，與決定「下次啟動清理就丟掉」不完全一致 | low | reject | 開發代理已記在 Implementation Notes；使用者正在用示範時保留它的釋放標記是合理結果 |

## Design Notes

**檔案範例：** `{ "schemaVersion": 1, "released": ["claude-code:…", "demo:3"] }`。Story 3.4 會加分配欄位並升版遷移。

**為什麼 `pool` 是獨立區段：** sessions 區段的擁有者是 detection（`toStageSession`），併進去會讓 detection 依賴 pool，也違反「一個區段一個擁有者」。面板在同一份 StageView 裡用 key 對照兩個區段，兩者同一個 `rev`，不會不一致。

**為什麼由 detection 收集 `reported`：** sessions 只在來源同步後才發佈它的 session，而逾時時 sessions 自己的 timer 與「同步完」誰先到不一定。pool 若只看發佈過的清單，可能在那些 session 發佈前就把它們的紀錄丟掉。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。

**Manual checks:**
- 開發代理：`--user-data-dir` 隔離執行 `npm start`，看 run log 與 `assignments.json`；不截圖、不碰使用者的 app。
- 使用者驗收：開示範模式，在「管理 session」釋放一列再改回；釋放後重開 app（示範關閉）確認該紀錄被清掉；真實 session 釋放後重開 app，仍是已釋放。
