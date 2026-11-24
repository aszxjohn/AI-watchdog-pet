# Epic 3 Context: 角色包上台

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

讓角色包真正上台：使用者匯入 `.awpet` 後，每個顯示中的 session 從池子分到一隻角色（一個 `actorId`）。角色包程式在沙盒裡只回傳繪圖指令，舞台用單一 PixiJS 畫布依 8 狀態演出，並在角色頭上畫名牌與狀態標記。包當掉會自動重啟；包停用或角色消失時換角色，其他角色照常演出。這是「每個 session 一隻桌寵」的核心，也是 Epic 4（遊走、互動、招式）與 Epic 5（編輯頁、展示模式）的地基。3.1～3.6（契約、匯入、管理頁、池子、沙盒、節拍與繪圖）已完成；2026-11-24「移動與彈道歸舞台、演出歸包」的變更不需要重做它們，剩下 3.7～3.9。遊走、捏起來拖走、右鍵角色選單、跨包事件、發射與招式都不在本 epic 範圍。

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

- **演出對應：**
  - 角色 `states` 有該狀態，就送原狀態。
  - 沒有，但 `fallback` 有指定，就送指定的狀態。
  - 兩者都沒有時，舞台畫內建佔位；該 actor 的 `draw` 一律忽略，直到狀態改變。
  - 空的 `draw` 代表這格不畫，不觸發佔位。
  - `done` 是過場，預設 5 秒後轉 `waiting`；預設 5 分鐘沒有事件轉 `idle`。秒數沿用舞台的計時設定。
- **名牌與標記：**
  - 由舞台畫，包不畫。位置用 manifest 該角色的 `anchor`（本地座標）。
  - 名牌顯示 session 顯示名稱；名稱變更時名牌即時更新，包也收到 `meta`。
  - `confidence` 為 `inferred` 的狀態用另一種標記，要和確定的狀態看得出差別。
  - 固定參數 `badges`（逐角色）關閉時，名牌與標記都不畫。
- **失敗與重啟：**
  - 觸發條件：心跳逾時（以 tick 計）、連續 `drawTimeoutMs` 沒有有效 `draw`、超過上限、未捕捉的例外。
  - 處理：`pack-host` 移除該包 iframe（連帶終止 Worker，不呼叫 `worker.terminate()`），該包的 actor 改演佔位，經 IPC 回報 `packs:runtime-failed`（`packId`、`version`、原因）。
  - 之後自動重建沙盒，以原 `actorId` 重新 `spawn`。同一包在本次執行最多重啟 3 次。
  - 第 4 次失敗時，`main/packs` 把該版本標為失敗（視同停用，不寫回角色包），經 StageView 發佈，角色包管理頁顯示原因。
- **換角色：**
  - 觸發條件：包被停用、移除、標為失敗，角色取消加入池子，或包更新後角色消失。
  - 處理：`main/pool` 立刻把受影響的分配換成池子裡的其他角色。舊 actor 結束，新 actor 拿新的 `actorId`。
  - 池子＝上場的包 ∩「加入池子」為開的角色。池子用完前畫面上不重複，用完才重複（挑出場次數最少者）。
  - 池子空了就收回角色，session 仍留在管理清單。
- **包更新：** 安裝成功後卸除舊沙盒，以新版本 URL 重載。仍存在的角色保留原 `actorId` 重新 `spawn`。素材 URL 帶版本，新舊不會混用。
- **示範模式（2026-11-24 改）：**
  - 示範模式是開發用的獨立模式，和一般模式互斥。
  - 開啟時真 session 的角色全部下台，session 仍留在清單。示範 session 演使用者從選單列指定的角色：任何已安裝、相容的角色都可以，不看池子。
  - 對 3.9 的影響：停用包、把角色移出池子都不影響示範。示範角色被移除，或新版本沒有它時，結束示範。
  - 關閉示範後，被收起的 session 帶原角色回來；原角色已不在池子時，照一般規則挑。
- **隔離與不變條件：**
  - 錯誤只影響那一包，記錄時帶 `packId`；一包變慢不拖累其他角色（每包最多一則 `frame` 在途，renderer 永不等待）。
  - 沒有角色包時一切照常、畫布為空；`src/` 不得出現角色或系列名稱、契約測試包的 id 字面值；完全不連網。

## Technical Decisions

- **API 版本：**
  - Epic 3 交付的是角色包 API 1.0。
  - 2026-11-24 新增的 1.1 項目由 Story 4.6、4.9 實作並升 minor，本 epic 不做。這些項目是：
    - manifest 的 `moves`、`stateMoves`；
    - `projectiles` 的 `{ asset, speed, range }` 寫法；
    - `stage.move`；
    - `frame.motion` 的 `move`、`step`、`progress`、`returning`；
    - `stage.fire` 必填的 `from`，以及 `angle`。
  - 舞台只送包宣告的 minor 以內的訊息與欄位，包必須忽略不認得的部分。
  - 載入前要再檢查一次 `apiVersion` 是否相容。
