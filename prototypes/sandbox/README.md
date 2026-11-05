# 沙盒原型（Story 1.2，AD-7 閘門）

可丟棄的獨立原型，用來在 Electron 45.2.1 實測 AD-7 的沙盒做法（sandbox iframe → classic Worker → SES Compartment → 封網）與 AD-24 的 `pack://` 權限。`src/` 不得引用這裡的任何東西。結果與結論寫在 `_bmad-output/implementation-artifacts/sandbox-prototype-report.md`。

## 怎麼跑

```sh
npm run proto:sandbox
```

1. `vite build --config prototypes/sandbox/vite.config.mts`：把 overlay 頁（PixiJS＋測試包原始碼）打包到 `.vite/proto-sandbox/overlay/`。
2. `node prototypes/sandbox/main.cjs`（協調者）：先以 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）跑兩次 `ses-node-check.cjs`（不刪清單、刪清單各一次），再依序開隱藏的 Electron 執行 `main.cjs`：4 種 `pack` scheme 權限組合各一次，能載入貼圖的組合再各跑一次不帶 `Access-Control-Allow-Origin`（目前共 6 次），跑完自動結束。`main.cjs` 的角色由 `require('electron')` 的結果決定：在 Node 下拿到 Electron 執行檔路徑（字串）就當協調者，在 Electron 裡拿到 API 就當原型入口；命令列上的 `--proto-role=child` 只是標記，不影響判斷。
3. 終端機印出四項結果與 `pack` 最小權限；完整原始資料寫到 `.vite/proto-sandbox/results.json`。

- 不顯示任何視窗（`show: false`，macOS 另隱藏 Dock 圖示），全程約 40 秒。
- 只連 `127.0.0.1`（原型自己開的對照伺服器），不連任何對外網路。
- 結束碼：`0` 閘門通過、`1` 閘門未通過、`2` 原型本身出錯（載不到 electron、子行程起不來、逾時或沒留下結果，此時不論閘門結果都回 2）。
- `.vite/` 已被 git 忽略，`npm start`（Forge）會清掉它；要看結果檔就重跑一次。
- 每次 Electron 執行的 `userData` 放在 `.vite/proto-sandbox/user-data/`，跑完即刪。

## 檔案

| 檔案                                    | 作用                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.cjs`                              | `require('electron')` 回傳字串（Node）時是協調者；回傳 API（Electron）時是原型的 Electron 入口：在 ready 前註冊 `app`／`pack`（`standard`、`secure`，不給 `bypassCSP`）、`app://`／`pack://` 處理器、`webRequest` 只放行 `app://`／`pack://`、AD-24 視窗設定、`127.0.0.1` 對照伺服器、main 行程對照組、判定結果 |
| `ses-node-check.cjs`                    | (b) 的補充證據：在 Electron 的 Node 模式（與 Worker 同一個 V8，不經 iframe／Worker）先刪 `ses-unknown-intrinsics.js` 的清單，再 `require('ses'); lockdown()`；本身不輸出，任何輸出都算 SES 的輸出                                                                                                               |
| `preload.cjs`                           | overlay 的 preload，只暴露 `protoHost.report()` 把結果交回 main                                                                                                                                                                                                                                                 |
| `vite.config.mts`                       | 打包 overlay 頁                                                                                                                                                                                                                                                                                                 |
| `web/overlay/`                          | overlay 頁（`app://overlay/`，CSP `script-src 'self'`，第一行 `import 'pixi.js/unsafe-eval'`）：建 sandbox iframe 與 MessageChannel、以 PixiJS 測 (d)                                                                                                                                                           |
| `web/sandbox/iframe-bootstrap.js`       | `pack://_stage/sandbox.html` 的 inline bootstrap；main 把 SES 與 Worker 程式內嵌進同一段 script，算 SHA-256 放進 CSP                                                                                                                                                                                            |
| `web/sandbox/worker-prelude.js`         | 原型專用：在 SES 之前記錄 Worker 的所有 console 輸出，以及被移除前的 `importScripts` 等事實                                                                                                                                                                                                                     |
| `web/sandbox/ses-unknown-intrinsics.js` | SES 尚未認得的 intrinsics 清單（AD-7，2026-11-05 決定），逐條列名，唯一一份；Worker bootstrap 與 `ses-node-check.cjs` 共用                                                                                                                                                                                      |
| `web/sandbox/worker-bootstrap.js`       | AD-7 的 Worker bootstrap：移除 fetch、XHR、WebSocket、EventSource、WebTransport、importScripts、巢狀 Worker、indexedDB、caches → 逐條刪除清單裡的 intrinsics（不存在就略過）→ `lockdown()`（不帶任何選項） → 包放進 `Compartment`，只注入 `stage`                                                               |
| `web/sandbox/probe-worker.js`           | 原型專用診斷 Worker：同一 iframe、同一 CSP，但不做移除也不用 SES，用來看 CSP 本身擋不擋得住網路                                                                                                                                                                                                                 |
| `web/test-pack/entry.js`                | 測試包：在 Compartment 內回報 `1+2+3`、列出看得到的全域、嘗試四種連線                                                                                                                                                                                                                                           |

