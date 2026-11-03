---
type: implementation-readiness
date: '2026-11-03'
verdict: CONCERNS
inputs:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/specs/spec-ai-watchdog-pet-stage/SPEC.md
  - _bmad-output/specs/spec-ai-watchdog-pet-stage/glossary.md
  - _bmad-output/planning-artifacts/architecture/architecture-gundam-pet-2026-11-02/ARCHITECTURE-SPINE.md
---

# 開工前就緒檢查

## 結論：CONCERNS（可以開工）

規劃可以照現況開工：CAP-1～CAP-18 → FR1～FR25 → 36 個 stories 雙向都對得上，沒有孤兒需求；epic 之間沒有往前依賴（4 與 5 互不依賴的處理也寫進了 Story 4.3、5.1）；SPEC、術語表、架構規約、epics 之間沒有互相矛盾的規則。

下列問題都不影響 Story 1.1、1.2 與 Epic 1～2 的大部分 story，但要在「最晚處理時間」那個 story 開工前補上，否則開發者得自己發明決定。

## CONCERNS

| # | 問題 | 位置 | 最晚處理時間 | 建議處理方式 |
| --- | --- | --- | --- | --- |
| 1 | 固定參數「大小」「遊走偏好」的資料形狀沒有定義：欄位、型別、範圍、預設值、預設值來源都沒寫。Demo 的遊走是「每個狀態一組」（九宮格 `cells`、`strength`、`step`、`stay`、`speed`），新架構改成「每個角色一組」固定參數，manifest（AD-13）也沒有遊走預設值欄位。 | AD-11、Story 3.6、4.1、5.1 | 「大小」：Story 3.6；「遊走偏好」：Story 4.1 | 用 `bmad-correct-course` 補進 AD-11（或術語表），寫明欄位與預設值 |
| 2 | 閘門範圍的寫法不一致：AD-7 與 epics 的 Additional Requirements 寫「通過前不實作 `src/sandbox`、`overlay/pack-host` 與角色包 API」，角色包 API 就是 Story 3.1；但排序規則只寫「3.5 以後」。 | AD-7、epics.md 第 67 行、Story 3.1 | Story 3.1 | 已在 `sprint-status.yaml` 的 `sequencing_rules` 採較嚴格的寫法：3.1 也等閘門。照順序做時 3.1 本來就排在閘門之後，對時程沒有影響 |
| 3 | 有幾條架構規則沒有落到任何 story 的 AC：`bitmap` 指令／`stage.canvas`／`advancedBitmap`（AD-9、AD-16、AD-17）；`particles` 指令與 emitter 跨 frame 持續（AD-17）；連續 `drawTimeoutMs` 沒有有效 `draw` 視同失敗（AD-17）；載入時也要檢查 `apiVersion`（AD-8，目前只有安裝時，Story 3.2）；睡眠／鎖定時暫停 world 節拍與心跳（AD-24，寫在 Story 1.6，但節拍要到 3.6 才存在）；NFR5「完全不連網」沒有驗證方式。 | Story 3.2、3.5、3.6、3.9 | 各自的 story | 開這些 story 時把對應規則補進 AC |
| 4 | 有些 story 讀的檔案不在 AD-4 的唯讀來源表裡：2.5 讀 `session_index.jsonl`、2.7 用 slug 反查專案資料夾、6.1 讀 `workspace.yaml` 並支援 `COPILOT_HOME`。都還是唯讀，但 AD-4 寫「來源只有下表」。 | AD-4、Story 2.5、2.7、6.1 | Story 2.5 | 實作時同步更新 AD-4 來源表（6.1 本來就要求實測後更新） |
| 5 | Story 1.1 的前提「空的 main 分支（只有 BMAD 與 README）」和現況不同：根目錄還有 `.claude/`、`_bmad-output/`，以及 7 個只在本機排除的 Demo 資料夾（`assets`、`backups`、`build`、`characters`、`locks`、`preview`、`shelved`，約 6,400 個檔）。`create-electron-app` 可能拒絕在非空資料夾建專案；oxlint、tsc、dependency-cruiser 也可能掃到這些資料夾。 | Story 1.1 | Story 1.1 | 在暫存資料夾產生模板再搬進來；lint／typecheck 的範圍限定在 `src/`、`test/`、`prototypes/` |

## 備註（不算 CONCERNS）

- 沒有 UX 文件：狀態標記樣式、佔位演出、面板版面要在開發時決定。驗收標準可以測（例如「確定與推測看得出差別」），所以不列為問題。
- 運行常數與部分門檻的數值（`flushDebounceMs`、`sandboxIdleMs`、`heartbeatTicks`、`drawTimeoutMs`、各種上限、`discoveryWindowMs`、`sessionExpireMs`、`syncTimeoutMs`、`errorHoldMs`）架構規約已明訂「實作時給、只定義一處」，不算缺漏。
- Story key 由 `sprint_plan.py` 依中文標題產生，含中文字；之後 story 檔名會是 `<key>.md`。

## 排序規則（已寫進 sprint-status.yaml 的 `sequencing_rules`）

1. **沙盒閘門：** 1.1（專案骨架）→ 1.2（沙盒原型驗證）最先完成。四項都通過、原型報告標記閘門通過前，不開始 3.1 與 3.5 起的沙盒相關 story。閘門失敗時，1.3～1.6 與 Epic 2 仍可繼續，沙盒相關 story 停下，回頭修訂 AD-7 並請使用者確認。
2. **Copilot 最後：** Epic 6 排最後；Story 6.1 要用真實 Copilot CLI session 驗證過才能標 done。

## 處理紀錄（2026-11-03）

5 項 CONCERNS 已全部補進文件，結論可視為 PASS：

| # | 處理方式 |
| --- | --- |
| 1 | 使用者決定：大小 50%～200%（每格 10%，預設 100%＝包的原始大小）；遊走偏好四項（是否遊走、九宮格偏好區域預設下排、活動量、速度）；角色包可在 manifest `defaults` 建議 `scale`、`wander`；推薦角色身高 110 基準像素（以 Demo 力天使為準），偏離 ±25% 只提示。寫進 AD-11、AD-13、SPEC 限制、Story 3.1、3.3、3.6、4.1、5.1 |
| 2 | Story 3.1 的 AC 加上「沙盒原型閘門已通過」；`sequencing_rules` 改為 3.1 必須等閘門 |
| 3 | 補 AC：particles 與 emitter 持續、advancedBitmap／`stage.canvas`／bitmap（3.6）；`drawTimeoutMs` 視同失敗（3.9）；載入時檢查 `apiVersion`（3.5）；睡眠／鎖定：1.6 只送通知、3.6 暫停節拍與心跳；NFR5 驗證：1.3 禁止引用 Node 網路模組、2.3 端到端斷言沒有對外請求 |
| 4 | AD-4 來源表補上 Codex `session_index.jsonl`、Cursor 以 slug 推出候選路徑只做存在性檢查、Copilot `workspace.yaml` 與 `COPILOT_HOME` |
| 5 | Story 1.1 改為在暫存資料夾產生模板再搬進 repo、不覆蓋既有檔案；工具只掃 `src/`、`test/`、`prototypes/` |
