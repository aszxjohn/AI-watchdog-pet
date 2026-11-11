---
title: 'Epic 2 驗收用：示範模式的方塊角色空殼與右鍵選單'
type: 'feature'
created: '2026-11-10'
status: 'done'
baseline_commit: 'd34985798f513d09d1819b71b641103ccc9b8998'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-demo-sessions-panel.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 示範模式最終要「在畫布上對角色按右鍵選狀態」，但角色要到 Epic 3 才上畫布。Story 2.3 只能從系統匣選狀態，Epic 2 驗收時沒辦法在畫布上確認這條路。

**Approach:**
- 示範模式開啟時，在畫布右下角畫一個方塊代表示範 session。方塊的顏色跟著狀態變，上面寫中文狀態名。
- 游標移到方塊上時，畫布才接收滑鼠；對方塊按右鍵會跳出原生選單，選了就呼叫偵測的 `setDemo(state | null)`，與系統匣走同一個入口。
- 「游標在角色上才接收滑鼠」與「右鍵開選單」兩個機制照 AD-14 做，Epic 3 的真角色直接沿用。方塊本身只供驗收用。

**Decisions（2026-11-10，使用者選定預設）：**
- 方塊只在示範模式開啟時出現，關閉就消失。
- 方塊是色塊，顏色跟著狀態變，上面寫中文狀態名。
- 方塊固定在畫布右下角，不能拖曳。
- 右鍵選單：8 種狀態（目前的打勾），再加「關閉示範模式」。
- 方塊只供驗收用，Epic 3 真角色上畫布後移除；穿透切換與右鍵選單的機制保留。

## Boundaries & Constraints

**Always:**
- 依 AD-14：
  - 穿透狀態由 overlay 擁有；只在「在方塊上／不在」改變時送請求，請求帶遞增的 `seq`；
  - main 冪等處理，並丟掉 `seq` 不比上一筆大的請求；
  - 不在方塊上時，一律恢復成 `setClickThrough` 的穿透設定。
- 畫布頁面重新載入或重建時，main 恢復穿透，並把該畫布的 `seq` 歸零。
- 方塊消失時（示範模式關閉）、游標離開視窗時，overlay 都送「不在方塊上」。
- 選單只在 `main/windows` 定義。狀態項目與 Story 2.3 的系統匣子選單共用同一份定義，選了都呼叫 `detection.setDemo(state | null)`。不直接呼叫示範轉接器的 `setState`，否則會跳過合併後的 StageView 通知與 `adapters` 的 demo 健康狀態。
- 系統匣「示範模式」子選單的勾選要跟偵測的狀態同步：依 `detection.onChange` 更新勾選，或重建系統匣選單。目前勾選由 Electron 自己管理，右鍵選單成為第二個入口後就會對不上。
- 新的 IPC 通道只開放給 overlay，經既有的註冊函式；輸入用 shared 的 zod schema 嚴格驗證。
- overlay 只從 StageView 的 `sessions` 區段得知示範 session 與它的狀態，不另外訂閱。

**Never:**
- 不做拖曳、遊走、角色包、池子分配，也不做真角色的右鍵選單項目（編輯頁、管理 session、暫停）。
- 不改判斷器、`sessions`、示範轉接器維持狀態的規則。
- Linux 不切換穿透（AD-14 整窗穿透）：方塊照樣畫出來，但不能右鍵，狀態改從系統匣選。

## I/O & Edge-Case Matrix

