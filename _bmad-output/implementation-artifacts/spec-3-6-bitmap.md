---
title: 'Story 3.6（下之三）：bitmap 與 stage.canvas'
type: 'feature'
created: '2026-11-18'
status: 'done'
baseline_commit: '70c6d04a65b7ea136e4ffc00d41408e7eed33655'
route: 'dispatch'
review_loop_iteration: 2
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `advancedBitmap` 角色還沒有 `stage.canvas`（固定是 `null`），`bitmap` 指令被略過。真的 ImageBitmap 會讓 overlay 的位元組檢查回 null，整則 `draw` 被當成不合規丟掉。

**Approach:** bootstrap 依角色的 `advancedBitmap` 給 `stage.canvas`（只有 2d）。包畫好後用 `stage.snapshot` 取得 ImageBitmap，放進 `bitmap` 指令。Worker 以 transfer 傳給 overlay；overlay 檢查後，renderer 把它當貼圖畫在 actor 本地座標。這是 3.6 的最後一段。

**Decisions（2026-11-18，可行性小實驗與拆段時已定）：**
- **可行性：** 刪除清單與 `lockdown()` 之後，Worker 仍有 `OffscreenCanvas`，2d 可用。ImageBitmap 從 opaque origin 的 Worker transfer 到 overlay 後，PixiJS 8.22 以 `new ImageSource({ resource })` 上傳，顏色正確、沒有 SecurityError。256×256 一張約 1 ms。
- **只給 2d context：** 原始 ctx 的 `canvas` 拿得到 `OffscreenCanvas` 建構式，能開 webgl2。所以 bootstrap 在 `lockdown()` 前移除 `OffscreenCanvasRenderingContext2D.prototype` 的 `canvas` getter，自己保留 canvas 的參照。移除後若 `'canvas' in` 仍成立，或 Worker 沒有 `OffscreenCanvas`，`stage.canvas` 一律丟 `TypeError`，開機不受影響。
- **`stage.canvas(actorId, width, height)`：** 回傳該 actor 的 2d context。第一次呼叫時建立；尺寸不同就改尺寸，改尺寸會清空。以下情況丟 `TypeError`：不是己方 actor、角色沒有 `advancedBitmap`、寬高不是 1～`BITMAP_MAX_SIDE` 的整數。
- **`stage.snapshot(actorId)`：** 呼叫 `transferToImageBitmap()`，回傳 ImageBitmap，canvas 隨即清空，所以每一格都要整張重畫。沒呼叫過 `stage.canvas` 就丟 `TypeError`。同一個 actor 每格（收到下一則 `frame` 之前）只能呼叫一次，第二次丟 `TypeError`（2026-11-19 審查後追加）。actor 離場時，它的 canvas 一起釋放。
- **層次與滑鼠：** bitmap 畫在該 actor 的 sprite 之上、粒子之下。bitmap 貼圖已上傳的 actor 視同「有畫出來」，跟 sprite 一樣給 hit area；只有粒子的 actor 仍然沒有。

## Boundaries & Constraints

**Always:**
- **誰能用：** pack-host 在送 `init` 之前，用沙盒內部訊息（`sandbox.` 開頭，Compartment 看不到）把 `advancedBitmap` 的 characterId 清單交給 bootstrap。bootstrap 從 `init`、`spawn` 記住 actorId → characterId。overlay 依 manifest 再檢查一次。
- **送出：** bootstrap 送 `draw` 時，把裡面的 ImageBitmap 放進 transfer list（去重）。post 失敗（例如送已經 transfer 過的 bitmap）時，照既有做法回 `sandbox.no-draw`（`draw-not-cloneable`），不讓 Worker 掛掉。送出前，不重複的 ImageBitmap 張數比己方 actor 數多時不送，回 `sandbox.no-draw`（`draw-too-many-commands`）（2026-11-19 審查後追加）。
- **送出的是抄本（2026-11-19 第 2 輪審查後追加）：** bootstrap 把 `frame` 回傳的內容逐一讀過一次，抄成新的純資料：null、布林、有限數字、字串、陣列（只抄索引元素；有其他自有屬性就算抄不了）、原型是 `Object.prototype` 或 null 的物件的自有可列舉資料，以及 ImageBitmap（原物件放進抄本）。位元組、指令數、張數都用抄本計算，`jsonBytes` 仍是 Worker 與 overlay 共用的實作；送出的是抄本，transfer list 是抄本裡的圖。抄的過程超過 `DRAW_MAX_BYTES` 就停，回 `draw-too-large`；遇到抄不了的值（undefined、函式、Map、Set、typed array 等其他物件、讀取時丟例外），整則不送，回 `sandbox.no-draw`（`draw-not-cloneable`）。認 ImageBitmap 用 `lockdown()` 前保存的品牌檢查（例如 `ImageBitmap.prototype` 的 `width` getter），不用 `instanceof`，包改原型或 `Symbol.hasInstance` 都騙不過。
- **`stage.*` 呼叫（2026-11-19 第 2 輪審查後追加）：** `fire`、`hold`、`face` 等送到 overlay 的參數也用同一套規則抄成純資料；抄不了或含有 ImageBitmap，當場丟 `TypeError`，不送出。
- **位元組：** `jsonBytes` 把 ImageBitmap 當成 `{}`（2 bytes）計算，Worker 與 overlay 共用同一個實作，不再回 null。
- **overlay 檢查與丟棄原因：** 以下任一條不符合，整則丟棄並記一行帶 `packId`，該則所有 ImageBitmap 立刻 `close()`。
  - 角色沒有 `advancedBitmap`：`bitmap-not-allowed`。
  - `image` 不是 ImageBitmap：`bitmap-not-image`。
  - 寬或高大於 `BITMAP_MAX_SIDE`：`bitmap-too-large`。
  - 同一 actor 一則超過 1 張；同一張 ImageBitmap 出現在多條指令；或同一 actor 在 1 秒滑動視窗內超過 `BITMAP_MAX_PER_SECOND` 張：`too-many-bitmaps`。
  - 既有的檢查順序不變，這些放在逐指令檢查那一步。
