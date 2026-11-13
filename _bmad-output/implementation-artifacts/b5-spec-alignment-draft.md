# B5 規格對齊草稿（Epic 2 回顧行動項目）

- **目的**：讓架構文件與 `epics.md` 符合 Epic 2 實際做出來的樣子。Epic 3 的規格會引用這兩份文件。
- **狀態**：草稿，等使用者核准。核准後才套用到下列兩個檔，並在架構的 `.memlog.md` 加 decision 紀錄。
  - `planning-artifacts/architecture/architecture-gundam-pet-2026-11-02/ARCHITECTURE-SPINE.md`
  - `planning-artifacts/epics.md`
- **依據**：`epic-2-retro-2026-11-13.md` 的 AV5，以及各 story 規格的定案。
- **原則**：只把已經定案、已經做出來的事寫進文件，不加新規則。標「已知限制」的是現況，不是目標。

## 一、ARCHITECTURE-SPINE.md

### A1. AD-4 來源表「已知抓不到」欄

| 來源 | 現在 | 改成 | 依據 |
|---|---|---|---|
| `claude-code` | 無；狀態檔格式變動時，批准改用推測 | 狀態檔那一半（Story 2.4 後半）完成前：批准、提問都用推測，`/clear` 後舊 session 照逾時結束，沒有行程結束的訊號。完成後：無；狀態檔格式變動時，批准改用推測 | `spec-2-4-claude-code-transcript.md` 定案；`sources.ts` 能力表 |
| `gemini` | 批准 | 批准、提問（`ask_user` 要等使用者回答後才寫入）、一輪結束（不寫，改推測，見 AD-22）；工具呼叫要整批完成後才寫入 | `spec-2-6-gemini-cli-adapter.md`；`sources.ts:117-122` |
| `cursor` | 批准（……）；以 step 為單位寫入……；`turn_ended` 的 error……；檔案可能整檔重寫 | 在原文「批准」後加上「、提問（`AskQuestion` 的回答不寫入）」，其餘不變 | `spec-2-7-cursor-adapter.md` 定案 |

### A2. AD-5 事件清單

- **現在**：只輸出 `session.start|end|meta`、`turn.start|end`、`tool.start|end`、`approval.request|resolved`、`question.request|resolved`、`error`、`activity`。
- **改成**：在 `turn.start|end` 後加 `turn.reply`。在句尾補一句：「`turn.reply` 只給不會寫『一輪結束』的來源，表示一個可能結束這一輪的回覆（Story 2.6）。」
- **依據**：`detection-events.ts:184`、`:246`。

### A3. AD-21 判斷器條件

在「`turn.end` 時清空該 turn 內未關的 tool、approval、question（視為紀錄漏寫）。」之後加一句：

> 補讀的紀錄不一定照日期到達（例如 Claude Code 先補讀主 transcript、再補讀 subagent 的），所以 `tool.start`、`approval.request`、`question.request` 的紀錄日期（`ts`）如果早於該 session 最後一次 `turn.end` 的紀錄日期（補讀的也算，推測的不算），就不開啟，其餘當成 `activity`（Epic 2 收尾 B2）。

依據：`reducer.ts`（`lastTurnEndTs`）、`spec-epic-2-retro-closeout.md`。

### A4. AD-22 生命週期與推測

1. **session 結束那一條**，句尾加：
   > 已知限制：目前沒有來源會回報行程已不存在（Claude Code 要等 Story 2.4 後半；Gemini、Cursor 沒有 pid）。在一輪中途被關掉的 session，會停在思考中、工作中，或推測的「要你批准」，直到 `sessionExpireMs`。
   
   依據：回顧 F2，使用者選 C。
2. **啟動補讀那一條**，把「判斷器對 `replay` 事件只重建條件集合，不啟動推測計時、不產生 `done` 過場；`sync.ready` 之後才開始計時。」改成：
   > 判斷器對 `replay` 事件只重建條件集合，不產生 `done` 過場、不維持 `error`；推測要等該來源 `sync.ready` 之後才做。同步時，補讀時還開著的工具從回推的開始時間起算，已經超過門檻的立刻推測。
   
   依據：`spec-2-2-inference.md`、`inference.ts` 檔頭。
3. **`main/pool` 那一條**，把「之後丟棄沒有被重新回報的持久化分配與顯示／釋放紀錄。」改成：
   > 之後丟棄沒有被重新回報的持久化分配與顯示／釋放紀錄；沒有確認的來源（逾時時仍未送 `sync.ready`，或啟動失敗）的紀錄保留（Epic 2 收尾 B1）。
