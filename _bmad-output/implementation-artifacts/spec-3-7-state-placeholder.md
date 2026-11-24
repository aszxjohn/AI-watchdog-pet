---
title: 'Story 3.7（上）：佔位演出'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_commit: '75bcbea8bcb1b39cc30d4008ed6bc6e6145371fc'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.6 已經照 `states`／`fallback` 對應狀態，但兩者都對應不到時舞台什麼都不畫，角色等於消失。作者文件第 11 節也還沒定案「佔位時 `frame` 送哪個狀態」。

**Approach:** 狀態對應不到時，舞台在 actor 的位置畫內建佔位，並整則忽略該 actor 的 `draw`，直到狀態變回對應得到。契約測試包的 e2e 驗收另外做（deferred-work）。

**Decisions（2026-11-24）：**
- **佔位外觀（使用者選 A）：** 半透明灰色的簡單人形剪影（圓頭加圓角身體），填在 `hitbox` 範圍，約 2 秒一次透明度起伏。8 種狀態同一個樣子，狀態由 3.8 的標記表示。
- **佔位時 `frame` 送原狀態：** 維持 3.6 的行為。包知道真實狀態，可以自己收尾；它的 `draw` 反正被忽略。作者文件寫成定案。
- **佔位接住滑鼠：** 看得到就接得到，範圍是 `hitbox` × 大小。
- **「忽略」只看目前狀態：** 對應不到時 sprite、bitmap、粒子都不畫；狀態一變回對應得到，就用包最新的 `draw`，跟一般狀態切換一樣可能晚一格。
- **佔位不等沙盒：** 角色外觀（manifest）到了、actor 有位置就畫。

## Boundaries & Constraints

**Always:**
- 佔位畫在 actor 當下的世界位置，乘「大小」，套 `bounds` 裁切，跟其他 actor 一起依 y 排序。
- 佔位是內建的 PixiJS Graphics，不載入素材。動畫用 render loop 的時間（ticker 的 deltaMS，跟粒子一樣），render loop 停下時佔位也停住。
- overlay body 新增 `drawnPlaceholders`；`drawnActors` 也算佔位 actor；WebGL context lost 時歸零。

**Never:**
- 不改 `fallback` 對應規則、manifest 檢查、reducer 計時，也不改契約測試包。
- 找不到包或角色的 actor 維持 3.6 的處理（不畫、記一行）。
- 不做名牌與狀態標記（3.8）、包失敗時的佔位（3.9）、e2e（deferred）。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 有實作 | `states` 有該狀態 | `frame` 送原狀態，畫包的 `draw` |
| fallback | 只有 `fallback` 有 | `frame` 送指定的狀態，畫包的 `draw`；契約測試包 probe-one 的 `done`、`waiting` 都送 `waiting` |
| 佔位 | 兩者都沒有 | `frame` 送原狀態；畫佔位（`hitbox` × 大小、`bounds` 裁切、透明度起伏）；`draw` 整則忽略；接住滑鼠 |
| 空 draw | 對應得到，`draw` 給空陣列 | 不畫、不接滑鼠、不出佔位 |
| 漏回 | 對應得到，`draw` 沒列它或還沒有 `draw` | 不畫、不出佔位（同 3.6） |
| 沙盒還沒好 | 對應不到，還沒有任何 `draw` | 照樣畫佔位 |
| 狀態變回 | 佔位 → 對應得到 | 佔位消失，用包最新的 `draw` |
| 資源 | 進入佔位前有 bitmap、粒子 | bitmap 照 3.6 釋放，發射器停止 |
| context lost | 佔位顯示中 | 計數歸零 |

</frozen-after-approval>

## Code Map

- `src/overlay/renderer/scene.ts`：`buildScene` 在 `mappedState(...) === null` 時是 `continue`（約 `:289`），改成推一個佔位 actor：`SceneActor` 加 `placeholder?: LocalBox`（角色的 `hitbox`），`sprites`、`emitters` 空，沒有 `bitmap`。areas 的篩選加上「是佔位」。模組註解（`:10-20`、`:37-43`）跟著改。
- `src/overlay/renderer/placeholder.ts`（新）：純函式，依 `hitbox` 給剪影形狀、依時間 ms 給透明度。不 import PixiJS；常數放這裡。
- `src/overlay/renderer/pixi-stage.ts`：`ActorNode`（`:401-411`）加佔位用的 Graphics，需要時建立，`hitbox` 改變時重畫（比照 `bounds` 字串 key），不再是佔位或離場時 destroy。`draw(scene, dtMs = 0)` 累計時間；`StageCounts`（`:414-419`）加 `placeholders`。
- `src/overlay/main.ts`：`drawFrame`（`:203-238`）把 `dtMs` 傳給 `draw`，`show('drawnPlaceholders', …)`；檔頭註解補佔位。
- `src/overlay/context-loss.ts`：`halt()`（`:191-206`）歸零 `drawnPlaceholders`。
- 註解：`src/overlay/world/states.ts:8-12`、`src/shared/pack-api/messages.ts:38-41`、`:137`。
- `docs/pack-api-v1.md`：3.2（`:171-192`）補 `frame` 送原狀態、佔位範圍與滑鼠、空 `draw` 不觸發佔位；第 11 節（`:614-626`）刪掉該項，加進「已定案」。
- **不要改：** `mappedState`／`sentState`、`stage-messages.ts` 的送法、`checkDraw`／`receiveDraw`、3.6 的 bitmap 與粒子規則、契約測試包、`src/main/**`、`test/e2e/**`。

