# Architecture Spine 審查（good-spine 檢查表）

- 審查對象：`ARCHITECTURE-SPINE.md`（AD-1～AD-15，status: draft，2026-11-02）
- 對照來源：`.memlog.md`（updated 2026-11-03T10:08）
- 審查日期：2026-11-03
- 方式：靜態閱讀與交叉比對；未寫任何程式、未做沙盒原型。文中標「需原型確認」的技術判斷是依 SES／Chromium 已知行為推論，不是實測結果。

## 結論

**有條件可用，還不能拿來拆 unit。** 決策骨架（微核心、唯讀偵測、8 狀態、世界歸舞台、單一 PixiJS 畫布、參數兩層）和 memlog 一致，沒有正面矛盾。但有三類缺口會讓平行開發的 unit 直接分歧：

1. **舞台↔角色包協定本體沒定**（scope 明寫包含「角色包契約」）：sandbox、pack-host、renderer、world 和每個第三方包都會各自發明。
2. **偵測的時間語意沒定**：session 何時算活著／結束、推測由誰做。5 個轉接器會各寫一套。
3. **作業面幾乎空白**：測試策略完全沒寫；開發／正式環境、打包、運行各只有一句或沒有。AD-7 的 CSP 也和開發環境、SES 本身衝突。

共 1 critical、6 high、7 medium、8 low。

## 檢查表結果

| # | 檢查項 | 結果 | 主要原因 |
| --- | --- | --- | --- |
| 1 | 修正下一層的真實分歧點，沒有遺漏 | 未通過 | 漏掉角色包 API 協定（C1）、session 生命週期（H2）、推測歸屬（H3）、preload／IPC 協定（M2）、世界與包內互動（H5） |
| 2 | 每條 AD 的 Rule 可執行且真的防住分歧 | 部分 | AD-7 的 CSP 字串照寫就跑不起來（H4）；AD-5 推測歸屬不明（H3）；AD-12 的 Prevents 與規則不符（L1）；AD-2／AD-1 沒有機械化檢查（L5） |
| 3 | Deferred 不會讓兩個 unit 分歧 | 部分 | 「是否凍結 Date」（C1、H4）、「推測門檻預設值」（H3、L8）、「沙盒實測」沒設閘門（H4、M1）都會造成分歧 |
| 4 | 本層該管的維度都已決定／延後／列為待決 | 未通過 | 測試策略完全空白（H1）；環境區分（H6）、打包與 app 生命週期（M5）、運行預算與健康回報（M6）只有一句或沒有 |
| 5 | 不與 memlog 決策矛盾 | 大致通過 | 沒有內容矛盾；但 AD-7、AD-15 的 [ADOPTED] 標記超出 memlog 記錄（M1），AD-12 的 Prevents 跟 memlog L40 不符（L1） |

---

## 發現（依嚴重度）

### C1 — 舞台↔角色包協定本體未定

- **嚴重度：** critical
- **位置：** AD-6、AD-7、AD-9、AD-10；Design Paradigm 表中 `src/shared` 的「角色包 API 訊息」
- **問題：** frontmatter 的 scope 寫明包含「角色包契約」，但協定只散落成幾句：AD-9 說「每格回傳繪圖指令」，AD-10 列了四種事件，AD-7 列了包可以取得的東西。協定本體沒定。以下各點，sandbox bootstrap、`overlay/pack-host`、`overlay/renderer`、`overlay/world` 和每個第三方包都會各自決定：
  1. **程式格式與進入點：** Compartment 執行的是 script，不是 ES module。包程式是單檔 IIFE 嗎？用 `register()` 回呼，還是用 export？manifest 的「程式進入點」是一包一個檔，還是一個角色一個？
  2. **生命週期與時序：** 每一格由誰驅動？是舞台送 tick、包回傳繪圖清單，還是包自己推送？MessageChannel 是非同步往返，回覆遲到時，舞台要沿用上一格還是跳過？tick 頻率多少？
  3. **實例身分：** 池子用完後，同一個角色會同時出現兩隻（memlog L40「池子用完才重複」）。同一包的所有角色又都在同一個沙盒裡。所以 API 必須用「實例 id」定址，不能用 characterId；也需要實例建立／銷毀事件。現在完全沒寫，包作者很可能預設一個角色只會有一隻。
  4. **座標系：** 繪圖指令裡的「位置、變形」相對於什麼？是角色錨點的本地座標還是畫布座標？單位是不是 DIP？y 軸向下嗎？這要怎麼和 AD-10「位置歸世界」不衝突？固定參數「大小」是不是由舞台整體縮放？
  5. **素材參照與格式：** 繪圖指令裡的「圖片、格」怎麼引用？是包內相對路徑嗎？spritesheet 用什麼格式？素材要事先宣告預載，還是可以動態載入？
  6. **事件內容：** 狀態事件帶不帶 `confidence`？`state-broadcast`、`enter`／`leave`、`proximity`、`hit` 會透露對方哪些資訊（packId？只有實例 id 和狀態？）？
  7. **後備演出（AD-6）：** 要在 manifest 宣告，還是由程式在執行時回報？
  8. **包內能用的 JS 內建：** 依 SES 文件，新的 Compartment 預設會馴化 `Date.now()`（回傳 NaN）和 `Math.random()`（直接丟錯）（需原型確認）。包作者如果用 `Math.random` 做粒子抖動或隨機待機動作，正式環境會直接壞掉。
