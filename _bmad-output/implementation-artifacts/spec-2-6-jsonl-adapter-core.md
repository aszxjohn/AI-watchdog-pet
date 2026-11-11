---
title: 'Story 2.6（前置）：抽出共用的 JSONL 讀檔核心'
type: 'refactor'
created: '2026-11-11'
status: 'done'
baseline_commit: '8b716804d6902df038a1b4ec36284bbfa476b198'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-4-claude-code-transcript.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 2.4 的 Claude Code 轉接器把「跟著 JSONL 紀錄檔讀」的通用機制（補讀、即時讀、監看、健康、資料夾重查）和 Claude Code 專屬的路徑規則、紀錄對照寫在一起（`claude-code.ts` 602 行）。Gemini（2.6）、Codex（2.5）、Cursor（2.7）都要同一套機制，各寫一份會讓同樣的錯（例如 2.4 在 Windows 上的 BigInt）分散到每個轉接器。

**Approach:** 把通用部分抽到 `src/main/detection/adapters/jsonl/`，claude-code 改成只提供參數的薄層。行為完全不變。

**Decisions（2026-11-11）：**
- 使用者決定把 2.6 拆開：先做這個重構，再做 Gemini 轉接器與推測一輪結束（`spec-2-6-gemini-cli-adapter.md`，草稿）。
- run log 的文字可以改成不提 Claude 的通用說法，但前綴（`claude-code:`）、記錄的代碼與數量不變，仍不寫路徑與內容。

## Boundaries & Constraints

**Always:**
- 行為不變：claude-code 既有測試的斷言一字不改、全部通過，測試數不減少；測試檔只改 import 與改用搬到 `test/helpers/` 的共用輔助函式。
- 核心沒有寫死任何來源：`source`、log 前綴、監看深度、路徑規則、初次掃描、紀錄翻譯、名稱事件、讀檔前的閘門都由參數提供。
- 核心不 import 任何來源的轉接器；`.dependency-cruiser.cjs` 加一條規則擋住 `adapters/jsonl` → `adapters/<其他資料夾>`。核心在 `adapters/` 底下，既有的 `adapters-no-processes-or-electron` 照樣涵蓋。

**Never:**
- 不改 claude-code 的事件、健康規則、補讀與即時讀的行為、常數。
- 不加任何 Gemini、Codex、Cursor 的東西，也不為它們預先加參數（各自的 story 再擴充核心）。

</frozen-after-approval>

## Code Map

