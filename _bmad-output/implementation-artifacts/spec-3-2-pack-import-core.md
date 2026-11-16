---
title: 'Story 3.2（上）：.awpet 檢查、安裝與 pack:// 處理器'
type: 'feature'
created: '2026-11-16'
baseline_commit: '641b795074c46e64609ca993f70392c16caf47a0'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/docs/pack-api-v1.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包契約（3.1）已經有了，但舞台還不能把一個 `.awpet` 變成已安裝的包：沒有安全檢查、沒有安裝位置與索引，overlay 與沙盒也沒有地方讀素材與入口。

**Approach:** 新增 `main/packs`，負責四件事：
- **檢查**：把一個 `.awpet` 檢查完，回傳安裝計畫，或拒絕原因的代碼。
- **安裝**：照計畫先解到暫存，成功才替換到 `userData/packs/<packId>/<version>/`，並更新 `packs/index.json`；失敗時回復舊版。
- **`pack://` 處理器**：只回應已安裝包宣告過的檔案。
- **發佈**：經 StageView 新的 `packs` 區段發佈已安裝的包。

**Decisions（2026-11-16，使用者選定）：**
- Story 3.2 拆兩段，本段只做核心。下半段（「角色包」頁的匯入按鈕與選檔、匯入結果與中文拒絕原因、替換確認與降版警告、第二實例與 macOS `open-file` 帶來的檔案）另寫規格，已記在 deferred-work。
- 匯入上限：解壓總大小 64 MiB、檔案數 512、單張圖寬高各 4096 像素、所有圖總像素 6400 萬。
- 圖片格式：v1.0 只收 PNG，以檔頭確認，副檔名必須是 `.png`。

## Boundaries & Constraints

**Always:**
- 檢查與安裝全部在 main，不執行包的任何程式碼。「入口能解析」的檢查方式是：用 `node:vm` 的 `new vm.Script(source)` 只編譯不執行，並拒絕含 `require(` 的入口。
- 拒絕原因一律是英文代碼，可帶參數（例如需要的 API 版本），中文只在顯示層。manifest 的錯誤沿用 `PACK_API_ISSUE_RULES`；版本不相容沿用 `checkApiCompatibility` 的 `reason`。
- 持久化照既有慣例：`index.json` 帶 `schemaVersion`、只往前遷移、用 `writeFileAtomic` 寫入、壞檔用 `renameBroken`；log 分類為 `packs`，只寫代碼、計數與 packId，不寫使用者的檔案路徑。
- 「同 packId 已安裝」由計畫回報新舊名稱與版本，以及是不是降版，但這一段不決定是否替換：計畫交給 `install` 時才替換。
- `pack` scheme 已在 `src/main/windows/protocols.ts` 註冊（standard、secure、corsEnabled），本段只加處理器，不改 scheme 權限。

**Never:**
- 不做選檔對話框、確認畫面、面板「角色包」頁、第二實例或 `open-file` 帶來的檔案（本 story 下半段）。
- 不做 3.3 的上場、加入池子、匯出、移除。
- 不做 3.5 的 `_stage` 文件、沙盒、交入口原始碼的 IPC；`pack://_stage/…` 先一律回 404。
- 不改 overlay 的 CSP（3.6 讀貼圖時再放行 `pack:`）。
- 不做 3.9 的失敗標記，但 `index.json` 的格式要留得下它。
- 不做檔案關聯（架構列為 Deferred）。

## I/O & Edge-Case Matrix

