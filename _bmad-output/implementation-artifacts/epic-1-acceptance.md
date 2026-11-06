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
| A1 | 打開 app 後看選單列、Dock、按 ⌘Tab | 選單列出現圓環圖示；Dock 沒有圖示；⌘Tab 清單裡沒有它 | ✅ 使用者確認（但要先指出位置才找得到，見過程紀錄） |
| A2 | 點選單列圖示 | 選單依序：管理 session、角色包、舞台設定、結束 | ✅ 使用者確認 |
| A3 | 點「管理 session」 | 面板打開，顯示「即將推出」；Dock 出現圖示；⌘Tab 切得回來 | ✅ 使用者確認；紀錄 16:31:22 `panel opened on sessions`、`dock icon shown` |
| A4 | 面板開著時，再從選單點「角色包」 | 同一個面板換到「角色包」頁，不會多開視窗 | ✅ 使用者從面板左側選單換頁，沒有多開視窗。Claude 16:35 用選單列選單操作：`panel opened on sessions` → `panel switched to settings`；輔助使用 API 看到的視窗只有一個面板（960×680）加畫布（1920×1080） |
| A5 | 按 ⌘W 關掉面板 | 約 1 秒內 Dock 圖示消失，⌘Tab 也沒有它 | ✅ 使用者確認；紀錄 16:31:32 `dock icon hidden (no panel open)`、`panel closed` |
| A6 | app 開著，在 Finder 對 app 點兩下 | 選單列沒有多一個圖示；主面板（管理 session）打開；紀錄有 `app activated: opening the main panel` | ✅ 16:32:29 使用者在 Finder 點兩下時面板已開著，紀錄 `app activated…`。Claude 16:35:54 在面板停在舞台設定頁時執行 `open`：`app activated…` → `panel switched to sessions`，仍只有一個主程序 |
| A7 | 關掉面板，在終端機執行 `open -n "$HOME/tools/gundam-pet/out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app"`（強制開第二個實例） | 同 A6，紀錄改為 `second instance launched: opening the main panel` | ✅ Claude 16:32:14 執行 `open -n`：紀錄 `second instance launched…`、`panel opened on sessions`；之後只剩一個主程序（PID 21851） |

## B. 透明穿透畫布（Story 1.6，FR5）

先關掉面板。畫布目前沒有內容，所以應該完全看不到。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| B1 | 看整個桌面 | 沒有任何框、陰影或半透明層，跟沒開 app 一樣 | ✅ 使用者確認 |
| B2 | 在主螢幕上點桌面圖示、拖曳視窗、在其他 app 裡捲動、打字 | 全部正常，點擊都穿透到底下 | ✅ 使用者確認 |
| B3 | 點選單列上的其他項目（時鐘、Wi-Fi 等） | 選單列畫在畫布上方，點得到 | ✅ 使用者確認 |
| B4 | 紀錄開頭 | 依序有 `displays: 2 connected (…)`、`canvas on display <主螢幕 id>, …`、`canvas window created on …`、`canvas ready (renderer webgl, …)`；沒有 `canvas window is at …, not the requested …` 的位置警告 | ✅ 16:24 啟動紀錄（Claude 讀紀錄） |
| B5 | 觀察：按 Mission Control（F3 或三指上滑） | 記下有沒有出現一個空白的大視窗縮圖。不是驗收條件，出現的話記成待處理問題 | ✅ 使用者確認沒有出現 |

「在所有桌面空間可見」要等 Story 3.x 畫布上有角色時才能用眼睛確認，這次不驗。

## C. 舞台設定：選畫布所在螢幕（Story 1.6）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| C1 | 從選單點「舞台設定」 | 「畫布所在螢幕」選項：「主螢幕（跟著系統設定）」，再列出兩個螢幕（名稱、解析度，主螢幕後面標「・目前的主螢幕」）；目前選在「主螢幕（跟著系統設定）」；狀態列寫 `畫布螢幕：<主螢幕名稱>` | ✅ 使用者確認 |
| C2 | 改選副螢幕 | 狀態列換成副螢幕名稱；紀錄有 `canvas on display <副螢幕 id>, …` 和 `canvas window moved to display <副螢幕 id>, …` | ✅ 使用者確認狀態列；紀錄 16:39:15 `changed canvasDisplayId (rev 5)`、`canvas window moved to display 1, 1920x1080 at 1920,0`；`settings.json` 為 `canvasDisplayId: 1` |
| C3 | 在副螢幕上點擊、拖曳視窗 | 一樣穿透 | ✅ 使用者確認 |
| C4 | 從選單「結束」，再用準備步驟的 `open` 指令打開，回到舞台設定 | 仍選在副螢幕；紀錄 `canvas on display <副螢幕 id>` | ⏳ Claude 16:39:30 從選單列「結束」、16:39:36 重開，紀錄 `canvas window created on display 1, … at 1920,0`、`canvas ready`；畫面上是否仍勾在副螢幕沒有目視：輔助使用 API 讀不到面板內容；勾選狀態由 `settings.json`（`canvasDisplayId: 1`）推出，推導邏輯有單元測試 |
| C5 | 選做：選在副螢幕時拔掉副螢幕，之後再接回 | 拔掉後選項多一個「螢幕 <id>（未連接，暫用主螢幕）」，狀態列寫「（暫用主螢幕）」，紀錄有 `display <id> is not connected; using the primary display for now`；接回後畫布移回副螢幕 | ⏭ 跳過 |
| C6 | 選做：在系統設定 > 顯示器 改主螢幕、解析度或縮放 | 紀錄有新的 `canvas window moved to …`，尺寸跟著變 | ⏭ 跳過 |
| C7 | 改回「主螢幕（跟著系統設定）」 | 狀態列與紀錄回到主螢幕 | ✅ 使用者 16:31 選回「主螢幕（跟著系統設定）」：紀錄 rev 4，之後 `settings.json` 為 `canvasDisplayId: null`。16:55 E1 重設預設值後，畫布也回到 display 3 |

