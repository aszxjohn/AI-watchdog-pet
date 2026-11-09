---
title: 'Epic 1 收尾：回顧修正項'
type: 'bugfix'
created: '2026-11-09'
status: 'done'
baseline_commit: '354bf03b2776f280b9dbe9fefd21d0734a736534'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-retro-2026-11-06.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 1 回顧找到幾個 story 之間接縫的問題，要在 Epic 2 之前修掉：
- ⌘H 會把畫布一起藏起來（R2）；
- 啟動流程丟錯時，tray 不會建立，運行紀錄也查不到原因（R1）；
- `main/ipc` 與 `main/windows` 互相依賴，卻沒有規則管（R5）；
- 畫布借用面板的 webPreferences（R6）；
- 三個測試驗不到它名稱說的東西（R7–R9）；
- 面板開著時點 Dock 或再啟動一次，頁面被強制切回「管理 session」（R3）。

**Approach:** 對應回顧行動項目 A1–A5 與 A7（使用者 2026-11-06 決定合成一個 story），只修上述問題，不加新功能。

**Decisions（2026-11-09 使用者決定）：**
- A7 做，`activate` 與 `second-instance` 都改：面板開著就只帶到前景、不切頁；沒開才開主面板。這刻意修改了 Story 1.5 I/O 矩陣「再啟動一次」在面板已開時的行為。
- ⌘H 改為「關閉面板」，效果與 ⌘W 相同：Dock 圖示跟著消失，下次從選單列打開。

## Boundaries & Constraints

**Always:**
- 啟動接線（ready 之後各步、`second-instance`、`activate`）任何一步丟錯都記一行 error，內容含 `errorCode`。
- 除了 session 防護，其他步驟失敗都不能阻止 tray 建立。session 防護失敗時，顯示原因並以 `app.exit(1)` 結束，與找不到 preload 時相同；不在沒有防護的 session 上開視窗。
- 選單內容仍只在 `src/main/windows/menu.ts` 定義（AD-14）。
- AD-24 的 webPreferences 基準只定義一次，放在 `security.ts`；面板與畫布各自展開。
- 新加的 dependency-cruiser 規則各有一個會觸發的守門反向測試。

**Never:**
- 不改 StageView、設定、IPC 契約與 schema。
- 不處理延後項目 R4、R10–R16。
- 不動 `prototypes/`。
- 不執行寫入類 git 指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ⌘H | macOS，面板在前景，按 ⌘H 或點應用程式選單的「關閉面板」 | 面板關閉，記一行；畫布留在螢幕上；應用程式選單沒有「隱藏」「隱藏其他」「顯示全部」 | 沒有面板開著時，什麼都不做 |
| 再啟動／點 Dock，面板已開 | 面板開在任一頁，觸發 `activate` 或 `second-instance` | 面板帶到前景，頁面不變，記一行 | — |
| 再啟動／點 Dock，面板沒開 | 沒有面板，觸發 `activate` 或 `second-instance` | 打開主面板（管理 session），記一行 | — |
| 啟動某步丟錯 | ready 後的選單、`app://`、Dock、畫布或電源監看丟錯 | 記一行 error（步驟名稱＋`errorCode`），其餘步驟照跑，tray 建立 | — |
| session 防護丟錯 | `installSessionGuards` 丟錯 | 記一行 error，顯示錯誤框，`app.exit(1)` | 不建立 tray、畫布 |
| 再啟動／activate 丟錯 | `panels.open` 丟錯 | 記一行 error，沒有 unhandled rejection | — |
| 面板當掉 | 面板 renderer 當掉或主框架載入失敗 | 記一行；銷毀延到下一個 task，與畫布相同 | — |

</frozen-after-approval>

## Code Map

- `src/main/main.ts`
  - 121–126：`flushSettingsOnQuit` 先註冊，`will-quit` 記 quit 後註冊（R8 要驗的順序）。
  - 158–174：`second-instance`、`activate` 的 `.then` 沒有 `.catch`。
  - 181–196：ready 鏈依序為 `installSessionGuards` → `Menu.setApplicationMenu` → `handleAppProtocol` → `dock.hideAtStartup` → `createTray` → `watchDisplays` → `watchPower`。
  - `preloadPath()` 是「顯示原因並 `exit(1)`」的現成寫法。
