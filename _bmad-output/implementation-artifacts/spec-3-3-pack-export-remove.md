---
title: 'Story 3.3（下）：匯出與移除角色包'
type: 'feature'
created: '2026-11-16'
status: 'done'
baseline_commit: '359244e48ca23af3ebba688592ed6a52cdd88d12'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-3-pack-list.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-2-pack-import-entry.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 「角色包」頁列得出已安裝的包，但不能匯出分享，也不能移除不要的包（FR12、Story 3.3 的匯出與移除驗收條件）。

**Approach:** 清單每一列加「匯出…」與「移除…」兩個按鈕。
- **匯出：** main 開存檔對話框，把已安裝的檔案用 yazl 3.3.1 壓成 `.awpet`。檔案只含角色包本身，不含使用者的調整。
- **移除：** 在頁面上確認後，main 先從 `packs/index.json` 刪掉該包，再刪掉它的資料夾。

存檔對話框可能開很久，所以匯出照 3.2 匯入的做法：IPC 立刻回應，狀態放在 StageView 新的 `packExport` 區段。移除很快，直接由 IPC 回覆結果。

**Decisions（2026-11-16）：**
- 匯出的預設檔名是 `<packId>-<version>.awpet`。zip 裡每個檔案的時間固定，不帶本機時間。
- 移除的確認放在該列上（「移除」／「取消」），不用系統對話框。
- 一次只匯出一個。移除與匯入不受匯出影響。
- 移除時，`settings.json` 裡該包的「上場」與各角色「加入池子」值保留（使用者 2026-11-16 選 A）：跟上半段「沒安裝的包，設定保留、不顯示」一致，重新匯入同一包時原本的選擇會回來；移除只動 `main/packs`，不寫設定。

## Boundaries & Constraints

**Always:**
- **匯出內容：** zip 根目錄是一個 `<packId>/`，裡面是安裝資料夾 `packs/<packId>/<version>/` 的每個檔案，位元組不變。匯出的檔案要能通過 `inspectPack`。
- **寫檔：** 先寫到目標旁邊一個不會和既有檔案撞名的暫存檔，fsync 後改名；失敗時刪掉暫存檔，不留半個檔案。
- **移除順序：** 先寫 `index.json`。寫不進去就什麼都不刪，回失敗代碼。寫成功後才刪資料夾；資料夾刪失敗只記錯誤、回報已移除，下次啟動的清理會刪掉。
- **面板：** 只依 StageView 顯示，寫入只走 invoke。英文代碼在面板轉成中文。
- **log：** 只寫代碼與 packId，不寫使用者選的路徑。
- **IPC：** 新的 IPC 只開給 panels，輸入用 shared 的 zod schema 驗證。
- **依賴：** yazl 從 devDependencies 移到 dependencies，版本鎖在 3.3.1。

**Never:**
- 不改 `inspect.ts`、`install.ts`、`archive.ts` 的規則，也不改 importer 的流程。
- 不做池子分配與換角色（3.4），也不做失敗標記（3.9）。
- 匯出不放任何設定值、覆蓋值或使用者路徑。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 匯出 | 按某包的「匯出…」 | invoke 立刻回 null；main 開存檔對話框（父視窗是面板，只列 `.awpet`，預設檔名 `<packId>-<version>.awpet`）；狀態「匯出中」，所有「匯出…」停用 |
| 取消匯出 | 對話框按取消 | 狀態回到原本，不顯示錯誤，不寫檔 |
| 匯出完成 | 選好位置 | 寫出 zip，根目錄 `<packId>/`，檔案與安裝資料夾一致；`inspectPack` 通過；狀態「已匯出：名稱 版本」 |
| 讀不到 | 安裝資料夾不見或讀不到 | 狀態是失敗（中文原因），不寫檔 |
| 寫不進 | 目標位置不能寫 | 狀態是失敗（中文原因），目標旁不留暫存檔 |
| 匯出中再匯出 | 匯出中又呼叫匯出 | 按鈕停用；main 忽略並記一行 |
| 匯出時被移除 | 對話框開著時該包被移除 | 狀態是失敗（已不在），不寫檔 |
| 移除確認 | 按「移除…」 | 該列顯示名稱、版本與「移除」「取消」；還沒送出任何請求 |
| 取消移除 | 確認時按「取消」 | 不送出，該列照舊 |
| 移除 | 確認後按「移除」 | `index.json` 少了該包，資料夾刪掉，StageView 清單少一列；`settings.json` 裡該包的值保留不動 |
| 刪資料夾失敗 | `index.json` 寫好了，刪資料夾失敗 | 照樣從清單消失，記一行錯誤；下次啟動清理刪掉資料夾 |
| 移除失敗 | `index.json` 這次執行不能寫或寫入失敗 | 面板顯示中文失敗原因；清單不變，檔案都在 |
| 已不在 | 移除一個沒安裝的 `packId` | 回「已不在」，什麼都不變 |
| 等待取代時移除 | 匯入正在等待取代同一個 `packId` 時移除它 | 照樣移除；之後按「取代」，安裝回 `stale-plan` |
| 壞輸入 | `packId` 不合法、參數不對，或 overlay 呼叫 | `invalid-input` 或 `sender-rejected`，什麼都不變 |

