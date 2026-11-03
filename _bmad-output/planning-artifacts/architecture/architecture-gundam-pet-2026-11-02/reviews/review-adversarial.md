# 對抗式審查：AI Watchdog Pet 舞台 Architecture Spine

| 項目 | 內容 |
| --- | --- |
| 審查對象 | `ARCHITECTURE-SPINE.md`（AD-1～AD-15，status: draft）、`.memlog.md` |
| 審查日期 | 2026-11-03 |
| 方法 | 把系統拆成可獨立建造的單元，讓任兩個單元「逐字遵守所有 AD」，找出仍然會做出接不起來的組合。每一組就是一個洞，附上能把它關掉的 AD 文字。 |
| 限制 | 純靜態審閱，沒有做原型、沒有執行任何程式。標「需原型確認」的技術判斷（CSP、SES 行為）來自對 Chromium／SES 的認知，未實測。本審查未修改 spine。 |

## 結論

**Spine 定了「誰擁有什麼」，沒有定「單元之間交換什麼、何時交換」，照現況不能開工。**

- 舞台↔角色包的執行期協定（節拍、繪圖指令、actor 身分、事件語意、參數傳遞）幾乎全空。這是第三方包作者唯一看得到的契約，舞台團隊與包作者兩邊都守規矩也一定接不起來（H1、H2、H8、H9）。
- AD-7 的 CSP 字面設定與 SES `Compartment` 的執行需求互相矛盾，沙盒照字面做跑不起來（H3）。
- main 內部：轉接器↔判斷器缺 session 原生 id、關聯 id、事件→狀態對照、session 存活規則（H5～H7）；池子遇到包停用／更新／崩潰時怎麼做沒寫（H10）。
- 共 20 個洞：critical 3、high 8、medium 7、low 2。

建議：開工前至少補完 critical 與 high（H1～H11）。H1、H2、H8、H9、H12、H14、H15 應合寫成 `src/shared/pack-api` 的一份版本化協定（下文新 AD-16、AD-18、AD-19、AD-21，加 AD-6／AD-11 收緊），因為包作者是對它寫程式的。

## 單元切分（本審查用）

| 代號 | 單元 |
| --- | --- |
| U-ad | `main/detection/adapters/<source>`（每個 AI 工具一個，含 demo） |
| U-red | `main/detection/reducer` |
| U-pool | `main/pool` |
| U-set | `main/settings` |
| U-pk | `main/packs`（安裝／匯入／匯出、`pack://`） |
| U-win | `main/windows` |
| U-world | `overlay/world` |
| U-rnd | `overlay/renderer`（PixiJS） |
| U-host | `overlay/pack-host` |
| U-sbx | `src/sandbox`（iframe 文件、Worker bootstrap、SES） |
| U-pnl | `src/panels`（editor、sessions、packs、showcase） |
| U-3p | 第三方角色包 |

## 總覽

| # | 嚴重度 | 衝突單元 | 洞 | 收斂 AD |
| --- | --- | --- | --- | --- |
| H1 | critical | U-world／U-rnd ↔ U-3p | 節拍歸誰、繪圖指令內容（座標系、素材引用、大小、層級、命中框）全未定 | 新 AD-18 |
| H2 | critical | U-world ↔ U-3p；U-pool ↔ U-world | 只有角色 key、沒有 actor（實體）id；同角色可同時兩隻、同包多隻共用沙盒 | 新 AD-16 |
| H3 | critical | U-win ↔ U-sbx；U-host ↔ U-sbx；U-sbx ↔ U-3p | CSP 字面讓 bootstrap 跑不起來、Compartment 無法 eval；包程式怎麼送進去、入口格式、誰 terminate 都沒定 | AD-7 收緊（第 6～10 點） |
| H4 | high | U-red／U-pool ↔ U-world／U-pnl | 狀態與分配兩條訂閱流各自到達、各自 join；沒有快照＋增量 | 新 AD-17 |
| H5 | high | U-ad ↔ U-red；U-ad ↔ U-pool | session 原生 id 未定（pid vs UUID）；事件沒有關聯 id；來源衝突時的採信順序被刪掉 | AD-5 收緊 |
| H6 | high | U-ad ↔ U-red | 只有狀態優先序，沒有「哪個事件開／關哪個條件」；error、activity、question 語意各自猜 | AD-5 收緊（對照表） |
| H7 | high | U-ad ↔ U-pool；U-ad ↔ U-red | 沒有 end 事件的工具不會結束 session，池子被殭屍吃光；啟動補讀歷史觸發推測計時 | 新 AD-22 |
| H8 | high | U-set ↔ U-host ↔ U-3p；U-pnl ↔ U-set | 有效參數誰算、怎麼送到包、何時生效、超出範圍怎麼辦；固定參數要不要給包 | AD-11 收緊 |
| H9 | high | U-world ↔ U-host ↔ U-3p | enter／leave／proximity／hit／state-broadcast 的發出者、收件者、同包收不收、快照、邊緣或持續觸發未定 | 新 AD-19（取代 AD-10 後兩句） |
| H10 | high | U-pool ↔ U-host ↔ U-pk | 包在 session 中途被停用、移除、更新、崩潰時，分配與畫面各做各的；更新時執行中的沙盒與素材混版 | 新 AD-20 |
| H11 | high | U-pk ↔ U-set／U-pool ↔ U-3p | packId 撞名靜默覆蓋；characterId 改名讓覆蓋值與分配懸空；id 字元未限制 | AD-13 收緊 |
| H12 | medium | U-host ↔ U-3p；U-pk ↔ U-3p | 「包沒實作的狀態」是 manifest 靜態宣告還是執行期判斷 | AD-6、AD-13 收緊 |
| H13 | medium | U-red ↔ U-pool ↔ U-set ↔ U-pnl | 「顯示／釋放」三個候選擁有者；「加入池子」與「包內勾選角色」、「包上場」與「包啟用」各兩個欄位 | AD-3、AD-12 收緊 |
| H14 | medium | U-world ↔ U-3p | 包要停下、轉向、同包互動，但拿不到位置也不能表達移動意圖 | 新 AD-21（移動） |
| H15 | medium | U-world／U-rnd ↔ U-3p（射方／被射方） | 發射 API 參數、自訂發射物誰畫、命中通知內容、射方卸除後的飛行物 | 新 AD-21（發射） |
| H16 | medium | U-sbx ↔ U-3p；U-win ↔ U-host | SES 預設馴化 Date／Math.random、Compartment 沒有 console／計時器；畫布被節流時心跳誤判 | AD-7、AD-14 收緊 |
| H17 | medium | U-pk／U-host ↔ U-3p | apiVersion 只有主版號，新增能力無法協商，仍會「表演中途才壞」 | AD-8 收緊 |
| H18 | medium | U-pnl ↔ U-set；U-set ↔ U-pk | 設定寫入是整份覆蓋還是 patch、多頁面並行、覆蓋值由誰依 manifest 驗證 | 新 AD-23 |
| H19 | low | U-ad(demo) ↔ U-pool ↔ U-pnl | 示範要指定角色但池子隨機分配；示範分配被持久化；編輯頁預覽沒有繪圖路徑 | AD-15 收緊 |
| H20 | low | U-world ↔ U-win | 穿透切換的觸發方式、點角色做什麼、視窗邊界／縮放變更通知 | AD-14 收緊 |

