# 沙盒原型報告（Story 1.2，AD-7 閘門）

- 實測日期：第一輪 2026-11-04、第二輪 2026-11-05
- 環境：macOS（Darwin 25.6.0）arm64；Electron 45.2.1（Chrome 156.0.8078.75、V8 15.6.75、內建 Node 24.22.1）；SES 2.3.0；PixiJS 8.22.0
- 原型：`prototypes/sandbox/`，以 `npm run proto:sandbox` 重跑（約 40 秒，不開視窗，跑完自動結束；結束碼 0 閘門通過、1 未通過、2 原型本身出錯）
- 閘門證據：`_bmad-output/implementation-artifacts/sandbox-prototype-results-2026-11-05.json`（第二輪最終執行的完整原始資料，從 `.vite/proto-sandbox/results.json` 複製而來；`.vite/` 會被 `npm start` 清掉，所以另存一份）

## 結論：閘門通過（第二輪）

| 項目 | 第一輪（2026-11-04） | 第二輪（2026-11-05，方案 D） |
| --- | --- | --- |
| (a) sandbox iframe 內以 blob 建 classic Worker | 通過 | 通過 |
| (b) Worker 內 `lockdown()` 無錯誤、無警告，`Compartment.evaluate` 可執行 | **失敗** | 通過 |
| (c) Worker 內 fetch、XHR、WebSocket、EventSource 全被擋 | 通過 | 通過 |
| (d) overlay 以 PixiJS 從 `pack://` 載入貼圖，確定 `pack` 最小權限 | 通過 | 通過 |

第二輪四項全部通過，**閘門通過**。這個結果只限 macOS arm64；Windows 由 Story 3.5 的沙盒安全測試在 CI 驗證。依 epic 1 的依賴規則，Story 3.1（角色包 API 契約）與 3.5 起的沙盒相關 story 可以照現行 AD-7 開工。

`pack` scheme 最小權限：**`standard`、`secure`、`corsEnabled`**，overlay 要搭配 `Assets.setPreferences({ preferCreateImageBitmap: false })`（細節見 (d)）。

**方案 D 帶來的限制**：SES 尚未認得的 intrinsics 清單（`prototypes/sandbox/web/sandbox/ses-unknown-intrinsics.js`，正式版在 `src/sandbox` 一處）只對 Electron 45.2.1（V8 15.6）＋ SES 2.3.0 驗證過。**每次升級 Electron（或 SES）都要重跑原型**；`lockdown()` 一出現新的移除警告，(b) 就會失敗，要把新名稱加進清單並請使用者確認。

## 第一輪 (b) 失敗紀錄（2026-11-04）

第一輪 `lockdown()` 沒有丟錯，`Compartment.evaluate` 回傳預期值 6，但 SES 在 `lockdown()` 期間輸出了警告，依 spec 判定 (b) 失敗、閘門未通過：

```text
SES Removing unpermitted intrinsics
  Removing intrinsics.%IteratorPrototype%.join
  Removing intrinsics.%IteratorPrototype%.includes
```

**原因**：Electron 45 的 V8 15.6 新增了 `Iterator.prototype.join` 與 `Iterator.prototype.includes`，SES 2.3.0 的允許清單不認得這兩個方法，就自己把它們刪掉並發出警告。這與沙盒做法無關：在 Electron 的 Node 模式下直接 `require('ses'); lockdown()`（不經 iframe、Worker）也印出同樣三行；本機 Node 24.18.0（V8 13.6，沒有這兩個方法）則沒有任何輸出。

當時停在這裡回報，沒有修改 AD-7，也沒有繞過或隱藏警告。

## 處理選項與決定（2026-11-05）

| 選項 | 做法 | 結果 |
| --- | --- | --- |
| A | 改用新版 SES | 不可行：2.3.0 已是最新版；2026-11-05 檢查 endo 主線 `packages/ses/src/permits.js`，`%IteratorPrototype%` 底下也還沒有 `join`、`includes` |
| B | 放寬 (b)，允許「移除未知 intrinsics」這類警告 | 不採用：警告一旦可以放行，下一批新的未知 intrinsics 也會靜悄悄通過 |
| C | `lockdown({ reporting: 'none' })` 關掉回報 | 不採用：所有 SES 警告與錯誤都會被藏起來，包括真正的問題 |
| D | Worker bootstrap 在 `lockdown()` 前逐條刪除已知的未知 intrinsics，`lockdown()` 仍要求零警告 | **採用**：只處理已確認的兩個名稱，其他新出現的仍會讓 (b) 失敗 |

使用者選擇方案 D（spec 的 Decisions），AD-7 第 3 點已同步修訂。