| 情境 | 輸入 | 預期 |
|---|---|---|
| 出現 | 從系統匣打開示範模式，選「要你批准」 | 畫布右下角出現方塊，顏色是 approval 的顏色，寫著「要你批准」 |
| 跟著變 | 改選「做完了」 | 方塊的顏色與文字跟著變 |
| 消失 | 關閉示範模式 | 方塊消失；游標當時在方塊上的話，畫布恢復穿透 |
| 移到方塊上 | 游標從外面移進方塊 | 送一次 `over: true`，畫布不再穿透 |
| 移開 | 游標移出方塊 | 送一次 `over: false`，恢復穿透；在方塊內外移動不重複送 |
| 右鍵 | 在方塊上按右鍵 | 跳出選單：8 種狀態，目前的打勾，下面是「關閉示範模式」 |
| 從選單選 | 選「出錯了」 | 示範 session 變成「出錯了」，方塊跟著變 |
| 兩個入口同步 | 從右鍵選單改狀態或關閉 | 系統匣子選單的勾選跟著改到同一項 |
| 過時的請求 | main 收到的 `seq` 不比上一筆大 | 丟掉，穿透狀態不變 |
| 畫布重載 | 畫布頁面重新載入或重建 | 恢復穿透，`seq` 從頭算 |
| 不是示範 session | 右鍵請求的 `sessionKey` 不是示範 session | 不跳選單，記一筆 `windows` 警告 |
| 壞請求 | 請求不符合 schema | 由註冊函式拒絕，穿透狀態不變 |

</frozen-after-approval>

## Code Map

**前提：** Story 2.3 的 commit 進 `main` 之後才實作。動手前先讀 2.3 實際的程式；下面標「2.3」的名稱以 2.3 的規格為準，實際名稱可能不同。

- `src/overlay/`：
  - 新增 `pointer.ts`：hit-test 與穿透狀態機。輸入游標位置與目前的可點區域（矩形清單），只在「在區域上／不在」改變時產生 `{ seq, over }`。純函式，不碰 DOM 或 PixiJS，Epic 3 沿用。
  - 新增 `demo-square.ts`（驗收用，Epic 3 移除）：從 StageView 的 `sessions` 找 `source === 'demo'` 的那筆；算出方塊的位置（世界右下角，邊長 120 DIP、距邊緣 24 DIP），以及顏色與文字（中文名取自 `src/shared/states.ts` 的 `STATE_DISPLAY_NAMES`）。純函式。
  - `main.ts`：
    - 用 PixiJS 畫方塊（`Graphics` 加 `Text`）。每次 StageView 變化就更新，再 `app.render()`；目前沒有 render loop，見檔內註解。
    - `mousemove`、`mouseleave` 交給 `pointer.ts`；在方塊上的 `contextmenu` 呼叫 `window.awp.canvas.contextMenu(sessionKey)`，並 `preventDefault()`。
  - 世界座標就是視窗的 client 座標（AD-14），世界大小取 StageView 的 `canvas.bounds`。
- `src/shared/ipc.ts`：比照 `canvasReady` 新增兩個 invoke 合約：
  - `canvas:set-hover`：輸入 `{ seq: 正整數, over: boolean }`；
  - `canvas:context-menu`：輸入 `{ sessionKey }`，`sessionKey` 用 `src/shared/detection-events.ts` 的 schema。
  
  兩者都回傳 null。
- `src/shared/preload-api.ts`、`src/preload/overlay.ts`：`OverlayApi.canvas` 加 `setHover`、`contextMenu`。
- `src/main/windows/canvas-window.ts`：
  - 新增 handler 註冊，比照 `registerCanvasReadyHandler`（`:381`），渲染器限 `CANVAS_RENDERERS`；
  - `seq` 的比較與歸零、穿透的切換，沿用 `setClickThrough`（`:113`）；
  - Linux 不切換。
- `src/main/windows/menu.ts`：示範狀態選單的 template，跟 2.3 的系統匣子選單共用狀態項目，以 `Menu.popup({ window: 畫布視窗 })` 顯示。
- `src/main/main.ts`：把右鍵請求接到偵測（2.3 的 `detection.ts`）：確認 `sessionKey` 是示範 session、讀目前狀態以標示打勾，選了就呼叫 `detection.setDemo(state | null)`。系統匣的勾選依 `detection.onChange` 更新（`src/main/windows/tray.ts` 保有 `Tray`，可重設 context menu）。
  - 2.3 實際的名稱（2026-11-10 讀過尚未 commit 的程式）：`createDetection` 回傳的 `Detection` 有 `get()`、`onChange()`、`setDemo(state | null)`；示範 session 的 key 是 `src/main/detection/adapters/demo/demo.ts` 的 `DEMO_SESSION_KEY`（`'demo:1'`）。目前狀態取 `detection.get().sessions` 裡這把 key 的 `state`，沒有這筆表示示範模式關閉，不必另加 getter。
  - 系統匣子選單的 radio 項目 id 是 `demo-off` 與 `demo-<state>`（`src/main/windows/menu.ts` 的 `demoSubmenu`），同步勾選時用 `Menu.getMenuItemById` 設 `checked`。
  - 實作前再讀一次 2.3 commit 後的程式，名稱以 commit 為準。
  - `main/windows` 不 import `main/detection`。