- **修正：**
  - 新增 **AD-16「角色包 API v1」**，把上面 8 點都寫成規則。最少要涵蓋：單檔 classic script＋`stage.register({ characters })`；舞台驅動 tick，回覆有固定期限，逾時沿用上一格；以 `instanceId` 定址，加上 `instance.create`／`instance.destroy`；繪圖座標是角色錨點的本地 DIP、y 向下，大小由舞台套用；素材用包內相對路徑、spritesheet 固定一種格式、在 manifest 宣告後由舞台預載；事件內容只帶對方的 `instanceId` 和狀態，不帶 packId；後備演出寫在 manifest。
  - 型別和 zod schema 放在 `src/shared/pack-api/`，除了 zod 之外不依賴任何東西，日後可以抽成給包作者用的型別套件。
  - 在 `src/` 以外放一個不含任何角色名稱的「契約測試包」fixture，作為驗收樣本。
  - 從 Deferred 刪掉「是否連 Date 都凍結」，改在 AD-16 寫明：包內不能用 `Date`／`Math.random`；時間只用舞台的相對時鐘，亂數用舞台 API 提供的 `random()`（每個實例一個種子）。

### H1 — 測試策略完全空白

- **嚴重度：** high
- **位置：** 整份文件（沒有 Testing 段落）；Stack；Consistency Conventions
- **問題：** 沒有寫測試框架、各層怎麼測、轉接器用什麼樣本、沙盒逃逸怎麼測、CI 怎麼跑。這份 spine 要交給多個小 agent 平行做 unit，沒定就會各選各的框架，或乾脆不寫測試。更重要的是，轉接器讀的是會隨工具版本改變、甚至未公開的格式（memlog L52、L53）。沒有樣本回歸測試，格式一變就無從發現。沙盒是這個產品的安全核心，「每一層都真的擋住」也必須有自動化測試，不能只靠一次原型。
- **修正：** 新增 Testing 段落（或一條 AD）：
  - (a) shared／main／overlay 的純邏輯用 Vitest，版本列進 Stack。
  - (b) 每個轉接器用 `test/fixtures/<source>/` 下去識別化的真實紀錄檔，做「紀錄行 → 共用事件」快照測試；判斷器用「事件序列 → 狀態序列」的表格測試，涵蓋優先序與 `done`／`idle` 計時（用假時鐘）。
  - (c) 沙盒安全測試要在真的 Electron 裡跑（Playwright `_electron`）。逐一嘗試 fetch、XHR、WebSocket、EventSource、importScripts、巢狀 Worker、存取 parent／top、indexedDB、`Date.now`、`Math.random`，全部都必須失敗。
  - (d) 每個 zod schema 做往返與拒絕測試。
  - (e) E2E 用 demo 轉接器（AD-15）當事件來源。
  - (f) CI 至少跑 macOS 和 Windows。

### H2 — session 生命週期沒定，5 個轉接器會各寫一套

