# Epic 1 手動驗收清單

- **對象**：`0eb0cf7`（Story 1.5）＋ Story 1.6 的改動，用打包版（`npm run package`）在 macOS 驗收
- **日期**：2026-11-06
- **怎麼記**：每項在「結果」填 ✅ 通過／❌ 失敗／⏭ 跳過；❌ 請寫看到什麼。也可以直接在對話裡回報，由 Claude 代填。
- **只驗自動檢查碰不到的部分**：看得到的畫面、點擊、Dock／⌘Tab、真實的檔案與紀錄。自動檢查已涵蓋的項目列在最後。

下面用到兩個路徑：

- app：`~/tools/gundam-pet/out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app`
- 資料夾：`~/Library/Application Support/AI Watchdog Pet/`（`settings.json`、`logs/`）

## 0. 準備

1. 從選單列圖示點「結束」，關掉目前開著的 Story 1.5 打包版。打包會覆寫它正在執行的 `out/` 資料夾。
2. 重新打包並打開：

   ```bash
   cd ~/tools/gundam-pet && npm run package && open "out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app"
   ```

3. 另開一個終端機，持續看最新的運行紀錄（跨整點換檔時要重下一次）：

   ```bash
   tail -f "$(ls -t ~/Library/Application\ Support/AI\ Watchdog\ Pet/logs/*.log | head -1)"
   ```

## A. 選單列入口與單一實例（Story 1.5，FR7、NFR10）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| A1 | 打開 app 後看選單列、Dock、按 ⌘Tab | 選單列出現圓環圖示；Dock 沒有圖示；⌘Tab 清單裡沒有它 | |
| A2 | 點選單列圖示 | 選單依序：管理 session、角色包、舞台設定、結束 | |
| A3 | 點「管理 session」 | 面板打開，顯示「即將推出」；Dock 出現圖示；⌘Tab 切得回來 | |
| A4 | 面板開著時，再從選單點「角色包」 | 同一個面板換到「角色包」頁，不會多開視窗 | |
| A5 | 按 ⌘W 關掉面板 | 約 1 秒內 Dock 圖示消失，⌘Tab 也沒有它 | |
| A6 | app 開著，在 Finder 對 app 點兩下 | 選單列沒有多一個圖示；主面板（管理 session）打開；紀錄有 `app activated: opening the main panel` | |
| A7 | 關掉面板，在終端機執行 `open -n "$HOME/tools/gundam-pet/out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app"`（強制開第二個實例） | 同 A6，紀錄改為 `second instance launched: opening the main panel` | |

## B. 透明穿透畫布（Story 1.6，FR5）

先關掉面板。畫布目前沒有內容，所以應該完全看不到。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| B1 | 看整個桌面 | 沒有任何框、陰影或半透明層，跟沒開 app 一樣 | |
| B2 | 在主螢幕上點桌面圖示、拖曳視窗、在其他 app 裡捲動、打字 | 全部正常，點擊都穿透到底下 | |
| B3 | 點選單列上的其他項目（時鐘、Wi-Fi 等） | 選單列畫在畫布上方，點得到 | |
| B4 | 紀錄開頭 | 依序有 `displays: 2 connected (…)`、`canvas on display <主螢幕 id>, …`、`canvas window created on …`、`canvas ready (renderer webgl, …)`；沒有 `canvas window is at …, not the requested …` 的位置警告 | |
| B5 | 觀察：按 Mission Control（F3 或三指上滑） | 記下有沒有出現一個空白的大視窗縮圖。不是驗收條件，出現的話記成待處理問題 | |

「在所有桌面空間可見」要等 Story 3.x 畫布上有角色時才能用眼睛確認，這次不驗。

## C. 舞台設定：選畫布所在螢幕（Story 1.6）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| C1 | 從選單點「舞台設定」 | 「畫布所在螢幕」選項：「主螢幕（跟著系統設定）」，再列出兩個螢幕（名稱、解析度，主螢幕後面標「・目前的主螢幕」）；目前選在「主螢幕（跟著系統設定）」；狀態列寫 `畫布螢幕：<主螢幕名稱>` | |
| C2 | 改選副螢幕 | 狀態列換成副螢幕名稱；紀錄有 `canvas on display <副螢幕 id>, …` 和 `canvas window moved to display <副螢幕 id>, …` | |
| C3 | 在副螢幕上點擊、拖曳視窗 | 一樣穿透 | |
| C4 | 從選單「結束」，再用準備步驟的 `open` 指令打開，回到舞台設定 | 仍選在副螢幕；紀錄 `canvas on display <副螢幕 id>` | |
| C5 | 選做：選在副螢幕時拔掉副螢幕，之後再接回 | 拔掉後選項多一個「螢幕 <id>（未連接，暫用主螢幕）」，狀態列寫「（暫用主螢幕）」，紀錄有 `display <id> is not connected; using the primary display for now`；接回後畫布移回副螢幕 | |
| C6 | 選做：在系統設定 > 顯示器 改主螢幕、解析度或縮放 | 紀錄有新的 `canvas window moved to …`，尺寸跟著變 | |
| C7 | 改回「主螢幕（跟著系統設定）」 | 狀態列與紀錄回到主螢幕 | |

