---
title: 'Story 3.7（下）：契約測試包 e2e 驗收'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_commit: '29a3aa1c2946ce7cd0251b5d247e6b522d63354d'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3.7 的 AC 要求用契約測試包驗收「一輪結束先演 `done` 5 秒，再轉 `waiting`」。上半段（`spec-3-7-state-placeholder.md`）的佔位只有單元測試；`main.ts` 把佔位 actor 排除在粒子之外、把 render loop 時間傳給佔位，這兩段接線沒有任何測試經過。

**Approach:** 在 `test/e2e/stage.spec.ts`（stage probe＝契約測試包換 id）加「過場」與「佔位」兩個測試，用真 Electron 驗收。overlay 多輸出一個佔位透明度的 data 屬性，讓 e2e 讀得到「有在起伏」。這段做完，3.7 的 AC 才算全部有測試。

**Decisions（2026-11-24）：**
- 驅動 `error`：e2e 的 Claude Code 合成紀錄加一種 API 錯誤紀錄（assistant，`isApiErrorMessage: true`，`stop_reason: 'stop_sequence'`），翻譯成 `error` 加 `turn.end`；`error` 優先於 `done`，持續 `errorHoldMs`（30 秒）。probe-one 沒實作 `error` 也沒有 `fallback` → 佔位。
- 時間基準：偵測以收到事件的時間起算 `done`，收到一定晚於 append，所以「`waiting` 最早在 append 前時間 T + 5000 出現」是穩定的下限。

## Boundaries & Constraints

**Always:**
- 探針只多做一件事：己方 actor 在 `frame` 裡的狀態跟上一則不同時，用 `stage.log` 寫一行 `awp-stage state <state>`（純 ASCII）。其他照舊，畫的仍是契約測試包。
- 新的 data 屬性 `placeholderAlpha`：有佔位時是這次 `draw()` 用的透明度（小數 3 位），沒有佔位時是 `none`；WebGL context lost 時也是 `none`。
- 新測試放在「粒子停止」之後、「加入與移出」之前，沿用檔內 serial 的同一個 session。

**Never:**
- 不改契約測試包、reducer、偵測計時、佔位外觀與規則。
- 不截圖、不讀像素。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 過場 | prompt 後送 answer，append 前記時間 T | StageView 在 T + 5000 前出現 `done`；`waiting` 第一次出現不早於 T + 5000（容許 50 ms）、不晚於 T + 15000；探針從 prompt 起的狀態行恰好是 `thinking`、`waiting`（沒有 `done`）；期間 `drawnPlaceholders` 一直是 `0`、`drawnActors` 是 `1` |
| 佔位 | prompt（thinking，sparkle 在畫）後送 API 錯誤紀錄 | 第一份 `drawnPlaceholders` 為 `1` 的 data 裡，`particleEmitters`、`drawnEmitters`、`drawnSprites` 都是 `0`，`hitAreas`、`drawnActors` 是 `1`；探針寫出 `awp-stage state error` |
| 起伏 | 佔位顯示中，隔約 300 ms 讀兩次 | 兩次 `placeholderAlpha` 都在 0.35～0.7 之間且不同 |
| context 還原 | 佔位顯示中，WebGL context lost 後還原 | lost 期間 `drawnPlaceholders` 是 `0`、`placeholderAlpha` 是 `none`；還原後回到 `1`，`hitAreas` 是 `1`；期間 overlay 沒有錯誤 log |

</frozen-after-approval>

## Code Map

- `test/e2e/helpers.ts`：`SyntheticTurn`（`:133`）加 `'error'`；`appendClaudeRecord`（`:139-159`）照 `claudeRecord`（`:91-105`）組 assistant 紀錄，頂層加 `isApiErrorMessage: true`，`message` 帶 text 內容與 `stop_reason: 'stop_sequence'`。翻譯規則見 `src/main/detection/adapters/claude-code/translate.ts:231-240`。
- `test/e2e/stage.spec.ts`：
  - `stageProbeEntry()`（`:82-117`）的 `frame` 包一層：比較 `message.actors[0].state` 與上次，不同就 `stage.log` 一行。
  - 「出現」（`:224-` 約 `:238-240`）的 `mapped` 在對應不到時要退回 `actor.state`（定案規則：送原狀態）。
  - 新增 helper：讀 run log 裡探針的狀態行（前綴 `pack stage-probe: stage.log: awp-stage state `），可取某個時間點之後的切片。
  - 「過場」「佔位」兩個新測試，以及佔位中的 context lost／還原（照 `test/e2e/bitmap.spec.ts:705-` 的做法，用 `loseOverlayContext`／`restoreOverlayContext`，`helpers.ts:509`、`:549`）。輪詢 StageView 用較密的間隔（例如 `intervals: [100]`）。
  - 檔頭註解補上這兩個測試與探針的狀態行。
