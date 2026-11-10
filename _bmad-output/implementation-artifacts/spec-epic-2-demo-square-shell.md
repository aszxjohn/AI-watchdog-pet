---
title: 'Epic 2 驗收用：示範模式的方塊角色空殼與右鍵選單'
type: 'feature'
created: '2026-11-10'
status: 'ready-for-dev'
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
- [ ] `src/shared/ipc.ts`、`src/shared/preload-api.ts`、`src/preload/overlay.ts`：兩個通道與 API。
- [ ] `src/overlay/pointer.ts`、`demo-square.ts`、`main.ts`：hit-test、方塊、右鍵。
- [ ] `src/main/windows/canvas-window.ts`、`menu.ts`：穿透切換、`seq`、選單。
- [ ] `src/main/main.ts`（以及必要時的 `detection.ts`）：接線。
- [ ] 測試：I/O 矩陣每一列（繪圖除外），以及新 schema 的往返與拒絕。
- [ ] `deferred-work.md`：加一筆「Epic 3 真角色上畫布後移除方塊空殼，保留 `pointer.ts` 與兩個通道」。

**Acceptance Criteria:**
- Given 這項工作完成，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when app 啟動完成，then run log 沒有 `windows`、`detection`、`stage-view` 錯誤。

## Implementation Notes

## Spec Change Log

## Review Triage Log

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