</frozen-after-approval>

## Code Map

- **`src/main/packs/export.ts`（新）：**
  - `exportPack(store, packId, target, fs)`：從 `store.find` 找安裝資料夾；遞迴列出檔案，依路徑排序；同步讀進記憶體，所以讀完後被移除也不影響。
  - 用 yazl `ZipFile.addBuffer` 寫入 `<packId>/<path>`，固定 `mtime`，mode `0o100644`；把輸出收成 Buffer，再寫成暫存檔並改名。
  - 回 `{ ok: true }`，或 `{ ok: false, code }`，code 是 `not-installed`／`read-failed`／`write-failed`。
  - 遇到不是一般檔案的項目算 `read-failed`。
- **`src/main/packs/exporter.ts`（新）：**
  - 照 `importer.ts`：`createPackExporter({ store, chooseTarget, exportPack })`，提供 `get()`、`onChange()`、`start(packId)`。
  - 狀態：
    - `idle`
    - `saving`（含 `packId`）
    - `result`：
      - `exported`（含 `packId`、`name`、`version`）
      - `failed`（含 `packId`、`code`）
  - 取消時回到原本的狀態。
- **`src/main/packs/remove.ts`（新）：**
  - `removePack(store, packId, fs)`：`store.find`，沒有就回 `not-installed`；`store.canWrite` 為 false 時回 `index-unwritable`。
  - `store.save(其他包)` 丟錯時回 `index-write-failed`；成功後 `rmSync(packs/<packId>, { recursive: true, force: true })`，失敗只記錯誤。
  - 刪資料夾只碰 `store.dir` 底下、符合 `packIdSchema` 的那一層。
- **`src/shared/packs.ts`：**
  - `stagePackExportSchema` 與兩組失敗代碼：`PACK_EXPORT_FAILURE_CODES`、`PACK_REMOVE_FAILURE_CODES`。
  - `packs:export` 的輸入是 `[packId]`。
  - `packs:remove` 的輸入是 `[packId]`，輸出是 `{ ok: true } | { ok: false, code }`。
- **`src/shared/stage-view.ts`：** 加 `packExport` 區段，先驗證再前進 `rev`。
- **`src/shared/ipc.ts`、`src/shared/preload-api.ts`、`src/preload/panels.ts`：** `awp.packs.export(packId)`、`awp.packs.remove(packId)`。
- **`src/main/packs/ipc.ts`：** 在 `registerPackHandlers` 加兩個通道，`PACKS_RENDERERS` 不變。
- **`src/main/stage-view/stage-view.ts`：** 加 `packExport` 來源。
- **`src/main/main.ts`：**
  - 建立 exporter。
  - `chooseTarget` 用 `dialog.showSaveDialog`，父視窗取法同 `choosePackFile`，`defaultPath` 是預設檔名，`filters: .awpet`。
- **yazl 型別：** 把 `test/helpers/yazl.d.ts` 移到 `src` 底下，main 與測試共用，內容依實際用到的 API 補齊；不加 `@types/yazl`。
- **`src/panels/pack-list.ts`：**
  - 每列的匯出、移除按鈕與停用條件。
  - 移除確認的文字。
  - `packExport` 狀態行。
  - 每個失敗代碼的中文。
  - 送出邏輯照 `createPackListActions`，永不 reject。
  - 「哪一列正在確認移除」是頁面本地的介面狀態，不是資料。
