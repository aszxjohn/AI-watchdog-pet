---
title: 'Story 1.2：沙盒原型驗證（AD-7 閘門）'
type: 'chore'
created: '2026-11-04'
status: 'done'
baseline_commit: 'f03882df41425f6cd2ffe247550f4bc4e3bd6060'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包要跑在「sandbox iframe → classic Worker → SES Compartment → 封網」的沙盒裡（AD-7），但這組做法從沒實測過；Epic 3 的角色包 API 與沙盒都建在它上面，做法不成立就得改設計。

**Approach:** 在 `prototypes/sandbox/` 寫一個獨立、可丟棄的 Electron 原型，在 Electron 45.2.1 實測 Story 1.2 的四項假設，把結果與證據寫成原型報告，並判定閘門是否通過。

## Boundaries & Constraints

**Always:** 原型完全放在 `prototypes/sandbox/`，以 `npm run proto:sandbox` 啟動；照 AD-7 的 CSP 與 Worker 設計實作，不放寬條件來讓測試通過；網路測試要有對照組，證明目標本來連得到、失敗是沙盒造成的；原型視窗不顯示（`show: false`），跑完自動結束；報告每項寫通過或失敗、證據、觀察到的限制。

**Decisions（使用者 2026-11-05 決定）：** 第一輪實測 (b) 因 Electron 45.2.1（V8 15.6）新增的 `Iterator.prototype.join`、`includes` 不在 SES 2.3.0 的允許清單，`lockdown()` 發出移除警告而失敗（SES 主線也尚未收錄）。採用方案 D：Worker bootstrap 在 `lockdown()` 前逐條移除這兩個方法（清單集中在一處、逐條列名），`lockdown()` 仍不得有任何警告；AD-7 已同步修訂。

**Never:** 改動 `src/`、`forge.config.mts` 或任何 Forge 建置設定；連任何對外網路（對照目標只用 `127.0.0.1`）；任一項失敗時自行修改 AD-7 或繞過去；開始 Story 1.3 的內容；執行 git 寫入指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| (a) 建 Worker | sandbox iframe（無 `allow-same-origin`）套 AD-7 CSP，以 blob 建 classic Worker | Worker 啟動並經 MessageChannel 回報 | 建立失敗時記錄錯誤訊息與 CSP 違規，判定 (a) 失敗 |
| (b) SES | Worker 內執行 `lockdown()`，再 `new Compartment().evaluate(...)` | 無錯誤、無警告，evaluate 回傳預期值 | 記錄錯誤或主控台警告，判定 (b) 失敗 |
| (c) 封網 | Worker 內對 `127.0.0.1` 對照伺服器做 fetch、XHR、WebSocket、EventSource | 四種全部失敗；同一目標由 main 行程連線成功 | 任一種成功即判定 (c) 失敗 |
| (d) 貼圖 | overlay（`app://`、CSP 不含 `'unsafe-eval'`）以 PixiJS 載入 `pack://` 圖片 | 貼圖載入成功，記下 `pack` scheme 的最小權限 | 記錄失敗原因與試過的權限組合 |

</frozen-after-approval>

## Code Map

