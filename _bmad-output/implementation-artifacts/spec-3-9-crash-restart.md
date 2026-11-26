---
title: 'Story 3.9（中）：當掉偵測與自動重啟'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_commit: 'ace09c39e1aa0edbb0a06be14513b9a6edaa0dac'
route: 'dispatch'
review_loop_iteration: 0
user_preview: approved
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/docs/pack-api-v1.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包沙盒現在只認未捕捉例外。卡死（無窮迴圈、`frame` 永遠不回）和一直交不出有效 `draw` 都偵測不到，角色會停格。失敗後沙盒也不會重建，角色直接消失，要等它離場再過 `SANDBOX_IDLE_MS` 才會恢復。

**Approach:** pack-host 用 world tick 計算心跳與 `drawTimeoutMs`。失敗時該包的角色改演佔位，並經新的 IPC `packs:runtime-failed` 問 main 要不要重啟。main 依「包@版本」記次數：前 3 次回答重啟，第 4 次起不重啟，那包停住、角色留在佔位。

**定案（2026-11-25 使用者）：** 3.9（下）另做：第 4 次失敗的標記、池子排除、管理頁原因、重新匯入清除、示範模式。超限只在持續時才算失敗：超限的 `draw` 視同沒有有效 `draw`，連續 `drawTimeoutMs` 都沒有有效 `draw` 才判失敗；`stage.*` 訊息超過頻率照舊只丟、不判失敗。用探針包驗證「失敗 4 次後停住」的 e2e 拆出去另做（已記 deferred-work）；這段的 e2e 只靠現有測試把任何 `sandbox failed` 視為故障。

## Boundaries & Constraints

**Always:**
- 常數只在 `src/shared/constants.ts` 定義一份：`HEARTBEAT_TICKS` 30（每 1 秒送 `ping`）、`HEARTBEAT_TIMEOUT_TICKS` 150（連續 5 秒沒有 `pong`）、`DRAW_TIMEOUT_MS` 10000、`PACK_RESTART_LIMIT` 3。
- 只用 tick 計時，不用牆鐘。只計 pack-host 實際處理到該沙盒的 tick，所以睡眠、鎖定、context lost、外觀還沒到的期間都不計。`drawTimeoutMs` 只在該包有己方 actor 時累計；有效 `draw`（包括空的）就歸零。
- 回 `pong` 的是 Worker bootstrap，在 Compartment 外，包的程式看不到 `ping`。
- 所有失敗（包括開機失敗、`boot-timeout`）都算次數。
- 佔位從失敗開始，到重建的沙盒交出第一則有效 `draw` 為止。第一次上台的開機期間維持現狀（還沒畫就不畫）。
- 重建用新的 `Sandbox`，照既有流程送 `init`，帶現有的全部 actorId。main 的回覆到達時，那包已經換了沙盒或沒有 actor 了，就不重建。
- 失敗只影響那一包，log 帶 `packId`。

**Never:** 不呼叫 `worker.terminate()`；不改 main/pool、管理頁、`StagePack`、index.json；不做 bitmap 的記憶體上限（另一筆 deferred）；不處理同版本覆蓋安裝。

## I/O & Edge-Case Matrix

| 情境 | 狀態 | 結果 |
|---|---|---|
| 卡死 | `frame` 進無窮迴圈 | 150 tick 沒 `pong` → `heartbeat-timeout` → 佔位 → 問 main → 重建 |
| 一直無效 | 每則 `draw` 都超限或 `no-draw` | 10 秒 → `draw-timeout` |
| 偶爾超限 | 中間有有效 `draw` | 只丟那則，不失敗 |
| 第 4 次 | 同一包@版本第 4 次失敗 | main 回 `restart: false` 並記一行；沙盒停在 failed，角色維持佔位 |
| 等回覆時換版本 | `version-changed` 先到 | 舊回覆忽略，照新版本建沙盒 |
| IPC 失敗 | invoke 丟錯或回 `ok: false` | 不重建，記到 console |
| 新版本 | 換了版本號 | 次數從 0 起算 |

</frozen-after-approval>

## Code Map