- **釋放：**
  - 貼圖用 `new ImageSource({ resource, autoGarbageCollect: false })`，不進全域快取。
  - actor 的 bitmap 換成新的一張，畫上去之後，舊的貼圖銷毀、舊 ImageBitmap `close()`。actor 離場或不再畫 bitmap 時也一樣。
  - 顯示中的 ImageBitmap 不可以 `close()`。
  - 被接受、但還沒顯示就被下一則換掉的 bitmap 交給 GC。
  - 每張最多 `close()` 一次。
- **移除略過：** `bitmap` 是最後一種被略過的指令，`commands-skipped` 這種 log 與 `SKIPPED_DRAW_COMMANDS` 一起移除。
- **新常數** `BITMAP_MAX_SIDE` 512、`BITMAP_MAX_PER_SECOND` 36 只放 `src/shared/constants`。滑動視窗就是 1 秒，以 overlay 收到 draw 的時間計；36 比節拍的 30 多留給時間抖動（2026-11-19 審查後由 30 改 36）。

**Never:**
- 不給包原始的 OffscreenCanvas，不開放 webgl；逃逸測試的 webgl 仍必須失敗。不改 `src/sandbox/lists.ts`、作者文件第 10 節的移除清單、CSP 雜湊流程，也不改既有的開機失敗原因。
- 不改契約測試包（它沒有 `advancedBitmap`）。
- 不做佔位、名牌、心跳與失敗判定（3.7～3.9）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| bitmap 出現 | `advancedBitmap` 角色每格用 `stage.canvas` 畫、`stage.snapshot`、回傳 `bitmap` | 畫在本地座標 `x`、`y`，大小 `width`×`height` 基準像素，套「大小」與 `bounds` 裁切，在 sprite 之上 |
| transfer | Worker 送出含 bitmap 的 `draw` | 經 transfer 傳送，Worker 端的 ImageBitmap 變成 0×0 |
| 位元組 | 含 ImageBitmap 的 `draw` | 位元組檢查照常通過 |
| 沒宣告的角色 | 角色沒有 `advancedBitmap` | `stage.canvas` 丟 `TypeError`；硬塞 `bitmap` 指令，整則丟棄（`bitmap-not-allowed`） |
| 只允許 2d | 包從 context 找 canvas 或建構式，或試 webgl | `ctx.canvas` 是 `undefined`，拿不到 `OffscreenCanvas`，webgl 開不了 |
| 參數不對 | `stage.canvas` 給別包或不存在的 actor、尺寸 0 或超過 `BITMAP_MAX_SIDE`；沒 `canvas` 就 `snapshot` | 丟 `TypeError` |
| snapshot 次數 | 同一 actor 在同一格呼叫 `stage.snapshot` 兩次 | 第二次丟 `TypeError`；下一格可以再呼叫 |
| 一則藏很多張 | `draw` 裡不重複的 ImageBitmap 比己方 actor 多（例如藏在額外欄位） | Worker 不送，回 `sandbox.no-draw`（`draw-too-many-commands`）；下一格照常 |
| 藏圖的寫法 | 圖改過原型、掛在陣列的非索引屬性、用 getter 兩次讀取回傳不同的圖、放進改寫過走訪方式的 Map | 圖不會被複製送出：Worker 送的是抄本，改過原型的圖仍認得出來並以 transfer 送出；陣列有額外屬性、Map 等抄不了的，整則回 `draw-not-cloneable` |
| 非純資料的 draw | `draw` 裡有 undefined、Map 等 | Worker 不送，回 `sandbox.no-draw`（`draw-not-cloneable`）；下一格照常 |
| stage.* 帶圖 | `stage.fire`／`hold`／`face` 的參數含 ImageBitmap 或抄不了的值 | 當場丟 `TypeError`，沒有送出 |
| 不是 ImageBitmap | `image` 是一般物件 | 整則丟棄（`bitmap-not-image`） |
| 尺寸 | 送來的 ImageBitmap 寬或高超過 `BITMAP_MAX_SIDE` | 整則丟棄（`bitmap-too-large`），bitmap 被 `close()` |
| 張數 | 同一 actor 一則 2 張；同一張用在兩條指令；1 秒內超過 `BITMAP_MAX_PER_SECOND` 張 | 整則丟棄（`too-many-bitmaps`），bitmap 被 `close()` |
| 抖動 | 每格送一張，但舞台卡頓讓回覆擠在一起（例如第 1 則晚了約 2 個 tick 才處理，之後恢復正常） | 不被判 `too-many-bitmaps` |
| 重複送 | 包把上一格的 snapshot 再放進下一則 `draw` | 該則回 `sandbox.no-draw`（`draw-not-cloneable`），下一格照常 |
| 釋放 | 換新圖；actor 離場；改成不畫 bitmap | 新圖畫上去後舊的 `close()`；離場或不畫時 `close()`；顯示中的不 `close()` |
| context 還原 | bitmap 顯示中，WebGL context lost 再還原 | bitmap 照常顯示 |
| hit area | 只有 bitmap 的 actor | 貼圖上傳後有 hit area（範圍照舊是 `hitbox` × 大小）；只有粒子的照舊沒有 |
| 沒有 OffscreenCanvas | Node 下的開機檢查 | 開機照常，`stage.canvas` 丟 `TypeError` |

</frozen-after-approval>

## Code Map

