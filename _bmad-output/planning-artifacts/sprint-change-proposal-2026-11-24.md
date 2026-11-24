# Sprint Change Proposal：移動與彈道歸舞台、演出歸包（招式）

- 日期：2026-11-24
- 流程：bmad-correct-course，審查方式：一次列出全部（Batch）
- 狀態：使用者已核准（2026-11-24，附帶修改：發射必須帶出發點）

## 1. 問題摘要

**觸發：** 使用者在示範模式看力天使角色包（`packs/dynames`）時，發現角色被切掉。Epic 1 的畫布本身蓋滿整個螢幕，切掉角色的是 Story 3.6 依 AD-17 實作的規則「超出 manifest `bounds` 的內容裁切」。

**根本原因：** 架構 AD-10（使用者決定 Q7 選 A）規定「包只能請自己的角色停在原地／恢復遊走、轉向，不能指定位置」。包無法表達「整隻角色要移動」，力天使的 TRANS-AM 狙擊衝刺只能把機體畫偏（本地座標左移 1.6～2.0 機高），結果：

- 受擊框與名牌留在原地，衝出去的機體點不到；
- 機體、槍管、光束超出 `bounds`（左 −260、右 +150，機高 110）的部分被切；
- 思考中雙槍連射的子彈約飛 350 基準像素才消失，右側只有 150，飛遠的部分也被切。

`reviews/review-adversarial.md` H14 當時已預告這個結果（「包作者的解法只剩在繪圖指令裡加位移」）。

**問題類型：** 對原始需求的誤解。使用者的心智模型是動作遊戲：角色本體就是受擊框，移動是受擊框在世界中移動，不存在「角色在一個畫框裡移動」。

**使用者定的方向（2026-11-24）：**

1. 移動與彈道歸舞台，角色包只提供演出（每個狀態的動畫自己循環）。
2. 有節奏的演出位移（高速移動、變速、停頓）寫成資料（招式）交給舞台執行。
3. 不同步的解法：舞台是唯一時鐘，每格告訴包招式進行到哪一段、進度幾 %、面向；包照這個選動畫格，不自己計時位移。
4. 招式由兩種方式觸發：狀態宣告（進入該狀態就循環）與包呼叫（例如偶爾前衝）。
5. 不遊走時招式照跑：以停留點為中心，跑完或被打斷時回到停留點。遊走中則暫停遊走、跑完從新位置繼續。
6. 招式水平衝出畫面時，舞台把方向翻過來並通知包轉向。
7. 第一版招式只有「停留」與「直線移動（距離、時間、加減速曲線）」；弧線、跳躍之後再加。
8. 子彈改成舞台的發射物件：彈道由舞台計算，在整個畫布自由飛、能撞到別的角色；包只指定出發點、角度與物件。
9. 發射協定：出發點 `from` 由包定義、必填。角色需要射擊時，包一定要給出發點（例如槍口位置）；沒給就不會射出任何東西（使用者核准時追加）。

## 2. 影響分析

### Epic 影響

| Epic | 狀態 | 影響 |
| --- | --- | --- |
| Epic 1 舞台骨架 | done | 無。畫布已蓋滿整個螢幕 |
| Epic 2 session 狀態 | in-progress | 無 |
| Epic 3 角色包上台 | in-progress | 已完成的 3.1～3.6 不用重做：受擊框（滑鼠命中）、名牌 `anchor`、`bounds` 裁切都相對於 actor 的世界位置，位置一動就跟著走。3.7～3.9 不受影響 |
| Epic 4 角色活起來 | backlog | 主要變更：4.1、4.6 修改驗收條件，新增 Story 4.9 招式 |
| Epic 5、6 | backlog | 無 |

### 文件衝突

- **SPEC（PRD）：** CAP-12（發射與彈道）、CAP-14（包不能指定位置）、Constraints「世界歸舞台管」。
- **架構：** AD-10 最後一句（被取代）、AD-13（manifest 欄位）、AD-16（`stage.move`、`frame.motion`）、AD-17（`bounds` 的意思）、AD-18（發射）、資料擁有者表；新增 AD-27 招式；Deferred 表加兩列。
- **epics.md：** FR16、FR18、Epic 4 描述（兩處）、Additional Requirements 兩行、Story 4.1、4.6，新增 Story 4.9。
- **角色包作者文件 `docs/pack-api-v1.md`：** 第 3.3 節 `bounds`、第 9 節「1.1 預計加入」。
- **其他：** `sprint-status.yaml`（加 4.9 與排序規則）、`reviews/user-decisions.md`（Q7 加修訂註記）、`glossary.md`（加「招式」）、架構與 SPEC 的 `.memlog.md`。
- **UX：** 沒有 UX 文件，N/A。

