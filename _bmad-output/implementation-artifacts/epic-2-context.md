# Epic 2 Context: 看見所有 AI session 的狀態

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

建立舞台的偵測管線與 session 管理：以完全唯讀的方式讀 Claude Code、Codex CLI、Gemini CLI、Cursor 的紀錄，各轉接器只翻譯成共用事件，由單一判斷器決定 8 狀態，經 StageView 顯示在「管理 session」面板。沒有任何角色包、甚至沒開任何 AI 工具時（示範模式），使用者也能看到 session、狀態與轉接器健康，能顯示／釋放 session、調整計時值。這是 app 的核心價值（不切視窗就知道哪個 session 在等你），也是 Epic 3 角色分配與演出、Epic 6 Copilot 轉接器的地基。本 epic 不依賴沙盒閘門；Copilot CLI 不在範圍內。

## Stories

- Story 2.1: 偵測事件契約與 8 狀態判斷器
- Story 2.2: session 生命週期、啟動補讀與推測
- Story 2.3: 示範轉接器、session 面板與轉接器健康
- Story 2.4: Claude Code 轉接器
- Story 2.5: Codex CLI 轉接器
- Story 2.6: Gemini CLI 轉接器
- Story 2.7: Cursor 轉接器
- Story 2.8: 顯示與釋放 session
- Story 2.9: 調整計時值

## Requirements & Constraints

- 8 狀態固定為 `waiting`、`thinking`、`working`、`approval`、`decision`、`done`、`idle`、`error`；判別值一律英文代碼，中文顯示名沿用 `src/shared` 既有的唯一對照。
- 偵測延遲：確定的狀態改變後 2 秒內反映到面板。Cursor 以 step 為單位寫紀錄，延遲數秒到數十秒，列為已知限制、不適用 2 秒目標。
- 計時預設：一輪結束先 `done` 5 秒再轉 `waiting`；最後事件起 5 分鐘轉 `idle`；讀不到批准的工具執行超過 10 秒沒結束推測為 `approval`（提問類工具推測為 `decision`）。三者都可在舞台設定調整並立即生效；超出合理範圍在面板擋下，`main/settings` 寫入時再驗一次。
- 對 AI 工具完全唯讀：不寫任何工具的檔案或設定、不裝 hook、不執行會寫入工具資料夾的指令（`claude agents --json` 每次都會寫鎖檔與快取）。每個轉接器的驗收：執行前後比對該工具資料夾的雜湊，完全不變。
- Claude Code 狀態檔：只讀檔名符合 `^\d+\.json$` 的檔，只取 `pid`、`sessionId`、`status`、`waitingFor`、`name`、`cwd`、`statusUpdatedAt`；禁止讀 `*.key`、禁止連任何 socket（含 `messagingSocketPath`）、不執行任何 `claude` 指令。格式未公開，解析失敗或缺欄位就標 `degraded`，退回只讀 transcript＋推測。
- 外部紀錄寬鬆解析：未知欄位放行、壞行跳過並計數、絕不丟例外；連續失敗只把該轉接器健康標 `degraded`，不中止。
- 沒有角色包時偵測、面板、管理 session 照常運作，畫布為空。釋放的 session 不再追蹤，但留在清單、可改回顯示。
- 完全不連網：端到端測試要斷言所有 renderer 只發出 `app://`、`pack://`（開發時加 Vite dev server）的請求。
- 測試 fixture 用去識別化的真實紀錄；repo 公開，不得含憑證或個資。

## Technical Decisions