- **`src/sandbox/worker-bootstrap.ts`：**
  - `boot()`：刪 API（`:383`）、刪 intrinsics（`:384-386`）、lockdown（`:403-411`）。移除 `canvas` getter 放在 `:386` 到 `:397` 之間，是獨立的一步；不併進 `removals`（`:387`），`build.test.ts` 的 `REMOVAL_NAMES` 不變。
  - `createStage`（`:268-311`；`harden` 在 `:281`、`canvas: null` 在 `:296`）：改成 `canvas(actorId, w, h)`，新增 `snapshot(actorId)`。`ownActors` 目前只是 actorId 的 Set（`:271`、`:645`、`:286`），要改成也帶 characterId（init、spawn 在 `:504-514` 更新，despawn 在 `:533`）。
  - port listener（`:659-685`）在 `routeStageMessage`（`:678`）之前攔下 `sandbox.` 開頭的內部訊息。
  - `routeStageMessage` 的位元組檢查在 `:558`、`:565`；`reply(draw)` 在 `:574`、`first.postMessage(reply)` 在 `:679-681`，在這裡加 transfer list 與 try/catch。`WorkerPort.postMessage`（`:449`）的型別要放寬，加上 transfer。
  - 檔案必須保持 ASCII（`:47`），因為 CSP 雜湊。
- **`src/shared/sandbox.ts`：**
  - 新的「pack-host → Worker」內部訊息 schema 放在 `port`（`:56-59`）旁邊，比照 `isPortMessage` 用完全相符的鍵判斷。
  - 丟棄原因 `PACK_MESSAGE_DROP_REASONS`（`:280-293`）加 4 個新原因。
  - 刪除 `SKIPPED_DRAW_COMMANDS`（`:302`）與 `commands-skipped` 的 log schema（`:377-381`）。用到的地方都要一起改：`src/main/packs/sandbox-log.ts:102`、`test/shared/sandbox.test.ts:357-402`、`test/main/packs-overlay-manifest.test.ts:253`、`test/overlay/pack-host-draw.test.ts:807`。
- **`src/shared/draw-size.ts`：** `jsonBytes`（`:43-89`）在 `:68` 的原型檢查之前，`typeof ImageBitmap !== 'undefined' && item instanceof ImageBitmap` 時算 2 bytes。這個檔不能 import 任何東西。
- **`src/overlay/pack-host/`：**
  - `host.ts`：`tick()` 在 `!sandbox.stage.inited` 時、送 `init` 之前（`:688` 前，`look` 在 `:684`）先送內部訊息。`post()` 在 `:612-626`；`SandboxFrame.post`（`:127`、`dom.ts:151-155`）的型別要放寬。
  - 收 draw 的路徑：`dom.ts:143-147` → `onMessage`（`:594`）→ `receive`（`:494`）→ `receiveDraw`（`:458-492`）。以下每個出口都要 `close()` 該則的 ImageBitmap：`:495-497`、rate-limited `:465-468`、stale `:470-479`、檢查失敗 `:480-484`、`dom.ts:144` 移除後收到的。拿掉 `:485-490` 的略過紀錄。每秒張數的滑動視窗放在這裡（每包、每 actor，時間可注入）。
  - `draw-rules.ts`：`checkDraw`（`:99`）在逐指令那一步（`:130-133` 原本的略過分支）加上 bitmap 的檢查；`DrawCheckLook`（`:73-77`）加角色的 `advancedBitmap`；`DrawnCommand`（`:54`）加 bitmap。actor 對應 characterId 從 `stage.actors`（`stage-messages.ts:59`）取，`inFlight`（`:67-70`）只有 actorId。
  - `looks.ts:34` 的 `character(id)` 讀得到 `advancedBitmap`。
- **`src/overlay/renderer/`：**
  - `scene.ts`：`SceneActor`（`:74-91`）加 `bitmap`；hit area（`:275-280`）把「bitmap 貼圖已上傳」算成有畫出來（ready 判斷要能問 bitmap）。
  - `pixi-stage.ts`：`ActorNode`（`:362-370`）加 bitmap 用的 `Sprite`，插在 sprite 之後、粒子之前（sprite 在 `:483-488` 插入，粒子在 `:445`）。貼圖照 `:105-112`、`:276-282` 建。actor 容器在 `:517`、`:541` destroy 時不會一起 destroy 貼圖，bitmap 貼圖要自己處理。`StageCounts`（`:373-376`）加 `bitmaps`。
  - `main.ts`：data 屬性加 `drawnBitmaps`（`show()` 在 `:179-182`，寫入在 `:222-231`）。`context-loss.ts` 的 `halt()`（`:200-206`）一起歸零。
- **`src/shared/constants.ts`：** 新常數放在 `PARTICLE_*`（`:318-332`）旁邊。
- **作者文件 `docs/pack-api-v1.md`：**
  - 8.1 的 `bitmap`（`:436-442`）：上限、每格要整張重畫、層次。
  - 刪掉 `:466-468` 裡「還不畫 bitmap」那些句子。
  - 8.2 的 `stage.canvas`（`:486`）改成定案，加上 `stage.snapshot`，寫明 `ctx.canvas` 是 `undefined`、沒有 webgl。
  - 第 11 節刪掉 bitmap 上限那項（`:583`）。
- **測試：**
  - `test/sandbox/sandbox.test.ts:581-589`：stage 鍵順序與 `canvas` 的斷言跟著改。
  - Node 下沒有 OffscreenCanvas 或 ImageBitmap，要注入替身（或用全域替身）測 `canvas`／`snapshot`、transfer list、內部訊息、post 失敗。
  - `test/helpers/sandbox-boot-check.cjs`（由 `build.test.ts:113-139` 執行）要斷言：沒有 OffscreenCanvas 時開機照常，`stage.canvas` 丟 `TypeError`。
  - 單元測試還要涵蓋 draw 檢查（4 個新原因、close）、每秒滑動視窗、`jsonBytes`、scene 的 hit area，以及 pixi-stage 在 Node 下以真的 PixiJS 換貼圖與 destroy。
  - e2e：新增 `test/e2e/bitmap.spec.ts`，用自己的探針包。做法照 `helpers.ts` 的 `writeProbePack`（約 `:362-378`）：`contractManifest()` 改 id，其中一個角色設 `advancedBitmap: true`，entry 自己寫。斷言以下幾件事：
    - bitmap 畫出來（`drawnBitmaps`），Worker 端變成 0×0。
    - `ctx.canvas` 是 `undefined`，從 ctx 拿不到 `OffscreenCanvas`，webgl 打不開（結果用 `stage.log` 寫回 run log）。
    - 沒宣告的角色呼叫 `stage.canvas` 會丟 `TypeError`。
    - 換圖後 bitmap 還在畫。
    - 不截圖、不讀像素。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