### 技術影響

- 程式：v1.0 已實作的部分不用改。新增的都是 API v1.1（升 minor）的追加：manifest `moves`、`stateMoves`、`projectiles` 物件寫法；`stage.move`；`frame.motion` 加欄位；`stage.fire` 加 `from`、`angle`。v1.0 的包照常可用。
- `src/shared/pack-api/manifest.ts` 的 `projectiles` 目前是 `record<id, id>`，v1.1 放寬成「字串或物件」，向下相容。
- 力天使角色包要改版（衝刺改用招式、子彈改用 `stage.fire`），等 4.6、4.9 完成後做；在那之前 TRANS-AM 仍會被切。

## 3. 建議做法

**選擇：直接調整（Option 1）。**

| 選項 | 評估 |
| --- | --- |
| 1 直接調整：改 SPEC／架構／Epic 4 規劃，新增一個 story | 可行。Epic 4 還沒開工，改規劃成本最低；不動已完成的程式。工作量：文件低、實作中（多一個 story）。風險：低～中（招式與進度回報是新設計，靠 world 單元測試把關） |
| 2 回滾 | 不可行，也不需要：已完成的程式與新設計相容 |
| 3 縮減 MVP | 不需要：範圍只多一個 story，MVP 目標不變 |

## 4. 詳細修改內容

以下「舊」是目前檔案內容（含其他 session 未 commit 的改動），「新」是修改後內容。只改列出的段落。

### 4.1 SPEC.md（`_bmad-output/specs/spec-ai-watchdog-pet-stage/SPEC.md`）

**CAP-12 intent**

舊：
> 不同包的角色透過五種通用互動彼此反應：被擊中、靠近／碰撞、進場／離場、狀態廣播、被捏起來。舞台提供通用飛行物件，包可以用自己的物件；沒指定或舞台不認得時，改丟一個隨機的通用物件。命中由舞台判定。

新：
> 不同包的角色透過五種通用互動彼此反應：被擊中、靠近／碰撞、進場／離場、狀態廣播、被捏起來。舞台提供通用飛行物件，包可以用自己的物件；沒指定或舞台不認得時，改丟一個隨機的通用物件。彈道與命中都由舞台負責：包必須指定出發點，可另指定角度與物件，沒指定出發點就不發射；飛行物件在整個畫布裡飛，不受射方的繪圖範圍裁切（2026-11-24 修改）。

**CAP-12 success**

舊：
> A 包射中 B 包的角色時，B 收到 `hit`；沒處理 `hit` 的包沒有反應，也不報錯；指定了不認得的物件時，仍然會丟出通用物件。

新：
> A 包射中 B 包的角色時，B 收到 `hit`；沒處理 `hit` 的包沒有反應，也不報錯；指定了不認得的物件時，仍然會丟出通用物件；斜向發射的物件能飛過畫面、打中遠處的角色。

**CAP-14 intent**

舊：
> 包可以請自己的角色停下、恢復遊走或轉向，但不能指定位置。

新：
> 包可以請自己的角色停下、恢復遊走或轉向，也可以宣告「招式」（有節奏的移動，例如衝刺、變速、停頓）交給舞台執行。包不能指定位置、看不到座標；舞台每格告訴包招式進行到哪裡，包照著演（2026-11-24 修改）。

**CAP-14 success**

舊：
> 包請求停下後，角色停在原地；使用者把遊走設成關閉時，包的恢復遊走請求無效。

新：
> 包請求停下後，角色停在原地；使用者把遊走設成關閉時，包的恢復遊走請求無效。招式進行時，受擊框、名牌與繪圖範圍跟著角色移動、不被裁切；停留中的角色跑完招式回到停留點；招式衝向螢幕邊緣時方向翻轉。

**Constraints 第 5 條**

舊：
> - 世界歸舞台管：位置、移動、碰撞、飛行物件都由舞台負責；包只回傳繪圖指令，由舞台用單一畫布統一畫（AD-9、AD-10、AD-17）。

