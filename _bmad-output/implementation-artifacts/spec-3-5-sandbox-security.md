---
title: 'Story 3.5（下）：請求限制與沙盒安全測試'
type: 'feature'
created: '2026-11-17'
status: 'done'
baseline_commit: 'fcc31369c617024d688db96b368380459891dd3f'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-5-sandbox-chain.md'
  - '{project-root}/_bmad-output/implementation-artifacts/sandbox-prototype-report.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 沙盒載入鏈已經在跑（3.5 上半段，`fcc3136`），但還沒在真的 Electron 裡證明包逃不出去。CI 也沒有任何測試會啟動 Electron，Windows 從沒驗過。另外，請求過濾只看 URL，不看是誰發的：開發時沙盒也能打到 Vite dev server（Epic 1 回顧 A8）。

**Approach:**
- **請求過濾看發起者：**
  - 正式版只放行 `app://`、`pack://`。
  - 開發時，dev server 只放行 overlay、panels 頂層框架發出的請求。
  - 沙盒（iframe 與它的 Worker）發出的請求一律 cancel；唯一例外是 overlay 載入沙盒文件本身。
- **Playwright 沙盒安全測試：**
  - 新增 `@playwright/test` 1.64.1，用 `_electron` 啟動正式建置。
  - 用暫存的 HOME 與 userData，放一個合成的 Claude Code session，讓測試包分到 actor、載入沙盒。測試包在工廠裡逐項嘗試逃逸，用 `stage.log` 回報。
  - 測試讀 run log 與 overlay 的 DOM 判斷結果。
  - CI 加一個 macOS、Windows 都跑的 e2e job。
- **一致性測試：** 移除清單與作者文件第 10 節要一致。

**Decisions（2026-11-17）：**
- 這組 e2e 就是 Epic 2 回顧 B8「端到端測試承接」的起點：
  - Playwright 設定、建置方式、CI job 由這個 story 建立。
  - 之後的 story 沿用；面板與 overlay 的畫面測試（3.3、3.4 延後的那兩筆）仍各自處理，不在這次。
- `devtools:` 只在開發時放行（開發者工具要用），正式版也擋。
- e2e 一律在暫存資料夾裡跑，不碰真的 HOME 與 userData；也不連網，逃逸嘗試的目標只用 `127.0.0.1`。
- 沙盒文件的 CSP 加上 `sandbox allow-scripts`（使用者 2026-11-17 選 A）：不靠嵌入端 iframe 的屬性也強制 opaque origin、只允許 script；不加 `frame-ancestors`。

## Boundaries & Constraints

**Always:**
- **判斷發起者：** 用 `onBeforeRequest` 的 `details`（`frame`、`webContentsId`、`initiatorOrigin`、`resourceType`）。拿不到發起者時，從嚴：dev server 的請求擋掉，`app://`、`pack://` 照舊。
- **沙盒的請求一律 cancel：** 框架不是頂層、框架 URL 是 `pack:`、或 `initiatorOrigin` 是 `"null"` 的請求，不論目標是什麼。唯一例外是 overlay 頂層載入 `pack://_stage/sandbox.html` 這個子框架。被擋的 origin 照現有規則只記一次。
- **e2e 的建置與啟動：**
  - 建置：用 Forge 的程式 API 打包到暫存的 `outDir`，取得正式版 `.vite`。不寫進、不占用 `out/`。
  - 啟動：`_electron.launch({ args: ['.', '--user-data-dir=<暫存>', <測試包.awpet>] })`，`HOME` 與 `USERPROFILE` 指向暫存資料夾。
  - 打包版的 fuses 不讓 Playwright 附加，所以不 launch 打包版。
- **測試包：** 只在測試裡用 `test/helpers/awpet.ts` 產生，不含角色或系列名稱，入口通過匯入檢查。
- **「清單每一條」的斷言：** 允許「已移除」或「原本就沒有」，不允許其他狀態。
- **CI：** 原本的 unit job 照舊（不下載 Electron）。e2e 是另一個 job，下載 Electron，也跑 `test/sandbox/build.test.ts` 的 Electron 區塊。

