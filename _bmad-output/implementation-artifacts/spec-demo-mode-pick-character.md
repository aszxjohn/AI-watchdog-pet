---
title: '示範模式：先清場、選角色，再切狀態（FR21 2026-11-24 修改）'
type: 'feature'
created: '2026-11-24'
status: 'review'
baseline_commit: '48d7e99638f8d4c481b6b068f6c11bf78b304654'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-demo-sessions-panel.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-4-pool-assignment.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:**
- 示範模式的假 session 照池子分配角色（Story 3.4），使用者沒辦法指定要看哪一隻。
- 舞台上同時還有真 session 的角色，看起來很亂。
- 2026-11-24 13:12 的實例：
  - 力天使已經分給一個 Claude Code session。
  - 示範 session 分到測試包的探針一。
  - 之後停用測試包也不會改派（3.4：池子變小，既有分配不動）。
  - 結果使用者切 8 個狀態，力天使都沒反應。

**Approach:**
- 示範模式改成開發用的獨立模式，跟一般模式互斥：舞台上兩種模式不會同時存在。
- 開啟時先清場，舞台只留示範角色。
- 角色由使用者從選單列挑，app 記住上次選的那隻。
- 8 個狀態都作用在這隻角色上。
- 關閉後回到一般模式，真 session 回到舞台。

**Decisions（2026-11-24，使用者選定）：**
- **清場：**
  - 示範期間，所有真 session 的角色都下台。效果跟「釋放」一樣：session 仍留在「管理 session」清單。
  - 示範期間才出現的新 session 也不給角色。
  - 關閉示範後全部自動回來。
  - 使用者的原話：原本的功能都停止，開啟專門播動畫的模式，結束時才回到一般運作模式；示範模式是開發用的工具。
- **選單位置：**
  - 在選單列「示範模式」子選單，依序是「關閉」、角色清單、8 個狀態。
  - 選角色就清場並開始示範，之後選狀態都作用在這隻。
- **角色清單：**
  - 列出所有已安裝、而且相容於這個舞台的角色，沒上場、沒加入池子的也列。
  - 上次選的排第一。
- **示範中改了角色包：**
  - 要即時重載，這是開發模式的目的。
  - 角色包被移除，或新版本沒有這個角色：結束示範。
  - 重新匯入取代（版本號有變）：畫布自己重載，示範照常。
- **記住上次的角色：**
  - 存在 `settings.json` 的新欄位 `demoCharacter`。
  - 記住的角色已經不在時，要「跳出來讓我選」。
- **剛選好角色時：** 先演「待機」，也就是「休息中」。
- **同版本重新匯入的即時重載：** 這次不做，見下方「待討論」。

## 待討論

- **同版本號重新匯入角色包時，畫布要不要即時重載（2026-11-24 使用者指定記為待討論）。**
  - **現況：**
    - overlay 的沙箱（pack-host）、外觀（looks.ts）、貼圖（textures）都以版本號當 key。
    - 同版本重匯後，StageView 的 `packs` 區段完全一樣。畫布不會重建沙箱，也不會重讀素材。
    - 版本號有變時，pack-host 會立刻拆掉舊沙箱、以新版本重建，素材 URL 也帶新版本。
  - **暫時的做法：** 重新匯入時把版本號加 1（例如 1.0.0 → 1.0.1）。
  - **要做的話會動到：**
    - `src/shared/packs.ts`：StagePack 要帶一個每次安裝都不同的值。
    - `main/packs` 的 store。
    - overlay 的 pack-host、looks、textures。
  - 範圍跟這次的示範模式無關，另開一個工作做。

## Boundaries & Constraints

**Always:**
- **示範模式的入口：**
  - 一律經過 `main/pool` 的示範模式（`demo-mode.ts`），它是唯一呼叫 `detection.setDemo` 和 `assigner.setDemo` 的地方。
  - 每次切換（清場、示範 session、記住角色）都在同一個 StageView batch 裡。
- **清場：**
  - 只動記憶體裡的分配。不改 `assignments.json` 的 `released`，面板也不會顯示「已釋放」。
  - 被收起的分配照常存進 `assignments.json`。這樣示範中 app 當掉，下次啟動時那些 session 仍沿用原角色。
  - 示範 session 的分配不存檔。