- **嚴重度：** high
- **位置：** AD-5、AD-6、AD-3（session 清單）
- **問題：** 紀錄檔會永久留在磁碟上，而 Codex、Gemini、Cursor、Copilot 都沒有明確的「session 結束」訊號。AD-5 列了 `session.start|end`，卻沒說三件事：啟動時回溯多久的紀錄算「還活著」；沒有明確結束訊號時，`session.end` 從哪裡來（process 消失？閒置多久？）；`idle` 之後多久會從畫面消失。結果可能是：某個工具一開 app 就冒出上百隻歷史 session，某個工具的角色永遠不離場，池子很快用完（AD-12 一個 session 一隻）。不同工具的行為也會不一致。
- **修正：** 在 AD-5 加規則：
  1. 啟動掃描只看最後修改時間在 `startupLookback` 之內的紀錄。這是舞台設定，預設值定在 shared。
  2. 轉接器只在有明確依據時發 `session.end`，例如 registry 的 pid 消失、紀錄檔寫明結束。
  3. 「閒置太久視為結束」統一由 `main/detection/sessions` 依 `sessionExpiry` 處理，轉接器不得自己計時。
  4. 明定 `idle` 到「離場」的條件。

### H3 — 推測（inferred）由誰做沒定，且與「轉接器只翻譯」矛盾

- **嚴重度：** high
- **位置：** AD-5；Deferred「推測門檻」
- **問題：** AD-5 寫「紀錄檔抓不到的批准、提問用推測產生」，沒說由誰產生。如果每個轉接器自己計時，就會有 5 套門檻和規則，也違反同一條 AD 的「轉接器只翻譯」。如果由判斷器推測，判斷器又得知道哪個來源抓得到批准：Claude Code 有 registry 的 `waitingFor` 可以精確得知，其他工具沒有。不知道的話，Claude Code 會被重複推測。此外，單憑「工具開始後超過門檻沒結束」分不出批准還是提問，也會把跑很久的工具（例如 build、測試）誤判成「要你批准」。
- **修正：**
  - 推測只在一個地方做，建議放在判斷器前一站 `main/detection/inference`。
  - 每個轉接器在 shared 宣告能力表，例如 `{ approval: 'exact' | 'none', question: 'exact' | 'none' }`，只對 `none` 的項目推測。
  - 推測只產生 `approval.request`，提問不推測（要推測就另寫規則）。
  - 門檻預設值只在 shared 的設定 schema 定義一次。
  - 推測產生的事件一律 `via: 'inferred'`。
  - 「長時間工具被誤判」寫成已知限制，並由 M4 的推測標記在畫面上區分。

### H4 — AD-7 第 1 層的 CSP 照寫跑不起來

- **嚴重度：** high
- **位置：** AD-7 第 1、3 層；Deferred「沙盒分層的實測」「是否連 JS 內建 Date 都凍結」
- **問題：** 寫死的 CSP `default-src 'none'; script-src blob:; worker-src blob:; connect-src 'none'` 和其他層不能同時成立：
  - iframe 文件由 `pack://` 提供，但 `script-src` 只允許 `blob:`。iframe 自己的 bootstrap script，不論來自 `pack://` 還是寫在頁面裡，都會被擋。這樣就沒有任何程式能去建立 blob Worker。
  - 用 blob 建立的 Worker 會繼承建立者的 CSP。SES 的 `Compartment.evaluate` 在實作上需要 eval／`Function` 建構子，CSP 沒有 `'unsafe-eval'` 時會失敗（需原型確認）。

  同一條規則又寫「任何一層都不得省略」。實作的人撞牆時只能各自改 CSP 或拿掉 SES，這正是 spine 要防的分歧。Deferred 裡的「沙盒實測」也沒說失敗時怎麼辦。
- **修正：**
  - 把 CSP 改成可運作、仍然封網的版本，並寫明理由。例如 `default-src 'none'; script-src 'sha256-<bootstrap>' blob: 'unsafe-eval'; worker-src blob:; connect-src 'none'`。`'unsafe-eval'` 只出現在 opaque origin 的沙盒 iframe 和 Worker 裡，圍堵靠的是 Worker＋Compartment＋封網三層，不靠禁 eval。
  - CSP 字串只由一個模組產生，並由 H1(c) 的測試覆蓋。
  - 把「沙盒原型」改成明確的**閘門**：原型通過前，不開始 sandbox、pack-host、AD-16 相關的 unit；原型失敗時由誰、怎麼修訂 AD-7，也要寫清楚。