- **審查修補（第 1 輪，2026-11-19）：**
  - 每秒上限（G3）：`constants.ts:349` 改成 36，註解改寫（比節拍多留給抖動）。`draw-rules.ts:243-249` 的 `BITMAP_WINDOW_MS` 改成 1000，註解跟著改；`host.ts:56`、`sandbox.ts:307` 提到上限的註解一起看。`pack-host-draw.test.ts:1122`、`:1316` 等跟著改，並補「抖動」列的測試。
  - 一則藏很多張（G2）：`worker-bootstrap.ts` 的 `routeStageMessage`，在 `jsonBytes(draw, …, bitmaps)`（`:781`）之後，`new Set(bitmaps).size > ownActors.size` 就回 `sandbox.no-draw`（`draw-too-many-commands`），不 post。
  - snapshot 次數（G7）：`createStage` 的 `snapshot`（`:432`）每個 actor 每格只准一次。計數在 `routeStageMessage` 收到 `frame`、呼叫 handler 之前歸零；計數可以放在 `OwnActor` 上，`init`、`spawn`、`despawn` 時跟著清。第二次丟 `TypeError`。
  - 非 draw 訊息（G1）：`host.ts` `receive()` 的 rate-limited（`:543`）與 `checkPackMessage` 不通過（`:546` 起）兩個出口，先 `closeBitmaps(data)` 再丟棄。
  - context 還原（G4）：`test/e2e/bitmap.spec.ts` 加一次 WebGL context lose／restore（照 `test/e2e/stability.spec.ts` 既有做法），斷言還原後 `drawnBitmaps`、`hitAreas` 回到 1，期間 overlay 沒有錯誤 log。
  - 作者文件（G5）：
    - 8.1：每秒上限改成 36（比節拍多留給抖動，每格送一張碰不到）；「顯示多久」補上包的沙盒被銷毀或失敗；補解析度：`width`／`height` 是基準像素，舞台會再乘「大小」與螢幕縮放並線性放大，要清楚就把畫布開大。
    - 8.2：改尺寸也會把 2d 狀態（transform、fillStyle、font 等）重設；context 與它回傳的物件（DOMMatrix、ImageData、漸層等）是瀏覽器的宿主物件；`stage.snapshot` 每格每 actor 一次；不重複的圖比己方 actor 多時，那格不送出。
    - 第 10 節仍不改。
  - 換圖寬高（G6）：`pixi-stage.test.ts:728` 的換圖測試，第二張圖改成不同像素尺寸、指令寬高也不同，斷言 `sprite.width`／`height` 與 `scale`。
  - 斷言放寬（G8）：`pack-host-draw.test.ts:456-459` 對 `sandbox.bitmap-characters` 改成檢查完整形狀：只有 `type` 與字串陣列 `characterIds`。

- **審查修補（第 2 輪，2026-11-19）：**
  - Worker 送抄本（R2-G1）：`worker-bootstrap.ts` `routeStageMessage`（`:802-840`）改成先抄再算。新寫一個「抄成純資料」的函式，放在 `worker-bootstrap.ts`，或不 import 任何東西的 `src/shared/draw-size.ts`；它邊抄邊收集 ImageBitmap、邊估大小，超過 `DRAW_MAX_BYTES` 就停。之後對抄本跑 `jsonBytes`、`countDrawCommands` 與張數檢查，`reply(抄本, 去重後的圖)`。第 1 輪為非純資料加的 `imageBitmapsIn` 分支拿掉。
  - 品牌檢查：在 `boot()` 移除清單之後、`lockdown()` 之前（與 `canvasMakerOf` 同一處），從 `scope.ImageBitmap.prototype` 取 `width` 的 getter 保存，用 `Reflect.apply` 判斷是不是真的 ImageBitmap；沒有 ImageBitmap 時沒有圖可認。`test/helpers/fake-bitmaps.ts` 的 `FakeImageBitmap` 要能做品牌檢查（例如用 private field 的 getter），既有測試跟著用。
  - `stage.*` 參數（R2-G2）：`createStage` 的 `send`（`:385`）送出前用同一個抄寫函式（不收圖），抄不了或含圖就丟 `TypeError`。`run()` 的 outbox（`:955-958`、`:1027`）改送抄本。`stage.log` 已經轉成文字，不受影響。
  - R2-G5：
    - `constants.ts` 的 `BITMAP_MAX_PER_SECOND` 寫成 `TICK_HZ + 6`。註解寫明：同時只有一則 `frame` 在途、world 不補發 tick，任一秒最多約 32 則回覆；之後若改成排隊送 `frame`，這個上限要重算。
    - 作者文件 8.1「解析度」改成不依賴倍率的建議：包拿不到「大小」與螢幕縮放，想在高解析度螢幕上清楚，就把畫布開成 `width`、`height` 的 2 倍（不超過 512）。8.1 那句「undefined 會跟著訊息送到舞台」改成 Worker 不送（`draw-not-cloneable`）。8.2 補上 `stage.*` 參數帶圖或非純資料會丟 `TypeError`。
    - `test/e2e/helpers.ts:549` 的 `restoreOverlayContext` 找不到 extension 就丟錯；`test/e2e/bitmap.spec.ts:651` 的 reload 計數改成比較前後差值。
    - 單元測試：`transferToImageBitmap` 丟例外時不算一次 snapshot。
    - `host.ts:64` 的註解重排成 80 字元內。
  - e2e（真的 Worker）：探針包在固定格數做一次性動作，結果用 `stage.log` 寫回 run log。
    - 同一格第二次 `stage.snapshot` 丟 `TypeError`。
    - `stage.fire` 的參數帶圖丟 `TypeError`。
    - 用 getter 回傳圖的 bitmap 指令照常畫出，Worker 端那張變成 0×0。
    - 改過原型的圖照常畫出，Worker 端變成 0×0。
    - 新增的動作不能讓既有斷言的丟棄行數改變；會改變的話，跟著調整預期並說明。