- `src/main/log/run-log.ts`：`errorCode(error)`、`logEvent`。
- `src/main/windows/menu.ts:62-72`：要換掉的 `hide`、`hideOthers`、`unhide` 角色。`applicationMenuTemplate(platform)` 目前不收動作參數；tray 選單的 `TrayMenuActions` 可以參照。
- `src/main/windows/panel-window.ts`
  - 44–55：`panelWebPreferences` 要移到 security。
  - 163–168、197–202：`close()` 同步 `destroy()`。
  - `PanelWindows` 目前只有 `open`、`isOpen`。
- `src/main/windows/canvas-window.ts`
  - 46、101：借用 `panelWebPreferences`。
  - 236–245：`defer` 選項，預設 `setTimeout(run, 0)`，可重用。
- `src/main/windows/security.ts`：AD-24 執行期防護，基準設定移到這裡。
- `src/main/windows/dock.ts`：用計數控制 Dock，`panelClosed` 減到 0 就隱藏。
- `src/preload/stage-view.ts:176-188`：取消訂閱時重設 `fetching = false`（R7 要保護的那一行）。
- `.dependency-cruiser.cjs`：目前 11 條規則。`src/main/ipc/origin.ts:11` → `windows/environment.ts` 是唯一一條 ipc→windows；`canvas-window.ts` → `ipc/origin`、`ipc/register` 是 windows→ipc，維持不變。
- `test/tooling/guard-rules.test.ts:239-330`：dependency-cruiser 反向測試，含 `RULES` 清單與 fixture 樹。
- `test/main/windows-main.test.ts`
  - 125：`flushSettingsOnQuit` 被 mock 成只記名稱，所以 454–460 的測試觀察不到先後。
  - 412：`activate` 測試。