### H5 — 世界歸舞台，與「同包角色互相互動」之間有缺口

- **嚴重度：** high
- **位置：** AD-10、AD-7（包可取得清單）、AD-3（世界）、AD-14（滑鼠命中）
- **問題：** memlog L22、L26 要求同一包的角色可以互相互動。AD-10 寫「包內特殊互動由包自己處理，不經過舞台」，但：
  - 包拿不到自己角色的位置（AD-7 的可取得清單沒有位置），也完全沒寫包能不能影響移動。包內互動（A 對 B 開火、兩隻靠近擊掌）要嘛做不出來，要嘛每個包作者各自要求舞台加能力。
  - 如果包內互動牽涉到投射物，投射物是世界物件，必須經過舞台。這和「不經過舞台」的寫法衝突。
  - 碰撞框和滑鼠命中的形狀從哪來沒定：是 manifest 宣告、繪圖結果的外框，還是 alpha？固定參數「大小」又怎麼作用在碰撞框上？
- **修正：** 在 AD-10 補四點：
  1. 每一格提供包「自己包內所有實例」的唯讀位置、朝向、狀態。
  2. 列出包可以對自己的實例發出的移動請求（例如停住、轉向、靠近某個實例），或明寫「包不能影響移動，只能在本地座標內做位移演出」。兩者擇一。
  3. 包內互動只要涉及世界物件（投射物、命中）就一律走舞台 API；只有純演出上的協調可以不經過舞台。
  4. 碰撞框＝manifest 為每個角色宣告的矩形 × 固定參數「大小」，滑鼠命中用同一個框；若要用 alpha 判定，要明寫。

### H6 — 沒有區分開發與正式環境，AD-7 的放行清單和工具鏈衝突

- **嚴重度：** high
- **位置：** AD-7 第 4 層；Structural Seed「部署」；Stack（Forge vite-typescript 模板）
- **問題：**
  - AD-7 規定 `webRequest` 只放行 `app://`、`pack://`。但 Forge vite-typescript 模板在開發時從 Vite dev server（`http://localhost:<port>`）載入 renderer，正式版預設用 `file://` 載入。照規則寫，開發模式會全部被擋。實作的人只能各自全域放行 localhost，或改回 `file://`。
  - `app://`、`pack://` 由哪個模組註冊沒寫（`protocol.registerSchemesAsPrivileged` 必須在 ready 前呼叫）。
  - `pack://` 同時要提供舞台自己的沙盒文件和各包的素材，路徑怎麼規劃也沒寫。
- **修正：** 新增「環境」規則：
  - 正式版所有視窗都走 `app://`，由 `main/windows` 註冊，指向打包後的 Vite 輸出；不使用 `file://`。
  - 開發模式只對 overlay、panels 兩個視窗額外放行 dev server 的 origin；沙盒 iframe 與 `pack://` 在任何環境都不放行。
  - 用 `app.isPackaged` 判斷環境，放行清單集中在一個模組。
  - `pack://` 路徑寫死：`pack://sandbox/…` 是舞台的沙盒文件，`pack://<packId>/…` 是包素材，由 `main/packs` 擁有。

### M1 — AD-7、AD-15 的 [ADOPTED] 標記超出 memlog 記錄

- **嚴重度：** medium
- **位置：** AD-7、AD-15 標題；Deferred「沙盒分層的實測」
- **問題：** memlog L61 記的是「研究建議，使用者未反對，需原型驗證」，沒有標 [ADOPTED]（其他採用的決策都有標）；L70 列的待確認清單也不包含它。spine 卻把 AD-7 標成 [ADOPTED]，還加上「任何一層都不得省略」，把狀態講得比實際確定。AD-15「展示與示範走同一條管線」的做法，memlog 只有「保留展示／示範模式」（L41），沒有使用者採用這個做法的紀錄。
- **修正：** AD-7 改標 PROPOSED（待原型），並附上 H4 的閘門；或請使用者確認後在 memlog 補一筆 [ADOPTED]。AD-15 同樣請使用者確認，或拿掉標記。

