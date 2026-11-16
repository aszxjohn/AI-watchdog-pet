---
title: 'Story 3.2（下）：匯入入口、確認替換與拒絕原因'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: '8d08883bdab47709fbbce0daf325b4a0c7c5c164'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-2-pack-import-core.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.2 上半段做好了 `main/packs` 的檢查與安裝（`a5b2ede`、`8d08883`），但使用者還沒辦法真的匯入。目前缺四件事：
- 面板沒有按鈕。
- 拒絕原因只有英文代碼。
- 同 packId 時沒有確認的地方。
- 第二實例帶來的檔案也沒人處理。

**Approach:** 在 `main/packs` 加一個匯入流程（importer），所有入口都走它：
- 面板按鈕：main 開選檔對話框。
- 第二實例的參數、第一次啟動帶的參數、macOS 的 `open-file`。

流程的狀態放在 main，經 StageView 新的 `packImport` 區段發佈。「角色包」頁依這個狀態顯示：讀取中、確認替換（新舊名稱與版本、降版警告）、結果（成功，或中文的拒絕原因）。IPC 只負責「開始選檔」與「確認或取消」，都立刻回應，避開 10 秒逾時。

**Decisions（2026-11-16）：**
- 同 packId 已安裝時一律要確認，同版本重裝也要；沒有安裝過的直接安裝，不問。
- 一次只處理一個匯入：
  - 讀取中又來新的匯入，新的忽略，記一行。
  - 等待確認時又來新的，先取消等待中的，再開始新的。
- 等待確認期間，計畫（最多 64 MiB 檔案內容）留在記憶體，取消或完成就釋放。
- 帶檔案的第二實例、`open-file` 會打開面板到「角色包」頁。檔案關聯（雙擊 `.awpet` 開 app）仍列在 Deferred。

## Boundaries & Constraints

**Always:**
- 拒絕原因與安裝失敗的中文文字只在面板，依上半段的代碼與參數對照：
  - `invalid-manifest` 顯示前幾筆的欄位路徑，並用 `PACK_API_ISSUE_RULES` 對照的中文說明。
  - `api-incompatible` 依 `reason` 分兩種文案：主版不同是「這個角色包的 API 版本不相容」，包較新是「需要舞台 API ≥ x.y」。
- 面板只依 StageView 顯示，寫入只走 invoke，不先改本地狀態。按鈕在讀取中或等待確認時停用。
- 從 argv 找 `.awpet`：只認副檔名是 `.awpet` 的現有一般檔案，其他參數忽略。log 不寫使用者的檔案路徑。
- 新的 IPC 只開給 panels，經既有的註冊函式；輸入用 shared 的 zod schema 驗證。

**Never:**
- 不做已安裝清單、上場、加入池子、匯出、移除（3.3）。
- 不做檔案關聯。
- 不改上半段的檢查規則與安裝流程，只呼叫它們。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 選檔 | 按「匯入角色包…」 | invoke 立刻回 null；main 開選檔對話框（只列 `.awpet`），狀態變「讀取中」 |
| 取消選檔 | 對話框按取消 | 狀態回到原本，不顯示錯誤 |
| 新包 | 選了沒裝過的合法包 | 直接安裝；狀態「已安裝：名稱 版本」；StageView `packs` 多一筆 |
| 拒絕 | 選了不合法的包 | 狀態是拒絕，面板顯示中文原因（含參數，例如需要的版本、出問題的路徑） |
| manifest 錯 | `invalid-manifest` | 顯示前幾筆的欄位路徑與中文說明，多的寫「還有 N 項」 |
| 需要確認 | 同 packId 已安裝 | 狀態「等待確認」，顯示新舊名稱與版本；按「取代」才安裝 |
| 降版 | 新版本比已裝的低 | 確認畫面另外顯示降版警告 |
| 取消取代 | 等待確認時按「取消」 | 不安裝，狀態「已取消」，計畫釋放 |
| 計畫過期 | 確認前已經裝了別的版本 | 安裝回 `stale-plan`，面板顯示中文失敗原因 |
| 安裝失敗 | `installPack` 回失敗代碼 | 面板顯示中文失敗原因，舊版照舊 |
| 讀取中再匯入 | 讀取中又按按鈕或第二實例帶檔 | 按鈕停用；第二實例的新匯入忽略，記一行 |
| 確認中再匯入 | 等待確認時第二實例帶來另一個檔 | 取消等待中的，開始新的 |
| 第二實例 | `second-instance` 的 argv 帶一個 `.awpet` | 打開面板到「角色包」頁，走同一流程 |
| 啟動參數 | 第一次啟動的 argv 帶 `.awpet` | ready 後走同一流程 |
| open-file | macOS `open-file`（ready 前或後） | ready 前先排隊，ready 後走同一流程；有 `preventDefault` |
| 不是 .awpet | argv 只有其他參數或不存在的路徑 | 照原本只打開面板，不匯入 |
| 壞輸入 | `packs:confirm` 帶非布林，或不在等待確認時呼叫 | 被拒絕或忽略，狀態不變 |