新：
> - 世界歸舞台管：位置、移動、碰撞、飛行物件與彈道都由舞台負責；包只回傳繪圖指令，由舞台用單一畫布統一畫。包需要有節奏的移動時宣告招式，由舞台執行並每格告訴包進度（AD-9、AD-10、AD-17、AD-27）。

### 4.2 架構（`ARCHITECTURE-SPINE.md`）

**資料擁有者表「世界」列**

舊：`| 世界（位置、移動、碰撞框、飛行物件、節拍） | overlay/world | 角色包只收事件 |`

新：`| 世界（位置、移動、招式執行、碰撞框、飛行物件與彈道、節拍） | overlay/world | 角色包只收事件與 frame.motion；招式由包宣告、world 執行（AD-27） |`

**AD-10 Rule 最後兩句**

舊：
> 包只能請自己的角色停在原地／恢復遊走、轉向（`stage.hold`、`stage.face`，AD-16），不能指定位置、看不到座標；使用者的遊走偏好優先，設成不遊走就一定不動 [ADOPTED]。事件與發射細則見 AD-18。

新：
> 移動與彈道歸舞台、演出歸包 [ADOPTED 2026-11-24，取代 Q7 的 A]：包不能指定位置、看不到座標，能影響移動的只有三種方式：請自己的角色停在原地／恢復遊走、轉向（`stage.hold`、`stage.face`，AD-16），以及宣告招式（有節奏的移動，由 world 執行，AD-27）。使用者的遊走偏好只管舞台自己的閒逛：設成不遊走就不閒逛，但招式照跑，跑完回到停留點。事件與發射細則見 AD-18。

**AD-13 Rule（manifest 欄位）**

舊：
> 選填 `projectiles`（key → `assets` 的 key）。每個角色宣告 …、選填 `defaults`（固定參數 `scale`、`wander` 的建議預設）、選填 `advancedBitmap`。

新：
> 選填 `projectiles`（key → `assets` 的 key，或 `{ asset, speed, range }`，AD-18）。每個角色宣告 …、選填 `defaults`（固定參數 `scale`、`wander` 的建議預設）、選填 `advancedBitmap`、選填 `moves` 與 `stateMoves`（招式，AD-27）。

**AD-16 `stage` 那一條**

舊：
> …、`stage.hold(actorId, on)`（己方角色停在原地／恢復遊走）、`stage.face(actorId, 'left' | 'right')`（轉向）。`hold`／`face` 只對己方 actor 有效，使用者設為不遊走或角色被捏起來時不生效。時間只來自 `frame` 的 `t`。

新：
> …、`stage.hold(actorId, on)`（己方角色停在原地／恢復遊走）、`stage.face(actorId, 'left' | 'right')`（轉向）、`stage.move(actorId, key | null)`（觸發或停止招式，AD-27）。`hold`／`face` 只對己方 actor 有效，使用者設為不遊走或角色被捏起來時不生效。時間只來自 `frame` 的 `t`。

**AD-16 訊息表 `frame` 列**

舊：`… 己方 actor 的狀態（已依 AD-18 對應）與 motion（是否移動、面向、是否被捏起來 held）、本 tick 的通用事件 …`

新：`… 己方 actor 的狀態（已依 AD-18 對應）與 motion（是否移動、面向、是否被捏起來 held，以及招式進度 move、step、progress、returning，AD-27）、本 tick 的通用事件 …`

**AD-16 包→舞台那一句**

舊：`包→舞台只有：frame 的回傳值（draw）、stage.fire、stage.hold、stage.face、stage.log。`

新：`包→舞台只有：frame 的回傳值（draw）、stage.fire、stage.hold、stage.face、stage.move、stage.log。`

**AD-17 繪圖座標那一條，句尾加一句**

加：
> `bounds` 是跟著 actor 走的近身繪圖框，不是活動範圍；角色的位移一律由 world 執行（招式，AD-27），不得用繪圖指令的偏移模擬。

**AD-18 發射那一條**

舊：
> 發射：`stage.fire(fromActorId, { target, object })`，兩者都選填。有 `target`（另一個 `actorId`）就朝目標發射，否則依面向水平發射；速度、射程、每個 actor 每秒次數上限是舞台常數，超出的丟棄。`object` 是 manifest `projectiles` 的 key，由 renderer 直接畫，射方包不參與每格繪製；落空依 AD-10 改丟通用物件。飛行物件屬於 world；射方包卸除後，其自訂物件改以通用外觀飛完。命中以 `hit` 通知，同包也收到。

