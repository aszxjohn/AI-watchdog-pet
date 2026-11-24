---
title: 'Story 3.6（下之二）：粒子'
type: 'feature'
created: '2026-11-18'
status: 'done'
baseline_commit: 'b45c20e5b3b57584c54c8fe3725d0eec30c3ba31'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-6-tick-and-draw.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.6 中段只畫 `sprite`，`particles` 指令被略過（每包記一行）。契約測試包在「思考中」送的 `sparkle` 粒子看不到；`preset` 也還接受任何 id 格式的名稱，作者文件第 11 節寫著清單未定。

**Approach:** overlay 自己寫發射器，用 PixiJS `ParticleContainer` 畫在 actor 的容器裡（一起套位置、大小、`bounds` 遮罩與 y 排序）。preset 正式清單放 `src/shared/pack-api`，schema 收緊成只接受清單裡的名稱；每個 preset 的外觀只在 renderer 定義一處。

**Decisions（2026-11-18）：**
- **拆段：** 粒子與 bitmap 合寫約 4,500 token，使用者選擇拆開，這段只做粒子；bitmap 是下之三（見 deferred-work）。
- **preset 清單（使用者選 A）：** `sparkle` 閃光、`smoke` 煙、`confetti` 彩紙、`bubbles` 泡泡。大致對應思考中、出錯、完成、休息，但包可以自由使用。之後新增 preset 要升 minor。
- **清單外的 preset（使用者選 A）：** schema 直接用清單，不合就整則 `draw` 丟棄（既有的 `invalid`），和其他不合規的處理一致。
- **`params`：** 只讀 `rate`（數字，乘在發射速率上，超出 0～2 就夾到範圍內，預設 1）與 `tint`（`#rrggbb`，粒子改成這個顏色）。其他名稱、型別不對的值忽略並用預設；`params` 的 schema 不變（仍是開放的 record）。

## Boundaries & Constraints

**Always:**
- **發射器：** 以「包 × actor × `emitterId`」為單位。該 actor 在這包最後一則有效 `draw` 裡有這個 `emitterId`，就依 preset 的速率持續發射，位置跟著最新的 `x`、`y`（actor 本地座標）；不在了就停止發射，已發出的粒子跑完壽命後移除，發射器也移除。換 preset（同一 `emitterId`）視同舊的停、新的開始。
- **立刻移除：** actor 離場、包的沙盒銷毀或失敗（最後一則 `draw` 被清掉）時，它的發射器與粒子一起移除。
- **上限：**
  - 一則 `draw` 的 `particles` 指令（所有 actor 合計）超過 `PARTICLE_EMITTERS_MAX`，整則丟棄，新原因 `too-many-emitters`，記一行帶 `packId`（照既有丟棄 log 限速）。
  - 每個發射器同時存在的粒子最多 `PARTICLES_PER_EMITTER_MAX`，滿了就暫停發射，不丟棄 `draw`。
- **模擬與繪製分開：** 粒子的出生、移動、淡出是純邏輯，可注入亂數與時間，在 Node 測。PixiJS 只負責把結果畫出來。
- **貼圖：** 每個 preset 一張，由程式畫在 canvas 上產生（不是 render texture，WebGL context 還原後才能重新上傳），不進 PixiJS 全域快取；同一個發射器的粒子共用它。
- **時間：** 用 ticker 的 `deltaMS`，單格最多算 100 ms（暫停或卡頓後不會一次噴出一大把）。render loop 停的時候（沒有 actor、睡眠或鎖定、context lost）粒子也停。
- `commands-skipped` 只剩 `bitmap` 會記（下之三才畫）。
- 新常數只放 `src/shared/constants`；preset 名稱清單放 `src/shared/pack-api`。