- **示範角色：**
  - 任何已安裝、相容的角色都可以，不看上場、加入池子。
  - 示範 session 被釋放也照樣演出。
  - 每次選角色（包括再選同一隻）都換新的 `actorId`，等於重新載入。
  - 出場次數不算示範的。
- **回到一般模式：**
  - 被收起的 session 先回來，條件跟「沿用上次分配」一樣：角色還在池子裡；畫面上已有同一隻時，要等池子全部都在台上才能重複。符合就用原角色，否則照一般規則挑。
  - 回來時都換新的 `actorId`，出場次數不重算。
- **示範模式本身不存檔：** 每次啟動都是關閉狀態，只有「上次選的角色」存在 `settings.json`。
- **log：** 不寫角色、包、session key。

**Never:**
- 不改偵測的判斷規則與 session 生命週期（`main/detection/**` 只改註解）。
- 不改 overlay、角色包、`packs/dynames/`。
- 不做同版本重載（見「待討論」）。

</frozen-after-approval>

## I/O & Edge-Case Matrix

| 情境 | 輸入／狀態 | 預期 |
|---|---|---|
| 選角色 | 示範關閉，從選單點一個角色 | 真 session 的角色全部下台；示範 session 以那隻角色演「休息中」；記住那隻；同一個 StageView 增量 |
| 切狀態 | 示範中點任一狀態 | 只有示範 session 換狀態，角色與 `actorId` 不變 |
| 休息中 | 示範中點「休息中」 | 示範 session 結束再重開，在同一次偵測變化裡完成，`actorId` 不變 |
| 換角色 | 示範中點另一隻 | 示範 session 改演那隻，從「休息中」開始；再點同一隻：換新的 `actorId`（重新載入） |
| 從狀態開啟 | 示範關閉，點一個狀態，記住的角色已安裝 | 直接用記住的角色演那個狀態 |
| 跳出選單 | 示範關閉，點一個狀態，沒記住或記住的已不在 | 從選單列圖示跳出「選擇示範角色」選單；選了才開始，沒選什麼都不做 |
| 沒有角色 | 一個角色都沒安裝，點一個狀態 | 示範 session 照常出現在面板，沒有角色（FR24） |
| 示範中來新 session | 示範中出現新的真 session | 列在面板，不給角色 |
| 關閉 | 點「關閉」 | 示範 session 結束；被收起的 session 帶原角色回來（換新 `actorId`）；示範中才來的照一般規則挑 |
| 回來時角色已離開池子 | 示範中把某 session 原本的角色移出池子，再關閉 | 那個 session 照一般規則挑 |
| 示範中結束或被釋放 | 被收起的 session 結束或被釋放後再關閉 | 不回來 |
| 角色包移除 | 示範中的角色所在包被移除，或新版本沒有這個角色 | 結束示範，舞台恢復 |
| 版本號更新 | 示範中重新匯入新版本，角色還在 | 示範照常，畫布重建沙箱並重讀素材 |
| 停用或移出池子 | 示範中把示範角色的包停用，或把角色移出池子 | 示範照常（示範不看池子） |
| 同版本重匯 | 示範中重新匯入同版本 | 畫布不會重載（待討論） |
| 重新啟動 | 示範中結束 app 再開 | 示範關閉；真 session 沿用原角色 |

## Code Map

- **`src/shared/settings.ts`：**
  - 新增欄位 `demoCharacter: CharacterKey | null`，預設 null。
  - 舊檔沒有這個欄位時取預設值，不用遷移。
- **`src/main/pool/assign.ts`：**
  - 新增 `setDemo(DemoStage | null)`。
  - 示範中：其他來源的 actor 收起（`parked`）；`demo` 來源的 session 演指定角色（`demoActors`）。
  - 關閉後：收起的先回來。
  - 存檔時排除示範的分配，包含收起的分配。
- **`src/main/pool/demo-mode.ts`（新）：**
  - 示範模式控制器：`pickCharacter`、`pickState`、`stop`、`view`／`onChange`、`watch`（跟著已安裝的包與設定）。
  - `demoCharactersOf` 排出角色清單。
- **`src/main/windows/menu.ts`：**
  - 「示範模式」子選單改成「關閉／角色／狀態」三組，依 `DemoMenuState` 建。
  - 新增「選擇示範角色」選單的範本。