---

## 各洞詳述

### H1｜critical｜節拍與繪圖指令沒有協定

**單元：** U-world＋U-rnd（舞台團隊）↔ U-3p（包作者），經 U-host。

**兩邊都守 AD 卻接不起來：**

- **節拍歸誰。** AD-9 只說「每格回傳繪圖指令」。舞台團隊做成「每個 rAF 送 `tick`、收到回覆再畫」；包作者做成「自己定時推 draw」。後者在 Compartment 裡根本沒有 `setInterval`／`requestAnimationFrame`（AD-7 只注入舞台 API）；若 bootstrap 作者「好心」注入計時器，兩種 bootstrap 又不相容。前者若同步等回覆，一包變慢全部角色停格，違反 AD-7.5「舞台不受影響」。
- **座標系。** AD-9 的「位置」沒說是螢幕絕對座標還是角色本地座標。包作者照字面輸出絕對座標，就能把角色畫到 world 以為它不在的地方；world 照 AD-10 用自己的碰撞框判命中 → 畫面與命中不一致，正是 AD-9 要防的事。
- **大小。** 固定參數「大小」可能被 world（碰撞框）、renderer（外層縮放）、包（若收到參數）各乘一次。
- **素材引用。** Worker 沒有 fetch，CSP `connect-src 'none'`，包讀不到自己的圖。「圖片、格」用路徑、id 還是 ImageBitmap 引用？精靈圖的格切割資訊放 manifest 還是包程式？都未定。
- **命中框來源。** AD-13 的 manifest 欄位沒有碰撞框。world 只能從繪圖範圍反推（要 renderer 回饋，overlay 內部形成循環依賴）或用固定框；兩個實作者會各選一種。
- **層級。** 指令裡的 z 是全域還是 actor 內？照字面一包可以把自己蓋在所有角色上面。
- **移動資訊。** 走路動畫需要「是否在走、面向」，world 有、包拿不到。
- **限速。** AD-7.5 說「限速」但沒有數字；60 fps 推送的包會被另一團隊寫的限速器殺掉。

**收斂（新增 AD-18 — 節拍與繪圖指令）：**

> - **節拍唯一擁有者是 `overlay/world`。** world 以固定邏輯頻率（舞台常數，預設 30 Hz）推進；每個邏輯 tick 對「至少有一隻 actor 在場」的每個包送一則 `frame{seq, t, dt, actors[], events[]}`，`t` 為舞台相對毫秒。Compartment 不注入任何計時器，包的時間只來自 `frame`。
> - `frame.actors[]` 每筆含 `actorId`、`characterId`、`state`（AD-6 對應後的值）、`motion{moving, facing:'left'|'right'}`。
> - 包對每則 `frame` 最多回一則 `draw{seq, actors:[{actorId, commands[]}]}`。每包同時最多一則 frame 在途；上一則未回就跳過該包這一格，不排隊。renderer 每個顯示幀使用該包最後一則有效 `draw`，永不等待。
> - **繪圖座標一律是 actor 本地座標**：原點＝world 給的錨點（腳底中心），單位＝基準像素（未乘「大小」），y 向下。舞台在外層容器依序套 world 位置、「大小」、actor 間層級（由 world 決定，預設依 y 排序）。指令內 `z` 只排同一 actor 內的前後。超出 manifest 宣告 `bounds` 的內容裁切。包無法用繪圖指令移動角色。
> - v1 指令種類為封閉清單（schema 在 `src/shared/pack-api`）：`sprite{asset, frame, x, y, rotation, scaleX, scaleY, alpha, z}`、`particles{emitterId, preset, x, y, params}`（`emitterId` 跨 frame 持續，下一則 draw 沒出現即停止發射）、`bitmap{x, y}`（進階模式，ImageBitmap 以 transfer 傳送，尺寸與每秒張數上限為舞台常數）。
> - `asset` 是 manifest `assets` 表的 key；`frame` 是該素材在 manifest 宣告之格切割中的索引。renderer 自行從 `pack://` 載入；除 `bitmap` 外包不傳任何圖檔位元組。
> - **命中、碰撞、滑鼠穿透判定只用 manifest 每個角色宣告的 `hitbox`（本地座標）×「大小」，由 world 計算**；繪圖內容不影響。名牌位置用 manifest 的 `nameplateAnchor`（本地座標）。
> - 限額為 `src/shared` 常數：每則 draw 每 actor 指令數、單則位元組數、每包 emitter 數。超限整則丟棄並記錄 `packId`；連續 `drawTimeoutMs` 沒有有效 draw 視同 AD-7.5 的失敗。

### H2｜critical｜只有角色 key，沒有 actor 身分

**單元：** U-world ↔ U-3p；U-pool ↔ U-world；U-host ↔ U-3p。

**兩邊都守 AD 卻接不起來：**

- AD-12「池子用完前畫面上不重複」代表用完後同一角色會同時出現兩隻；但 spine 唯一的角色識別是 `<packId>/<characterId>`（AD-11、命名慣例）。有兩隻 X 時，「X 被擊中」「X 這樣畫」無法定址。
- 包作者照 AD-11「以角色為單位」用 characterId 當內部狀態 key → 兩隻 X 共用動畫狀態。
- id 由誰發：pool 可以發 assignment id、world 可以發 entity id、面板用 sessionKey——三套 id，對照關係沒定。
- AD-10 說同包角色在同一沙盒，但沒說沙盒怎麼得知「現在有哪幾隻」（spawn／despawn），也沒說 host 要拒絕包對別包 actor 下指令。
- 沙盒何時建立沒定：每個已安裝包常駐，或有 actor 才建？前者裝 20 個包就是 20 個 iframe＋Worker。

**收斂（新增 AD-16 — actor 身分）：**

> - 畫面上的每一隻是一個 **actor**。`actorId` 由 `main/pool` 在建立一筆分配時產生（不透明字串，app 執行期間不重用）。一筆分配＝一個 session × 一個 characterKey＝一個 actorId。重新分配（換角色）＝舊 actorId 結束、新 actorId 產生。
> - world 實體、繪圖指令、發射、所有舞台↔包訊息一律以 `actorId` 定址。同一 characterKey 可同時有多個 actorId。包的內部狀態必須以 `actorId` 為 key；`characterId` 只用來選外觀與讀參數。
> - 每包一個沙盒：該包有第一個 actor 時建立，最後一個 actor 離場後 `sandboxIdleMs`（舞台常數）銷毀。沙盒以 `spawn{actorId, characterId, params, state}`、`despawn{actorId}` 得知自己的 actor。
> - `overlay/pack-host` 驗證包送出的每則訊息中的 `actorId` 屬於該包，否則整則丟棄並記錄 `packId`。
> - 包看不到 `sessionKey`、`source`、別包的 `packId`／`characterId`；只看得到 `actorId` 與 AD-7 允許的顯示名稱。

