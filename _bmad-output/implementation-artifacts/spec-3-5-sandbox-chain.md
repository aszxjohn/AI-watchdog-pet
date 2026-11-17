---
title: 'Story 3.5（上）：角色包沙盒載入鏈'
type: 'feature'
created: '2026-11-17'
status: 'done'
baseline_commit: '129a11543a349b315609ccd200c0b6a8cca2581b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/sandbox-prototype-report.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-pool-assignment.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** session 已經分到角色（3.4），但角色包的程式還沒有地方跑。3.6 的節拍與繪圖需要每個上場的包有一個沙盒：碰不到檔案、網路、系統，只能透過舞台 API 表演（NFR3、NFR9）。

**Approach:** 照 Story 1.2 驗證過的做法（`prototypes/sandbox/`、`sandbox-prototype-report.md`）做正式版：
- **建置：** `src/sandbox` 的 iframe 文件、Worker bootstrap、SES 在建置時組成一份 `sandbox.html`，CSP（含 inline script 雜湊）由 `src/sandbox` 一個模組產生。
- **提供文件：** main 從建置產物以 `pack://_stage/sandbox.html` 提供。
- **建沙盒：** overlay 新增 `pack-host`。一個包有第一個 actor 時：
  1. 經 IPC 向 main 拿入口原始碼；main 交出前再查一次 `apiVersion`。
  2. 建 `<iframe sandbox="allow-scripts">`，把 MessageChannel 的一端和原始碼交給它。
  3. iframe 以 bootstrap＋入口建 classic Worker，把 port 轉交給 Worker，之後不轉發任何訊息。
  4. Worker 移除 API 與「SES 尚未認得的 intrinsics」，以不帶選項的 `lockdown()` 鎖定，在 `Compartment` 裡求值入口，得到工廠並呼叫它取得 `handlers`。
- **訊息：** 包送出的每則訊息都由 `pack-host` 驗證、限速、檢查 `actorId` 歸屬。
- **銷毀：** 最後一個 actor 離場 `SANDBOX_IDLE_MS` 後，移除 iframe 銷毀沙盒。

**Decisions（2026-11-17）：**
- 這段只建立與銷毀沙盒、驗證包送出的訊息。舞台→包的 `init`／`spawn`／`despawn`／`params`／`meta`／`frame` 與繪圖都在 3.6；這段結束時，包已載入、拿到 `handlers`，但還不會收到任何舞台訊息。
- `stage.log` 這段就接通：限速後經 IPC 寫進 run log，帶 `packId`。其他舞台 API 依作者文件建好介面；依賴 actor 的部分（`random`、`hold`、`face`）在 3.6 有 actor 之後才有作用，`fire`、`hold`、`face` 的世界行為在 Epic 4。
- 已安裝但 `apiVersion` 不相容的包：
  - 「角色包」頁顯示原因。
  - 不放進池子，main 也不交出入口，所以不會有 actor 也不會載入。
- actor 指向找不到或不相容的包（3.4 交接條件）時，不建沙盒，每個包只記一行，不出錯。
- 沙盒的失敗（lockdown 有輸出或丟錯、入口不是工廠、工廠丟錯、Worker 錯誤）先只做到：移除該包的 iframe，記一行帶 `packId` 的錯誤。自動重建與次數上限是 3.9。

## Boundaries & Constraints

**Always:**
- **建置與提供：**
  - SES 與 bootstrap 在建置時內嵌，執行時不讀 `node_modules`。`npm start` 與打包版都由 main 從建置產物提供同一份文件；沙盒不經 Vite dev server。
- **CSP：**
  - 字串只由 `src/sandbox` 一個模組產生，`pack://_stage/sandbox.html` 的回應標頭帶上它。
  - 內容沿用原型：`default-src 'none'`、`script-src` 只放那段 inline script 的雜湊與 `'unsafe-eval'`、`worker-src blob:`、`connect-src 'none'`。
  - 其他 `pack://_stage/…` 一律 404。
