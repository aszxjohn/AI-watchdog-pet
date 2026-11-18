---
title: 'Story 3.6（下之一）：畫布穩定性與 macOS 隱藏'
type: 'feature'
created: '2026-11-18'
status: 'done'
baseline_commit: 'bc432a18a170ce24604ccd81ff44a2c074298353'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-6-tick-and-draw.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色已經畫在畫布上（3.6 中段，使用者已在每天用的新版裡實際使用），但畫布遇到失效狀況時沒有人處理：
- WebGL context lost 時 overlay 什麼都不做，畫面可能停住或空白。
- GPU 行程當掉時 main 沒有任何紀錄。
- 畫布無回應時，只會把滑鼠穿透打開，畫面會一直卡著。
- macOS 上任何 app 按「隱藏其他」（⌥⌘H），整個桌寵 app 連畫布一起被隱藏，角色消失，要從選單列打開面板才會回來（Epic 1 回顧 R2，epic-3-context「角色上台前要決定」）。

**Approach:**
- **context lost：** overlay 監聽畫布的 `webglcontextlost`／`webglcontextrestored`，停止與恢復繪製，並經新的 overlay 通道告訴 main。main 記錄；`CANVAS_CONTEXT_RESTORE_MS` 內沒還原，就重新載入畫布。
- **GPU 行程當掉：** main 聽 app 的 `child-process-gone`（`type` 為 `GPU`）並記錄；畫布的恢復走 context lost 那條路。
- **無回應：** 畫布 `unresponsive` 照舊立刻打開滑鼠穿透；持續超過 `CANVAS_UNRESPONSIVE_RELOAD_MS` 就重新載入畫布，`responsive` 時取消並記錄。
- **重新載入的上限：** 所有重新載入與重建都計入既有的「60 秒內最多 3 次」，超過就停止並記錄。
- **macOS 隱藏：** app 被隱藏時，只把畫布視窗叫回來，不搶焦點、不打開面板。

**Decisions（2026-11-18）：**
- 重新載入畫布就是重新載入畫布視窗的頁面。overlay 會重新訂閱 StageView、重送 `canvas:ready`；沙盒會跟著頁面一起消失，之後依 actor 重建，沒有另外的復原流程。
- Windows 沒有「隱藏 app」的概念，這段在 Windows 上只做 GPU 與畫布的部分。
- macOS 隱藏（使用者 2026-11-18 選 A）：試著讓畫布留著。實作時先在實機確認；如果叫回畫布會連帶讓整個 app（含面板）取消隱藏、或搶走焦點，就退回「接受隱藏」（維持現在的行為，只在說明寫明），並在 Implementation Notes 寫明原因與實測結果。

## Boundaries & Constraints

**Always:**
- **context lost 期間：** 不送 `frame`，也不渲染；還原後從 StageView 的現況與每包最後一則 `draw` 重畫。素材由 PixiJS 重新上傳，不重新下載。
- **只報狀態變化：** overlay 只回報「lost」「restored」兩種，main 依此計時；同一個畫布頁面的重複事件只記一行。
- **新通道：** 只開給 overlay，輸入用 shared 的 zod schema 驗證。
- **新常數：** 只放 `src/shared/constants`。
- **log：** 記原因代碼、exit code、次數，不記使用者資料。
- **不改繪製結果：** 不改 3.6 中段的節拍、訊息、`draw` 檢查與繪製規則。