### H3｜critical｜沙盒載入鏈照 AD-7 字面跑不起來，責任也沒分

**單元：** U-win（protocol、CSP、webRequest）↔ U-sbx；U-host ↔ U-sbx；U-sbx ↔ U-3p。

**兩邊都守 AD 卻接不起來：**

1. **bootstrap 無法執行。** iframe 文件由 `pack://` 提供、CSP `script-src blob:`：文件自己的 `<script>`（inline 或 `pack://` URL）都被擋；沒有腳本就造不出 blob。照字面設 CSP 的 U-win 與照字面寫 bootstrap 的 U-sbx 直接衝突。
2. **Compartment 無法 eval（需原型確認）。** 從 blob 建立的 Worker 繼承 iframe 的 CSP；`default-src 'none'; script-src blob:` 不含 `'unsafe-eval'`，而 SES `Compartment.evaluate()` 需要動態求值，會丟 EvalError。bootstrap 作者只能二選一：自加 `'unsafe-eval'`（違反 AD-7.1 字面），或把包程式直接拼進 Worker 腳本、不經 Compartment（違反 AD-7.3）。
3. **SES、bootstrap、包程式怎麼送進 Worker。** Worker 移除了 fetch／importScripts，CSP 又擋 connect，三份原始碼都只能由外面以文字送入。由 U-host 從 `pack://` 讀後 postMessage？由 main 經 IPC 給？未定。
4. **入口格式。** manifest「程式進入點」是 ES module（`export default`）、classic script 設全域、還是 CommonJS？classic Worker＋`Compartment.evaluate` 只吃 script／expression；包作者照現代習慣打包成 ESM 就是語法錯誤。
5. **誰 terminate。** Worker 物件在 opaque origin iframe 的 realm 內，overlay 拿不到，無法呼叫 `worker.terminate()`，只能移除 iframe。若 overlay↔沙盒的 MessagePort 由 iframe 轉發，Worker 卡死時 iframe 仍會回心跳，心跳永遠不逾時。
6. **`pack://` 由誰註冊、URL 形狀。** 舞台自己的 sandbox 文件與第三方包檔案共用 `pack://` 命名空間；處理器歸 `main/packs` 還是 `main/windows` 未定，包內若有同名檔可能蓋掉 bootstrap 路徑。

**收斂（AD-7 收緊，新增第 6～10 點）：**

> 6. sandbox iframe 文件是舞台程式（`src/sandbox`），由保留主機 `pack://_stage/sandbox.html` 提供；第三方 packId 不得以 `_` 開頭。`pack://` 處理器由 `main/packs` 註冊，URL 形狀 `pack://<packId>@<version>/<path>`，處理器拒絕 `..`、絕對路徑，以及 manifest `assets`／入口以外的檔案。
> 7. iframe 文件 CSP：`default-src 'none'; script-src 'sha256-<bootstrap 雜湊>' blob: 'unsafe-eval'; worker-src blob:; connect-src 'none'`（雜湊於建置時產生）。`'unsafe-eval'` 只為 SES `Compartment.evaluate` 而開，風險由 Worker＋SES 隔離承擔；overlay 與 panels 的 CSP 一律不含 `'unsafe-eval'`。沙盒原型的第一項驗證就是這組設定。
> 8. 載入順序固定：`overlay/pack-host` 以 `fetch(pack://...)` 讀入口原始碼 → 建 MessageChannel → 以 `postMessage` 把 `port2`、SES 原始碼、Worker bootstrap 原始碼、包入口原始碼交給 iframe → iframe 組成一個 blob 建 classic Worker，並**把 `port2` transfer 給 Worker**；iframe 之後不轉發任何訊息。
> 9. 入口格式：單一、已自行打包、不含 `import`／`require` 的 script，完成值為工廠函式 `(stage) => handlers`；`handlers` 的鍵為 `src/shared/pack-api` 定義的訊息名稱。其他格式在安裝時（manifest 驗證＋試解析）拒絕。
> 10. 心跳由 `pack-host` 每 `heartbeatMs` 發 `ping`，Worker bootstrap 在 Compartment 外回 `pong`；逾時由 `pack-host` 移除該包 iframe（連帶終止 Worker），不呼叫 `worker.terminate()`。重啟政策見 AD-20。

### H4｜high｜main→畫布／面板的狀態複製沒有契約

**單元：** U-red、U-pool（發佈）↔ U-world／U-host、U-pnl/sessions（訂閱）。

**兩邊都守 AD 卻接不起來：**

- AD-3 只寫「訂閱」。overlay 分別訂閱 detection（狀態、顯示名稱）與 pool（分配），兩條 IPC 交錯到達：某 session 的狀態先到、分配後到；或分配已收回，最後一筆狀態才到 → 套到錯的 actor，或沒有 actor 可套。
- 面板與畫布各自 join、各有時序 → 面板顯示角色 X、畫面上是 Y，正是 AD-12 要防的「分配在畫布與面板間不一致」。
- Structural Seed 只有 `pool --> world`，沒有 detection→overlay：狀態要經 pool 轉手嗎？那 pool 就成了狀態的第二個發佈者，與 AD-3 衝突。
- overlay renderer 重新載入（崩潰、開發時 reload）怎麼取得現況未定：重播事件還是拿快照？

**收斂（新增 AD-17 — 舞台視圖 StageView）：**

> - main 內新增 `main/stage-view`（唯讀組合者，不擁有任何資料），把 detection、pool、settings、packs 組成單一 `StageView`：`actors[]{actorId, sessionKey, characterKey, state, confidence, displayName}`、`sessions[]`（含未分配與已釋放）、已啟用的包與版本、各 characterKey 的有效參數與固定參數、計時設定。
> - `StageView` 帶單調遞增 `rev`。訂閱流程固定為：訂閱 → 收完整快照 → 收 `delta{rev}`；收到不連號的 `rev` 就重拿快照。renderer 重載一律重拿快照。
> - overlay、panels 只能訂閱 `StageView`，不得分別訂閱 detection／pool 再自行 join。一筆分配的建立與該 actor 的第一個狀態必須在同一個 `delta` 內。
> - Structural Seed 改為 `reducer、pool、settings、packs --> stage-view --> world／host／panels`。

### H5｜high｜session 原生 id、事件關聯 id、來源採信順序未定

