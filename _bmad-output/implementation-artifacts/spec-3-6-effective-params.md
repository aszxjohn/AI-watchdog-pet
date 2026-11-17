---
title: 'Story 3.6（上）：有效參數與合併增量'
type: 'feature'
created: '2026-11-17'
status: 'done'
baseline_commit: '1a6c492af3931735aa7385dd9a83b06108d7c6b2'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-3-pack-list.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-pool-assignment.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:**
- 3.6 中段的 `spawn`／`params` 要送「完整有效參數」，畫角色時要套固定參數「大小」，但目前沒有人算這兩樣：index.json 只有角色的 id、名稱、身高。
- 一次 `settings:patch` 會產生好幾個 StageView 增量（Epic 1 回顧 R10），中間有不一致的狀態：
  - 先 `settings` 再 `canvas`。
  - 先 `settings` 再 `actors`。
  - 計時改了時，還會先 `sessions`。

**Approach:**
- **有效值的計算（AD-23）：** `main/settings` 讀 `main/packs` 已安裝包的 manifest，為每個角色算出有效參數與有效固定參數，發佈成 StageView 新的 `characters` 區段：
  - **有效參數：** 覆蓋值符合目前宣告才採用，否則用 manifest 預設。
  - **有效固定參數：** 舞台覆蓋值 ?? manifest 該角色的 `defaults` ?? 舞台預設。
- **合併增量：** StageView 加一個批次機制。`settings:patch` 在批次裡執行，這次 patch 同步引起的所有區段變化合成一個增量。

**Decisions（2026-11-17）：**
- **參數覆蓋值：** 設定檔目前沒有欄位，角色編輯頁在 Epic 5。這段的有效參數就是 manifest 預設；計算函式照 AD-11 的規則收覆蓋值並用單元測試鎖住，接上設定檔是 Epic 5。
- **`characters` 區段收哪些角色：** 所有已安裝且相容的包的所有角色，不論上場或加入池子；中段的 `spawn` 與 Epic 5 的編輯頁都要用。
- **固定參數改回預設時刪掉覆蓋值（3.3 的規則）：** 這段不新增可設定的固定參數，`setFixed` 仍只收 `inPool`（manifest 不能給它預設），所以規則照舊。新增 `scale`、`wander` 時要和有效預設比較，留給 Epic 5。

## Boundaries & Constraints

**Always:**
- **只算一處：** 有效參數與有效固定參數只由 `main/settings` 計算，計算本身是 `src/shared` 的純函式，renderer 只讀 `characters` 區段。
- **讀 manifest：** 由 `main/packs` 提供：從已安裝資料夾讀 `manifest.json` 並用 `manifestSchema` 驗證。`main/settings` 經注入的函式取得，不直接依賴 `main/packs`。每次 packs 變更都重新讀；同版本可以覆蓋安裝，所以不能只靠 `id@version` 快取。
- **固定參數和包參數分開放：** 固定參數不放進要給包的參數裡。包宣告的 param key 就算叫 `scale`，也是包自己的參數。
- **`wander` 逐欄合併：** manifest 的 `defaults.wander` 可以只給部分欄位。
- **找不到或不相容：** manifest 讀不到、不合 schema，或包不相容時，該包不出現在 `characters`，記一行帶 `packId`，其他包照常。
- **批次：**
  - 批次內的發佈合成一個增量：同一區段後到者勝，整體驗證一次，`rev` 只加 1。
  - 巢狀批次併入最外層；批次內沒有任何變化就不發增量。
- **順序：** 安裝或移除包時，`characters` 的增量不早於列出那個包的 `packs` 增量；它的訂閱排在 StageView 之後，照 `assign.ts` `watchPool` 的做法。