- `package.json` -- 已有 `electron` 45.2.1、`ses` 2.3.0；沒有 PixiJS。`lint` 會掃 `prototypes/`（oxlint 加 `--deny-warnings`），`tsconfig.json` 的 include 含 `prototypes/**/*`（`allowJs` 開、`checkJs` 未開）。
- `node_modules/ses/dist/ses.umd.min.js` -- 含 `lockdown` 與 `Compartment` 的單檔，可直接併進 Worker 的 blob。
- AD-7（架構規約）-- iframe 文件 CSP：`default-src 'none'; script-src 'sha256-<bootstrap 雜湊>' 'unsafe-eval'; worker-src blob:; connect-src 'none'`；Worker bootstrap 先移除 fetch、XHR、WebSocket、EventSource、WebTransport、importScripts、巢狀 Worker、indexedDB、caches，再 `lockdown()`，包放進 `Compartment`；MessageChannel 的 port 直接交給 Worker。
- AD-24 -- `app`、`pack` 以 `protocol.registerSchemesAsPrivileged` 在 ready 前註冊，至少 `standard`、`secure`、不給 `bypassCSP`；視窗 `sandbox`、`contextIsolation` 開，`nodeIntegration*` 關；`webRequest` 只放行 `app://`、`pack://`；overlay CSP `script-src 'self'`，入口先 `import 'pixi.js/unsafe-eval'`。
- Story 1.1 紀錄 -- npm 快取權限問題用 `npm_config_cache` 指到暫存目錄繞過；Demo 資料夾與 `_bmad-output/` 不可被工具掃描。

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- 加 `pixi.js` 8.22.0 到 dependencies、加 `proto:sandbox` 腳本 -- (d) 需要 PixiJS
- [x] `prototypes/sandbox/main.cjs` -- 獨立 Electron 入口：註冊 `app`／`pack` scheme 與處理器（`pack://_stage/sandbox.html` 帶 AD-7 CSP 標頭、`pack://<packId>/<version>/<path>` 提供測試圖片）、`webRequest` 放行清單、AD-24 視窗設定、`127.0.0.1` 對照伺服器、收集結果寫成 JSON 後結束 -- 重現架構的 Electron 層
- [x] `prototypes/sandbox/web/` -- overlay 頁（`app://`，載入 PixiJS 並測 (d)、建 sandbox iframe 與 MessageChannel）、sandbox iframe 文件與 bootstrap、Worker bootstrap 與測試用的包程式 -- 測 (a)～(c)
- [x] `prototypes/sandbox/README.md` -- 寫怎麼跑、每項測什麼 -- 讓之後能重跑
- [x] `_bmad-output/implementation-artifacts/sandbox-prototype-report.md` -- 四項結果、證據、限制、`pack` scheme 最小權限、閘門結論 -- Story 1.2 的交付物

**Acceptance Criteria:**
- Given 原型完成，when 執行 `npm run proto:sandbox`，then 不跳出視窗、自動結束，並產出四項結果。
- Given 四項結果，when 撰寫報告，then 每項寫明通過或失敗與證據；四項都通過才寫「閘門通過」，任一項失敗就寫「閘門未通過」並停在這裡回報。
- Given 原型完成，when 執行 `npm run typecheck` 與 `npm run lint`，then 都通過。

## Implementation Notes

**第一輪（2026-11-04）**

- **閘門未通過**：(a)(c)(d) 通過，(b) 失敗。`lockdown()` 不丟錯、`Compartment.evaluate` 回傳 6，但 SES 2.3.0 在 Electron 45.2.1（V8 15.6）`lockdown()` 時輸出「SES Removing unpermitted intrinsics」，移除 `%IteratorPrototype%.join`、`.includes`。在 Electron 的 Node 模式直接 `lockdown()` 也重現，與沙盒做法無關。依 Boundaries 停在這裡，未改 AD-7、未繞過；處理選項寫在報告「需要你決定」一節。
- `pack` 最小權限：`standard`、`secure`、`corsEnabled`，overlay 需 `Assets.setPreferences({ preferCreateImageBitmap: false })`；PixiJS 預設載入方式在 overlay CSP `script-src 'self'` 下會卡住不結束（blob Worker 被擋）。回應不需要 ACAO 標頭。
- Code Map 以外新增的檔案：`prototypes/sandbox/preload.cjs`（overlay 把結果交回 main 的最小 API）、`prototypes/sandbox/vite.config.mts`（打包 overlay 頁與 PixiJS，對應 AD-24 的「`app://` 載入 Vite 輸出」）。
- `main.cjs` 兩種角色：`node` 執行時是協調者，依序開 6 次隱藏 Electron（4 種 `pack` 權限組合，加上能載入貼圖的 2 組再各跑一次不帶 ACAO），彙整結果；`electron` 執行時是原型入口。`registerSchemesAsPrivileged` 每個行程只能呼叫一次，比較權限組合只能分開行程。
- 打包輸出與結果放在 `.vite/proto-sandbox/`（不放 `prototypes/sandbox/out/`）：實測 `oxfmt --check prototypes` 不套用 `.gitignore`，放在 `prototypes/` 底下會讓 `npm run lint` 失敗；`.vite/` 已被 git 忽略、也不在 lint 範圍。缺點是 `npm start` 會清掉 `.vite/`，結果檔要重跑才有。
- 原型專用觀測工具（不屬於 AD-7 設計）：Worker prelude 記錄 console、iframe 診斷 port、不做移除的診斷 Worker（單獨驗證 CSP 層與 CSP 繼承）、overlay 對 `127.0.0.1` 的請求（驗證 `webRequest` 層）。
- 驗證：`npm run proto:sandbox` 不開視窗、約 40 秒自動結束，結束碼 1（閘門未通過）；`npm run typecheck`、`npm run lint` 通過；`git status --porcelain src forge.config.mts` 無輸出。只在 macOS arm64 實測，Windows 未測。
- 執行中的 git 寫入指令被 hook 擋下一次（試著用 `git checkout` 還原測試用的 `.gitignore` 修改），已改用直接編輯還原，`.gitignore` 最終沒有改動。