**單元：** U-ad（尤其 claude-code，含 registry 與 transcript 兩個 probe）↔ U-red；U-ad ↔ U-pool（持久化）。

**兩邊都守 AD 卻接不起來：**

- 命名慣例是 `<source>:<原生 id>`，但 Claude Code 的即時狀態檔以 **pid** 命名、transcript 以 **session UUID** 命名。registry probe 發 `claude-code:<pid>`、transcript probe 發 `claude-code:<uuid>` → 一個終端兩隻角色。`/clear` 是同 pid 換 UUID、resume 是同 UUID 換 pid，兩種 key 的分合結果剛好相反。
- pool 以 sessionKey 持久化分配（AD-12）；若 key 用 pid，重開機後 pid 重用會把無關的新 session 接上舊分配。
- 事件沒有關聯 id：Claude Code 會平行跑多個工具，`tool.end` 不知道關的是哪個 `tool.start`；推測產生的 `approval.request`（AD-5）不知道該被哪個 `tool.end` 或 exact approval 取代。判斷器若用計數、轉接器假設用集合 → 卡在 `working`，或提早掉到 `thinking`。
- memlog 原有「hook > registry > log」的採信順序；spine 移除 hook 後，沒有留下 registry 與 log 衝突時的規則（AD-5 的優先序是狀態之間，不是來源之間）。

**收斂（AD-5 收緊）：**

> - 每個 source 的「原生 id」在 `src/shared` 列明且只有一種；`claude-code` 為 transcript 的 session UUID，registry probe 必須先把 pid 對應到 UUID 才能發事件，對應不到就不發。轉接器內部負責合併多個 probe 並去重，**對外每個 session 只有一個 sessionKey**。原生 id 改變（`/clear`、新對話）＝舊 session `end`、新 session `start`。
> - 事件新增關聯欄位：`tool.*` 帶 `toolCallId`；`approval.*`、`question.*` 帶 `requestId`（由工具呼叫觸發時等於 `toolCallId`）。推測產生的 approval 以 `toolCallId` 關聯，收到同 id 的 exact `approval.*` 或 `tool.end` 即取代或關閉。工具本身沒有 id 時，轉接器自行產生並保證 start／end 一致。
> - 判斷器依 session 維護「進行中 tool 集合」與「未決 approval／question 集合」，不得用計數。
> - 同一 session 同一條件（例：某 requestId 是否未決）出現矛盾時，採信 `registry` > `log` > `inferred`。

### H6｜high｜事件→狀態對照沒寫死

**單元：** U-ad（每個工具各自獨立實作）↔ U-red。

**兩邊都守 AD 卻接不起來：**

- AD-5 只給 8 狀態的優先序，沒說哪個事件讓哪個條件成立或解除。
- `error` 是點事件：轉接器 A 發一次，期待判斷器維持到下一輪 `turn.start`；判斷器作者寫成維持 N 秒。Codex rollout 不寫錯誤，Codex 轉接器乾脆不發。
- `activity`：轉接器 B 每收到一段串流輸出就發，用來「避免掉到 idle」；判斷器作者把 `activity` 對到 `thinking` → `turn.end` 後晚到的 activity 把狀態翻回 thinking。
- 事件 `question.*` 對到狀態 `decision`，名稱不一致，容易有人另開 `decision.*` 事件。
- `turn.end` 時仍有未關的 `tool.start`（紀錄檔漏寫 end），要 `done` 還是維持 `working`？
- 轉接器作者一旦知道判斷器怎麼算，就會「為了得到某狀態挑事件」，判斷邏輯又散回轉接器，AD-5 的 Prevents 失效。

**收斂（AD-5 收緊，加入對照表）：**

> 判斷器依每個 session 的條件集合決定狀態；條件的開關只由下表事件觸發。轉接器只照事實發事件，不得為了取得某狀態而合成事件。
>
> | 狀態 | 成立條件 | 解除 |
> | --- | --- | --- |
> | `approval` | 有未決的 approval requestId | 同 id `approval.resolved`、同 toolCallId `tool.end`、`turn.end`、`session.end` |
> | `decision` | 有未決的 question requestId | 同 id `question.resolved`、同 toolCallId `tool.end`、`turn.end`、`session.end` |
> | `error` | 收到 `error` 之後 | 下一個 `turn.start`／`tool.start`，或 `errorHoldMs` 到期 |
> | `working` | 進行中 tool 集合非空 | 集合為空 |
> | `thinking` | `turn.start` 之後、`turn.end` 之前 | `turn.end` |
> | `done` | `turn.end` 起 `doneMs` 內 | 到期轉 `waiting`；任何 `turn.start` |
> | `waiting` | `turn.end` 之後且不在 done 期間 | `turn.start` |
> | `idle` | 最後一個事件（含 `activity`）起超過 `idleMs` | 任何事件 |
>
> `activity` 只更新「最後事件時間」，不開任何條件。`turn.end` 時清空該 turn 內未關的 tool 與 approval（視為紀錄漏寫）。秒數皆為 `main/settings` 的計時設定。

### H7｜high｜session 生命週期：存活、結束、啟動補讀

**單元：** U-ad ↔ U-pool；U-ad ↔ U-red。

**兩邊都守 AD 卻接不起來：**

- 只有紀錄檔的工具（Codex、Gemini、Copilot、Cursor），使用者關掉終端時不會寫「結束」。轉接器 A 自己用「N 分鐘沒動靜」發 `session.end`，轉接器 B 從不發。判斷器把 B 的 session 轉 `idle`，但 AD-12 只在 session 結束時放回角色 → 幾天後池子被殭屍 session 用光，永遠重複。
- AD-12 持久化分配；沒有回收規則，重開 app 後舊分配全數留存。
- 啟動時補讀紀錄檔：轉接器 A 只發最後狀態，轉接器 B 把歷史事件全部重播。重播的 `tool.start` 沒有 end → 判斷器立刻依推測門檻產生 `approval`；重播的 `turn.end` 讓每個舊 session 都演一次 `done`。判斷器若用事件 `ts` 計時，所有舊事件都「早已逾時」；用到達時間計時，又全部重新計時。
- 轉接器掃到的歷史 session 數量沒有上限，可能一次發數百個 `session.start` 給池子。

**收斂（新增 AD-22 — session 生命週期）：**

> - **結束由判斷器統一決定**：收到 `session.end`、轉接器回報行程已不存在（有 registry／pid 的來源），或最後事件起超過 `sessionExpireMs`（設定，預設 30 分鐘），即結束該 session。轉接器不得自行用逾時合成 `session.end`。
> - 啟動補讀：轉接器只回報最後修改時間在 `discoveryWindowMs` 內的 session；補讀事件標 `replay: true`，補讀完成發 `sync.ready{source}`。判斷器對 `replay` 事件只重建條件集合，不啟動推測計時、不產生 `done` 過場；`sync.ready` 之後才開始計時。
> - 判斷器所有計時以收到事件時的單調時鐘為準；事件 `ts` 只用於排序與顯示。
> - `main/pool` 在所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）前不建立新分配；之後丟棄沒有被重新回報的持久化分配。