### M2 — preload 層與 IPC 協定沒定

- **嚴重度：** medium
- **位置：** Design Paradigm 層表；AD-2 依賴圖；Structural Seed 目錄；Consistency Conventions
- **問題：** AD-2 要求 renderer 只能經 preload 呼叫 main，但 preload 不在任何層、目錄或依賴圖裡。以下都沒定：
  - 兩個 renderer（overlay、panels）共用一個 preload，還是各一個？各自暴露哪些能力？型別從哪來？
  - IPC 通道怎麼命名、什麼時候用 invoke、什麼時候用 send、錯誤怎麼回傳。
  - 訂閱的「初始快照＋增量」協定。AD-3 只寫「訂閱」，overlay 與 panels 會各自發明；視窗重載或漏收一則之後就會跟 main 不同步。
- **修正：**
  - 層表加 `src/preload/`，下有 `overlay.ts`、`panels.ts`，各自只暴露最小 API，型別由 shared 的 IPC schema 產生；依賴圖補上 preload。
  - Conventions 加 IPC 規則：通道命名 `<domain>:<action>`；查詢和寫入用 invoke，回傳 `{ ok: true, data } | { ok: false, error }`；訂閱一律先回快照再推增量，每則帶遞增的 `rev`，跳號就重新拿快照；所有 handler 都透過同一個註冊函式，由它統一檢查 senderFrame（同時讓 AD-7 第 4 層可以被檢查）。

### M3 — 持久化資料的擁有者不明，設定檔沒有版本與遷移

- **嚴重度：** medium
- **位置：** AD-3、AD-12；Consistency Conventions「設定與檔案」
- **問題：**
  1. 「顯示／釋放」是使用者的選擇，而且要持久化。AD-3 把它歸給 `main/detection`，AD-12 又說「使用者可指定……分配結果由 `main/pool` 持久化」。面板的寫入請求該送到哪個模組不明。
  2. 規則只寫「只有 main 寫檔」。userData 底下有哪些檔案（設定、分配、已安裝包索引、紀錄）、各歸哪個模組、檔名是什麼都沒定，兩個模組可能寫同一個檔。
  3. 持久檔沒有 `schemaVersion`，也沒有遷移規則。搭配「讀不懂就改名、改用預設」，下一版只要改個欄位名，使用者的覆蓋值和池子設定就會被清掉。
- **修正：**
  - AD-3 改成：session 的顯示／釋放偏好歸 `main/settings`，以 sessionKey 存；`main/detection` 只擁有「偵測到的事實」。
  - 加一張 userData 檔案表，一個檔一個擁有者，例如 `settings.json` 歸 settings、`assignments.json` 歸 pool、`packs/` 歸 packs、`logs/` 歸 log。
  - 每個持久檔都帶 `schemaVersion`，由 `main/<擁有者>/migrations` 只往前遷移；遷移失敗才走 broken 流程。

### M4 — 名牌與標記由誰畫沒定

- **嚴重度：** medium
- **位置：** AD-9；AD-11（固定參數「名牌與標記顯示」）；AD-5（confidence）
- **問題：** memlog L40 保留了名牌與標記，AD-11 也有對應的固定參數，但沒有任何 AD 說由誰畫。包又拿得到 session 顯示名稱，可能自己再畫一次名牌，造成重複或風格不一。推測出來的狀態（`confidence: inferred`）要不要在畫面上區分，也沒定。
- **修正：** AD-9 補：名牌與狀態標記由 `overlay/renderer` 畫在包的繪圖層之上，受固定參數控制；包不得畫名牌（session 名稱只供演出用）。推測狀態用不同的標記樣式顯示，規則寫在 overlay。

### M5 — 打包與 app 生命週期幾乎沒寫