## Tasks & Acceptance

**Execution:**
- [x] `src/overlay/renderer/placeholder.ts`、`scene.ts` -- 佔位 actor 與 hit area -- 角色不消失
- [x] `src/overlay/renderer/pixi-stage.ts`、`src/overlay/main.ts`、`src/overlay/context-loss.ts` -- 畫佔位、計數、歸零 -- 畫出來
- [x] 註解與 `docs/pack-api-v1.md` -- 定案 -- 文件與實作一致
- [x] 單元測試 -- `test/overlay/scene.test.ts:242` 改成佔位並補矩陣各列（`describe('I/O matrix')`、標題 `'<列名>: …'`）；新增 `test/overlay/placeholder.test.ts`；`pixi-stage.test.ts` 用真 PixiJS 測建立、重畫、destroy；`stage-messages.test.ts` 用契約測試包 manifest 測 probe-one `done`→`waiting`、probe-two `waiting`→`done`、`error` 送原狀態；`context-loss.test.ts` 歸零 -- 鎖住行為

**Acceptance Criteria:**
- Given 完成，when 執行 typecheck、lint、depcruise、`npx vitest run`，then 全部通過；既有斷言只因「對應不到改畫佔位」而改動。
- Given 示範模式選契約測試包的 probe-one，when 依序選「要你批准」「工作中」，then 先畫佔位、滑鼠移上去會接住，再換成包的圖。

## Implementation Notes

- **佔位 actor 的粒子：** 文件 8.1 原本就寫「這一則沒畫它（漏回、狀態對應不到）……發射器與粒子立刻移除」，所以佔位 actor 不送進 `particles.sync`（`scene.ts` 新增 `particleActorsOf()`，`main.ts` 用它），`particles.ts` 照它對「沒畫的 actor」的既有規則立刻移除發射器與粒子；`particles.ts` 只改註解。若改成把佔位 actor（`emitters` 空）送進去，會變成「停止發射、粒子淡出」，跟 8.1 和 Decisions 的「粒子都不畫」衝突。
- **透明度時鐘：** `pixi-stage` 累計 `draw(scene, dtMs)` 給的時間（取一個週期的餘數），所有佔位同步起伏；`dtMs` 為 0、負數或非數字時不動。
- **外觀常數**（`placeholder.ts`）：灰 `0x9e9e9e`、透明度 0.35～0.7、週期 2000 ms；頭半徑取 `min(寬×0.3, 高×0.17)`，頸部間隔為頭半徑×0.25，身體佔 `hitbox` 全寬到底，圓角 `min(寬×0.35, 身高/2)`。
- **第 2 條驗收（示範模式手動操作）沒有執行**：要啟動 Electron 視窗，留給使用者。
- **第 1 輪審查修補（2026-11-24）：** 只改文件與註解，沒有程式改動。作者文件 3.2 改為 `init`、`spawn`、`frame` 都送原狀態，並提醒包會收到 `states` 以外的狀態碼；補上佔位期間 `draw` 仍照 8.1 檢查與計入上限、`badges` 關閉時沒有標記、要等 manifest 載入才畫。第 7 節 `state` 與 8.1 粒子段（佔位也接滑鼠）跟著改。另外改了 `spawnMessageSchema` 的註解與 `pixi-stage.ts` 檔頭的措辭。
- **本機驗證（2026-11-24 15:40，修補後）：** typecheck、lint、depcruise 通過；`npx vitest run` 5515 通過、2 略過。e2e 沒有在本機跑，交給 CI。
- CI：commit `29a3aa1`（2026-11-24）後，GitHub Actions 的 unit（check）與 e2e 在 macOS、Windows 都通過（run 45349987270）。
- **實機驗收（2026-11-24，16:16 重新打包的 `out/`）：** 使用者回覆通過：示範模式選探針一，「要你批准」畫出會起伏的灰色剪影並接住滑鼠，「工作中」換回包的圖（第 2 條 AC）。
- **sprint-status：** 這份規格只是 3.7 的上半段，e2e 驗收已拆到 deferred-work，所以 `3-7-依狀態演出-後備與佔位` 維持 `in-progress`，不改成 `review`。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-24，review_loop_iteration 0）。來源：V＝Verification Gap、E＝Edge Case Hunter、B＝Blind Hunter。