- `src/main/detection/adapters/claude-code/read.ts` → `jsonl/read.ts`：整檔搬（`tailRead`、`splitLines`、`readRange`、`LineCarry`、讀檔型別）。
- `claude-code/watcher.ts` → `jsonl/watcher.ts`：`depth: 3`（:53）改為參數；`WatchedStats`（`paths.ts:89`）與 `partsBelow`（`paths.ts:32`）一起搬。
- `claude-code/claude-code.ts` 的通用核心（約 :166-575：`health`、`deliver`、`badLine`／`goodRecord`、`readOpen`、補讀／即時讀／變小重讀、`resolveRoot` 與 `armRecheck`、watcher 世代、`replayAll`、`sync`）→ `jsonl/log-adapter.ts`，對外一個建立函式，收上面列的參數。claude-code 留下：選項、`scan`（:363）、「subagent 等父 session 讀過」的閘門（:300-314、`readSessions` :164）、翻譯與名稱事件的接線。
- `claude-code/translate.ts`：與格式無關的 `isObject`（:122）、`timestampOf`（:127）、`folderNameOf`（:174）、`parseRecordLine`（:426）搬到 `jsonl/records.ts`；Claude 專屬的對照留著。
- `claude-code/paths.ts`：留 Claude 專屬的部分；`shouldWatch` 的 `Number(stats.mtimeMs)` 那段若變成共用，連同註解一起搬。
- 測試：`test/main/detection-claude-code*.test.ts` 裡通用的輔助函式（`fakeWatcher` :67、`fingerprint` :315、`diagnose` :291、真 chokidar 的 `startReal`／`stopReal`／`arrives` :429-486、`readAll` :23）搬到 `test/helpers/`；只測 `read.ts` 的 describe 可以改名搬到 `test/main/detection-jsonl-read.test.ts`，斷言不改。
- `src/main/main.ts`：不需要改（claude-code 的建立函式與選項不變）。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/detection/adapters/jsonl/`：`read.ts`、`watcher.ts`、`records.ts`、`log-adapter.ts`。
- [x] `src/main/detection/adapters/claude-code/`：改成使用核心，只留 Claude 專屬部分。
- [x] `.dependency-cruiser.cjs`：核心不得 import 其他轉接器資料夾。
- [x] `test/helpers/`、`test/main/detection-claude-code*.test.ts`：搬共用輔助函式、改 import。

**Acceptance Criteria:**
- Given 重構完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，測試數不少於重構前（2126）。
- Given 重構完成，when 看 `git diff` 裡 `test/main/detection-claude-code*.test.ts` 的改動，then 只有 import、輔助函式搬家，沒有任何 `expect` 被改或刪。
- Given 重構完成，when 在 `src/main/detection/adapters/jsonl/` 搜尋 `claude`（不分大小寫），then 沒有結果。
- Given 用隔離的 `--user-data-dir` 啟動 `npm start`，when 有 Claude Code 的 transcript，then run log 仍有 `claude-code:` 開頭的啟動與同步紀錄，沒有 `detection` 錯誤。

## Implementation Notes

- 開發代理對規格沒寫明之處的解讀：
  - 核心的建立函式是 `createJsonlLogAdapter<Where, State>(options)`。參數：`source`、`logPrefix`、`root`、`rootName`（log 裡怎麼稱呼根目錄，claude-code 給 `projects folder`，所以既有 log 文字一字不變）、`fs`、`watch`、`watchDepth`、`locate(root, file)`（路徑 → 這個檔是什麼，回傳的 `Where` 對核心是不透明的；null 就不開）、`follow`（watcher 要不要跟）、`scan(root, list)`（回傳依序補讀的群組，每組有 log 用的名稱）、`initialState`、`translate`、`nameEvent`、`gate`（`allows`／`read`／`reset`，選用）。核心不假設 session id 在檔名裡：session 歸屬只存在 `Where` 與翻譯狀態中。
  - 每次讀檔的翻譯 context 是 `{ ...Where, replay, fallbackTs }`；claude-code 的 `Where` 是 `{ kind, sessionKey }`，所以 `translateRecord`、`currentNameEvent` 直接當參數傳，不另包一層。
  - subagent 閘門：`readSessions` 留在 claude-code，經 `gate.allows`（讀前）、`gate.read`（讀完、送出前，對應原本的 `readSessions.add`）、`gate.reset`（對應原本 `forgetAll` 裡的 `clear`）接上。
  - BigInt 那段改成共用：`jsonl/watcher.ts` 的 `shouldFollow(root, entry, stats, recent, kindOf)` 負責根目錄、修改時間（`Number(stats.mtimeMs)` 與註解一起搬來）、檔案／資料夾判斷；claude-code 的 `shouldWatch` 只提供 `kindOf`（transcript／資料夾／都不是），簽名不變。監看深度 3 改為 `paths.ts` 的 `WATCH_DEPTH`。
  - `WatchTranscripts` 的第二個參數由 `follow` 函式改為 `{ depth, follow }`（深度要從參數傳進 chokidar）；`ClaudeCodeAdapterOptions` 的欄位不變，`main.ts` 沒動。
  - `records.ts` 除了規格列的四個，另搬 `displayNameOf`（`folderNameOf` 依賴它）與 `Fields` 型別；`idOf` 留在 translate。讀檔型別名稱（`TranscriptFs` 等）照「整檔搬」保留。
  - depcruise 新規則 `jsonl-core-not-to-source-adapters`：`^src/main/detection/adapters/jsonl/` 不得 import `adapters/` 底下 `jsonl/` 以外的資料夾。暫時放一個 import `claude-code/paths` 的檔試過，規則會報錯，試完已刪。
  - 測試輔助函式搬到 `test/helpers/jsonl-adapter.ts`：`readAll`、`fakeWatcher`、`filesUnder`、`fingerprintFiles(dir)`、`diagnose`、`startReal(adapter)`、`stopReal`、`arrives`、`REAL_WATCH_*`。fixture 測試以 `const fingerprint = () => fingerprintFiles(tmp)` 保留原呼叫；`startReal()` 的兩處呼叫改成傳入 `createClaudeCodeAdapter({ root })`。
  - 只測 `read.ts` 的 describe **沒有**搬到 `detection-jsonl-read.test.ts`（規格寫「可以」）：搬走會讓 Verification 的 `expect` grep 出現刪除行。
  - Verification 的 `git diff -U0 … | grep -E '^[-+].*expect'` 有兩行輸出，都是 `-        expect(`：來自搬走的 `startReal`、`arrives` 裡 `vi.waitFor` 的等待條件（不是測試斷言），原樣出現在 `test/helpers/jsonl-adapter.ts`。規格要求搬這兩個函式，這兩行無法避免；測試本身的 `expect` 沒有改或刪。
- 審查修補（主 session 指示，開發代理）：`guard-rules.test.ts` 補上新規則的反向測試（`RULES`、違規與不違規的 fixture）；`detection-claude-code.test.ts` 新增一個測試，涵蓋資料夾消失時 `gate.reset()` 清掉已讀 session（拿掉 `readSessions.clear()` 或核心的 `gate?.reset()` 都會失敗）；`diagnose` 跳過沒有被 spy 的 console 方法；read、translate 兩個測試檔的開頭註解改為註明也測共用核心。因為新增了測試，`expect` grep 現在也會出現這個新測試的 `+` 行（新增，不是修改）。開發代理只跑了受影響的 5 個測試檔（231 個測試，全過）；完整驗證由主 session 執行。
- 驗證（開發代理）：重構前 `CI=true npm test` 為 47 個檔案、2126 個測試。重構後 `npm run typecheck`、`npm run lint`、`CI=true npm test`（47 個檔案、2126 個測試、全過）、`npm run depcruise`（0 違規）全部通過；`grep -ri claude src/main/detection/adapters/jsonl/` 沒有輸出。
- 實機（開發代理）：`npm start -- -- --user-data-dir=<scratchpad>` 隔離執行，未截圖、未碰使用者的 app。run log 依序有 `claude-code: started; watching the projects folder` 與 `claude-code: replayed 11 transcripts modified within the discovery window (7 sessions, 4 subagents; 785 transcripts in all); sync.ready`，沒有 `detection` 錯誤或警告；停止後 log 有 `claude-code: stopped`、`app quit`，沒有殘留行程。

- 主 session 核對：把舊 `claude-code.ts` 的核心（:136-602）與新 `log-adapter.ts`（:207-666）逐行比對（忽略空白），差異只有改成參數（`source`、`rootName`、`locate`、`scan`、`translate`、`nameEvent`、`gate`、`watchDepth`）；`read.ts` 只改了檔頭註解；`shouldWatch` 改由 `shouldFollow`＋`watchedKind`，路徑規則與原本相同。測試檔的改動只有 import 與輔助函式搬家，`expect(` 數量 26＋50＋33＋106 不變（fixture 測試的 2 個搬進 `test/helpers/jsonl-adapter.ts`）。重跑 typecheck、lint、`CI=true npm test`（47 個檔案、2126 個測試）、depcruise（0 違規）全部通過；`jsonl/` 底下搜尋 `claude` 沒有結果。實機那一項依開發代理的紀錄，主 session 沒有另外執行。

- 審查修補（第 1 輪，4 項）後，主 session 重跑：typecheck、lint、`CI=true npm test`（47 個檔案、2130 個測試）、depcruise（0 違規）全部通過；claude-code 測試檔被刪的 `expect(` 仍只有搬到 `test/helpers/jsonl-adapter.ts` 的那 2 行；`jsonl/` 底下搜尋 `claude` 沒有結果。
- sprint 狀態：`2-6-gemini-cli-轉接器` 維持 `in-progress`，不設為 `review`，因為這份只是 2.6 的前置重構，Gemini 轉接器本體（`spec-2-6-gemini-cli-adapter.md`）還沒做。
- CI：使用者 commit `e06dde2`（2026-11-11）後，GitHub Actions 的 macOS、Windows 都通過（run 42984635692）。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-11）。審查員代號：B＝blind-hunter，E＝edge-case-hunter，VG＝verification-gap。

| # | 發現 | 判定 | 處理 | 依據 |
|---|---|---|---|---|
| VG1 | 新的 depcruise 規則 `jsonl-core-not-to-source-adapters` 沒有反向測試 | medium | patch | `test/tooling/guard-rules.test.ts` 的 `RULES` 只列 14 條，設定檔有 15 條；檔頭規定每條規則都要在違反它的 fixture 上觸發 |
| VG2 | 資料夾消失再回來後清掉「已讀 session」的 `gate.reset()` 沒有測試 | medium | patch | 這是重構新加的接縫；`folderRemoved` 的測試都沒有 subagent，拿掉 `reset` 測試照樣通過 |
| B4、E7 | 共用的 `diagnose` 在 console 沒被 spy 時取 `.mock.calls` 丟 `TypeError`，等待會一直失敗 | low | patch | `test/helpers/jsonl-adapter.ts:125-130` 直接 `vi.mocked(method).mock.calls`；現在只有一個有 spy 的檔在用，但它已是給 Gemini、Codex 測試共用的輔助函式，下一個 story 就會用到 |
| B7 | `detection-claude-code-read.test.ts`、`-translate.test.ts` 的檔頭仍說只測 Claude Code，實際也測共用的 `jsonl/read`、`jsonl/records` | low | patch | 檔頭註解直接改正即可 |
| B12 | `spec-2-5-codex-cli-adapter.md` 的 Code Map 仍要從 claude-code 搬出共用核心 | low | patch（主 session 改文件） | 2.5 是草稿，回來做時會重新規劃；先在它的 Implementation Notes 註明核心已存在 |
| E1、E2、E3、E4 | 共用核心沒有防護來源提供的回呼（`follow`、`scan`、`locate`、`gate`、`translate`）丟例外：`follow` 在 chokidar 的 `ignored` 裡丟會讓初次掃描中斷、`sync.ready` 不送；`translate` 丟會讓同一個檔卡住 | medium（未發生） | defer | 與重構前完全相同（舊程式同樣沒有 try/catch）；claude-code 的回呼設計上不丟例外。2.4 的 BigInt 就是這一類，Gemini 加第二個來源時一併處理 |
| B1 | 來源寫在 `source`、`logPrefix`、`translate.ts` 的 `commonFields` 三處，核心不檢查一致 | low | reject | 目前只有一個來源且一致；要加參數或過濾，屬於規格 Never 的「不為之後的來源預先加參數」 |
| B2 | 共用核心沒有自己的測試，只透過 claude-code 間接測 | low | reject | 核心的每條路徑都由 claude-code 測試涵蓋；沒給 `gate`、0 組 `scan` 這些路徑目前沒有使用者，Gemini 轉接器會是第二個使用者並帶自己的測試 |
| B3 | `fakeWatcher` 丟掉 `depth`，沒有測試確認深度 3 傳到 watcher | false | reject | 真 chokidar 測試 `detection-claude-code-fixtures.test.ts:418-421` 在 ready 之後寫入深度 3 的 subagent 並等它的事件；深度傳錯就會失敗 |
| B5 | `arrives` 的失敗訊息永遠寫 `health none` | low | reject | 原樣搬來；只影響測試失敗時的訊息 |
| B6 | 規格 Verification 的 `expect` grep 已知有 2 行輸出 | low | reject | 修法是改本規格；Implementation Notes 已說明那 2 行是搬移，`expect(` 總數不變 |
| B8 | `translate.ts` 的 `RecordContext`／`Translation` 與核心的型別重複 | low | reject | claude-code 的 `translateRecord` 直接當參數傳進核心，兩邊不相容時 typecheck 就會失敗，不會悄悄分歧 |
| B9、E5 | `{ ...where, replay, fallbackTs }` 會蓋掉來源同名欄位 | low | reject | claude-code 的 `Where` 只有 `kind`、`sessionKey`；擋它要加型別約束，目前沒有來源會碰到 |
| B10 | `scan` 回傳 0 組時 log 變成 `(; N transcripts in all)` | low | reject | 只有回傳空陣列的來源會碰到，目前沒有；只影響 log 文字 |
| B11 | depcruise 沒擋「來源資料夾互相 import」 | low | reject | 規格沒有要求；不影響這次的行為 |
| B13 | deferred-work 兩筆的 `source_spec` 用法不一致 | false | reject | 兩筆都依流程填「延後它的那份規格」，並在 summary 寫明被延後的規格路徑 |
| E6 | 同路徑換成另一個更大的檔時，從舊位置接著讀 | low | reject | carried：2.4 審查 E4 已以「Claude Code 只附加寫入」拒絕；重構未改這段 |
| E8 | `startReal` 等不到 `sync.ready` 時沒有停掉轉接器 | low | reject | 原樣搬來；只在測試已經失敗時發生 |

## Design Notes

接下來要用這個核心的轉接器（不在本次範圍，只為了介面不要擋住它們）：
- Gemini、Codex 的 session id 寫在檔案第一行，不在檔名；補讀只讀最後 2 MiB 時要另外讀第一行。
- Gemini 的 subagent 在 `chats/<父 session id>/` 底下，Codex 的 subagent 是獨立檔、靠第一行的欄位連到父 session。
- Cursor 會整檔重寫（變小時整檔重讀並去重）。

所以核心以「每個檔的路徑 → 屬於哪個 session、要不要讀」與「每個檔一份翻譯狀態」為參數，不要假設 session id 一定在檔名裡。

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：全部通過。
- `git diff -U0 -- 'test/main/detection-claude-code*.test.ts' | grep -E '^[-+].*expect'`：沒有輸出。
- `grep -ri claude src/main/detection/adapters/jsonl/`：沒有輸出。

**Manual checks:**
- 開發代理：`--user-data-dir` 隔離執行 `npm start`，看 run log；不截圖、不碰使用者的 app。