**Never:**
- 不呼叫 `app.disableHardwareAcceleration()`，不改 Chromium 的 GPU 旗標。
- 不做粒子、bitmap（3.6 下之二）。
- 不在 app 程式加測試後門；e2e 只能用 Playwright 對 main 行程的 `evaluate` 與頁面上的 WebGL API。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| context lost 後還原 | 畫布的 WebGL context lost，數秒內 restored | lost 時停止繪製與 `frame`，main 記一行；restored 後恢復繪製，角色照常出現，main 記一行 |
| context 沒還原 | lost 之後超過 `CANVAS_CONTEXT_RESTORE_MS` 沒還原 | main 重新載入畫布並記一行；畫布重送 `canvas:ready`，角色重新畫出 |
| GPU 行程當掉 | app 收到 `child-process-gone`，`type` 為 `GPU` | 記一行（原因、exit code）；app 照常執行，畫布依 context lost 的規則恢復 |
| 無回應後恢復 | 畫布 `unresponsive`，在時限內 `responsive` | 立刻打開滑鼠穿透（現有行為），不重新載入，恢復時記一行 |
| 一直無回應 | 畫布 `unresponsive` 超過 `CANVAS_UNRESPONSIVE_RELOAD_MS` | 重新載入畫布並記一行 |
| 次數上限 | 60 秒內第 4 次需要重新載入或重建 | 不再處理，記一行錯誤（沿用現有上限） |
| 重複事件 | 同一個畫布頁面連續報兩次 lost | 只記一行，計時不重設 |
| 壞輸入 | 新通道的參數不合法，或從 panels 呼叫 | `invalid-input` 或 `sender-rejected`，什麼都不做 |
| macOS 隱藏 | 在其他 app 按「隱藏其他」，或用 Dock 的「隱藏」 | 畫布視窗很快回到畫面上，角色照常；面板保持隱藏，焦點留在原本的 app；做不到時依 Decisions 退回並記錄 |
| Windows | 在 Windows 上執行 | 只有 GPU 與畫布的部分；沒有隱藏的處理 |

</frozen-after-approval>

## Code Map

- **`src/overlay/main.ts`（或新的小模組）：**
  - 在 `app.canvas` 上聽 `webglcontextlost`／`webglcontextrestored`；PixiJS 會先 `preventDefault`，所以 context 有機會還原。
  - lost 時停 ticker、暫停 world；restored 時恢復。
  - 經新通道回報 lost／restored。
  - 判斷寫成可在 node 測的純邏輯。
- **`src/shared/ipc.ts`、`preload-api.ts`、`src/preload/overlay.ts`：** 新增只開給 overlay 的通道，例如 `canvas:gpu`，輸入是 `['context-lost' | 'context-restored']`。
- **`src/main/windows/canvas-window.ts`：**
  - 處理新通道：lost 時開始 `CANVAS_CONTEXT_RESTORE_MS` 計時，restored 時取消；逾時就重新載入頁面。
  - `unresponsive` 開始 `CANVAS_UNRESPONSIVE_RELOAD_MS` 計時，`responsive` 取消。
  - 重新載入與既有的 `render-process-gone` 重建共用「60 秒內最多 3 次」（`constants.ts:121-124`）。
  - 計時器可注入。
- **`src/main/main.ts`：** `app.on('child-process-gone')`，`type === 'GPU'` 時記一行。
- **macOS 隱藏：** 放在 `src/main/windows/`。可能的接法：
  - `systemPreferences.subscribeLocalNotification('NSApplicationDidHideNotification', …)`，或畫布視窗的 `hide` 事件。
  - 收到後對畫布呼叫 `showInactive()`。
  - 要實機確認：這樣會不會連帶讓整個 app（含面板）取消隱藏，或搶走焦點。
