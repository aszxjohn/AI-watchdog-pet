---
title: 'Story 3.3（上）：已安裝清單、上場與加入池子'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: '34db856955f0c6a27e1a58f98686bf7da5bf56df'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-2-pack-import-entry.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「角色包」頁目前只有匯入，看不到已安裝哪些包，也沒辦法決定哪幾包上場、哪些角色加入池子。3.4 的池子要讀這兩個值，但 `settings.json` 還沒有它們。

**Approach:**
- 在 `main/settings` 加兩個以 key 存的值：
  - 每包「上場」，key 是 `packId`。
  - 每個角色的固定參數「加入池子」，key 是 `<packId>/<characterId>`。
- `settings:patch` 加只改單一 key 的操作。
- 「角色包」頁列出已安裝的包：名稱、版本、角色、上場開關，每個角色一個「加入池子」勾選框；身高偏離推薦值時在角色旁提示。

**Decisions（2026-11-16）：**
- 新安裝的包預設上場、角色預設加入池子（`FIXED_PARAM_DEFAULTS.inPool`）。依據是 Epic 3 目標「使用者匯入 .awpet 後，每個 session 分到一隻角色」：匯入後不用再勾。
- 設定檔只存和預設不同的值；改回預設就刪掉那一筆。
- 同 `packId` 重新匯入或換版本時，設定照舊。新版本裡已經不存在的角色，設定保留但不顯示。
- 沒安裝的包和角色，設定保留、不顯示。要不要在移除時清掉，3.3 下半段再決定。
- 包沒上場時，角色的「加入池子」照樣可以改。

## Boundaries & Constraints

**Always:**
- 照 AD-23：面板只依 StageView 顯示，寫入只走 `settings:patch`，不先改本地狀態。
- 新的操作一次只改一個 key。`baseRev` 過舊時以 key 為單位合併，同一個 key 後到者勝。這兩個值不能用整份覆寫的 `set`。
- 「上場」與「加入池子」的有效值＝設定檔的值 ?? 舞台預設，manifest 不能給。計算只寫在 `src/shared` 一處，面板與 3.4 的 `main/pool` 共用。
- `settings.json` 缺這兩個欄位時用預設值，`schemaVersion` 不升、不寫遷移。欄位或其中任一筆不合法時，照現有規則：整個欄位用預設、留 `.broken-` 備份。
- patch 回覆 `saved: false` 時，沿用 `display-options.ts` 的提示文字，不能顯示成功。
- 身高提示用 `RECOMMENDED_CHARACTER_HEIGHT` 與 `CHARACTER_HEIGHT_HINT_TOLERANCE`：82.5～137.5（含兩端）不提示。只提示，不擋任何操作。

**Never:**
- 不做匯出、移除（3.3 下半段），也不做角色編輯頁與其他固定參數（3.6、Epic 5）。
- 不做池子分配與換角色（3.4）。這個 story 不會讓畫布出現角色。
- 不改 `main/packs`、`main/pool`、`src/overlay`。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 空清單 | 沒有已安裝的包 | 顯示「還沒有安裝角色包」，匯入區照常 |
| 列出 | 有已安裝的包、設定檔沒有對應的值 | 依 id 排序列出每包的名稱、版本、角色（manifest 順序）；上場、加入池子都是勾選 |
| 切換上場 | 取消某包上場 | 送只改該包的 patch；勾選框要等 StageView 回來才變；設定檔多一筆 `false` |
| 改回預設 | 再勾回上場或加入池子 | 設定檔刪掉那一筆 |
| 加入池子 | 取消某角色加入池子 | 只改 `<packId>/<characterId>` 那一筆；同包其他角色、別包同名角色不受影響 |
| 身高提示 | 角色 `height` 是 82 或 138 | 角色旁顯示提示（含宣告的身高與建議範圍）；82.5、137.5、110 不提示 |
| 沒保存 | patch 回覆 `saved: false` | 顯示沒有保存的提示；值照樣經 StageView 生效 |
| 寫入失敗 | patch 回錯誤 | 顯示失敗原因；勾選框依 StageView 不變 |
| 送出中 | patch 還沒回覆 | 所有開關停用；這段期間的點擊不送出 |
| 舊值合併 | `baseRev` 過舊，另一個 key 剛被改過 | 只改這次的 key，另一筆保留 |
| 換版本 | 同 `packId` 換版本，舊版有設定 | 設定照舊；新版沒有的角色不顯示，設定保留 |
| 沒安裝的設定 | 設定檔有沒安裝的包或角色 | 保留在設定檔，不顯示 |
| 舊設定檔 | `schemaVersion` 1、沒有這兩個欄位 | 用預設值載入，不備份、不重寫 |
| 壞設定 | 其中一筆的 key 或值不合法 | 整個欄位用預設，留 `.broken-` 備份，其他欄位不受影響 |
| 壞輸入 | patch 的 `packId`、角色 key 不合法，值不是布林，或用 `set` 整份覆寫這兩個欄位 | `invalid-input`，值不變 |
| 超過上限 | 這次 patch 會讓筆數超過上限 | patch 失敗，值不變，面板顯示失敗原因 |

