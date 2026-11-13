# Epic 3 Context: 角色包上台

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

讓角色包真正上台：定義有版本的角色包 API v1 與 `.awpet` 格式；使用者能匯入角色包（危險或不相容的包被擋下並說明原因）、匯出、選擇哪幾包上場、哪些角色加入池子。每個顯示中的 session 從池子分到一隻角色（一個 `actorId`）。角色包程式在「iframe → classic Worker → SES Compartment」沙盒裡執行，只回傳繪圖指令，由舞台用單一 PixiJS 畫布依 8 狀態演出，頭上畫名牌與狀態標記。包當掉會自動重啟；包失敗或被停用時換角色，其他角色不受影響。這是產品「每個 session 一隻桌寵、依狀態演出」的核心，也是 Epic 4（遊走與互動）、Epic 5（編輯頁與展示模式）的地基。沙盒原型閘門（Story 1.2）已通過，可照現行架構開工。遊走、捏起來拖走、右鍵角色選單、跨包互動不在本 epic 範圍。

## Stories

- Story 3.1: 角色包 API v1 契約與契約測試包
- Story 3.2: 匯入與安裝 .awpet
- Story 3.3: 角色包管理頁
- Story 3.4: 池子與 session 分配
- Story 3.5: 角色包沙盒與載入鏈
- Story 3.6: 世界節拍與統一繪圖
- Story 3.7: 依狀態演出、後備與佔位
- Story 3.8: 名牌與狀態標記
- Story 3.9: 角色包當掉與換角色

## Requirements & Constraints

- **池子與分配：** 池子＝上場的包 ∩「加入池子」為開的角色。每個顯示中的 session 分到一隻。池子用完前畫面上不重複，用完才重複（挑出場次數最少者）。session 結束時角色放回池子。已釋放的 session 不分配角色，但仍留在管理清單。所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）前不建新分配。示範模式的假 session 照同一套規則分配。
- **匯入：** 以下情況拒絕並顯示原因（例如「需要舞台 API ≥ x.y」）：含 `..`、絕對路徑或捷徑檔；超過解壓總大小、檔案數、圖片寬高或總像素上限；manifest 不符 schema；入口無法解析；`apiVersion` 不相容。相容＝主版號相同，且包的 minor ≤ 舞台 minor；安裝與載入時都要檢查。同 `packId` 已安裝時，顯示新舊名稱與版本，經使用者確認才替換；降版另外警告。安裝先解到暫存，成功才替換，失敗就回復舊版。所有匯入入口（面板、第二實例帶來的檔案）走同一個匯入流程。
- **匯出：** 只含角色包本身，不含使用者的調整。
- **演出：** 角色 `states` 有該狀態就送原狀態；沒有、但 `fallback` 有指定，就送 fallback 指定的狀態；兩者都沒有時由舞台畫佔位，該 actor 的 `draw` 一律忽略，直到狀態改變。空的 `draw` 代表這格不畫，不觸發佔位。計時沿用 Epic 2 的設定（`done` 5 秒後轉 `waiting`、5 分鐘沒事件轉 `idle`）。
- **名牌與標記：** 由舞台畫在 manifest `anchor` 的位置，包不畫名牌。推測的狀態（`confidence: inferred`）用另一種看得出差別的樣式。固定參數「名牌與標記顯示」關閉時兩者都不畫。顯示名稱變更時名牌即時更新，包也收到 `meta`。
- **失敗與換角色：** 以下任一情況，舞台移除該包的 iframe，角色改演佔位，並回報 `packs:runtime-failed`：心跳逾時（以 tick 計）、連續 `drawTimeoutMs` 沒有有效 `draw`、超過上限、未捕捉的例外。之後自動重建沙盒，保留原 `actorId`。同一包在本次執行最多重啟 3 次；第 4 次失敗時，該版本標為失敗（視同停用，不寫回包），角色包管理頁顯示原因。以下情況要立刻把受影響的角色換成池子裡的其他角色（舊 actor `leave`、新 actor `enter`）：包被停用、移除或標為失敗，角色取消加入池子，或包更新後角色消失。池子空了就收回角色，session 留在清單。
- **隔離：** 包碰不到檔案、網路、系統指令、對話內容、別的包、舞台設定，也看不到 `sessionKey`、`source`、`confidence` 與別包的身分。錯誤只影響那一包（記錄時帶 `packId`）；一包變慢不拖累其他角色。
- **不變條件：** 沒有角色包時一切照常，畫布為空。`src/` 不得出現任何角色或系列名稱（CI 掃描契約測試包的 `packId`、`characterId` 字面值）。完全不連網。判別值用英文代碼，中文只在顯示層。角色宣告的身高偏離推薦的 110 基準像素 ±25%（約 83～138）時只提示，不擋匯入、不自動換算。