4. **推測那一條**，作三處修改：
   - 「能力表（approval、question 各為 `exact` 或 `none`，並列出該工具的『提問類』工具名稱）」改成：
     > 能力表（approval、question、一輪結束 `turnEnd` 各為 `exact` 或 `none`，並列出該工具的『提問類』工具與『不推測』工具名稱）
   - 在「只對 `none` 的項目推測：……就取代或關閉。」之後加：
     > 『不推測』的工具跑再久也不推測（本來就會跑很久的工具，例如 subagent、網頁搜尋；以及要等下一筆紀錄才知道結束的工具，例如 Cursor 的 `Read`）。`turnEnd` 為 `none` 的來源，在 `turn.reply` 之後、沒有開著的工具與請求，且 `TURN_END_INFER_MS`（10 秒，常數，不開放調整）內沒有更新的事件時，推測這一輪結束，產生 `via: inferred` 的 `turn.end`（Story 2.6）。
   - 已知限制那條句尾加：
     > 對要等工具完成才寫入的來源，回覆之後的工具（或等批准）超過 `TURN_END_INFER_MS` 時，會被推測成一輪結束。
5. **門檻預設值那一條**，句尾加：
   > 推測一輪結束的 `TURN_END_INFER_MS` 是 `src/shared/constants` 的常數，不是設定。

### A5. AD-12 池子

- **現在**：「釋放＝收回角色、不再分配；session 仍留在管理清單，可改回顯示」。
- **改成**：在括號內加「已釋放的 session 照常偵測狀態」，變成「釋放＝收回角色、不再分配；已釋放的 session 照常偵測狀態、仍留在管理清單，可改回顯示」。
- **依據**：`spec-2-8-session-release.md` 定案。

## 二、epics.md

| 位置 | 現在 | 改成 | 依據 |
|---|---|---|---|
| FR21（第 42 行） | 示範模式用假 session 輪播 8 狀態並照池子分配 | 示範模式用假 session 顯示使用者指定的狀態，並照池子分配 | `spec-2-3` 定案「不輪播，改成指定狀態」 |
| Epic 2 簡介（第 299 行） | 並用示範模式的假 session 看狀態輪播 | 並用示範模式的假 session 看指定的狀態 | 同上 |
| Story 2.1 第一條驗收條件 | 只能是 `session.start|end|meta`、`turn.start|end`、…… | 在 `turn.start|end` 後加 `turn.reply`（只給不會寫「一輪結束」的來源，Story 2.6） | A2 |
| Story 2.3 第二條驗收條件 | 產生 8 個假 session，經同一個判斷器輪播 8 種狀態，面板即時顯示 | 使用者指定一種狀態，就產生一個顯示該狀態的假 session，經同一個判斷器運作，維持到改選或關閉，面板即時顯示 | `spec-2-3` 定案 |
| Story 2.3 第三條驗收條件的「端到端測試……」 | （原文不變） | 句尾加「（延後；由哪個 story 承接，依 Epic 2 回顧 B8 決定）」 | 回顧 AV5、B8 |
| Story 2.4 第二條驗收條件 | 比對執行前後 `~/.claude/` 的檔案雜湊，完全不變 | 對 fixture 資料夾跑完整個轉接器，前後雜湊完全相同；對真實的 `~/.claude/projects/`，只比對執行前後的檔案清單、大小與修改時間（不讀內容），也完全不變 | `spec-2-4` 的 I/O 矩陣「唯讀」與實作紀錄 |
| Story 2.8 第一條驗收條件 | 該 session 標為已釋放、不再追蹤顯示，但仍留在清單裡；按「改回顯示」後恢復追蹤 | 該 session 標為已釋放：照常偵測狀態，面板整列淡化並標「已釋放」，Story 3.4 起不分配角色；按「改回顯示」後恢復 | `spec-2-8` 定案 |
| Story 2.8 第二條驗收條件 | 所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）後，丟棄沒有被重新回報的持久化紀錄 | 句尾加「；沒有確認的來源（逾時時仍未送 `sync.ready`，或啟動失敗）的紀錄保留」 | A4 第 3 點 |

## 三、不改的

- Story 2.4 的「等批准時顯示 `approval`（exact）」「行程結束」：屬於 2.4 後半（B6），維持原文。
- Story 2.5 Codex：沒做，維持原文。
- NFR1「2 秒內反映」：目標不變，量測由回顧 B10 處理。

## 套用後的影響

- `epic-2-context.md` 是從規劃文件編譯出來的。規劃文件更新後它會被視為過期；Epic 2 的 story 已經做完，Epic 3 開工時本來就會編譯新的 `epic-3-context.md`，所以不另外重編。