</frozen-after-approval>

## Code Map

- `src/shared/packs.ts`：新增 `characterKeySchema`（`<packId>/<characterId>`，兩段各自用 `packIdSchema`、`idSchema`）與 `characterKey(packId, characterId)`。3.4 的 StageView actors 也用它。
- `src/shared/settings.ts`：
  - 兩個新欄位（名稱可調）：
    - `packEnabled`：`packId` → boolean。
    - `fixedOverrides`：角色 key → `{ inPool?: boolean }`。用 strict 物件，3.6 再加 `scale` 等。
  - 兩者都進 `settingsValuesSchema`、`settingsFileSchema`、`SETTINGS_DEFAULTS`（空物件），也都不在 `set` 操作的 union 裡。
  - 新操作：
    - `{ op: 'setPackEnabled', packId, value }`
    - `{ op: 'setFixed', characterKey, param: 'inPool', value }`
  - `settingsOpSchema` 改成依 `op` 區分。
  - `isPackEnabled(values, packId)`、`isInPool(values, packId, characterId)`：唯一的有效值計算。
  - 筆數上限放 `src/shared/constants.ts`，例如上場 1024 筆、固定參數 4096 筆。
- `src/main/settings/store.ts`：
  - `patch` 套用新操作：等於預設時刪 key，否則寫入。
  - `changed` 判斷與 log 照現有寫法，log 只寫欄位名，不寫 key 或值。
  - 超過上限時 `settingsValuesSchema.parse` 會丟錯，經 `registerIpcHandler` 回 `handler-failed`。
  - 讀檔的 `readFields` 不用改：缺欄位用預設、壞欄位備份。
- `src/panels/pack-list.ts`（新，純 `.ts`）：
  - `packListView(packs, settings)`：每包的 `enabled`，每個角色的 key、名稱、`inPool`、身高提示文字或 null。
  - patch 產生函式。
  - `createPackListActions(api, onState)`：照 `display-options.ts` 的 `createDisplayChooser`，永不 reject；`saved: false` 用 `NOT_SAVED_TEXT`，錯誤用 `patchErrorText`。
  - 開關停用條件與每個開關送出的操作也放這裡，App.tsx 只負責渲染（3.2 審查 VG1 的做法）。
- `src/panels/App.tsx`、`index.css`：「角色包」頁上面是「已安裝」清單，下面是現有的匯入區。
- 測試：
  - `test/shared/settings.test.ts`：新欄位與新操作的往返與拒絕。
  - `test/main/settings-store.test.ts`：套用、刪回預設、合併、上限、舊設定檔、壞設定。
  - `test/panels/pack-list.test.ts`：清單、提示邊界、送出邏輯、停用條件。
  - 既有測試若對 `SETTINGS_DEFAULTS` 或 settings 區段做 `toStrictEqual`，只補新欄位。