### H8｜high｜參數的解析、傳遞路徑與更新時機

**單元：** U-set ↔ U-host ↔ U-3p；U-pnl/editor ↔ U-set。

**兩邊都守 AD 卻接不起來：**

- 有效值「覆蓋值 ?? 包的預設值」由誰算：settings（要讀 manifest）、host，還是包？若 host 只送覆蓋值、包自己合併程式內寫死的預設，而那個預設跟 manifest 不同 → 面板顯示 5、包用 3。
- Structural Seed 有 `settings --> world`、`packs --> host`，**沒有 settings→host**：參數到包的路徑不存在。
- 包更新後 `max` 由 20 改 10，舊覆蓋值 15：照套、夾到 10、還是忽略？型別從 `int` 改成 `choice` 呢？AD-11 只處理「參數已不存在」。
- 更新時機：面板拖滑桿每秒送幾十次 → settings 每次 temp＋rename 寫檔、包每秒收幾十則（撞 AD-7.5 限速）；另一團隊做成放開才送 → 沒有即時預覽。兩種都合規。
- 固定參數（大小、遊走、名牌）要不要給包：包若拿到「大小」自己縮放，舞台又縮放一次（接 H1）。

**收斂（AD-11 收緊）：**

> - **有效值只由 main 計算**（`main/settings` 讀 `main/packs` 的 manifest）：覆蓋值存在且符合該參數**目前**的宣告（型別相同；數值夾到 `min`／`max` 並對齊 `step`；`choice` 在選項內）才採用，否則用 manifest 預設值。不符的覆蓋值保留在設定檔但不套用。
> - 包收到的是該角色**所有宣告參數**的完整有效值（在 `spawn` 與 `params{characterId, values}` 中），不是差異。manifest 是預設值的唯一來源，包程式不得另設預設。
> - 固定參數由舞台消化，不傳給包（「大小」由 renderer 外層縮放與 world 碰撞框套用，見 AD-18）。
> - 變更流程：面板拖動時送 `settings.preview`（只廣播、不落地），放開或停止 `commitDebounceMs` 後送 `settings.patch` 落地（AD-23）。`pack-host` 對同一 characterId 每個 tick 至多送一則 `params`，於下一則 `frame` 前生效。
> - 參數經 AD-17 的 StageView 到達 `pack-host`；Structural Seed 補 `stage-view --> host`。

### H9｜high｜通用事件語意未定

**單元：** U-world ↔ U-host ↔ U-3p；U-pool ↔ U-world。

**兩邊都守 AD 卻接不起來：**

- **enter／leave 誰發、何時發。** world 團隊在 actor 加入／移出世界時發；pool 團隊認為分配建立就是 enter（即使該包還沒載入）。重新分配算不算 leave＋enter？包自己的 actor 進場，收 `enter` 還是只收 `spawn`？
- **同包收不收。** AD-10 說「包內特殊互動由包自己處理，不經過舞台」。host 作者據此過濾同包事件 → 包永遠不知道自己兩隻角色靠近了；但位置歸 world、包拿不到位置，所以同包互動實際上做不出來。AD-10 前後兩句互相矛盾。
- **快照。** 沙盒晚於其他角色建立，或崩潰重啟後，要不要補發現場所有 actor 的 `enter`？不補，包就不知道別人存在。
- **state-broadcast。** 自己 actor 的狀態與別人的狀態是同一則還是兩則？`done→waiting` 這種頻繁過場要不要廣播？要不要帶 `confidence`？
- **proximity。** 每 tick 都發（持續）還是只在進入／離開時發（邊緣）？半徑用誰的？持續觸發會直接撞限速。
- **hit 的內容。** 帶不帶射方 packId／characterId？帶了，包就能針對特定別包寫專屬反應，違反 memlog「不同包之間沒有特殊互動」。
- **leave 時機。** 立即移除，或保留一段讓包演退場？保留期間角色已放回池子，可能被新 session 分到，畫面上短暫出現兩隻。

**收斂（新增 AD-19 — 通用事件，取代 AD-10 最後兩句）：**

> - 發出者唯一：`enter`／`leave`、`proximity`、`hit` 由 `overlay/world` 依世界變化產生；`state-broadcast` 由 `overlay/pack-host` 依 StageView 的狀態變化產生。事件放在下一則 `frame.events[]` 送達。
> - `enter`／`leave`＝actor 加入／移出世界（actorId 集合的差異）；重新分配＝舊 actor `leave`＋新 actor `enter`。v1 `leave` 即時移除，沒有退場保留期。
> - 收件規則：每個事件以「接收 actor」定址，送給擁有該 actor 的包。`enter`／`leave`／`state-broadcast` 送給每個**其他** actor 的擁有包（同包也送）；包自己的 actor 另以 `spawn`／`despawn` 與 `frame.actors[].state` 得知。舞台不過濾同包事件；「包內特殊互動」指收到通用事件後怎麼反應由包決定，觸發來源仍是舞台。
> - `proximity{actorId, otherActorId, phase:'begin'|'end', kind:'near'|'touch'}` 為邊緣觸發；`near` 半徑為舞台設定，`touch`＝兩個 hitbox 相交。
> - `hit{actorId, byActorId, projectile:'generic'|'custom'}`。
> - 事件內只出現 `actorId`、8 狀態碼與顯示名稱；不出現別包的 `packId`、`characterId`，也不出現 `sessionKey`、`source`、`confidence`。
> - 沙盒建立或重啟後的第一則訊息是 `init{actors:[{actorId, own, characterId(own 才有), state}]}`；之後才有增量事件，不補發歷史。

### H10｜high｜包在 session 中途被停用／移除／更新／崩潰

**單元：** U-pool ↔ U-host ↔ U-pk ↔ U-pnl/packs。

**兩邊都守 AD 卻接不起來：**

- **停用包**（或取消勾選角色、關掉「加入池子」）：pool 團隊只對新 session 套用池子定義（AD-12 沒提現有分配）；host 團隊卸除停用包的沙盒 → 現有角色依 AD-7.5 變成佔位演出，一直停在那裡。或 pool 立即重分配 → leave＋enter。兩種都合規。
- **移除包**：持久化分配指向不存在的 characterKey。
- **更新包**：`main/packs`「成功才替換」直接換掉磁碟上的檔案，但執行中的沙盒仍是舊程式；renderer 依 `pack://<packId>/<path>` 快取的貼圖與新檔混用 → 舊程式用新素材的格索引。沒有任何事件通知 overlay 重載。
- **崩潰**（心跳逾時）：AD-7.5 只說改演佔位。要不要重啟、幾次？main 不知道（沒有 overlay→main 的執行狀態通道），pool 繼續把新 session 分給壞掉的包，包管理面板也顯示不出「失敗」。

