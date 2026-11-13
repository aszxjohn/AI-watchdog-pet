---
title: 'Epic 2 驗收用：每個 session 一個方塊'
type: 'feature'
created: '2026-11-13'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-epic-2-demo-square-shell.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 畫布上只有示範 session 有方塊。真實的 AI session 只看得到面板，畫布上什麼都沒有。角色包要到 Epic 3 才上台，使用者在 Epic 2 驗收時看不到「畫布上演出每個 session」的樣子。

**Approach:** 把示範方塊空殼擴大成每個 session 一個方塊，畫法照舊：色塊跟著狀態變，上面寫中文狀態名。畫布只依 StageView 的 `sessions` 與 `pool` 區段來畫。示範方塊是其中一個，右鍵選單照舊。仍然只供驗收用，Epic 3 真角色上台後移除。

## Boundaries & Constraints

**Always:**
- 版面：方塊照面板的順序（來源、名稱、key），由左到右排，整排靠畫布右下角。邊長、右邊距、下邊距沿用示範方塊（120、24、96 DIP），方塊間隔 16 DIP。一排放不下就往上換排；整個畫布放不下的方塊不畫。
- 狀態改變時方塊位置不動。只有 session 出現、結束（或依決定釋放）時，後面的方塊才補位。
- 面板的排序與「沒有顯示名稱時用原生 id」的規則搬到 `src/shared` 共用，面板行為與既有斷言不變。
- 只在方塊與文字有變時重畫，仍然沒有 render loop。舊的 `Text` 物件要 destroy，不累積。

**Never:**
- 不改 main 端：IPC、穿透切換、右鍵選單、`detection`、`pool` 都不動。
- 不做拖曳、遊走、角色包、池子分配。

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 沒有 session | 清單是空的 | 畫布是空的，不接收滑鼠 |
| 多個 | 11 個 session | 11 個方塊，照面板順序，靠右下 |
| 狀態變 | 某 session 從思考中變工作中 | 只有它的顏色與文字變，所有方塊位置不動 |
| 新 session | 多出一個 | 依排序插入，後面的方塊補位 |
| 結束 | 某 session 結束 | 它的方塊消失，後面的方塊補位 |
| 名稱太長 | 顯示名稱超過上限 | 截斷並加「…」 |
| 沒名稱 | `displayName` 為 null | 用原生 id（一樣會截斷） |
| 推測 | 狀態是推測的 | 方塊上標「推測」 |
| 示範 | 打開示範模式 | 示範方塊在它的排序位置；右鍵選單照舊 |
| 放不下 | 方塊數超過整個畫布 | 多的不畫，其他照常 |

</frozen-after-approval>

## Open Questions

1. **已釋放的 session 要不要畫方塊？**
   - **A（建議）** 不畫。等同 Story 3.4「釋放的不分配角色」，在畫布上就看得到釋放的效果。示範 session 釋放後方塊也會消失，右鍵選單跟著不能用，要改從選單列切狀態。
   - **B** 照畫，但淡化，跟面板一樣。
2. **方塊上寫什麼？**
   - **A（建議）** 上方小字寫 session 名稱（太長截斷），中間大字寫狀態名，推測的狀態在下方小字寫「推測」。看得出哪個方塊是哪個 session。
   - **B** 只寫狀態名，跟現在的示範方塊一樣。分不出哪個方塊是哪個 session，要對照面板。
3. **真實 session 的方塊接不接收滑鼠？**
   - **A（建議）** 不接收，完全穿透。只有示範方塊接收滑鼠（右鍵選單）。11 個方塊不會擋住下面視窗的點擊。
   - **B** 都接收。真實 session 右鍵開一個有「釋放」的選單。這要新增選單與 IPC，範圍變大。

## Code Map

- `src/overlay/demo-square.ts` → 改名為 `session-squares.ts`：
  - `sessionSquares(view)` 依 `sessions`（與 `pool`）算出每個方塊：位置、邊長、顏色、文字色、狀態名、名稱、是否推測。
  - 顏色表、亮底深字的規則、邊距常數沿用。
  - 只把接收滑鼠的方塊轉成 `HitArea`。
- `src/overlay/canvas-input.ts`：從單一方塊改成方塊清單。比較、`draw`、`areasChanged` 的流程不變。
- `src/overlay/main.ts`：
  - 一個 `Graphics` 畫所有色塊，每個方塊配自己的 `Text`（名稱、狀態、推測）。
  - 清單變了就重建 `Text`，舊的 destroy。
- `src/shared/`：把 `src/panels/session-rows.ts` 的排序（`sourceOrder`、名稱、key）與名稱規則抽成共用函式，放在 `stage-view.ts` 或新檔。`session-rows.ts` 改用它們，輸出不變。
- 測試：
  - `test/overlay/demo-square.test.ts` → `session-squares.test.ts`：每列矩陣、換排、放不下、亮底深字。
  - `test/overlay/canvas-input.test.ts`：多個方塊；只有接收滑鼠的方塊進 hit area。
  - `test/shared/`：共用排序與名稱。
  - `test/panels/session-rows.test.ts` 的既有斷言不變。

**不要改：** `src/main/**`、`src/preload/**`、`src/overlay/pointer.ts`、`src/overlay/start.ts`。

## Tasks & Acceptance

**Execution:**
- [ ] `src/shared/`、`session-rows.ts`：抽出共用排序與名稱規則，加測試，面板測試不變。
- [ ] `session-squares.ts`、`canvas-input.ts`：算出方塊清單與 hit area，涵蓋 I/O 矩陣的每一列。
- [ ] `src/overlay/main.ts`：畫多個方塊與文字。

**Acceptance Criteria:**
- Given 這次改動完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過；`pointer.ts`、`canvas-window`、`menu` 與面板的既有斷言不變。

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。

**Manual checks (if no CLI):**
- 使用者實機驗收：打包版開著真實 AI session 時，畫布右下有對應數量的方塊，名稱與狀態跟面板一致；示範方塊右鍵照舊。