| # | 發現 | 判定 | 依據 | 去向 |
|---|---|---|---|---|
| V1 | `main.ts` 用 `particleActorsOf` 濾掉佔位 actor 這段接線沒有測試經過 | medium | 驗證層已查證：改回 `particles.sync(scene.actors)` 單元測試全過，粒子會在佔位上淡出 | defer（e2e 已由 intent 排除） |
| V2 | `main.ts` 把 `dtMs` 傳給 `draw` 沒有驗證 | medium | 驗證層已查證：拿掉後佔位不起伏、測試全過；沒有可讀的 data 屬性 | defer |
| E1、E5、B6 | 佔位不到一格就切回、最新 draw 還是進佔位前那則時，那張 bitmap 已被 `release` 關掉，`closed.has` 擋下，bitmap 少畫 | low | 屬實（`pixi-stage.ts:511-521`、`:542`）。但佔位期間包每格都收到 `frame` 並回新圖，只有佔位短於一次往返才會發生，最多少畫約一格；修法要加隱藏而不釋放的狀態 | reject |
| E2、B5 | 佔位期間包送的 bitmap 沒顯示就被取代，全交給 GC，可能堆積 | maybe-false | 規則本身是 3.6 的（`host.ts:62-66`）；佔位讓「從不顯示」變成持續狀態。是否真的堆積要看 Blink 是否把 ImageBitmap 計入 V8 外部記憶體、GC 會不會及時觸發；要在真 Electron 讓 bitmap 包停在佔位幾分鐘量 GPU／行程記憶體才能定 | defer（未驗證，若屬實為 medium） |
| E3 | 包失敗時對應不到的 actor 畫佔位、對應得到的不畫 | low | 屬實，但佔位部分是凍結的決定「佔位不等沙盒」，失敗包的其他 actor 不畫是 3.6 既有行為，intent 明列「包失敗時的佔位（3.9）」不在本段 | reject（intent 排除） |
| E4、B8 | `SceneActor` 型別允許 `placeholder` 與 sprite／bitmap 並存，pixi-stage 會兩邊都畫 | false | `buildScene` 是 `SceneActor` 唯一的產生者，佔位 actor 一律 `sprites: []`、`emitters: []`、沒有 `bitmap`（`scene.ts:309-330`），沒有能走到的路徑 | reject |
| B1 | 文件「角色一上台就畫佔位」講太滿，實際要等 manifest（look）到 | low | 屬實（`scene.ts` 要 `packLook` 才放置 actor） | patch |
| B2 | 文件說狀態看標記，但 `badges` 關閉時沒有標記、各狀態佔位一樣 | low | 屬實；直接補一句 | patch |
| B3 | 文件只寫 `frame` 送原狀態；`init`、`spawn` 也是，且沒提醒包會收到 `states` 以外的狀態碼；第 7 節 `state` 說明未跟上 | low | 屬實（`stage-messages.ts:139` 的 `sentState` 同時用在 init／spawn） | patch |
| B4 | 文件說佔位 actor 的 `draw`「反正不會畫」，沒講它仍照 8.1 檢查與計入上限 | low | 屬實（`checkDraw` 不看狀態，違規整則丟棄） | patch |
| B9 | `placeholder.test` 用正則檢查 import，抓不到 side-effect／動態 import | low | 屬實，但要有人在純函式檔加 `import 'pixi.js'` 才會漏；修法是新增 depcruise 規則 | reject |
| B10 | `pixi-stage.ts` 檔頭「an actor drawn as it is」意思讀反，且一行超過 80 字 | low | 屬實 | patch |
| B11 | 文件 8.1 粒子段「只看有沒有畫出 sprite 或 bitmap」漏了佔位 | low | 屬實（`docs/pack-api-v1.md:441`） | patch |
| B12 | 測試裡 probe-one／probe-two 的 hitbox 是複製的字面值 | low | 屬實但只是測試整潔；manifest 改了測試會明確失敗 | reject |
| B13 | 多個佔位同步起伏沒測；`elapsedMs` 沒佔位時也累計，新佔位起始相位任意 | low | 屬實，但規格沒要求起始相位，看不出差別 | reject |
| B14 | 中灰背景上透明度低點幾乎看不到，卻接住滑鼠 | low | 背景剛好接近 `0x9e9e9e` 才會發生；外觀是使用者選的 A，加描邊會改變已核准外觀，交給手動驗收時看 | reject |
| B15 | `context-loss.test` 新案例跟既有歸零斷言重複，還原路徑沒測 | low | 屬實但只是測試冗餘；還原後重畫走一般 `drawFrame`，不是佔位特有 | reject |
| B16 | `test/e2e/stage.spec.ts:238-240` 的 `mapped` 算法對應不到時得 `undefined`，跟定案規則（送原狀態）不一致 | low | 屬實，既有程式、不在本段 diff；目前 e2e 起始狀態都對應得到 | defer |

## Verification

**Commands:**
- `npm run -s typecheck && npm run -s lint && npm run -s depcruise` -- 無錯誤
- `npx vitest run` -- 全部通過
