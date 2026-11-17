---
title: 'Story 3.6（中）：節拍、舞台訊息與 sprite 繪製'
type: 'feature'
created: '2026-11-17'
status: 'done'
baseline_commit: 'f09cb866b89f8ec3f257a9c3edcace0fc8cb3992'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-5-sandbox-chain.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-6-effective-params.md'
  - '{project-root}/_bmad-output/implementation-artifacts/sandbox-prototype-report.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包已經在沙盒裡載入（3.5），有效參數也算好了（3.6 上），但包收不到任何舞台訊息，畫布上也還只有 Epic 2 的示範方塊。使用者看不到分到的角色。

**Approach:**
- **節拍：** 新增 `overlay/world`，以 `TICK_HZ`（30）推進。
- **舞台訊息：** pack-host 依 StageView 的 `actors` 與 `characters` 對每包送 `init`／`spawn`／`despawn`／`params`／`meta`／`frame`。
- **回傳繪圖：** Worker bootstrap 把訊息交給包的 `handlers`，`frame` 的回傳值包成 `draw` 送回。
- **繪製：** overlay 在單一 PixiJS 畫布上，用每包最後一則有效的 `draw` 畫 sprite：
  - 角色先在畫面底部排成一排，依序套 world 位置、固定參數「大小」，actor 之間依 y 排序。
  - 超出 manifest `bounds` 的部分裁切。
- **素材：** manifest 與 spritesheet JSON 經 IPC 取得；圖片從帶版本的 `pack://` 網址載入並快取。
- **收尾：** 移除 Epic 2 的示範方塊空殼。

**Decisions（2026-11-17）：**
- **素材怎麼拿：**
  - 圖片用 `Image` 從 `pack://` 載入，overlay CSP 只加 `img-src pack:`。
  - manifest 與 spritesheet JSON 由 main 經 IPC 給，不給 `pack` scheme `supportFetchAPI`，也不開 `connect-src pack:`；維持 AD-24 的最小權限。
- **座標與像素：** sprite 的 `x`、`y` 是圖的左上角，在 actor 本地座標（基準像素）；1 個圖像素＝1 基準像素 × `scaleX`／`scaleY`，負值就是翻轉。這是契約測試包的寫法，作者文件第 11 節「未定」改成定案。
- **spritesheet 支援的欄位：**
  - `frames` 的 `frame` 矩形，`rotated`、`trimmed`、`spriteSourceSize`、`sourceSize` 照 PixiJS 處理。
  - `meta.image`、`meta.size`；`meta.scale` 只接受 1 或省略。
  - `animations` 忽略，包自己用 `frame` 選圖。
  - schema 放在 `src/shared/pack-api`，載入時檢查。
- **`draw` 漏了己方 actor：** 那個 actor 這一則什麼都不畫。
- **粒子與 bitmap 指令：** 3.6 下段才畫。這段略過這兩種指令（每包記一行），其他照畫；整則因此丟棄會讓契約測試包在「思考中」時整隻消失。
- **狀態對應不到：** 狀態依 `states`／`fallback` 對應後才送給包；兩邊都對應不到時照送原狀態，該 actor 不畫。佔位演出在 3.7。
- **排列：** 畫面底部靠右排成一排，順序同 `actors`，間距用 `bounds` 寬度 × 大小，再加固定間隔；放不下的不畫。遊走在 Epic 4。
- **滑鼠（使用者 2026-11-17 選 B）：** 角色的 manifest `hitbox` × 大小，在它的畫面位置上交給 `pointer.ts`；滑鼠移到角色身上時畫布接住滑鼠，移開恢復穿透。右鍵目前沒有選單，角色的右鍵選單在 4.3。
- **右鍵選單：** 只認示範 session 的右鍵選單隨示範方塊一起移除，示範模式改從選單列切換。角色的右鍵選單在 4.3。

## Boundaries & Constraints

**Always:**
- **每包最多一則 `frame` 在途：** 上一則沒回就跳過這個 tick，不排隊。renderer 每個顯示幀用該包最後一則有效的 `draw`，永不等待；一包變慢不影響其他包。
- **`init`：** 沙盒就緒後第一則，帶目前所有 actor（己方帶 `characterId`、完整有效參數、對應後的狀態、顯示名稱；別包的只帶 `actorId` 與狀態），不補發歷史。
- **之後的訊息：**
  - 己方 actor 加入、移出時送 `spawn`／`despawn`。
  - 角色有效參數改變時送 `params`，同一角色每 tick 最多一則。
  - 顯示名稱改變時送 `meta`。
  - `frame` 帶 `seq`、`t`、`dt`、己方 actor 對應後的狀態與本 tick 的 `enter`／`leave` 事件。
