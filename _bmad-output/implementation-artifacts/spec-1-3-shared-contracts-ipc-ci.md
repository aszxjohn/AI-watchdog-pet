---
title: 'Story 1.3：共用契約、IPC 骨架與 CI'
type: 'feature'
created: '2026-11-05'
status: 'done'
baseline_commit: 'e831ccf21e1f8d6fa36cc9f86af40dccfb069287'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 之後每個模組都要跨 main／preload／renderer 傳資料，但目前沒有共用的 schema、IPC 規則、測試框架與 CI，各 story 會各寫一套，依賴方向也沒有任何東西在把關。

**Approach:** 建立 `src/shared` 的共用契約與常數、main 唯一的 IPC 註冊函式、兩支最小 preload，並用一條示範通道 `app:get-version` 走通整條路徑；加上 Vitest、dependency-cruiser 與 macOS＋Windows 的 GitHub Actions CI。

## Boundaries & Constraints

**Always:** 跨邊界資料只在 `src/shared` 定義一次 zod schema、收到就嚴格驗證；`src/shared` 最先載入的模組設 `z.config({ jitless: true })`；IPC 只經同一個註冊函式，通道名 `<domain>:<action>`，回傳 `{ ok: true, data }`／`{ ok: false, error }`，handler 的例外不得丟到 renderer；`senderFrame` 為 null、不是頂層框架、或來源不在允許清單時一律拒絕；8 狀態碼與中文顯示名只定義一次；preload 不依賴 Node polyfill；新增套件版本照架構 Stack 表。

**Never:** 實作設定、StageView、運行紀錄、選單列、畫布（Story 1.4～1.6）；改 `app://` 載入方式或視窗安全設定（Story 1.5）；動 `prototypes/`；連任何對外網路；執行 git 寫入指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 正常呼叫 | 允許來源的頂層框架呼叫 `app:get-version` | `{ ok: true, data: <版本字串> }` | — |
| 框架為 null | `event.senderFrame` 為 null | `{ ok: false, error }`，handler 不執行 | 記 warning |
| 非頂層框架 | 來自 iframe 的呼叫 | 拒絕，handler 不執行 | 同上 |
| 來源不允許 | 打包後的 `file://`、或非 dev server 的 http 來源 | 拒絕 | 同上 |
| 輸入不符 schema | 參數型別錯 | `{ ok: false, error }` | 不丟例外 |
| handler 丟例外 | handler 內部錯誤 | `{ ok: false, error }` | 不洩漏堆疊到 renderer |
| 通道名不合法 | 註冊 `getVersion` 之類 | 註冊時直接丟錯（開發期錯誤） | — |

</frozen-after-approval>

## Code Map