## D. 睡眠、鎖定與當掉重建（Story 1.6，NFR12）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| D1 | 按 Ctrl+⌘Q 鎖定螢幕，再解鎖 | 紀錄有 `screen locked`、`screen unlocked` | |
| D2 | 選做：讓 Mac 睡眠再喚醒 | 紀錄有 `system suspended`、`system resumed` | |
| D3 | 關掉面板，在終端機執行 `pkill -9 -f 'Watchdog Pet.*--type=renderer'`，讓畫布 renderer 當掉 | 紀錄有 `canvas renderer gone (…)`、`rebuilding the canvas window (1 of 3 within 60 s)`，接著新的 `canvas ready …`；點擊照常穿透 | |

D3 只在面板關著時做：面板開著的話，它的 renderer 也會被一起殺掉。

## E. 設定檔壞掉不會被蓋掉（Story 1.4，FR23）

每一項都要先從選單「結束」app，改完檔案再用準備步驟的 `open` 指令打開。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| E1 | 結束 app 後執行 `echo 'not json' > ~/Library/Application\ Support/AI\ Watchdog\ Pet/settings.json`，再打開 | app 正常啟動；資料夾多一個 `settings.json.broken-<日期>-<時間>`，內容是 `not json`；紀錄有 `settings.json is unusable (…); renamed it to settings.json.broken-… and using defaults`；舞台設定回到主螢幕 | |
| E2 | 結束 app 後執行 `printf '{"schemaVersion":1,"canvasDisplayId":"abc"}' > ~/Library/Application\ Support/AI\ Watchdog\ Pet/settings.json`，再打開 | app 正常啟動；多一個 broken 檔，內容是剛寫入的那行；紀錄有 `settings.json has bad fields (invalid: canvasDisplayId); copied it to …`；約 1 秒後 `settings.json` 被改寫成 `canvasDisplayId` 為 `null` 的合法內容 | |

做完可以自行刪掉 `settings.json.broken-*`。

## F. 運行紀錄（Story 1.4，FR22）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| F1 | `ls ~/Library/Application\ Support/AI\ Watchdog\ Pet/logs/` | 檔名是本地時間的 `YYYY-MM-DD-HH.log`，一小時一個檔；沒有超過 24 小時的舊檔 | |
| F2 | 打開一個紀錄檔 | 每行三欄，以 Tab 分隔：帶時區的時間、類別（`app`、`settings`、`stage-view`、`windows`、`ipc`）、內容；看不到設定值或錯誤訊息全文 | |
| F3 | 最後從選單點「結束」 | 選單列圖示消失；紀錄最後是 `canvas window closed` … `app quit` | |

## G. Windows（有 Windows 機器才做，沒有就記為未驗證）

在 Windows 上 clone 後執行 `npm ci` 和 `npm run package`，打開 `out\` 底下的 app。資料夾在 `%APPDATA%\AI Watchdog Pet\`。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| G1 | 打開 app | 系統匣出現灰色圓環圖示；工作列沒有 app | |
| G2 | 從系統匣打開面板，再關掉 | 開著時工作列和 Alt+Tab 有它；關掉後都消失 | |
| G3 | 面板關著時按 Alt+Tab，並在桌面點擊、拖曳視窗 | Alt+Tab 沒有畫布；點擊穿透 | |
| G4 | 再啟動一次 app | 不開第二個實例，改打開主面板 | |
| G5 | 看紀錄 | 有 `canvas ready (renderer webgl, …)`；沒有 `canvas window is at …, not the requested …` 的位置警告（高 DPI 螢幕最容易出現） | |

## 自動檢查已涵蓋，不用手動

- **Story 1.1**：版本鎖定、目錄結構、typecheck、lint：CI（macOS＋Windows）。
- **Story 1.2**：沙盒四項假設：`sandbox-prototype-report.md`，AD-7 閘門已通過。
- **Story 1.3**：IPC 回傳格式、通道命名、`senderFrame` 檢查、依賴方向、禁止網路模組：Vitest＋dependency-cruiser＋CI。
- **Story 1.4**：`settings:patch` 合併規則、temp＋rename、StageView 快照與增量、`rev` 斷號重拿、紀錄 24 小時刪除：Vitest。
- **Story 1.5**：AD-24 安全設定、CSP 不含 `'unsafe-eval'`、`app://` 載入：Vitest＋開發版與打包版實機紀錄。
- **Story 1.6**：通知 overlay 世界座標、重建上限 60 秒 3 次、overlay 只能呼叫自己的 IPC：Vitest。

## 結果摘要

（驗收完填：通過幾項、失敗幾項、跳過哪些、要開的問題）