- `src/overlay/renderer/pixi-stage.ts`：`StageCounts`（`:435`）加 `placeholderAlpha`（這次 `draw()` 算出的值）。
- `src/overlay/main.ts`：`drawFrame` 依 `counts.placeholders` 寫 `placeholderAlpha`（`none` 或 `toFixed(3)`）。
- `src/overlay/context-loss.ts`：`halt()` 把 `placeholderAlpha` 設為 `none`。
- **不要改：** 契約測試包、`src/main/**`、佔位的形狀與常數、其他 e2e 檔。

## Tasks & Acceptance

**Execution:**
- [x] `src/overlay/renderer/pixi-stage.ts`、`main.ts`、`context-loss.ts` -- `placeholderAlpha` data 屬性 -- 讓 e2e 讀得到起伏
- [x] 單元測試 -- `pixi-stage.test.ts` 斷言 `placeholderAlpha` 等於該次 draw 的透明度；`context-loss.test.ts` 斷言 lost 時設為 `none` -- 鎖住新欄位
- [x] `test/e2e/helpers.ts`、`test/e2e/stage.spec.ts` -- error 紀錄、探針狀態行、`mapped` 修正、「過場」「佔位」與 context 還原 -- 契約測試包驗收

**Acceptance Criteria:**
- Given 完成，when 執行 typecheck、lint、depcruise、`npx vitest run`，then 全部通過。
- Given push 到 main，when CI 跑完，then unit 與 e2e 在 macOS、Windows 都通過，含新增的「過場」「佔位」。

## Implementation Notes

- **本機不跑 e2e（使用者 2026-11-24 決定）：** 本機只跑 typecheck、lint、depcruise、`npx vitest run`；`npm run e2e` 會在桌面開出 Electron 視窗，不在本機執行，e2e 由 push 後的 CI 驗證。

- **第 1 輪審查修補（2026-11-24）：** 只改 `test/e2e/stage.spec.ts`：`lastStateAt()` 回傳輪詢讀到的那一行；「過場」先確認探針收到 thinking 再送 answer，並檢查 done 中間沒有閃成別的狀態，`WAITING_EARLY_MS` 註解寫明實際精度；「佔位」加上 30 秒期限的清楚失敗訊息、lost 期間不畫不接滑鼠、還原後仍在起伏、期間沒有丟棄或沙盒問題；「加入與移出」先送 prompt（`turn.start` 清掉 error）回到包的圖、`placeholderAlpha` 為 `none`，再 release。
- **本機驗證（2026-11-24，修補後）：** typecheck、lint、depcruise 通過；`npx vitest run` 5516 通過、2 略過。e2e 沒有在本機跑，等 push 後的 CI。
- **處理掉的 deferred-work 項目**（依流程不改既有條目，記在這裡）：`spec-3-7-state-placeholder.md` 的 e2e 驗收、`main.ts` 的 `particleActorsOf` 接線（V1）、`dtMs` 傳給 `draw`（V2，`placeholderAlpha` 起伏）、`stage.spec.ts` 的 `mapped` 算法（B16）。尚未處理的仍是 bitmap 包停在佔位時的 GC 堆積（未驗證）。
- **sprint-status：** 3.7 上下兩段都完成，`3-7-依狀態演出-後備與佔位` 改為 `review`；CI 通過、使用者實機驗收示範模式後再標 `done`。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-24，review_loop_iteration 0）。來源：V＝Verification Gap、E＝Edge Case Hunter、B＝Blind Hunter。行號是 `test/e2e/stage.spec.ts`。