**第二輪（2026-11-05，依 Decisions 採方案 D）**

- **閘門通過**：(a)(b)(c)(d) 四項全部通過，`npm run proto:sandbox` 結束碼 0。報告保留第一輪 (b) 的失敗紀錄與原因，並加上第二輪結果、方案 D 的做法與升級限制。
- 新增 `prototypes/sandbox/web/sandbox/ses-unknown-intrinsics.js`：SES 尚未認得的 intrinsics 清單唯一的一份，逐條列名 `Iterator.prototype.join`、`Iterator.prototype.includes`，加上刪除函式（擁有者或屬性不存在就回報 `absent` 並略過，不丟錯）。它與其他 Worker 程式一起內嵌進沙盒 bootstrap，算進 CSP 雜湊。
- `worker-bootstrap.js` 的順序改為：移除網路等 API → 呼叫上述函式逐條刪除 → `lockdown()`（不帶任何選項，沒有 `reporting: 'none'`）→ Compartment。Worker 的 console 照樣全程記錄，有任何輸出 (b) 仍失敗。`main.cjs` 的 (b) 判定加上：清單項目 `not-deletable` 算失敗，`absent` 記為 note。
- 新增 `prototypes/sandbox/ses-node-check.cjs`：協調者在 Electron Node 模式（`ELECTRON_RUN_AS_NODE=1`，V8 15.6.75）跑它兩次，讀同一份清單檔。不刪清單時 `lockdown()` 印出與第一輪相同的 3 行；先刪清單時沒有任何 stdout／stderr 輸出。後者也列為 (b) 的通過條件。
- 第二輪 6 次執行中，兩條清單項目在 Worker 內都是 `removed`；Worker 的 console 輸出 0 行；main 行程收到的 `console-message` 裡沒有 SES 訊息。(a)(c)(d) 的結果與第一輪相同。
- `README.md` 補上清單檔、Node 模式檢查與「升級 Electron 時」一節。
- 驗證：`npm run typecheck`、`npm run lint` 通過。本輪依指示沒有執行任何 git 指令，`src/`、`forge.config.mts` 沒有編輯。

**第二輪審查修補（2026-11-05）**