- **overlay：** CSP 只多開 `frame-src pack:`，其他不放寬。
- **固定的載入順序：**
  1. `pack-host` 先拿到原始碼。
  2. iframe `load` 之後，`postMessage` 一次把原始碼與一個 port 交出。
  3. iframe 只接受來自 `parent`、恰好一個 port 的第一則 `load`。
  4. Worker 是 classic（不帶 `type`），由 blob 建立。
- **Worker bootstrap 的順序：**
  1. 開始計算 console 輸出。
  2. 沿原型鏈刪除 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`WebTransport`、`importScripts`、`Worker`、`SharedWorker`、`indexedDB`、`caches`，還在的再蓋成 `undefined`。
  3. 逐條刪除清單裡的 intrinsics。兩份清單都只在 `src/sandbox` 一處列名。
  4. 不帶選項的 `lockdown()`。
  5. 在 `Compartment` 裡只注入 `stage`。
- **回報與失敗處理：**
  - bootstrap 回報每條移除的結果，以及從載入 SES 到 `lockdown()` 結束的 console 行數。
  - 行數大於 0、任何一條移除失敗、或 `lockdown()` 丟錯，都算沙盒失敗。
- **包送出的訊息：**
  - 用 shared 的 zod schema 驗證，每包限速。
  - `actorId` 不屬於該包（目前沒有任何 actor 時，一律不屬於），整則丟棄。
  - 丟棄時記錄帶 `packId` 的一行；同類的 log 也要限速。
- **隱私：** 交給沙盒的只有入口原始碼與 port。包看不到 `sessionKey`、`source`、`confidence` 與別包的身分。
- **銷毀：** 一律移除 iframe，不呼叫 `worker.terminate()`。
- **新常數：** 只定義在 `src/shared/constants`，例如 `SANDBOX_IDLE_MS`、每包訊息與 `stage.log` 的限速、單則訊息的位元組上限。

**Never:**
- 不做節拍、`frame`、`draw` 的繪製、佔位演出（3.6、3.7）。
- 不做自動重建、心跳逾時、失敗標記（3.9）。
- 不改 `webRequest` 放行規則，也不做 Playwright 沙盒安全測試（3.5 下半段）。
- 不讓 iframe 有 `allow-same-origin`，不給 `pack` scheme `bypassCSP`。
- 不改 `main/pool` 的挑角色規則；不相容的包只是不算在池子裡。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 第一個 actor | 某包第一個 actor 出現 | 拿到原始碼後，建一個 `sandbox="allow-scripts"`、來源 `pack://_stage/sandbox.html` 的 iframe；`load` 後交出原始碼與 port；Worker 回報就緒，記一行帶 `packId` |
| 同包多 actor | 同一包又來一個 actor | 不建新沙盒 |
| 不同包 | 兩個包都有 actor | 各自一個 iframe、一個 Worker |
| 最後一個離場 | 包的最後一個 actor 離場 | `SANDBOX_IDLE_MS` 後移除 iframe；期間又有 actor 回來就保留 |
| 找不到包 | actor 指向未安裝的包 | 不建沙盒，該包記一行，其他包照常 |
| 不相容 | 已安裝的包 `apiVersion` 與舞台不相容 | 「角色包」頁顯示原因；不在池子裡；main 不交出入口 |
| 沙盒文件 | 要 `pack://_stage/sandbox.html` | 回傳建置產物，標頭有 `src/sandbox` 產生的 CSP；雜湊對得上 inline script；`pack://_stage/` 其他路徑 404 |
| 建置 | `npm start` 與打包版 | 都由 main 提供同一份內嵌文件，執行時不讀 `node_modules`，不經 dev server |
| 移除清單 | Worker bootstrap 執行 | 10 個 API 都已移除、清單每條 intrinsic 已移除或原本就沒有，逐條回報 |
| lockdown | 從載入 SES 到 `lockdown()` 結束 | console 0 行算成功；有輸出或丟錯算失敗：移除 iframe，記錯誤 |
| 入口 | 入口求值 | 結果是工廠，呼叫後得到 `handlers` 物件才算就緒；否則算失敗 |
| 訊息驗證 | 包送出不合 schema 的訊息 | 整則丟棄，記一行帶 `packId` |
| 不屬於該包 | 訊息裡的 `actorId` 不是該包的 | 整則丟棄，記一行帶 `packId` |
| 限速 | 包短時間送出超過上限 | 超出的丟棄，記一行帶 `packId` |
| stage.log | 包呼叫 `stage.log` | 在限速內寫進 run log，帶 `packId`，內容截斷並跳脫控制字元 |
| 隱私 | 交給沙盒的訊息 | 只有原始碼與 port，沒有 `sessionKey`、`source`、`confidence`、別包 id |
| 壞輸入 | 拿原始碼或寫 log 的 IPC 參數不合法，或從 panels 呼叫 | `invalid-input` 或 `sender-rejected`，什麼都不做 |