- 測試：`test/overlay/`、`test/main/`、`test/shared/` 的純邏輯測試，比照 `test/overlay/start.test.ts`、`windows-canvas.test.ts`。PixiJS 繪圖本身不寫單元測試。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/ipc.ts`、`src/shared/preload-api.ts`、`src/preload/overlay.ts`：兩個通道與 API。
- [x] `src/overlay/pointer.ts`、`demo-square.ts`、`main.ts`：hit-test、方塊、右鍵。
- [x] `src/main/windows/canvas-window.ts`、`menu.ts`：穿透切換、`seq`、選單。
- [x] `src/main/main.ts`（以及必要時的 `detection.ts`）：接線。
- [x] 測試：I/O 矩陣每一列（繪圖除外），以及新 schema 的往返與拒絕。
- [x] `deferred-work.md`：加一筆「Epic 3 真角色上畫布後移除方塊空殼，保留 `pointer.ts` 與兩個通道」。

**Acceptance Criteria:**
- Given 這項工作完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when app 啟動完成，then run log 沒有 `windows`、`detection`、`stage-view` 錯誤。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - `canvas:set-hover` 的 `seq` 用 `z.int().positive()`（1 到 2^53−1）；`canvas:context-menu` 的請求是 `{ sessionKey }`，preload 的 `contextMenu(sessionKey)` 包成物件送出。
  - main 只接受「目前畫布視窗的頁面」送來的請求：`CanvasWindowHandle.webContents` 加 `id`，與 IPC 事件的 `sender.id` 比對；重建前的舊頁面送來的一律丟掉。`createCanvasWindows` 改成泛型，`main.ts` 拿到的是 `BrowserWindow`，可直接給 `Menu.popup({ window })`。
  - 冪等：`seq` 比上一筆大就收下（即使 `over` 沒變也更新 `seq`），但只有 `over` 改變時才呼叫 `setIgnoreMouseEvents`。過時的請求不記紀錄。
  - 「畫布頁面重新載入」用 `webContents` 的 `did-navigate`（主框架導覽完成，含重新載入）判斷：`seq` 歸零，當時不穿透的話恢復 `setClickThrough`。重建時新視窗本來就從穿透、`seq` 0 開始。
  - 右鍵是否為示範 session 的判斷放在 `menu.ts` 的 `openCanvasMenu`（可單獨測試）；`main.ts` 只提供 `DEMO_SESSION_KEY`、目前狀態（`demoStateOf(detection.get().sessions)`）與 `detection.setDemo`，`main/windows` 不 import `main/detection`。不是示範 session 記 `windows` warn（只記來源代碼，不記原生 id）；示範模式已關閉但方塊還沒消失時的右鍵，也不跳選單、記一筆 warn。
  - 右鍵選單的 8 個狀態項目與系統匣子選單共用 `demoStateItems`（radio，id 同為 `demo-<state>`），下面是分隔線與一般項目「關閉示範模式」（id `demo-turn-off`）。
  - 系統匣勾選同步：`detection.ts` 新增純函式 `demoStateOf(sessions)` 與 `watchDemoState(detection, listener)`（只在示範狀態真的改變時通知；「休息中」的結束再開在同一次通知內，不會出現中間的 null）。`main.ts` 在 `startupStep('tray')` 內接上 `showTrayDemoState`：用 `getMenuItemById` 設 `checked`，有移動才重設 `tray.setContextMenu`（Linux 要重設才會顯示；勾選已在原位時不重設）。
  - overlay：`pointer.ts` 是純函式的狀態機（`pointerMoved`、`pointerLeft`、`areasChanged`），回傳下一個狀態與要送的請求。可點區域改變而游標沒動時，只會送「不在」：方塊在靜止游標下出現不會關閉穿透，等下一次移動，因為最後的游標位置可能已經過時（forward 的移動在視窗邊緣就停了），過時的「在上面」會擋住底下視窗的點擊。
  - 方塊太小的世界（寬小於 144 DIP 或高小於 216 DIP）把方塊夾在左上邊緣，不畫到畫面外。標籤字型 `sans-serif` 22 粗體；深色字用 `#212121`。
  - overlay 只在方塊有變（出現、改狀態、跟著世界移動、消失）時重畫並 `app.render()` 一次；PixiJS 的 resize plugin 在視窗大小改變後會自己再 render。