## Technical Decisions

- **尚未安裝、要鎖確切版本的套件：** yauzl 3.4.0（讀 `.awpet`）、yazl 3.3.1（匯出）、@playwright/test 1.64.1（沙盒安全測試）。`ses` 2.3.0、`pixi.js` 8.22.0 已在依賴中。
- **契約與版本：** manifest、舞台↔包訊息、繪圖指令、API 版本常數只放在 `src/shared/pack-api/`，除 zod 外不依賴任何東西。新增訊息、指令或欄位升 minor；移除或改變語意升 major。舞台只送包宣告的 minor 以內的訊息與欄位，包必須忽略不認得的部分。
- **`.awpet` 與 manifest：** `.awpet` 是 zip，根目錄一個 `<packId>/`，內含 `manifest.json`、程式與素材。`assets` 是 key → 單張圖或 PixiJS spritesheet JSON；`projectiles` 指向 `assets` 的 key。`packId`、`characterId` 符合 `^[a-z0-9][a-z0-9-]{1,63}$`，所以不可能以 `_` 開頭（`pack://_stage/` 是保留主機）。`characterId` 是跨版本的穩定身分，改名視同舊角色消失。
- **入口與包能用的 API：** `entry` 是已自行打包、不含 `import`／`require` 的單一 classic script，求值結果是工廠函式 `(stage) => handlers`；`handlers` 的鍵是訊息名稱，`frame` 的回傳值就是該 tick 的 `draw`。其他格式在安裝時拒絕。包唯一能用的是 `stage`：`fire`、`random(actorId)`、`log`、`canvas`、`hold`、`face`（`fire`、`hold`、`face` 的世界行為在 Epic 4）。時間只來自 `frame.t`。以下限制要寫進角色包作者文件：Compartment 內沒有 `Date`、`Math.random`、`console`、計時器、`Float32Array`／`Float64Array`；Worker 不是 secure context（沒有 `crypto.subtle`）；`Iterator.prototype.join`／`includes` 已移除。
- **actor：** `actorId` 由 `main/pool` 在建立分配時產生（不透明字串，執行期間不重用）。一筆分配＝一個 session × 一個角色＝一個 `actorId`；換角色＝舊 actor 結束、新 actor 產生。舞台↔包訊息、世界實體、繪圖一律以 `actorId` 定址，同一角色可以同時有多個 actor；`characterId` 只用來選外觀與參數。
- **訊息：** 舞台→包有以下幾種：
  - `init`：現場所有 actor 與其狀態，己方 actor 另含 `characterId`。沙盒建立或重啟後的第一則，不補發歷史。
  - `spawn`／`despawn`：己方 actor 加入或移出，含 `characterId`、完整有效參數、狀態、顯示名稱。
  - `params`：某角色的完整有效參數，同一角色每 tick 至多一則。
  - `meta`：己方 actor 的 session 顯示名稱。
  - `frame`：`seq`、`t`、`dt`、己方 actor（已對應後）的狀態與 `motion`、本 tick 的事件。

  包→舞台只有 `draw` 與 `stage.*`。心跳 `ping`／`pong` 由 Worker bootstrap 在 Compartment 外處理。
- **沙盒載入鏈：** 每包一個 `<iframe sandbox="allow-scripts">`（不給 `allow-same-origin`），文件由 `pack://_stage/sandbox.html` 提供。SES 與 Worker bootstrap 在建置時內嵌，雜湊寫進 CSP；CSP 字串只由 `src/sandbox` 一個模組產生。
  - 載入順序固定：`main/packs` 經 IPC 交出入口原始碼 → `pack-host` 建 MessageChannel，把一端 port 與原始碼 `postMessage` 給 iframe → iframe 以 bootstrap＋入口組成 blob、建 classic Worker 並 transfer port。之後 iframe 不轉發任何訊息。
  - bootstrap 的順序：沿原型鏈刪除網路、儲存、Worker 相關 API → 逐條刪除「SES 尚未認得的 intrinsics」清單（只在 `src/sandbox` 一處列名）→ 不帶選項的 `lockdown()`（不得有任何警告）→ 放進 Compartment。
  - 該包第一個 actor 出現時建立沙盒，最後一個 actor 離場後 `sandboxIdleMs` 銷毀。終止的方式是移除 iframe，不呼叫 `worker.terminate()`。
  - 升級 Electron、SES 或修改 lockdown 選項時，要跑完全部沙盒測試；出現新警告就更新清單並請使用者確認。
  - `prototypes/sandbox/` 與 `sandbox-prototype-report.md` 是已驗證過的參考做法。