</frozen-after-approval>

## Code Map

- **`src/sandbox/`（新，web 環境，不用 Node built-ins）：**
  - `iframe.ts`：iframe 內的 inline 程式，參考 `prototypes/sandbox/web/sandbox/iframe-bootstrap.js`，只留一個 port。
  - `worker-bootstrap.ts`：參考原型的 `worker-bootstrap.js`。
    - 負責 console 計數、移除、清單、`lockdown()`、`Compartment`。
    - 依作者文件建 `stage` 並 `harden`。
    - 入口求值成工廠後呼叫它，檢查 `handlers`。
    - port 到之前的回報先放 outbox。
  - `lists.ts`：要移除的 10 個 API，以及「SES 尚未認得的 intrinsics」（`Iterator.prototype.join`、`Iterator.prototype.includes`）。
  - `csp.ts`：唯一產生沙盒 CSP 的純函式，輸入 inline script 的雜湊。
  - **建置：** 在 main 的 Vite 建置裡加一個 plugin（設定放在根目錄的 vite 設定或 `scripts/`）。
    - plugin 打包 `src/sandbox`，用 fs 讀 `ses` 的 `dist/ses.umd.min.js`。原型 `main.cjs:812-852` 的組字與檢查（`<>&` 與非 ASCII 跳脫、遇到 `</script`、`<!--` 就停）照搬。
    - 算 SHA-256，呼叫 `csp.ts`，輸出 `sandbox.html` 與記 CSP 的 JSON 到 main 的建置產物旁。
    - `ses` 的 `exports` 沒匯出 dist 檔，要用解析套件路徑的方式讀。
    - depcruise 不允許 `src/main` import `src/sandbox`，main 只讀建置產物。
- **`src/main/packs/protocol.ts`：**
  - `_stage/sandbox.html` 改成回傳建置產物，帶 CSP 與 `content-type: text/html`。文件內容與 CSP 由注入的提供者給，測試可以替換。
  - 其他 `_stage` 路徑仍 404。
- **`src/main/packs/`：**
  - 新增交出入口的處理：入口從安裝資料夾的 `manifest.json` 取 `entry`（`servedPaths` 依字母排序，第一個不一定是入口；審查 VG1 更正）。查已安裝、`checkApiCompatibility`，讀檔回 `{ packId, version, source }`；不相容或找不到回失敗代碼。
  - store 發佈 `packs` 時帶每包的相容結果。
- **`src/shared/packs.ts`、`ipc.ts`、`preload-api.ts`、`src/preload/overlay.ts`：**
  - 兩個只開給 overlay 的通道：拿入口原始碼、寫 `stage.log`。
  - StageView `packs` 每包加相容結果（不相容時帶 `reason`、`required`）。
  - pack→stage 訊息的 schema（`stage.*` 呼叫）放在 `src/shared/pack-api`，`messages.ts:11` 已註明留給 3.5。
- **`src/main/windows/csp.ts`：** overlay（正式與開發）加 `frame-src pack:`，更新 `windows-csp.test.ts` 的整串比對。
- **`src/overlay/pack-host/`（新，不引入 React）：**
  - 依 StageView `actors` 與 `packs` 決定哪些包要有沙盒，管理 iframe 生命週期與閒置計時。
  - 驗證、限速、`actorId` 歸屬寫成純函式，可在 node 測。
  - `src/overlay/main.ts` 接上它。示範方塊不動。