**不要改：** `src/sandbox/lists.ts`、作者文件第 10 節；CSP 雜湊流程（`scripts/sandbox-plugin.ts:120-135`、`document.ts:92`）；開機順序（只多一步移除 getter）與 `SANDBOX_BOOT_FAILURES`；`checkDraw` 1～5 步的順序；`receiveDraw` 先 rate、再 stale、再 check 的順序；iframe 只收一次 `load`；`main.ts` 的 `preferCreateImageBitmap: false`；契約測試包；`src/main/**`（只有 `sandbox-log.ts` 因為移除 `commands-skipped` 而改）。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/constants.ts`、`draw-size.ts`、`sandbox.ts` -- 常數、ImageBitmap 的位元組計算、內部訊息、新丟棄原因、移除 `commands-skipped` -- 兩端都依賴這些
- [x] `src/sandbox/worker-bootstrap.ts` -- 移除 `canvas` getter、`stage.canvas`／`snapshot`、內部訊息分流、transfer 與 post 失敗 -- 包端畫 bitmap
- [x] `src/overlay/pack-host/`、`src/main/packs/sandbox-log.ts` -- 送 `advancedBitmap` 清單、bitmap 檢查、每秒視窗、丟棄時 close、拿掉略過紀錄 -- 擋下不合規的
- [x] `src/overlay/renderer/`、`main.ts`、`context-loss.ts` -- bitmap 貼圖、釋放、hit area、data 屬性 -- 畫出來
- [x] `docs/pack-api-v1.md` -- 8.1、8.2、第 11 節定案 -- 作者文件與實作一致
- [x] 測試 -- 涵蓋 I/O 矩陣，含 e2e
- [x] 審查修補第 1 輪 -- 見 Code Map「審查修補（第 1 輪）」-- 修掉 Review Triage Log 的 G1～G8，並涵蓋矩陣新增的三列
- [x] 審查修補第 2 輪 -- 見 Code Map「審查修補（第 2 輪）」-- Worker 送抄本、`stage.*` 參數抄本、R2-G5 的小修補，並涵蓋矩陣新增的三列

**Acceptance Criteria:**
- Given 這段完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過；既有斷言只因 stage 鍵、`commands-skipped` 移除、新丟棄原因，以及 Spec Change Log 記錄的規則變更而改動。
- Given 沙盒安全測試，when 跑 e2e，then 既有的逃逸嘗試全部仍失敗，Worker 從開機到 `lockdown()` 結束的 console 仍是 0 行。
- Given push 到 main，when CI 跑完，then unit 與 e2e 在 macOS、Windows 都通過。

## Implementation Notes

- 2026-11-18 交接（主流程記錄）：第一個開發代理撞到用量上限中斷，停在「pixi-stage 用真的 PixiJS 的測試」。已完成的部分留在工作區，**沒有驗證、沒有跑過全套測試**，接手者以 `git diff 70c6d04` 加未追蹤檔為準接著做，不要從頭重寫。
  - 中斷時的工作區：`src/` 底下 Code Map 列的檔案大多已改（shared、worker-bootstrap、pack-host、renderer、main、context-loss、`src/main/packs/sandbox-log.ts`），也新增了 `test/helpers/fake-bitmaps.ts`，並改了 sandbox、pack-host、scene、pixi-stage 等測試。
  - 還沒碰的：`docs/pack-api-v1.md`（8.1、8.2、第 11 節）、`test/e2e/bitmap.spec.ts` 與它的探針包、`jsonBytes` 的 ImageBitmap 測試（`test/shared/` 底下沒有改動）。
  - 接手時先跑 typecheck 和改到的測試檔，確認現況再繼續。
- 2026-11-18 第二次接手（主流程記錄）：照省 token 規則，`context:` 拿掉 `spec-3-6-particles.md`（用得到的位置已在 Code Map）。接手分兩個開發代理依序做：
  - 第一棒：驗證既有實作（typecheck、改到的測試檔），補完 pixi-stage 用真 PixiJS 的測試與 `jsonBytes` 的 ImageBitmap 測試，單元測試補齊 I/O 矩陣。
  - 第二棒：作者文件、`test/e2e/bitmap.spec.ts` 與探針包，最後跑一次全套驗證。
- 本機驗證（2026-11-19，第 3 輪修補後）：typecheck、lint、depcruise 通過；`CI=true npm test` 5434 通過、2 略過；`npm run e2e` 32 通過。
- CI：commit `2c03120`（2026-11-24）後，GitHub Actions 的 unit（check）與 e2e 在 macOS、Windows 都通過（run 45310579583）。

## Spec Change Log

- 2026-11-19 第 2 輪審查（review_loop_iteration 2）：
  - 觸發的發現：第 2 輪 B1、B2、E1～E4、E8、V2（Worker 數圖的方式跟 structured clone 看到的不一樣，圖會被藏起來、整張複製送出、可一直重送）；B3、V1（`stage.*` 參數帶圖）。
  - 改了什麼（使用者 2026-11-19 選「Worker 抄一份再送」）：Boundaries 加「送出的是抄本」「`stage.*` 呼叫」兩條；I/O 矩陣加「藏圖的寫法」「非純資料的 draw」「stage.* 帶圖」三列；Code Map 加「審查修補（第 2 輪）」；AC 允許因規則變更而改的斷言。
  - 使用者也決定：張數上限維持數所有己方 actor（R2-G3 不改）；囤積 snapshot 先不管（R2-G4 記 deferred-work）。
  - 避免的已知壞狀態：Worker 的張數檢查與送出內容不一致，惡意包能把大量圖整張複製給舞台。
  - KEEP：第 1 輪的 KEEP 全部延續；張數上限的數法、每格一次 snapshot、36 張／1 秒視窗、非 draw 訊息丟棄時 close 都不動。

- 2026-11-19 第 1 輪審查（review_loop_iteration 1）：
  - 觸發的發現：V2、E3、B4（每秒上限的時間視窗在舞台卡頓後會誤丟合法包）；B2（一則 draw 可藏數百張圖）；E5（snapshot 每格沒有上限）。
  - 改了什麼（使用者 2026-11-19 同意修改 frozen 段）：`BITMAP_MAX_PER_SECOND` 30 改 36，視窗就是 1 秒；Boundaries「送出」加 Worker 端張數檢查；Decisions 的 `stage.snapshot` 加每格一次；I/O 矩陣加「snapshot 次數」「一則藏很多張」「抖動」三列；Code Map 加「審查修補（第 1 輪）」。
  - 避免的已知壞狀態：每格送一張的合法包在舞台卡頓後被判 `too-many-bitmaps`，整則丟棄並計入失敗條件；舞台主執行緒被一則數百張圖拖慢；包在 Worker 裡無限 snapshot。
  - KEEP（使用者選擇保留現有程式，不 revert）：既有實作與測試全部保留，只改上面幾點與 Triage Log 的 patch。transfer 去重、`canvas` getter 在 `lockdown()` 前移除、各丟棄出口 close、bitmap 層次與 hit area 的做法都不動。

## Review Triage Log

第 1 輪（2026-11-19，Blind Hunter = B、Verification Gap = V、Edge Case Hunter = E）。G 是共同根因的群組。

| # | 發現 | 判定 | 證據 | 歸類 |
|---|---|---|---|---|
| B1 | `host.ts` `receive()` 非 draw 訊息的出口不 close ImageBitmap | medium | 包把 snapshot 當 `stage.fire`／`hold` 的參數，bootstrap 以 structured clone 送出；`receive()` 的 rate-limited 與 checkPackMessage 失敗兩個出口沒呼叫 `closeBitmaps`，只能等 GC | G1 patch |
| V3 | 同 B1 | medium | 同 B1；`host.ts` 模組註解說不保留的訊息都會 close | G1 patch |
| E1 | 同 B1 | medium | 同 B1 | G1 patch |
| B2 | 一則訊息能帶的 ImageBitmap 張數沒有上限 | medium | `jsonBytes` 每張算 2 bytes，`countDrawCommands` 只數指令；藏在指令的額外欄位可一次 transfer 數百張，overlay 主執行緒逐張反序列化再 close。張數只受 Worker 產生 snapshot 的速度限制 | G2 intent_gap |
| B3 | 被接受但還沒顯示就被換掉的圖交給 GC，頻率不低 | low | 屬實（render 與 tick 都約 30 Hz、不同步），但 frozen Boundaries 明定交給 GC；V8 把 ImageBitmap 算進外部記憶體，會催 GC | reject（intent 明定） |
| E2 | 同 B3 | low | 同 B3 | reject（intent 明定） |
| B4 | 每秒張數視窗不是 1 秒，文件與常數註解沒跟著改 | medium | `BITMAP_WINDOW_MS = 1000 - TICK_MS`（約 966.7 ms），與 spec、`constants.ts`、作者文件的「1 秒」不符 | G3 intent_gap |
| V2 | 視窗餘裕不夠，每格送一張的合法包會被丟 | medium | `world.ts:140`：tick 晚到不滿一個週期不重設網格，下一個 tick 緊接著觸發；主執行緒卡超過一個 tick 時回覆擠在一起，30 個回覆的間距小於 966.7 ms，第 31 張被判 `too-many-bitmaps`，整則丟棄且計入失敗條件 | G3 intent_gap |
| E3 | 同 V2 | medium | 同 V2 | G3 intent_gap |
| B5 | I/O 矩陣「context 還原」沒真的測到 | medium | `pixi-stage.test.ts:829` 只把同一 scene draw 兩次，中間沒有 context lost；e2e 也沒有 lose／restore | G4 patch |
| B6 | 原始 2d context 帶出宿主物件，與第 10 節「宿主 API 一律沒有」不符 | low | 屬實：`getTransform()` → DOMMatrix → `toFloat32Array()` 等可取得宿主物件與 Float32Array。但 frozen Intent 明定給原始 2d context、只拿掉 `canvas` getter。`Symbol.hasInstance` 那段不成立：改寫只影響包自己的 draw（誤判為圖的物件 transfer 失敗回 no-draw，或被 overlay 以 `invalid` 丟棄），沒有越權。第 10 節依 spec 不改，改在 8.2 註明 | G5 patch（文件） |
| B7 | 文件沒寫改尺寸會重設 2d 狀態 | low | HTML 規範：設定 canvas 的 width／height 會把 context 重設為預設狀態（transform、fillStyle、font 等） | G5 patch（文件） |
| B8 | 同一 actorId 再 spawn 時釋放畫布沒有測試 | low | `composeTick` 只對新 actor 送 `spawn`，實際走不到 | reject |
| B9 | e2e 的釋放與 hit area 只看計數器 | low | pixi-stage 單元測試已用真 PixiJS 驗 destroy／close；e2e 要驗得新增 data 屬性（新介面） | reject |
| B10 | 作者文件缺指引（解析度、降級、沙盒銷毀、範例） | low | 解析度：圖會再乘「大小」與螢幕 scaleFactor 線性放大，作者會遇到模糊；「顯示多久」漏了沙盒銷毀／失敗。降級：Electron 的 Worker 一定有 OffscreenCanvas，作者遇不到；範例不是缺陷 | G5 patch（只補解析度與沙盒銷毀） |
| V1 | 換成像素尺寸不同的圖後，畫出的寬高沒有測試 | medium | 預先驗證的缺口：`pixi-stage.test.ts:728` 兩張都是 8×8、指令寬高不變 | G6 patch |
| E4 | draw 的 getter 每次回傳不同的圖，第二張被 clone 而非 transfer | low | 屬實，但只影響包自己（多一次複製），overlay 照常檢查與限速；修法要先整份複製 draw | reject |
| E5 | `stage.snapshot` 每格次數沒有上限 | medium | 屬實：包可反覆 snapshot 不送出，ImageBitmap 佔 Worker 外部記憶體。同類的記憶體濫用（包自己配置大量陣列）原本就沒上限，這是新管道 | G7 intent_gap |
| E6 | AC 列舉以外的斷言改動；假 frame 的 post 檢查放寬 | low | 屬實：`pack-host-draw.test.ts:456-459` 對 `sandbox.bitmap-characters` 只看 type。其他改動（`StageCounts.bitmaps`、`drawnBitmaps`、Set → Map）都是 spec 要求的變更帶來的 | G8 patch |

**狀態：** G2、G3、G7 屬 intent_gap，使用者 2026-11-19 決定：G3 上限改 36、視窗 1 秒；G2、G7 兩個都擋；保留程式不 revert（見 Spec Change Log）。G1、G4、G5、G6、G8 照 patch 處理。E5 擋下之後，跨格囤圖的部分記進 deferred-work。

第 2 輪（2026-11-19，只審第 1 輪修補的 diff；R2- 開頭的 G 是本輪群組）。

| # | 發現 | 判定 | 證據 | 歸類 |
|---|---|---|---|---|
| B1 | `bytes === null` 的 draw 照樣送出：不檢查位元組；繼承 Map 改寫走訪方式可藏圖 | high | 屬實：非純資料的 draw 不經位元組檢查就 clone（這部分是原本就有的）；`imageBitmapsIn` 照 Map 的走訪方式找圖，structured clone 照內部資料複製，看到的不一樣 | R2-G1 intent_gap |
| B2 | 改掉圖的原型，Worker 認不出，張數與 transfer 都被繞過 | high | 屬實：`isImageBitmap` 用 `instanceof`，snapshot 回傳的圖沒 harden；`Object.setPrototypeOf` 後 `jsonBytes` 當成 `{}`，postMessage 仍依內部 slot 複製整張圖，包手上的不會變 0×0，可每格重送、囤積後一次塞進一則 | R2-G1 intent_gap |
| E1 | 圖掛在陣列的非索引屬性上沒被數到 | high | 屬實：`jsonBytes` 只走陣列索引，structured clone 會帶上陣列自己的可列舉屬性 | R2-G1 intent_gap |
| E2 | getter 兩次讀取回傳不同的圖 | high | 屬實：數圖讀一次、postMessage 再讀一次，第二次的圖沒被數到、被 clone | R2-G1 intent_gap |
| E3 | 同 B2 | high | 同 B2 | R2-G1 intent_gap |
| E4 | Map／Set 改寫走訪方式藏圖 | high | 同 B1 後半 | R2-G1 intent_gap |
| E8 | 繞過的圖是 clone 不是 transfer（與 Intent 不符） | high | 同 B2、E1、E2 的結果 | R2-G1 intent_gap |
| V2 | 同 B2、E2 | high | 同上；`routing.test.ts` 兩則「一則藏很多張」都只用配合的輸入 | R2-G1 intent_gap |
| B3 | `stage.*` 呼叫帶圖，Worker 沒擋 | medium | 屬實：`send` → `deliver` 直接 postMessage（structured clone），overlay 反序列化後才丟棄；包手上的原圖不變，可每秒最多 120 次重送 | R2-G2 intent_gap |
| V1 | 同 B3（缺 Worker 端斷言） | medium | 同 B3 | R2-G2 intent_gap |
| B4 | 張數上限用所有己方 actor 數，太寬 | low | 屬實：只有 `advancedBitmap` 角色能畫，5 個 actor 只有 1 個能畫時一則仍可送 5 張；但 frozen 文字寫「己方 actor 數」 | R2-G3 intent_gap |
| B8 | 囤積 snapshot 延後處理的理由不成立 | medium | 屬實：ImageBitmap 的像素不在 JS heap，之後若加 heap 類上限也算不到它；可在 snapshot 時限制每個 actor 還沒送出的張數 | R2-G4 intent_gap |
| E5 | 同 B8，建議 snapshot 時 close 上一張 | medium | 同 B8 | R2-G4 intent_gap |
| B5 | 張數超過時借用 `draw-too-many-commands`，名稱誤導 | low | 屬實，但這是使用者 2026-11-19 選的（不新增原因） | reject（intent 明定） |
| B6 | `BITMAP_MAX_PER_SECOND = 36` 寫死、註解沒寫上界推導 | low | 屬實：可寫成 `TICK_HZ + 6`（同在 `constants.ts`），註解寫明任一秒最多約 32 則回覆、依賴「同時只有一則 frame 在途」 | R2-G5 patch |
| B7 | 文件「解析度」建議包做不到 | low | 屬實：5.1 寫明「大小」不會傳給包，訊息也沒有螢幕縮放；改成不依賴倍率的固定建議 | R2-G5 patch |
| B9 | e2e 工具只搬一半；`restoreOverlayContext` 失敗時沒有錯誤 | low | 屬實：`helpers.ts:549` 用 `?.` 靜默略過，只會逾時；重複的比對字串是重複程式，沒有具體壞處 | R2-G5 patch（只改丟錯） |
| E7 | 同 B9 的 `restoreOverlayContext` | low | 同 B9 | R2-G5 patch |
| E6 | e2e「context 還原」的 reload 計數沒有基準值 | low | 屬實：`bitmap.spec.ts:651` 直接斷言 0，同一次執行先前若有 reload 會誤判；改成比較前後差值 | R2-G5 patch |
| B10 | 缺測試：snapshot 讀取失敗不算一次；新規則沒在真的 Worker 驗過 | low | 屬實：程式是對的但沒測試；真 Worker 的驗證併入 R2-G1 | R2-G5 patch |
| B11 | `host.ts:64` 註解一行 100 字元 | low | 屬實，直接重排 | R2-G5 patch |
| V3 | deferred-work 舊條目仍寫 30 張 | low | 屬實，但那是拆段時的歷史紀錄，流程規定不改既有條目 | reject |
| E9 | 同一 actorId 重新 spawn 會重設 snapshot 次數 | low | `composeTick` 只對新 actor 送 `spawn`，實際走不到 | reject |

**狀態：** 使用者 2026-11-19 決定：R2-G1、R2-G2 照「Worker 抄一份再送」修；R2-G3 維持數所有己方 actor（reject）；R2-G4 先不管（defer）。R2-G5 照 patch 處理。見 Spec Change Log。

第 3 輪（2026-11-19，只審第 2 輪修補的 diff；R3- 開頭的 G 是本輪群組）。

| # | 發現 | 判定 | 證據 | 歸類 |
|---|---|---|---|---|
| B1 | 「每個 getter 只執行一次」對共用的子物件不成立 | low | 屬實（審查者實測）：同一物件從兩條路徑被引用會重讀；但送出的仍是抄本，數到的就是送出的，只有文件與註解說得太滿 | R3-G3 patch（文件） |
| B2 | `stage.*` 的大小上限數 UTF-16 長度，不是 UTF-8 位元組 | medium | 屬實（實測）：`copyPlain` 用 `length` 計數，`stage.*` 路徑沒有第二道 `jsonBytes`；非 ASCII 參數超過 64 KiB 仍會送出，再由 overlay 判 `too-large`，與文件 8.2 不符 | R3-G1 patch |
| E1 | 同 B2 | medium | 同 B2 | R3-G1 patch |
| V3 | 同 B2 | medium | 同 B2；`sandbox.test.ts:988` 只用 ASCII | R3-G1 patch |
| B3 | 對抄本多走一次 `jsonBytes`，`jsonBytes` 留下沒人用的參數 | low | 屬實，但只是多一次走訪，沒有具體壞處 | reject |
| B4 | 沒有深度上限：很深的巢狀資料抄得過但 clone 不了 | medium | 屬實（實測）：30000 層陣列在 64 KiB 內，`structuredClone` 丟 RangeError。draw 路徑落到 `draw-not-cloneable`（註解寫錯）；port 到之前的 `stage.*` 呼叫會在之後被靜默吞掉，這是第 2 輪拿掉 `structuredClone` 造成的回歸 | R3-G2 patch |
| B5 | `stage.*` 帶抄不了的值改成丟例外，後果沒寫 | low | 屬實，但這是使用者 2026-11-19 選的；`stage.*` 原本就會在其他誤用時丟 `TypeError` | reject（intent 明定） |
| B6 | `TypeError` 訊息沒有原因；`fire` 先解構參數，getter 丟的是包自己的錯 | low | 屬實，但包拿到的是自己的錯，不是宿主物件 | reject |
| B7 | 丟棄原因會誤導（忘了 return、循環參照） | low | 文件已寫「沒有回傳值也算」與循環參照的結果；新增原因是新介面 | reject |
| B8 | 兩處註解過時（`sandbox.ts:182-185`、`worker-bootstrap.ts:276`） | low | 屬實，直接改 | R3-G3 patch |
| B9 | 每個物件都走一次會丟例外的品牌檢查，建議改成 snapshot 時登記 | low | 屬實但沒量過，估計每格不到 1 ms；改法是重新設計 | reject |
| B10 | 做得出畫布但認不出圖時會全面失效 | low | 現行 Chromium 的 Worker 兩者都有（e2e 證實），沒有證明走得到 | reject |
| B11 | 品牌檢查參數是選填，容易漏傳 | low | 漏傳時 e2e「bitmap 出現」會失敗，單元測試也有突變自檢 | reject |
| B12 | 文件對陣列「只抄索引元素」的說法有誤導 | low | 屬實：程式是有任何非索引自有屬性就整則不送，不是忽略 | R3-G3 patch（文件） |
| B13 | 解析度建議每邊各自封頂會讓圖變形 | low | 屬實：寬 300、高 100 會變 512×200，兩邊倍率不同 | R3-G3 patch（文件） |
| E3 | 同 B13 | low | 同 B13 | R3-G3 patch（文件） |
| E4 | 寬高是小數時，乘 2 後不是整數，`stage.canvas` 丟錯 | low | 屬實：schema 允許任意正數 | R3-G3 patch（文件） |
| B14 | 文件沒寫 Worker 不送的那則裡的圖後來怎樣 | low | 屬實：沒被 transfer，仍在包手上，等 GC | R3-G3 patch（文件） |
| E6 | 同 B14（藏在 Map 的圖以前會被 transfer 再 close） | low | 同 B14 | R3-G3 patch（文件） |
| B15 | e2e 的 reload 斷言變寬、標題沒改 | low | 改成前後差值是第 2 輪 E6 要求的，仍斷言這個測試期間沒有 reload | reject |
| B16 | e2e 沒驗真 Worker 裡 `stage.*` 的品牌檢查有接上 | low | 不成立：漏接時改過原型的圖會被抄成 `{}`，不會有圖送出；接線有單元測試與突變自檢 | reject |
| E2 | 物件或 Proxy 宣稱有大量鍵時，會先列舉完才判超過 | low | 只耗包自己 Worker 的時間，等同包自己跑迴圈 | reject |
| E5 | `restoreOverlayContext` 第二次呼叫會用到舊的 extension | low | 屬實，還原後刪掉即可 | R3-G4 patch |
| V1 | `routeStageMessage` 傳給 `jsonBytes` 的品牌判斷沒有測試守著 | medium | 預先驗證的缺口：拿掉第 4 個參數，原型改成其他物件或偽造 `Symbol.hasInstance` 的圖會被多擋，沒有測試變紅 | R3-G4 patch |
| V2 | 「`post` 丟例外時換成自己的 TypeError」的測試已走不到 `post` | medium | 預先驗證的缺口：`sandbox.test.ts:642` 的參數是函式，在抄寫時就被擋下 | R3-G4 patch |

**狀態：** 本輪沒有 intent_gap 或 bad_spec，照 patch 處理 R3-G1～G4，修完重跑 Verification 的全套檢查後進 step-05。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者在打包版實機驗收：匯入一個 `advancedBitmap` 的驗收用包（由主流程在 scratchpad 產生，不進 repo），角色以 bitmap 畫出、每格更新；滑鼠移到角色上時接住滑鼠。