- `test/main/ipc-register.test.ts:155`：5174 已是 overlay 的 dev server（43 行），要換埠。
- `test/preload/stage-view.test.ts`：沒有「訂閱 → 取消 → 再訂閱」的案例。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/windows/security.ts`：新增 `secureWebPreferences(preload)`，內容是 AD-24 的基準。
- [x] `src/main/windows/panel-window.ts`：
  - 改用 `secureWebPreferences`，刪除 `panelWebPreferences`。
  - `close()` 先記錄並清掉 `current`，`destroy()` 改經可注入的 `defer`（預設下一個 task）。
  - `PanelWindows` 加兩個方法：
    - `close()`：一般關閉（`win.close()`），沒開時不做事；
    - `openOrFocus(page)`：已開時只帶到前景、不換頁，沒開時才建立。
  - 理由：R6、R17、A2、A7。
- [x] `src/main/windows/canvas-window.ts`：webPreferences 改成 `secureWebPreferences` 加上 `backgroundThrottling: false`。
- [x] `src/main/windows/menu.ts`：`applicationMenuTemplate(platform, actions)`。拿掉三個角色，加上自訂項目「關閉面板」（`accelerator: 'Command+H'`，呼叫 `actions.closePanel()`），並更新檔頭註解。
- [x] `src/main/main.ts`：
  - ready 鏈每步各自 try/catch，失敗記 `startup step <名稱> failed: <errorCode>`；session 防護失敗時改走錯誤框加 `exit(1)`。
  - `second-instance`、`activate` 加 `.catch`，改呼叫 `panels.openOrFocus(MAIN_PANEL_PAGE)`；紀錄分「opening the main panel」與「bringing the open panel to the front」兩種。
  - 選單的 `closePanel` 接到 `panels.close()`。
  - 更新檔頭與 `activate` 的註解。
- [x] `.dependency-cruiser.cjs`：
  - `no-circular`（`from: ^src/`、`to: { circular: true }`）；
  - `main-ipc-only-windows-environment`：`^src/main/ipc/` 只能 import `src/main/windows/` 的 `environment.ts`。
- [x] `test/tooling/guard-rules.test.ts`：兩條新規則加進 `RULES`，各給一個會觸發的 fixture。
- [x] 測試，I/O 矩陣每列都要有：
  - `test/main/windows-tray.test.ts`（現有的應用程式選單測試在這裡）：選單沒有三個角色、⌘H 項目會呼叫動作。
  - `test/main/windows-main.test.ts`：
    - 各啟動步驟丟錯；
    - session 防護丟錯；
    - `second-instance`／`activate` 丟錯；
    - R8：mock 的 `flushSettingsOnQuit` 也註冊一個 `will-quit`，斷言觸發順序是先寫設定、再記 quit；
    - `activate`、`second-instance` 在面板已開與沒開時的行為，取代「open or not 都開主面板」的舊測試。
  - `test/main/windows-panel-window.test.ts`：延後銷毀，以及新增的面板方法。
  - `test/main/windows-canvas.test.ts`：webPreferences 來自基準。
  - `test/main/ipc-register.test.ts`：R9，改用兩個 dev server 都不是的埠（例如 5175），並斷言紀錄內容是 `origin not allowed`。
  - `test/preload/stage-view.test.ts`：R7，同步「訂閱 → 取消 → 再訂閱」之後，新的訂閱者收到快照。

**Acceptance Criteria:**
- Given 完成實作，when 執行 `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`，then 全部通過。
- Given 刪掉 `src/preload/stage-view.ts` 的 `fetching = false`，或把 `main.ts` 記 quit 的監聽移到 `flushSettingsOnQuit` 之前，when 跑對應測試，then 會失敗。開發代理要在自己的複本上實際做過這兩個 mutation 確認，再還原。
- Given `npm start`（隔離的 `--user-data-dir`），when 打開面板後觸發 ⌘H 對應的選單項目，then 畫布視窗仍可見（`isVisible()` 為 true），運行紀錄沒有 error。

## Implementation Notes

- 四項檢查實際執行並通過：`npm run typecheck`（兩份 tsconfig）、`npm run lint`（oxlint＋oxfmt）、`npm test`（31 個檔、980 個測試；基準 948 個）、`npm run depcruise`（115 個模組、377 條依賴，無違規）。
- I/O 矩陣對應測試：
  - ⌘H：`windows-tray`（選單沒有 `hide`／`hideOthers`／`unhide`；⌘H 只有「關閉面板」一項、不是 role、點了只呼叫 `closePanel`；建出來的選單接到同一組動作）、`windows-main`（`closePanel` 接到 `panels.close()`）、`windows-panel-window`（`close()` 走 `win.close()`，觸發 `closed` → Dock 計數減一、記 `panel closed`；沒開時什麼都不做）。
  - 再啟動／點 Dock，面板已開或沒開：`windows-main`（`second-instance`、`activate` 各三案：沒開記 `opening the main panel`、已開記 `bringing the open panel to the front`，兩者都呼叫 `openOrFocus(sessions)`）＋`windows-panel-window`（`openOrFocus` 已開時只 restore／show／focus、不載入、不記「切頁」；沒開時建立）。
  - 啟動某步丟錯：`windows-main` 的 `it.each`（menu、app-protocol、dock、tray、canvas、power 六步各丟一次 `code: EFAKE`），斷言只有一行 `app: startup step <名稱> failed: EFAKE`，其餘步驟照順序都有執行、tray 有建立。
  - session 防護丟錯：`windows-main`，順序只有 `installSessionGuards` → 錯誤框 → `app.exit 1`，沒有選單、tray、畫布、電源監看；紀錄一行 `startup step session-guards failed: EFAKE. …`。
  - 再啟動／activate 丟錯：`windows-main`，`openOrFocus` 丟錯時記 `windows: <事件> failed: EFAKE`，`unhandledRejection` 沒有發生。
  - 面板當掉：`windows-panel-window`（載入失敗與 renderer 消失都是先記錄、`isOpen()` 立即為 false，`destroy()` 等延後的工作執行才發生；預設 `setTimeout 0`；同一個視窗連續兩個錯誤只記一行、只銷毀一次；等待銷毀期間 `ready-to-show` 不會把它顯示出來；等待期間可以開新面板，Dock 計數正確、`close()` 作用在新面板）。
  - R6：`windows-security`（`secureWebPreferences` 逐欄斷言、每次回傳新物件）、`windows-panel-window`（面板的 webPreferences 嚴格等於基準）、`windows-canvas`（三個平台都是基準加 `backgroundThrottling: false`）。
  - R7：`preload/stage-view` 新增「訂閱 → 取消 → 再訂閱（同步）」案例：第一次快照晚到被丟掉，新的訂閱者只收到第二次快照，之後的增量照常。
  - R8：`windows-main` 的 `flushSettingsOnQuit` mock 也註冊 `will-quit`，斷言事件順序為 `settings flushed` → `log app: quit`。
  - R9：`ipc-register` 改用 5175，並在拒絕案例表加上預期原因欄（`frame is null`、`not a top-level frame`、`origin not allowed`），斷言紀錄以 `sender rejected: <原因>` 開頭。
  - 新規則：`guard-rules` 的 `RULES` 加入 `no-circular`、`main-ipc-only-windows-environment`；fixture 為 `src/main/cycle-a.ts` ↔ `cycle-b.ts`，以及 `src/main/ipc/to-windows.ts` → `windows/target.ts`；另有一個 `ipc/to-environment.ts` → `windows/environment.ts` 不違規的案例。dependency-cruiser 一個循環只回報一次（從先走到的檔案），所以斷言改成不分方向。
- Mutation 確認（在 scratchpad 的複本上做，`node_modules` 用 symlink，做完逐一還原並與 repo 比對一致）：
  - 刪掉 `src/preload/stage-view.ts` 取消訂閱裡的 `fetching = false`：只有新的 R7 測試失敗（21 個中 1 個）。
  - 把 `main.ts` 記 quit 的 `will-quit` 監聽移到 `flushSettingsOnQuit` 之前：只有 R8 測試失敗（29 個中 1 個）。
  - 額外：把 R9 的埠改回 5174，該案例失敗（實際原因變成 `renderer overlay may not use this channel`）。
- `npm start`（未截圖）：使用者的打包版仍在 `out/` 執行（PID 29189），沒有碰它與真實 userData；改用 `--user-data-dir=<scratchpad>`，加 `--inspect-electron`，從 main inspector 操作與讀取。結果：
  - 啟動紀錄依序 `app start`、`dock icon hidden (startup)`、`tray icon created`、`displays: 2 connected`、畫布建立、overlay 訂閱、`canvas ready (renderer webgl, 1920x1080)`，沒有任何 error。
  - 實際的應用程式選單：第一個選單只有 `close-panel｜關閉面板｜Command+H`、分隔線、`結束`；沒有隱藏類項目。
  - `app.emit('activate')`（沒有面板）→ `app activated: opening the main panel`、面板開在 `#/sessions`。把面板切到 `#/settings` 後再 `activate` 與 `second-instance` → 紀錄 `bringing the open panel to the front`，網址仍是 `#/settings`，沒有開第二個視窗。
  - 點「關閉面板」（`Menu.getApplicationMenu().getMenuItemById('close-panel').click()`）→ 面板關閉、`dock icon hidden (no panel open)`、`panel closed`；畫布 `isVisible()` 為 true。沒有面板時再點一次，沒有任何紀錄、畫布仍可見。之後 `second-instance` 重新打開主面板，再關閉一次，結果相同。
  - 到這一步為止，運行紀錄與 main 的 stderr 都沒有 error 行。
  - 額外驗證「面板當掉」：對面板 `forcefullyCrashRenderer()` → 一行 `panel closed after an error: renderer gone (killed, exit code 2)`（預期的 error）、`dock icon hidden`、`panel closed`，main 照常，`activate` 可以再開面板。最後 `app.quit()`，紀錄 `canvas window closed`、`panel closed`、`app quit`，行程結束；PID 29189 仍在執行。
  - 沒有實際送出 ⌘H 按鍵：用 System Events 送鍵時若前景不是這個 app，會把使用者正在用的其他 app 藏起來，所以改點選單項目，並從實際選單確認 accelerator 是 `Command+H`。按鍵本身留給打包版手動驗收（Verification 的 Manual checks）。