**不要改：** `src/main/packs/**`、`src/main/pool/**`、`src/overlay/**`、`src/shared/pack-api/**`（只引用）、`settingsPatchResultSchema`。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/packs.ts`、`settings.ts`、`constants.ts`：角色 key、兩個欄位、兩個操作、有效值函式、上限。
- [x] `src/main/settings/store.ts`：套用新操作。
- [x] `src/panels/pack-list.ts`、`App.tsx`、`index.css`：已安裝清單、開關、身高提示。
- [x] 測試，涵蓋 I/O 矩陣；I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言只因新欄位補值。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start` 並匯入契約測試包，when 打開「角色包」頁，then run log 沒有錯誤，清單列出契約測試包與它的角色（實際勾選由使用者實機驗收）。

## Implementation Notes

- 2026-11-16 開發代理自行決定的部分：
  - 欄位名照 Code Map 用 `packEnabled`、`fixedOverrides`；「上場」預設值是 `PACK_ENABLED_DEFAULT`（`src/shared/settings.ts`）。上限 `PACK_ENABLED_MAX_ENTRIES = 1024`、`FIXED_OVERRIDES_MAX_ENTRIES = 4096`（`src/shared/constants.ts`）。
  - `set` 的 union 改由 `SETTINGS_SET_FIELDS`（排除這兩個欄位）產生；record 拒絕自帶的 `__proto__` key；`isPackEnabled`、`isInPool` 用 `Object.hasOwn`。
  - store 寫檔時 key 排序；`sameValue` 改成不看 key 順序，避免同一個 patch 刪了又加回同一個 key 被當成有變動。超過上限時先記一行只有欄位名的 warn 再丟錯，經 `registerIpcHandler` 回 `handler-failed`。
  - `display-options.ts` 的 `patchErrorText` 加可選參數 `what`（預設維持原文字）；清單的錯誤前綴是「無法變更角色包設定」。
  - 身高提示文字：「身高 82，建議 82.5～137.5，和其他角色放在一起可能偏小／偏大」。
  - 作者寫的名稱用 `<bdi>` 隔離；沒上場的包名稱與角色名淡化，勾選框照樣能按。「讀取中…」判斷移到 `Packs` 一處。
  - `fixedOverrides` 讀檔時接受空物件 `{}`（store 自己不會寫出空物件）。
- 2026-11-16 開發代理驗證：四項檢查全過（241 個模組、0 違規；85 檔通過、1 檔跳過，4209 個測試通過、2 個跳過）。隔離 `--user-data-dir` 的 `npm start` 帶契約測試包壓成的 `.awpet`：run log 有 `installed pack …`、`panel opened on packs`，沒有錯誤；用本機 DevTools port 讀 DOM 文字，清單是「契約測試包／版本 1.0.0／上場／探針一 加入池子／探針二 加入池子」，三個勾選框都勾選、可按，身高 110、96 沒有提示；取消上場與一個角色的加入池子後 `settings.json` 各多一筆 `false`，勾回去後兩筆都消失。
- 2026-11-16 主流程重跑：四項檢查全過，數字同上；I/O 矩陣 16 列都有測試且都跑過；diff 裡沒有刪掉的 `expect(`。