**Never:**
- 不做 bitmap、`stage.canvas`（下之三）。
- 粒子不影響 hit area：照舊只看畫出來的 sprite 與 manifest `hitbox`。
- 不改 `src/sandbox/**`、`src/main/**`；不改每包最多一則 `frame` 在途、既有的檢查順序與丟棄原因。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 粒子出現 | 契約測試包 probe-one 在「思考中」、`glow` 開，送 `sparkle` 發射器 | 角色上方出現粒子，持續發射 |
| 粒子停止 | 下一則 `draw` 沒有那個 `emitterId`（例如狀態改變） | 不再發射；已發出的跑完壽命後消失，發射器移除 |
| 粒子跟隨 | 同一 `emitterId` 的 `x`、`y` 每格改變 | 新粒子從新位置發出 |
| 四種 preset | 分別用 `sparkle`、`smoke`、`confetti`、`bubbles` | 各自依定義的外觀發射，彼此看得出差別 |
| `rate` 與 `tint` | `rate: 2`、`tint: '#ff0000'`；`rate: 9`；`rate: 'x'` | 速率加倍、粒子變紅；9 夾成 2；`'x'` 忽略用 1 |
| 清單外 preset | `preset: 'fireworks'` | 整則丟棄（`invalid`），記一行帶 `packId` |
| 發射器上限 | 一則 `draw` 的 `particles` 超過 `PARTICLE_EMITTERS_MAX` | 整則丟棄（`too-many-emitters`），記一行帶 `packId` |
| 粒子數上限 | 速率很高 | 每個發射器同時最多 `PARTICLES_PER_EMITTER_MAX` 顆 |
| 大小與裁切 | 角色固定參數「大小」不是 1；粒子飛出 `bounds` | 粒子跟著大小縮放；超出 `bounds` 的部分不畫 |
| actor 離場 | 有發射器的 actor 離場 | 發射器與粒子立刻移除 |
| 暫停 | 系統睡眠或鎖定，之後恢復 | 期間粒子不動；恢復後接著跑，不會一次噴出一大把 |
| hit area | 只有粒子、沒有 sprite 的 actor | 沒有 hit area；有 sprite 的 actor 的 hit area 不因粒子改變 |
| bitmap 照舊 | `draw` 含 `bitmap` | 略過那幾條、其他照畫，每包記一行 `commands-skipped` |

</frozen-after-approval>

## Code Map

- **`src/shared/pack-api/`：**
  - 新增 `particles.ts`：`PARTICLE_PRESETS = ['sparkle', 'smoke', 'confetti', 'bubbles'] as const` 與 `ParticlePreset` 型別；從 `index.ts` 匯出。
  - `draw.ts:55-64` 的 `particlesCommandSchema.preset` 從 `idSchema` 改成 `z.enum(PARTICLE_PRESETS)`。pack-api 只依賴 zod，不能 import `constants`。
  - 測試 `test/shared/pack-api/draw.test.ts:220-221`「any id-style preset (v1.0)」改寫成清單內通過、清單外拒絕。
- **`src/shared/draw-size.ts`：** 新增 `countEmitters(draw)`（各 actor 的 `particles` 指令合計），放在 `countDrawCommands` 旁邊。
- **`src/shared/constants.ts`（`:294-310` 附近，`TICK_HZ`、`DRAW_MAX_*` 旁）：** `PARTICLE_EMITTERS_MAX` 16、`PARTICLES_PER_EMITTER_MAX` 64。
- **`src/shared/sandbox.ts`：** `SKIPPED_DRAW_COMMANDS`（`:300`）只剩 `'bitmap'`；`:333` 的說明、`:373-377` 的 log schema 跟著改。
- **`src/overlay/pack-host/`：**
  - `draw-rules.ts:101-104`：`particles` 不再放進 `skipped`；在 schema 驗證之後加發射器數檢查與新原因 `too-many-emitters`（檢查順序說明 `:1-20` 一起更新）。
  - `host.ts:482-486` 的 `commands-skipped` 照舊，只是不會再有 `particles`。