- **尚未安裝、要鎖確切版本的套件：** chokidar 5.0.0、@playwright/test 1.64.1。
- **模組與擁有者：** `main/detection` 下分 `adapters/<source>/`、`inference`、`reducer`、`sessions`，擁有 session 清單、8 狀態、顯示名稱。`main/pool` 擁有顯示／釋放，持久化在 `userData/assignments.json`（帶 `schemaVersion`、temp＋rename、只往前遷移），寫入只走 `pool:*` invoke。計時值歸 `main/settings`，寫入走 `settings:patch`。新 handler 一律經既有的註冊函式；`main` 底下新資料夾之間也不得形成循環依賴（CI `no-circular`）。
- **事件契約（`src/shared`）：** 事件只有 `session.start|end|meta`、`turn.start|end`、`tool.start|end`、`approval.request|resolved`、`question.request|resolved`、`error`、`activity`。每筆帶 `source`、`sessionKey`（`<source>:<原生 id>`）、`ts`（epoch 毫秒，只用於排序與顯示）、`via`（`log`／`registry`／`inferred`）、`confidence`（由 `via` 推導，只有 `inferred` 是 `inferred`；schema 擋矛盾組合）。`tool.*` 帶 `toolCallId`；`approval.*`／`question.*` 帶 `requestId`（由工具觸發時等於 `toolCallId`）；工具沒給 id 時由轉接器產生，保證 start／end 一致。補讀事件標 `replay: true`，補讀完發帶 source 的 `sync.ready`。來源代碼：`claude-code`、`codex`、`gemini`、`cursor`、`copilot`、`demo`。
- **原生 id：** 每個來源只有一種，在 `src/shared` 列明：`claude-code`＝session UUID（transcript 檔名），狀態檔的 `sessionId` 對不到 transcript UUID 就不發事件；其他來源＝紀錄檔的 session id。轉接器內部合併多個 probe 並去重；原生 id 改變（`/clear`、新對話）＝舊 session `end`＋新 session `start`。
- **轉接器只翻譯：** 只照事實發事件，不得為了取得某狀態合成事件，也不得自己用逾時合成 `session.end`。同一條件的來源矛盾時，採信 registry > log > inferred。每個轉接器在 `src/shared` 宣告能力表：approval、question 各為 `exact` 或 `none`，並列出該工具的「提問類」工具名稱。
- **判斷器條件：** 每個 session 維護「進行中 tool 集合」與「未決 approval／question 集合」（用集合，不用計數）。`approval`＝有未決 approval，由同 `requestId` 的 resolved、同 `toolCallId` 的 `tool.end`、`turn.end`、`session.end` 關閉；`decision` 同理對應 question；`error`＝收到 `error` 起，到下一個 `turn.start`／`tool.start` 或 `errorHoldMs` 到期；`working`＝tool 集合非空；`thinking`＝turn 進行中；`done`＝`turn.end` 起 `doneMs` 內；`waiting`＝不在 turn、不在 `done`、最後事件在 `idleMs` 內；`idle`＝超過 `idleMs`。優先序 `approval` > `decision` > `error` > `working` > `thinking` > `done` > `waiting` > `idle`。`turn.end` 清空該 turn 未關的 tool／approval／question；`activity` 只更新最後事件時間；`session.meta` 只更新顯示名稱等中繼資料。
- **生命週期與推測：** session 結束只由 `sessions` 決定：收到 `session.end`、有 pid 的來源回報行程不存在，或最後事件起超過 `sessionExpireMs`。啟動時只補讀最後修改在 `discoveryWindowMs` 內的紀錄；`replay` 事件只重建條件集合，不啟動推測計時、不產生 `done`，`sync.ready` 之後才開始計時。所有計時用收到事件時的單調時鐘。推測只在 `inference` 一處，只對能力表為 `none` 的項目：工具開始超過 `approvalInferMs` 沒結束，產生 `via: inferred` 的 `approval.request`（提問類工具改為 `question.request`），以 `toolCallId` 關聯，收到同 id 的 exact 事件或 `tool.end` 就取代或關閉。已知限制：跑很久的工具（build、測試）會被推測成 `approval`。
- **常數與預設：** `doneMs`、`idleMs`、`approvalInferMs`、`discoveryWindowMs`、`sessionExpireMs`、`syncTimeoutMs`、`errorHoldMs` 的預設只在 shared 設定 schema 定義一次（後四個的數值實作時給）；狀態檔重讀節流等運行常數只在 `src/shared/constants`。
- **各來源的唯讀位置與已知缺口：**
  - `claude-code`：狀態檔 `~/.claude/sessions/<pid>.json`＋transcript `~/.claude/projects/<cwd>/<id>.jsonl`；批准為 exact，狀態檔不可用時改推測。
  - `codex`：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，顯示名稱優先取 `~/.codex/session_index.jsonl`；批准、提問抓不到（`none`），錯誤只在紀錄有寫時顯示。
  - `gemini`：`~/.gemini/tmp/<專案>/chats/session-*.jsonl`；批准抓不到；工具呼叫要完成才寫入時，`working` 由推測或下一筆紀錄補上，並寫進能力表。
  - `cursor`：`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`（IDE 與 cursor-agent CLI 同格式）；批准只能推測；`turn_ended` 的 error 多為使用者中止，要看錯誤字串，中止視為一輪結束；檔案可能整檔重寫（變小時整檔重讀並去重）；顯示名稱由 slug 推出候選專案路徑，只 stat 檢查存在、不讀內容，找不到就用 slug。