- 審查修補（主 session 交辦，7 項）：
  - 滑鼠與 IPC 的狀態和接線從 `src/overlay/main.ts` 移到新的 `src/overlay/canvas-input.ts`（不含 DOM／PixiJS 型別，`api`、`draw` 由外部傳入），`main.ts` 只轉送 `clientX/clientY` 並依回傳值 `preventDefault`；測試在 `test/overlay/canvas-input.test.ts`。
  - 畫布初始化完成（`onCanvasReady`）並真的畫出方塊之前，可點區域保持為空；`initCanvas` 失敗時永遠不會有看不見的 120×120 區域攔截滑鼠或開選單。
  - 右鍵送出選單請求後，視同游標離開（`pointerLeft`，送下一個 `seq` 的 `over: false`）：原生選單關掉後，不會因 overlay 還以為游標在方塊上而吞掉一次點擊，下一次移動再重新判定。
  - 畫布頁面 `unresponsive` 時，若是目前視窗且不穿透，main 恢復 `setClickThrough`、`over` 改為 false、`seq` 保留，並記一筆 `windows` warn。
  - `approval`、`done` 也改用深色字（白字對比只有約 2.8:1、2.2:1）：深色字現在是 `approval`、`decision`、`done`、`waiting`。這改了 Design Notes「文字用白色；decision、waiting 改用深色字」的寫法。
  - 方塊離右緣 24 DIP，離下緣改為 96 DIP（`DEMO_SQUARE_BOTTOM_MARGIN`），避開 Windows 工作列（48 DIP）與 macOS 底部 Dock；依工作區域放置留給 Epic 3 的角色。這改了 Code Map「距邊緣 24 DIP」的寫法。
  - `pointer.ts` 改用 shared 的 `CanvasHover` 型別（`import type`），刪掉重複的 `HoverRequest`。