**收斂（新增 AD-20 — 包的執行期生命週期）：**

> - 設定變更使角色不再屬於池子（包停用、角色取消勾選、包移除、更新後角色消失）時，`main/pool` **立即**對受影響的 session 重新分配（依 AD-19：舊 actor `leave`、新 actor `enter`）；池子空了則該 session 沒有 actor（畫布可為空，符合 AD-1）。
> - 包更新：`main/packs` 安裝成功後在 StageView 發佈新 `version`；`pack-host` 卸除舊沙盒，以 `pack://<packId>@<newVersion>/` 重載，對仍有效的 actor **保留原 actorId** 重新 `spawn`；其他包不收到 enter／leave。素材 URL 帶版本，renderer 依 URL 快取，不會混版。
> - 執行期暫時失敗（心跳逾時、超限、未捕捉例外）：該包 actor 改演佔位、**分配不變**；`pack-host` 以退避重啟最多 `maxRestarts` 次。超過即經 IPC 回報 `packs.runtimeFailed{packId, version, reason}`：`main/packs` 在本次執行期間標記該版本失敗（不寫回角色包），`main/pool` 視同停用並依第一點重新分配，包管理面板顯示原因。使用者重新啟用、更新版本或重開 app 後清除。
> - Structural Seed 補 `host --> main/packs`（執行狀態回報）。

### H11｜high｜角色身分跨版本、packId 撞名

**單元：** U-pk ↔ U-set（覆蓋值 key）、U-pool（持久化分配）↔ U-3p。

**兩邊都守 AD 卻接不起來：**

- 兩位作者各自選了 `packId: "starter"`。AD-13「成功才替換」→ 第二個匯入被當成更新，靜默取代第一個，還繼承第一個的覆蓋值與池子勾選；另一位實作者可能做成直接拒絕。兩種都合規。
- 作者在新版把 `characterId` 改名（例如修錯字）→ 覆蓋值變孤兒（AD-11 只處理參數）、分配懸空。
- `version` 格式（semver？）未定；降版是否允許未定；同版本號、不同內容重新匯入怎麼辦未定。
- id 字元沒限制：`characterId` 含 `/` 會破壞 `<packId>/<characterId>` 的解析；含 `:` 會影響其他 key。

**收斂（AD-13 收緊＋身分規則）：**

> - `packId`、`characterId` 格式 `^[a-z0-9][a-z0-9-]{1,63}$`（`_` 開頭保留給舞台）；`packId` 建議 `<作者>-<名稱>`。`version` 為 semver。manifest 必填 `author`。
> - 匯入時 packId 已存在：`author` 相同 → 視為更新，顯示舊／新版本請使用者確認，降版另外警告；`author` 不同 → 拒絕，請使用者先移除舊包，不自動覆蓋。同版本號重新匯入視為重裝。
> - `characterId` 是跨版本的穩定身分。作者改名須在 manifest 以 `renamedFrom: [舊 id]` 宣告，`main/settings` 與 `main/pool` 據此搬移 key。未宣告而消失的角色依 AD-20 處理，其覆蓋值保留但不套用（與 AD-11 的參數規則一致）。

### H12｜medium｜後備演出的判定方式

**單元：** U-host ↔ U-3p；U-pk（manifest schema）↔ U-3p。

**兩邊都守 AD 卻接不起來：**

- AD-6「包沒實作的狀態」可以是 manifest 靜態宣告，也可以是執行期判斷（回空 draw、丟 unsupported）。AD-13 的 manifest 欄位清單沒有狀態或後備欄位，host 作者只能做執行期判斷 → 包作者故意不畫（例如隱身演出）卻被換成佔位。
- 包收到的是真實狀態還是對應後的狀態？若收到真實狀態，「舞台改演後備」就是空話；若收到對應後狀態，要寫清楚。

**收斂（AD-6、AD-13 收緊）：**

> - manifest 每個角色宣告 `states`（已實作的狀態碼清單）與選填 `fallback`（`{<未實作狀態>: <已實作狀態>}`，或單一預設已實作狀態）。
> - `pack-host` 依 manifest 靜態對應：有實作就送原狀態；沒實作但有 fallback 就送 fallback 指向的狀態（`frame.actors[].state` 為對應後的值）；兩者都沒有就由舞台畫內建佔位，該 actor 的 draw 被忽略直到狀態改變。
> - 空的 draw 一律代表「這格不畫」，不觸發佔位。

### H13｜medium｜顯示／釋放、池子勾選、包上場各有多個擁有者

**單元：** U-red ↔ U-pool ↔ U-set ↔ U-pnl（sessions、editor、packs）。

**兩邊都守 AD 卻接不起來：**

- AD-3 把「顯示／釋放」歸 `main/detection`；AD-12（池子）又寫「使用者可指定哪些 session 顯示、哪些釋放」；而使用者意圖照 AD-3 第三列屬於「舞台設定」。session 管理面板作者打 detection 的 IPC、池子作者在 pool 實作釋放 → 兩套狀態。
- 「釋放不追蹤」：detection 作者讓 session 從清單消失（之後無法取消釋放）；pool 作者只收回角色，session 仍在清單。
- AD-11 固定參數「加入池子」與 AD-12「包內勾選的角色」是同一件事的兩個欄位；編輯頁寫一個、包管理頁寫另一個，pool 取交集 → 使用者在一處打開、另一處仍關著，角色就是不出現。
- 同理，「使用者勾選上場的包」（設定）與包管理頁可能做的「啟用／停用」（`main/packs`）會變成兩個欄位。

**收斂（AD-3、AD-12 收緊）：**

> - `main/detection` 只擁有觀察到的事實（session 清單、狀態、顯示名稱），**不擁有任何使用者意圖**。
> - session 的顯示／釋放是使用者意圖，由 `main/pool` 擁有並持久化（key 為 sessionKey，隨 AD-22 回收）。「釋放」＝收回角色、不再分配；session 仍出現在管理清單，可改回顯示。
> - 每個角色只有一個池子開關：固定參數 `inPool`（存於 `main/settings`，key `<packId>/<characterId>`）；包管理頁的「包內勾選角色」寫的就是這個欄位。每個包只有一個開關 `packs.<packId>.enabled`（存於 `main/settings`）；`main/packs` 不另存啟用狀態。
> - AD-3 表格改為：「session 清單、8 狀態、顯示名稱 → `main/detection`」；「分配、池子、session 顯示／釋放 → `main/pool`」。

### H14｜medium｜移動意圖與位置

**單元：** U-world ↔ U-3p。

**兩邊都守 AD 卻接不起來：**