- `src/shared/sandbox.ts`：比照 `sandboxBitmapCharactersMessage`（`:66-79`）加 `sandbox.ping`；`sandboxReportSchema`（`:221`）加 `sandbox.pong`（少了會被當 `bad-report`）；`SANDBOX_FAILURE_REASONS`（`:256`）加 `heartbeat-timeout`、`draw-timeout`；IPC 輸入 `{ packId, version, reason }`、輸出 `{ restart: boolean }`。
- `src/sandbox/worker-bootstrap.ts`：`isHostMessage` 分支（`:1270`）收到 ping 就用 `first.postMessage` 回 pong。
- `src/overlay/pack-host/host.ts`：
  - `tick()`（`:722`）：每個沙盒的 tick 計數；
  - `report()`（`:424`）：收 pong；
  - `receiveDraw`：有效 `draw` 時歸零計數、清掉 recovering；
  - `fail()`（`:352`）：記完 log 後 invoke 問 main；
  - `start()`（`:578`）：可標 recovering；
  - 新增 `troubled(packId)`：`failed` 或 recovering 時為真；
  - 檔頭 `:25-30` 改寫。
  - `PackHostApi`（`:165`）加 `runtimeFailed`。
- `src/overlay/renderer/scene.ts`：`SceneInput`（`:183`）加 `troubled`，在 `:392` 和 `mappedState === null` 一樣走佔位；`src/overlay/main.ts:224` 接上。
- IPC：`src/shared/ipc.ts`（`:221-247` 一帶）、`src/shared/preload-api.ts:131-146`、`src/preload/overlay.ts:38-43`；`src/main/packs/ipc.ts` 的 `registerPackSandboxHandlers`（`:77`）多收一個 handler，呼叫端在 `src/main/main.ts`。
- 新檔 `src/main/packs/runtime-failures.ts`：純邏輯計數器，以「包@版本」為 key，只存在記憶體；版本不是目前安裝的版本就不重啟、也不計次；log 比照 `sandbox-log.ts`。
- 文件 `docs/pack-api-v1.md`：8.1 `:505`（超限改為持續才算）、8.4 `:561-583` 寫入數值、11 `:640` 拿掉已定案的時間數值。

## Tasks & Acceptance

**Execution:**
- [x] shared：常數、ping／pong、失敗原因、`packs:runtime-failed` 的 channel 與 schema、preload。
- [x] bootstrap 回 pong，並寫單元測試（比照 `test/sandbox/routing.test.ts`）。
- [x] pack-host：心跳、draw 逾時、問 main、重建、`troubled`；改 `test/overlay/pack-host.test.ts`（`:535`、`:545`、`:783`、`:802`），以及 `pack-host-draw.test.ts:608`「一包變慢」（改成會逾時失敗）。
- [x] scene／main.ts：佔位接線與 scene 測試；`drawnPlaceholders` 已有。
- [x] main：`runtime-failures.ts` 寫單元測試；IPC 接線與 `test/shared/ipc.test.ts`。
- [x] 文件與 host.ts 檔頭。

**Acceptance Criteria:**
- Given 健康的契約測試包跑超過 10 秒，then 沒有任何 `sandbox failed`。
- Given 兩個包其中一個卡死，then 另一包照常收 `frame`、照常畫。

## Verification

- `npm run -s typecheck`、`npm run -s lint`、`npm run -s depcruise`、`npx vitest run`：全部通過。
- 現有 e2e 只在 CI 跑（不在本機開視窗），驗證健康的包沒有任何 `sandbox failed`。

## Implementation Notes

- 實作代理在 2026-11-25 被使用者暫停，2026-11-26 帶新的 handoff 規則接著完成；中斷前程式、測試、文件已寫完，接續時照 review-patterns RP-14 把 `SceneInput.troubled` 改成必填（overlay 漏接時 typecheck 會擋）。
- 解讀與取捨：換版本建的新沙盒不算 recovering（開機期間跟第一次上台一樣不畫）；`sinceDraw` 在沒有己方 actor 時暫停、不歸零；`pong` 不帶序號，收到任何 pong 都歸零心跳計數；`stage.*` 與 `draw` 共用每包訊息額度，所以每秒超過額度的 `stage.*` 洪水持續 10 秒會讓 `draw` 被限速丟掉而判 `draw-timeout`。
- 文件 8.4 第 3 點沿用原句（第 4 次標為失敗、管理頁顯示原因、換角色），這些要到 3.9（下）才實作；目前第 4 次只停止重啟、角色留在佔位。
- 檢查（2026-11-26，新規則：預覽前只跑改到的測試）：`npm run -s typecheck` 通過；12 個改過的測試檔、666 個測試通過。完整 `npm test`、lint、depcruise 等預覽核可、審查後一次跑。
- 使用者預覽（2026-11-26）：開發版實機跑約 2 分鐘，角色包沙盒正常、run log 沒有任何 `sandbox failed` 或重啟，選 A 進審查。
- 審查修正後的完整驗證（2026-11-26）：`npm run -s typecheck`、`npm run -s lint`、`npm run -s depcruise` 通過；`npx vitest run` 118 個檔案、5620 個測試通過（2 個原本就 skip）；`npm run codemap` 已重新產生。e2e 不在本機跑，等 CI。

