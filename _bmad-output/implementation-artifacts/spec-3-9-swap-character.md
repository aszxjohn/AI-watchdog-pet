---
title: 'Story 3.9（上）：換角色'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_commit: 'a3003ffaf1309dab675b32b1c0993b7446f4e3aa'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 3.4 決定池子在執行中變小時，已分配的角色不動，換角色留給 3.9。所以包停用、移除、角色退出池子，或新版本沒有那個角色之後，畫面上仍演著已經不在池子裡的角色。

**Approach:** `main/pool` 協調分配時，一般模式下角色已不在目前池子的分配立刻結束；同一次協調裡，再照既有的挑角色規則給那個 session 新角色和新的 `actorId`。池子空了就不給。

**定案（2026-11-25，使用者選擇把 3.9 拆兩段、先做這段）：**

- 觸發：一般模式下，分配的角色不在目前的池子裡。池子＝上場且相容的包 × 加入池子的角色，所以包停用、移除、不相容，角色退出池子，新版本沒有該角色，都會觸發。
- 同一次協調先結束所有受影響的分配，再依 `sessions` 順序挑新角色，所以不會挑到正要離場的角色。挑法沿用既有規則：池子用完前畫面上不重複，用完才重複，挑出場次數最少的。換上的角色計一次出場。
- 新 actor 站在原 session 的位置。舞台依 `actors` 順序排位，world 依 `actorId` 的差異自動送舊 actor `leave`、新 actor `enter`。
- 池子空了：session 留在管理清單，沒有角色（面板顯示「沒有角色」）。
- 池子變大時不換回：已有角色的 session 不動，只補給沒有角色的 session（3.4 規則不變）。
- 示範模式不看池子（既有行為不變）。示範結束後回來的 session，照既有規則重新檢查池子。
- 換角色和觸發它的 settings／packs 變更，在同一個 StageView 增量裡發佈（沿用既有的 batch）。
- 不在這段：執行失敗的偵測、重啟與失敗標記（3.9 下，已記在 deferred-work）。

</frozen-after-approval>

## Implementation Notes

- `src/main/pool/assign.ts`：`reconcile` 把 `pool`／`inPool` 移到 live 迴圈之前算；一般模式（`demo === null`）下，角色不在 `inPool` 的分配跟「session 消失／被釋放」一樣在迴圈裡結束，它的 session 仍在 `due`，由後面既有的 `pickCharacter` 迴圈補上（新 `actorId`、`appeared()` 計次）。示範模式的分支不動，所以示範角色與停車中的分配都不受影響（停車的回來時本來就會檢查 `inPool`）。檔頭註解與 `reconcile` 說明改寫成新規則，拿掉「An actor never changes character here (3.9)」。
- log：`assignments:` 那行的 `ended` 後面加 `(N out of the pool)`，只有計數，不帶 session、角色或 actor id。
- 存檔：換角色會讓 `ended`、`added` 大於 0，既有的 `save()` 條件就會存，不用另外處理。
- 位置與 `enter`／`leave`：沒有改 overlay。`actors` 依 `sessions` 順序，`rowLayout` 依 `actors` 順序排位，所以新 actor 站在原 session 的位置；`world.ts` 依 `actorId` 差異送 `leave`／`enter`，換角色自然產生。
- 測試：`test/main/pool-assign.test.ts` 把舊的「池子變小：角色不動」改成五個測試（包未上場、角色退出池子、移除與新版本少角色同時發生、包不相容、池子空了再變大），另加一個「示範角色不受換角色影響」；`test/main/settings-patch-batch.test.ts` 的 `packs:remove` 測試改為 `actors`、`characters`、`packs` 同一個增量，另加「`setPackEnabled` 關閉唯一的包，`settings` 與 `actors` 同一個增量」。
- 本機檢查（2026-11-25，審查修正後重跑）：`npm run -s typecheck`、`npm run -s lint`、`npm run -s depcruise` 通過；`npx vitest run` 117 個檔案、5568 個測試通過（2 個原本就 skip）。e2e 沒有在本機跑（會開視窗），等 CI。
- sprint-status：3.9 還有（下）半段，所以 `3-9-角色包當掉與換角色` 維持 `in-progress`、不同步成 `review`，在該行加註說明。
- 3.9（下）當掉偵測與重啟已記在 `deferred-work.md`（source_spec: none）；之後失敗標記只要讓 `poolOf` 排除失敗的包，就會走這段的換角色。

## Review Triage Log

Blind Hunter（2026-11-25），10 條：

1. 新 actor 不一定站在原位置（外觀還沒載入時不排位；新舊寬度不同時，後面的角色會移動）。**low**，屬實：`scene.ts` 約 `:345` 外觀沒到就 `continue`，`rowLayout` 依寬度排。外觀延遲只有短暫一下，而 session 結束本來就會讓後面的角色移位，Epic 4 遊走後整列排位也會換掉。**patch** 只修 `src/overlay/world/layout.ts` 檔頭說法（新 session 不推動別人；離場與換角色會），不改行為。
2. 整合測試只測池子變空，沒測到真的換成另一個角色。**medium**，屬實。**patch**：`settings-patch-batch.test.ts` 新增「`setFixed` 把探針一移出池子 → 同一 session 換成探針二、新 actorId、`actors`／`characters`／`settings` 同一個增量」；原本池子變空那個改名為「合併：收回」。
3. Implementation Notes 是空的。**false**：審查開始時還沒寫，之後已補上。
4. deferred 新條目寫 `source_spec: none`。**false**：step-01 拆段的範本就是 `none`，條目 evidence 已寫拆段原因。
5. sprint-status 沒反映拆段，oneshot 收尾會把 3.9 同步成 `review`。**medium**，屬實。**patch**：維持 `in-progress`，在該行加註上下兩段的狀態。
6. 第三條 AC（包更新後以原 actorId 重送）沒有測試鎖住 `init` 帶原 actorId。**medium**，屬實（行為由 `composeTick` 而來，但沒有斷言）。**defer**：記入 deferred-work，3.9（下）改重建流程時一起補。
7. 還沒上台的已存分配（`restored`），池子變小時不會立刻丟，池子在 session 出現前變回來就拿回舊角色，跟已上台的不對稱。**low**，屬實但罕見（要有尚未確認的來源，且池子在補讀期間先變小再變回），結果無害。**reject**。
8. log 計數變數叫 `swapped`，實際算的是「因不在池子而結束」。**low**，屬實。**patch**：改名 `leftPool`；log 文字本來就寫 `out of the pool`，不改。
9. 幾個新測試斷言較少，也沒測換角色時 actorId 產生失敗。**low**：失敗路徑跟新 session 完全相同（既有測試已涵蓋），第一個測試已斷言單次變更、存檔與出場次數。**reject**。
10. 沒有 e2e／手動驗收，3.4 驗收表 P3「取消上場→角色都不變」被推翻卻沒加註。P3 加註為 **low** 文件修正，**patch**（`epic-3-acceptance.md` P3 註明 3.9 起的新規則）。e2e 部分 **reject**：overlay 沒有改，`enter`／`leave` 與排位是既有行為；實機驗收照慣例在 CI 後打包給使用者做。