- **嚴重度：** medium
- **位置：** Structural Seed「部署」；Deferred「開機自動啟動、自動更新、簽章流程細節」
- **問題：** 打包只有一句「Forge makers 產安裝檔」。缺少：
  - 單一實例（`requestSingleInstanceLock`）。沒有的話，兩個實例會同時寫 userData，畫面上也會疊兩層畫布。
  - `.awpet` 檔案關聯與雙擊匯入（mac 的 `open-file`、Windows 第二實例的 argv）。
  - app 入口：系統匣或選單列？要不要隱藏 Dock／工作列圖示？點角色會發生什麼？
  - appId。memlog L69 要求 app id 也用這個名字，spine 沒寫。
  - 要用哪些 makers。

  另外，部署寫「不連任何伺服器」，Deferred 卻放了需要連線的「自動更新」，理由是「不影響各模組一致性」。這個理由不完全成立：自動更新會改變網路邊界，也牽涉 Windows 安裝器的選擇。
- **修正：** 新增打包／生命週期規則：
  - 單一實例。
  - `.awpet` 檔案關聯一律導向 `main/packs` 的匯入流程。
  - 所有平台都以系統匣為入口，從系統匣開面板視窗。
  - 明訂 appId（例如 `<reverse-dns>.ai-watchdog-pet`）。
  - makers：mac 用 dmg＋zip；Windows 在 squirrel 和 msix 之間擇一。
  - 明寫「第一版完全不連網；加入自動更新時必須修訂這一條」。

### M6 — 沒有運行預算、外部格式容錯與健康回報

- **嚴重度：** medium
- **位置：** AD-7 第 5 層（限速、心跳）；AD-9；AD-4；Consistency Conventions
- **問題：**
  1. **效能預算：** 沒有數字。畫布 fps 上限、每包每格的回覆期限、訊息限速、心跳間隔與逾時、閒置時要不要降頻，全都沒定。桌寵是常駐程式，這些直接決定耗電。如果這些常數由 pack-host 和 sandbox 兩邊各寫一份，就會不一致。
  2. **外部格式容錯：** Conventions 說跨邊界資料「收到就驗證」。如果轉接器也對 AI 工具的紀錄做嚴格的 zod 驗證，工具一更新格式，偵測就全斷。Claude Code 的即時狀態檔本身就是未公開格式（memlog L52）。
  3. **健康回報：** 轉接器失效（找不到目錄、連續解析失敗）時，面板看不到任何提示。
  4. **畫布復原：** overlay renderer 當掉後怎麼復原沒寫。
- **修正：**
  - 在 shared 定義一份運行常數（fps、tick 期限、限速、心跳），兩端引用同一份。
  - Conventions 加「外部來源寬鬆解析」：未知欄位放行、壞行跳過並計數、絕不丟例外。
  - 新增轉接器健康狀態（ok／degraded／missing），由 detection 發布，面板顯示。
  - `main/windows` 監聽 `render-process-gone`，重建畫布視窗並重送快照。

### M7 — 進階繪圖模式與素材尺寸會繞過 AD-9 的目的

- **嚴重度：** medium
- **位置：** AD-9（進階模式）；AD-13
- **問題：** 進階模式允許包在 Worker 裡用 OffscreenCanvas，但沒限定 context 種類。包如果在 OffscreenCanvas 開 WebGL 或 WebGPU，就回到 AD-9 要防的「每個角色一個 WebGL context、撞到上限」。包要怎麼申請進階模式（manifest 旗標？）也沒寫。另外，AD-13 限制了解壓總大小和檔案數，卻沒限制圖片的像素尺寸。素材是由 overlay 解碼的，overlay 不在沙盒裡；一張壓縮後很小、尺寸極大的 PNG 就能吃光畫布行程的記憶體。
- **修正：**
  - AD-9 補：進階模式只允許 `getContext('2d')`，bootstrap 封鎖 webgl／webgpu；必須在 manifest 宣告，使用者可在編輯頁關掉。
  - AD-13 補：安裝時檢查每張圖的寬高上限（例如 4096）和總像素數。

### L1 — AD-12 的 Prevents 與 memlog 不符

- **嚴重度：** low
- **位置：** AD-12 Prevents
- **問題：** Prevents 寫「同一角色同時出現兩隻」，但 memlog L40 是「池子用完才重複」。Rule 本身是對的，Prevents 卻會誤導，讓人以為同一角色永遠不會重複出現（連帶影響 C1 第 3 點）。
- **修正：** Prevents 改成「池子還沒用完時，同一角色重複出現」，並在 Rule 註明池子用完後會重複。