**安全上的意義**：SES 本來就會在 `lockdown()` 時移除這兩個方法（第一輪的警告就是在說它刪了）。方案 D 由 bootstrap 先刪，最後的結果與 SES 自己刪完全相同，差別只在 SES 不再發出警告。保留「零警告」這個條件，是為了在升級 Electron／SES 後偵測到下一批未知 intrinsics。

## 方案 D 的做法（第二輪）

- 清單只放在一處、逐條列名：`web/sandbox/ses-unknown-intrinsics.js` 列出 `Iterator.prototype.join`、`Iterator.prototype.includes`，並提供刪除函式；某條的擁有者或屬性不存在就略過（回報 `absent`），不丟錯。
- Worker bootstrap 的順序變成：移除網路／儲存／Worker API → **逐條刪除清單裡的 intrinsics** → `lockdown()` → `Compartment`。清單檔跟其他 Worker 程式一起內嵌在沙盒 bootstrap 裡，算進 CSP 雜湊。
- 沒有隱藏 SES 的輸出：`lockdown()` 不帶任何選項（沒有 `reporting: 'none'`），Worker 的 console 照樣全程記錄；只要有任何一行輸出，(b) 仍判定失敗。
- 補充證據：協調者先在 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`，與 Worker 同一個 V8，不經 iframe／Worker）跑 `prototypes/sandbox/ses-node-check.cjs` 兩次，讀同一份清單檔。這個腳本本身不輸出任何東西，所以 stdout／stderr 上的任何一個位元組都算 SES 的輸出。注意載入的 SES 檔不同：Node 模式以 `require('ses')` 載入 `dist/ses.cjs`，Worker 內嵌的是 `dist/ses.umd.min.js`（同為 SES 2.3.0 的建置產物）。清單的讀取／刪除與 `lockdown()` 分開回報：

| Node 模式檢查 | 清單讀取／刪除 | `lockdown()` | stdout／stderr |
| --- | --- | --- | --- |
| 不刪清單（對照組） | 不執行 | 成功 | 3 行，與第一輪相同的警告 |
| 先刪清單 | 成功，兩條都是 `removed` | 成功 | **沒有任何輸出** |

對照組有輸出、刪清單後沒有，證明是清單消除了警告。若哪天對照組也沒有輸出，原型會在 (b) 加註「對照組無輸出，清單作用無法證實」。

## 原型怎麼重現架構

- **Electron 層（AD-24）**：ready 前以 `protocol.registerSchemesAsPrivileged` 註冊 `app` 與 `pack`，兩者至少 `standard`、`secure`，都不給 `bypassCSP`；視窗 `sandbox`、`contextIsolation` 開，`nodeIntegration`、`nodeIntegrationInSubFrames`、`nodeIntegrationInWorker` 關，`backgroundThrottling` 關，`show: false`；`setWindowOpenHandler`、`setPermissionRequestHandler` 一律拒絕；`will-frame-navigate` 只允許 `app://`、`pack://`；`webRequest` 只放行 `app://`、`pack://`。
- **overlay**：由 `app://overlay/` 載入 Vite 打包的頁面，CSP `script-src 'self'`（不含 `'unsafe-eval'`），入口第一行 `import 'pixi.js/unsafe-eval'`，PixiJS 以 `preference: 'webgl'`、透明背景初始化。
- **沙盒（AD-7）**：overlay 建 `<iframe sandbox="allow-scripts">` 載入 `pack://_stage/sandbox.html`，回應帶 CSP `default-src 'none'; script-src 'sha256-<bootstrap 雜湊>' 'unsafe-eval'; worker-src blob:; connect-src 'none'`。SES 與 Worker 程式內嵌在同一段 inline script 裡，雜湊由 main 對整段 script 計算。iframe 把「bootstrap＋入口」組成一個 blob 建 classic Worker，把 MessageChannel 的 port 直接交給 Worker。Worker bootstrap 依上面的順序移除 API 與未知 intrinsics、`lockdown()`，再把測試包放進只注入 `stage` 的 `Compartment`。
- **觀測工具（不屬於 AD-7 設計）**：Worker prelude 在 SES 之前記錄所有 console 輸出；iframe 經另一個診斷 port 回報自身狀態；另建一個同 iframe、同 CSP、但不做移除也不用 SES 的診斷 Worker，用來單獨檢驗 CSP 這一層；overlay 另發一個請求檢驗 `webRequest` 這一層。

以下 (a)～(d) 的證據都是第二輪（2026-11-05）的結果。(a)(c)(d) 兩輪結果相同。每一輪都跑 6 次 Electron：4 種 `pack` 權限組合各一次，加上能載入貼圖的 2 種組合各重跑一次不帶 `Access-Control-Allow-Origin`；(a)～(c) 在這 6 次裡結果都一樣。

## (a) sandbox iframe 內以 blob 建 classic Worker：通過