- **`src/overlay/renderer/`：**
  - 新增 `particles.ts`（純邏輯，不 import pixi.js）：
    - preset 定義表 `Record<ParticlePreset, PresetDef>`：速率、壽命、初速與方向範圍、重力、大小、旋轉、顏色、淡出；型別保證和清單一一對應。
    - 外觀方向：`sparkle` 小亮點在發射點周圍小範圍散開（半徑約 15 基準像素）、閃爍淡出，不往上飄遠（契約測試包 probe-one 的發射點 y = -120，`bounds` 上緣是 -130，往上飄會立刻被裁掉）；`smoke` 灰色柔和圓點上升變大變淡；`confetti` 多色小方片往外噴、受重力落下並旋轉（`tint` 時單色）；`bubbles` 淡藍小圓慢慢上升、左右輕擺。
    - 發射器集合：依每個 actor 的最新指令建立、更新、停止；`step(dtMs)`；`rate`、`tint` 解析；粒子數上限；可注入亂數。
  - `scene.ts`：`SceneActor` 加 `emitters`（該 actor 最新 `draw` 裡的 `particles` 指令）；z 排序（`:137-148`）、y 排序（`:264`）、hit area（`:267-273`）不變。
  - `pixi-stage.ts`：`ActorNode`（`:120-131`、`:143-148`）加每個發射器一個 `ParticleContainer`（自設 `boundsArea`），放在同一個被遮罩的 container 內、所有 sprite 之上；把模擬結果同步成 `Particle`。preset 貼圖照 `:74-81` 建 `Texture`（不進全域快取），renderer 銷毀時一起銷毀。
- **`src/overlay/main.ts`：** `drawFrame`（`:186-209`）每格用 ticker 的 `deltaMS` 推進粒子，再交給 stage。body 的 data 屬性多 `particleEmitters`、`liveParticles`（值改變時才寫），e2e 讀這些。第一行 `import 'pixi.js/unsafe-eval'` 與 `preferCreateImageBitmap: false`（`:61`）不動。
- **作者文件 `docs/pack-api-v1.md`：**
  - 8.1 的 `particles`：preset 清單與外觀、`rate`、`tint`、兩個上限，以及清單外名稱會讓整則被丟。
  - 刪掉「目前的舞台還不畫 `particles` 與 `bitmap`」那句裡的 `particles`。
  - 第 11 節：刪掉 preset 清單那項，發射器上限移到正文（bitmap 上限仍未定）。
- **測試：**
  - 單元測試：preset schema、`countEmitters`、draw 檢查（清單外、`too-many-emitters`、particles 不再 skipped）、粒子模擬（發射、停止、跟隨、上限、`rate`／`tint`、單格 100 ms 上限、換 preset）、scene，以及 pixi-stage 在 Node 下以真的 PixiJS 建出 `ParticleContainer`（沿用 `test/overlay/pixi-stage.test.ts` 的做法）。
  - e2e（`test/e2e/stage.spec.ts`）：讓探針 actor 進入「思考中」（契約測試包 probe-one 的 `glow` 預設開），斷言 `particleEmitters` 是 1、`liveParticles` 大於 0；狀態改成不發射的狀態後，`particleEmitters` 回到 0。只讀 body 的 data 屬性，不截圖、不讀像素。
  - I/O 矩陣測試標題用 `describe('I/O matrix')` 加 `'<列名>: …'`。

**不要改：** `src/sandbox/**`、`src/main/**`、`test/packs/contract-pack/**`（它已經送 `sparkle`）；既有的丟棄原因與檢查順序（只新增 `too-many-emitters`）；貼圖不進全域快取。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/pack-api/particles.ts`、`draw.ts`、`src/shared/draw-size.ts`、`src/shared/constants.ts`、`src/shared/sandbox.ts` -- preset 清單、收緊 schema、`countEmitters`、新常數、skipped 只剩 bitmap -- 其他部分依賴這些
- [x] `src/overlay/pack-host/draw-rules.ts` -- 發射器數檢查、particles 不再略過 -- 擋下超量的 `draw`
- [x] `src/overlay/renderer/particles.ts`、`scene.ts`、`pixi-stage.ts`、`src/overlay/main.ts` -- 模擬、繪製、data 屬性 -- 粒子畫出來
- [x] `docs/pack-api-v1.md` -- 8.1 與第 11 節 -- 作者文件與實作一致
- [x] 測試 -- 涵蓋 I/O 矩陣，含 e2e

**Acceptance Criteria:**
- Given 這段完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`，then 全部通過；既有斷言只因 preset 收緊與 particles 不再略過而改動。
- Given push 到 main，when CI 跑完，then unit 與 e2e 在 macOS、Windows 都通過。