| # | 發現 | 判定 | 依據 | 去向 |
|---|---|---|---|---|
| V1、B7 | `drawFrame` 在沒有佔位、context 正常時寫 `placeholderAlpha=none` 的分支沒有斷言 | low | 驗證層已查證：改成一律輸出數字，所有測試照過；唯一斷言 `none` 的是 `halt()` 那條路徑 | patch（併入 B8 的修法） |
| B1 | 「過場」的 `waiting` 下限用讀完後的時間比，實際精度是一個讀取週期（輪詢間隔加兩次 IPC），`WAITING_EARLY_MS` 50 ms 的註解誇大了精度 | low | 屬實：迴圈在第一次讀到 `waiting` 就停，所以下限只證明 `waiting` 不早於 T + 5000 減一個讀取週期 | patch（註解寫明實際精度） |
| B2 | 「過場」沒檢查 `done` 中間沒有閃成別的狀態 | low | 屬實：只取第一個 `done`、第一個 `waiting` 的時間 | patch |
| B3、E1 | 「佔位」整段要在 `errorHoldMs`（30 秒）內跑完，沒有時間防護；CI 慢時會在還原那步失敗、看不出原因 | medium | 屬實：各步輪詢上限加總遠超 30 秒；開發者會在 Windows CI 看到像 context 還原壞掉的失敗 | patch |
| B4 | context lost 期間沒斷言不接滑鼠、不畫 actor | low | 屬實：`whileLost` 只看 `drawnPlaceholders`、`placeholderAlpha` | patch |
| B5 | 還原後只看透明度格式，沒看有沒有繼續起伏 | low | 屬實：render loop 沒重啟時只會補畫一格，格式仍對；起伏那段的讀法可以重用 | patch（標題的「rises and falls」措辭不改） |
| B6 | 佔位與 context 掉失期間沒檢查 `draw` 被丟棄或沙盒出錯 | low | 屬實：「粒子停止」與 `bitmap.spec.ts` 都有這類檢查，新測試沒有 | patch |
| B8 | 「加入與移出」排在「佔位」後面，release 時 actor 還在佔位，`drawnSprites` 為 0 變成必然成立，despawn 拿掉 sprite 的路徑在本檔不再被測到 | low | 屬實：error 會再持續約 25 秒。`turn.start` 會清掉 `errorAt`（`src/main/detection/reducer.ts:317-323`），再送一次 prompt 就回到 thinking、畫回 sprite | patch |
| B9 | 兩個新測試對 probe-one 的前提（done→waiting、error 對應不到、分配到 probe-one）沒有從 `MANIFEST` 斷言 | low | 屬實，但契約測試包很少改，改了也會明確失敗；修法是另加前提斷言 | reject |
| B10 | `lastStateAt()` 讀兩次 run log，中間多寫一行會回傳別的狀態的時間 | low | 屬實但目前呼叫點都在狀態穩定時；直接回傳輪詢讀到的那一行即可 | patch |
| B11 | diff 處理掉的 deferred-work 項目沒同步結案 | low | deferred-work 依流程不改既有條目；結案記在本規格的 Implementation Notes | reject |
| E2 | 「過場」在 StageView 變 thinking 後立刻送 answer，探針可能還沒收到帶 thinking 的 `frame`，最後的狀態行斷言會無故失敗 | medium | 屬實：每包只有一則 `frame` 在途，thinking 要到下一則才送；偵測讀 answer 快時 thinking 可能沒送到探針 | patch |
| E3 | 偵測讀 answer 延遲超過 5 秒時，`done` 會在 T + 5000 之後才第一次看到，測試失敗 | false | 「T + 5000 前看到 `done`」是凍結的矩陣要求；偵測延遲超過 5 秒本身就該失敗 | reject |
| E4 | 最後一次讀取在期限前開始、期限後才回來，`waitingAt` 超過 T + 15000 | low | 要 `waiting` 晚到約 15 秒才會碰到，那時失敗是對的 | reject |
| E5 | 100 ms 輪詢可能沒讀到第一格佔位，殘留幾格的粒子會漏看 | low | sparkle 停止後要 500～900 ms 才消失、停止中的發射器仍計數，第一次讀到時仍會看見；修法要在頁面裝 MutationObserver | reject |

## Verification

**Commands:**
- `npm run -s typecheck && npm run -s lint && npm run -s depcruise` -- 無錯誤
- `npx vitest run` -- 全部通過
- `npm run e2e` -- 全部通過（本機是否執行見 Implementation Notes）