新：
> 發射：`stage.fire(fromActorId, { from, object, angle, target })`。`from` 必填 [ADOPTED 2026-11-24]：出發點（本地座標 `{ x, y }`），由包定義（例如槍口位置）；沒給或格式不對時不發射，整則丟棄並記錄 `packId`。其餘選填：有 `target`（另一個 `actorId`）就朝目標發射，否則照 `angle`（度，0＝右、90＝下，與繪圖座標同向），沒給 `angle` 就依面向水平發射。彈道由 world 計算，第一版為直線；飛行物件在整個畫布裡飛，不受射方 `bounds` 裁切，超過射程或飛出畫面就移除，圖沿飛行方向旋轉，不會打中射方自己。速度與射程取 manifest `projectiles` 物件寫法的 `speed`、`range`（基準像素／秒、基準像素，乘射方「大小」），沒寫或用字串寫法時用舞台預設，都夾在舞台上限內；每個 actor 每秒次數上限是舞台常數，超出的丟棄。`object` 是 manifest `projectiles` 的 key，由 renderer 直接畫，射方包不參與每格繪製；落空依 AD-10 改丟通用物件。飛行物件屬於 world；射方包卸除後，其自訂物件改以通用外觀飛完。命中以 `hit` 通知，同包也收到。

**新增 AD-27（放在 AD-26 之後）**

> ### AD-27 — 招式：包宣告節奏、world 執行、舞台是唯一時鐘 [ADOPTED]
>
> - **Binds:** `overlay/world`、`overlay/pack-host`、`src/shared/pack-api`、manifest、第三方角色包
> - **Prevents:** 動畫與位移各自計時而不同步；包把身體畫偏，受擊框、名牌留在原地、超出 `bounds` 被切；包看不到座標而衝出螢幕
> - **Rule:**
>   - manifest 每個角色可宣告 `moves`：招式 key → 段落清單。段落兩種：`hold`（停 `duration` 秒）、`line`（沿面向前進 `dx`、往下 `dy` 基準像素，`duration` 秒，`easing` 為 `linear`／`in`／`out`／`in-out`）。`dx` 正值＝朝面向前進。段數、單段速度（距離÷時間）、單段距離有上限（shared 常數），安裝時驗證，超出拒絕並說明原因。第一版沒有弧線、跳躍。
>   - 觸發：角色選填 `stateMoves`（狀態碼 → 招式 key），進入該狀態就循環跑該招式，狀態改變時中斷。包也可以呼叫 `stage.move(actorId, key)` 觸發一次，優先於狀態的招式，跑完後狀態的招式從頭再跑；`stage.move(actorId, null)` 停止目前的招式。正在跑時觸發新招式＝中斷舊的、開始新的。
>   - 唯一時鐘：world 依節拍執行招式，移動 actor 的世界位置；受擊框、名牌、`bounds`、發射起點都跟著走。每則 `frame` 的 `motion` 帶 `move`（招式 key 或 `null`）、`step`（段落索引）、`progress`（該段 0～1）、`returning`（是否正在回停留點）、`moving`、`facing`、`held`。包依此選動畫格，不自行計時位移；包最多落後一則 `frame`，掉格只影響姿勢，不影響位置。
>   - 遊走與停留：遊走中跑招式時暫停遊走，跑完從新位置繼續。停留中（使用者設不遊走，或包 `hold(true)`）以停留點為中心跑；招式結束或被中斷時，world 以舞台的回位速度把角色帶回停留點，期間 `returning` 為 `true`。
>   - 邊界：一段 `line` 開始時，若它的終點會讓 `hitbox` 水平超出畫面，world 把該段與之後各段的水平方向翻過來並改面向（下一則 `frame` 的 `facing` 反映）；翻了仍放不下、或垂直超出時，停在邊上。
>   - 捏起來：招式立即中止；放開後照 AD-14 從放下處恢復遊走；停留中的角色以放下處為新停留點。
>   - 角色之間不擋路，穿過時只產生 `proximity`（AD-18）。
>   - `pack-host` 驗證 `stage.move` 的 `actorId` 屬於該包、key 在該角色的 `moves` 裡，否則整則丟棄並記錄 `packId`。

**Deferred 表加兩列**

| 項目 | 為什麼可以等 |
| --- | --- |
| 招式的弧線、跳躍等段落 | 第一版只有 `hold`、`line`；要加新段落類型時升 API minor（AD-27） |
| 拋物線等非直線彈道 | 第一版直線；要加時在 `projectiles` 物件寫法加欄位並升 minor（AD-18） |