- 2026-11-16 審查修補後驗證（主流程重跑）：四項檢查全過（85 檔通過、1 檔跳過；4213 個測試通過、2 個跳過；depcruise 0 違規）；I/O 矩陣 16 列都有測試且都跑過；diff 裡沒有刪掉的 `expect(`。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-16）：Blind Hunter 12 條（B1–B12）、Edge Case Hunter 5 條（E1–E5）、Verification Gap 1 個缺口（VG1）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B7、VO1 | `PackListCheckbox.id` 註解說是 React key 與 input id，App.tsx 兩者都沒用，唯一性測試保護的是沒人用的值 | low | patch | 已確認 App.tsx 的 key 用 `pack.id`／`character.key`、input 沒有 `id`；直接修正：把它設成 input 的 `id`，註解改成實際用途 |
| B8、E4 | 「加入池子」的 `ariaLabel` 沒有包名，兩包有同名角色時報讀一樣；身高提示沒用 `aria-describedby` 關聯 | low | patch | 已確認 `pack-list.ts` 的 label 只帶角色名；修法是改字串並加一個關聯屬性 |
| B4 | `applyOp` 遇到 `FIXED_PARAM_DEFAULTS` 就刪 key，3.6 加 `scale`、`wander` 時，manifest 有預設的情況會把使用者選的值刪掉；`wander` 是物件，`===` 比不出相等 | low | patch | 目前 schema 只收 `inPool`（manifest 不能給），現在不會出錯；但 `fixedOverrideSchema` 註解寫 3.6 會加 `scale`，會照抄這條規則。補註解寫明只適用 manifest 不能給預設的參數 |
| B9 | 「列出: sorts by id even if handed out of order」最後斷言 `stagePacksSchema.safeParse(PACKS)`，驗的是排好的 fixture，不是丟進去的資料 | low | patch | 已確認斷言對象錯；刪掉那行或改成驗實際輸入 |
| B11 | store 拒絕 patch 時 log 寫死「(more entries than allowed)」，根層級 issue 的 `path[0]` 會印出 `undefined` | low | patch | 目前只有上限會走到；直接修正 log 文字，不斷言原因、不印 `undefined` |
| B12 | 「超過上限」沒有同一個 patch 帶 `set` 加超限 keyed op 的測試 | low | patch | 程式是先在副本上套用、驗證通過才換值，本身是原子的；補一個測試 |
| E3 | `Object.freeze` 是淺凍結，`packEnabled`、`fixedOverrides` 與其中的物件可以被 main 端的使用者改到，不會升 rev、不通知、不寫檔 | low | patch | 已確認只凍結最外層；原本欄位都是原始值所以夠用，新的巢狀值打破「values 不可變」；3.4 的 `main/pool` 會讀它們。parse 後凍結巢狀物件 |
| VG1、B10 | 勾選框受控（`checked` 只依 StageView）、送出中 `disabled`、`baseRev` 用 settings rev，都只寫在 App.tsx，沒有測試渲染它；停用測試只驗純函式 | medium | defer | 驗證缺口已附證據；AD-25 與 `vitest.config.mts` 只測 node 環境的純邏輯，整個 repo 沒有 React 渲染測試，不是這個 story 造成；交給 Epic 2 回顧 B8（端到端測試承接）一起處理，目前由實機驗收把關 |
| B1、E1 | 超過上限時面板只顯示「無法變更角色包設定（handler-failed：handler failed）」，看不出是上限 | low | reject | 要先有 1024 個沒上場的包或 4096 個取消加入池子的角色才會碰到；和「寫入失敗」同樣顯示錯誤代碼與訊息；要說清楚原因得新增 IPC 錯誤碼 |
| B2 | 超過上限時 `register.ts` 記一行 error | low | reject | 同上，實際碰不到；改要動 IPC 錯誤設計 |
| B3、E2 | 沒安裝的包與換版本後消失的角色，設定只增不減，佔滿上限後無法再改 | low | reject | intent 決定保留這些設定；要累積上千筆非預設值才會碰到；移除時是否清理已在 3.3 下半段的延後條目 |
| B5 | 有效值由 `src/shared` 的函式計算，和 AD-23「只由 main/settings 計算」不同，沒記在 Spec Change Log | false | reject | 已寫在核准的 intent（Always：計算只寫在 `src/shared` 一處）；這兩個值 manifest 不能給，不需要讀 manifest；3.6 發佈有效值時再一起對齊 |
| B6 | 送 patch 的狀態機有三份，`createDisplayChooser` 沒有 try/finally 防呆，`onState` 丟錯會一直停用 | low | reject | `display-options.ts` 是既有程式；`onState` 是 React 的 `setState`，不會丟錯 |
| E5 | 手動編輯寫進的預設值（`true`、`{}`）會被保留並計入上限 | low | reject | 只有手動編輯才會出現；要在讀檔時正規化，會多一段邏輯 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 匯入契約測試包，看到清單與兩個角色，上場與加入池子都是勾選。
  - 取消上場、取消一個角色加入池子，重新啟動後仍是取消。
  - 勾回去後，`settings.json` 裡那一筆消失。