- **Electron 層：** `pack` scheme 權限為 `standard`、`secure`、`corsEnabled`，不給 `bypassCSP`，只在 `main/windows` 於 ready 前註冊。`pack://` 處理器歸 `main/packs`，URL 只有 `pack://_stage/…` 與 `pack://<packId>/<version>/<path>` 兩種形狀，只回應 manifest 宣告的素材與入口。`webRequest` 只放行 `app://`、`pack://`；沙盒在任何環境都沒有 dev server 例外。
- **節拍與繪圖：** `overlay/world` 是節拍唯一的擁有者（`tickHz` 30）。每包同時最多一則 `frame` 在途，上一則沒回就跳過，不排隊；renderer 每個顯示幀用該包最後一則有效的 `draw`，永不等待。座標是 actor 本地座標（原點為腳底中心、單位為基準像素、y 向下），外層依序套 world 位置、「大小」、actor 之間依 y 排序；超出 `bounds` 的內容裁切。素材以 manifest key 引用，renderer 從帶版本的 `pack://` URL 載入並快取。載入任何貼圖前必須設 `Assets.setPreferences({ preferCreateImageBitmap: false })`，否則載入會靜默卡住。命中與滑鼠穿透只看 manifest `hitbox` ×「大小」。`src/overlay` 不引入 React。系統睡眠或鎖定時暫停節拍與心跳，暫停期間不判定逾時。
- **參數有效值：** 只由 `main/settings` 讀 manifest 計算。覆蓋值符合該參數目前的宣告才採用，否則用 manifest 預設值；不符合的覆蓋值保留在設定檔但不套用。包收到的是完整值。固定參數由舞台套用、不傳給包，取值順序為「舞台覆蓋值 ?? manifest `defaults`（只能給 `scale`、`wander`）?? 舞台預設」。固定參數的預設寫在 `src/shared`：`scale` 0.5～2.0、每格 0.1、預設 1.0；`inPool` 預設開；`badges` 預設開；`wander` 的 `enabled` 預設開、`areas` 預設 `[6, 7, 8]`、`activity` 與 `speed` 預設 `medium`。角色 key 為 `<packId>/<characterId>`。設定寫入只走 `settings:patch`。
- **資料擁有者：**
  - `main/settings`（`settings.json`）：上場的包、加入池子、固定參數、覆蓋值。
  - `main/packs`（`userData/packs/index.json`＋`<packId>/<version>/`）：已安裝的包、失敗標記。
  - `main/pool`（`assignments.json`）：分配與 `actorId`。

  持久檔都帶 `schemaVersion`、只往前遷移，寫入一律 temp＋rename。
- **StageView：** 新增 actors（`actorId`、`sessionKey`、`characterKey`、狀態、`confidence`、顯示名稱）、已啟用的包與版本與失敗標記、各角色的有效參數與固定參數。一筆分配的建立與該 actor 的第一個狀態必須在同一個增量裡。新區段先驗證，再前進 `rev`。
- **常數：** 以下常數只在 `src/shared/constants` 定義一份，數值實作時給：`tickHz`、`drawTimeoutMs`、`heartbeatTicks`、`sandboxIdleMs`、訊息限速、每則 `draw` 的指令數與位元組數、emitter 數、`bitmap` 尺寸與每秒張數、匯入的各項上限。超過上限一律整則丟棄並記錄 `packId`。粒子 preset 清單由 renderer 一處定義，放在 `src/shared/pack-api` 的常數。
- **測試：** 每個 schema 都要有往返與拒絕測試。`test/packs/contract-pack/` 是 API v1 的驗收樣本：不含角色名稱、至少 2 個角色、只實作部分狀態並宣告 `fallback`、每種參數型別各一個。沙盒安全測試用 Playwright `_electron` 在真的 Electron 裡跑，CI 的 macOS 與 Windows 都要通過，必須同時斷言：
  - 指定的逃逸嘗試全部失敗。
  - 正向對照：測試包在 Compartment 內成功執行並回報。
  - Worker 從載入 SES 到 `lockdown()` 結束的 console 輸出為 0 行。
  - 清單每一條都回報已移除。

  原型只在 macOS arm64 驗證過。

## UX & Interaction Patterns