## Review Triage Log

2026-11-26 三層審查（Blind Hunter 13 條、Edge Case Hunter 6 條、Verification Gap 0 個缺口加 3 條其他發現），合併重複後逐條核對：

- B4／E2／VG-1 重建時 `packs:get-entry` 失敗，`noEntry()` 刪掉 recovering 沙盒，`troubled()` 變 false，角色消失不演佔位。**medium**，屬實（`host.ts` 的 `noEntry` 走 `sandboxes.delete`）。**patch**：recovering 沙盒拿不到入口時留在 map、phase 改 failed。
- E1 main 的 yes 到達時包沒有 actor，失敗沙盒留在 map；actor 在 `SANDBOX_IDLE_MS` 內回來，`onView` 只 `keep()`，角色一直演佔位、不重建。**medium**，屬實。**patch**：沒有 actor 時直接 `destroy` 失敗沙盒，回來的 actor 拿新沙盒。
- B1／E6 第 4 次之後不是真的停住：actor 離場、過了 idle，再上台會重新開機一次；main 的 log 寫「it stays stopped」不對。**low**，屬實；行為是中段的過渡狀態（3.9 下會把該版本排出池子），只改說法。**patch**：log 與文件寫實際行為。
- B2 文件 8.4 第 3 點把 3.9（下）的標記、管理頁原因、換角色寫成已完成。**low**，屬實。**patch**：改寫成現況，註明之後才加。
- B7／E5／VG-2 文件說 `stage.*` 超頻只丟、不算失敗，但 `stage.*` 與 `draw` 共用每包訊息額度（3.6 起就是如此），塞滿額度會讓 `draw` 被限速、10 秒後判 `draw-timeout`。**medium**，屬實（`host.ts` 的 `receiveDraw` 用 `sandbox.messages`）。**patch** 文件與 host.ts 檔頭說明；要不要讓洪水不能經由 `draw` 判失敗是另一個決定，**defer**。
- B8 「偶爾超限」測試標題說 `stage.*` 超頻，實際只超過 `stage.log` 自己的頻率。**low**，屬實。**patch**：改標題。
- B9／VG-3 文件「時間只用 tick 計」沒排除開機逾時（10 秒牆鐘，`clock.setTimer`）。**low**，屬實。**patch**：文件註明例外。睡眠剛好在開機時會用掉一次重啟額度，罕見，不改行為。
- B10 文件寫 150 tick（約 5 秒），但計數從上一次 pong 起算、ping 每 30 tick 一次，任何處理函式卡約 4 秒就可能逾時。**low**，屬實。**patch**：文件寫清楚。
- B11 draw 逾時的 tick 數在 host.ts（`Math.ceil`）和測試（不取整）各算一份。**low**，屬實；`DRAW_TIMEOUT_MS` 改成非整除值時兩邊會不一致。**patch**：constants.ts 匯出一份 `DRAW_TIMEOUT_TICKS`。測試裡寫死的 200／800／900 不改。
- B12 scene.test.ts 一段 JSDoc 被新 describe 隔開、掛錯位置。**low**，屬實。**patch**：移回原處。
- B3／E3 main 在回答 yes 時就計次並記「restarting」，overlay 若因沒有 actor 或已換沙盒而沒重建，額度照樣用掉。**low**，屬實但罕見（要在 IPC 往返的幾毫秒內離場，或包在 idle 期間卡死），修法要加回報或退額度的協定。**reject**。
- E4 main 答應後、重建拿入口前包剛好更新，新版本沙盒被當成 recovering、開機期間演佔位。**low**，只是開機期間顯示佔位而非不畫，罕見。**reject**。
- B5 沒有「重建後又失敗、連續 4 次」的串接測試。**low**：兩半各有測試（overlay 每次失敗都問 main、計數器第 4 次邊界），依專案規則測試只寫 AC 主要路徑。**reject**。
- B6 真正卡死的 Worker 是否會因移除 iframe 而停止，沒有實機驗證；deferred 的 e2e 探針只用例外，不會走到心跳逾時。**maybe-false**，若不成立為 high（卡死的 Worker 持續吃 CPU）。**defer**：探針 e2e 加一個 `frame` 無窮迴圈的案例。
- B13 失敗後立刻重建、沒有間隔或退避。**low**，設計選擇：開機必敗的包很快用完 3 次額度正是要的結果；喚醒後的暫時性開機逾時罕見。**reject**。