- 驗證：開發代理跑過 `npm run typecheck`、`npm run lint`、`npm test`（42 個檔案、1929 個測試，基準 1788）、`npm run depcruise`（0 違規），全部通過。I/O 矩陣：出現／跟著變／消失在 `test/overlay/demo-square.test.ts`；移到方塊上／移開／消失時送「不在」在 `test/overlay/pointer.test.ts`；main 端的切換、冪等、過時、畫布重載與重建、Linux 不切換、壞請求在 `test/main/windows-canvas.test.ts`；右鍵選單內容、從選單選、不是示範 session、兩個入口同步（含以真的 `createDetection` 照 `main.ts` 接線的端到端測試）在 `test/main/windows-tray.test.ts`；`watchDemoState` 在 `test/main/detection.test.ts`；`main.ts` 接線在 `test/main/windows-main.test.ts`；新 schema 的往返與拒絕在 `test/shared/ipc.test.ts`，preload 到 main 在 `test/preload/overlay.test.ts`。PixiJS 繪圖與 DOM 事件（`overlay/main.ts`）沒有單元測試。
- 用隔離的 `--user-data-dir`（scratchpad 暫存資料夾）跑 `npm start`：`canvas ready (renderer webgl, 1920x1080)`，等過 `syncTimeoutMs` 後 run log 沒有 `windows`、`detection`、`stage-view` 錯誤，console 也沒有錯誤，之後停止，沒有殘留行程。畫布、方塊與系統匣沒有實際操作（無法自動化、不截圖），使用者驗收那幾項尚未做。
- 主 session 核對：讀過 `d349857` 以來的完整 diff，6 項任務與 2 條驗收條件都已完成。重跑 typecheck、lint、`npm test`（42 個檔案、1929 個測試、0 跳過）、depcruise（0 違規），全部通過；I/O 矩陣 12 列都有測試並已執行。開發代理在 `deferred-work.md` 既有的兩筆（方塊空殼、系統匣勾選同步）後面加了「已解決」；依「只增不改」的規則已還原，兩筆由本規格解決，記錄在此。`npm ci` 因 npm 快取寫入權限失敗，worktree 的 `node_modules` 是從主資料夾以 APFS 複製（lockfile 相同）。
- 主 session 修補後核對：讀過 `src/overlay/canvas-input.ts` 與 `main.ts` 的接線，7 項修補都已到位。重跑 typecheck、lint、`npm test`（43 個檔案、1946 個測試）、depcruise（0 違規），全部通過。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-10）。審查員代號：VG＝verification-gap，B＝blind-hunter，E＝edge-case-hunter。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| VG1、B8 | `overlay/main.ts` 的滑鼠與 IPC 接線（`apply` 保存狀態、`showView` 送「不在」、`mousemove`／`contextmenu` 用 client 座標）沒有任何測試實際跑過 | medium | patch | gap 預先驗證：只有 `guard-rules.test.ts` 讀這個檔的原始碼；`pointer.test.ts`、`demo-square.test.ts` 在測試裡自己串起純函式。比照 `start.ts`，把接線抽成注入 api 的模組再測 |
| B1、E1、E8 | 畫布還沒畫好（`initCanvas` 尚未完成或失敗）時，可點區域照樣設定：右下角一塊看不見的區域會關掉穿透、右鍵也會跳選單 | medium | patch | 程式確認：`start.ts` 先訂閱 StageView 再初始化畫布，`showView` 設定 `areas` 不看 `drawing` |
| B2 | 右鍵選單關閉後，overlay 仍以為游標在方塊上、main 維持不穿透；下一次移動前，選單項目所在位置的點擊會被畫布吃掉 | low | patch | 程式確認：選單開著時 overlay 收不到移動，選完後方塊與區域沒變，`areasChanged` 不送請求。修法是送出右鍵請求後，overlay 視同游標離開（送 `over: false`），下一次移動再重新判定 |
| B3、E4 | overlay 卡住（renderer 無回應）時若正好不穿透，整個螢幕的點擊都被吃掉，送不出 `over: false` | medium | patch | 改動前畫布永遠穿透，這是新出現的失敗方式；`BrowserWindow` 有 `unresponsive` 事件可以恢復穿透 |
| B7 | `done`（綠）、`approval`（橘）的白字對比度約 2.2:1、2.8:1，不好辨識 | low | patch | 對比度計算確認；驗收第一步就要看「要你批准」。改用深色字，與 `decision`、`waiting` 相同 |
| B12 | `pointer.ts` 的 `HoverRequest` 與 `src/shared/ipc.ts` 的 `CanvasHover` 重複定義 | low | patch | 改成 `import type`，之後改一邊不會分歧 |
| E7 | 方塊距底邊只有 24 DIP：Windows 工作列、macOS 下方的 Dock 會蓋住方塊下半部，右鍵點到工作列或 Dock | medium | patch | 畫布視窗涵蓋整個螢幕（不扣工作區），Windows 工作列預設 48 DIP 高、橫跨整個底邊。最小修法是加大底邊距離；用工作區定位要在 StageView 加欄位，留給 Epic 3 的真角色 |
| E5、E6、E9 | `idleMs` 與 `sessionExpireMs` 都設成 1 小時（範圍允許）時，選「休息中」的示範 session 會立刻逾時：方塊消失、系統匣勾選跳回「關閉」，示範轉接器卻還在跑 | low | defer | 程式確認：Story 2.3 的「休息中」把時間回推 `idleMs`，兩者相等時逾時點就是現在。這是 2.3 示範轉接器原有的問題，本次的勾選同步只是把它顯示出來 |
| B4、E2 | `canvas:set-hover` 回傳失敗時 overlay 不重送，main 可能維持不穿透 | low | reject | 要 IPC 本身失敗才會發生（通道已註冊、輸入由 overlay 自己組），日常不會遇到；修法要加回退分支 |
| B5 | overlay 以 `source === 'demo'` 找示範 session，main 以 `DEMO_SESSION_KEY` 判斷，兩邊可能分歧 | low | reject | 示範轉接器只有一個 session、key 固定為 `demo:1`；方塊在 Epic 3 移除 |
| B6 | 方塊位置用 StageView 要求的視窗大小，不是實際大小 | low | reject | AD-14 規定世界大小取 `canvas.bounds`；實際大小不符時 `checkBounds` 已記警告，Windows DPI 偏差另有 deferred 項目 |
| B9 | run log 沒有穿透切換、重設、外來頁面請求的紀錄 | low | reject | 驗收時直接觀察得到；逐次記錄移入／移出會很吵 |
| B10 | `tray.setContextMenu` 丟例外後，勾選資料與 Linux 上的顯示會一直不一致 | low | reject | `setContextMenu` 實務上不會丟例外；已有錯誤紀錄 |
| B11 | `checkDemoItem` 找不到 id 時不記錄 | low | reject | id 與選單 template 由同一個 `demoItemId` 產生，測試已涵蓋 |
| B13 | 系統匣端到端測試在斷言失敗時不會 `detection.stop()`，計時器殘留 | low | reject | 只在測試已失敗時影響後續測試 |
| E3 | 重新載入失敗、提交錯誤頁時只有 `did-fail-load`、沒有 `did-navigate`，穿透不會恢復 | maybe-false（若成立為 low） | reject | 打包版不會重新載入畫布（當掉時重建新視窗，已正確歸零）；只在開發時的重載會遇到，要確認 Electron 提交錯誤頁時是否也發 `did-navigate` |