- **`src/main/pool/assign.ts` 的 `poolOf`：** 排除不相容的包。只改池子組成，不改挑選規則。
- **`src/panels/pack-list.ts`、`App.tsx`：** 不相容的包顯示原因，文字沿用 3.2 的 `api-incompatible` 文案。
- **測試：**
  - `src/sandbox` 的純函式：清單、CSP、組字與跳脫。
  - 建置 plugin 產物的雜湊一致。
  - `protocol`、入口 IPC、`pack-host` 的生命週期與驗證，用假 iframe 與假計時器。
  - 正向對照：用 `ELECTRON_RUN_AS_NODE` 的子行程（照原型 `ses-node-check.cjs`）跑 SES＋bootstrap＋契約測試包的入口，斷言 console 0 行、清單逐條回報、工廠回傳 `handlers`。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/main/windows/environment.ts` 的 `webRequest` 放行規則、`src/main/detection/**`、`main/pool` 的挑選規則、`src/shared/pack-api` 既有的訊息與繪圖 schema（只新增 `stage.*`）。

## Tasks & Acceptance

**Execution:**
- [x] `src/sandbox`（清單、CSP、iframe、bootstrap）與建置 plugin：產出 `sandbox.html` 與 CSP。
- [x] `src/main/packs`：`_stage/sandbox.html`、交出入口、相容結果；IPC 與 preload。
- [x] `src/main/windows/csp.ts`：`frame-src pack:`。
- [x] `src/overlay/pack-host` 與 `overlay/main.ts`：沙盒生命週期、訊息驗證、限速、`stage.log`。
- [x] `poolOf` 排除不相容的包；「角色包」頁顯示原因。
- [x] 測試，涵蓋 I/O 矩陣，含正向對照。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言只因新欄位、新通道、CSP 補值。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`、匯入契約測試包、打開示範模式，when 示範 session 分到角色，then run log 有該包的沙盒就緒，沒有錯誤；關掉示範模式 `SANDBOX_IDLE_MS` 後記錄沙盒已銷毀。

## Implementation Notes

- 2026-11-17 開發代理自行決定的部分：
  - **建置：** plugin 在 `scripts/sandbox-plugin.ts`，`vite.main.config.mts` 掛上它（`apply: 'build'`；Forge 的 main 在 `npm start` 也是 build，所以兩邊同一份）。`buildStart` 用 Vite 的 `build()`（`configFile: false`、`write: false`、lib IIFE、不壓縮、無 source map）各打包 `src/sandbox/worker-bootstrap.ts`（全域 `__awpSandboxWorker`）與 `iframe.ts`（全域 `__awpSandboxIframe`），以 `createRequire(<root>/package.json).resolve('ses/package.json')` 找到 `dist/ses.umd.min.js`，交給 `src/sandbox/document.ts` 組字（原型的跳脫與 `</script`、`<!--`、非 ASCII 檢查照搬，另把 CRLF 統一成 LF），再算 SHA-256 呼叫 `src/sandbox/csp.ts`，`emitFile` 出 `sandbox.html` 與 `sandbox-csp.json`（`{ csp, sha256 }`），並把來源檔加進 watch。檔名常數 `SANDBOX_DOCUMENT_FILE`、`SANDBOX_CSP_FILE` 在 `src/shared/constants`。`npm start` 會印 Vite「native config loader」的前瞻警告（config 引入了 TS 來源檔），目前的 bundle loader 正常運作。
  - **inline script 的組成：** `const __awpWorkerScript = "<Worker 腳本 JSON>"` → iframe bundle → `__awpSandboxIframe.startIframe(self, __awpWorkerScript)`。Worker 腳本＝bootstrap bundle → `__awpSandboxWorker.countConsole()` → SES → `__awpSandboxWorker.run(__awpEntrySource)`；iframe 只在前面加 `const __awpEntrySource = <入口的 JSON 字串>`。所以 console 從載入 SES 之前就開始算。
  - **`Compartment` 一定在 `lockdown()` 之後才取：** 正向對照抓到，`lockdown()` 前拿到的 `Compartment` 在 lockdown 後仍用未馴化的 intrinsics（工廠裡 `Date.now()` 不會丟錯）；`harden` 也是 lockdown 後才出現。bootstrap 先取 `lockdown`，lockdown 後才取 `harden` 與 `Compartment`，少一個都算 `ses-missing`。
  - **Compartment 不帶任何 globals：** 作者文件第 6、10 節與契約測試的 `bareRealm` 都是「工廠拿到 `stage`」，沒有全域 `stage`；從外面交進 Compartment 的只有工廠參數 `stage`。
  - **`stage`：** `log(...args)` 在 Worker 內轉成文字（字串原樣、Error 為 `name: message`、其他物件 JSON、失敗為 `[unprintable]`），以 `cutText` 截到 `STAGE_LOG_MAX_LENGTH`；`fire`／`hold`／`face` 照包給的值送 `stage.*`，由 pack-host 驗證；`random(actorId)` 只回答 Worker 認得的己方 actor（3.5 沒有任何 actor，所以一律丟 TypeError），種子由 actorId 雜湊（FNV-1a＋mulberry32，[0, 1)）；`canvas` 先是 `null`（bitmap 繪圖在 3.6）。參數無法 structured clone 時，該方法丟 bootstrap 自己的 TypeError，不把 host 的 DOMException 交給包。port 到之前的呼叫最多留 `SANDBOX_OUTBOX_MAX`（256）則，回報一定保留。`fire` 的 `target` 先定為 actorId（任何一包的）。
  - **Worker 的回報：** `sandbox.ready`（removals、consoleLines 0）、`sandbox.failed`（reason、removals、consoleLines）、`sandbox.fault`（Worker 內未捕捉的 `error`／`unhandledrejection`）。schema 在 `src/shared/sandbox.ts`，sandbox 端只 `import type`，bundle 裡沒有 zod。移除失敗、lockdown 有輸出或丟錯時不求值入口。iframe 在 Worker 建不起來或觸發 `error` 時對 parent 送不帶任何內容的 `{ type: 'worker-error' }`（不轉發 Worker 訊息），pack-host 只收自己 iframe 的這一種。
  - **寫 run log 的通道：** spec 的兩個 overlay 通道定名 `packs:get-entry`、`packs:log`。驗收要 run log 有「沙盒就緒／已銷毀」，所以 `packs:log` 除了 `stage.log`，也帶 pack-host 自己的行（`sandbox-ready`、`sandbox-destroyed`、`sandbox-failed`、`sandbox-skipped`、`messages-dropped`），全是英文代碼、id、版本與移除名稱；唯一的自由文字 `stage.log` 在 main 經 `quotedName`（加了長度參數）跳脫控制與 bidi 字元並截斷。main 交出入口時另記一行 `entry handed to its sandbox`。
  - **pack-host 的狀態：** 每包 `requesting → loading → ready`，失敗為 `failed`（iframe 立刻移除，actor 還在時不重建，離場滿 `SANDBOX_IDLE_MS` 後清掉紀錄，之後的新 actor 是新沙盒）。main 拒絕交出入口時記一行，actor 都離場前不再要求。丟棄 log 每包每種原因 `PACK_DROP_LOG_INTERVAL_MS`（10 秒）一行，下一行帶期間累積的數量，沙盒銷毀或失敗時補記。限速為固定窗：每包訊息 120 則／秒、`stage.log` 20 行／10 秒；單則上限 64 KiB（以有上限的 JSON 位元組估算，非純 JSON 資料算 `invalid`）。`SANDBOX_IDLE_MS` 定 30 秒。
  - **overlay CSP：** `PACKAGED_CSP` 仍是 panels 的；新增 `OVERLAY_PACKAGED_CSP`（在 `connect-src` 後插入 `frame-src pack:`），`devServerCsp(origin, page)` 依 renderer 選；`app://overlay/` 與 overlay 的 dev server 用 overlay 版。
  - **StageView `packs`：** 每包加 `compatibility`（`{ compatible: true }` 或 `{ compatible: false, reason, required }`，schema 在 `src/shared/packs.ts`，pack-api 只新增 `stage.ts`）。「角色包」頁以 `apiIncompatibleText`（從 3.2 的 `api-incompatible` 文案抽出）顯示「無法上場：…」。
- 既有斷言改動（不是只補新欄位、新通道、CSP 的部分）：`packs-protocol.test.ts` 原本把 `pack://_stage/sandbox.html` 列在 404 清單，改成 `pack://_stage/other.html`（sandbox 文件現在會回 200，另有專門的測試）；`windows-protocols.test.ts` 的 overlay 標題由「the same CSP」改為 overlay 自己的 CSP；`shared/packs.test.ts` 的「stage pack 是 index entry 去掉 servedPaths」改為「再加 compatibility」。
- 2026-11-17 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise` 全過。正向對照在 Electron 45.2.1 的 Node 模式跑真 SES＋建置出的 bootstrap＋契約測試包入口：console 0 行、stdout／stderr 皆空、12 條移除逐條回報（兩條 Iterator 方法為 removed）、工廠回傳 6 個 handlers；工廠裡碰 `Date.now`、`Math.random`、`console`、`fetch` 都是 `factory-threw`；SES 載入後印一行則 `lockdown-output`（反向對照）。隔離 `--user-data-dir` 的 `npm start` 帶契約測試包 `.awpet`：run log 有 `entry handed to its sandbox` 與 `sandbox ready`（removed 9、absent 3、console 0）；overlay 裡只有一個 `sandbox="allow-scripts"`、hidden、`pack://_stage/sandbox.html` 的 iframe，iframe origin 為 `null`、讀 `parent.document` 丟 SecurityError；經主行程 inspector 點系統匣 `demo-approval` 後示範 session 分到角色（同包不另建沙盒）；所有 actor 離場（釋放、關掉示範模式）後 30 秒記 `sandbox destroyed`，iframe 為 0；再顯示示範 session 又建新沙盒並就緒。run log 沒有 error 行。打包到暫存資料夾（驗完已刪）：asar 內有 `.vite/build/sandbox.html` 與 `sandbox-csp.json`、雜湊相符、沒有 `node_modules/ses`；以隔離 `--user-data-dir` 啟動打包版也記到 `sandbox ready`。

- 2026-11-17 主流程重跑：四項檢查全過（96 檔通過、1 檔跳過；4773 個測試通過、2 個跳過；depcruise 271 個模組、0 違規）；I/O 矩陣 17 列都有測試且都在本機跑過（Electron Node 模式的正向對照在本機有跑；CI 設 `ELECTRON_SKIP_BINARY_DOWNLOAD`，那幾個會改跑純 Node 版本）；3 行被改寫的既有 `expect(` 只補新的 overlay CSP、`packs` preload API 與 `compatibility` 欄位；另外 `packs-protocol.test.ts` 原本斷言 `_stage/sandbox.html` 回 404，依規格改成斷言其他 `_stage` 路徑 404。（更正：CI 只跑純 Node 區塊的 2 個案例，見審查 VO1。）

- 2026-11-17 審查修補（協調者指出）：
  - **入口改從安裝資料夾的 `manifest.json` 取：** `inspect.ts` 把 `servedPaths` 排序後存，Code Map「`servedPaths[0]` 就是 entry」不成立（入口排在素材後面時會交出圖片）。`readPackEntry` 讀已安裝版本的 `manifest.json`（容許 BOM），`entry` 須通過 `packPathSchema` 且在 `servedPaths` 裡，否則 `read-failed`；已安裝的舊包同樣適用。`packIndexEntrySchema` 的註解改為「排序、哪個是入口只有 manifest 知道」。
  - **開機逾時：** 新常數 `SANDBOX_BOOT_TIMEOUT_MS`（10 秒），從加入 iframe 起算，沒收到 ready／failed 就以 `boot-timeout` 失敗（移除 iframe、記一行）；ready、failed、銷毀時清掉計時。
  - **包被移除、變不相容或換版本：** actor 還在時，`onView` 發現沙盒的包已不在、不相容或版本不同，就立刻銷毀（`sandbox-destroyed` 新增必填 `reason`：`idle`／`not-installed`／`api-incompatible`／`version-changed`），之後照一般規則記 skip 或為新版本建沙盒。
  - **沙盒文件比對雜湊：** main 載入時算文件唯一 inline script 的 SHA-256，須等於 `sandbox-csp.json` 的 `sha256` 且出現在 CSP 裡，否則記一行錯誤、當作沒有文件（404）。
  - **handlers 檢查：** 陣列、thenable（含 async 工廠回傳的 promise）、`then` getter 丟錯，都算 `handlers-not-object`。
  - **回報先送：** Worker 先送開機回報，工廠期間的 `stage.*` 之後才送；pack-host 在 ready 前只收 `stage.log`，其他呼叫以新原因 `not-ready` 丟棄。`sandbox.fault` 每個 Worker 只送一次。outbox 上限只算 `stage.*` 呼叫，不算回報。
  - **Windows 路徑：** plugin 的 watch 檔與測試的比對都用 `path.normalize`。
  - **CI 覆蓋：** `build.test.ts` 的入口失敗碼、工廠碰 `Date.now`／`Math.random`／`console`／`fetch`、陣列與 async 工廠、`stage.log` 截斷、反向對照都移到純 Node 區塊；Electron 區塊只留 Iterator intrinsics 為 removed 與 lockdown 0 行。
  - `src/sandbox/document.ts` 註解的檔名改為 `scripts/sandbox-plugin.ts`。

- 2026-11-17 審查修補後驗證（主流程重跑）：四項檢查全過（96 檔通過、1 檔跳過；4804 個測試通過、2 個跳過；depcruise 0 違規）；被改寫的既有 `expect(` 仍是那 3 行；Code Map 的入口說明已更正（審查 VG1）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-17）：Blind Hunter 16 條（B1–B16）、Edge Case Hunter 7 條（E1–E7）、Verification Gap 1 個缺口（VG1）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VG1、B14 | `readPackEntry` 以 `servedPaths[0]` 當入口，但 `inspect.ts:325` 把 `servedPaths` 依字母排序；入口排在素材後面的包（例如 `main.js` 加 `img/…`）會把圖片當入口交給沙盒 | high | patch | 已確認 `checkedFiles` 回傳 `[...served].sort()`；測試的包剛好入口排第一。這是 Code Map 寫錯的假設，開發代理照做；修法局部：從安裝資料夾的 `manifest.json` 取 `entry`（檢查路徑規則且在 `servedPaths` 裡），已安裝的包也適用，補入口排在後面的實際安裝測試 |
| B2、E1 | 沙盒一直沒回報（文件 404、CSP 雜湊不符、工廠無窮迴圈）時永遠停在載入中，iframe 留著，run log 沒有任何一行 | medium | patch | 已確認 `host.ts` 沒有載入逾時；工廠無窮迴圈可以直接造出來。加 `SANDBOX_BOOT_TIMEOUT_MS`，逾時照沙盒失敗處理（移除 iframe、記一行） |
| B1、E3 | 包被移除或換版本時，已存在的沙盒不比對已安裝清單，舊程式繼續跑到 actor 離場 | medium | patch | 已確認 `onView` 遇到已有沙盒只 `keep`；使用者移除包後程式仍在跑。包不在已安裝清單就銷毀；版本變了就銷毀、依新版本重建（重新 `spawn` 屬 3.9） |
| E6 | 建置測試比對 watch 檔案時，Vite 的 module id 是 `/`，`path.join` 在 Windows 是 `\`，windows-latest 會失敗 | medium | patch | 已確認比對沒有正規化；CI 的 Windows 會擋住 push。在 plugin 或測試正規化路徑 |
| B3、E2 | `sandbox-csp.json` 的 `sha256` 讀了沒用，文件與 CSP 不成對時 inline script 被擋、沙盒無聲不啟動 | low | patch | 正常建置一定成對；直接修正：載入時比對雜湊，不符就記錯誤並當成沒有文件（404） |
| E4 | 非同步工廠回傳 Promise、或回傳陣列，被當成 `handlers` 回報就緒 | low | patch | 已確認只檢查 `typeof === 'object'`；直接修正：陣列與 thenable 算 `handlers-not-object` |
| B4、B11 | bootstrap 先送工廠裡的 `stage.*`、後送就緒回報，host 在就緒前就放行；測試標題寫「先送回報」，斷言卻是後送 | low | patch | 3.5 沒有 actor 所以目前都丟棄，但 3.6 起開機失敗的包仍可能影響世界；改成先送回報，host 在就緒前只放行 `stage.log`，標題與斷言一致 |
| B5 | `sandbox.fault` 沒有只送一次的鎖，port 到之前 outbox 會無上限成長 | low | patch | 第一個 fault 對 host 已是終局；直接修正成只送一次 |
| B12 | `src/sandbox/document.ts` 註解寫 `scripts/sandbox-plugin.mts`，實際是 `.ts` | low | patch | 直接修正 |
| VO1 | 規格的驗證紀錄說 CI 會改跑純 Node 版本，但純 Node 區塊只有 2 個案例；入口失敗代碼、工廠碰全域、`stage.log` 截斷在 CI 都沒跑 | low | patch | 審查者實測這些案例在純 Node 也成立；把與 Electron V8 無關的案例移到純 Node 區塊，讓 CI 也跑；驗證紀錄改正 |
| B9 | 沙盒文件的 CSP 沒有 `sandbox allow-scripts` 與 `frame-ancestors`，opaque origin 完全靠 iframe 的屬性 | low | defer | 目前沒有途徑在沒有 `sandbox` 屬性的框架載入它；凍結的 CSP 內容是「沿用原型」，加指令要使用者同意；放進 3.5 下半段（安全把關）一起決定 |
| B10 | 正向對照沒有執行實際組出來的 Worker 字串與 iframe 程式，只有字串比對與假物件 | medium | defer | 開發代理在 `npm start` 與打包版實際看到 sandbox ready；3.5 下半段的 Playwright 會在真 Electron 跑整條鏈，記進 deferred-work 要求下半段斷言它 |
| B6 | 丟棄計數要等下一次丟棄或銷毀才補記 | low | reject | 只是 log 時間點；加計時器要多一個狀態 |
| B7 | `request-failed`、`read-failed` 不重試，actor 在就一直沒有沙盒 | low | reject | 重建與重試是 3.9 的範圍 |
| B8 | 不相容的包「上場」「加入池子」仍可勾，沒有效果 | low | reject | 值照樣保存，包相容後才生效；要停用要多一段 UI 邏輯 |
| B13 | `packIdOf` 放在 overlay，沒有 `/` 的字串整串當 pack id | low | reject | `actors` 的 `characterKey` 已由 `characterKeySchema` 驗證，不會出現沒有 `/` 的值 |
| B14（其餘） | `source` 上限用位元組數當 UTF-16 長度；輸出驗證前就記「handed」 | low | reject | UTF-16 長度不會超過 UTF-8 位元組數，上限只會比較鬆；log 時間點問題 |
| B15 | iframe 建不起來也記成 `worker-error` | low | reject | 只影響 log 的原因字樣；新增原因代碼要改 shared 列舉 |
| B16 | sprint 與 spec 狀態不同；延後條目 `source_spec: none`；限制只寫在延後條目 | false | reject | 狀態依流程在 step-05 同步；拆段條目依流程規定寫 `none`；修法是改本規格 |
| E5 | 安裝後被改大的入口檔整個讀進記憶體 | low | reject | 要有人改動 userData 才會發生 |
| E7 | 「既有斷言只補新欄位」不精確：`_stage/sandbox.html` 的 404 斷言改成其他路徑 | false | reject | 規格要求提供這份文件，這是預期的行為改變；驗證紀錄改正措辭 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 匯入契約測試包、打開示範模式：run log 有沙盒就緒。
  - 取消上場或關掉示範模式：`SANDBOX_IDLE_MS` 後記錄沙盒銷毀。