- (b) 判定：Worker 的 console 紀錄改取 `ses`、`pack-evaluated`、`done` 三則訊息的聯集（prelude 給每筆紀錄加上 `seq`，依 `seq` 合併）；`done` 沒送到或沙盒逾時都判 (b) 失敗。Node 模式對照組（不刪清單）若沒有輸出，(b) 加註「清單作用無法證實」。
- (c) 判定：診斷 Worker 的四種 API 都必須是 `blocked`，並各有一筆 `connect-src` 違規；`cspInheritance` 的 `importScriptsBlob`、`fetchBlob` 必須是 `blocked`；`webRequest` 紀錄裡不得出現 `from=probe-*`。對照伺服器上 main 的 4 個標記（main-fetch、main-xhr、main-websocket、main-eventsource）各須恰好出現一次，其他命中一律算 renderer 洩漏。
- 結束碼：新增共用的 `runProcess`，處理子行程的 `error` 事件，Node 模式檢查也套用與 Electron 子行程相同的逾時。載不到 `electron`、協調者未捕捉的錯誤、任一子行程起不來／逾時／沒留下結果，都以結束碼 2 結束。
- 不帶 ACAO 的重跑如果本身出錯或逾時，摘要印 `unknown`。
- 修正：`toInlineScriptJson` 的 regex 改用 `￿` 跳脫寫法（原本是原始字元）；`main.cjs` 檔頭與 README 改寫角色判斷的說法（依 `require('electron')` 的型別判斷，`--proto-role=child` 只是標記）。`ses-node-check.cjs` 把清單的讀取／刪除與 `lockdown()` 分開 try、分開回報。
- README 補上 `%XxxPrototype%` 怎麼對應到 `globalThis` 路徑，以及隱藏 intrinsic（例如 `%IteratorHelperPrototype%`）走不到時要回報使用者、不得自行繞過。
- 報告新增「處理選項與決定」一節（A～D 各附理由），說明 D 的安全結果與 SES 自己刪除相同、保留零警告是為了偵測下一批；並註明 Node 模式載入 `dist/ses.cjs`、Worker 載入 `dist/ses.umd.min.js`；通過只限 macOS arm64，Windows 由 Story 3.5 在 CI 驗證；cookie／localStorage 與 main 收到的 console 則數改標為觀察；執行次數改為正確描述。
- 修完重跑 `npm run proto:sandbox`：四項通過、閘門通過、結束碼 0；結果另存為 `_bmad-output/implementation-artifacts/sandbox-prototype-results-2026-11-05.json`，報告引用此檔。依指示只跑涵蓋本次修改的檢查（`proto:sandbox`、`oxlint`／`oxfmt --check prototypes`），沒有執行 git 指令。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 「lockdown() 零警告」升級 Electron 後只靠手動重跑原型，正式版清單沒有自動檢查 | medium | patch | 預檢後送來的缺口：AD-25 與 Story 3.5 的沙盒安全測試只要求 API 全部失敗，沒有檢查 lockdown 輸出、清單 removed、包有正常執行；補進 AD-25、AD-7、Story 3.5 AC。 |
| VG2 verdictB 在 done 沒送到時改用不含 lockdown 期間的紀錄 | medium | patch | `main.cjs` 的 fallback 取 `evaluated.consoleRecords`，該紀錄從 `consoleRecordsBeforePack` 才開始；`sandbox.timedOut` 也沒被判定，逾時時 (b) 可能誤判通過。 |
| B1 (b) 判定可能誤判通過 | medium | patch | 與 VG2 同一根因。 |
| B2 (c) 沒有逐層驗證：timeout 只記 note、violations 與 cspInheritance 沒檢查 | medium | patch | 升級後若 blob Worker 不再繼承 CSP、改由 webRequest 擋下，閘門仍會通過；而 AD-7 正是靠重跑原型發現這類退化。 |
| B3 Node 模式對照組（不刪清單）沒有參與判定 | low | patch | 若對照組也沒輸出，刪清單後的沉默就證明不了清單有作用；改成寫 note。另在報告註明 Node 模式載的是 `ses.cjs`、Worker 是 `ses.umd.min.js`。 |
| B4 清單格式寫不出隱藏 intrinsics，README 更新步驟不完整 | low | patch | SES 警告用 `%XxxPrototype%` 名稱，只有部分能從 globalThis 走到；在 README 寫明名稱對應方式與隱藏 intrinsic 的限制。 |
| B5 升級防護沒有長期有效的檢查 | medium | patch | 與 VG1 同一根因。 |
| B6 原型其他結論沒寫回架構 | medium | patch | `pack` 需 `corsEnabled`、PixiJS 須 `preferCreateImageBitmap: false` 否則卡住、API 要沿原型鏈移除、Worker 非 secure context 沒有 `crypto.subtle`；不寫回 AD-24／AD-7／AD-16，Story 1.6、3.x 會重新踩雷。 |
| B7 文件到處列出清單內容，與「只在一處」矛盾 | low | patch | 清單一改，架構、epics 就會不同步；架構與 epics 改為引用模組，具體名稱只留在清單檔與報告。 |
| B8 sprint-status 與 spec 狀態不一致 | false | reject | step-05 會把 story 設為 `review` 並更新 `last_updated`。 |
| B9 frozen 區改了但 Spec Change Log 空白、方案 A～C 無處可查 | low | patch | Spec Change Log 只記審查 loopback；方案比較改寫進原型報告的「處理選項與決定」一節（修 spec 本身的部分依規則駁回）。 |
| B10 結束碼約定不可靠：spawn 沒接 error、Node 檢查沒逾時 | low | patch | 找不到 Electron 或子行程卡住時，結束碼 1 會被讀成「閘門未通過」，或協調者永遠等下去；補 error 處理與逾時，原型自身錯誤一律結束碼 2。 |
| B11 閘門原始證據沒有保存 | medium | patch | `results.json` 在被忽略的 `.vite/`，`npm start` 會清掉；把這次結果的快照與報告放在一起提交。 |
| B12 報告列的部分證據不在判定裡 | low | patch | cookie／localStorage、main 收到的 console 則數只是觀察；報告標成「觀察」而不是判定依據。 |
| B13 方案 D 的實際效果沒講清楚、兩句說法沒有根據 | low | patch | 報告補上：SES 本來就會移除這兩個方法，D 的安全結果相同、差別只在不再警告；「主線尚未收錄」附上檢查日期與檔案；刪掉「包程式用不到」改成實際影響。Story 3.1 AC 補「作者文件列出不可用的 intrinsics」。 |
| B14 「零警告」只在 lockdown() 用預設選項時成立 | medium | patch | 正式版若設 `errorTaming` 等選項，輸出可能不同；AD-7 固定為不帶選項，改選項要重跑原型。 |
| B15 只驗 macOS 卻沒有排 Windows 後續工作 | medium | patch | 報告寫明通過只限 macOS arm64；AD-25 的沙盒安全測試在 CI 的 macOS 與 Windows 都要跑，Story 3.5 AC 補上明確要求。 |
| B16 regex 內含原始 U+FFFF 字元 | low | patch | 編輯器或格式化工具可能弄壞該字元，進而影響內嵌 script 的 ASCII 檢查與雜湊；改成 `\uffff` 跳脫。 |
| B17 diff 缺 package-lock、可丟棄原型把 PixiJS 加進 dependencies | false | reject | lockfile 存在且已更新；PixiJS 8.22.0 本來就在架構 Stack 表，Story 1.6 的 overlay 會用到。 |
| B18 報告寫「6 種權限組合」不精確 | low | patch | 實際是 4 種權限組合加不帶 ACAO 的重跑；修正用詞。 |
| B19 `--proto-role=child` 沒被讀取 | low | patch | 角色其實由 `require('electron')` 的型別決定；修正檔頭註解與 README，避免誤導。 |
| B20 typecheck 對原型的 JS 沒有實際檢查 | low | reject | 修正方式是改 spec 的驗收說明，依規則駁回；`allowJs` 開、`checkJs` 關是 Story 1.1 的既有設定。 |
| E1 Node 模式檢查子行程沒有逾時 | low | patch | 與 B10 同一根因。 |
| E2 spawn 沒接 error 事件 | low | patch | 與 B10 同一根因。 |
| E3 `require('electron')` 失敗時直接崩潰 | low | patch | 與 B10 同一根因。 |
| E4 不帶 ACAO 的重跑因原型錯誤失敗時摘要會誤導 | low | patch | 應顯示 unknown 而不是「(none)」或「全部需要」。 |
| E5 done 沒送到時 (b) 漏掉 lockdown 期間的紀錄 | medium | patch | 與 VG2 同一根因。 |
| E6 overlay 的 `app.init` 沒有逾時 | low | reject | 卡住時整輪被 `CHILD_TIMEOUT_MS` 終止並判失敗，是會被看見的失敗，不會誤判通過。 |
| E7 控制伺服器靠 query 參數判斷請求來源 | medium | patch | renderer 發出的請求若標成 `from=main-*` 會被當成對照流量；改成 main 的 4 筆必須各恰好一次，其餘一律算 renderer 洩漏。 |
| E8 probe 結果為 timeout 時 (c) 仍通過 | medium | patch | 與 B2 同一根因。 |
| E9 probe 被 webRequest 而非 CSP 擋下時沒被發現 | medium | patch | 與 B2 同一根因。 |
| E10 Node 模式對照組沒有斷言 | low | patch | 與 B3 同一根因。 |
| E11 ses-node-check 把清單刪除失敗報成 lockdown 失敗 | low | patch | 刪除與 lockdown 分開 try，診斷才不會指錯方向。 |
| E12 Node 模式子行程卡住時永遠不結束 | low | patch | 與 B10 同一根因。 |

## Verification

**Commands:**
- `npm run proto:sandbox` -- expected: 不顯示視窗、自動結束，輸出四項結果
- `npm run typecheck` -- expected: 無錯誤
- `npm run lint` -- expected: 無錯誤
- `git status --porcelain src forge.config.mts` -- expected: 沒有任何改動