## Implementation Notes

- 2026-11-18 開發代理自行決定的部分：
  - **`DrawnActors`：** 改成每個 actor 的 `sprite` 與 `particles` 指令（照包的順序，型別 `DrawnCommand`），scene 再分成 sprites（照 `z`）與 `emitters`。只有 sprite 的 draw 結果不變，既有斷言不用改。
  - **檢查順序與原因：** `too-many-emitters` 在 schema 之後、`not-own-actor` 之前；`DrawLimits` 多 `emitters`。新原因排在 `PACK_MESSAGE_DROP_REASONS` 的 `stale-draw` 之後、no-draw 原因之前。main 的 log 直接印原因代碼，`src/main` 不用改。
  - **常數：** 規格的兩個之外，另加 `PARTICLE_STEP_MAX_MS` 100（「時間」那條的單格上限）。PixiJS ticker 本身也把 `deltaMS` 夾在 100（預設 minFPS 10），等於兩道。
  - **模擬（`renderer/particles.ts`）：**
    - 發射器跟著「這一格畫出來的 actor」（`scene.actors`）走：actor 不在 scene 就立刻移除它的發射器與粒子。除了規格列的離場、沙盒銷毀／失敗，也包括漏回、狀態對應不到、放不下（這些情況 actor 本來就整隻不畫）。
    - 停止的發射器（指令不在、換 preset）等粒子跑完才移除，`particleEmitters` 的計數包含這種淡出中的。同一個 `emitterId` 停了又出現，是新的發射器。
    - 發射量用累積值（`carry`）算，每格發 `floor`；滿了的時候發不出去的不保留，不會事後補噴。一格裡發出的粒子，出生時間在那一格內隨機分散（30 fps 下不成團）。
    - `tint` 接受大小寫十六進位（`/^#[0-9a-fA-F]{6}$/`），`rate` 0 就是不發射；都寫進作者文件 8.1。
    - preset 數值在 `PARTICLE_PRESET_DEFS`：`sparkle` 每秒 14 顆、壽命 0.5～0.9 秒、出生半徑 10、速度 2～6 任意方向（最遠約 15.4 基準像素）；`smoke` 往上、變大變淡；`confetti` 五色方片、重力 160；`bubbles` 淡藍、往上、左右擺 3 像素。**數值沒有在實機看過，可能要調。**
  - **繪製（`pixi-stage.ts`）：**
    - 每個發射器一個 `ParticleContainer`（`position`、`vertex`、`rotation`、`color` 都設成 dynamic，`uvs` 不是），`boundsArea` 是 actor 的 `bounds`，bounds 改變時跟著改。新的 sprite 用 `addChildAt` 插在粒子之下。粒子 anchor 0.5、scale ＝ size ÷ 32，設 `tint`、`alpha`；`Particle` 物件依位置重用。
    - preset 貼圖：32×32 canvas（main.ts 用 `document.createElement('canvas')`），白色，依 `shape` 畫（spark：放射漸層加四角星；puff：柔和漸層；square：四周留 2 像素透明的方塊；bubble：圓環、淡填色、高光），用 `ImageSource`（linear），第一次用到時才建立。pixi-stage 多了 `destroy()`（連同 preset 貼圖），但 main.ts 沒有呼叫：overlay 頁面存活期間 renderer 不會被銷毀，頁面重載時整個 context 一起回收。
    - pixi-stage 照舊不引用 DOM 型別：canvas 與 2D context 用最小介面 `PaintCanvas`／`PaintContext` 傳入，Node 測試用會記錄呼叫的假 canvas。
  - **main.ts：** ticker 的 callback 改成 `onRenderFrame(ticker)`，把 `ticker.deltaMS` 交給 `drawFrame(dtMs)`；`followView` 的「最後一格」呼叫 `drawFrame()`（dt 0，粒子不動）。`particleEmitters`、`liveParticles` 讀模擬的 `counts()`，不讀 pixi-stage 的回傳值（避免改 `StageCounts` 的既有斷言）。context lost 時 `context-loss.ts` 只把 `drawnActors` 等歸零，沒有動這兩個屬性：模擬在 lost 期間停住，值維持原樣。
  - **e2e：** `test/e2e/helpers.ts` 新增 `appendClaudeRecord(home, session, 'prompt' | 'answer')`，在合成 transcript 後面追加一行（user prompt → thinking；assistant `end_turn` → done），和 `writeClaudeSession` 共用路徑與記錄格式。`stage.spec.ts` 新增「粒子出現」「粒子停止」，放在「加入與移出」之前（serial）。