- **不送給包的：** `motion`（API 1.1）、固定參數、`sessionKey`、`source`、`confidence`、別包的 `characterId`。
- **`draw` 的檢查順序：**
  1. 完整 parse 前，先擋位元組數與指令數上限。
  2. 用 `drawMessageSchema` 驗證。
  3. 只接受己方 `actorId`。
  4. sprite 的 `asset` 必須是該包 manifest 的 key；`frame` 只用在 spritesheet，而且名稱存在。
  - 任何一條不過，整則丟棄，記一行帶 `packId`（照 3.5 的丟棄 log 限速）。
- **素材快取：** 以 `packId@version` 分開，換版本或移除包就釋放。spritesheet 的 frame 不進 PixiJS 的全域快取，不同包同名不會互撞。
- **`Assets.setPreferences({ preferCreateImageBitmap: false })`：** 維持在任何載入之前。
- **找不到：** actor 的包或角色不在 `packs`／`characters`（3.4 交接條件）時不畫，每包記一行，不出錯。
- **暫停：** StageView `power` 的 `suspended` 或 `locked` 時，節拍暫停，恢復後繼續；暫停期間不送 `frame`。
- **解析度：** 依 `canvas.scaleFactor` 設 PixiJS 的 resolution，換螢幕時跟著改。
- **hit area：** 每個畫出來的 actor 一塊，key 是它的 `sessionKey`，範圍是 `hitbox` × 大小在它的畫面位置；疊在上面（y 排序較後）的優先；actor 沒畫（找不到、狀態對應不到、放不下）就沒有 hit area。
- **render loop：** 有 actor 時才跑。
- **新常數：** 只放 `src/shared/constants`，例如 `TICK_HZ`、`draw` 的位元組與指令上限。

**Never:**
- 不做粒子、bitmap、`stage.canvas`、WebGL context lost 與 GPU 當掉的處理（3.6 下段）。
- 不做佔位演出、名牌與標記（3.7、3.8），不做心跳、`drawTimeoutMs` 判定失敗、自動重建（3.9）。
- 不做遊走、捏起來、角色右鍵選單（Epic 4）。
- 不給 `pack` scheme 多的權限，不在 app 程式加測試後門。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 出現 | 某 session 分到契約測試包的角色，沙盒就緒 | 包收到 `init`（含完整有效參數、對應後狀態、顯示名稱）；之後每 tick 一則 `frame`；回傳的 `draw` 在畫面底部畫出那個角色 |
| 加入與移出 | 同包再多一個 actor；之後一個 actor 離場 | 送 `spawn`（含參數、狀態、名稱）與 `enter` 事件；離場送 `despawn` 與 `leave`，畫面上那隻消失 |
| 狀態改變 | actor 的狀態改變 | 下一則 `frame` 帶對應後的新狀態，`draw` 跟著變 |
| 狀態對應不到 | 狀態不在 `states`，`fallback` 也沒有 | `frame` 照送原狀態，該 actor 不畫 |
| 參數與名稱 | 角色的有效參數改變；session 顯示名稱改變 | 該 tick 送一則 `params`；送 `meta` |
| 在途 | 包上一則 `frame` 還沒回 | 跳過這個 tick；renderer 照用最後一則 `draw` |
| 一包變慢 | 一包一直不回 `draw` | 其他包照常推進、照常畫 |
| 大小與排序 | 兩個 actor，固定參數 `scale` 不同 | 各自依 `bounds` 寬度 × 大小排在底部；大小乘在原始尺寸上；依 y 排序 |
| 裁切 | `draw` 的內容超出 `bounds` | 超出的部分不畫 |
| spritesheet | 契約測試包 probe-two 用 `frame` 選 spritesheet 的圖 | 畫出那個 frame；不同包同名的 frame 不互相影響 |
| 素材快取 | 同一素材在多個 tick 使用；包換版本 | 只載入一次；換版本後用新版本的網址重新載入 |
| 超過上限 | `draw` 的位元組或指令數超過上限 | 完整 parse 前就整則丟棄，記一行帶 `packId` |
| 不合規 | `draw` 不合 schema、`actorId` 不是己方、`asset` 不在 manifest、`frame` 用在單張圖或名稱不存在 | 整則丟棄，記一行帶 `packId` |
| 粒子與 bitmap | `draw` 含 `particles` 或 `bitmap` 指令 | 略過那幾條，其他照畫，每包記一行 |
| 漏回 | `draw` 沒有某個己方 actor | 那個 actor 這一則不畫 |
| 找不到 | actor 指向不在 `packs` 或 `characters` 的包或角色 | 不畫，每包記一行，其他照常 |
| 暫停 | 系統睡眠或鎖定，之後喚醒或解鎖 | 期間不送 `frame`、節拍停止；恢復後繼續 |
| 換螢幕 | 畫布移到縮放比例不同的螢幕 | PixiJS resolution 跟著 `canvas.scaleFactor` 改，角色不模糊、大小正確 |
| 隱私 | 送給包的所有訊息 | 沒有 `sessionKey`、`source`、`confidence`、固定參數、`motion`、別包的 `characterId` |
| 示範方塊 | 打開示範模式 | 畫布上不再有示範方塊；示範 session 分到的角色照一般角色畫出 |
| 滑鼠 | 滑鼠移到角色的 `hitbox` × 大小範圍內，再移開 | 移入時畫布接住滑鼠（`canvas:set-hover`），移開恢復穿透；兩隻重疊時上面那隻優先；右鍵沒有選單 |