- **位置歸舞台、演出歸包：**
  - actor 的世界位置只由 `overlay/world` 擁有。包不能指定位置，也看不到座標。
  - `bounds` 是跟著 actor 走的近身繪圖框，超出的部分裁切；它不是活動範圍。不得用繪圖偏移模擬位移。
  - 舞台替 actor 畫或計算的東西（佔位、名牌、標記、hitbox、`bounds` 裁切）都以 actor 當下的世界位置與「大小」為準，位置一動就跟著走。Epic 4 的遊走、拖曳與招式都會移動 actor。
- **狀態對應：** 由 `overlay/pack-host` 依 manifest 靜態對應。`frame` 裡送的是對應後的狀態。
- **actor 身分：** `actorId` 由 `main/pool` 產生，app 執行期間不重用；一筆分配＝一個 session × 一個角色。重啟與更新保留原 `actorId`，換角色產生新的。
- **沙盒生命週期：**
  - 每包一個沙盒：第一個 actor 出現時建立，最後一個 actor 離場後 `sandboxIdleMs` 銷毀。
  - 心跳：`pack-host` 每 `heartbeatTicks` 個 world tick 送 `ping`，Worker bootstrap 在 Compartment 外回 `pong`。
  - 系統睡眠或鎖定時，節拍與心跳都暫停，暫停期間不判定逾時。
- **資料擁有者與狀態流：**
  - 失敗標記歸 `main/packs`，分配與換角色歸 `main/pool`；示範模式的切換只經 `main/pool` 的示範模式入口，在同一個 StageView batch 裡完成。
  - renderer 只訂閱 StageView，寫入只走擁有者的 invoke；一筆分配的建立和該 actor 的第一個狀態在同一個增量裡。
- **常數：** `drawTimeoutMs`、`heartbeatTicks`、`sandboxIdleMs` 等運行常數只在 `src/shared/constants` 定義一份。
- **測試：**
  - `overlay/world` 與 `src/main` 的純邏輯用 Vitest，以假時鐘測試。
  - 契約測試包是 API 1.0 的驗收樣本。用它驗證：一輪結束先演 `done` 5 秒，再轉 `waiting`。
  - 契約測試包裡有一個狀態既沒實作也沒有 `fallback`（3.6 時那種 actor 不畫），可以當佔位的驗收案例。

## UX & Interaction Patterns

- 沒有 UX 文件。佔位演出與標記樣式在開發時決定，但確定與推測的標記必須看得出差別。
- 角色包管理頁要顯示執行失敗的原因：第 4 次失敗後，該版本視同停用。
- 用示範模式驗收演出：
  - 選單列「示範模式」子選單依序是「關閉」、角色清單（上次選的排第一）、8 個狀態。
  - 選角色就清場並開始示範，角色先演「休息中」。

## Cross-Story Dependencies

- **本 epic 內：**
  - 3.7、3.8 建在 3.6 的節拍與繪圖上。
  - 3.9 需要 3.4（池子）、3.5（沙盒）、3.6（節拍、`frame` 在途）。失敗期間演的是 3.7 的佔位。
- **已完成的 story 交給 3.9 的事：**
  - 3.4 決定池子在執行中變小時，已分配的角色不動；換角色留給 3.9。
  - 3.5 的沙盒失敗目前只做到移除 iframe、記一行。版本改變時，3.5 已會拆舊沙盒、依新版本重建；自動重建、重試上限、保留 `actorId` 重新 `spawn` 屬於 3.9。
  - 3.6 沒有處理 `frame` handler 永遠不回的情況（在途標記不會清），要靠 3.9 的 `drawTimeoutMs` 判定失敗。
  - 包可以跨格囤積 `stage.snapshot` 的 ImageBitmap，目前沒有每包的記憶體上限（例如每個 actor 最多留幾張）；留到 3.7～3.9 的失敗判定時一起決定。
  - 同版本覆蓋安裝後畫布不會重載（沙盒、外觀、貼圖都以版本當 key）。這件事原本交給 3.9 一起處理，2026-11-24 改記為待討論、另開工作。暫時的做法是重新匯入時把版本號加 1。
- **與其他 epic：**
  - 跨包通用事件在 Epic 4：Story 4.5 由 `overlay/world` 送 `enter`／`leave`（含換角色時的舊 actor `leave`、新 actor `enter`）與 `proximity`，由 `pack-host` 送 `state-broadcast`；`grab` 在 4.4，`hit` 在 4.6。
  - Epic 4 也會加上遊走、拖曳、右鍵角色選單、發射與招式；其中 4.6、4.9 會把 API 升到 1.1。
  - Epic 5 沿用同一個「加入池子」值與有效參數的計算。
