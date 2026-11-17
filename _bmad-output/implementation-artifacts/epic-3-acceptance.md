# Epic 3 手動驗收紀錄

- **範圍**：只驗自動檢查碰不到的部分（畫面、點擊、系統對話框、真實檔案）。目前到 Story 3.3 為止；3.4 起的 story 完成後接著補在後面。
- **怎麼記**：每項在「結果」填 ✅ 通過、❌ 失敗或 ⏭ 跳過，❌ 要寫看到什麼。

## Story 3.2、3.3（2026-11-16）

- **對象**：`c2517f7`（Story 3.3 下半段），macOS，`npm start` 開發版。
- **環境**：
  - 隔離的 `--user-data-dir`，放在 Claude 的 scratchpad；使用者正在跑的打包版與真實 userData 都沒碰。
  - 測試用 `.awpet` 從 `test/packs/contract-pack/` 現場壓出：1.0.0、0.9.0，以及一個 manifest 改壞的包。

### 3.2 匯入

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| I1 | 按「匯入角色包…」，在選檔對話框選 `.awpet` | 「已安裝：契約測試包 1.0.0」，清單多一列 | ✅ 使用者操作；之前一次按取消，log 記「the file dialog was cancelled」，沒有錯誤 |
| I2 | 第二實例帶同一個檔 | 面板打開到「角色包」；確認「同一個版本，會重新安裝」；按「取代」後重新安裝 | ✅ |
| I3 | 第二實例帶 0.9.0 | 確認畫面多一行降版警告；按「取消」後顯示「已取消」，仍是 1.0.0 | ✅ |
| I4 | 第二實例帶改壞的包 | 「無法匯入：manifest.json 的內容不符合規格」，下面列出 `name`、`characters[0].height`、`extraField` 的中文說明 | ✅ |
| I5 | macOS `open-file`（`open -a` 開發版 Electron 帶檔） | 送進同一個執行中的 app（沒有多開程序），log 記 `open-file: a .awpet to import`，出現取代確認 | ✅ |

### 3.3 上半段：清單、上場、加入池子

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| L1 | 打開「角色包」頁 | 契約測試包 1.0.0、探針一、探針二；上場與加入池子都是勾選；身高 110、96 沒有提示 | ✅ |
| L2 | 取消上場、取消探針一加入池子，結束 app 再啟動 | `settings.json` 有 `packEnabled: {contract-pack: false}`、`fixedOverrides: {contract-pack/probe-one: {inPool: false}}`；重新啟動後仍是取消 | ✅ 點擊當下勾選框不動，要等 StageView 回來才變 |
| L3 | 兩個都勾回去 | `settings.json` 兩欄都是 `{}` | ✅ |

### 3.3 下半段：匯出、移除

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| E1 | 按「匯出…」 | 存檔對話框（預設檔名 `contract-pack-1.0.0.awpet`）；狀態行「匯出中…」，「匯出…」停用 | ✅ |
| E2 | 在對話框按「儲存」 | 「已匯出：契約測試包 1.0.0」 | ✅ 檔案存到 `~/Documents/contract-pack-1.0.0.awpet` |
| E3 | 檢查匯出檔並再匯入 | zip 根目錄 `contract-pack/`，7 個檔與安裝資料夾逐位元組相同，時間都是 2000-01-01；再匯入出現取代確認 | ✅ |
| E4 | 再按「匯出…」，在對話框按「取消」 | 狀態行回到前一次的結果，「匯出…」恢復可按，不寫檔 | ✅ |
| E5 | 「移除…」→「取消」，再「移除…」→「移除」 | 確認文字寫明設定會保留；取消時清單不變；移除後顯示「還沒有安裝角色包」，`packs/` 只剩 `index.json`（`packs: []`），`settings.json` 位元組沒變 | ✅ |

### 過程紀錄

- 2026-11-16 17:16～17:24，Claude 依使用者要求自行驗收，I1 由使用者操作：
  - 面板用 Chromium 本機除錯埠（`--remote-debugging-port`）讀取與點擊，沒有截圖。
  - 第二實例用 `electron .` 帶同一個 `--user-data-dir`。
  - 存檔對話框的「取消」用 macOS 輔助使用 API 對按鈕發出按下動作（Swift），沒有送滑鼠或鍵盤事件到任何 app。AppleScript 分不出兩個同名視窗（畫布與面板都叫「AI Watchdog Pet」），所以改用 Swift。
- E2：第一次打開存檔對話框時，app 在 17:19:33 被帶到前景，17:19:37 存檔。Claude 沒有按「儲存」，判斷是使用者按的。
- 驗完以 SIGTERM 結束測試 app，run log 最後一行是 `quit`；整份 run log 91 行，沒有任何 error 或 fail。
- 審查時已知、沒有修的小問題，這次也看到了：移除後狀態行仍顯示前一次「已匯出」（3.3 下半段審查 B4，駁回）。
- **結果**：3.2、3.3 共 13 項全部通過，沒有發現 app 的缺陷。

## Story 3.4（2026-11-17）

- **對象**：`870f1f7`（Story 3.4），macOS，`npm start` 開發版。
- **環境**：新的隔離 `--user-data-dir`（Claude 的 scratchpad），使用者的打包版與真實 userData 都沒碰。session 用本機現有的 Claude Code session（隔離實例自己的轉接器讀到 12 個、顯示 7 個），加上示範模式；沒有另外產生新的 AI session。讀頁面時只讀「來源、狀態、角色」三欄，`assignments.json` 只印統計，不印 session 名稱或 key。

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| P1 | 第二實例匯入契約測試包（2 個角色），7 個 session 顯示中 | 7 個 session 交替分到「探針一」「探針二」；前兩個不同，之後依出場次數最少的重複；`assignments.json` 是 v2，7 筆、7 個不同的 `actorId` | ✅ log：`assignments: 7 new … (7 actors, 2 characters in the pool)` |
| P2 | 釋放第一列，再改回顯示 | 釋放後顯示「沒有角色」並標「已釋放」，其他列不變；改回顯示後分到「探針二」（本次出場次數較少），`actorId` 是新的 | ✅ |
| P3 | 「角色包」頁取消上場 | 現有 7 個角色都不變，沒有新的分配 | ✅ |
| P4 | 池子空時釋放再顯示一列，然後勾回上場 | 池子空時那列「沒有角色」（未釋放）；勾回上場後立刻補上「探針一」；log 先記 `changed packEnabled` 再記分配 | ✅ |
| P5 | 選單列打開示範模式（思考中），再切到工作中 | 示範 session 分到「探針二」；切狀態後角色不變，沒有新的分配 | ✅ 選單列用輔助使用 API 操作 |
| P6 | 結束 app 再啟動 | `start-up sync: kept 7 saved assignments, dropped 1 (1 not reported …)`；7 個 session 的角色與 `actorId` 都和結束前相同；示範模式重啟後是關的，那筆被丟掉；面板角色欄與結束前一致 | ✅ |

### 過程紀錄

- 2026-11-17，Claude 依使用者要求自行驗收：面板用本機除錯埠讀取與點擊，選單列的示範模式用 AppleScript 對選單項目發出按下動作（關選單時送過一次 Esc，當時選單在前景），沒有截圖。
- 驗完以 SIGTERM 結束測試 app，run log 最後一行是 `quit`；整份 run log 78 行，沒有任何 error、fail 或 warn。
- **結果**：3.4 共 6 項全部通過，沒有發現 app 的缺陷。