**Never:**
- 不送任何舞台訊息，不畫角色（3.6 中段）。
- 不加參數覆蓋值的設定欄位或編輯 UI（Epic 5）。
- 不改 `assign.ts` 的池子規則；`inPool` 仍由 `isInPool` 讀。
- 不改 renderer 的 StageView 訂閱流程；preload 照舊每個增量給完整快照。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 包預設 | 已安裝、相容的包，沒有覆蓋值 | 每個角色的參數恰好是宣告的 key，值是各自的 `default` |
| 固定參數預設 | manifest 沒有 `defaults` | `scale` 1、`inPool` 開、`badges` 開、`wander` 用舞台預設 |
| manifest 預設 | `defaults.scale` 1.5、`defaults.wander` 只給 `areas` | `scale` 1.5；`wander.areas` 用 manifest 的，其他欄位用舞台預設 |
| 加入池子覆蓋 | `fixedOverrides` 有 `inPool: false` | 該角色 `inPool` 是 false，其他固定參數照舊 |
| 覆蓋值規則 | 計算函式拿到覆蓋值：合法的、超出範圍、不在格子上、不是選項、宣告裡沒有的 key | 合法的採用；其餘用 manifest 預設，覆蓋值本身不被改動 |
| 參數與固定分開 | 包宣告一個 key 叫 `scale` 的參數 | 它留在包的參數裡；固定參數 `scale` 另外照規則算 |
| 換版本 | 同包換成宣告不同的版本，或同版本覆蓋安裝 | `characters` 依新的 manifest 重算 |
| 移除 | 移除包 | 它的角色從 `characters` 消失 |
| 讀不到 | 已安裝的 `manifest.json` 讀不到、不是 JSON 或不合 schema，或包不相容 | 該包不在 `characters`，記一行帶 `packId`；其他包照常 |
| 合併：螢幕 | 一次 `settings:patch` 改了畫布所在螢幕 | 恰好一個增量，同時帶 `settings` 與 `canvas`，`rev` 加 1 |
| 合併：計時 | 一次 patch 改了會讓偵測重算的計時 | `sessions`（與 `actors`）和 `settings` 在同一個增量 |
| 合併：池子 | 一次 patch 讓包重新上場、補上 actor | `settings`、`actors` 在同一個增量 |
| 沒有變化 | patch 沒改到任何值 | 不發增量 |
| 安裝順序 | 安裝一個新包 | `characters` 裡的新角色不早於列出那個包的 `packs` 增量 |

</frozen-after-approval>

## Code Map

- **`src/shared/params.ts`（新，或放 `src/shared/pack-api` 旁的 shared 模組；不放 pack-api 本身）：**
  - `effectiveParams(decls, overrides)`：用 `isValidParamValue`（`pack-api/params.ts:221`）判斷，回傳 `ParamValues`。
  - `effectiveFixed(characterDefaults, override)`：依 `FIXED_PARAM_DEFAULTS` 與 `characterDefaultsSchema`，`wander` 逐欄合併，回傳凍結的 `FixedParams`。
- **`src/shared/stage-view.ts`：**
  - `characters` 區段：每個 `characterKey` 對應 `{ params: ParamValues, fixed: FixedParams }`，依 key 排序。
  - 改 `stageViewSchema`、`stageViewSectionsSchema`，加對應的 `Stage*Sections` 型別。
- **`src/main/packs/`：** 新增讀已安裝 manifest 的函式。路徑是 `dir/<id>/<version>/manifest.json`，去 BOM、`JSON.parse`、`manifestSchema.safeParse`，失敗回原因代碼。`inspect.ts` 的 `checkedManifest` 可以參考，但不要改它的行為。
- **`src/main/settings/characters.ts`（新）：**
  - 輸入：settings 的值、packs 的已安裝清單、注入的讀 manifest 函式。
  - 提供 `get()`、`onChange()` 與一個在 StageView 之後才接上的 `watch()`，照 `assign.ts` 的 `watchPool`。
  - 只在 settings 或 packs 變更時重算，結果沒變就不通知。
- **`src/main/stage-view/stage-view.ts`：**
  - 加 `characters` 來源，以及 `batch(run)`：批次內的 `publish` 先累積，結束時合成一個增量。
  - 批次中丟例外也要結束批次；已累積的照樣發佈或捨棄，選一種並寫明。
- **`src/main/settings/ipc.ts`、`main.ts`：**
  - `settings:patch` 的 handler 在 `stageView.batch` 裡呼叫 `settings.patch`。
  - main.ts 接上 characters 來源與 `watch()`。
  - `watchDisplays` 在 ready 之後才註冊，但 `layout` 是同步的（`stage-sources.ts:149`），所以它的 `canvas` 會落在同一個批次裡。