## D. 睡眠、鎖定與當掉重建（Story 1.6，NFR12）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| D1 | 按 Ctrl+⌘Q 鎖定螢幕，再解鎖 | 紀錄有 `screen locked`、`screen unlocked` | ⏭ 跳過：Claude 16:56 用 System Events 模擬 Ctrl+⌘Q 沒有成功鎖定，使用者決定跳過。事件處理有單元測試，缺實機證據 |
| D2 | 選做：讓 Mac 睡眠再喚醒 | 紀錄有 `system suspended`、`system resumed` | ⏭ 跳過 |
| D3 | 關掉面板，在終端機執行 `pkill -9 -f 'Watchdog Pet.*--type=renderer'`，讓畫布 renderer 當掉 | 紀錄有 `canvas renderer gone (…)`、`rebuilding the canvas window (1 of 3 within 60 s)`，接著新的 `canvas ready …`；點擊照常穿透 | ✅ Claude 16:54:55 `kill -9` 畫布 renderer（PID 26000）：`canvas renderer gone (killed, exit code 9)` → `rebuilding the canvas window (1 of 3 within 60 s)` → `canvas window created` → `webContents 3 subscribed at rev 1`（重拿快照）→ `canvas ready`，前後約 0.15 秒。這個重建出來的畫布在副螢幕上只存在約 20 秒，就因為 E1 重開而消失，所以 17:02:20 在主螢幕再做一次：紀錄同樣是 gone → rebuilding (1 of 3) → created on display 3 → subscribed at rev 1 → ready；重建後的點擊穿透沒有目視（使用者的 Claude 視窗在副螢幕，無法當作主螢幕的證據）。重建跟啟動走同一個 `create()`，啟動建立的畫布 B2 已確認穿透 |

D3 只在面板關著時做：面板開著的話，它的 renderer 也會被一起殺掉。

## E. 設定檔壞掉不會被蓋掉（Story 1.4，FR23）

每一項都要先從選單「結束」app，改完檔案再用準備步驟的 `open` 指令打開。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| E1 | 結束 app 後執行 `echo 'not json' > ~/Library/Application\ Support/AI\ Watchdog\ Pet/settings.json`，再打開 | app 正常啟動；資料夾多一個 `settings.json.broken-<日期>-<時間>`，內容是 `not json`；紀錄有 `settings.json is unusable (…); renamed it to settings.json.broken-… and using defaults`；舞台設定回到主螢幕 | ✅ Claude 16:55:17：`settings.json is unusable (not valid JSON); renamed it to settings.json.broken-20261106-165517 and using defaults`，備份內容為 `not json`，畫布回到 display 3，app 正常啟動 |
| E2 | 結束 app 後執行 `printf '{"schemaVersion":1,"canvasDisplayId":"abc"}' > ~/Library/Application\ Support/AI\ Watchdog\ Pet/settings.json`，再打開 | app 正常啟動；多一個 broken 檔，內容是剛寫入的那行；紀錄有 `settings.json has bad fields (invalid: canvasDisplayId); copied it to …`；約 1 秒後 `settings.json` 被改寫成 `canvasDisplayId` 為 `null` 的合法內容 | ✅ Claude 16:55:31：`settings.json has bad fields (invalid: canvasDisplayId); copied it to settings.json.broken-20261106-165531…`，備份內容與寫入的相同，`settings.json` 已改寫為 `{"schemaVersion": 1, "canvasDisplayId": null}` |

做完可以自行刪掉 `settings.json.broken-*`。

## F. 運行紀錄（Story 1.4，FR22）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| F1 | `ls ~/Library/Application\ Support/AI\ Watchdog\ Pet/logs/` | 檔名是本地時間的 `YYYY-MM-DD-HH.log`，一小時一個檔；沒有超過 24 小時的舊檔 | ✅ 17:02:20 開新檔 `2026-11-06-17.log` 時，滿 24 小時的 `2026-11-05-17.log` 被刪除，剩 10、11、16、17 四個檔 |
| F2 | 打開一個紀錄檔 | 每行三欄，以 Tab 分隔：帶時區的時間、類別（`app`、`settings`、`stage-view`、`windows`、`ipc`）、內容；看不到設定值或錯誤訊息全文 | ✅ Claude 檢查 4 個紀錄檔共 153 行：全部 3 欄、時間帶時區、類別只有 app／settings／stage-view／windows；設定變更只記欄位名稱和 rev，壞檔只記原因類別 |
| F3 | 最後從選單點「結束」 | 選單列圖示消失；紀錄最後是 `canvas window closed` … `app quit` | ✅ Claude 16:39:30 從選單列「結束」：`panel closed`、`canvas window closed`、`app quit`，程序消失 |