- **`src/main/windows/tray.ts`：**
  - `createTray` 多帶示範狀態。
  - `showTrayDemo` 重建選單。
  - 點任一個示範項目後也重建，把 Electron 自己移動的勾選改回來。
  - `popUpDemoCharacters` 從圖示跳出角色選單。
- **`src/main/main.ts`：**
  - 建立示範模式：在 StageView 之後，接 `stageView.batch`、`popUpDemoCharacters`。
  - 選單列的動作接到示範模式；示範模式一有變化，就重建選單。
- **註解：**
  - `demo.ts`：檔頭的入口說明。已知限制「休息中可能換 actor」已不成立。
  - `detection.ts`：`watchDemoState` 不再接選單列。
- **面板提示：** `session-rows.ts` 的 `DEMO_MODE_HINT`。
- **測試：**
  - `test/main/pool-demo-mode.test.ts`（新）：
    - 控制器在假物件上的行為。
    - 照 main.ts 接線，點選單範本重現 13:12 的實例。
  - `pool-assign.test.ts`：補「示範模式的舞台」一組測試。
  - `windows-tray.test.ts`：改成新的子選單、重建選單、跳出角色選單。
  - `windows-main.test.ts`：改成新的接線。
  - `settings*.test.ts`：補新欄位。

## Tasks & Acceptance

**Execution:**
- [x] 設定新欄位 `demoCharacter`。
- [x] 分配器的示範舞台（`setDemo`）。
- [x] 示範模式控制器。
- [x] 選單列子選單、重建、跳出角色選單。
- [x] main.ts 接線。
- [x] 註解與面板提示。
- [x] 測試，涵蓋 I/O 矩陣（同版重匯除外）。
- [ ] 使用者實機驗收。

**Acceptance Criteria:**
- Given 改完，when 執行 `npm run typecheck`、`npm run lint`、`npx vitest run`、`npm run depcruise`，then 全部通過。
- Given 使用者的 app 重新打包並重開，有真 session 在台上，when 從選單列「示範模式」點力天使、再逐一點 8 個狀態，then 舞台只有力天使，每個狀態都換動作；點「關閉」後，真 session 帶原角色回來。

## Implementation Notes

- **2026-11-24 開發代理自行決定的部分：**
  - 「待機」對應到「休息中」（`idle`）。
  - 「跳出來讓我選」做成從選單列圖示跳出的原生選單（`tray.popUpContextMenu`），不另開視窗：
    - app 平常沒有 Dock 圖示，對話框可能跑到其他視窗後面。
    - 選單一定看得到。
    - Linux 不支援 `popUpContextMenu`，那裡不會跳出。
  - 從「關閉」狀態點某個狀態時：
    - 記住的角色還在，就直接用它演那個狀態；不在才跳出選單。
    - 一個角色都沒安裝時，照舊開示範（面板看得到）。
  - 選單勾選以示範模式記錄的為準，不再跟著 detection 的回報。現在只有示範模式會呼叫 `detection.setDemo`，`watchDemoState` 留著，但 main.ts 不再用它。
  - 示範中的「關閉」順序是先結束示範 session、再還舞台。如果反過來，示範 session 會短暫拿到池子角色。

## Spec Change Log

## Review Triage Log

## Verification

**Commands（2026-11-24 13:45，本機執行）：**
- `npx vitest run`：115 個檔通過、1 個略過；5486 個測試通過、2 個略過。
- `npm run typecheck`：通過。
- `npm run lint`：通過（oxlint、oxfmt）。
- `npm run depcruise`：沒有違規。

**Manual checks：**
- **2026-11-24 13:52 實機（重新打包的 `out/`），依 run log 核對：**
  - 選力天使：收起 1 個 actor，示範 session 演「休息中」，`demoCharacter` 記成 `dynames/dynames`。
  - 切到「工作中」。
  - 示範中把 4 個已釋放的 session 改回顯示，它們沒有拿到角色。
  - 關閉：1 個帶原角色回來，4 個照一般規則分配（池子只有力天使，所以都是力天使）。
  - 整段沒有錯誤。
- **尚未實機確認：**
  - 其餘 6 個狀態，本次只點了「休息中」和「工作中」。
  - 示範關閉時直接點狀態，是否會用記住的角色開始。
  - 跳出「選擇示範角色」選單：只能在 macOS 實機確認，單元測試用的是假 Tray。
  - 動作畫面要靠使用者目視，log 看不到。