### 4.3 epics.md

**FR16**

舊：
> FR16: 包可以發射物件：用包自己的物件，沒指定、不認得或素材載入失敗時改丟隨機的通用物件；命中由舞台判定並以 `hit` 通知。〔CAP-12〕

新：
> FR16: 包可以發射物件：必須指定出發點（沒指定就不發射），可另指定角度與物件；彈道由舞台計算，物件在整個畫布裡飛、不受射方繪圖範圍裁切；用包自己的物件，沒指定、不認得或素材載入失敗時改丟隨機的通用物件；命中由舞台判定並以 `hit` 通知。〔CAP-12〕

**FR18**

舊：
> FR18: 包可以請自己的角色停下／恢復遊走、轉向，不能指定位置；使用者設成不遊走或角色被捏起來時請求無效。〔CAP-14〕

新：
> FR18: 包可以請自己的角色停下／恢復遊走、轉向，不能指定位置；使用者設成不遊走或角色被捏起來時這些請求無效。包可以在 manifest 宣告招式（停留與直線移動的段落），由狀態自動循環或包呼叫觸發，舞台執行並每格告訴包進度；遊走中跑完從新位置繼續，停留中跑完回停留點，水平衝出畫面時翻轉方向，被捏起來時中止。〔CAP-14〕

**Epic 4 描述（Epic List 與 Epic 4 標題下兩處）**

舊：`… 同包角色有專屬互動，包能請自己的角色停下或轉向。`

新：`… 同包角色有專屬互動，包能請自己的角色停下或轉向，並宣告招式讓舞台照節奏移動角色。`

**Additional Requirements「角色包 API v1」**

舊：`包只回 draw 與 stage.fire／hold／face／log／random／canvas；…；命中只看 manifest hitbox。〔AD-16、AD-17、AD-18〕`

新：`包只回 draw 與 stage.fire／hold／face／move／log／random／canvas；…；命中只看 manifest hitbox；招式由 world 執行，frame.motion 帶招式進度（v1.1）。〔AD-16、AD-17、AD-18、AD-27〕`

**Additional Requirements「manifest」**

舊：`characters（id、name、參數宣告、states、fallback、hitbox、bounds、anchor、advancedBitmap）、projectiles；…〔AD-13〕`

新：`characters（id、name、參數宣告、states、fallback、hitbox、bounds、anchor、advancedBitmap、v1.1 起 moves、stateMoves）、projectiles（v1.1 起也可寫成 { asset, speed, range }）；…〔AD-13、AD-27〕`

**Story 4.1 第二組驗收條件**

舊：`Then 該角色一定不動`

新：`Then 該角色不閒逛；招式照跑，跑完回到停留點（Story 4.9）`

**Story 4.6 第一組驗收條件**

舊：
> **Given** 包呼叫 `stage.fire(fromActorId, { target, object })`
> **When** world 處理
> **Then** 有 `target` 就朝目標發射，否則依面向水平發射；速度、射程、每個 actor 每秒次數上限是舞台常數，超出的丟棄〔FR16〕
> **And** 飛行物件屬於 world，由 renderer 直接畫，射方包不參與每格繪製

新：
> **Given** 包呼叫 `stage.fire(fromActorId, { from, object, angle, target })`（`from` 必填，其餘選填）
> **When** world 處理
> **Then** 從 `from`（本地座標，由包定義，例如槍口）出發；有 `target` 就朝目標，否則照 `angle`（度，0＝右、90＝下），沒給就依面向水平發射；速度與射程取 manifest `projectiles` 的 `speed`、`range`，沒寫用舞台預設，都夾在舞台上限內；每個 actor 每秒次數上限是舞台常數，超出的丟棄〔FR16〕
> **And** 彈道由 world 計算（第一版直線）；飛行物件在整個畫布裡飛、不受射方 `bounds` 裁切，超過射程或飛出畫面就移除，圖沿飛行方向旋轉，不會打中射方自己；由 renderer 直接畫，射方包不參與每格繪製
>
> **Given** 包呼叫 `stage.fire` 時沒帶 `from`，或 `from` 不是有效的本地座標
> **When** pack-host 驗證
> **Then** 不發射任何物件，整則丟棄並記錄 `packId`
>
> **Given** manifest `projectiles` 的值是素材 key（v1.0 寫法）或 `{ asset, speed, range }`
> **When** 安裝
> **Then** 兩種都接受；`speed`、`range` 超出上限時拒絕並說明原因