- **`src/panels/App.tsx`、`index.css`：** 每列的按鈕、確認區、匯出狀態行。
- **測試：**
  - `test/main/packs-export.test.ts`：匯出與重新匯入的往返，用真的 `inspectPack`。
  - `test/main/packs-exporter.test.ts`
  - `test/main/packs-remove.test.ts`
  - `packs-ipc`、`pack-list`、`windows-main`、shared schema 的往返與拒絕。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/main/packs/inspect.ts`、`install.ts`、`archive.ts`、`importer.ts` 的邏輯，`src/main/pool/**`、`src/overlay/**`、`src/shared/pack-api/**`。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/packs.ts`、`stage-view.ts`、`ipc.ts`、preload：區段、代碼、通道、API。
- [x] `src/main/packs/export.ts`、`exporter.ts`、`remove.ts`、`ipc.ts`、`stage-view.ts`、`main.ts`：匯出、移除與接線；yazl 移到 dependencies，型別宣告移到 `src`。
- [x] `src/panels/pack-list.ts`、`App.tsx`、`index.css`：每列按鈕、移除確認、匯出狀態、中文代碼。
- [x] 測試，涵蓋 I/O 矩陣。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言只因新區段補值。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start` 並匯入契約測試包，when 打開「角色包」頁，then run log 沒有錯誤，每列有「匯出…」「移除…」（實際存檔與移除由使用者實機驗收）。

## Implementation Notes

- 2026-11-16 開發代理自行決定的部分：
  - `exportPack(store, packId, target, { fs, token })`：照 `installPack` 用選項物件，`token` 讓測試能預測暫存檔名。成功時回 `{ ok: true, name, version }`（比 Code Map 的 `{ ok: true }` 多帶實際寫出的名稱與版本，exporter 用它發佈「已匯出」），失敗照 Code Map 回 `{ ok: false, code }`。
  - zip 時間：每次匯出現場建 `new Date(2000, 0, 1)`（`exportMtime()`），並加 yazl 的 `forceDosTimestamp: true`，zip 只存 DOS 日期時間、不存 UTC extra field。理由：yazl 以本地時間讀 Date 的欄位，固定一個 Date 物件會因時區不同寫出不同位元組；用 2000 年而不是 1980-01-01 是避開 yazl 的下限夾值（時區在執行中改變時會被夾到另一個時刻）。測試在 UTC 與 Asia/Tokyo 下各匯出一次，位元組相同。
  - 暫存檔名是 `.awpet-export-<token>.tmp`（不從目標檔名衍生，避免長檔名超過 255 字元），以 `flag: 'wx'` 建立，絕不覆蓋既有檔案；名字被佔用（EEXIST）時換一個，最多試 3 個，被佔用的檔案不動、不刪。
  - 安裝資料夾裡沒有任何檔案，或 yazl 不收的檔案（檔名或大小，安裝不會產生），也算 `read-failed`。
  - exporter 在開對話框前先 `store.find` 取版本當預設檔名；開始時包已不在，直接發佈 `failed`／`not-installed`，不開對話框。`exportPack` reject（bug）時照 importer 記錯誤、回 `idle`。
  - `removePack` 對不合法的 `packId` 也回 `not-installed`，不碰任何資料夾（IPC 已先擋成 `invalid-input`）。`index-unwritable` 用真的 store 碰不到（`canWrite` 為 false 時清單一定是空的，先回 `not-installed`），測試用包裝過的 store。
  - 移除後一律關掉確認區（成功或失敗），失敗原因顯示在清單下方（含包名稱），與勾選框的錯誤分開一行。`not-installed` 的中文都含「已不在」。
  - 確認問句：「要移除「名稱」版本 x.y.z 嗎？它的檔案會刪除；上場與加入池子的選擇會保留，之後重新匯入同一包時會回來。」作者寫的名稱照 3.2 用 FSI／PDI 隔離。
  - 每列按鈕的停用條件：送出中或沒有 preload API 時全部停用；另外「匯出…」在 `packExport` 為 `saving` 時停用，「移除…」在該列正在確認時停用。移除不受匯出影響。
  - 存檔對話框多帶 `title: '匯出角色包'` 與 `properties: ['createDirectory', 'showOverwriteConfirmation']`（後者只對 Linux 有效，macOS／Windows 本來就會問是否覆蓋）。`filePath` 為空字串時也當取消。
  - `main.ts` 把兩個對話框共用的父視窗取法抽成 `openPanelWindow()`。
  - `registerPackHandlers(importer, exporter, remove)` 改成三個參數；`packs:remove` 的回覆是 `{ ok: true, data: { ok, code? } }`（外層是 IPC 結果，內層是移除結果）。
  - `npm install --save-exact yazl@3.3.1` 照字面執行時 npm 保留它在 devDependencies，所以加上 `--save-prod` 才真的移到 dependencies；`package-lock.json` 同時把 yazl 與它的依賴 `buffer-crc32` 的 `dev: true` 拿掉，沒有新增其他套件。
  - yazl 型別宣告移到 `src/main/packs/yazl.d.ts`（`tsconfig.node.json` 同時涵蓋 `src/main` 與 `test`），補上 `forceDosTimestamp`。
- 2026-11-16 開發代理驗證：
  - `npm run typecheck`、`npm run lint`、`npm run depcruise`（247 個模組、0 違規）、`CI=true npm test`（88 檔通過、1 檔跳過；4392 個測試通過、2 個跳過）全過。I/O 矩陣 15 列都有 `'<列名>: …'` 的測試且都跑過。既有測試只因新的 `packExport` 區段、`packs.export`／`packs.remove` preload API、`registerPackHandlers` 新參數與啟動順序而補值；`packs-ipc` 原本的 sender-rejected 測試原樣保留，新通道另寫一個。
  - 隔離 `--user-data-dir`（scratchpad）的 `npm start`（`--enable-logging`，帶契約測試包壓成的 `.awpet` 當啟動參數）：run log 有 `installed pack contract-pack (7 files)`、`panel opened on packs`，沒有錯誤行。用本機 DevTools port 讀 DOM：該列是「契約測試包／版本 1.0.0／上場／匯出…／移除…」，兩個按鈕可按。用 DOM `click()` 依序按「移除…」→ 確認區顯示問句與「移除」「取消」、「移除…」停用 →「取消」後確認區消失、清單不變；取消「上場」後再「移除…」→「移除」：清單變成「還沒有安裝角色包」，`packs/index.json` 的 `packs` 為空、`packs/contract-pack/` 消失，`settings.json` 位元組不變（仍有 `"contract-pack": false`），run log 有 `removed pack contract-pack`。再以同一個 `--user-data-dir` 啟動第二實例帶同一檔重新匯入：清單回來，「上場」維持未勾。之後結束所有自己開的程序，run log 最後一行是 `quit`。
  - 沒有按「匯出…」（會開原生存檔對話框，不截圖無法操作）；實際存檔、從存出的檔案再匯入，仍由使用者實機驗收。

- 2026-11-16 主流程重跑：四項檢查全過（88 檔通過、1 檔跳過；4392 個測試通過、2 個跳過；depcruise 247 個模組、0 違規）；I/O 矩陣 15 列都有測試且都跑過；diff 裡唯一被改的既有 `expect(` 是 preload `api.packs` 的鍵清單（補上 `export`、`remove`）。

- 2026-11-16 審查後沒有修補項目（1 筆延後、其餘駁回），程式與上面主流程重跑時相同。

- CI：commit `c2517f7`（2026-11-16）後，GitHub Actions 的 macOS、Windows 都通過（run 43837526684）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-16）：Blind Hunter 11 條（B1–B11）、Edge Case Hunter 4 條（E1–E4）、Verification Gap 1 個缺口（VG1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VG1、B8(c) | 匯出狀態行、匯出中停用「匯出…」、移除確認區都只寫在 App.tsx，沒有測試渲染它，開發代理實機也沒按過「匯出…」 | medium | defer | 驗證缺口已附證據；repo 依 AD-25 只測 node 環境的純邏輯，沒有 React 渲染測試，不是這個 story 造成；純函式 `packExportStatus`、`packRowControls` 有測；交給實機驗收與 Epic 2 回顧 B8 |
| B1、E3 | 匯出打包安裝資料夾裡的所有檔案，不過濾也不檢查：Finder 的 `.DS_Store`、外部放進去的檔案或超過上限的內容都會被打包，可能匯出 `inspectPack` 不收的檔 | low | reject | 安裝資料夾只由 `install.ts` 寫入，裡面的檔案都通過檢查；要有人或系統改動 userData 裡的資料夾才會發生；只匯出安裝時的檔案要在 `index.json` 記完整清單（改 schema），檢查名稱與上限要多加防護 |
| B2 | 移除確認區沒有焦點管理（按「移除…」後焦點掉回 body，確認區不會被讀出，沒有 Esc） | low | reject | 3.2 的取代確認也沒有；要在 React 層加 ref 與 effect，不是直接修正；放進之後統一的無障礙檢查 |
| B3 | `index-unwritable` 用真的 store 走不到（`canWrite` 為 false 時清單一定是空的，先回 `not-installed`） | low | reject | 已確認 `store.ts` 的 `canWrite` 只在載入時決定，false 時清單是 `NO_PACKS`；這個防守性檢查沒有壞處，和 `installPack` 的同名代碼一致，凍結矩陣「移除失敗」列也點名它 |
| B4 | 匯出狀態行的「匯出中」「無法匯出」沒寫是哪一包，結果會一直留著 | low | reject | 一次只匯出一個，使用者剛按的就是那一包；外觀問題 |
| B5 | 「已匯出」沒說檔案在哪，沒有「在 Finder 中顯示」 | low | reject | 不在 intent 範圍，是新功能 |
| B6、E2 | 存檔對話框回傳的路徑沒有 `.awpet` 時不補副檔名 | low | reject | macOS 依 filter 強制副檔名；Windows 只有使用者自己打別的副檔名時才會發生；由 main 補副檔名會繞過對話框的覆寫確認，可能悄悄蓋掉同名檔 |
| B7 | `exportPack` 意外 reject（bug）時狀態回 idle，沒有錯誤訊息 | low | reject | 只有 bug 才會走到，與 importer 的處理一致（3.2 審查 B4 同樣駁回） |
| B8(a)(b) | `zipOf` 的 catch 沒測；符號連結只用假的 dirent 測 | low | reject | 分支邏輯已用注入的 fs 測過；真的 symlink 在 Windows CI 需要權限 |
| B9 | 匯出在 main thread 同步讀檔，記憶體會有好幾份 | low | reject | 一般角色包只有幾 MB；main thread 同步處理的問題已在 deferred-work（3.2 量測那筆，建議移到 worker／utilityProcess），匯出會跟著一起處理 |
| B10 | 寫暫存檔與改名之間 app 被強制結束，暫存檔會留在使用者選的資料夾 | low | reject | 要在很短的時間窗內被強制結束或斷電；事後清理要額外記錄進行中的路徑 |
| B11 | 矩陣沒有「移除正在上場的包」這一列 | false | reject | 目前畫布不會出現角色；包被移除時換角色已寫在 epic-3-context「失敗與換角色」，是 3.4 的範圍 |
| B12 | Code Map 的 `exportPack` 簽名與回傳值跟實作不同 | low | reject | 修法是改本規格；差異已記在 Implementation Notes |
| E1 | 存檔對話框開著時同一包被換成別的版本，檔名是舊版本、內容是新版本 | low | reject | 要在對話框開著時完成一次取代匯入；狀態行顯示的是實際匯出的版本；擋下來要多傳版本並比對 |
| E4 | 「既有斷言只因新區段補值」不精確：`registerPackHandlers` 的預期字串、`api.packs` 的鍵清單也改了 | false | reject | 已逐一看過：這些改動只補上新的通道與接線，沒有放寬任何斷言；主流程的驗證紀錄已寫明 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 匯出契約測試包到桌面，再匯入那個檔案，看到取代確認。
  - 按「移除…」→「取消」，清單不變；再按「移除…」→「移除」，清單少一列，`packs/` 底下的資料夾消失。