</frozen-after-approval>

## Code Map

- **`src/sandbox/worker-bootstrap.ts`：**
  - 在 port 上收訊息，用 `stageMessageSchema` 驗證後交給 `handlers[type]`。讀取 getter、呼叫 handler 都包 try/catch。
  - 依 `init`／`spawn`／`despawn` 更新己方 actor 的 Set（傳給 `createStage`，`stage.random` 才認得）。
  - `frame` 的回傳值包成 `{ type: 'draw', seq, actors }`；無法 clone 時丟棄並記錄，不讓 Worker 掛掉。
  - 不改 3.5 的開機順序與清單。
- **`src/overlay/pack-host/`：**
  - `SandboxFrame` 加 `post()`（dom.ts 的 port1）。
  - 每包記住已送的 actor、在途的 `seq`、最後一則有效的 `draw`。
  - 在 `isReport` 之後、`checkPackMessage` 之前把 `type: 'draw'` 分流給 draw 的檢查。
  - 銷毀或失敗時清掉該包的 draw 與在途標記。
  - `jsonBytes`（rules.ts）可當完整 parse 前的位元組檢查。
- **`src/overlay/world/`（新）：** 節拍、actor 的排列位置、狀態對應、事件、暫停。純邏輯，可在 node 測。
- **`src/overlay/renderer/`（新）：**
  - PixiJS 的容器樹：每個 actor 一個容器，套位置、大小、`bounds` 遮罩，子層是 sprite；依 y 排序。
  - 素材載入：`Image` 從 `pack://`，spritesheet 用 IPC 拿到的 JSON 建 `Spritesheet`，並設 `cachePrefix` 或只用回傳的 `textures`。
  - 有 actor 才啟動 ticker。
  - 可測的部分（命令轉成繪製參數、排列、裁切矩形）寫成純函式。
- **`src/overlay/main.ts`：**
  - 接上 world、renderer、pack-host。
  - 刪除示範方塊的部分（Graphics／Text、`draw()` 的方塊）；resolution 跟 `canvas.scaleFactor`。
  - 第一行 `import 'pixi.js/unsafe-eval'` 不動。
- **`src/overlay/canvas-input.ts`、`demo-square.ts`：**
  - 刪除 `demo-square.ts`，canvas-input 改成依每個畫出來的 actor 提供 hit area（hitbox × 大小、畫面位置、y 排序在後的優先）。
  - `pointer.ts` 與 `canvas:set-hover`、`canvas:context-menu` 通道保留。
- **main 端：**
  - 新的 overlay IPC：回傳某包某版本已驗證的 manifest 與各 spritesheet 的 JSON，或擴充 `packs:get-entry`。可沿用 `main/packs/manifest.ts` 的 `readInstalledManifest`。
  - 移除 main.ts 只認示範 session 的右鍵選單。
- **`src/main/windows/csp.ts`：** overlay（正式與開發）`img-src` 加 `pack:`，更新 `windows-csp.test.ts` 的整串比對。
- **`src/shared/pack-api/`：**
  - spritesheet JSON 的 schema（依 Decisions）。
  - 作者文件 `docs/pack-api-v1.md` 第 11 節：座標與像素、漏回、spritesheet 欄位改成定案。
