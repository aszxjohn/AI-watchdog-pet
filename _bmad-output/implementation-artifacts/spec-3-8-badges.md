---
title: 'Story 3.8：名牌與狀態標記'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_commit: 'b149fd2f2b5954f0132317410948c5a897be06b4'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 畫布上的角色看不出代表哪個 session、現在是什麼狀態；3.7 的佔位剪影各狀態長得一樣，更要靠標記分辨。

**Approach:** 舞台在每隻角色 manifest `anchor` 的位置畫名牌（session 顯示名稱）與狀態標記，推測的狀態（`confidence: inferred`）用另一種樣式；角色的固定參數 `badges` 為關時不畫。包不畫名牌。

**Decisions（2026-11-24 規劃時定，使用者可推翻）：**
- **畫在誰上面：** 場景裡的每隻 actor 都畫，包括佔位與 `draw` 給空陣列的；不在場景裡的（漏回、還沒有 `draw`、找不到角色）不畫。
- **位置與大小：** 名牌底部中央對齊 actor 位置加 `anchor` × 大小；名牌本身的字與框不隨「大小」縮放；不受 `bounds` 裁切；畫在所有角色之上的獨立圖層，名字不會被別的角色蓋住；不接滑鼠。
- **名稱：** `displayName`，沒有時用 session key 的原生 id（跟面板一樣）；太長時截斷加「…」。
- **即時更新：** 名稱、狀態、`confidence` 一變，下一個畫面就換；`meta` 已由 3.6 送給包，不改。
- **樣式（使用者 2026-11-24 選 A）：** 一個深色半透明圓角名牌，兩行：第一行「● 狀態名」（圓點與文字用狀態色），第二行 session 名稱。推測的狀態：圓點改空心、狀態名後加「？」。不放型號、不做機甲風格。
- **名牌互不遮擋（使用者 2026-11-24 審查後選 B）：** 依場景順序擺放名牌，先擺的留在原位；跟已擺好的名牌相交時往上錯開一層（名牌高度加一點間距），直到不相交。
- **不出畫布（2026-11-24 審查後追加）：** 名牌左右夾在畫布內，上緣不高於畫布頂端；只有這兩種情況會離開 `anchor` 正上方。
- **開關（使用者 2026-11-24 選 A）：** 3.8 只照 StageView 的 `fixed.badges` 決定畫不畫，用單元測試驗；設定檔與開關介面跟 Epic 5 的角色編輯頁一起做，這段期間實機關不掉。

## Boundaries & Constraints

**Always:**
- 名牌與標記是舞台內建繪製，不載入素材、不連網；文字用系統字型畫在 2D canvas 上做成貼圖（比照 `particleTextures` 由 main.ts 提供 canvas），同內容共用、不用就銷毀，解析度跟著畫布螢幕的 `scaleFactor`。
- 狀態的中文名稱只從 `STATE_DISPLAY_NAMES` 取。
- overlay body 新增 `drawnBadges`（畫了幾個名牌）；WebGL context lost 時歸零。

**Never:**
- 不改 manifest、pack API 訊息、`meta` 的送法、佔位外觀。
- 不做右鍵選單、拖曳、遊走（Epic 4）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 出現 | 一隻 actor 在場景裡 | 在 `anchor` × 大小 的位置畫一個名牌：session 名稱與狀態標記 |
| 推測 | `confidence` 為 `inferred` | 標記用推測樣式，和確定的看得出差別 |
| 佔位 | actor 在佔位 | 照樣畫名牌與標記 |
| 不在場景 | 漏回、還沒有 `draw` | 不畫名牌 |
| 關閉 | 角色 `fixed.badges` 為 false | 名牌與標記都不畫 |
| 改名 | `displayName` 改變 | 下一個畫面名牌換新名字；包收到 `meta`（既有） |
| 沒名字 | `displayName` 為 null | 顯示原生 id |
| 太長 | 名稱超過寬度上限 | 截斷加「…」 |
| 重疊 | 兩隻角色前後重疊 | 兩個名牌都在所有角色之上 |
| 名牌互疊 | 相鄰兩隻角色，名牌寬度超過兩者間距 | 後擺的名牌往上錯開一層，兩張都完整看得到；不相交的留在 `anchor` 正上方 |
| 邊緣 | 最右邊的角色，名牌比它右側的空間寬 | 名牌整張在畫布內（往左移），不被切掉 |
| 離場 | actor 離開 | 名牌消失，沒人用的貼圖銷毀 |
| context lost | 名牌顯示中 | `drawnBadges` 歸零；還原後照常 |