| 檢查 | 觀察值 |
| --- | --- |
| iframe origin | `null`（opaque，沒有 `allow-same-origin`） |
| AD-7 CSP 是否生效 | 未雜湊的 inline script 被擋（`script-src-elem` 違規），雜湊過的 bootstrap 正常執行 |
| iframe 隔離 | 讀 `parent.document` 丟 `SecurityError`（判定依據） |
| cookie／localStorage（觀察，非判定依據） | 讀 `document.cookie`、`localStorage` 也都丟 `SecurityError` |
| Worker 建立 | `blob:null/<uuid>`，`[object DedicatedWorkerGlobalScope]` |
| classic Worker | 移除前 `typeof importScripts === 'function'`（module Worker 沒有這個函式） |
| 經 MessageChannel 回報 | Worker 直接用 overlay 交下來的 port 回報，iframe 沒有轉發 |

**觀察到的限制**：Worker 的 `isSecureContext` 是 `false`（opaque origin 的 blob Worker），iframe 本身是 `true`。只在安全環境提供的 API（如 `crypto.subtle`、`caches`、`WebTransport`）在包的 Worker 裡本來就不存在。

## (b) `lockdown()` 與 `Compartment.evaluate`：通過（第二輪）

| 檢查 | 觀察值 |
| --- | --- |
| 刪除未知 intrinsics | `Iterator.prototype.join`、`Iterator.prototype.includes` 都是 `removed` |
| `lockdown()`（不帶選項） | 不丟錯 |
| `new Compartment().evaluate('[1, 2, 3].reduce((a, b) => a + b, 0)')` | `6` |
| intrinsics 凍結 | `Object.prototype`、`Array.prototype`、`Function.prototype`、`Promise.prototype` 皆已凍結 |
| 測試包在 Compartment 內執行 | 成功，回報 `sum: 6` |
| Worker 的 console 輸出（載入 SES、`lockdown()`、執行測試包全程） | **0 行** |
| main 行程收到的 `console-message` 裡的 SES 訊息（觀察，非判定依據） | 0 則（第一輪有 3 則） |
| Node 模式補充檢查（先刪清單） | `lockdown()` 成功，stdout／stderr 沒有任何輸出 |

**觀察到的限制**：

- 清單的有效性綁在 V8 與 SES 的版本組合上，見結論的「方案 D 帶來的限制」。升級後若 Node 模式「不刪清單」那次也沒有輸出，表示清單已經不需要；某條清單項目回報 `absent` 則表示新的 V8 沒有該方法。兩種情況都要請使用者確認後再改清單。
- 角色包不能使用 `Iterator.prototype.join`、`Iterator.prototype.includes`（與 SES 自己刪除時相同）。
- 因為 AD-7 規定先移除 `importScripts` 再 `lockdown()`，SES 判斷不出自己在 Worker 裡，第一輪的警告是走 `console.error` 輸出（否則會是 `console.warn`）。這些訊息也會出現在 main 行程的 `console-message` 事件（frame 為 `pack://_stage/sandbox.html`），正式版可以記進運行紀錄，升級後出問題時比較容易看到。
- 在 Compartment 內，`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`WebTransport`、`importScripts`、`Worker`、`indexedDB`、`caches`、`self`、`postMessage`、`console`、`setTimeout` 的 `typeof` 都是 `undefined`，透過 `Function` 建構子查也一樣。

## (c) 封網：通過

對照目標是原型自己在 `127.0.0.1` 開的伺服器，所有回應都帶 `Access-Control-Allow-Origin: *`，所以失敗不可能是 CORS 造成的。

| 層 | 證據 | 結果 |
| --- | --- | --- |
| 對照組（main 行程） | `net.fetch`、`net.request`（XHR 對應的同一端點）、Node `WebSocket`、`net.fetch` 讀 SSE 都成功（`pong`、`hello`） | 目標本來連得到 |
| Compartment（測試包） | 四種呼叫都丟 `TypeError`（`fetch is not a function`、`XMLHttpRequest is not a constructor` 等） | 擋住 |
| bootstrap 移除 | 移除後 Worker 全域這 10 個名稱的 `typeof` 都是 `undefined` | 擋住 |
| CSP `connect-src 'none'`（診斷 Worker，用真的 API） | fetch 丟 `TypeError: Failed to fetch`，XHR、WebSocket、EventSource 收到 error 事件；每一種都有一筆 `connect-src` 違規 | 擋住 |
| CSP 有沒有被 blob Worker 繼承 | 診斷 Worker 的 `importScripts(blob:)` 被 `script-src-elem` 擋、`fetch(blob:)` 被 `connect-src` 擋 | 有繼承 |
| `webRequest` 放行清單 | overlay（CSP 沒有 `connect-src`）對 `127.0.0.1` 的 fetch 被 `webRequest` 取消 | 擋住 |
| 對照伺服器紀錄 | 只收到 4 筆 `from=main-*` 請求，沒有任何 renderer 端請求 | 沒有外洩 |

**觀察到的限制**：

- 沙盒裡的請求在 renderer 端就被 CSP 擋下，根本沒到 `webRequest`；`webRequest` 這一層只由 overlay 的請求驗證到。
- 移除 API 時必須沿原型鏈刪除：`fetch`、`importScripts`、`indexedDB` 在 `WorkerGlobalScope.prototype` 上，不在全域物件本身；`XMLHttpRequest`、`WebSocket`、`EventSource`、`Worker` 在全域物件上。`WebTransport`、`caches`、`SharedWorker` 在這個 Worker 裡本來就不存在。
- `webRequest` 沒有看到任何 `blob:` 請求，AD-24 的放行清單不會擋到 blob Worker。

## (d) PixiJS 從 `pack://` 載入貼圖：通過