- `src/main/main.ts` -- 模板的視窗建立；preload 路徑 `panels.cjs`。在 Story 1.5 才會改用 `app://`，所以打包版目前仍是 `file://`。
- `src/preload/panels.ts` -- 目前只有註解。`src/panels/renderer.ts` -- 只 import CSS 與 console.log。
- `forge.config.mts` -- build 兩個入口（main、preload/panels）；renderer `main_window`。
- `package.json` -- `lint` 逐一列出根目錄 4 個 `.mts`（oxlint 不展開 glob，Windows cmd 也不展開）；`typecheck` 是 `tsc --noEmit`。
- `tsconfig.json` -- 單一專案，include `src`、`test`、`prototypes`、`*.mts`。
- `deferred-work.md` 給本 story 的三項：preload 載入沒有任何斷言、oxlint 根目錄設定檔清單要手動維護、是否拆分各 process 的 tsconfig。
- `node_modules/@types/node` 已存在（electron 帶入）；electron 的型別會引用 Node 型別，所以 import `electron` 的 preload 一定看得到 Node 全域。

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- 加 `zod` 4.6.7（dependencies）、`vitest` 5.1.0、`dependency-cruiser` 18.7.2（devDependencies）；腳本 `test`、`depcruise`；`lint` 改呼叫跨平台腳本 -- 架構 Stack
- [x] `scripts/lint.mjs` -- 用 Node 收集 `src`、`test`、`prototypes`、`scripts` 與根目錄所有 `*.mts`／`*.cjs` 設定檔，再呼叫 oxlint（`--deny-warnings`）與 oxfmt；macOS 與 Windows 都能跑 -- 解決根目錄設定檔要手動列的問題
- [x] `tsconfig.json` 拆成 base＋`tsconfig.node.json`（main、preload、shared、scripts、test、根目錄設定；無 DOM）與 `tsconfig.web.json`（panels、overlay、sandbox、shared；有 DOM、`types: []` 無 Node）；`typecheck` 兩個都跑 -- 讓 renderer 用到 Node 全域、或 shared 用到 DOM／Node 時型別檢查失敗
- [x] `.oxlintrc.json` -- 對 `src/preload/**` 禁用 `Buffer`、`process`、`setImmediate`、`require`、`__dirname`、`__filename` -- preload 的型別擋不住 Node 全域，改由 lint 擋
- [x] `src/shared/zod-setup.ts`、`constants.ts`、`states.ts`、`ipc.ts`、`preload-api.ts` -- jitless 設定、運行常數、8 狀態碼與中文顯示名、IPC 結果型別與通道名規則、`window.awp` 的型別 -- 契約唯一來源
- [x] `src/main/ipc/register.ts` -- 唯一註冊函式：檢查通道名、`senderFrame`（非 null、頂層、來源在允許清單：`app://`，以及 `!app.isPackaged` 時的 Vite dev server 來源）、輸入 schema，包裝回傳並攔住例外 -- AD-24 IPC 規則
- [x] `src/main/main.ts` -- 啟動時確認 preload 產物存在（不存在就丟出清楚的錯誤）、註冊 `app:get-version` -- 補上 preload 載入的斷言
- [x] `src/preload/panels.ts`、`src/preload/overlay.ts`、`forge.config.mts` -- panels 經 `contextBridge` 暴露 `window.awp.app.getVersion()`；overlay 暴露空的 `window.awp`；forge 加 overlay preload 入口 -- 各自最小 API
- [x] `src/panels/renderer.ts` -- 在頁面顯示 `window.awp.app.getVersion()` 的結果；`window.awp` 不存在時顯示錯誤並 console.error -- preload 沒載入時看得出來
- [x] `vitest.config.mts`、`test/shared/*.test.ts`、`test/main/ipc-register.test.ts` -- 每個 schema 的往返與拒絕測試、狀態對照完整性、註冊函式對 I/O 矩陣每一列的測試（mock `electron`） -- AC
- [x] `.dependency-cruiser.cjs` -- AD-2 依賴方向（shared 不依賴任何層；main／preload／overlay／panels／sandbox 只往 shared；overlay、panels 不得 import `src/main`；`src/` 不得 import `prototypes/`、`test/`）＋禁止 `http`、`https`、`http2`、`net`、`tls`、`dgram` -- AC、NFR5
- [x] `.github/workflows/ci.yml` -- macOS 與 Windows 矩陣，`node-version-file: .nvmrc`、`npm ci`（`ELECTRON_SKIP_BINARY_DOWNLOAD=1`），依序跑 typecheck、lint、test、depcruise；actions 用查證過的現行主版本 -- AC

**Acceptance Criteria:**
- Given 完成實作，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過，且 I/O 矩陣每一列都有對應測試並通過。
- Given 故意在 `src/panels` import `src/main`、在 `src/shared` import `node:http`、在 `src/panels` 用 `process.env`，when 跑 depcruise 與 typecheck，then 都會失敗（驗證完還原）。
- Given 執行 `npm start`，when 視窗開出，then 頁面顯示 app 版本，確認後立刻關閉。

## Implementation Notes

- 四項檢查實際通過：`npm run typecheck`（node、web 兩份 tsconfig）、`npm run lint`、`npm test`（4 個檔、108 個測試，I/O 矩陣 7 列都有對應測試）、`npm run depcruise`。AC2 的違規逐一驗證會失敗後還原：panels import `src/main`（含 type-only）→ depcruise；shared import `node:http` → depcruise＋typecheck；panels 用 `process.env`、shared 用 `document` → typecheck。
- `npm start` 頁面顯示「版本 1.0.0」，`window.awp.app.getVersion()` 回 `{ ok: true, data: '1.0.0' }`；不經 preload 開 dev server 時頁面顯示 preload 未載入的錯誤。第一次啟動曾出現沒有 renderer 的情況，之後 3 次正常，原因未查明。
- spec 以外的決定：新增 `.gitattributes`（`* text=auto eol=lf`，避免 Windows runner 的 CRLF 讓 oxfmt 失敗）；dependency-cruiser 另加「shared／overlay／panels／sandbox 不得 import Node 內建模組與 `electron`」「不得有解析不到的 import」並開 `tsPreCompilationDeps`；oxlint 禁止 `src/**` 直接 import zod（只有 `zod-setup.ts` 例外，確保 jitless 先設定）；`tsconfig.node.json` 保留 `prototypes/**`；`*.css` 宣告搬到 `src/panels/env.d.ts`；lint 收集根目錄所有 JS／TS 設定檔；dev server 來源暫放 `register.ts`，Story 1.5 搬到 `main/windows`。
- 打包版目前以 `file://` 載入，`app:get-version` 會被拒絕而顯示錯誤，Story 1.5 改用 `app://` 後恢復；打包版未實測。CI 未執行，要推上 GitHub 後確認。
- 實作期間連了 npm registry、GitHub（查 actions 版本：checkout v7.0.1、setup-node v7.1.0）與 nodejs.org；這是安裝與查證所需，程式本身不連網。