**新增 Story 4.9（放在 Story 4.8 之後）**

> ### Story 4.9: 招式：舞台照包宣告的節奏移動角色
>
> As a 角色包作者,
> I want 把有節奏的移動（例如狙擊時的高速衝刺、變速、停頓）宣告成招式交給舞台執行,
> So that 衝刺時受擊框、名牌與繪圖範圍跟著角色走、不會被畫框切掉，動畫也跟移動對得上。
>
> **Acceptance Criteria:**
>
> **Given** manifest 角色宣告 `moves`（招式 key → 段落清單；段落為 `hold` 或 `line`）與選填 `stateMoves`（狀態碼 → 招式 key）
> **When** 安裝
> **Then** schema 驗證段數、速度、距離上限（shared 常數），超出拒絕並說明原因；沒有這兩個欄位的 v1.0 包照常安裝〔FR18〕
>
> **Given** 角色進入有 `stateMoves` 的狀態，或包呼叫 `stage.move(actorId, key)`
> **When** world 推進
> **Then** world 依段落移動 actor 的世界位置，受擊框、名牌、`bounds`、發射起點都跟著走；狀態的招式在該狀態期間循環，包觸發的招式跑一次、跑完回到狀態的招式；`stage.move(actorId, null)` 停止；狀態改變時中斷
> **And** 每則 `frame` 的 `motion` 帶 `move`、`step`、`progress`（0～1）、`returning`、`moving`、`facing`、`held`，與 world 的位置一致
>
> **Given** 角色在遊走中
> **When** 招式開始與結束
> **Then** 招式期間暫停遊走，結束後從新位置繼續遊走
>
> **Given** 角色停留中（使用者設不遊走，或包 `hold(true)`）
> **When** 招式結束或被中斷
> **Then** world 以回位速度把角色帶回停留點，期間 `motion.returning` 為 `true`
>
> **Given** 某段 `line` 的終點會讓 `hitbox` 水平超出畫面
> **When** world 開始該段
> **Then** 把該段與之後各段的水平方向翻過來並改面向，下一則 `frame` 的 `facing` 反映；翻了仍放不下、或垂直超出時停在邊上
>
> **Given** 招式進行中角色被捏起來
> **When** `grab` 開始
> **Then** 招式立即中止；放開後照 Story 4.4 從放下處恢復；停留中的角色以放下處為新停留點
>
> **Given** 包對不屬於自己的 `actorId` 呼叫 `stage.move`，或 key 不在該角色的 `moves`
> **When** pack-host 驗證
> **Then** 整則丟棄並記錄 `packId`
>
> **Given** world 的單元測試（假時鐘）
> **When** 跑一個含 `hold` 與 `line`（各種 `easing`）的招式，涵蓋遊走、停留回位、邊界翻轉、捏起來中止
> **Then** 每個 tick 的世界位置與 `motion` 的 `step`／`progress` 一致；契約測試包加一個招式，端到端可看到角色移動

### 4.4 角色包作者文件（`docs/pack-api-v1.md`）

**第 3.3 節 `bounds`**

舊：`- bounds：繪圖範圍，超出的內容會被裁掉。`

新：`- bounds：繪圖範圍，超出的內容會被裁掉。它跟著角色走，是近身的繪圖框，不是活動範圍：不要把身體畫偏來表現移動；衝刺這類位移在 v1.1 用招式交給舞台執行（第 9 節）。`

**第 8.2 節 `stage.fire` 那一列，句尾加一句**

加：`v1.1 起必須帶出發點 from（本地座標，例如槍口），沒帶就不發射（第 9 節）`

**第 9 節「1.1 預計加入」**

舊：
> - 1.1 預計加入：`frame` 裡每個 actor 的 `motion`（是否在移動、面向、是否被捏起來），以及互動事件（靠近、被擊中、被捏起來、別的角色狀態改變）。

新：
> - 1.1 預計加入：`frame` 裡每個 actor 的 `motion`（是否在移動、面向、是否被捏起來、招式進度）；互動事件（靠近、被擊中、被捏起來、別的角色狀態改變）；招式（manifest `moves`、`stateMoves` 與 `stage.move`，讓舞台照包宣告的節奏移動角色）；`stage.fire` 必須帶出發點 `from`（沒帶就不發射）、可另帶角度，以及 `projectiles` 的速度與射程。