## Design Notes

**方塊的顏色**（只供驗收）：文字用白色；`decision`、`waiting` 的底色較淺，改用深色字。

| 狀態 | 顏色 |
|---|---|
| `thinking` | `#7c4dff` 紫 |
| `working` | `#2979ff` 藍 |
| `approval` | `#ff6d00` 橘 |
| `decision` | `#ffd600` 黃 |
| `error` | `#d50000` 紅 |
| `done` | `#00c853` 綠 |
| `waiting` | `#b0bec5` 淺灰 |
| `idle` | `#546e7a` 深灰 |

**已知風險，要在實機確認：**
- 畫布視窗是不可聚焦的（macOS `panel`、Windows `toolbar`），在它上面跳原生選單：macOS 應該可行；Windows 上點選單外面時，選單可能不會自己關掉。
- 游標停在方塊上不動時，畫布維持不穿透。這只影響方塊那一小塊；游標一移動就會重新判定。

## Verification

**Commands:**
- `npm run typecheck`：無錯誤
- `npm run lint`：無錯誤
- `npm test`：全部通過，含新增測試
- `npm run depcruise`：無違規

**Manual checks:**
- 開發代理：用 `--user-data-dir` 指向隔離的資料夾執行 `npm start`，確認啟動後 run log 沒有錯誤。不碰使用者的 app，也不截圖；畫布與系統匣無法自動操作。
- 使用者驗收（macOS，以及能的話 Windows）：
  - 從系統匣打開示範模式，方塊出現；
  - 對方塊按右鍵，依序選 8 種狀態，方塊與「管理 session」頁跟著變；
  - 方塊以外的地方，點擊照樣落到下面的視窗；
  - 選「關閉示範模式」後，方塊消失。