**Never:**
- 不在 app 程式裡加測試專用的後門或環境變數；取得 actor 只靠合成的 session 檔與現有通道。
- 不改沙盒載入鏈、訊息驗證、限速的行為（3.5 上半段）。唯一例外是沙盒 CSP 加上 `sandbox allow-scripts`。
- 不做面板、overlay 的畫面測試，也不做節拍與繪圖（3.6）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 正式版放行 | 打包版，請求 `app://`、`pack://` | 放行；`http(s)`、`ws`、`file`、`devtools:` 等一律 cancel |
| 開發版 dev server | `npm start`，overlay 或 panels 頂層框架請求 dev server（含 HMR） | 放行 |
| 沙盒發出 | 請求來自沙盒 iframe 或它的 Worker（不論目標是 dev server、`pack://` 或其他） | cancel，該 origin 只記一次 |
| 沙盒文件 | overlay 頂層載入 `pack://_stage/sandbox.html` 子框架 | 放行 |
| 不明發起者 | `details` 沒有發起者資訊 | dev server 擋掉；`app://`、`pack://` 照舊 |
| 正向對照 | e2e 啟動正式建置，測試包分到 actor | run log 有該包 sandbox ready：每條清單「已移除」或「原本就沒有」，console 0 行；工廠用 `stage.log` 回報已執行 |
| 逃逸失敗 | 測試包在工廠裡嘗試 fetch、XHR、WebSocket、EventSource、importScripts、巢狀 Worker、parent、top、indexedDB、`Date.now`、`Math.random`、OffscreenCanvas webgl，以及經 Function 建構子拿全域 | 每一項都失敗，回報裡沒有任何一項成功 |
| 實際組出來的鏈 | e2e 檢查 overlay | 恰好一個 `sandbox="allow-scripts"`、來源 `pack://_stage/sandbox.html` 的 iframe；它的 origin 是 `null`，讀 `parent` 丟錯 |
| 沙盒 CSP | e2e 取 `pack://_stage/sandbox.html` | 回應的 CSP 與建置產物一致，含 `sandbox allow-scripts`，沒有 `frame-ancestors`；沙盒照樣就緒 |
| 閒置銷毀 | e2e 經面板釋放那個 session | `SANDBOX_IDLE_MS` 後 run log 有 sandbox destroyed，overlay 不再有該 iframe |
| CI | push 到 main | e2e job 在 macOS 與 Windows 都跑且通過；失敗時會讓 CI 變紅 |
| 隔離 | e2e 執行 | 只用暫存的 HOME 與 userData；沒有對外連線 |
| 清單與文件 | 比對 `src/sandbox/lists.ts` 與作者文件第 10 節「已移除」 | 兩邊名稱一致；只改一邊測試就失敗 |

</frozen-after-approval>

## Code Map

- **`src/main/windows/security.ts`、`environment.ts`：**
  - `createRequestFilter` 改收 Electron 的 details（`url`、`frame`、`webContentsId`、`initiatorOrigin`、`resourceType`）。
  - 判斷寫成可單獨測的純函式；`isAllowedRequestUrl` 的 `devtools:` 只在有 dev server 時放行。
  - 仍只裝在 `session.defaultSession`（main.ts:497）。
  - Worker 發的請求帶的 `frame` 要實測。測不到時照「拿不到發起者，從嚴」處理，並記在 Implementation Notes。
  - 沙盒文件的 CSP 在 webRequest 之前就會擋掉沙盒的請求，所以這一層只能用單元測試帶 details 驗。