### 4.5 其他

- **`sprint-status.yaml`：** Epic 4 在 `4-8-…` 之後加 `4-9-招式-舞台照包宣告的節奏移動角色: backlog`；`sequencing_rules` 加一條 `moves-after-wander`：「4.9 依賴 4.1（world 位置與遊走）與 4.4（捏起來）；排在 4.4 之後即可，不必等 4.5～4.8。力天使角色包改版等 4.6 與 4.9 完成後再做。」
- **`reviews/user-decisions.md`：** Q7 表格後加註「2026-11-24 修訂：改為移動與彈道歸舞台、演出歸包，新增招式（AD-27）；不遊走時招式照跑並回停留點。見 sprint-change-proposal-2026-11-24.md。」
- **`glossary.md`：** 加一列「招式：角色包在 manifest 宣告的一段有節奏的移動（停留、直線移動的段落），由舞台執行；舞台每格告訴包進行到哪一段，包照著演。」
- **架構 `.memlog.md`、SPEC `.memlog.md`：** 各記一筆這次的決定。

## 5. 執行交接

- **變更規模：Moderate。** 需要調整 backlog（新增 4.9、修改 4.1、4.6），也改了一條已採用的架構決定（AD-10），但不用回滾，也不影響已完成的 Epic 1～3。
- **交接：**
  - 規劃文件修改：本次 correct-course 在使用者核准後直接套用第 4 節的內容。
  - 實作：Epic 4 開工時照一般流程建 story（4.1 → … → 4.4 → 4.9 → 其餘）。4.6 與 4.9 都會改 `src/shared/pack-api`，API 版本升到 1.1。
  - 角色包：力天使角色包改版（衝刺改用招式、子彈改用 `stage.fire`、`bounds` 縮回近身框），等 4.6 與 4.9 完成後做。
- **成功條件：**
  - 文件之間一致：SPEC、架構、epics、作者文件對「包不能指定位置、招式由舞台執行、彈道由舞台計算」的說法一致，沒有殘留「設成不遊走就一定不動」。
  - 4.9 完成後：力天使衝刺時受擊框、名牌跟著走，不被裁切；思考中的子彈能飛過畫面、打中別的角色。

## 附錄：Change Navigation Checklist

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 1.1 觸發 story | [x] | Story 3.6 的 `bounds` 裁切；示範模式看力天使時發現 |
| 1.2 問題定義 | [x] | 對原始需求的誤解：使用者要的是受擊框本身移動 |
| 1.3 證據 | [x] | 力天使 `bounds` −260～150、TRANS-AM 位移 1.6～2.0 機高、子彈飛約 350 基準像素；review H14 |
| 2.1 目前 epic | [x] | Epic 3 可照原計畫完成 |
| 2.2 epic 層級變更 | [x] | Epic 4 改 4.1、4.6，新增 4.9 |
| 2.3 其餘 epic | [x] | Epic 5、6 無影響 |
| 2.4 作廢或新增 epic | [N/A] | 不需要 |
| 2.5 排序 | [x] | 4.9 排在 4.4 之後 |
| 3.1 PRD（SPEC） | [x] | CAP-12、CAP-14、Constraints |
| 3.2 架構 | [x] | AD-10、13、16、17、18，新增 AD-27，擁有者表、Deferred 表 |
| 3.3 UX | [N/A] | 沒有 UX 文件 |
| 3.4 其他文件 | [x] | `docs/pack-api-v1.md`、`sprint-status.yaml`、`glossary.md`、`user-decisions.md`、memlog |
| 4.1 直接調整 | Viable | 工作量低～中、風險低～中 |
| 4.2 回滾 | Not viable | 沒有需要回滾的 story |
| 4.3 縮減 MVP | Not viable | 不需要 |
| 4.4 選定做法 | [x] | Option 1 直接調整 |
| 5.x 提案內容 | [x] | 本文件第 1～5 節 |
| 6.1～6.2 檢查 | [x] | 已交叉比對 SPEC、架構、epics、作者文件 |
| 6.3 使用者核准 | [x] | 2026-11-24 核准；追加「發射必須帶出發點，沒帶就不發射」 |
| 6.4 sprint-status | [x] | 已加入 4-9 與排序規則 moves-after-wander |
| 6.5 下一步 | [x] | 見第 5 節 |