- 位置與移動全歸 world（AD-10），包沒有任何 API 表達「工作中請坐著別動」「轉向」。包作者的解法只剩在繪圖指令裡加位移（造成 H1 的畫面與命中不一致），或讓坐在桌前的動畫一邊滑過螢幕。
- 固定參數「遊走偏好」與包的需求衝突時誰贏，未定。

**收斂（新增 AD-21 前半 — 移動意圖）：**

> - 包可對自己的 actor 送 `motion{actorId, intent:'auto'|'hold'}` 與 `face{actorId, facing}`；`hold` 時 world 停止該 actor 的遊走，`auto` 回到舞台遊走。跳躍等垂直表現只能是繪圖層的視覺位移，不影響 hitbox。
> - 使用者的「遊走偏好」為上限：使用者設為不遊走時，`auto` 也不動；包無法讓使用者設為不動的角色移動。
> - 包看不到任何 actor 的螢幕座標；需要相對關係時用 AD-19 的 `proximity`。

### H15｜medium｜發射物契約

**單元：** U-world、U-rnd ↔ U-3p（射方）；U-world ↔ U-3p（被射方）。

**兩邊都守 AD 卻接不起來：**

- 發射 API 參數未定：目標 actor、方向、速度？包看不到位置（H14），只能指定目標 actor。
- 自訂發射物誰畫：設計 A 是 renderer 依 manifest 的靜態素材直接畫；設計 B 是射方包每格自己畫（需要每格把發射物位置給射方包）。兩種互斥。
- 「舞台不認得的物件」在何時判定（發射當下查 manifest？安裝時？）。
- 射方包被卸除後，飛行中的自訂發射物貼圖被釋放 → 崩潰或殘影。
- 同包互相射中要不要發 `hit`（接 H9）；發射頻率沒有上限。

**收斂（新增 AD-21 後半 — 發射）：**

> - `fire{fromActorId, targetActorId?, object?}`：有 `targetActorId` 時 world 朝目標發射，否則依 `fromActorId` 的面向水平發射；速度、射程為舞台常數。
> - `object` 是 manifest `projectiles` 表的 key（靜態素材＋選填格動畫），由 renderer 直接畫，射方包不參與每格繪製。沒給或 key 不在 manifest 中 → world 改丟隨機通用物件（AD-10 的後援，發射當下判定）。
> - 飛行物件屬於 world，與射方之後的狀態無關；射方包被卸除時，其自訂物件改以通用外觀飛完。
> - 每個 actor 每秒發射次數上限為舞台常數，超出的 `fire` 丟棄。命中通知見 AD-19 的 `hit`，同包也會收到。

### H16｜medium｜時間來源、SES 馴化與節流

**單元：** U-sbx（lockdown 選項）↔ U-3p；U-win（視窗選項）↔ U-host（心跳）。

**兩邊都守 AD 卻接不起來：**

- SES lockdown 後，新 Compartment 內的 `Date.now()`、`new Date()`、`Math.random()` 預設被馴化（呼叫會丟錯或回傳 NaN，依 SES 版本，需原型確認）；Compartment 的全域也沒有 `console`、`setTimeout`。包作者在一般瀏覽器測試時用 `Math.random()` 做粒子抖動、用 `console.log` 除錯 → 只有在舞台裡才丟錯。Spine 把「是否凍結 Date」放在 Deferred，等於讓 bootstrap 實作者自選 lockdown 選項，包作者無從得知。
- 畫布視窗被遮蔽、螢幕鎖定、系統睡眠時，Chromium 會節流計時器與 rAF。U-win 若沒設 `backgroundThrottling: false`，而 U-host 用牆上時間量心跳 → 喚醒後所有包同時逾時，全部變佔位。

**收斂（AD-7、AD-14 收緊）：**

> - SES lockdown 選項固定寫在 `src/sandbox`；Compartment 內 `Date`、`Math.random` 依 SES 預設馴化（不可用）。舞台 API 提供 `stage.random()`（每個 actor 一個種子）與 `stage.log(...)`（限速後轉給 main 的運行紀錄，帶 `packId`）。包規格明寫：不可用 `Date`、`Math.random`、`console`、任何計時器。此項自 Deferred 移除。
> - `main/windows` 建立畫布視窗時設 `backgroundThrottling: false`。main 收到 `powerMonitor` 的 suspend／lock 時通知 overlay，overlay 暫停 world 節拍與心跳計時，resume／unlock 後恢復；心跳逾時以 world 節拍數計，不以牆上時間計。

### H17｜medium｜apiVersion 只有主版號

**單元：** U-pk／U-host（舞台 1.x）↔ U-3p（針對較新的 1.y 寫）。

**兩邊都守 AD 卻接不起來：**

- 新增第五種通用事件、新的繪圖指令種類都不是不相容變更，主版號不動。為新版舞台寫、用了新指令的包，裝在舊版舞台上通過主版號檢查，執行時才被 schema 拒絕 → 「表演中途才壞」，正是 AD-8 的 Prevents。
- 舊包收到不認得的新事件類型時，包端怎麼處理沒說。

**收斂（AD-8 收緊）：**

> - manifest `apiVersion` 為 `"<major>.<minor>"`。舞台接受同主版號且 `minor` ≤ 舞台 minor 的包；否則安裝與載入時拒絕，並寫明「需要舞台 API ≥ x.y」。
> - 舞台只送該包宣告的 minor 以內存在的訊息與欄位；包必須忽略不認得的欄位。新增訊息、指令、欄位升 minor；任何移除或語意改變升 major。

### H18｜medium｜設定寫入協定與驗證歸屬

**單元：** U-pnl（多個頁面／視窗）↔ U-set；U-set ↔ U-pk。

**兩邊都守 AD 卻接不起來：**

- AD-3 只說「透過 IPC 讀寫請求」。編輯頁與包管理頁各自讀整份設定、改一個欄位、整份寫回 → 後寫的蓋掉先寫的。
- 覆蓋值合不合法：面板作者在前端驗證，設定作者假設面板已驗證；手改的設定檔或舊版面板寫入的值就沒人擋。`src/shared` 的設定 zod schema 無法靜態知道每個包有哪些參數。

**收斂（新增 AD-23 — 設定寫入）：**

> - 設定 IPC 只有 `settings.get`、`settings.patch{baseRev, ops[]}`、`settings.preview`（AD-11）。`main/settings` 依序套用 patch；`baseRev` 過舊時以欄位為單位合併（不同欄位都套用，同欄位後到者勝）並回傳新 `rev`。不提供整份覆寫。
> - 覆蓋值在 `main/settings` 寫入時依當下 manifest 驗證（AD-11 規則）；面板的驗證只做 UX，不是把關。
> - 落地以 `flushDebounceMs` 把多次 patch 合併為一次 temp＋rename。

### H19｜low｜示範／展示模式、編輯頁預覽與池子

**單元：** U-ad(demo) ↔ U-pool ↔ U-pnl（showcase、editor）。