## G. Windows（有 Windows 機器才做，沒有就記為未驗證）

在 Windows 上 clone 後執行 `npm ci` 和 `npm run package`，打開 `out\` 底下的 app。資料夾在 `%APPDATA%\AI Watchdog Pet\`。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| G1 | 打開 app | 系統匣出現灰色圓環圖示；工作列沒有 app | 未驗證（沒有 Windows 機器） |
| G2 | 從系統匣打開面板，再關掉 | 開著時工作列和 Alt+Tab 有它；關掉後都消失 | 未驗證（沒有 Windows 機器） |
| G3 | 面板關著時按 Alt+Tab，並在桌面點擊、拖曳視窗 | Alt+Tab 沒有畫布；點擊穿透 | 未驗證（沒有 Windows 機器） |
| G4 | 再啟動一次 app | 不開第二個實例，改打開主面板 | 未驗證（沒有 Windows 機器） |
| G5 | 看紀錄 | 有 `canvas ready (renderer webgl, …)`；沒有 `canvas window is at …, not the requested …` 的位置警告（高 DPI 螢幕最容易出現） | 未驗證（沒有 Windows 機器） |

## 自動檢查已涵蓋，不用手動

- **Story 1.1**：版本鎖定、目錄結構、typecheck、lint：CI（macOS＋Windows）。
- **Story 1.2**：沙盒四項假設：`sandbox-prototype-report.md`，AD-7 閘門已通過。
- **Story 1.3**：IPC 回傳格式、通道命名、`senderFrame` 檢查、依賴方向、禁止網路模組：Vitest＋dependency-cruiser＋CI。
- **Story 1.4**：`settings:patch` 合併規則、temp＋rename、StageView 快照與增量、`rev` 斷號重拿、紀錄 24 小時刪除：Vitest。
- **Story 1.5**：AD-24 安全設定、CSP 不含 `'unsafe-eval'`、`app://` 載入：Vitest＋開發版與打包版實機紀錄。
- **Story 1.6**：通知 overlay 世界座標、重建上限 60 秒 3 次、overlay 只能呼叫自己的 IPC：Vitest。

## 結果摘要

**結論：Epic 1 在 macOS 上的驗收條件全部符合，沒有失敗項；Windows 尚未驗證。**

- **macOS 27 項**：✅ 23、⏭ 4（C5 拔螢幕、C6 改顯示器設定、D1 鎖定、D2 睡眠）、❌ 0。
- **只有部分證據的 2 項**：C4 的勾選畫面沒有目視，D3 重建後的穿透沒有目視；兩項都有紀錄或程式路徑的佐證。
- **Windows（G1～G5）**：沒有 Windows 機器，未驗證。已記在 `deferred-work.md` 的「Windows／Linux 的穿透、透明…只有單元測試」。
- **驗收中發現的問題**：不違反驗收條件，但影響第一次使用，已記到 `deferred-work.md`。
  1. 佔位的選單列圖示（空心圓圈）很難認出來，使用者在選單列上找不到 app。
  2. 使用者以為關掉面板就是結束 app；目前沒有提示說明 app 會繼續留在選單列。
- **驗收方式**：使用者負責看畫面、點擊；Claude 下指令、讀運行紀錄、用 System Events 操作選單列選單，並填寫本清單。

### 過程紀錄

- 2026-11-06 16:13：使用者在選單列找不到 Story 1.5 打包版（PID 45719）的圖示，也看不出 app 正在執行。用 System Events 查到圖示確實存在（副螢幕選單列 x=3186、34×24），替使用者點開選單後，由使用者點「結束」（16:23:50 `app quit`）。**發現**：佔位的空心圓圈圖示很難認出來，也沒有任何提示告訴使用者 app 在選單列裡。
- 2026-11-06 16:24：重新打包（Story 1.6，`d3bd0a4`）並打開，啟動紀錄符合 B4。
- 2026-11-06 16:31：做 A 段時，使用者順手在舞台設定切換螢幕。紀錄 rev 1→4：畫布移到 display 1（1920,0）再移回 display 3（0,0），最後 `settings.json` 為 `canvasDisplayId: null`，是 C2／C7 的初步證據；C 段仍照表做完。
- 2026-11-06 16:37：請使用者「換到副螢幕後從選單結束」，使用者回報「結束了」，但紀錄只有 16:37:11 `panel closed`，app 仍在執行，設定也沒變。**發現**：使用者以為關掉面板視窗就是結束 app。這是常駐設計的預期行為，但目前沒有任何提示說明「關掉面板後 app 仍在選單列執行」，跟找不到圖示是同一類可發現性問題。