</frozen-after-approval>

## Code Map

- `src/main/packs/importer.ts`（新）：
  - `createPackImporter({ store, inspect, install, chooseFile })`。
  - 狀態機：`idle`／`reading`／`confirm`／`result`。
  - 方法：`start(file)`、`choose()`（呼叫注入的 `chooseFile`，回傳路徑或 null）、`confirm(replace)`。
  - `get()` 與 `onChange()`，給 StageView。
  - `inspect` 與 `install` 注入上半段的 `inspectPack`、`installPack`。
- `src/shared/packs.ts`：
  - StageView `packImport` 區段的 schema，以 `phase` 區分：
    - `idle`
    - `reading`
    - `confirm`：`packId`、`name`、`version`、`previous`、`downgrade`
    - `result`：`installed` 帶 `packId`、`name`、`version`；`rejected` 帶 `rejection`；`failed` 帶 `code`；`cancelled`
  - 拒絕原因直接重用上半段的 `PackRejection` 型別與 schema（必要時補上）。
- `src/shared/stage-view.ts`：加 `packImport` 區段，先驗證再前進 `rev`。
- `src/shared/ipc.ts`：
  - `packs:choose`：無輸入，回 null。
  - `packs:confirm`：`[boolean]`，回 null。
- `src/main/packs/ipc.ts`（新）：`registerPackHandlers`，`PACKS_RENDERERS = ['panels']`，照 `pool/ipc.ts`。
- `src/shared/preload-api.ts`、`src/preload/panels.ts`：`awp.packs.choose()`、`awp.packs.confirm(replace)`。
- `src/main/main.ts`：
  - 建立 importer，`chooseFile` 用 `dialog.showOpenDialog`，父視窗是面板，`filters: .awpet`。
  - `createStageView` 加 `packImport`。
  - `second-instance` 從 argv 找 `.awpet` 交給 importer，並打開面板到 `packs`。
  - 第一次啟動的 `process.argv` 同樣處理。
  - `app.on('open-file')` 在 ready 前排隊，接到後 `preventDefault`。
  - argv 解析放成可單獨測的純函式。
- `src/panels/pack-import.ts`（新，純 `.ts`）：
  - 從 `packImport` 狀態算出畫面（文字、按鈕是否可按、確認區）。
  - 中文對照：每個拒絕代碼、安裝失敗代碼、`PACK_API_ISSUE_RULES` 的每條規則。
  - 照 `display-options.ts` 寫送出邏輯，永不 reject。
- `src/panels/App.tsx`：「角色包」頁換掉「即將推出」，改成匯入按鈕、狀態行與確認區（取代、取消）；`index.css` 補最少樣式。
- 量測（上半段延後的 B11）：
  - 用測試輔助產生一個接近上限的包（約 64 MiB、512 個檔），量 `inspectPack` 加 `installPack` 的耗時。
  - 結果記在 Implementation Notes，不寫成會因機器快慢而失敗的斷言。
  - 超過 1 秒就在 deferred-work 記一筆並附建議做法。
