# Epic 2 手動驗收清單

- **對象**：`4907871`（Story 2.9），用打包版（`npm run package`）在 macOS 驗收。
- **日期**：2026-11-13
- **怎麼記**：每項在「結果」填 ✅ 通過、❌ 失敗或 ⏭ 跳過，❌ 請寫看到什麼。也可以直接在對話裡回報，由 Claude 代填。
- **範圍**：只驗自動檢查碰不到的部分，包括畫面、點擊、真實的 AI 工具 session、真實的檔案與紀錄。Codex（2.5）沒做，本機也沒裝，不驗；Claude Code 狀態檔那一半（2.4 後半）也還沒做。

下面用到兩個路徑：

- app：`~/tools/gundam-pet/out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app`
- 資料夾：`~/Library/Application Support/AI Watchdog Pet/`，裡面有 `settings.json`、`assignments.json`、`logs/`

## 0. 準備

1. 重新打包並打開。`out/` 裡現在是 11/6 Epic 1 的版本；打包前要確認選單列沒有開著舊版。

   ```bash
   cd ~/tools/gundam-pet && npm run package && open "out/AI Watchdog Pet-darwin-arm64/AI Watchdog Pet.app"
   ```

2. 另開一個終端機，持續看最新的運行紀錄。跨整點換檔時，要重新下一次指令。

   ```bash
   tail -f "$(ls -t ~/Library/Application\ Support/AI\ Watchdog\ Pet/logs/*.log | head -1)"
   ```

## A. 示範模式、面板與方塊（Story 2.3、方塊空殼）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| A1 | 打開「管理 session」 | 有 session 表格（來源、名稱、狀態、操作）和轉接器健康列表；claude-code、gemini、cursor 都是「正常」 || ✅ Claude 11:52 讀面板：6 個 session（啟動回報 11 個，超過 2 小時的已逾時）；健康三個都「正常」 |
| A2 | 選單列圖示 → 示範模式 → 依序選 8 種狀態 | 面板出現一列示範 session，狀態跟著變；紀錄每次切換有一行 `detection` || ✅ 8 種依序切換，面板即時顯示；紀錄每次一行 `demo mode: …` |
| A3 | 示範模式開著時看畫布 | 畫面右下角出現方塊，顏色與文字對應目前狀態 || ✅ 擷取畫布頁面取樣：8 種狀態的顏色都對（擷取時色彩描述檔讓整體偏暗約 3～6%，偏移一致）；位置在右下、邊長 120，方塊外透明 |
| A4 | 對方塊按右鍵，依序選幾種狀態 | 方塊和面板跟著變；選單列的示範模式勾選也跟著移動 || ✅ 右鍵選單（layer 101，117×237）選「思考中」：面板與選單列勾選都跟著變。選單出現在真實游標位置，因為右鍵是程式送進頁面的 |
| A5 | 在方塊以外的地方點擊 | 點擊照樣落到下面的視窗，畫布不擋 || ✅ 真實點擊穿透畫布（畫布頁只收到轉送的 mousemove、沒有 mousedown），落到底下的 Claude 視窗 |
| A6 | 選「關閉」示範模式 | 方塊消失，面板的示範列消失 || ✅ 示範列消失，方塊位置像素透明 |