- **`src/shared/constants.ts`：** `TICK_HZ` 與 `draw` 的上限。
- **測試：**
  - 單元測試：
    - world 的節拍、在途、暫停、事件、狀態對應、排列。
    - pack-host 的訊息組成與 `draw` 檢查。
    - bootstrap 的路由與回傳（假 port）。
    - renderer 的純函式。
    - IPC 與 CSP。
  - e2e（`test/e2e/`）：用契約測試包，斷言包收到 `init`／`frame`、回傳的 `draw` 被採用。可以用 overlay `body.dataset` 或 `renderer.extract` 讀像素。斷言不要依賴截圖，也不要依賴畫面像素的確切位置。
  - 刪除 `test/overlay/demo-square.test.ts`，改寫 `canvas-input.test.ts`。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/sandbox` 的開機順序、移除清單與 CSP；`src/main/pool/**`；`src/main/settings/**`（只讀 `characters` 區段）；`src/shared/pack-api` 既有的訊息與繪圖 schema（只新增 spritesheet schema）。

## Tasks & Acceptance

**Execution:**
- [x] `src/sandbox/worker-bootstrap.ts`：訊息路由、己方 actor、`draw` 回傳。
- [x] `src/overlay/pack-host`：`post()`、舞台訊息、在途、`draw` 檢查。
- [x] `src/overlay/world`、`src/overlay/renderer`、`overlay/main.ts`：節拍、排列、繪製、暫停、resolution；移除示範方塊。
- [x] main：manifest 與 spritesheet 的 IPC、overlay CSP `img-src pack:`、移除示範右鍵選單。
- [x] `src/shared`：常數、spritesheet schema；作者文件第 11 節。
- [x] 測試，涵蓋 I/O 矩陣，含 e2e。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過，既有斷言只因新通道、CSP、移除示範方塊而補值或刪除。
- Given push 到 main，when CI 跑完，then unit 與 e2e 在 macOS、Windows 都通過。

## Implementation Notes

- 2026-11-17 開發代理自行決定的部分：
  - **IPC：** 新通道 `packs:get-manifest`（只開給 overlay），參數 `[packId, version]`，回 `{ ok, packId, version, manifest, spritesheets: { <assetKey>: { image, data } } }`，或沿用 `packs:get-entry` 的失敗代碼（`not-installed`／`api-incompatible`／`read-failed`）。main 端是 `src/main/packs/overlay-manifest.ts` 的 `readPackManifest`：版本必須等於已安裝版本、再查一次 `apiVersion`、manifest 用 `readInstalledManifest`、每個 spritesheet 讀檔（容許 BOM）後用 `spritesheetSchema` 檢查，`meta.image`（相對於 JSON）必須在 `servedPaths` 裡；任何一個 spritesheet 不過就整包 `read-failed`，記一行帶包 id、版本與原因。不快取（同版本可覆蓋安裝）。`registerPackSandboxHandlers` 多第三個參數。
  - **spritesheet schema（`src/shared/pack-api/spritesheet.ts`）：** 用 `z.object`，不認得的欄位丟掉（TexturePacker 的 `pivot`、`anchor`、`meta.app` 等不會擋下整張表，也不會交給 PixiJS）；`frame` 矩形 x、y ≥ 0，w、h > 0；`meta.scale` 接受 `1` 與字串 `"1"`（TexturePacker 寫字串）或省略。另有 `spritesheetImagePath`、`spritesheetFitsImage`（旋轉的格佔 h × w）。格名稱上限 `SPRITESHEET_FRAME_NAME_MAX_LENGTH`（256）放在 pack-api，跟 `ACTOR_ID_MAX_LENGTH` 等 schema 上限同一處（pack-api 不能 import `constants`）。
  - **常數：** `TICK_HZ` 30、`DRAW_MAX_BYTES` 64 KiB、`DRAW_MAX_COMMANDS` 256（所有 actor 合計）；排列用 `STAGE_ROW_RIGHT_MARGIN` 24、`STAGE_ROW_BOTTOM_MARGIN` 96（沿用示範方塊避開工作列與 Dock 的值）、`STAGE_ROW_GAP` 16。
  - **Worker bootstrap：** 照 Code Map 用 `stageMessageSchema` 驗證，所以 zod 進了 Worker 的 bundle（未壓縮約多 200 KB；在 Electron 的 Node 模式實測 lockdown 後 zod 正常、console 0 行）。新增 `routeStageMessage`；己方 actor 的 Set 由 `run()` 持有，經 `boot` 的新選項 `ownActors` 交給 `createStage`。`frame` 沒有可送的 `draw`（沒有 handler、丟例外、讀 getter 丟例外、回傳值無法 clone）時改送新的回報 `sandbox.no-draw`（`seq`、`reason`），pack-host 據此清掉在途標記並記丟棄；否則在途標記永遠不清，那包再也收不到 `frame`（判定失敗是 3.9）。
  - **pack-host：** 新增 `overlay/looks.ts`：包有 actor 且已安裝、相容時，向 main 要那個版本的 manifest 與 spritesheet，每個版本要一次，換版本、移除或不相容時釋放；失敗記一行 `not-drawn`（`manifest-unavailable`），要等那包的 actor 都離場才會重要。沙盒就緒而且 look 到了才送 `init`。`draw` 只在 `seq` 等於在途那則時被接受（其他記 `stale-draw`），而且對照的是**那則 `frame` 的 actor**，不是現在的（`frame` 之後才離場的 actor 不會讓整則被丟）。在途時跳過的 tick 的事件累積到下一則 `frame`，不會遺失。沒有己方 actor 的包不送 `frame`（作者文件 8.3「對有 actor 的包送」），但 `despawn` 照送。新的丟棄原因：`too-many-commands`、`unknown-asset`、`unknown-frame`、`stale-draw` 與三個 no-draw 原因；新的 log 種類：`commands-skipped`（每個沙盒每種指令一行，所以最多兩行）、`not-drawn`（`character-missing`／`manifest-unavailable`／`asset-failed`）。spritesheet 的 sprite 沒給 `frame` 視為 `unknown-frame`。
  - **world：** 節拍排在 1000 / `TICK_HZ` 的格點上（不累積誤差）；晚到連下一格都已到期時，從那一刻重新起算，不補發。`t` 只在節拍進行時前進（暫停或沒有 actor 時停住，之後接著走）。最後一個 actor 離場後**再跳一格**才停，讓 `leave` 與 `despawn` 送得出去；暫停中離場的，恢復時補這一格。
  - **排列：** 第一個 actor 在最右邊，之後往左排，新 actor 不會讓已在場的移位；某個放不下時，它和後面的都不畫。actor 的本地原點放在 slot 左緣減 `bounds.x × 大小`。
  - **座標與像素：** sprite 用 PixiJS 的 anchor (0, 0)：`x`、`y` 是圖第 0 列第 0 行像素的外角，`scaleX`／`scaleY` 與 `rotation` 都以這一點為原點（負的 `scaleX` 往左翻）。已寫進作者文件 8.1。
  - **renderer：** `scene.ts`（純函式：放置、狀態對應、最後一則 draw、z 排序、y 排序、hit area；放置函式可注入，Epic 4 的遊走可沿用）、`textures.ts`（以 `packId@version` 分開的泛型素材庫，同版本同一個 PNG 只載一次；格超出圖的 spritesheet 視為失敗）、`pixi-stage.ts`（`Image` crossorigin 加上自己建的 `ImageSource`／`Texture`，spritesheet 只用 `new Spritesheet(...).parseSync()` 回傳的 textures，都不進全域快取；每個 actor 一個 Container，子層 Graphics 當 bounds 遮罩）。render loop 在有 actor 且沒暫停時才跑，停下前再畫一格；resolution 用 `renderer.resize(w, h, scaleFactor)`。body 的 data 屬性多了 `drawnActors`、`drawnSprites`、`resolution`（值改變時才寫），e2e 讀這些，不讀像素。
  - **hit area：** 只有畫出來的 actor 才有：已放置、狀態對應得到、該包最後一則 draw 有它（空陣列也算在場，只是沒有圖）。
  - **右鍵：** overlay 在角色上右鍵只 `preventDefault`，不送 `canvas:context-menu`（沒有選單，所以也不切回穿透）；main 仍註冊 `canvas:context-menu`，`openCanvasMenu(sessionKey, window)` 只記一行（只寫來源）、不開選單。`menu.ts` 刪掉 `demoCanvasMenuTemplate`、`DemoMenuTarget`、`DEMO_TURN_OFF_LABEL`。
  - **CSP 與 `pack://`：** overlay（正式與開發）`img-src` 加 `pack:`，`connect-src` 不變；`pack://` 不送 ACAO（`corsEnabled` 已足夠），`protocol.ts` 的註解改成定案。
- 既有斷言的改動：
  - 不屬於「新通道、CSP、移除示範方塊」的只有一處：`test/overlay/pack-host.test.ts` 的「訊息驗證」表格刪掉 `'a draw (Story 3.6)'` 那列。3.5 預期 `draw` 被當成 `invalid` 丟棄；現在 `draw` 改走 draw 的檢查，沒有在途 `frame` 時是 `stale-draw`，新行為在 `pack-host-draw.test.ts` 測。
  - 其餘：CSP 整串比對；`api.packs` 的 key 多 `getManifest`；示範右鍵選單的測試刪除或改寫（tray 的端到端測試改成只用系統匣）；`canvas-input.test.ts` 改寫、`demo-square.test.ts` 刪除；測試替身補上 `post()`、`characters`、`getManifest`、`registerPackSandboxHandlers` 的第三個參數。
  - 測試輔助：e2e 探針包的 `frame` 改回傳 `{}`（原本 `[]` 會被當成不合 schema 的 draw，一直記丟棄）；`sandbox-boot-check.cjs` 在開機後多送一則 `init` 與 `frame`（結果多 `replies`、`ownActors` 欄位）。
- 2026-11-17 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`（108 檔通過、1 檔跳過；5136 個測試通過、2 個跳過）、`npm run depcruise`（303 個模組、0 違規）、`npm run e2e`（12 個通過，含新的 `test/e2e/stage.spec.ts` 4 個）全過，e2e 跑了兩次都通過。突變實驗：拿掉在途判斷、拿掉 y 排序、拿掉 draw 的己方 actor 檢查，各自有測試失敗（已還原）。I/O 矩陣 21 列都有測試：單元測試在 `test/overlay/{world,stage-messages,pack-host-draw,scene,looks,canvas-input}.test.ts`、`test/sandbox/routing.test.ts`、`test/main/{packs-overlay-manifest,windows-tray}.test.ts`；e2e 涵蓋出現、隱私、換螢幕（resolution 等於 `scaleFactor`）、加入與移出。裁切只驗到 scene 帶出 `bounds`、pixi-stage 以它為遮罩（程式閱讀），沒有讀像素。

- 2026-11-17 主流程重跑：五項檢查全過（108 檔通過、1 檔跳過；5136 個測試通過、2 個跳過；depcruise 303 個模組、0 違規；`npm run e2e` 12 個全過）；`out/` 沒有被動到；I/O 矩陣 21 列都有測試且都跑過。diff 裡被刪的既有 `expect(` 共 72 行：`demo-square.test.ts` 整檔刪除（23）、`canvas-input.test.ts` 依示範方塊的案例改寫（22）、`windows-tray.test.ts` 畫布示範右鍵選單（22，選單列的「示範模式」子選單測試都還在）、`windows-main.test.ts`（3）與 `windows-csp`、`preload/overlay`（各 1，新通道與 CSP）；另有 `pack-host.test.ts`「訊息驗證」表格刪掉 draw 那一列（draw 改走 draw 的檢查）。開發代理中途有一次 `git rm --cached` 被 hook 擋下、沒有執行（違反「git 只能唯讀」的派工限制，已回報使用者）。

- 2026-11-17 依審查修補（協調者指出）：
  - **最後一個己方 actor 離場：** `composeTick` 送 `despawn` 後再送一則沒有 actor 的 `frame`，帶上累積的事件（含它的 `leave`）；在途時等那則回了再送。之後沒有己方 actor 時不送 `frame`、不累積事件；等待中的事件最多保留最新的 `FRAME_EVENTS_MAX`（256，新常數）。
  - **hit area：** 只給至少有一張 sprite 真的畫出來（貼圖已載入）的 actor；`buildScene` 多一個必填的 `ready` 判斷（main.ts 用 `textures.get`）。空陣列、貼圖載入中或失敗都沒有 hit area。
  - **render loop 上限：** `renderer/display.ts` 的 `capFrameRate` 把 ticker 的 `maxFPS` 設成 `TICK_HZ`；同一檔的 `followResolution` 是 `followView` 抽出的 resolution 步驟（`{ resolution, resize }`）。
  - **Worker bootstrap 先擋上限：** `jsonBytes`、`countDrawCommands` 移到 `src/shared/draw-size.ts`（overlay 的 `rules.ts`、`draw-rules.ts` 照舊 re-export）。bootstrap 在 post 之前量 draw，超過 `DRAW_MAX_BYTES`／`DRAW_MAX_COMMANDS` 就回 `sandbox.no-draw`（新原因 `draw-too-large`、`draw-too-many-commands`），量的時候 getter 丟錯算 `draw-not-cloneable`；overlay 的檢查保留為第二道。`frame` 不合 schema 但 `seq` 讀得到（非負整數）時回 `invalid-frame`。常數註解改正。
  - **右鍵：** overlay 在角色上右鍵改回送 `canvas:context-menu`（上面那隻的 session key），main 照舊只記一行、不開選單；不切回穿透。
  - **spritesheet：** `frame`、`spriteSourceSize`、`sourceSize` 的值必須是整數（`meta.size` 不變）。貼圖明定 `scaleMode: 'linear'`；作者文件 8.1 寫明線性取樣、相鄰格要留 1 像素透明間隔、矩形必須是整數。`pixi-stage.ts` 不再引用 DOM：`Image` 載入移到 main.ts，`pixiTextures(loadImage)` 與 `sheetTextures` 在 Node 下以真的 PixiJS 測試（`test/overlay/pixi-stage.test.ts`）。
  - **其他：** body 的 data 屬性多 `hitAreas`，e2e 斷言出現時 1、離場後 0；`character-missing` 的 log 改成兩種情況都適用的說法；作者文件 7 節的 `events[]` 改成「上一則 `frame` 之後的事件，含跳過的 tick」；補了被限速的 draw 仍清掉在途、spritesheet JSON 帶 BOM 的測試。

- 2026-11-17 審查修補後驗證（主流程重跑）：五項檢查全過（110 檔通過、1 檔跳過；5169 個測試通過、2 個跳過；depcruise 307 個模組、0 違規；`npm run e2e` 12 個全過）；`out/` 沒有被動到；被刪的既有 `expect(` 剩 68 行，來源同上一筆紀錄（右鍵改回送 `canvas:context-menu`，canvas-input 有幾條斷言恢復）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-17）：Blind Hunter 13 條（B1–B13）、Edge Case Hunter 7 條（E1–E7）、Verification Gap 5 個缺口（VG1–VG5）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B1 | 包的最後一個己方 actor 離場後不再送 `frame`，`leave` 卡在 `events` 裡，等下次有 actor 才跟著過時的 frame 送出；沒有 actor 時 `events` 無上限累積 | medium | patch | 已確認 `composeTick` 在沒有己方 actor 時不送 frame，測試把過時事件鎖住；違反矩陣「加入與移出」。最後一個離場時補送一則帶 `leave` 的 frame，`events` 有上限 |
| B3 | 空的 `draw`、素材還在載入或載入失敗的 actor 仍有 hit area，看不見卻接住滑鼠 | medium | patch | 已確認 `scene.ts` 對空清單也給 hit area，`pixi-stage.ts` 只把 sprite 設成不可見；使用者選了接住滑鼠，看不見的區域會擋住 Dock、工作列的點擊。只有至少畫出一個 sprite 的 actor 才有 hit area |
| B5 | render loop 沒有限速，有 actor 時以螢幕更新率每幀重算重畫 | medium | patch | 已確認沒有 `maxFPS`；常駐的桌寵會一直耗電。上限設成 `TICK_HZ`（draw 每秒最多變 30 次） |
| B6 | `DRAW_MAX_BYTES` 註解說「parse 前檢查」，但 draw 經 MessagePort 時 overlay 已整個反序列化，超大 draw 每 33 ms 都會拖住 overlay 主執行緒 | medium | patch | 已確認 structured clone 在 overlay 端完成；Worker bootstrap（lockdown 前的可信程式）先用同樣的上限檢查，超過回 `sandbox.no-draw`；overlay 的檢查保留當第二道，註解改正 |
| VG1、B9 | 「換螢幕」的 e2e 分辨不出 resolution 有沒有跟著改（啟動時 DPR 本來就等於 scaleFactor） | medium | patch | 驗證缺口已附證據；把解析度同步抽成可測函式，用假 renderer 單元測試 |
| VG2 | `drawFrame` 把 hit area 交給 canvas-input 的接線沒有測試 | medium | patch | 驗證缺口已附證據；body dataset 多寫 hit area 數，e2e 斷言 |
| VG3 | 被限速的 draw 仍要清掉在途標記，沒有測試 | medium | patch | 驗證缺口已附證據；清錯順序會讓包永久收不到 frame。補測試 |
| VG5 | `pixi-stage.ts` 把 scene 畫上畫面（裁切遮罩、大小、排序、spritesheet 的格）沒有任何測試 | medium | patch | 驗證缺口已附證據，審查者實測 pixi.js 在 node 下可建 Container、Sprite 與 `Spritesheet.parseSync`；補 `test/overlay/pixi-stage.test.ts` |
| VG4 | 帶 BOM 的 spritesheet JSON 在 `packs:get-manifest` 沒有測試 | low | patch | 驗證缺口已附證據；安裝時接受 BOM，載入時若不接受包就畫不出來；補測試 |
| B7 | 不合 schema 的 `frame` 被 Worker 靜默丟掉，在途標記永遠不清 | low | patch | 只有 overlay 組錯訊息才會發生；直接修正：讀得到 `seq` 時回 `sandbox.no-draw` |
| E4 | spritesheet 的格矩形接受小數，PixiJS 會取整，可能變成 0 大小或偏移 | low | patch | 直接修正：`x`、`y`、`w`、`h`（與 `sourceSize`、`spriteSourceSize`）改成整數 |
| E5 | overlay 在角色上右鍵不再送 `canvas:context-menu`，main 的處理與 log 變成死碼 | low | patch | 規格要保留通道；直接修正：右鍵照送，main 記一行「目前沒有選單」 |
| B4 | 材質取樣沒決定（PixiJS 預設 linear），spritesheet 相鄰格會滲色 | low | patch | 定案：linear；作者文件 8.1 寫明取樣方式與「格之間留至少 1 像素透明間隔」，程式明確設定 |
| B2 | 作者文件仍說 `events` 是「本 tick 的事件」，實際是「上一則 frame 之後的事件」 | low | patch | 直接修正文件 |
| B12 | `not-drawn`／`character-missing` 的 log 固定寫「舞台沒有值」，manifest 沒有該角色時會誤導 | low | patch | 直接修正成兩種情況都適用的說法 |
| B8 | `bitmap.image` 是 ImageBitmap 時，`jsonBytes` 回 null，整則 draw 被當成不合規丟掉 | low | defer | `stage.canvas` 目前是 null 碰不到；3.6 下段開放 bitmap 時要一併處理 |
| B10 | 排列只用整個螢幕加固定邊距，不看工作區；Dock 或工作列在側邊、上方時，角色與 hit area 會壓在上面 | medium | defer | StageView 的 canvas 沒有工作區資訊；記為已知限制，Epic 4 遊走與排列時一起處理 |
| E2 | 同版本覆蓋安裝後，overlay 的 manifest、素材快取、沙盒都還是舊的（以 `packId@version` 為 key） | medium | defer | 要在 index 加一個「安裝識別」才分得出來；3.9 的「包更新後重載」一併處理 |
| B11 | 包的 actor 全部離場後，材質要到 app 結束才釋放 | low | reject | 包數量少、素材小；閒置釋放要多一份計時與狀態 |
| B13 | 同一張 PNG 上傳 GPU 兩次；`meta.size` 沒和實際圖比對 | low | reject | 只影響少量記憶體；取整一致性由 E4 的整數格處理 |
| E1 | frame handler 永遠不回，在途標記不清 | low | reject | `drawTimeoutMs` 的判定是 3.9 的範圍；事件累積由 B1 加上限 |
| VO1、E3 | 包的 look 或角色值晚到時，後面的角色會先往右移一格再移回 | low | reject | 只在第一次出現或升級的瞬間（IPC 回來前）；預留位置要先知道 `bounds` 寬度，得等 look |
| E6 | 粒子與 bitmap 的略過 log 每次重建沙盒、每種指令各一行 | low | reject | 每包最多兩行，重建不常發生 |
| E7 | 刪掉「訊息驗證」表格的 draw 那一列，不在 AC 列的三個理由內 | false | reject | 已記在主流程驗證紀錄；draw 改走 draw 的檢查是本規格的行為 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：
  - 匯入契約測試包、打開示範模式與幾個 AI session：角色出現在畫面底部，依狀態變化。
  - 取消上場或釋放 session：角色消失。
  - 把畫布換到另一個螢幕：角色照常、不模糊。