</frozen-after-approval>

## Code Map

- `src/overlay/renderer/scene.ts`：`SceneActor`（`:102-126`）加名牌資料（名稱、狀態、`confidence`、`anchor`，`badges` 關時沒有）；`buildScene` 從 `actor`（`StageActor`，`src/shared/pool.ts:100-107`）、`view.characters[key].fixed.badges`、`character.anchor` 取值；佔位與一般 actor 都帶。名稱 fallback 用 `splitSessionKey`（`src/shared/detection-events.ts:97`）的原生 id，比照 `src/panels/session-rows.ts:175`。
- `src/overlay/renderer/badges.ts`（新）：純函式，名牌的版面（截斷、寬高）與 2D 畫法（比照 `pixi-stage.ts` 的 `PaintContext`／`paintParticle`，`:164-282`），常數放這裡。
- `src/overlay/renderer/pixi-stage.ts`：`createPixiStage`（`:478-`）多收一個名牌圖層（在 actor 圖層之上），依場景擺名牌 Sprite；貼圖依內容 key 快取、沒人用就銷毀；`StageCounts`（`:435`）加 `badges`。
- `src/overlay/main.ts`：`:317-319` 多建一個 Container 疊在 actor 圖層之上給名牌；`drawFrame` 寫 `drawnBadges`；名牌 canvas 比照 `:325` 的 `document.createElement('canvas')`。
- `src/overlay/context-loss.ts`：`halt()`（`:191-213`）歸零 `drawnBadges`。
- 作者文件 `docs/pack-api-v1.md`：3.3 的 `anchor` 補一句名牌與標記畫在這裡、不隨包的 `draw`；5.1 的 `badges` 說明現況。
- **不要改：** `src/main/**`、`src/shared/settings.ts`、`src/panels/**`、pack API、契約測試包、佔位。

## Tasks & Acceptance

**Execution:**
- [x] `src/overlay/renderer/badges.ts`、`scene.ts` -- 名牌資料與版面 -- 每隻 actor 有名牌
- [x] `src/overlay/renderer/pixi-stage.ts`、`src/overlay/main.ts`、`src/overlay/context-loss.ts` -- 名牌圖層、貼圖快取、`drawnBadges` -- 畫出來
- [x] `docs/pack-api-v1.md` -- `anchor` 與 `badges` 說明 -- 文件一致
- [x] 測試 -- `scene.test.ts`、新 `badges.test.ts`（假 2D context）、`pixi-stage.test.ts`（真 PixiJS、假 canvas）、`context-loss.test.ts` 涵蓋 I/O 矩陣；`test/e2e/stage.spec.ts` 在既有測試加 `drawnBadges`（出現時 `1`、佔位時 `1`、離場後 `0`）-- 鎖住行為

**Acceptance Criteria:**
- Given 完成，when 執行 typecheck、lint、depcruise、`npx vitest run`，then 全部通過；e2e 由 push 後的 CI 驗證。
- Given 重新打包的 app，when 示範模式依序切幾個狀態，then 角色頭上的名牌跟著換狀態（示範模式送的都是確定的狀態；推測樣式由單元測試驗證）。

## Implementation Notes

- **本機不跑 e2e**（同 3.7，使用者 2026-11-24 決定）：只跑 typecheck、lint、depcruise、`npx vitest run`。

- **開發代理自行決定的外觀細節（可推翻）：** 狀態色：等你回覆黃、思考中紫、工作中綠、要你批准橙、要你決定粉、做完了青、休息中灰、出錯了紅；字級 11px（狀態名粗體）；名稱最寬 140 DIP；名牌左上角對齊整數裝置像素。
- **第 1 輪審查修補（2026-11-24）：** 名牌依場景順序擺放、相交就往上錯開一層（`stackBadges`，間距 `BADGE_STACK_GAP` 2 DIP）；先夾回畫布左右，錯開後上緣再夾回 ≥ 0（在頂端時可能跟別張重疊）；`Scene` 帶 `canvasWidth`；`fitText` 改用 `Intl.Segmenter` 依字素切；底色不透明度 0.9；e2e 還原後檢查 `drawnBadges`；作者文件 3.3 補尺寸與擺放規則。
- **本機驗證（2026-11-24，修補後）：** typecheck、lint、depcruise 通過；`npx vitest run` 5561 通過、2 略過。e2e 等 push 後的 CI。
- **sprint-status：** `3-8-名牌與狀態標記` 改為 `review`；CI 通過、使用者實機驗收後再標 `done`。

## Spec Change Log