- **示範模式：** 實作成 `demo` 轉接器，輸出同一套共用事件、走同一個判斷器（之後也走同一池子與世界），不另寫繞過偵測的邏輯。
- **StageView：** 新增 sessions（`sessionKey`、來源、顯示名稱、狀態、`confidence`，含已釋放）、轉接器健康（`ok`／`degraded`／`missing`，由 `main/detection` 發佈）與計時設定。新增區段時先驗證再前進 `rev`，避免一筆壞資料卡住整個推送；並定義同一次變更跨區段的增量合併規則（目前一次 `settings:patch` 會產生 settings、canvas 兩個增量）。
- **測試：** 判斷器與推測用「事件序列 → 狀態序列」表格測試（假時鐘，涵蓋優先序、`done`／`idle`、`replay`、推測）；轉接器用 `test/fixtures/<source>/` 做「紀錄 → 共用事件」快照測試（Claude Code 含狀態檔樣本）；每個新 schema 做往返與拒絕測試。Playwright `_electron` 端到端以 `demo` 為事件來源，同時在 CI 加入建置步驟並檢查 preload 產物只 require `electron`；settings → StageView → canvas 的整合測試也可一併補上。面板元件測試要不要引入 jsdom／happy-dom，在面板有實際內容時決定。

## UX & Interaction Patterns

- 沒有 UX 設計文件，面板版面開發時決定。面板只訂閱 StageView，寫入走擁有者的 invoke，不先改本地狀態。
- 「管理 session」頁：每列顯示來源、顯示名稱、中文狀態名，推測的狀態有明顯不同的標示，可「釋放」／「改回顯示」；另有轉接器健康列表。
- 示範模式從選單列／系統匣開啟（選單只在 `main/windows` 一處定義）：8 個假 session 輪播 8 種狀態、面板即時更新，關閉後假 session 結束。
- 第一次使用的引導：認得出的選單列圖示，以及「關掉面板後 app 仍在選單列執行」的提示（Epic 1 驗收時使用者找不到圖示、以為關面板就結束了）。
- 舞台設定頁在螢幕選項之外加三個計時欄位：做完了過場（5 秒）、無動靜轉休息中（5 分鐘）、推測要你批准（10 秒）。patch 結果要回報是否真的保存，沒保存（例如 `settings.json` 無法寫入）就提示使用者，不能顯示成功。
- 目前沒有面板頁會擋下卸載；若要攔「未送出內容」，先決定規則：面板不得阻擋卸載，或結束被取消後畫布能恢復（結束流程會先停掉畫布，目前無法恢復）。

## Cross-Story Dependencies

- 建在 Epic 1 上：IPC 註冊函式與共用 schema（1.3）、設定與 StageView（1.4）、選單與面板視窗（1.5）、舞台設定頁（1.6）。不受 1.2 沙盒閘門影響。
- 2.1 → 2.2 → 2.3：先有事件契約與判斷器，再加生命週期、補讀與推測，最後用 `demo` 轉接器把整條管線接到 StageView 與面板。
- 2.4～2.7 彼此獨立，都建在 2.1～2.3（共用事件、能力表、推測、面板、健康狀態）上。
- 2.8 建 `main/pool` 與 `assignments.json`，依賴 2.2 的 `sync.ready`：所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）後，丟棄沒被重新回報的持久化紀錄。
- 2.9 在 1.6 的舞台設定頁加欄位；2.1 的判斷器與 2.2 的推測要能立即改用新值。
- 後續沿用：Story 3.4 在 2.8 的 `main/pool` 上加角色分配與 `actorId`，所有來源 `sync.ready` 前不建新分配；Story 3.8 在畫布上用另一種標記顯示推測狀態；Epic 5 的展示模式擴充同一個 `demo` 轉接器（指定只對 `demo` 來源有效）；Epic 6 的 `copilot` 轉接器只依賴本 epic 的事件契約、能力表與推測。