- **`src/shared/constants.ts`：** `CANVAS_CONTEXT_RESTORE_MS`（例如 5 秒）、`CANVAS_UNRESPONSIVE_RELOAD_MS`（例如 10 秒）。
- **測試：**
  - 單元測試：overlay 的 lost／restored 邏輯；canvas-window 的計時、重新載入與上限（`test/main/windows-canvas.test.ts:139`、`:700-736` 的寫法）；`child-process-gone`；新通道的拒絕。
  - e2e：
    - 在 overlay 用 `WEBGL_lose_context` 的 `loseContext()`／`restoreContext()` 驗證「還原」與「沒還原」兩條路，看 run log 與 `body.dataset`。
    - macOS 的隱藏用 `electronApp.evaluate(({ app }) => app.hide())`，只在 macOS 跑。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/overlay/world`、`src/overlay/renderer` 的繪製規則、`src/overlay/pack-host`、`src/sandbox`、`src/main/packs`、`src/main/pool`。

## Tasks & Acceptance

**Execution:**
- [x] overlay：context lost／restored 的處理與回報。
- [x] 新的 overlay 通道、preload。
- [x] main：計時、重新載入、上限、`child-process-gone`、無回應。
- [x] macOS 隱藏：畫布留著（做不到就退回並記錄）——實測做不到，已退回「接受隱藏」，見 Implementation Notes。
- [x] 測試，涵蓋 I/O 矩陣，含 e2e。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過，既有斷言只因新通道補值。
- Given push 到 main，when CI 跑完，then unit 與 e2e 在 macOS、Windows 都通過。

## Implementation Notes

- 2026-11-18 開發代理自行決定的部分：
  - **通道：** `canvas:gpu`（只開給 overlay），輸入 `[canvasGpuStateSchema]`（`'context-lost' | 'context-restored'`），回 null；preload 是 `api.canvas.gpu(state)`。
  - **常數：** `CANVAS_CONTEXT_RESTORE_MS` 5 秒、`CANVAS_UNRESPONSIVE_RELOAD_MS` 10 秒；`CANVAS_REBUILD_LIMIT`／`CANVAS_REBUILD_WINDOW_MS` 的註解改成「重建與重新載入一起算」，數值不變。
  - **overlay（`src/overlay/context-loss.ts`，純邏輯）：** 只在狀態改變時 `halt`／`resume` 並回報。`main.ts` 的 halt：停 ticker、world 改吃 `worldView(view, true)`（把 power 讀成睡眠，沿用既有的暫停規則：不 tick、不送 `frame`、時間停住；所以沒有改 `overlay/world`）、`canvas-input` 清空 hit area、body dataset `context=lost` 並把 `drawnActors`／`drawnSprites`／`hitAreas` 歸 0。resume：world 改回真的 view、`followView` 重新開 render loop，從 StageView 現況與每包最後一則 draw 重畫；素材庫不動，貼圖由 PixiJS 的 contextChange 重新上傳。lost 期間 `followView` 與 `drawFrame` 什麼都不做（PixiJS 的 `render` 沒有 lost 檢查）。回報失敗只寫 console。
  - **main（`canvas-window.ts`）：** 每個頁面記「lost 的起點與計時器」「無回應的起點與計時器」；did-navigate、closed、render-process-gone、新視窗、`stop()` 都清掉。重複的 lost、沒有 lost 的 restored、別的頁面送來的都不理。計時器以 `setTimer`／`clearTimer` 注入（測試沿用 `test/helpers/fake-clock.ts`）。log：
    - `canvas WebGL context lost; nothing is drawn until it is restored`（warn）
    - `canvas WebGL context restored after 1.2 s`（info）
    - `reloading the canvas page: its WebGL context was not restored within 5 s (recovery 1 of 3 within 60 s, rebuilds and reloads count together)`（warn；重建的 log 也改成同樣的計數寫法）
    - `reloading the canvas page in a new renderer: it still did not respond 10 s after Chromium found it unresponsive (recovery n of 3 within 60 s, rebuilds and reloads count together)`（warn）
    - `canvas renderer stopped (killed, exit code N); reloading its page`（info）
    - `canvas page responding again after 4.0 s; not reloading it`（info）
  - **無回應的重新載入：** 卡住的 renderer 直接 `reload()` 可能永遠 commit 不了，所以照 Electron 文件對 `unresponsive` 的建議：先 `forcefullyCrashRenderer()`，等它的 `render-process-gone` 來了再 `reload()`（同一個視窗、新的 renderer）。這次 gone 不算當掉：不重建、不另外計次。旗標若殘留，只會讓下一次真的當掉改走「重新載入」而不是「重建」，仍然會恢復。
  - **上限：** 重建與重新載入共用同一份 60 秒內的紀錄。第 4 次時：如果這次和前 3 次都是重建，沿用原本的訊息（`canvas renderer gone 4 times within 60 s; …`，既有斷言不變）；否則記 `canvas needed a rebuild or reload 4 times within 60 s, the last because …; not rebuilding or reloading it again (the app keeps running without a canvas | with the canvas as it is)`。之後和既有的上限一樣全部停止（不重建、不重新載入、也不再搬移畫布）；重新載入到上限時視窗維持原狀。
  - **GPU 行程（`src/main/windows/gpu.ts`）：** `watchGpuProcess(app)` 只記 `type === 'GPU'`：`GPU process gone (crashed, exit code 139); the canvas recovers through its WebGL context`（error）；其他 child process 不記。
- **macOS 隱藏：實測做不到，依 Decisions 退回「接受隱藏」。**
  - 做法：在 `NSApplicationDidHideNotification`（`systemPreferences.subscribeLocalNotification`）之後對畫布呼叫 `showInactive()`。
  - 實測方法：用 Playwright `_electron` 啟動 e2e build 的測試實例（暫存 HOME、`--user-data-dir`，匯入契約測試包、面板開著），只對這個實例呼叫 `app.hide()`；在 main 讀 `app.isHidden()`、畫布與面板的 `isVisible()`、`BrowserWindow.getFocusedWindow()`，另以唯讀的 `lsappinfo front` 比對最前面的 app 是不是測試實例的 pid。
  - 結果（macOS，Electron 45.2.1，跑兩次一致）：
    - 對照組（把畫布的 `showInactive` 換成空函式）：約 2–53 ms 內 `hidden: true`，畫布與面板都不見，沒有焦點——重現原本的問題。
    - `showInactive()`：約 25–31 ms 後 `hidden: false`，畫布回來，**面板也一起回來**；焦點沒有被搶（`getFocusedWindow()` 為 null，最前面的 app 不是測試實例）。
    - 改用 `moveTop()`：同樣約 25 ms 後整個 app 取消隱藏、面板回來。
  - 結論：app 隱藏時只要把畫布排回畫面，AppKit 就會把整個 app 取消隱藏（不啟用），面板跟著出現，符合 Decisions 的退回條件。已移除這段處理，只在 `canvas-window.ts` 與 `main.ts` 的模組說明寫明；e2e 的「macOS 隱藏」改成斷言接受的行為：隱藏後畫布和面板都藏起來、2 秒內不會自己回來、沒有焦點；`app.show()` 之後畫布和角色回來。
  - 沒有實作、需要使用者重新決定的方向：隱藏時先由 main 自己把面板 orderOut 再叫回畫布。這樣 app 會變成「未隱藏」，Dock 與選單列重新打開面板的行為要另外設計。
  - `deferred-work.md` 的 R2 項目（Dock「隱藏」／別的 app「隱藏其他」）沒有改動，由使用者決定是否改寫成「已決定接受」。
- 既有斷言的改動：只有新增，沒有刪除或改寫任何 `expect`。
  - 新通道補值：`test/preload/overlay.test.ts` 的 `api.canvas` key 多 `gpu`；`test/main/windows-main.test.ts` 的建立順序多 `registerCanvasGpuHandler canvas`。
  - 測試替身：`FakeWindow` 多 `reload`、`forcefullyCrashRenderer`；`setup()` 改用 `fakeClock()`（`setTime` 語意不變）；`start.test.ts`、`canvas-input.test.ts` 的假 API 多 `gpu`。
- 2026-11-18 依審查修補（Review Triage Log 第 1 輪的 patch 項）：
  - B2：恢復後的頁面（重新載入或重建之後）在 `canvas:ready` 回報初始化失敗，就再重新載入一次，計入上限；第一次啟動的失敗照舊只記錄。`registerCanvasReadyHandler(canvas?)` 把報告交給 `canvas.ready()`，`main.ts` 傳入畫布視窗。
  - B3／E2／VG3：`forcefullyCrashRenderer()` 或 `reload()` 丟例外時，清掉 `reloadWhenGone`，記一行 warn，改走重建（計入上限）。
  - E1／B12：context 沒還原的計時器觸發時，若頁面同時無回應，改走「強制停掉再重新載入」，兩者只算一次恢復。
  - VG1／VG2／E4／E5：overlay 的接線抽成 `createContextStage`（`context-loss.ts`），注入 world、input、ticker、resize、show；lost 期間 PixiJS 的 `resizeTo` 設成 null，恢復時設回 `window`；`attach()` 接上監聽後立刻檢查 `isContextLost()`。
  - B5／E3：`stop()` 或到上限之後，新的 `context-lost` 不記 warn、不設計時器；`unresponsive` 不設計時器（滑鼠穿透的恢復與它原本的 warn 保留，避免畫布擋住點擊）。
  - B8／E6：GPU 的 `clean-exit` 記 info（`GPU process "GPU" exited cleanly (exit code 0)`），其他原因照舊記 error；兩者都帶 `details.name`。
  - B1：`gpu.ts` 的說明寫明：GPU 短時間內當太多次時 Chromium 可能停用 WebGL 到重啟為止，重新載入救不回來，會在恢復上限後停止；不呼叫 `disableDomainBlockingFor3DAPIs`。
  - B7、B15：log 與常數說明的措辭（見上面的 log 清單）。
  - B9：e2e「context 沒還原」改成等 lost 行數加 1（完整執行時是 2），並在重新載入前確認 dataset 是 lost。
  - B11：`windows-main.test.ts` 的「macOS 隱藏」測試鎖住：沒有任何 `systemPreferences` 通知訂閱、app 只聽固定的事件清單、main 建立的畫布視窗沒有任何監聽；`windows-canvas.test.ts` 鎖住畫布視窗只聽 ready-to-show、closed、unresponsive、responsive。
- 2026-11-18 開發代理驗證：
  - `npm run typecheck`、`npm run lint`、`CI=true npm test`（112 檔通過、1 檔跳過；5233 個測試通過、2 個跳過）、`npm run depcruise`（312 個模組、0 違規）、`npm run e2e`（15 個全過，含新的 `test/e2e/stability.spec.ts` 3 個）全過。`out/` 沒有被動到。
  - 突變實驗（都已還原）：重複 lost 會重設計時、重新載入不計次、故意停掉的 renderer 被當成當掉、`responsive` 不取消計時、overlay 重複回報 lost、lost 時 world 不暫停，各自有測試失敗。
  - I/O 矩陣 10 列都有測試：單元測試在 `test/main/{windows-canvas,windows-gpu,windows-main}.test.ts`、`test/overlay/context-loss.test.ts`、`test/preload/overlay.test.ts`、`test/shared/ipc.test.ts`；e2e 涵蓋「context lost 後還原」「context 沒還原」「macOS 隱藏」（只在 macOS 跑）。
  - 缺口：
    - overlay `main.ts` 的 halt／resume 接線沒有單元測試；e2e 驗了 dataset 與 log。「lost 期間不送 `frame`」只由 `worldView` 的單元測試與程式閱讀確認。
    - 「無回應」「GPU 行程當掉」只有單元測試：e2e 不能加後門讓頁面卡住，也不能讓 GPU 行程真的掛掉。`forcefullyCrashRenderer` 之後的重新載入沒有在真的 Electron 跑過。
    - 角色是否真的畫在畫面上只看 dataset，沒有讀像素。
    - Windows 只有 CI 會跑。

- 2026-11-18 主流程重跑：五項檢查全過（112 檔通過、1 檔跳過；5233 個測試通過、2 個跳過；depcruise 312 個模組、0 違規；`npm run e2e` 15 個全過）；`out/` 沒有被動到；I/O 矩陣 10 列都有測試且都跑過；diff 裡沒有刪掉的 `expect(`。

- CI：commit `b45c20e`（2026-11-18）後，GitHub Actions 的 unit（check）與 e2e 在 macOS、Windows 都通過（run 44224962740）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-18）：Blind Hunter 15 條（B1–B15）、Edge Case Hunter 6 條（E1–E6）、Verification Gap 3 個缺口（VG1–VG3）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B2 | 重新載入後 PixiJS 初始化失敗（`canvas:ready` 回失敗）只記一行，不計次、不重試，畫布空白到重啟 | medium | patch | 已確認 `logCanvasReady` 只記錄；恢復後的初始化失敗也要當成一次恢復，在上限內再試 |
| B3、E2、VG3 | `forcefullyCrashRenderer()` 或 `reload()` 丟例外時，`reloadWhenGone` 留著、計時器已清，頁面永遠卡住；這條路沒有測試 | medium | patch | 已確認 `resetPage()` 先清了計時器；失敗時清掉 `reloadWhenGone`，在上限內改走重建，FakeWindow 加丟例外的旗標補測試 |
| E1、B12 | context 沒還原的計時器觸發時，頁面若同時無回應，走的是一般 `reload()`，對卡住的 renderer 可能永遠載不完；lost 或無回應期間 `closed`、兩者同時發生，都沒有測試 | medium | patch | 已確認兩個計時器各自走不同路；同時無回應時改走強制停掉再重新載入，只算一次恢復，補測試 |
| VG1、VG2、E4、E5 | overlay `main.ts` 的暫停與恢復接線（清 hit area、world 暫停與恢復、StageView 更新時維持暫停）沒有任何測試；lost 期間 PixiJS 的 ResizePlugin 仍會 render；context 在 `app.init` 期間就 lost 時沒人知道 | medium | patch | 驗證缺口已附證據；把接線抽到 `context-loss.ts`，注入 world、input、ticker、show，用真的 `createCanvasInput` 與 `createWorld` 測；lost 期間關掉 `resizeTo`；接上監聽後檢查 `isContextLost()` |
| B5、E3 | `stop()` 或到上限之後，新的 `context-lost` 與 `unresponsive` 仍記 warn、設不會做事的計時器 | low | patch | 直接修正：已停止就忽略 |
| B8、E6 | GPU 的 `child-process-gone` 不分原因一律記 error，`clean-exit` 也說「畫布會恢復」 | low | patch | 直接修正：`clean-exit` 記 info 或略過，並帶上 `name` |
| B9 | e2e「context 沒還原」的第一個等待會撿到上一個測試留下的 lost 行 | low | patch | 直接修正：斷言 lost 行數變成 2，並在重新載入前確認 dataset 是 lost |
| B11 | `windows-main.test.ts` 的「macOS 隱藏」測試沒有鎖住「沒有訂閱隱藏通知、沒有畫布的 hide 處理」 | low | patch | 直接修正測試 |
| B7 | log 與常數說明說「10 秒沒回應」，實際是 Chromium 自己的偵測延遲再加 10 秒 | low | patch | 直接修正說明與 log 措辭 |
| B15 | 重新載入也計入 `CANVAS_REBUILD_*`，log 卻寫「rebuilding (2 of 3)」 | low | patch | 直接修正 log 措辭，寫明重建與重新載入一起算 |
| B1 | GPU 短時間內當太多次時，Chromium 可能停用 WebGL 直到 app 重啟，重新載入救不回來；`gpu.ts` 的說明講得太肯定 | low | patch | 不呼叫 `disableDomainBlockingFor3DAPIs`（那是 Chromium 的保護）；直接修正說明，寫明這種情況會在上限後停止 |
| B4 | context 反覆掉了又回來，沒有上限，log 會一直寫 | low | reject | GPU 驅動一直不穩才會發生；要加抖動偵測與狀態 |
| B6 | 到上限後 `place()` 也停了，畫布不再跟著螢幕或設定移動，使用者看不到提示 | low | reject | 既有行為（Story 1.6 的上限設計），這段只是把重新載入也算進去 |
| B10 | e2e 沒有讓 GPU 行程真的當掉（例如 `chrome://gpucrash`） | low | reject | 請求過濾與導覽守衛會擋 `chrome://`；真的讓 CI 的 GPU 行程當掉可能讓其他測試不穩；恢復路徑已由 `WEBGL_lose_context` 的 e2e 跑過 |
| B13 | 假時鐘的 `setTime` 說不能倒退，但沒有強制 | low | reject | 測試輔助的說明問題，沒有測試因此誤判 |
| B14 | 延後條目 `source_spec: none`；R2 的狀態與「先收面板再叫回畫布」的方向沒記 | low | patch | 拆段條目依流程寫 `none`（不改）；R2 與新方向由主流程記進 deferred-work |

修補結果（2026-11-18）：11 組都已修正。B5 有一處和指示不同：停止或到上限之後，無回應時仍把滑鼠穿透打開並記原本那行 warn（Story 1.6 的行為），不然卡住的畫布會擋住點擊；只是不再設計時器。主流程重跑：typecheck、lint、depcruise 通過；`CI=true npm test` 112 檔、5256 個測試通過；`npm run e2e` 15 個通過；`out/` 沒動；沒有刪掉 `expect(`。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者在打包版實機驗收：在其他 app 按「隱藏其他」，桌寵 app 連畫布一起被隱藏（實測後接受隱藏）；從選單列打開面板後角色回來。