- spec 以外的決定：
  - ⌘H 的「記一行」就是面板 `closed` 事件的 `panel closed`（與 ⌘W 相同，一次 ⌘H 一行），`close()` 本身不另外記，以免同一動作兩行；需要區分 ⌘H 與 ⌘W 時再加。
  - `startup step <名稱>` 的名稱：`session-guards`、`menu`、`app-protocol`、`dock`、`tray`、`canvas`（`watchDisplays`）、`power`；類別都是 `app`。`second-instance`／`activate` 失敗記在 `windows` 類別：`<事件> failed: <errorCode>`。
  - session 防護失敗與找不到 preload 共用新的 `exitBecause(reason)`（記 error、錯誤框、`app.exit(1)`）。
  - 面板的錯誤關閉加了「同一視窗只處理一次」與「等待銷毀時不顯示」兩個保護：延後銷毀之後，同一個視窗在銷毀前可能再收到第二個錯誤事件或 `ready-to-show`，同步銷毀時不會發生。
  - `PanelWindowHandle` 加 `close()`；選單項目 id 為 `close-panel`，標籤常數 `CLOSE_PANEL_LABEL`；動作型別 `ApplicationMenuActions`。
  - 第二個行程印在 console 的那行從「(it opens its main panel)」改成「(it brings up its panel)」，因為 A7 之後面板已開時不再切到主面板（同時更新對應測試）。