- **`src/sandbox/csp.ts`：** 加上 `sandbox allow-scripts`；`protocol.ts` 的 CSP 檢查與既有測試跟著改。
- **`test/e2e/`（新）：**
  - `sandbox.spec.ts`。
  - 輔助程式：暫存 HOME、合成 session 檔（`<HOME>/.claude/projects/<資料夾>/<uuid>.jsonl`，一行 `type: user` 的紀錄，時間是現在）、產生測試包、讀 run log（每小時一檔，要讀多個）。
  - 測試包工廠逐項 try/catch，把結果組成一行 ASCII JSON，用 `stage.log` 回報。`stage.log` 每包 20 行／10 秒，回報要在這個限制內。
  - 釋放 session：在面板呼叫 `window.awp.pool.setReleased`。沙盒 iframe 的 origin、`parent`：用 Playwright 的 frame 取得。
- **`playwright.config.ts`（新，根目錄）：** 只跑 `test/e2e/*.spec.ts`，worker 1 個，逾時夠涵蓋 `SANDBOX_IDLE_MS`。vitest 只收 `*.test.ts`，不會收進去。
- **`scripts/e2e-build.mjs`（新）：** 呼叫 `@electron-forge/core` 的 `api.package({ dir, outDir: <暫存> })`，得到正式版 `.vite`。
- **`package.json`：**
  - `npm install --save-dev --save-exact @playwright/test@1.64.1`，不下載瀏覽器（`_electron` 不需要）。
  - 新增 `e2e` script（先建置再跑 Playwright）。
- **`.github/workflows/ci.yml`：** 新增 `e2e` job。
  - matrix `[macos-latest, windows-latest]`，不設 `ELECTRON_SKIP_BINARY_DOWNLOAD`。
  - 步驟：`npm ci`、`npm run e2e`、Electron 區塊的 vitest。
  - 逾時 20 分鐘；失敗時上傳 run log 與 Playwright 報告當 artifact。