### L2 — AD-8 只有主版號，擋不住新功能不相容

- **嚴重度：** low
- **位置：** AD-8
- **問題：** 舞台加了相容的新 API 後，用到新 API 的包裝在舊版舞台上不會被擋，要到表演時才失敗，正是 AD-8 想防的情況。版本號的型別和舞台支援的範圍也沒寫。
- **修正：** `apiVersion` 改為 `"major.minor"`（字串，用 schema 驗證）。載入條件是主版號相同，且舞台的 minor ≥ 包宣告的 minor。舞台支援的版本常數定義在 shared。

### L3 — AD-5 的 `via` 與 `confidence` 資訊重疊

- **嚴重度：** low
- **位置：** AD-5 事件欄位
- **問題：** `via`（log／registry／inferred）和 `confidence`（exact／inferred）表達的資訊重疊，可能出現 `via: 'inferred', confidence: 'exact'` 這種自相矛盾的組合。
- **修正：** 只留一個欄位；或規定 `confidence` 由 `via` 推導，並在 schema 用 refine 擋掉不合法的組合。

### L4 — id 格式、同名包與參數變更沒處理

- **嚴重度：** low
- **位置：** AD-13；AD-11；Consistency Conventions 命名
- **問題：**
  - packId、characterId 沒有格式限制。key 用 `/` 分隔，id 裡含 `/` 或 `..` 就會出問題。
  - 不同作者用了同一個 packId 會互相覆蓋，因為安裝規則是「替換」。
  - AD-11 只處理「參數消失」，沒處理參數型別或範圍改變後，舊覆蓋值已經不合法的情況。
- **修正：**
  - shared schema 定 id 的正規式，例如 `^[a-z0-9][a-z0-9-]{1,63}$`。
  - 安裝同 packId 的包時，顯示新舊版本和名稱，讓使用者確認。
  - 套用覆蓋值前，先用目前的參數宣告驗證；不合法就不套用，但保留原值。

### L5 — AD-1、AD-2 沒有機械化檢查

- **嚴重度：** low
- **位置：** AD-1、AD-2
- **問題：** 依賴方向和「src 不得出現角色名稱」都只是文字規則，平行開發的小 agent 很容易不小心違反。AD-1 的「角色名稱」本身也無法列舉。
- **修正：** CI 用 dependency-cruiser 或 ESLint `import/no-restricted-paths` 強制 AD-2。AD-1 改成可以檢查的形式，例如 `src/` 不得出現任何 packId 字面值、不得有依 characterId 分支的程式；其餘交給 review。

### L6 — 工具鏈版本與升級規則沒有定死

- **嚴重度：** low
- **位置：** Stack
- **問題：** TypeScript 7.0.2 後面寫「建專案時依模板相容性確認」，等於還沒決定。開發和建置用的 Node 版本、套件管理器也沒定。memlog L66「Vite 外掛是 experimental，升級前看 release notes」沒有轉成規則。
- **修正：** 一次定死 TypeScript 版本、建置用 Node 版本、套件管理器（npm 或 pnpm 擇一），並寫進 `engines` 或 `.nvmrc`。lockfile 必須提交。升級 Forge 或 Vite 外掛時，要先看 release notes，並跑完 H1 的全部測試。

### L7 — `copilot` 來源範圍不明

- **嚴重度：** low
- **位置：** Consistency Conventions（來源代碼）；Structural Seed「轉接器 ×5」
- **問題：** memlog L53 裡的 Copilot 有兩種來源：Copilot CLI 的 `session-state/<id>/events.jsonl`，以及沒有批准事件的 VS Code Copilot。spine 只有一個 `copilot` 代碼，做轉接器的人得自己猜範圍。
- **修正：** 明寫第一版的 `copilot` 指 Copilot CLI。如果兩者都要支援，就拆成 `copilot-cli` 和 `copilot-vscode` 兩個代碼。

### L8 — 兩項 Deferred 缺少落點