| 情境 | 輸入 | 預期 |
|---|---|---|
| 正常 | 契約測試包壓成的 `.awpet` | 計畫：packId、版本、名稱、沒有舊版 |
| 路徑不安全 | entry 名稱含 `..`、以 `/` 或磁碟代號開頭、含 `\` | 拒絕：路徑不安全 |
| 捷徑 | entry 是 symlink（外部屬性）或副檔名 `.lnk` | 拒絕：捷徑檔 |
| 根目錄不對 | 根目錄不只一個 `<packId>/`（含 `__MACOSX/`）、或資料夾名與 manifest `id` 不同 | 拒絕並說明 |
| 太大 | 解壓總大小、檔案數超過上限；實際解出的位元組超過宣告 | 拒絕：超過上限（邊讀邊累計，超過就停） |
| 圖片太大 | 某張圖寬或高超過上限、或所有圖的總像素超過上限 | 拒絕：圖片太大 |
| 圖片格式 | `assets` 或 spritesheet 的圖不是 PNG（檔頭不符或副檔名不是 `.png`） | 拒絕：不支援的格式 |
| manifest 不對 | 缺 `manifest.json`、不是 JSON、不符 schema | 拒絕，附 issue 代碼與欄位路徑 |
| 引用不存在 | `entry`、`assets` 路徑或 spritesheet 的 `meta.image` 在包裡找不到 | 拒絕：缺檔案 |
| 入口不行 | 語法錯誤、ESM `import`／`export`、含 `require(` | 拒絕：入口無法解析 |
| 版本 | `apiVersion` 主版不同、或 minor 大於舞台 | 拒絕：附原因與需要的版本；在完整 schema 之前先判斷 |
| 大小寫衝突 | 兩個 entry 名稱只差大小寫 | 拒絕：檔名衝突 |
| 已安裝 | 同 packId 已安裝 | 計畫附新舊名稱與版本；比舊版低時標為降版 |
| 安裝 | `install(計畫)` | 解到 `packs/` 下的暫存資料夾，替換到 `packs/<packId>/<version>/`，更新 `index.json`，刪掉舊版資料夾；StageView `packs` 區段更新 |
| 安裝失敗 | 替換或寫 `index.json` 途中出錯 | 回復舊版資料夾與 `index.json`，暫存清掉，回報失敗代碼 |
| 殘留 | 啟動時 `packs/` 有上次留下的暫存或舊版資料夾 | 清掉，記一行 |
| 索引壞了 | `index.json` 不是 JSON 或不符 schema | 改名 `.broken-<時間>`，從空的開始，記一行錯誤 |
| `pack://` | `pack://<packId>/<version>/<已宣告路徑>` | 回傳檔案，Content-Type 依副檔名 |
| `pack://` 拒絕 | 未安裝的包或版本、未宣告的路徑（含 `..`）、`_stage` | 404 |

</frozen-after-approval>

## Code Map

- `src/main/packs/`（新）：
  - `inspect`：讀 `.awpet`（yauzl），做 I/O 矩陣的所有檢查，回傳計畫或拒絕。計畫包含暫存解壓需要的資料，或在安裝時重讀檔案。
  - `install`：安裝。
  - `store`：`index.json` 的載入與寫入，以及啟動時的殘留清理。
  - `protocol`：`pack://` 處理器。
  - 圖片尺寸：讀 PNG 檔頭（IHDR），可參考 `test/packs/contract-pack.test.ts` 的 `pngSize`。
  - semver 比較：只需比 `MAJOR.MINOR.PATCH` 三個整數。
- `index.json`（`schemaVersion: 1`）：`packs[]` 每筆包含：
  - `id`、`name`、`version`、`apiVersion`
  - `characters[]`（`id`、`name`、`height`）
  - `servedPaths`：安裝時算好的已宣告路徑，包括入口、`assets` 路徑，以及已宣告 spritesheet JSON 的 `meta.image`。
  - 每個 packId 只保留一個版本。3.9 的失敗標記之後以選填欄位加入。
- `src/shared/`：
  - 新增 `packs.ts`：`index.json` 與 StageView `packs` 區段的 schema，以及拒絕原因代碼清單。
  - `stage-view.ts` 加 `packs` 區段，照 `pool` 的做法，先驗證再前進 `rev`。
  - `constants.ts` 加匯入上限（照定案的四個數值）。
- `src/shared/pack-api/manifest.ts`（3.1 延後的三項）：
  - 路徑段在第一個 `.` 之前不得是 Windows 裝置名。
  - manifest 內只差大小寫的路徑視為衝突。
  - 包 id 也擋 `com0`、`lpt0`。
  - 作者文件 `docs/pack-api-v1.md` 同步更新。
- `src/main/main.ts`：
  - 載入 packs store，在 startupStep 註冊處理器，照 `handleAppProtocol` 的時機。
  - `createStageView` 加 `packs`。
  - 本段只提供 `main/packs` 的檢查與安裝函式；IPC 與畫面在下半段。
- 其他：
  - `src/main/log/run-log.ts` 加 `packs`。
  - `.dependency-cruiser.cjs` 的 `persist-not-to-owners` 加 packs；新增規則：`main/packs` 不依賴 detection 與 pool。
- `package.json`：加 `yauzl@3.4.0`（鎖確切版本）與它的型別；yazl 只有測試需要，用來把契約包壓成 zip。
- 測試：
  - `test/main/packs-*.test.ts`，用 yazl 在暫存資料夾產生各種壞包，涵蓋 I/O 矩陣每一列。
  - 處理器用 fake electron 的 protocol 測。
  - shared schema 做往返與拒絕。

**不要改：** `src/main/detection/**`、`src/main/pool/**`、`src/overlay/**`、`src/panels/**`、`src/main/windows/csp.ts`、`prototypes/**`。

## Tasks & Acceptance

**Execution:**
- [x] `package.json`：yauzl、yazl（dev）。
- [x] `src/shared/packs.ts`、`stage-view.ts`、`constants.ts`、`pack-api/manifest.ts` 與作者文件：schema、區段、上限、3.1 延後的三項。
- [x] `src/main/packs/`：檢查、安裝、索引、處理器。
- [x] `main.ts`、`run-log.ts`、`.dependency-cruiser.cjs`：接線與規則。
- [x] 測試，涵蓋 I/O 矩陣每一列。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言不變。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 啟動完成，then run log 有 packs 載入（沒有 `index.json` 時從空的開始），沒有錯誤。

## Implementation Notes

- 2026-11-16：使用者選定三題都照建議（上限 A、只收 PNG、拆兩段）。

- 2026-11-16 實作時規格沒寫明、開發代理自行決定的部分：
  - 多三個拒絕代碼：`unreadable-file`、`invalid-archive`、`invalid-spritesheet`。
  - 入口加 `'use strict'` 前綴再編譯（沙盒以 strict 執行），也擋 `import(`。
  - zip 路徑不安全的範圍比矩陣寬：另擋 `:`、`*?"<>|`、控制字元、段尾 `.` 或空白、Windows 裝置名、空段與 `.` 段；大小寫衝突含資料夾與 Unicode 正規化，同名重複也算。
  - 檔案數只算檔案；圖檔副檔名必須是小寫 `.png`；總像素只算宣告的圖。
  - 啟動清理：`index.json` 讀得到或不存在時，index 沒列的包資料夾也刪；`index.json` 壞掉或讀不到時只刪暫存資料夾。
  - `@types/yazl` 沒裝，改用本地型別檔 `test/helpers/yazl.d.ts`。
  - 已知風險：同版本重裝時「舊資料夾已移走、新的還沒放上」之間當掉，index 會指向不存在的資料夾（`install.ts` 註解）；包檔案寫入沒有 fsync（只有 `index.json` 有）；`pack://` 沒有 CORS header，3.6 用 PixiJS 載貼圖時可能要加；計畫把檔案內容放在記憶體（最多 64 MiB），下半段等使用者確認期間會一直佔著。
- 2026-11-16 主 session 核對：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`（228 個模組、0 違規）、`CI=true npm test`（80 檔、3729 個測試）全過；沒有刪任何既有 `expect(`，既有測試只因新增的 `packs` 區段、啟動順序、新規則而補欄位或補列，`manifest.test.ts` 的 `com0` 照規格從接受改為拒絕；I/O 矩陣 20 列都有測試且都有跑。隔離 `--user-data-dir` 的 `npm start` 由開發代理執行兩次：空的 userData 時 log 有 `no index.json; no packs installed`、沒有錯誤；預先放一個已安裝的包與三個殘留資料夾時 log 有載入 1 個包與清掉 3 個殘留，兩次都正常結束。

- 2026-11-16 審查修補後：所有 zip 項目（檔案與資料夾）都套用 ASCII 路徑字元集（`packPathSchema`），擋掉 `entry.jſ` 覆寫、上標裝置名與段尾空白；新增 `PACK_IMPORT_MAX_ENTRIES` 1024、`PACK_IMPORT_MAX_PATH_LENGTH` 255、`PACK_IMPORT_MAX_PATH_SEGMENTS` 32，前綴逐段累加；啟動清理只在 `index.json` 成功載入時刪包資料夾，否則只清 `.staging-*` 與 `index.json.tmp`；同版本回復改成先把新資料夾移開再放回 backup（backup 名稱帶 packId 與版本），啟動時遇到 index 指向不存在的資料夾會先還原對應的 backup；`stale-plan` 失敗代碼；入口檢查照 ses 2.3.0 transforms（新增 `html-comment`、`direct-eval`）；spritesheet 檢查原始 `meta.image`、拒絕 `related_multi_packs`、要求 `.json` 與 `frames`；拒絕原因的名稱截斷到 200 字元並跳脫控制與 bidi 字元；資料夾不見的包記錯誤並排除；錯誤分類改看 `syscall`；包檔案寫入加 `flush`；補 `pack://` 先註冊後安裝與上限邊界的測試；作者文件與 protocol.ts 註解同步。我重跑四項檢查全過（80 檔、3775 個測試；depcruise 229 個模組、0 違規），沒有刪任何既有 `expect(`。
- 2026-11-16：sprint 的 `3-2-…` 維持 in-progress，下半段（匯入按鈕、拒絕原因中文顯示、替換確認、第二實例）完成並經 CI 確認後才改 review／done。

- 2026-11-16 CI：commit `a5b2ede` 在 macOS 通過、Windows 失敗（run 43799778028）。唯一失敗的測試是 `packs-inspect.test.ts`「a folder is unreadable-file」：Windows 把資料夾當成空檔案打開，yauzl 回報沒有 `syscall` 的錯誤而被分類成 `invalid-archive`。主 session 修正：`readPackArchive` 交給 yauzl 前先 `statSync`，不是一般檔案或 stat 失敗都回 `unreadable-file`；本機四項檢查重跑全過（80 檔、3775 個測試）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-16）：Blind Hunter 14 條（B1–B14）、Edge Case Hunter 12 條（E1–E12）、Verification Gap 3 個缺口（VG1–VG3）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B2、E1、E11、E2、VO1 | 大小寫衝突只用 `toLowerCase` 比對，未宣告的 zip 檔名又可以是任何字元：`entry.jſ` 在 APFS 會覆寫已檢查過的 `entry.js`，PNG 檢查同樣能繞過；上標的 `COM¹`、段尾空白的 `con .png` 也不在裝置名清單 | high | patch | 邊界情況審查在這台 Mac 重現覆寫；所有 zip 檔名都套用 ASCII 路徑字元集（`[A-Za-z0-9._-]` 分段），非 ASCII 一律 `unsafe-path` |
| B1、E3、E4 | 資料夾項目沒有上限、路徑段數與名稱長度沒有上限，`findNameConflict` 隨深度平方成長；一個 32767 段的名稱就要數秒與上 GB 記憶體 | high | patch | 實測數據已附；加總項目數、段數、名稱長度上限，前綴改成逐段累加 |
| VG2、B8 | `index.json` 不存在時被當成權威，啟動清理會刪光所有包資料夾；讀不到時保留包資料夾這條分支沒有測試 | high | patch | `index.json` 被誤刪或隔離時資料無法復原；沒有 `index.json` 時只清暫存資料夾、保留包資料夾並記一行，補兩種情境的測試 |
| E9、E12 | 同版本重裝的回復途中刪新資料夾失敗時，舊版留在 `.backup-*`，下次啟動清理會刪掉，舊版永久遺失 | medium | patch | 回復時新資料夾改成先移開再把 backup 放回，backup 永遠不會是唯一的舊版位置；啟動清理遇到 index 指向不存在的資料夾而有對應 backup 時還原 |
| VG1 | `pack://` 只在「先安裝、後建 handler」的順序下測過，main 實際是先註冊、後安裝 | medium | patch | 驗證缺口已附證據；補「先註冊再安裝、換版本」的測試 |
| B3、E6 | 入口檢查和 SES 不一致：SES 會拒絕任何位置的 `<!--`、`-->`、直接 `eval(`、`import /*…*/ (`，這裡放行；`require/**/(` 也繞得過 | medium | patch | 照 ses 2.3.0 mandatoryTransforms 的 regex 檢查，`require` 用同樣寫法；作者文件第 6 節列出 |
| B4 | `meta.image` 先 normalize 才檢查，`sub//x.png` 被合併成合法路徑，執行時 PixiJS 要的是保留 `//` 的網址而 404 | medium | patch | 先用路徑規則檢查原始 `meta.image` |
| E7、E8 | spritesheet 用了 `meta.related_multi_packs` 會讓 PixiJS 去要連結的 sheet 而 404；spritesheet 的路徑不是 `.json` 或沒有 `frames`，PixiJS 會當一般 JSON 載入 | medium | patch | 拒絕 `related_multi_packs`；要求 `.json` 副檔名與 `frames` 物件（`invalid-spritesheet`） |
| B10 | 計畫在檢查當下算好 `previous`，等使用者確認期間若已裝了別的版本，`installPack` 照樣替換；同一份計畫也能重複安裝 | medium | patch | 安裝時比對目前版本與計畫的 `previous`，不一致回新的失敗代碼；下半段的確認流程依賴這點 |
| B12 | 拒絕原因直接帶 zip 原始名稱，最長 64 KiB，可能有控制字元或 bidi 覆寫字元，下半段會顯示在畫面上 | medium | patch | 在 archive.ts 截斷並把控制字元與 bidi 字元轉成 `\uXXXX`，補測試 |
| B7 | 載入時不確認索引裡的包資料夾還在，資料夾不見時 StageView 顯示已安裝、`pack://` 全部 404，沒有 log | low | patch | 載入時檢查資料夾，不見的記一行錯誤並從清單排除 |
| VG3 | 總大小、總像素「剛好等於上限」沒有測試，`>` 改成 `>=` 也不會被發現 | low | patch | 補兩個邊界案例 |
| B5、E5 | 用「有字串 `code`」判斷讀檔失敗，Node 內部錯誤（`ERR_…`）會被當成讀檔失敗，串流中的 `EIO` 反而被當成壞 zip | low | patch | 改看 `syscall`／`errno` |
| B6 | 包的檔案寫入沒有 fsync，註解低估了斷電風險 | low | patch | `writeFileSync` 加 `flush: true` 並修正註解 |
| B9 | `extract-failed` 收集了刪暫存資料夾的錯誤卻沒記 log | low | patch | 直接補記錄 |
| B13 | 作者文件沒說明哪些檔案由 `pack://` 提供（只有入口、`assets` 與 spritesheet 的圖），也沒列 `invalid-spritesheet` 的條件 | low | patch（文件） | 與實作對齊 |
| B14 | `pack://` 沒有 `Access-Control-Allow-Origin`，程式註解沒寫，3.6 接手的人不會知道 | low | patch（註解） | 在 protocol.ts 模組註解寫明，3.6 決定 |
| B11 | 不受信任的內容在 main thread 同步處理（最多 64 MiB 的入口編譯與寫檔），manifest 壞掉的包也要先全部解壓才被拒絕 | medium | defer | 改用 utilityProcess／worker 或先讀 manifest 是較大的結構調整；記給下半段或 3.5 |
| E10 | 同版本重裝搬資料夾時，正在讀檔的 `pack://` 請求可能短暫回 404 | low | reject | 只在同版本重裝的瞬間發生，下一次請求就正常 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。