- **`test/sandbox/lists-docs.test.ts`（新）：** 讀 `docs/pack-api-v1.md` 第 10 節「已移除」兩行，和 `REMOVED_WORKER_APIS`、`SES_UNKNOWN_INTRINSICS` 比對。可參考 `test/packs/contract-pack.test.ts:150` 讀文件的寫法。
- **測試：** 請求過濾的單元測試放在既有的 `windows-security`、`windows-environment`；I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`，e2e 也一樣。

**不要改：** `src/overlay/pack-host/**`、`src/sandbox/worker-bootstrap.ts`、`iframe.ts`、`lists.ts`（只讀）、`src/main/packs/**`（`protocol.ts` 的 CSP 檢查除外）、偵測與分配。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/windows/security.ts`、`environment.ts`：依發起者過濾，加單元測試。
- [x] `src/sandbox/csp.ts`（加 `sandbox allow-scripts`）、`protocol.ts` 的檢查。
- [x] `@playwright/test`、`playwright.config.ts`、`scripts/e2e-build.mjs`、`test/e2e/`：沙盒安全測試。
- [x] `.github/workflows/ci.yml`：e2e job。
- [x] `test/sandbox/lists-docs.test.ts`。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過，既有斷言只因新的過濾參數與 CSP 補值。
- Given push 到 main，when CI 跑完，then unit 與 e2e 兩個 job 在 macOS、Windows 都通過。

## Implementation Notes

- 2026-11-17 開發代理自行決定的部分：
  - **發起者實測（Electron 45.2.1）：** 用暫存 `--user-data-dir` 的獨立小程式（scratch，不進 repo）載入 `app://overlay/` 與一個 127.0.0.1 頁面，在 `onBeforeRequest` 記下 details：
    - Worker 發的請求（沙盒 Worker 的 fetch、WebSocket、`importScripts`，巢狀 Worker 的 fetch）帶的 `frame` 是啟動它的文件的框架：沙盒 Worker 的就是沙盒 iframe（url `pack://_stage/sandbox.html`、parent 是 overlay 頂層），`initiatorOrigin` 是 `"null"`。Worker 測得到，不必退回「拿不到發起者」。
    - 視窗自己的頂層導覽（`mainFrame`）：`frame` 是頂層框架，url 還是 `''`，沒有 `initiatorOrigin`。所以「頂層框架導覽到 renderer 的網址」也算 renderer 頂層框架，否則 `npm start` 第一次載入 dev server 就會被擋。
    - iframe 導覽（`subFrame`）：`frame` 是那個 iframe 自己（url `''`，parent 是設 `src` 的框架），`initiatorOrigin` 是父框架的 origin（`app://overlay`）。沙盒文件的例外照這個形狀判斷：`subFrame`、URL 恰好是 `SANDBOX_DOCUMENT_URL`、框架的 parent 是 overlay 的頂層框架、`initiatorOrigin` 等於 overlay 的 origin；少一項就照「不是頂層框架」cancel。
    - `webContentsId` 用不到：判斷只看 `frame`、`initiatorOrigin`、`resourceType`。WebFrameMain 已銷毀（讀屬性丟錯）視同拿不到發起者。
  - **判斷：** `environment.ts` 新增 `requesterOf`（`sandbox`／`sandbox-document`／`stage-page`／`page`／`unknown`）與 `requestDecision`（決定與發起者一起回傳，框架只讀一次；`isAllowedRequest` 只取決定）；`isAllowedRequestUrl` 仍是只看 URL 的那一層。`isDevelopment`（有 dev server）是「開發時」的唯一判斷：`devtools:` 只在這時放行，面板（`panel-window.ts`）也只在這時開 DevTools。`security.ts` 的 `createRequestFilter` 收 Electron 的 details；被擋的請求依「origin＋是不是沙盒發出」各記一次，沙盒那一行多 `, made by a sandbox`（所以沙盒去碰一個已因頁面被擋過的 origin，仍會留一行）。
  - **`protocol.ts` 的 CSP 檢查：** `sandbox-csp.json` 的 CSP 須以 `default-src 'none'; ` 開頭，恰好一條名為 `sandbox` 的 directive 且內容是 `sandbox allow-scripts`，沒有任何 `frame-ancestors`；directive 名稱不分大小寫（瀏覽器只用重複 directive 的第一條，所以重複的 `sandbox` 也拒絕）。不符就照「不符 schema」處理（404、記一行錯誤）。
  - **e2e：**
    - Playwright 把 `.ts` 編成 CommonJS（package.json 沒有 `type: module`），`import.meta` 不能用：`test/helpers/awpet.ts` 的契約包路徑改用 `__dirname`（vitest 也提供），`test/e2e/helpers.ts` 同樣。
    - 測試包 `sandbox-probe`：契約測試包換 id、名稱 `Sandbox probe`、入口換成探針。探針在工廠裡逐項嘗試 42 項：規格的 13 項（Function 建構子拆成 Compartment 自己的、和經 `stage.log.constructor` 拿到的 Worker realm 的兩項）、經 Function 建構子組出來的動態 `import()`，以及作者文件第 10 節列為沒有的每一項（`performance`、`crypto.getRandomValues`／`crypto.subtle`、`Intl`、`self`／`postMessage`／`navigator`／`location`、`SharedArrayBuffer`、`Atomics`、`WeakRef`、`FinalizationRegistry`、`new Date()`／`Date()`、`console`、四種計時器、三種 Float 陣列、兩個 Iterator 方法、`WebTransport`／`SharedWorker`／`caches`）。每項回報 `threw:<錯誤名>` 或 `returned:<型別>`；另有一個用同樣方式執行、一定會成功的 control。報告的 JSON 把非可列印 ASCII 寫成 `\uXXXX`，切成每段 900 字元、一段一行 `stage.log`（`awp-probe <i>/<n> …`），測試依序組回；目前 2 行，都不會被截斷、遠低於每 10 秒 20 行。網路類嘗試的目標是測試自己在 127.0.0.1 開的伺服器，「隔離」斷言它沒收到任何請求。
    - 沙盒發出（真的經過 webRequest）：在沙盒 iframe 裡把自己導向 `pack://sandbox-probe/1.0.0/entry.js`（overlay CSP 的 `frame-src pack:` 與導覽守衛都放行，主行程 `net.fetch` 同一個 URL 是 200），run log 出現 `request blocked: pack://sandbox-probe, made by a sandbox …`。這會弄壞那個 iframe 的內容，所以排在所有讀 iframe 內容的測試之後；之後只有閒置銷毀與隔離。
    - 沙盒 CSP 單獨生效：在 overlay 建一個**沒有** `sandbox` 屬性的 `pack://_stage/sandbox.html` iframe，origin 仍是 `null`、讀 `parent.document` 丟 SecurityError，測完移除。
    - `beforeAll` 的時限是內部各段等待的總和加 30 秒；等就緒時若出現該包的 `sandbox failed` 或 `gets no sandbox`，立刻帶那一行失敗。閒置銷毀只認釋放之後的 `sandbox destroyed`。
    - 一次啟動跑完整個檔案（serial）。run log 在 afterAll 複製到 `test-results/run-log/` 再刪暫存資料夾；CI 一律（`always()`，含逾時取消）上傳 `test-results/`、`playwright-report/`（`actions/upload-artifact@v4`），Electron 區塊的 build.test.ts 在 e2e 失敗時也跑（`!cancelled()`）。`scripts/e2e-build.mjs` 刪暫存打包資料夾時重試（10 次、間隔 500 ms），刪不掉只警告，不會蓋掉打包本身的錯誤。`.gitignore` 加這兩個資料夾；`tsconfig.node.json` 加 `playwright.config.ts`。
    - 沙盒 CSP：overlay 的 CSP 是 `connect-src 'self'`，不能直接 fetch `pack:`，改用主行程的 `net.fetch('pack://_stage/sandbox.html')`（Playwright `app.evaluate`）取回應。
    - 隔離：主行程的 `app.getPath('userData')`、`HOME`、`USERPROFILE` 等於暫存資料夾；StageView 的 sessions 只有合成的那一個；run log 被擋的請求恰好只有沙盒發出那一行。
- 既有斷言改動：
  - `windows-security.test.ts` 的 `createRequestFilter` 表格改帶 overlay 頂層框架的 details（新的過濾參數）；其中 `devtools:` 那列由「兩邊都放行」改成「打包擋、開發放行」（2026-11-17 的決定）。
  - `windows-environment.test.ts` 的 `isAllowedRequestUrl` 表格 `devtools:` 那列由「兩邊都放行」改成「打包擋、開發放行」（同一個決定）。
  - `sandbox.test.ts` 的 `sandboxCsp` 整串比對補上 `; sandbox allow-scripts`（CSP 補值）。
  - `windows-panel-window.test.ts` 的「dev 才開 DevTools」不變，另加「未打包、沒有 dev server 不開」。
  - 其餘都是新增的案例。
- 2026-11-17 審查修補後驗證（開發代理）：只跑改到的檔案涵蓋的單元測試（windows-security、windows-environment、windows-panel-window、packs-protocol、lists-docs，311 個通過）與 `npm run e2e`（8 個全過，`out/` 未變動、暫存資料夾與程序都已清掉）；完整檢查由協調者重跑。
- 2026-11-17 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`（97 檔通過、1 檔跳過；4883 個測試通過、2 個跳過）、`npm run depcruise`（276 個模組、0 違規）、`npm run e2e`（Forge 打包到暫存資料夾後刪除、`out/` 未變動；Playwright 6 個全過，閒置銷毀那個約 30 秒）都在本機（macOS arm64）跑過。另外用暫存 HOME／userData 跑一次 `npm start` 帶契約測試包：兩個 renderer 都從 dev server 載入、沙盒就緒，run log 沒有任何 `request blocked`（dev server、HMR、`devtools:` 都放行）。CI（macOS、Windows 的 e2e job）尚未跑。

- 2026-11-17 主流程重跑（macOS arm64）：`npm run typecheck`、`npm run lint`、`npm run depcruise`（276 個模組、0 違規）、`CI=true npm test`（97 檔通過、1 檔跳過；4883 個測試通過、2 個跳過）、`npm run e2e`（6 個全過，31.5 秒）全過；`out/` 沒有被動到；I/O 矩陣 12 列有測試且都跑過，「CI」列要等 push 後的實際 CI；（更正：diff 裡被改寫的 2 行 `expect(` 是 `windows-security.test.ts` 的 `createRequestFilter` 改帶頂層框架的 details；`devtools:` 依決定改成正式版擋、開發放行，改的是兩張 `it.each` 表格的資料列。）

- 2026-11-17 審查修補後驗證（主流程重跑，macOS arm64）：五項檢查全過（97 檔通過、1 檔跳過；4893 個測試通過、2 個跳過；depcruise 0 違規；`npm run e2e` 8 個全過，31.9 秒）；`out/` 沒有被動到；被改寫的既有 `expect(` 仍是那 2 行；「CI」列待 push 後的實際 CI。

- CI：commit `1a6c492`（2026-11-17）後，GitHub Actions 的 unit（check）與 e2e 兩個 job 在 macOS、Windows 都通過（run 44031335014），I/O 矩陣「CI」列成立；Windows 第一次在 CI 啟動 Electron 就通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-17）：Blind Hunter 16 條（B1–B16）、Edge Case Hunter 9 條（E1–E9）、Verification Gap 2 個缺口（VG1、VG2）與 2 條其他發現（VO1、VO2）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VG1 | 「沙盒發出」的規則只用手寫的 details 測過；e2e 的逃逸都在 CSP 或 Compartment 就被擋，沒有一個請求真的從沙盒框架走到 webRequest | medium | patch | 驗證缺口已附證據；在 e2e 從沙盒框架導覽到 `pack://` 網址（overlay CSP 與導覽守衛都放行，只剩 webRequest 能擋），斷言被 cancel 並記 `made by a sandbox`；這也讓升級 Electron 時能重新確認 `details` 的形狀 |
| B9 | 新加的 CSP `sandbox allow-scripts` 沒被單獨驗證；「實際組出來的鏈」的 `null` origin 光靠 iframe 屬性就能解釋 | medium | patch | 使用者選 A 的目的沒被觀察到；在 e2e 從 overlay 建一個不帶 `sandbox` 屬性的 iframe 載入沙盒文件，斷言 origin 仍是 `null`、讀 `parent` 丟錯 |
| B5、E6、VO1 | `devtools:` 改成有 dev server 才放行，`panel-window.ts:227` 卻在未打包時就開 DevTools；e2e 每次開空白 DevTools，`隔離` 測試把這行寫成例外 | medium | patch | 已確認兩處對「開發中」的定義不同；`environment.ts` 加一個共用的判斷，兩處都用它，拿掉 e2e 的例外 |
| B6、B7 | 探針報告約 585 字元，真有逃逸時會超過 `stage.log` 的 1000 字元而被截斷、解析失敗；`parent`、`top` 在 Worker 本來就沒有，作者文件第 10 節列的多數項目（`performance.now`、計時器、`SharedArrayBuffer`、`postMessage`、`navigator` 等）沒試，字串拼出的動態 `import()` 也沒試 | medium | patch | 最需要看到哪一項逃出去時反而看不到；報告改成分行、不截斷且在每 10 秒 20 行內，探針補齊作者文件第 10 節宣稱沒有的項目與動態 `import()` |
| E3 | Windows 上打包後 exe 可能還被鎖著，`e2e-build.mjs` 的 `fs.rm` 會 EBUSY／EPERM | medium | patch | Windows CI 第一次跑，`npm run e2e` 會在建置成功後失敗；加重試 |
| B11 | job 撞到逾時被取消時 `if: failure()` 不會上傳 artifact；e2e 失敗時 Electron 正向對照那步也被跳過 | low | patch | 卡住是 e2e 最可能的失敗方式；改成 `if: always()`，正向對照那步加 `if: ${{ !cancelled() }}` |
| B14、E4 | `beforeAll` 總逾時 120 秒比內部等待加起來（最壞 210 秒）短，沙盒失敗時只看到一般逾時 | low | patch | 直接修正：外層逾時涵蓋內層，等待時遇到 `sandbox failed`／`gets no sandbox` 立刻以那行訊息失敗 |
| E5 | 閒置銷毀測試可能撿到釋放之前就記下的 destroyed 行 | low | patch | 直接修正：只認釋放之後的那一行 |
| B2、B3、E2 | 被擋請求的 log 只以 origin 去重，同一 origin 先被非沙盒擋過，沙盒的嘗試就沒有紀錄；`requesterOf` 算兩次，框架中途銷毀時 log 少了 sandbox 標示 | low | patch | 直接修正：決策只算一次並回傳發起者，去重的 key 改成 origin 加發起者類別 |
| B1、E1、VO2 | main 檢查沙盒 CSP 時區分大小寫、沒處理重複的 directive（瀏覽器以第一個為準），比註解宣稱的寬鬆 | low | patch | 只有建置產物被改過才會發生；直接修正：directive 名稱不分大小寫、`sandbox` 只能出現一次且等於 `sandbox allow-scripts`、不能有 `frame-ancestors`，註解寫明實際檢查什麼 |
| B15 | `lists-docs.test.ts` 的反向案例只改文件那一邊 | low | patch | 矩陣要求「只改一邊就失敗」；比對函式改成可傳入清單，補清單多一項、少一項 |
| B13 | `npm run e2e` 會先清掉並覆蓋 `.vite/`，註解沒寫；打包會用到 Electron 的下載快取 | low | patch | 直接修正註解：不能和 `npm start` 同時跑 |
| VG2 | 開發時 dev server 只放行頂層框架的規則，沒有任何自動測試在真 Electron 裡跑過 | medium | defer | 要在 e2e 裡啟動 Forge 的 Vite dev server；壞了會在下次 `npm start` 立刻出現，並有 `request blocked` 的 log |
| B4 | 「made by a sandbox」把所有非頂層框架都算成沙盒 | low | reject | panels 沒有 iframe，overlay 唯一的 iframe 就是沙盒；只影響 log 字樣 |
| B8 | 只要丟錯就算擋下，看不出是哪一層擋的 | low | reject | 釘住錯誤名稱會隨 Electron 與 SES 版本變動；control 探針已證明偵測有效 |
| B10 | dev 模式下 A8 沒有真 Electron 的負向驗證，量測程式不在 repo | low | reject | VG1 的 e2e 會在真 Electron 驗證沙盒的請求被擋；dev 模式那半併入 VG2 的延後項 |
| B12 | e2e job 沒快取 Electron binary；`upload-artifact@v4` 與其他 action 的主版本不同 | low | reject | 只是 CI 時間；版本可在 CI 跑過後再確認 |
| B16、E7 | 驗證紀錄寫錯被改寫的是哪兩行 `expect(`；AC 沒涵蓋 `devtools:` 決定造成的改動 | false | reject | 驗證紀錄由主流程更正；`devtools:` 的改動是核准的決定 |
| E8 | 任何頂層框架對 renderer 網址的 `mainFrame` 請求都算 stage-page | low | reject | 只在開發時；導覽守衛只放行 app 自己的網址 |
| E9 | e2e 的建置步驟用真的 HOME，打包可能讀寫 Electron 下載快取、需要時連網 | low | reject | 決定指的是被測 app 的執行；建置步驟需要 Electron 的 zip，CI 本來就會下載；已在 B13 的註解寫明 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 看 CI 的 e2e job 在 macOS、Windows 的結果與 artifact。