- 既有斷言的改動（都是 preset 收緊或 particles 不再略過）：`draw.test.ts`「any id-style preset (v1.0)」改成清單內四個通過、清單外拒絕；`sandbox.test.ts` 原因清單多 `too-many-emitters`、`commands-skipped` 的範例由 `particles` 改 `bitmap`（`particles` 改列在拒絕）；`packs-overlay-manifest.test.ts` 的 `commands-skipped` log 行改成 `bitmap`；`pack-host-draw.test.ts` 兩個「粒子與 bitmap」改名「bitmap 照舊」，particles 留在 draw 裡、只記 bitmap；`scene.test.ts`「出現」的期望多 `emitters: []`。測試輔助：`pixi-stage.test.ts` 的 `sceneActor` 多 `emitters: []`、`scene.test.ts` 的 `drawOf` 型別放寬成 `DrawnCommand[]`。
- 2026-11-18 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`（113 檔通過、1 檔跳過；5305 個測試通過、2 個跳過）、`npm run depcruise`（315 個模組、0 違規）、`npm run e2e`（17 個通過，含新的 2 個）。突變實驗 8 項（拿掉單格上限、粒子數上限、停止發射、actor 不在就移除、`too-many-emitters` 檢查、sprite 插在粒子下、scene 帶 emitters、`tint`）各自有測試失敗（已還原）。I/O 矩陣 13 列都有測試：單元測試在 `test/overlay/{particles,pixi-stage,scene,pack-host-draw}.test.ts`、`test/shared/pack-api/draw.test.ts`；e2e 涵蓋粒子出現、粒子停止。「大小與裁切」只驗到粒子容器是 actor 容器（有大小與 bounds 遮罩）的子層，沒有讀像素；「暫停」只在單元測試驗模擬，main.ts 的接線（只在 ticker 推進）是程式閱讀。
- 2026-11-18 依審查修補（協調者指出）：
  - **發射器累積：** `sync` 後每個 actor 的發射器（含停止中、淡出中）超過 `PARTICLE_EMITTERS_MAX` 時，先移除最舊的停止中發射器（連同粒子）；發射中的一律保留。
  - **畫面上的粒子：** `createPixiStage` 的 `particles` 參數改成必填；pixi-stage 多 `particleCounts()`，回報上一次 `draw()` 實際放上舞台的 `ParticleContainer` 數與粒子總數。main.ts 寫成 data 屬性 `drawnEmitters`、`drawnParticles`；e2e「粒子出現」斷言兩者大於 0，「粒子停止」斷言回到 0，等待改成 5 秒（`PARTICLES_GONE_TIMEOUT_MS`）。`StageCounts` 沒動，既有斷言不變。
  - **context lost：** `halt()` 把 `particleEmitters`、`liveParticles`、`drawnEmitters`、`drawnParticles` 一起歸零，`context-loss.test.ts` 的期望多這四個。
  - **測試補強：** `particles.test.ts` 加換 id 洪水（100 格、每格 16 個新 id）、同一發射器中途改 `rate`／`tint` 與 `rate: 0`、停止後同 id 同 preset 再出現；「粒子數上限」改成上限 3、每秒 10 顆，斷言全部死掉後只照速率補（1、2、3），不會一次補滿。突變實驗 6 項（拿掉發射器上限、`emitter.params` 更新、`if (!emitter.active) continue`、`carry -= count`、pixi-stage 的計數、context lost 歸零 `drawnEmitters`）都有測試失敗（已還原）。
  - **作者文件 8.1：** 列出各 preset 的基準速率與壽命；`tint`、`rate`、`x`／`y` 只影響之後發出的粒子；停止中的發射器也算在每個 actor 16 個之內。
  - 驗證（只跑涵蓋改動的部分）：typecheck、lint、`test/overlay/{particles,pixi-stage,context-loss}.test.ts`（59 個通過）、`test/e2e/stage.spec.ts`（6 個通過）。

- CI：commit `70c6d04`（2026-11-18）後，GitHub Actions 的 unit（check）與 e2e 在 macOS、Windows 都通過（run 44243830617）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-18）：Blind Hunter 12 條（B1–B12）、Edge Case Hunter 3 條（E1–E3）、Verification Gap 4 個缺口（VG1–VG4）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| B1、E1 | `PARTICLE_EMITTERS_MAX` 只算這一則 `draw` 的指令；停止後還在淡出的發射器不算。包每格換 `emitterId` 時，殘留的發射器與 `ParticleContainer` 可累積到數百個 | medium | patch | 已確認 `particles.ts` 的 `sync` 只在粒子跑完後才移除停止的發射器，沒有總數上限；每個 actor 的發射器（含淡出中）超過 `PARTICLE_EMITTERS_MAX` 時先移除最舊的停止中發射器，補換 id 洪水的測試 |
| VG1 | e2e 讀的 `particleEmitters`、`liveParticles` 來自模擬，不是 pixi-stage 畫出來的；main.ts 漏傳第三參數或 key 用錯時，畫面沒有粒子但測試全過 | medium | patch | 驗證缺口已附證據；pixi-stage 回報實際放上舞台的 `ParticleContainer` 與粒子數，main.ts 寫成另一組 data 屬性，e2e 斷言大於 0；`particles` 參數改成必填 |
| B2 | context lost 時 `halt()` 沒把 `particleEmitters`、`liveParticles` 歸零，與 `context-loss.ts` 說明「nothing drawn」不符 | low | patch | 已確認 `halt()` 只歸零 sprite 相關屬性；直接把粒子屬性（含 VG1 新增的）加進歸零清單並補測試 |
| B3、VG3 | 同一發射器中途改 `rate`／`tint`（含 `rate: 0` 停止發射）沒有測試；刪掉 `sync` 裡更新 params 那行，測試照過 | low | patch | 驗證缺口已附證據；補測試 |
| VG4 | 停止中的發射器以同一個 `emitterId` 與 preset 再出現時會新建、立刻發射，沒有測試；拿掉 `if (!emitter.active) continue` 會中斷最長一個粒子壽命 | low | patch | 驗證缺口已附證據；補測試 |
| B5 | 「粒子數上限」測試的速率太高，分辨不出「滿了之後不補噴」 | low | patch | 已確認測試用 `rate` 100,000 × 2，`carry -= count` 的突變也會過；改用中等速率與小上限，斷言死掉一顆後只照速率補 |
| VG2 | `ticker.deltaMS` 的時間單位沒被測試釘住；誤用 `deltaTime` 時粒子慢約 16 倍，e2e 的 20 秒等待仍會過 | low | patch | 驗證缺口已附證據；「粒子停止」在狀態改變後改用短的等待（sparkle 壽命上限加傳遞延遲，約 5 秒） |
| B4、E2 | 作者文件 8.1 說 `tint` 讓「粒子全部改成這個顏色」，實作是出生時固定；文件沒有各 preset 的基準速率與壽命，作者不知道 `rate: 1` 是多少、停止後留多久 | low | patch | 已確認顏色在 `emit()` 時固定；直接修正文件：`tint`、`rate`、`x`／`y` 只影響之後發出的粒子，並列出每個 preset 的基準速率與壽命 |
| B6 | Worker 端沒有預先檢查發射器數，17 個發射器的 `draw` 會先送出再被丟；這個不對稱沒記進 deferred-work | low | reject | overlay 仍會整則丟棄，多送一則小訊息沒有實際影響；補上要改 `src/sandbox`（這段的 Never） |
| B7 | preset 清單在文件、`PARTICLE_PRESETS`、測試三處，沒有「文件 ↔ 程式」同步測試 | low | reject | 只有改 preset 清單（升 minor）時才會不同步，機會很小；補上要新增解析文件的測試 |
| B8 | 實機驗收項目只有 sparkle；契約測試包只送 sparkle，其他三種與遮罩裁切在打包版看不到 | low | reject | 修正方式是改這份 spec 的驗收項目；實機驗收時由主流程在 scratchpad 另做驗收用的包，涵蓋四種 preset 與裁切，不進 repo |
| B9 | `stage.destroy()` 與 `ParticleTextures.destroy()` 在正式程式碼沒人呼叫；destroy 後再 draw 會重建貼圖 | low | reject | overlay 頁面存活期間 renderer 不會銷毀，使用者碰不到 |
| B10 | 發射器以 `actorId` 當 key，沒有 `packId`；同一 `actorId` 換包時發射器會延續 | false | reject | `actorId` 由 `main/pool` 產生、執行期間不重用，換角色是舊 actor 結束、新 actor 產生（epic context），同一 `actorId` 不會換包 |
| B11 | `sync()` 每個顯示格都重建 Map、解析 params | low | reject | 每秒最多 30 格、actor 數少，成本可忽略；B1 的上限修好後也不會放大 |
| B12 | `host.ts` 註解有一行約 86 欄；e2e 標題「takes the mouse as before」只斷言 hit area 數 | low | reject | 格式檢查通過；hit area 範圍不變由單元測試涵蓋 |
| E3 | 驗收條件說既有斷言只因 preset 收緊與 particles 不再略過而改，但 `test/shared/sandbox.test.ts:352` 的丟棄原因清單也因新原因 `too-many-emitters` 改了 | low | reject | 修正方式是改這份 spec 的紀錄；該斷言的改動本身正確（新增丟棄原因），主流程的刪除 `expect(` 檢查也看得到 |

修補結果（2026-11-18）：8 組都已修正（發射器每個 actor 最多 `PARTICLE_EMITTERS_MAX` 個含停止中；pixi-stage 的 `particleCounts()` 寫成 `drawnEmitters`、`drawnParticles`，e2e 斷言它們；context lost 一起歸零；補 3 個模擬測試並改寫上限測試；「粒子停止」逾時 5 秒；作者文件 8.1 列出基準速率與壽命）。開發代理的突變實驗 6 項都會讓測試失敗。主流程重跑：typecheck、lint、depcruise（315 個模組、0 違規）通過；`CI=true npm test` 113 檔、5310 個測試通過；`npm run e2e` 17 個通過；`out/` 沒動；I/O 矩陣 13 列都有測試且跑過；被刪的既有 `expect(` 只有 `pack-host-draw.test.ts` 一行（particles 不再略過，改成期望 `[PARTICLES, SPRITE]`）。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`、`npm run e2e`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者在打包版實機驗收：匯入契約測試包，讓一個分到探針一的 session 進入「思考中」，角色上方有閃光粒子；狀態改變後粒子停止並淡出。