**兩邊都守 AD 卻接不起來：**

- 展示要「讓角色 X 演狀態 Y」，但 demo 轉接器只能產生 session 事件，角色由 pool 隨機分配；pool 沒有指定 API → showcase 作者在 pool 外開後門，或 demo 轉接器作者直接寫分配。
- demo session 照 AD-12 被持久化、佔用池子 → 真實 session 被迫重複。
- 編輯頁調參數要預覽：AD-2 依賴圖沒有 panels→沙盒的邊。編輯頁作者可能在面板裡再開一個 PixiJS＋沙盒（第二套繪圖路徑），也可能乾脆不做。

**收斂（AD-15 收緊）：**

> - `demo` session 的角色由 `main/pool` 的 `pool.pin{sessionKey, characterKey}` 指定，只接受 `source = demo` 的 session；demo 分配不持久化、不佔池子名額，且可指定未入池的角色。
> - 編輯頁預覽一律以 pin 住的 demo session 在畫布上演出；面板不載入沙盒、不建 WebGL。

### H20｜low｜穿透切換、點擊行為與視窗邊界

**單元：** U-world（命中）↔ U-win。

**兩邊都守 AD 卻接不起來：**

- AD-14「游標在角色上才請 main 關閉穿透」：overlay 每次 mousemove 都送，還是只在狀態改變時送？快速劃過時兩則 IPC 交錯，視窗可能停在「不穿透」，擋住使用者點擊底下的程式。
- 關閉穿透後點角色做什麼（開編輯頁？拖曳？）沒有 AD；拖曳會改位置（world 擁有），開頁面要 overlay→main 帶 characterKey。
- 使用者換螢幕、改解析度或縮放比例時 U-win 會調整視窗；world 的邊界由誰通知、座標單位（DIP 或實體像素）未定。

**收斂（AD-14 收緊）：**

> - 穿透狀態由 overlay 擁有，只在「在角色上／不在」改變時送 `windows.setCapture{on, seq}`；main 冪等處理並依 `seq` 丟棄過時請求。overlay 在 `captureTimeoutMs` 內沒收到 mousemove 就自動送 `on:false`。
> - v1 點擊行為：左鍵拖曳＝移動該 actor（world 執行，放開後回到遊走）；右鍵＝請 main 開該 characterKey 的編輯頁。包不收任何滑鼠事件（AD-7 不變）。
> - 世界座標單位為所選螢幕的 DIP；`main/windows` 在視窗邊界或縮放比例改變時送 `windows.bounds{width, height, scaleFactor}`，world 把超出邊界的 actor 夾回畫面內。

---

## AD 異動總表

| 異動 | 關掉的洞 |
| --- | --- |
| 新增 AD-16 actor 身分 | H2 |
| 新增 AD-17 舞台視圖（StageView） | H4、H8 |
| 新增 AD-18 節拍與繪圖指令 | H1 |
| 新增 AD-19 通用事件（取代 AD-10 最後兩句） | H9 |
| 新增 AD-20 包的執行期生命週期 | H10 |
| 新增 AD-21 移動意圖與發射 | H14、H15 |
| 新增 AD-22 session 生命週期 | H7 |
| 新增 AD-23 設定寫入 | H18 |
| AD-3 收緊（擁有者表） | H13 |
| AD-5 收緊（原生 id、關聯 id、條件表、採信順序） | H5、H6 |
| AD-6 收緊（後備靜態對應） | H12 |
| AD-7 收緊（第 6～10 點、SES 選項、`stage.random`／`stage.log`） | H3、H16 |
| AD-8 收緊（`major.minor`） | H17 |
| AD-11 收緊（main 計算、完整值、預覽／提交、固定參數不給包） | H8 |
| AD-12 收緊（單一池子開關、釋放語意） | H13 |
| AD-13 收緊（manifest 新欄位：`author`、`assets`、`projectiles`，每角色 `hitbox`／`bounds`／`nameplateAnchor`／`states`／`fallback`／`renamedFrom`；id 格式；撞名規則） | H1、H11、H12、H15 |
| AD-14 收緊（節流、穿透協定、點擊、邊界） | H16、H20 |
| AD-15 收緊（`pool.pin`、demo 不持久化） | H19 |
| Structural Seed 補邊：`stage-view` 匯流、`stage-view --> host`、`host --> main/packs` | H4、H8、H10 |
| Deferred 移除「是否連 JS 內建 Date 都凍結」 | H16 |

## 需要你拍板的選擇

上面的 AD 文字已先填入建議值；以下幾處是真正的設計取捨，確認後再寫進 spine。

| # | 問題 | A（建議） | B |
| --- | --- | --- | --- |
| 1 | `leave` 要不要保留退場時間（H9） | v1 即時移除，簡單、不會短暫出現兩隻 | 保留 `leaveGraceMs` 讓包演退場，期間角色不回池 |
| 2 | 事件裡要不要揭露別包身分（H9） | 不揭露，維持「跨包沒有特殊互動」 | 揭露 characterKey，允許跨包專屬反應（推翻 memlog 決策） |
| 3 | 包停用／角色出池時的現有分配（H10） | 立即重分配 | 保持到 session 結束，期間演佔位 |
| 4 | 執行期暫時失敗（H10） | 保留分配＋佔位＋退避重啟，超過次數才視同停用 | 一失敗就重分配 |
| 5 | 繪圖節拍（H1） | world 固定 30 Hz 拉取，renderer 用最後一則 draw | 每顯示幀（60 Hz）拉取，訊息量與 CPU 加倍 |
| 6 | Worker 內的 `'unsafe-eval'`（H3） | 只在 sandbox iframe／Worker CSP 開，靠 Worker＋SES 隔離 | 不開，改成包必須先經舞台提供的打包工具預先轉換（等於把「角色包製作工具」提前到 v1） |

## 其他觀察

- AD-2、AD-13 沒有標 `[ADOPTED]`，其他 AD 都有；需確認是漏標還是尚未定案。
- AD-7 標 `[ADOPTED]`，但 memlog 第 61 行記為「研究建議，使用者未反對，需原型驗證」，與第 50 行「待使用者確認」。狀態標記與決策紀錄不一致。
- 依賴圖與 Structural Seed 缺的邊（detection→overlay、settings→host、overlay→main 執行狀態、panels→pool／detection）本身就是 H4、H8、H10、H13 的徵兆；補 AD 時一起更新圖。

## 已檢查、未發現洞的部分

- AD-1、AD-2 的依賴方向本身一致（只是缺邊，見上）。
- AD-4 唯讀原則與各單元沒有衝突。
- 狀態碼、來源代碼的命名慣例清楚。
- 運行紀錄、壞檔保護、temp＋rename 規則清楚（僅缺寫入合併，見 H18）。
- AD-9「單一 WebGL 畫布」原則本身正確，問題在指令內容（見 H1）。