## B. 釋放與改回顯示（Story 2.8）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| B1 | 開示範模式，在示範列按「釋放」 | 整列淡化（含按鈕），名稱旁標「已釋放」，按鈕變「改回顯示」，狀態照常更新；畫布方塊**還在**（預期：Epic 2 只在面板標示） || ✅ 整列 0.5（含按鈕）、「已釋放」、「改回顯示」；釋放後切狀態照常更新；方塊還在（橘色） |
| B2 | 按「改回顯示」 | 淡化與標示消失，按鈕變回「釋放」 || ✅ |
| B3 | 再釋放一次，從選單「結束」，再打開 app | 示範模式是關的；紀錄有 `start-up sweep: kept 0, dropped 1`；`assignments.json` 的 `released` 是空的 || ✅ 結束時檔案 5 筆（含 demo）；重開後示範關閉、`kept 4, dropped 1`，檔案剩 4 筆 claude-code（使用者先前自己釋放了 4 個真實 session，所以 kept 不是 0） |
| B4 | 開一個真的 AI session（Claude Code 等）並釋放，結束 app 再打開，等約 10 秒 | 那個 session 仍是「已釋放」；紀錄的 sweep 為 `kept 1` || ✅ 使用者自己釋放 4 個 Claude Code session 後重開：`loaded assignments.json: 4 released`、`kept 4, dropped 0` |
| B5 | 對 B4 那列按「改回顯示」 | 恢復正常顯示 || ✅ 改回顯示後恢復；驗完再釋放回去，檔案維持 4 筆 |

## C. 計時值（Story 2.9）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| C1 | 打開「舞台設定」 | 螢幕選項下有「計時」區：做完了過場 5 秒（範圍 1～60）、無動靜轉休息中 5 分鐘（1～60）、推測要你批准 10 秒（1～600）；沒改時「儲存」停用 || ✅ |
| C2 | 休息中依序輸入 `0`、`61`、`2.5`、清空 | 每次都顯示「請輸入 1～60 的整數」，儲存停用 || ✅ 四種輸入都顯示「請輸入 1～60 的整數」，儲存停用 |
| C3 | 用中文輸入法的全形模式，在做完了輸入「８」 | 接受，可以儲存 || ✅ 全形「８」無錯誤，可以儲存 |
| C4 | 做完了改成 15，按儲存 | 顯示「已儲存」，欄位顯示 15；`settings.json` 的 `doneMs` 是 15000 || ✅ 「已儲存」；`settings.json` 的 `doneMs` 15000；紀錄 `changed doneMs (rev 1)` |
| C5 | 存完後再改任一欄位 | 「已儲存」消失 || ✅ |
| C6 | 用真的 AI session 跑完一輪（例如請 Claude Code 回一句話） | 「做完了」大約停 15 秒，才轉「等你回覆」 || ✅ `claude -p` 測試 session：做完了 10.0 秒 → 等你回覆 25.1 秒，停 15.1 秒 |
| C7 | 把做完了改回 5 並儲存 | 恢復預設 || ✅ `settings.json` 回到 5000／300000／10000 |
| C8（選做） | 「沒存到」提示，見下方步驟 | 第一次存顯示「已儲存」（預期）；第二次與改螢幕選項都顯示「已套用，但無法存到設定檔，重新啟動後會回到原本的值」 || ✅ 隔離資料夾設唯讀：第一次「已儲存」；紀錄 `cannot write settings.json (EACCES)`；第二次與改螢幕選項都顯示沒存到提示 |

C8 的步驟。這一項用另一個資料夾，不碰正式的設定：

1. 從選單「結束」正式那個 app。
2. 用一個空的資料夾啟動：

   ```bash
   mkdir -p /tmp/awp-readonly && open -n ~/tools/gundam-pet/out/AI\ Watchdog\ Pet-darwin-arm64/AI\ Watchdog\ Pet.app --args --user-data-dir=/tmp/awp-readonly
   ```

3. 等面板可以操作後，把資料夾設成唯讀：

   ```bash
   chmod a-w /tmp/awp-readonly
   ```

4. 改一個計時值並儲存，等 1 秒，再改一次並儲存，然後改一次螢幕選項。
5. 結束這個 app，把資料夾恢復成可寫，然後刪掉：

   ```bash
   chmod u+w /tmp/awp-readonly && rm -rf /tmp/awp-readonly
   ```

## D. 真實的 AI 工具（Story 2.4、2.6、2.7）