- 2026-11-24 第 1 輪審查（review_loop_iteration 1）：
  - 觸發的發現：E3、B1（相鄰名牌互相重疊，intent_gap）；E1、B2（最右邊的名牌超出畫布）。
  - 改了什麼（使用者 2026-11-24 選「重疊時往上錯開」並「保留現有程式」）：Decisions 加「名牌互不遮擋」「不出畫布」兩條；I/O 矩陣加「名牌互疊」「邊緣」兩列。
  - 避免的已知壞狀態：兩個以上 session 排成一列時，長名字的名牌互相蓋住；最右邊角色的名牌被畫布右緣切掉。
  - KEEP：既有的實作與測試全部保留，不 revert；只加上錯開、夾回畫布，以及 Review Triage Log 裡的 patch。

## Review Triage Log

第 1 輪（2026-11-24，review_loop_iteration 0）。來源：V＝Verification Gap、E＝Edge Case Hunter、B＝Blind Hunter。

| # | 發現 | 判定 | 依據 | 去向 |
|---|---|---|---|---|
| E3、B1 | 同一排相鄰角色的名牌互相重疊，後畫的蓋掉旁邊的名稱與狀態 | medium | 屬實：`rowLayout` 相鄰中心差 `bounds` 寬 × 大小 + 16（契約包 96 DIP），名牌最寬 152 DIP；沒名字的 session 顯示 36 字 UUID，一定截到最寬。凍結的決定沒涵蓋名牌與名牌之間，解法使用者看得到 | intent_gap（問使用者） |
| E1、B2 | 最右邊角色的名牌超出畫布右緣被切掉 | medium | 屬實：最右邊角色原點距右緣 24 + 40 = 64 DIP（契約包），名牌半寬最多 76 DIP | patch：名牌水平位置夾在畫布內 |
| V1 | 名牌水平位置的 `anchor.x × 大小` 沒有測試觀察得到 | low | 驗證層已查證：所有測試與契約包的 `anchor.x` 都是 0 | patch |
| V2、B6 | 「名牌在所有角色之上」只靠 `main.ts` 的 `addChild` 順序，沒有測試鎖住 | medium | 驗證層已查證：`pixi-stage.test.ts` 的兩個圖層沒有共同 parent，e2e 只讀數字 | defer（要調整圖層組裝方式才測得到） |
| B5 | 矩陣「context lost：還原後照常」對名牌沒有驗證 | low | 屬實：e2e 還原後的輪詢沒看 `drawnBadges` | patch：e2e 還原後斷言 `drawnBadges` 回到 `1` |
| E5、B4 | `fitText` 依 code point 截斷，會切開 ZWJ 表情、國旗等字素叢集；註解卻說不會切在字中間 | low | 屬實：`Array.from` 拆的是 code point；名稱來自 AI 標題，可能含表情 | patch：改用 `Intl.Segmenter` 的 grapheme 切分 |
| B7 | 名牌底色半透明，疊在白色視窗上時紅、粉、紫字對比不足 | low | 屬實：0.78 不透明度疊白底約 `#484a4b`，11px 小字對比低於 4.5:1 | patch：底色不透明度提高到 0.9 |
| B8 | 作者文件沒寫名牌尺寸、不隨大小縮放、可能超出或重疊；5.1 有一句重複 | low | 屬實 | patch |
| B9 | `Scene.resolution` 註解說「畫布放好前是 1」，但畫布已放好、沒有 actor 時也是 1 | low | 屬實（`buildScene` 回傳 `EMPTY`）；目前沒有人用 | patch：改註解 |
| B3、E4 | 125%、175% 縮放下名牌底邊落在半個裝置像素上變糊，貼圖實際高度與定位用的高度差 0.4 DIP | low | 屬實但只在非整數縮放、只差半個像素；修法要把版面改成以裝置像素取整 | reject |
| E2 | manifest 的 `anchor` 可以填離角色很遠的值，名牌會跑到畫面外 | low | 屬實，但只影響該包自己角色的名牌；`anchor` 的檢查是 3.1 的既有規則 | reject |
| E6 | sprite 貼圖還在載入或載入失敗時，看不到的角色上方仍有名牌 | low | 符合凍結的決定「場景裡的每隻 actor 都畫」；載入中只有短暫幾格 | reject |
| B10 | 拿不到 2D context 時產生透明空白名牌、照樣計數、沒有 log | low | Chromium 實際不會回 null；修法要加記錄分支 | reject |

## Verification

**Commands:**
- `npm run -s typecheck && npm run -s lint && npm run -s depcruise` -- 無錯誤
- `npx vitest run` -- 全部通過