- 已知限制與風險：
  - 只處理本 app 自己選單的 ⌘H。面板開著、Dock 圖示出現時，Dock 圖示右鍵選單的「隱藏」，以及別的 app 的「隱藏其他」，仍走 macOS 的整個 app 隱藏，會把畫布一起藏起來（回顧「未解問題」已列後者，前者這次才注意到，都沒有實測）。
  - 面板之後若有擋下關閉的頁面（Epic 2 編輯頁），`close()` 走 `win.close()` 可能被取消；目前沒有任何頁面會擋（與 R12 同一類）。
- 開發代理使用了允許的唯讀 git（`status`、`diff --stat`、`log`）。mutation 測試時誤把一個備份檔先複製到 `/tmp/sv.bak`，隨即刪除；其餘暫存檔都在 scratchpad。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 `no-circular` 說涵蓋 `import type`，但 fixture 兩邊都是一般 import | medium | patch | 已預先查證的缺口：關掉 `tsPreCompilationDeps` 或加上 `dependencyTypesNot: ['type-only']` 時，測試仍會過；而 ipc↔windows 現在本來就經過一條 type-only 邊（`canvas-window.ts:41`）。改 fixture 即可，不加新介面。 |
| B1 選單步驟失敗時，Electron 的預設選單（含 Hide、DevTools）留著 | low | reject | 確實會發生（Electron 沒設選單時會給預設選單），但 `buildApplicationMenu` 用的是靜態樣板，不會丟錯；修正要在 catch 裡多一個分支。 |
| B2 `app-protocol` 失敗時畫布仍會建立並載入失敗，根因被後面的錯誤淹沒 | low | reject | `startup step app-protocol failed` 是第一行 error，根因看得到；`protocol.handle` 只有重複註冊才會丟錯；跳過畫布要加狀態。 |
| B3 session 防護失敗時，ready 前排入的 `second-instance`／`activate` 仍會開面板 | low | reject | 微任務順序確實如此，但前提是 session 防護丟錯（沒有實證），而且打包版那時 `app://` 尚未註冊，視窗載入失敗，行程隨即結束；修正要加旗標。與 E1 同一項。 |
| B4 ready 鏈外層沒有 `.catch`；ready 前的步驟沒包；沒有全域例外處理 | low | patch | 外層鏈沒有 `.catch`，與 A1「啟動鏈補上 `.catch`」字面不符，補一行即可。ready 前的步驟不在凍結範圍（Always 只寫 ready 之後），而且 Electron 對 main 未捕捉的例外會跳出錯誤框，不是靜默失敗，這部分不處理。 |
| B5 `main.ts` 檔頭說「tray 一定會建立」，但 tray 本身失敗或防護失敗時都沒有 tray | low | patch | 註解與程式不符，改寫成「其他步驟失敗不會擋住 tray」。 |
| B6 A7 改了「再啟動一次」，但需求文件與 `activate` 註解仍寫「打開主面板」 | medium | patch | `epics.md:28,257`（FR7、Story 1.5 驗收條件）、`SPEC.md:35-36` 沒改；`main.ts` 的 `activate` 註解引用 I/O 矩陣「再啟動一次」。Story 1.5 的 E13 就是審查員依舊文字把行為「修回」一律切頁，舊文字留著會重演。已完成的 spec-1-5 與驗收紀錄是歷史紀錄，不改。 |
| B7 A2 要求的「面板在前景按 ⌘H，畫布仍在」沒有加進驗收清單 | low | patch | 回顧 A2 明寫要加；在 `epic-1-acceptance.md` 補一項待驗。 |
| B8 新發現的限制（Dock 右鍵「隱藏」、`close()` 可能被擋）只寫在 spec | medium | defer | 兩者都不是這個 story 造成的，改記進 `deferred-work.md`。與 E5 同一項。 |
| B9 `no-circular` 註解說「資料夾之間的循環」，規則只看檔案 | low | patch | 改註解：檔案層級的循環由它擋，ipc／windows 的方向由第二條規則擋。 |
| B10 `environment.ts` 若轉出其他 windows 模組，可繞過第二條規則 | low | reject | 目前 `environment.ts` 只 import `protocols.ts` 與 shared；要再加一條葉節點規則才擋得住，屬於假設的未來。 |
| B11 type-only 循環沒有測試 | medium | patch | 與 VG1 同一項。 |
| B12 `openOrFocus` 在 `ready-to-show` 前就 `show()` | low | reject | `open()` 從 Story 1.5 起就是這樣（既有行為）；要兩次啟動間隔短於第一次載入才會看到；修正要追蹤 ready 狀態。 |
| B13 `showPanelOn` 用 `isOpen()` 決定紀錄文字，`openOrFocus` 自己再判斷一次 | low | reject | 兩者都讀同一個 `live()`，目前不會分歧；改回傳值是新增公開介面。 |
| B14 錯誤紀錄只有 `Error` 名稱，看不出原因 | false | reject | `errorCode` 是 Story 1.4 的刻意設計：「Never the message, which can quote file contents」（`run-log.ts:201-205`）；紀錄有步驟名稱與錯誤碼，符合規格寫的「含 `errorCode`」。 |
| B15a 沒有模擬 `Menu.setApplicationMenu` 本身丟錯 | low | reject | 與 `buildApplicationMenu` 丟錯走同一個 `startupStep` catch，現有測試已涵蓋這條路徑。 |
| B15b 防護失敗的測試把錯誤框標題寫死 | low | reject | 與既有「找不到 preload」測試寫法相同，純屬風格。 |
| B15c R9 的 5175 是寫死的，沒和兩個 dev server 常數比對 | low | patch | 補一行斷言，確認 5175 不是兩個 dev server 的埠，之後改埠時測試會提醒。 |
| E1 session 防護失敗後，排隊中的再啟動仍開面板 | low | reject | 與 B3 同一項。 |
| E2 選單步驟失敗時留下預設選單 | low | reject | 與 B1 同一項。 |
| E3 tray 本身丟錯時，Dock 已隱藏，app 沒有任何入口 | low | reject | 改動前就是這樣（丟錯後什麼都沒有）；`new Tray` 不會因圖示讀不到而丟錯；macOS 仍可從 Finder 再啟動開面板，再從選單結束。 |
| E4 `app-protocol` 失敗後畫布與面板都載入失敗 | low | reject | 與 B2 同一項。 |
| E5 Dock 右鍵「隱藏」或別的 app 的 ⌥⌘H 仍會藏起畫布 | medium | defer | 屬於 R2 同類，但不是這個 story 造成的；凍結範圍只處理 ⌘H。與 B8 同一項。 |
| E6 面板有未存內容時按 ⌘H 會丟掉 | false | reject | 使用者 2026-11-09 已決定 ⌘H＝關閉面板；目前沒有任何頁面有未存內容，Epic 2 的關閉保護會一併涵蓋 ⌘W 與 ⌘H。 |
| E7 `stage-view.ts` 有兩行 `fetching = false`，刪錯行時 mutation 會過 | false | reject | 實作紀錄寫明刪的是取消訂閱裡那一行（第 187 行），結果只有 R7 測試失敗；Code Map 也指定 176–188 行。 |
| E8 ready 前的步驟丟錯時仍沒有 tray 與紀錄 | low | reject | 與 B4 後半同一項：凍結的 Always 只涵蓋 ready 之後，而且 Electron 會跳出錯誤框。 |
- 審查修補（第 1 輪；只跑了涵蓋修改檔案的測試：`windows-main`、`ipc-register`、`guard-rules`，共 150 個通過，完整驗證由協調者執行）：
  - `main.ts`：ready 之後的啟動鏈外層加 `.catch`，步驟以外丟出的錯誤（包括 `exitBecause` 本身）記一行 `app: startup failed: <errorCode>`。新測試讓 session 防護與錯誤框都丟錯，斷言這一行且沒有 `unhandledRejection`；在複本上拿掉 `.catch` 時該測試失敗。
  - `main.ts` 檔頭第 3 點改成「其他步驟失敗不會阻止 tray 建立」（tray 這一步本身失敗或 session 防護失敗時沒有 tray）；`activate` 的註解改為直接描述新行為（面板已開就帶到前景、留在原頁，否則打開主面板），並註明這取代 Story 1.5 的「再啟動一次」行為（Epic 1 回顧 A7），不再指向舊的 I/O 矩陣列。
  - `.dependency-cruiser.cjs`：`no-circular` 的說明改成「抓檔案之間的 import 循環（經 `tsPreCompilationDeps` 含 type-only import）」，資料夾方向由 `main-ipc-only-windows-environment` 負責。
  - `guard-rules`：循環 fixture 改成 `cycle-b.ts` 以 `import type { A } from './cycle-a'` 閉合，原斷言不變；在複本上把 `tsPreCompilationDeps` 改成 false 時，`no-circular` 的兩個測試都失敗。
  - `ipc-register`：R9 的埠改成常數 `NON_DEV_SERVER_URL`，另加一個測試斷言它的 origin 與兩個 dev server 的 origin 都不同。

## Design Notes

**session 防護為什麼例外：** 其他步驟失敗時，app 只是少一個功能。session 防護失敗後如果還開面板，面板就跑在沒有權限拒絕和請求過濾的 session 上。所以失敗時寧可停下、說明原因。

**R7 的情境：** React StrictMode 開發版會「訂閱 → 立刻取消 → 再訂閱」。第一次取得快照還在途中就被取消，`generation` 前進後，舊結果會被丟掉。如果沒有把 `fetching` 重設，第二次訂閱就不會重新取得快照，面板會一直停在「讀取中…」。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`npm test`、`npm run depcruise`：expected 全部通過。
- `npm start` 加隔離的 `--user-data-dir`：expected 啟動紀錄沒有 error；⌘H 對應項目執行後畫布仍可見；確認後結束 app。

**Manual checks (if no CLI):**
- 使用者用打包版確認（A2 的驗收項）：面板在前景時按 ⌘H，桌面上的畫布仍在；應用程式選單不再有「隱藏」。