- 測試：
  - `test/main/packs-importer.test.ts`：狀態機涵蓋 I/O 矩陣，`chooseFile`、`inspect`、`install` 都用 fake。
  - `test/main/packs-ipc.test.ts`。
  - argv 解析與 `open-file` 排隊。
  - `test/panels/pack-import.test.ts`：中文對照涵蓋每個代碼與規則。
  - `windows-main.test.ts`：啟動順序。
  - shared schema 的往返與拒絕。

**不要改：** `src/main/packs/inspect.ts`、`install.ts`、`archive.ts` 的檢查與安裝邏輯，`src/main/detection/**`、`src/main/pool/**`、`src/overlay/**`。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/packs.ts`、`stage-view.ts`、`ipc.ts`、preload：區段、通道、API。
- [x] `src/main/packs/importer.ts`、`ipc.ts`、`main.ts`：流程、通道、各入口。
- [x] `src/panels/pack-import.ts`、`App.tsx`、`index.css`：「角色包」頁的匯入區與中文對照。
- [x] 量測並記錄。
- [x] 測試，涵蓋 I/O 矩陣。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言不變。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 啟動完成，then run log 沒有錯誤，面板「角色包」頁能打開（實際選檔與確認由使用者實機驗收）。

## Implementation Notes

- 2026-11-16 實作時規格沒寫明、開發代理自行決定的部分：
  - `packImport` 的 `result` 用 `outcome` 區分（巢狀 discriminated union）。`rejected` 多一個 `moreIssues`：`invalid-manifest` 只發佈前 `PACK_IMPORT_REPORTED_ISSUES_MAX`（新常數，5）筆，`moreIssues` 是其餘筆數，其他代碼一律 0（schema 檢查）。理由：上千個未知鍵的 manifest 會產生上千筆 issue，整包經 StageView 推送太大。
  - 拒絕原因補上 zod schema `packRejectionSchema`（`satisfies z.ZodType<PackRejection>`，型別仍以上半段的 `PackRejection` 為準）。importer 發佈前把所有引用的名稱（`path`、`folder`、manifest 欄位路徑的字串段）再經 `archive.ts` 的 `quotedName`（截斷、跳脫控制與 bidi 字元）；manifest 的路徑與未知鍵名原本沒截斷，可能很長或含 bidi 字元。
  - 「讀取中」涵蓋三種情況：選檔對話框開著、檢查中、確認取代後安裝中。確認後的安裝放到下一個 task（`setTimeout(0)`），讓 `packs:confirm` 先回覆、面板先看到「讀取中…」。
  - 取消選檔回到選檔前的狀態（例如前一次的結果），不是一律回 idle；對話框本身失敗也一樣，另記一行錯誤。
  - `inspect` reject 或 `install` throw（上半段保證不會，只有 bug 才會）時記錯誤、狀態回 `idle`；schema 沒有對應的結果種類，所以面板上只會看到「讀取中…」消失。
  - `.awpet` 副檔名不分大小寫；`-` 開頭的參數一律跳過；argv 有多個 `.awpet` 只取第一個；相對路徑以 `second-instance` 的 `workingDirectory`（第一次啟動用 `process.cwd()`）為準。
  - 第一次啟動帶 `.awpet` 時也打開面板到「角色包」頁（規格只寫「走同一流程」）。帶檔案的第二實例改走 `panels.open('packs')`（會切頁），不再呼叫原本的 `openOrFocus`。
  - `open-file` 一律 `preventDefault`；不是 `.awpet` 的檔案只記一行、不開面板。ready 前收到的檔案（`open-file`、第二實例、啟動參數）放在 `createLaunchFileQueue`，ready 的最後一個 startup step 才交出去。
  - 選檔對話框的父視窗：`main.ts` 在 `createWindow` 裡記下面板的 `BrowserWindow`，沒開或已銷毀時不帶父視窗；`panel-window.ts` 沒改。
  - 同版本重裝的確認文字加「（同一個版本，會重新安裝）」。
  - 量測寫成 opt-in 測試 `test/main/packs-import-timing.test.ts`（`AWP_MEASURE_IMPORT=1` 才跑，CI 跳過，只斷言安裝成功、不斷言耗時）。

- 2026-11-16 量測（B11，Apple M4、本機 Node v24.18.0 的 vitest，非 Electron 內；三次範圍）：
  - 512 個檔、解壓後 63.9 MiB（隨機內容）：`inspectPack` 121～201 ms，`installPack` 1974～2127 ms。安裝的時間幾乎都在每個檔 `writeFileSync(..., { flush: true })` 的 fsync。
  - 入口約 63.9 MiB（約 200 萬個小函式）、7 個檔：`inspectPack` 2086～2276 ms，`installPack` 49～54 ms。另以單獨腳本拆開：`vm.Script` 編譯約 1.9 s，SES 規則的四個 regex 合計約 22 ms。
  - 兩種都超過 1 秒，已在 deferred-work 記一筆並附建議做法。期間 main thread 完全卡住（tray、IPC、StageView 推送都停）。

- 2026-11-16 開發代理驗證：`npm run typecheck`、`npm run lint`、`npm run depcruise`（239 個模組、0 違規）、`CI=true npm test`（84 檔通過、4042 個測試；量測測試 1 檔 2 個跳過）全過；既有測試只因新增的 `packImport` 區段、`packs` preload API、啟動順序而補欄位或補列，沒有刪任何 `expect(`。隔離 `--user-data-dir` 的 `npm start`（`--enable-logging`）帶契約測試包壓成的 `.awpet` 當啟動參數：run log 有 `launch arguments: a .awpet to import`、`panel opened on packs`、`installed pack contract-pack (7 files)`，沒有錯誤行，renderer console 沒有 `[awp]`／`[panels]` 錯誤；再用同一個 `--user-data-dir` 啟動第二實例帶同一個檔：run log 有 `second-instance: a .awpet to import` 與 `waiting for confirmation`。之後結束程序，run log 有 `quit`。實際選檔對話框、按「取代」與畫面文字沒有操作或截圖，留給使用者實機驗收。

- 2026-11-16 審查修補後驗證（主流程重跑）：`npm run typecheck`、`npm run lint`、`npm run depcruise`（239 個模組、0 違規）、`CI=true npm test`（84 檔通過、1 檔跳過；4048 個測試通過、2 個跳過）全過；I/O 矩陣 17 列都有測試且都跑過；diff 裡沒有刪掉的 `expect(`。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-16）：Blind Hunter 13 條（B1–B13）、Edge Case Hunter 4 條（E1–E4）、Verification Gap 1 個缺口（VG1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VG1 | 「取代」送 `confirm(true)`、「取消」送 `confirm(false)`、匯入按鈕依 `canChoose` 停用，都只寫在 `App.tsx`，沒有測試會跑到；兩個 `onClick` 對調也不會被發現 | medium | patch | 驗證缺口已附證據；這是流程裡唯一的取代關卡，對調會在使用者按取消時取代。照 repo 慣例把按鈕與請求的對照、停用條件移到 `pack-import.ts` 並補測試，`App.tsx` 只負責渲染 |
| B1 | 確認問句與「已安裝」那行直接嵌入包作者寫的名稱；`labelSchema` 只擋全空白，U+202E 等 bidi 覆寫字元能讓問句、版本、降版警告讀起來變樣 | low | patch | 已確認 `labelSchema`（`common.ts:86`）允許 bidi 字元；修法是直接修正：名稱前後加 FSI／PDI（U+2068／U+2069）隔離，合法的右到左名稱照常顯示 |
| B6 | `deferred-work.md` 的新條目插在檔頭（檔案是由舊到新往後加）；舊的「Story 3.2 下半段」與 B11「要量一次」兩筆這次已完成卻沒標（已解決） | low | patch | 已確認檔頭位置與既有「（已解決）」慣例；新條目移到檔尾，兩筆舊條目標（已解決）並指向本規格 |
| E1 | 選檔對話框的 promise 若永遠不 settle（例如面板在 sheet 開著時被銷毀），狀態卡在「讀取中」直到重啟 | maybe-false | defer | macOS 視窗掛著 sheet 時關閉鈕停用，面板只在使用者關閉或結束 app 時銷毀；要確認 Electron 在父視窗銷毀時 `showOpenDialog` 是否回 canceled。若成立為 medium |
| E2 | 檢查卡在停滯的網路磁碟時永遠不結束，狀態卡在「讀取中」 | low | reject | 需要檔案系統本身卡住；那時上半段 `archive.ts` 的 `statSync` 會先卡住整個 main thread，importer 層的等待不是主要問題；加逾時要多一個狀態與分支 |
| E3 | 「既有斷言不變」不成立：啟動順序清單、`toStrictEqual` 快照、mock 都改了 | false | reject | 逐一看過測試的刪除行：只有 `createStageView` 的預期字串與 helper 改成帶 `packImport`，其餘都是新增，沒有放寬任何既有斷言，也沒刪 `expect(` |
| E4 | 等待確認時 `choose()` 不會取消等待中的包，跟「等待確認時又來新的，先取消」不符 | false | reject | Always 寫明按鈕在等待確認時停用；矩陣「確認中再匯入」講的是第二實例，`start()` 有取消再開始並有測試 |
| B2 | 外部帶進來的 `.awpet` 用 `panels.open('packs')` 切頁，「舞台設定」未存的計時草稿會丟掉 | low | reject | 打開到「角色包」頁是 intent 的決定；檔案關聯延後，外部入口只有拖到 Dock 與指令列，邊改計時邊從外部帶檔很少見；保留草稿要加提示或確認流程 |
| B3 | 等待確認時計畫（最多 64 MiB）沒有時間上限 | low | reject | intent 已決定計畫留到確認或取消才釋放，大小上限 64 MiB |
| B4 | `broke()` 回 `idle`，非預期錯誤時畫面只看到「讀取中…」消失 | low | reject | 只有 bug 才會走到（上半段保證 `inspectPack` 不 reject、`installPack` 不 throw）；加結果種類要擴充 schema |
| B5 | 多個外部檔案同時進來只匯入第一個，其餘只記 log | false | reject | intent 明定「讀取中又來新的匯入，新的忽略，記一行」 |
| B7 | 未知鍵名含 `.`、`[0]`、`：` 時欄位路徑讀起來模稜兩可，可偽造說明 | low | reject | 只影響包作者自己被拒絕的包的說明文字，日常不會遇到；改寫法要多一個分支 |
| B8 | 主版不同時沒說要更新 app 還是要新版包 | low | reject | 文案是 intent 指定的（「這個角色包的 API 版本不相容」） |
| B9 | Verification 的手動驗收清單缺 open-file、第二實例、降版、取消等路徑 | low | reject | 修法是改本規格；改在交付說明列出實機驗收項目 |
| B10 | 請求錯誤一直留在畫面上，直到下次按按鈕 | low | reject | `packs:choose`／`packs:confirm` 都立刻回 null，只有 bug 才會失敗；清除要多一個 effect |
| B11 | `is-success` 沒有樣式 | low | reject | 外觀問題；面板沒有 success 色票，要新增淺色、深色兩組 token，不是直接修正 |
| B12 | 父視窗用可變的 `panelWindow` 取得，比 `BrowserWindow.fromWebContents(event.sender)` 繞 | false | reject | 對話框拿到的是最新的面板視窗，有銷毀檢查；沒有錯誤的結果 |
| B13 | 外部入口不經確認就安裝沒裝過的包，本機程序能把包程式碼寫進 userData | false | reject | 能啟動 app 帶參數的本機程序本來就有同樣權限，可直接寫 userData，沒有跨越權限邊界；沒有註冊協定或檔案關聯，沒有遠端途徑；intent 已決定新包直接安裝。檔案關聯已在延後清單 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 用契約測試包壓成的 `.awpet` 匯入一次，看到「已安裝」。
  - 再匯入同一包，看到確認畫面，按取代。
  - 匯入一個改壞的包，看到中文原因。