測試圖是 main 產生的 48×32 單色 PNG（RGBA 51, 153, 204, 255），由 `pack://test-pack/1.0.0/…` 提供。判定除了載入成功，還用 `renderer.extract.pixels` 讀回像素比對顏色，證明圖片確實以未污染（untainted）的狀態進到 WebGL。PixiJS 在每次執行都選到 `webgl` renderer，overlay 確認無法 eval。

| `pack` 權限（都含 `standard`、`secure`） | 回應帶 ACAO | 預設（blob Worker） | `no-workers`（fetch＋createImageBitmap） | `image-element`（`<img crossorigin>`） |
| --- | --- | --- | --- | --- |
| 無額外 | 有 | 卡住，5 秒逾時 | `URL scheme "pack" is not supported` | CORS 擋下 |
| `corsEnabled` | 有 | 卡住 | `URL scheme "pack" is not supported` | **成功** |
| `corsEnabled` | 無 | 卡住 | `URL scheme "pack" is not supported` | **成功** |
| `supportFetchAPI` | 有 | 卡住 | CORS 擋下 | CORS 擋下 |
| `supportFetchAPI`＋`corsEnabled` | 有 | 卡住 | **成功** | **成功** |
| `supportFetchAPI`＋`corsEnabled` | 無 | 卡住 | **成功** | **成功** |

（ACAO＝`Access-Control-Allow-Origin: app://overlay`）

**`pack` scheme 最小權限：`standard`、`secure`、`corsEnabled`**，overlay 要搭配 `Assets.setPreferences({ preferCreateImageBitmap: false })`（以 `<img crossorigin="anonymous">` 載入）。如果要用 fetch＋`createImageBitmap`，就要再加 `supportFetchAPI`，並設 `preferWorkers: false`。兩種做法 `pack://` 回應都不需要帶 ACAO 標頭。

**觀察到的限制**：

- **PixiJS 預設載入方式在 AD-24 的 overlay CSP 下會永遠卡住**：預設 `preferWorkers: true` 會建 blob Worker 檢查 ImageBitmap 支援，`script-src 'self'`（沒有 `worker-src`）擋掉它，但 PixiJS 只等 Worker 的 message，不會丟錯，`Assets.load` 就一直不結束。正式 overlay 一定要設定上面的 preferences。
- 給了 `corsEnabled` 之後，`app://overlay` 不論 `pack://` 回應有沒有 ACAO 都能跨來源讀取 `pack://` 素材。ACAO 在 Electron 45 的自訂協定上不是存取控制；`pack://` 的存取限制要靠處理器只回應 manifest 宣告的路徑，加上沙盒 iframe 的 CSP（`default-src 'none'`）。
- 順帶觀察（不在 (d) 範圍）：`app` 只給 `standard`、`secure`，就能載入 Vite 的 module script（`type="module" crossorigin`）與動態 import 的分塊。
- AD-24 只規定 overlay CSP 的 `script-src`，原型照字面只設這一條；`img-src`、`connect-src`、`frame-src` 目前不受 CSP 限制，overlay 對外連線只靠 `webRequest` 擋。是否補其他 directive 留給 Story 1.6 決定。

## 這次沒涵蓋的範圍

- 只在 macOS arm64 實測，Windows 沒有測（AD-25 要求 CI 兩個平台都跑）。
- 沒有測 AD-25 沙盒安全測試的其餘項目（包內 importScripts、巢狀 Worker、存取 parent／top、`Date.now`、`Math.random`、OffscreenCanvas 的 webgl）；這些屬於 Epic 3 的 Playwright `_electron` 測試。上面 (b) 的 Compartment 全域清單只是順帶觀察。
- 原型只確認做法可行，沒有效能或記憶體量測。