- **嚴重度：** low
- **位置：** Deferred「推測門檻」「多螢幕世界」
- **問題：** 推測門檻寫「實作時給預設」，但沒說預設值定在哪裡，偵測和設定兩個 unit 可能各寫一份。多螢幕延後了，世界座標系卻沒有先定，之後要跨螢幕就得改世界的座標基準。
- **修正：** 預設值只定在 shared 的設定 schema。世界座標先定為「畫布視窗本地 DIP、原點在左上」，寫進 AD-10。

---

## 各 AD 可執行性速查

| AD | 可執行？ | 備註 |
| --- | --- | --- |
| AD-1 | 部分 | 名稱無法列舉，需改成可檢查的形式（L5） |
| AD-2 | 可，但需工具 | 缺 preload 層（M2）；要靠 CI 規則強制（L5） |
| AD-3 | 部分 | 顯示／釋放的擁有者衝突；缺檔案表（M3） |
| AD-4 | 可 | 加上外部格式容錯會更完整（M6） |
| AD-5 | 不足 | 推測歸屬（H3）、session 生命週期（H2）、欄位重疊（L3） |
| AD-6 | 可 | 後備演出的宣告位置待 AD-16 定（C1） |
| AD-7 | 照寫不可行 | CSP 自相矛盾、開發環境被擋、[ADOPTED] 狀態誇大（H4、H6、M1） |
| AD-8 | 可，但防不全 | 沒有 minor（L2） |
| AD-9 | 部分 | 進階模式會繞過目的（M7）；名牌歸屬（M4） |
| AD-10 | 部分 | 包內互動與世界擁有權有缺口；命中形狀未定（H5） |
| AD-11 | 可 | 參數型別變更時的處理（L4） |
| AD-12 | 可 | Prevents 措辭（L1） |
| AD-13 | 可 | 圖片尺寸、id 格式（M7、L4） |
| AD-14 | 可 | — |
| AD-15 | 可 | 標記需使用者確認（M1） |

## 與 memlog 對照

| memlog | spine | 判定 |
| --- | --- | --- |
| L18、L19 只做舞台；角色不能獨立運作 | AD-1、scope | 一致 |
| L20、L21、L29、L43、L72 參數兩層、以角色為單位、覆蓋值只存舞台 | AD-11 | 一致 |
| L25、L35 包是程式外掛，能力白名單 | AD-7 | 內容一致；狀態標記超出記錄（M1） |
| L26、L22 同包可以互相互動 | AD-10 | 文字一致，但做不出來（H5） |
| L33、L36、L38 世界歸舞台、四種通用事件、發射後援 | AD-10 | 一致 |
| L39、L59、L71 8 狀態、done 過場、後備演出 | AD-6 | 一致 |
| L40 池子用完才重複 | AD-12 | Rule 一致；Prevents 不符（L1） |
| L41 保留展示／示範模式 | AD-15 | 保留一致；「同一條管線」的做法沒有採用紀錄（M1） |
| L45、L53 支援的工具 | 來源代碼 | Copilot 範圍不明（L7） |
| L56、L66、L67 Electron 45、Forge＋Vite＋TS、React 19 | Stack | 一致；L66 的升級規則沒帶過來（L6） |
| L57、L58 唯讀偵測、轉接器＋判斷器 | AD-4、AD-5 | 一致；推測歸屬未定（H3） |
| L60 單一 PixiJS 畫布，進階用 OffscreenCanvas | AD-9 | 一致；需限制 context（M7） |
| L61 沙盒分層（未標 ADOPTED，需原型） | AD-7 [ADOPTED] | 狀態不一致（M1） |
| L68、L69 API 版本、.awpet、app id | AD-8、AD-13 | 一致；app id 沒寫（M5） |
| L73 單一螢幕 | AD-14 | 一致 |

## 建議修訂順序

1. 補 AD-16 角色包 API v1（C1），一併修 AD-10（H5）和 AD-12 的 Prevents（L1）。
2. 修 AD-7：改成可運作的 CSP、加原型閘門、修正狀態標記（H4、M1），同時補環境規則（H6）。
3. 修 AD-5：session 生命週期、推測歸屬、欄位重疊（H2、H3、L3）。
4. 補 Testing 段落（H1），以及打包、生命週期、運行段落（M5、M6）。
5. 補 preload／IPC 規則、檔案表與遷移、名牌歸屬（M2、M3、M4），最後處理其餘 low。