- 審查修補（第 1 輪，未觸發 loopback）：`@types/node` 鎖 24.19.2（原被提升的 26.6.6 已消失）；depcruise 加 preload 只准依賴 `electron` 與 `src/shared`、overlay 不得引入 React、網路模組清單補 `dns`、`undici`；oxlint 限定 `ipcMain` 只在 `register.ts`、`ipcRenderer` 只在 `invoke.ts`、`src/**` 禁 electron `net` 與全域 `fetch`／`WebSocket`／`XMLHttpRequest`／`EventSource`、preload 禁用全域補齊（成員存取寫法擋不到，檔內註明）；`register.ts` 攔下 schema 例外並加 `IPC_HANDLER_TIMEOUT_MS` 逾時；preload 不存在時顯示錯誤對話框後 `app.exit(1)`（只做靜態檢查）；lint 腳本改由 `bin` 欄位解析執行檔；CI 加 `timeout-minutes` 與 `concurrency`；新增 preload 端測試與每條防護規則的反向測試。
- 修補後重跑：typecheck、lint、`npm test`（7 個檔、172 個測試）、depcruise 全部通過；修補未改變正常路徑的行為（由 preload 到 main 的 loopback 測試涵蓋），`npm start` 未重跑。
- 本 story 解決了 Story 1.1 延後的三項：preload 載入斷言（啟動檢查＋preload 端測試）、oxlint 根目錄設定檔清單（`scripts/lint.mjs` 自動收集）、tsconfig 拆分（node／web 兩份）。新的延後項目已追加到 `deferred-work.md`。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 preload 的 invoke 與 window.awp 沒有自動測試 | medium | patch | 預檢後送來的缺口：`test/` 沒有任何檔案經過 `src/preload/invoke.ts`；改壞參數展開或拿掉 try/catch，CI 全綠。 |
| VG2 lint 與依賴規則沒有可重跑的反向測試 | medium | patch | 預檢後送來的缺口：CI 只證明目前沒違規；override 的 glob 寫錯或被刪，preload 用 `process` 也不會被發現。 |
| VG3 preload 檔名的啟動檢查不在 CI 路徑上 | low | defer | 一啟動就報錯，第一次手動執行就會發現；Story 1.5 重寫視窗並新增 overlay 視窗時，集中 bundle 名稱並加一致性測試。 |
| B1 被提升的 @types/node 是 26 版，執行環境是 Node 24 | medium | patch | `node_modules/@types/node` 由 vite／vitest 帶進 26.6.6；用到 Node 25／26 才有的 API 時 typecheck 會過、執行才壞；直接鎖定 24.x。 |
| B2 preload 能 import 什麼沒有檢查 | medium | patch | `web-side-no-node-builtins` 沒涵蓋 preload；Forge 把 Node 內建模組當 external，`import 'node:fs'` 會通過所有檢查、在沙盒 preload 執行時才失敗。 |
| B3 「只經同一個註冊函式」沒有強制 | medium | patch | 在 register.ts／invoke.ts 以外直接用 `ipcMain.handle`、`ipcRenderer` 不會報錯，可繞過 senderFrame 與 schema 檢查。 |
| B4 不連網的靜態檢查漏了全域 fetch／WebSocket 與 electron net | medium | patch | 只擋 Node 網路模組；main 與 renderer 都能直接用 `fetch`、`WebSocket`，main 還有 `net.fetch`。 |
| B5 缺少「overlay 不引入 React」的依賴規則 | low | patch | epic 情境列為 CI 強制的依賴方向之一；加一條 depcruise 規則即可。 |
| B6 IPC 只有 invoke，沒有 main 推送的契約 | medium | defer | Story 1.3 的 AC 只要求 invoke 骨架；推送的唯一用途是 StageView，由 Story 1.4 以同一套共用 schema 建立。 |
| B7 允許清單只看來源、不分通道；dev server 只認 main_window | low | defer | renderer 只能經 preload 暴露的 API 呼叫，preload 就是通道邊界；overlay 視窗與其 dev server 由 Story 1.5／1.6 建立，屆時一併加上依視窗限制通道。 |
| B8 deferred-work.md 沒有更新 | low | patch | 本 story 解掉的三項沒有註記，新的延後事項也沒記；依格式追加新條目，解掉的寫進 Implementation Notes。 |
| B9 spec 與 sprint-status 狀態不一致 | false | reject | step-05 會把 story 設為 `review`。 |
| B10 epic-1-context 把剛裝的套件列成「尚未安裝」 | low | patch | 情境檔標明可直接編輯；把 zod、Vitest、dependency-cruiser 移出「尚未安裝」清單。 |
| B11 preload 那一半沒有測試 | medium | patch | 與 VG1 同一根因。 |
| B12 新加的防護規則沒有自動化反向測試 | medium | patch | 與 VG2 同一根因。 |
| B13 preload 禁用的全域不完整 | low | patch | 缺 `clearImmediate`、`global`、`module`、`exports`；`globalThis.process` 這類成員寫法 no-restricted-globals 擋不到，列為已知限制。 |
| B14 CI 沒有 build 步驟 | medium | defer | 需要 Electron 二進位與 Forge 打包；Story 2.3 建立 Playwright `_electron` 端到端測試時在 CI 一併建置，與 VG3 合併處理。 |
| B15a CI 沒有 timeout 與 concurrency | low | patch | 卡住的 job 會一直佔用 runner；加 `timeout-minutes` 與同分支取消舊執行。 |
| B15b actions 沒有釘 commit SHA | low | reject | 沒有自動更新機制時釘 SHA 會讓 actions 長期停在舊版；目前已設 `permissions: contents: read` 與 `persist-credentials: false`。 |
| B16 parseIpcResult 每次重建 schema | low | reject | 目前只有一條通道；高頻的 StageView 走推送、不走 invoke，實際用不到快取。 |
| B17 lint.mjs 寫死執行檔路徑 | low | patch | 改從套件 `package.json` 的 `bin` 欄位解析，套件改 bin 位置或沒被提升時不會壞。 |
| B18a preload 用不含 DOM 的 lib 檢查 | low | defer | preload 目前只用 contextBridge 與 ipcRenderer；要用 DOM API 時（Story 1.5 起）再為 preload 開獨立 tsconfig。 |
| B18b .dependency-cruiser.cjs 的 JSDoc 型別沒被檢查 | low | reject | 設定檔，沒有實際影響。 |
| E1 schema 在 safeParse 內丟例外時錯誤會傳到 renderer | low | patch | refine／transform 丟錯時 `safeParse` 會直接拋出；包 try/catch 回 `invalid-input`／`invalid-output`。 |
| E2 handler 永遠不結束時 renderer 一直等 | low | patch | main 端以共用常數的逾時包住 handler，逾時回 `handler-failed`。 |
| E3 preload 不存在時丟錯後行程留在背景 | low | patch | 以 `dialog.showErrorBox` 顯示原因後 `app.exit(1)`。 |
| E4 file:// 來源一律被拒，打包版永遠顯示錯誤 | false | reject | 這是已記錄的暫時行為：Story 1.5 改用 `app://` 後恢復；架構只允許 `app://`。 |
| E5 preload import Node 內建模組不會被擋 | medium | patch | 與 B2 同一根因。 |
| E6 preload 可用 clearImmediate、global 或 globalThis 成員 | low | patch | 與 B13 同一根因。 |
| E7 漏擋 electron net、全域 fetch／WebSocket、dns、undici | medium | patch | 與 B4 同一根因；網路模組清單補 `dns`、`undici`。 |

## Verification

**Commands:**
- `npm run typecheck` -- expected: 兩個 tsconfig 都無錯誤
- `npm run lint` -- expected: 無錯誤
- `npm test` -- expected: 全部通過
- `npm run depcruise` -- expected: 無違規
- `npm start` -- expected: 頁面顯示 app 版本，確認後立刻關閉

**Manual checks (if no CLI):**
- CI 只能在推上 GitHub 後確認：使用者推送後，看 Actions 頁面 macOS 與 Windows 兩個 job 都通過。