- 沒有 UX 設計文件。面板版面、佔位演出、標記樣式都在開發時決定，但「確定」與「推測」的標記必須看得出差別。
- 「角色包」面板頁：
  - 列出已安裝的包（名稱、版本、角色清單、是否上場），可以匯入新包。
  - 每個角色一個「加入池子」勾選框，和 Epic 5 的編輯頁是同一個值；身高偏離推薦值時在該角色旁提示。
  - 匯出時讓使用者選存檔位置；移除前要確認。
  - 匯入被拒絕的原因、替換確認（新舊名稱與版本、降版警告）、執行失敗的原因都在這一頁呈現。
- 面板只訂閱 StageView，寫入走擁有者的 invoke，不先改本地狀態。patch 沒有真的保存時要提示使用者，不能顯示成功（沿用 Epic 2 的做法）。
- 畫布上的角色先依序排在畫面底部，遊走在 Epic 4 才加入。
- 示範模式目前是一個顯示使用者指定狀態的假 session，從系統匣選擇狀態。
- Epic 2 驗收用的示範方塊空殼，在真角色上畫布後移除：`src/overlay/demo-square.ts`、overlay 畫方塊的部分、只認示範 session 的右鍵選單。保留 `src/overlay/pointer.ts` 與 `canvas:set-hover`、`canvas:context-menu` 兩個通道，角色 hitbox 直接交給 `pointer.ts`。右鍵角色選單本身是 Story 4.3 的範圍。

## Cross-Story Dependencies

- **建在 Epic 1、2 上：** IPC 註冊函式與 `src/shared` schema、settings 與 StageView（含 `settings:patch`）、畫布與滑鼠穿透（1.6）、偵測事件與 session 生命週期及 `sync.ready`（2.2）、`demo` 轉接器（2.3）、`main/pool` 與 `assignments.json`（2.8）、計時設定（2.9）。沙盒閘門（1.2）已通過，3.1 與 3.5 起的 story 可以開工。
- **本 epic 內的先後（由各 story 的驗收條件推得）：**
  - 3.1（契約與契約測試包）是其他所有 story 的前提。
  - 3.2 提供安裝流程與 `pack://` 處理器；3.3 在其上做管理頁，寫入「上場」與「加入池子」。
  - 3.4 需要 3.1 的角色定義與上場／加入池子設定，並擴充 2.8 的 `main/pool`。
  - 3.5 需要 3.2 的 `pack://` 處理器與入口原始碼。
  - 3.6 需要 3.4 的 actor 與 3.5 的沙盒；3.7、3.8 建在 3.6 上；3.9 需要 3.4～3.6。
- **指名由 Epic 3 處理的待辦：**
  - **3.5：** 開發模式放行 dev server 時要檢查請求的發起者，只放行 overlay、panels 頂層框架發出的請求，`pack://` 發出的一律 cancel，並附測試（Epic 1 回顧 A8）。
  - **3.4：** 決定 `assignments.json` 是否改為逐 key 驗證（目前一個壞 key 就整檔當壞檔），以及 pool 寫檔失敗要不要回報（settings 有 `saved`，pool 沒有）。
  - **3.6，overlay 同時讀 settings 與 canvas 之前：** 先合併同一次 `settings:patch` 產生的兩個增量。
  - **3.6，畫布換螢幕與位置：** 換到縮放比例不同的螢幕時，依 `canvas.scaleFactor` 調整 PixiJS 的 resolution；canvas 區段目前發佈的是要求的位置，不是實際位置。
  - **3.6，有節拍之後：** 一起設計 WebGL context lost、GPU 行程當掉、renderer 無回應的處理。
  - **角色上台前：** macOS 整個 app 被隱藏時（Dock 圖示的「隱藏」、別的 app 的「隱藏其他」），畫布會一起被藏起來；要決定做法，並在實機確認。
  - **端到端測試：** 承接 story 仍未指定（Epic 2 回顧 B8），範圍包括 Playwright、不連網斷言、CI 建置與 preload 產物檢查。3.5 是第一個需要 Playwright `_electron` 的 story。
  - **沒有結束訊號的 session：** Gemini、Cursor 沒有行程結束的訊號，Claude Code 狀態檔那一半（2.4 後半）也還沒完成。在一輪中途被關掉的 session 會停在原狀態並佔著角色，直到 `sessionExpireMs`；實際影響在角色演出時再評估。
- **後續沿用：** Epic 4 在 `overlay/world` 與 `pack-host` 上加遊走、角色命中、捏起來、右鍵角色選單、通用事件、發射與 `hold`／`face`。Epic 5 的編輯頁顯示同一個「加入池子」值，沿用 3.6 的有效參數計算；展示模式擴充同一個 `demo` 轉接器。