| # | 做什麼 | 應該看到 | 結果 |
|---|---|---|---|
| D1 | 開一個 Claude Code session，問一個要讀檔的問題 | 面板出現它，名稱是 session 標題或專案名；狀態依序經過思考中、工作中、做完了、等你回覆 || ✅ `claude -p` 測試 session 出現，名稱是資料夾名；思考中 → 做完了 → 等你回覆。Read 不到 0.5 秒，沒取樣到工作中（D2 有看到） |
| D2 | 在 Claude Code（非 auto 模式）讓它跑一個需要你批准的指令，停在批准畫面不按 | 約 10 秒後顯示「要你批准」並帶「推測」標示；你批准後回到工作中 || ✅ 以 `sleep 15` 代替批准畫面（`-p` 模式不會停在批准）：工作中 6.0 秒 → 要你批准（推測）16.1 秒 → 工具結束回思考中 21.6 秒 → 做完了 22.6 秒。真的停在批准畫面留給使用者日常遇到時看 |
| D3 | 開一個 Gemini CLI session，問一句話 | 面板出現它；狀態會變化。「做完了」可能帶「推測」：Gemini 的一輪結束要從沒有新紀錄推出來 || ✅ `gemini --skip-trust -p` 測試 session：思考中 → 做完了（推測）→ 等你回覆（推測） |
| D4 | 在 Cursor 開一個 agent session，請它做事 | 面板出現它，名稱是**專案資料夾名**，不是一串 slug；狀態會變化，但會慢幾秒到幾十秒（以 step 為單位寫紀錄，已知限制） || ⏭ 本機沒有 cursor-agent CLI，Cursor IDE 的 agent 無法自動操作，待使用者實測 |
| D5 | 在 Cursor 讓 agent 跑一個要你批准的 Shell 指令，停在批准畫面 | 約 10 秒後顯示「要你批准（推測）」 || ⏭ 同 D4 |
| D6 | 在 Cursor 讓 agent 問你問題（AskQuestion），先不回答 | 約 10 秒後顯示「要你決定（推測）」 || ⏭ 同 D4 |
| D7 | 在 Cursor 中途按停止 | 顯示「做完了」，**不是**「出錯了」 || ⏭ 同 D4 |
| D8 | 觀察 Cursor 的 agent 用 `TodoWrite`、`ReadLints`、`SemanticSearch` 等工具時 | 記下是否被誤判成「要你批准（推測）」；有的話告訴 Claude 工具名，再決定要不要加進不推測清單 || ⏭ 同 D4 |
| D9 | 結束任何一個 AI session 後等一陣子 | 5 分鐘沒動靜轉「休息中」；2 小時後從清單消失（可不等） || ✅（只驗休息中）最後事件 11:58:51 的測試 session 在 12:04:25 是休息中；2 小時消失沒等 |

## 過程紀錄

- 2026-11-13 11:51～12:06，Claude 依使用者要求自行驗收：
  - 選單列用輔助使用 API 操作；面板與畫布用 Chromium 本機除錯埠（app 以 `--remote-debugging-port` 重開）讀取與模擬操作；方塊顏色用程式取樣像素，沒有截圖給人看。驗完已用一般方式重開，除錯埠已關。
  - C6、D1、D2 用暫存資料夾裡的 `claude -p` 小任務，D3 用 `gemini --skip-trust -p`，各產生一個測試 session（工具自己的紀錄，2 小時後從清單消失）。
  - A5 的三次真實點擊落在疊在面板上方的 Claude 桌面 app 視窗（同一點），之後沒有再對其他 app 送點擊。
- 驗收時 Claude 端測試工具的問題（不是 app 的問題）：監看腳本殘留的程式同時寫同一個檔，D3 的時間軸因此錯亂，狀態順序改以直接讀面板確認。
- D4～D8（Cursor）：使用者 2026-11-13 決定先擱置，日常使用 Cursor 時順便看，不擋後續工作。
- 結果：A、B、C 全部通過；D 區 Claude Code、Gemini 通過；沒有發現 app 的缺陷。