- **測試：**
  - 純函式的有效值。
  - 讀 manifest：正常、BOM、壞 JSON、不合 schema、檔案不在。
  - characters 來源：換版本、移除、不相容、同版本覆蓋。
  - StageView 批次：合併、巢狀、沒變化、例外。
  - settings → `watchDisplays` → canvas 的整合測試（補上 deferred-work R10 說沒有的那條鏈）。
  - `pool-assign.test.ts:1531-1558` 斷言 `[['settings'],['actors']]` 的地方，若改經 IPC 就照新行為改。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/overlay/**`、`src/sandbox/**`、`src/main/pool/assign.ts` 的池子規則、`src/main/packs/inspect.ts`／`install.ts` 的行為、`src/shared/pack-api/**`（只引用）。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared`：有效值純函式、`characters` 區段。
- [x] `src/main/packs`：讀已安裝 manifest。
- [x] `src/main/settings/characters.ts` 與 main.ts 接線。
- [x] `src/main/stage-view/stage-view.ts` 的 `batch`、`settings:patch` 包進批次。
- [x] 測試，涵蓋 I/O 矩陣。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過，既有斷言只因新區段與合併後的增量補值或改寫。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start` 並匯入契約測試包，when 改畫布所在螢幕或取消上場，then run log 沒有錯誤，StageView 每次只前進一個 `rev`，`characters` 有契約測試包兩個角色的有效參數。

## Implementation Notes

- 2026-11-17 開發代理自行決定的部分：
  - 純函式放 `src/shared/params.ts`：`effectiveParams(decls, overrides = {})`、`effectiveFixed(characterDefaults, override)`，回傳都凍結（`wander.areas` 是新的凍結陣列，不和輸入或 `FIXED_PARAM_DEFAULTS` 共用）。`effectiveFixed` 逐欄用固定參數的 schema 檢查覆蓋值與 manifest 預設，不合法就往下一層找（審查後補）。`override` 的型別 `FixedParamsOverride` 收四個固定參數（`wander` 逐欄），settings 的 `FixedOverride`（目前只有 `inPool`）可以直接傳；Epic 5 加欄位時函式不用改。
  - `characters` 區段是 `characterKey → { params, fixed }` 的 record，key 依 code-unit 排序，拒絕自帶的 `__proto__`。`fixed` 用 `stageFixedParamsSchema`（`fixedParamsSchema` 把 `wander.areas` 改成 readonly），凍結的值才過得了型別檢查。
  - 讀 manifest：`src/main/packs/manifest.ts` 的 `readInstalledManifest(dir, packId, version, fs?)`，同步讀（跟 packs store 一樣），不記 log。失敗代碼 `unreadable`（附 errno）、`not-json`、`invalid-manifest`，另加 `mismatch`：manifest 的 `id` 或 `version` 和資料夾不同時不採用。代碼清單與結果型別 `INSTALLED_MANIFEST_FAILURES`、`InstalledManifestResult` 放在 `src/shared/packs.ts`，兩邊共用。
  - `src/main/settings/characters.ts` 的 `createCharacters({ settings, packs, readManifest })`：建立時與每次 packs 變更時重讀所有相容包的 manifest；`watch()` 先補上建立後到現在的變化（packs 沒變就不重讀）；settings 變更只用已讀的 manifest 重算。不相容的包不讀、記一行 warn；讀不到記一行 error，都帶 `packId`。結果用 JSON 比對，沒變不通知；log 只寫數量。
  - 批次中丟例外時選「照樣發佈」：來源已經變了、不會再通知一次，捨棄會讓 StageView 一直落後；發佈後把例外丟回呼叫端（IPC 回 `handler-failed`）。合併後整體驗證一次；不通過時改成逐區段各自送出（各自驗證，只丟掉壞的那段並記 error）。`run` 回傳 promise 時記一行 error 並丟 TypeError。批次結束前 `snapshot()` 仍是批次前的狀態。
  - `registerSettingsHandlers(store, stageView)` 第二個參數必填，型別是結構型的 `SettingsPatchBatch`（`main/settings` 不 import `main/stage-view`）。
  - main.ts：`characters.watch()` 放在 `createStageView` 之後、`assigner.watchPool()` 之前，importer 的 `install` 與 `packs:remove` 的移除也包進 `stageView.batch`（StageView 在呼叫時才取用），安裝或移除一個包時 `packs`、`characters`（有變的話還有 `actors`）在同一個增量。
  - 既有斷言的改寫：StageView 全量 fixture 補 `characters: {}`；`stageViewSchema`／delta 的「未知區段」從 `characters` 改用 `world`；windows-main 的啟動順序多 `createCharacters`、`characters.watch`，`createStageView` 多 `characters`，`registerSettingsHandlers` 記錄改成帶 store 與 stage-view。`pool-assign.test.ts` 直接呼叫 `settings.patch` 的那個測試（`[['settings'],['actors']]`）沒改：它不經 IPC，仍是兩個增量、驗的是 `watchPool` 的順序；經 IPC 的新行為寫在 `test/main/settings-patch-batch.test.ts`（「合併：池子」）。
- 2026-11-17 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`（101 檔通過、1 檔跳過；4986 個測試通過、2 個跳過）、`npm run depcruise`（283 個模組、0 違規）、`npm run e2e`（8 個通過）全過。I/O 矩陣 14 列都有測試且都跑過。把 StageView 的暫存邏輯拿掉時，批次與「合併：螢幕／計時／池子／加入池子覆蓋」共 10 個測試會失敗（已還原）。隔離 `--user-data-dir` 與暫存 HOME（scratchpad）的 `npm start` 帶契約測試包 `.awpet`：run log 有 `installed pack contract-pack` 與 `characters changed: 2 characters of 1 pack`，沒有 error 行（只有三個轉接器找不到資料夾的 warn）；經本機 DevTools port 在面板呼叫 `window.awp.settings.patch`：改畫布螢幕（3 → 1）、取消上場、取消一個角色加入池子、全部改回，各前進恰好一個 rev（5→6→7→8→9），畫布螢幕和 settings 在同一個快照變；沒改到值的 patch 不前進 rev；`characters` 有兩個角色，參數是 manifest 預設，探針二的 `scale` 0.9、`wander.speed` slow。結束後 run log 最後一行是 `quit`，自己開的程序都已關閉。

- 2026-11-17 主流程重跑：五項檢查全過（101 檔通過、1 檔跳過；4986 個測試通過、2 個跳過；depcruise 283 個模組、0 違規；`npm run e2e` 8 個全過）；`out/` 沒有被動到；I/O 矩陣 14 列都有測試且都跑過；diff 裡沒有刪掉的 `expect(`。

- 2026-11-17 審查修補後驗證（主流程重跑）：五項檢查全過（101 檔通過、1 檔跳過；5004 個測試通過、2 個跳過；depcruise 0 違規；`npm run e2e` 8 個全過）；`out/` 沒有被動到；diff 裡被改寫的 2 行既有 `expect(` 都在 `windows-main.test.ts`，是 install／remove 改成在批次裡執行的接線斷言（改得更嚴）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-17）：Blind Hunter 12 條（B1–B12）、Edge Case Hunter 3 條（E1–E3）、Verification Gap 1 個缺口（VG1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B1、B2 | 安裝、移除包沒有包進批次，拆成 `packs` → `characters` → `actors` 三個增量；移除時有一段 `characters` 已拿掉角色、`actors` 還在演它；main.ts 宣稱的安裝順序沒有測試（假 assigner、空殼 characters） | medium | patch | 已確認 importer 的 `install` 與 `packs:remove` 的 `remove` 都是 main.ts 注入的；直接修正：注入時包進 `stageView.batch`，三個區段合成一個增量；用真的 assigner、characters、StageView 補安裝與移除的測試 |
| VG1 | `characters` 區段 key 的排序沒有測試守住；拿掉排序所有測試照過，但角色宣告順序不是字母順序、或 `mech` 與 `mech-two` 這種包 id 時，schema 會拒絕整個區段 | medium | patch | 驗證缺口已附證據（突變實驗）；補宣告順序顛倒與 `mech`／`mech-two` 兩個測試 |
| B3、E1 | 批次是整批驗證，一個壞區段會把同批合法的 `settings`、`canvas` 一起丟掉，來源不會再通知，renderer 一直落後 | low | patch | 只有 bug 才會出現壞區段，但後果是持續不同步；直接修正：整批驗證失敗時改成逐區段發佈，合法的照常送出，壞的記錯誤 |
| B4、E3 | `effectiveFixed` 不檢查覆蓋值，和 `effectiveParams` 不對稱；格子外的 `scale`、空的 `areas` 會讓 `characters` 區段不合 schema | low | patch | 目前設定檔只有 `inPool` 可覆蓋，碰不到；直接修正：各欄位先用固定參數的 schema 驗證，不合格就退回下一層，單元測試鎖住 |
| B5 | `watch()` 不會先和目前的 settings、packs 對齊 | low | patch | 現在的接線碰不到；直接修正：`watch()` 時先重讀一次 |
| B6 | `batch()` 沒有防止 `run` 是非同步的，批次會提早結束而且沒有任何紀錄 | low | patch | 直接修正：`run` 回傳 thenable 時記錯誤並丟出 |
| B7 | IPC 層沒有測「patch 在批次裡丟例外」：回 `handler-failed`、已累積的只發一個增量 | low | patch | 只在 `hub.batch` 直接測過；補 IPC 層的測試 |
| B12 | `characters.ts` 的失敗代碼型別是 `string`；讀不到的測試沒有 `mismatch` | low | patch | 直接修正：失敗代碼放 `src/shared` 兩邊共用，補 `mismatch` 的測試 |
| B8 | deferred-work 的 R10 條目沒標（已解決） | low | patch | 主流程標記 |
| B9 | 新增的兩筆延後條目 `source_spec: none` | false | reject | 拆段的條目依流程規定寫 `none` |
| B10 | AC 第 2 條要求 `npm start` 實機檢查，Manual checks 卻說實機驗收併入中段 | false | reject | AC 是開發驗證（已做），Manual checks 指使用者實機驗收，兩者不衝突 |
| B11 | 壞掉或不相容的包常駐時，每次 packs 變更都重複記同一行 | low | reject | 只在 packs 變更時重複，次數少；去重要多一份狀態 |
| E2 | 啟動或安裝當下讀 manifest 暫時失敗，該包的角色要等下一次 packs 變更才出現 | low | reject | 要剛好遇到檔案被鎖；重試要加計時與狀態 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 這段沒有畫面上的變化；實機驗收併入 3.6 中段，屆時角色依有效參數與「大小」出現在畫布上。