`worker-prelude.js`、`probe-worker.js`、iframe 回報用的診斷 port 都是觀測工具，不是 AD-7 設計的一部分。

## 每項測什麼

| 項目          | 做法                                                                                                                                                                                                                                       | 通過條件                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 建 Worker | overlay 建 `<iframe sandbox="allow-scripts">`（無 `allow-same-origin`）載入 `pack://_stage/sandbox.html`，回應帶 AD-7 CSP；iframe 以 blob 建 classic Worker，把 MessageChannel 的 port 直接交給 Worker                                     | iframe origin 為 `null`、未雜湊的 inline script 被擋、讀不到 parent；Worker 是 `blob:` 且建立時有 `importScripts`（classic），並經 port 回報                                      |
| (b) SES       | Worker 內移除 API、刪除 SES 尚未認得的 intrinsics 後 `lockdown()`，再 `new Compartment().evaluate('[1, 2, 3].reduce((a, b) => a + b, 0)')`，最後把測試包放進 Compartment 執行                                                              | `lockdown()` 不丟錯、回傳 `6`、intrinsics 已凍結、測試包在 Compartment 內執行成功，且整段期間 Worker 沒有任何 console 輸出（含警告）；Node 模式補充檢查（刪清單後）也沒有任何輸出 |
| (c) 封網      | 測試包在 Compartment 內對 `127.0.0.1` 對照伺服器做 fetch、XHR、WebSocket、EventSource；診斷 Worker 用真的 API 再試一次；overlay 另發一個請求檢查 `webRequest` 這一層；main 行程對同一目標做對照組                                          | 對照組四種都成功；Compartment 內四種都丟錯；診斷 Worker 四種都被擋；對照伺服器沒收到任何 renderer 端請求                                                                          |
| (d) 貼圖      | overlay 以 PixiJS（`preference: 'webgl'`）從 `pack://test-pack/1.0.0/…` 載入 48×32 的測試圖，三種載入方式各試一次：預設（blob Worker）、`no-workers`（fetch＋createImageBitmap）、`image-element`（`<img crossorigin>`）；讀回像素比對顏色 | 至少一種方式載入成功且像素正確；在權限組合中找出最小的一組                                                                                                                        |

`pack` 權限組合（都含 `standard`、`secure`）：無額外、`corsEnabled`、`supportFetchAPI`、兩者都給；能載入貼圖的組合再各跑一次「回應不帶 `Access-Control-Allow-Origin`」，看處理器要不要送這個標頭。

## 升級 Electron 時

`web/sandbox/ses-unknown-intrinsics.js` 只對 Electron 45.2.1（V8 15.6）與 SES 2.3.0 這組版本驗證過。升級 Electron 或 SES 後要重跑 `npm run proto:sandbox`：

- (b) 出現新的「Removing unpermitted intrinsics」警告：把警告裡的名稱換成 `globalThis` 路徑加進清單，請使用者確認後再重跑。對應方式：
  - 警告寫的是 SES 的 intrinsic 名稱，例如 `intrinsics.%IteratorPrototype%.join`。`%名稱%` 先對到能從 `globalThis` 走到的物件：`%IteratorPrototype%` 是 `Iterator.prototype`，`%ArrayPrototype%` 是 `Array.prototype`，`%XxxPrototype%` 一般是 `Xxx.prototype`；建構子本身（例如 `%Iterator%`）是 `Iterator`。後面的屬性名照抄，所以清單寫 `Iterator.prototype.join`。
  - 清單的刪除函式只會從 `globalThis` 逐段往下走。隱藏的 intrinsic（例如 `%IteratorHelperPrototype%`、`%AsyncIteratorPrototype%` 這類沒有全域名稱、只能從某個物件的原型鏈拿到的）走不到，清單寫了也只會回報 `absent`。遇到這種情況要停下來回報使用者，不得自行用其他方式（改刪除函式、關掉 SES 回報等）繞過。
- 摘要裡「without the list」那行變成 0 行輸出：SES 已經認得這些方法，清單可以清空；某條項目變成 `absent`（(b) 的 note）：這個 V8 已沒有該方法，可以從清單移除。兩種都請使用者確認後再改。
