---
status: final
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/specs/spec-ai-watchdog-pet-stage/SPEC.md
  - _bmad-output/specs/spec-ai-watchdog-pet-stage/glossary.md
  - _bmad-output/planning-artifacts/architecture/architecture-gundam-pet-2026-11-02/ARCHITECTURE-SPINE.md
---

# AI Watchdog Pet 舞台 - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for AI Watchdog Pet 舞台, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

本專案沒有 PRD 與 UX 文件：需求來源是 SPEC.md（CAP-1～CAP-18，取代 PRD），技術規則來源是架構規約（AD-1～AD-26）。

## Requirements Inventory

### Functional Requirements

FR1: 舞台以唯讀方式偵測 Claude Code、Codex CLI、Gemini CLI、Cursor、Copilot CLI 的 session，把每個 session 歸成 8 狀態之一（`waiting`、`thinking`、`working`、`approval`、`decision`、`done`、`idle`、`error`）。〔CAP-1〕
FR2: 讀不到批准或提問訊號的工具，工具執行超過推測門檻（預設 10 秒）沒結束時，舞台推測為「要你批准」（提問類工具推測為「要你決定」），並標為推測。〔CAP-1、AD-22〕
FR3: 每個追蹤中的 session 從池子分到一隻角色；池子用完前畫面上不重複；session 結束時角色放回池子。〔CAP-2〕
FR4: 使用者可以指定哪些 session 顯示、哪些釋放不追蹤；釋放的 session 收回角色但留在管理清單，可以改回顯示。〔CAP-3〕
FR5: 角色在使用者選定的一個螢幕上，於透明、置頂、滑鼠穿透的畫布裡遊走；游標在角色身上才接收滑鼠。〔CAP-4〕
FR6: 使用者以左鍵把角色捏起來拖到別處：拖曳中暫停遊走、跟著游標、限制在畫面內；放開後從放下處直接恢復遊走；包收到 `grab` 事件可演被捏起來的動作，沒實作就照原樣被拎著走。〔CAP-5〕
FR7: 右鍵角色開選單：這個角色的編輯頁、管理 session、暫停／顯示。app 入口在 macOS 選單列與 Windows 系統匣；Dock／工作列圖示只在有面板開著時出現；app 已在執行時再啟動一次會打開主面板。〔CAP-6〕
FR8: 舞台在每隻角色上方畫名牌（session 顯示名稱）與狀態標記，位置用包宣告的錨點；推測的狀態用另一種標記樣式；固定參數「名牌與標記顯示」可逐角色關閉。〔CAP-7〕
FR9: 角色編輯頁上半部是固定參數（大小、加入池子、遊走偏好、名牌與標記顯示），下半部依角色包宣告自動產生欄位（`bool`、`int`、`number`、`choice`、`asset`）。有效值＝舞台覆蓋值，沒有就用包預設值；覆蓋值只存在舞台、以角色為單位，重新匯入包後仍在。〔CAP-8〕
FR10: 使用者勾選哪幾包上場；每個角色只有一個「加入池子」開關，屬於舞台設定，編輯頁與包管理頁顯示同一個值。〔CAP-9〕
FR11: 使用者可以匯入 `.awpet`：擋下危險路徑、超大圖片、manifest 錯誤、API 版本不相容的包並說明原因；同 `packId` 已存在時顯示新舊版本，經確認才替換，降版另外警告；安裝失敗回復舊版。〔CAP-10〕
FR12: 使用者可以匯出角色包，匯出檔只含角色包本身，不含使用者的調整。〔CAP-10〕
FR13: 每隻角色依 8 狀態演出；包沒做的狀態先演包宣告的後備演出，沒有後備才演舞台佔位；`done` 是過場，預設 5 秒後轉 `waiting`；預設 5 分鐘沒有事件轉 `idle`。〔CAP-11〕
FR14: 使用者可以在舞台設定調整計時值：「做完了」過場秒數、轉「休息中」的逾時、推測批准的門檻。〔CAP-11、AD-22〕
FR15: 跨包通用互動五種：被擊中（`hit`）、靠近／碰撞（`proximity`）、進場／離場（`enter`／`leave`）、狀態廣播（`state-broadcast`）、被捏起來（`grab`）；目標包沒處理就不反應、不報錯。〔CAP-12〕
FR16: 包可以發射物件：用包自己的物件，沒指定、不認得或素材載入失敗時改丟隨機的通用物件；命中由舞台判定並以 `hit` 通知。〔CAP-12〕
FR17: 同一包的角色之間可以有包內自訂的特殊互動。〔CAP-13〕
FR18: 包可以請自己的角色停下／恢復遊走、轉向，不能指定位置；使用者設成不遊走或角色被捏起來時請求無效。〔CAP-14〕
FR19: 包當掉時自動重啟，同一包最多 3 次；第 4 次失敗標為失敗（視同停用），在包管理頁顯示原因。〔CAP-15〕
FR20: 包被停用、移除、標為失敗，角色取消加入池子，或更新後角色消失時，畫面上受影響的角色立刻換成池子裡的其他角色；池子空了就收回角色。〔CAP-15〕
FR21: 示範模式用假 session 輪播 8 狀態並照池子分配；展示模式可以指定任何角色與狀態，不存檔、不佔池子；編輯頁的「在畫面上預覽」用展示模式。〔CAP-16〕
FR22: 舞台留運行紀錄：每小時一個檔、只留 24 小時。〔CAP-17〕
FR23: 設定檔壞掉時保留 `.broken-<時間>` 備份、改用預設值，不被默默蓋掉；單一欄位型別錯只有那欄用預設。〔CAP-17〕
FR24: 沒有安裝任何角色包時，偵測、面板、管理 session 都照常運作，畫布為空。〔CAP-18〕
FR25: 面板顯示每個轉接器的健康狀態（`ok`／`degraded`／`missing`）。〔AD-26〕

### NonFunctional Requirements

NFR1: 偵測延遲：確定的狀態改變後 2 秒內反映到畫面。Cursor 例外：以 step 為單位寫紀錄，延遲數秒到數十秒，批准只能推測。〔CAP-1、AD-4〕
NFR2: 對 AI 工具完全唯讀：不寫入任何工具的檔案或設定、不裝 hook、不執行會寫入工具資料夾的指令（例如 `claude agents --json`）；Claude Code 讀 `~/.claude/sessions/<pid>.json` 時只取必要欄位、不讀 `*.key`、不連 socket。驗收：執行前後各工具資料夾雜湊不變。〔AD-4〕
NFR3: 角色包安全隔離：包程式碰不到檔案、網路、系統指令、對話內容、別的包、舞台設定；`'unsafe-eval'` 只開在沙盒 iframe 與其 Worker。〔AD-7〕
NFR4: 錯誤隔離：任何角色包的錯誤只影響那一包，舞台不中止；一包變慢不拖累其他角色（每包最多一則 `frame` 在途，renderer 不等待）。〔AD-17、Conventions〕
NFR5: 第一版完全不連網：main 與所有 renderer 不發任何對外請求。〔AD-26〕
NFR6: 平台：macOS 13+、Windows x64／arm64 為主；Linux 次要，降級為整窗穿透；第一版只用一個螢幕。〔AD-14、AD-26〕
NFR7: 舞台原始碼不得出現任何角色、系列名稱或角色專屬分支；CI 掃描 `src/` 不得出現測試包的 id。〔AD-1、AD-25〕
NFR8: 判別值一律英文代碼，中文只在顯示層。〔Conventions〕
NFR9: 角色包 API 版本：manifest 宣告 `apiVersion`（`major.minor`），安裝與載入時檢查，不相容就拒絕並說明需要的版本。〔AD-8〕
NFR10: 單一實例；所有匯入入口走同一個匯入流程。〔AD-26〕
NFR11: 檔案可靠性：只有 main 寫檔、一檔一擁有者；寫入一律 temp＋rename；持久檔帶 `schemaVersion` 只往前遷移。〔AD-3、Conventions〕
NFR12: 復原：畫布 renderer 當掉時自動重建並重拿 StageView 快照；系統睡眠或鎖定時暫停 world 節拍與心跳，恢復後繼續。〔AD-24、AD-26〕
NFR13: 繪圖效能：邏輯節拍 30 Hz；全部角色用單一 PixiJS WebGL 畫布；繪圖指令、粒子、bitmap 有數量與尺寸上限。〔AD-9、AD-17〕

### Additional Requirements

- **起手模板（Epic 1 Story 1）：** 以 `create-electron-app@8.0.1 --template vite --typescript` 建專案，把 `electron` 鎖在 45.2.1；保留模板預設（`forge.config.mts`、main／preload 產物 `.cjs`、oxlint＋oxfmt、`typecheck`、FusesPlugin：`RunAsNode` 關、`OnlyLoadAppFromAsar` 與 `EnableEmbeddedAsarIntegrityValidation` 開）；TypeScript 6.0.3、`strict: true`；npm＋lockfile、`.nvmrc` 與 `engines`（Node 24.22.2）；`ses` 鎖確切版本。〔Stack、部署與環境〕
- **沙盒原型閘門（必須最先做）：** 在 Electron 45.2.1 實測 (a) sandbox iframe 內能以 blob 建 classic Worker；(b) Worker 內 `lockdown()` 無錯誤無警告、`Compartment.evaluate` 可執行；(c) Worker 內 fetch、XHR、WebSocket、EventSource 全被擋；(d) overlay 能以 PixiJS 從 `pack://` 載入貼圖並確定 scheme 最小權限。四項通過前不實作 `src/sandbox`、`overlay/pack-host` 與角色包 API；任一項失敗就回頭修訂 AD-7 並請使用者確認。〔AD-7〕
- **目錄與依賴方向：** `src/shared`、`src/main`、`src/preload`、`src/overlay`、`src/panels`、`src/sandbox`、`test/`；依賴只能照 AD-2 方向，CI 用 dependency-cruiser 強制。〔AD-2、Structural Seed〕
- **共用契約：** 跨邊界資料（IPC、舞台↔包、manifest、設定檔）只在 `src/shared` 定義一次 zod schema、收到就嚴格驗證；`z.config({ jitless: true })` 最先載入；運行常數只在 `src/shared/constants`，使用者可調的預設只在設定 schema。〔AD-24、Conventions〕
- **Electron 安全設定：** 所有視窗 `sandbox`、`contextIsolation` 開，`nodeIntegration*` 關，`setWindowOpenHandler` 拒絕，`will-frame-navigate` 只允許 `app://`、`pack://`，權限請求一律拒絕；overlay／panels CSP 不含 `'unsafe-eval'`，overlay 先 `import 'pixi.js/unsafe-eval'`；打包後用 `app://` 不用 `file://`；開發時只對 overlay、panels 放行 Vite dev server。〔AD-24〕
- **自訂協定：** `app`、`pack` 兩個 scheme 在 ready 前註冊一次；`pack://_stage/…` 提供沙盒文件，`pack://<packId>/<version>/<path>` 只回應 manifest 宣告的素材與入口。〔AD-24〕
- **IPC 規則：** 通道 `<domain>:<action>`；invoke 回傳 `{ ok, data }`／`{ ok, error }`；所有 handler 經同一註冊函式並檢查 `senderFrame`；main 往 renderer 只推 StageView。〔Conventions〕
- **StageView：** `main/stage-view` 組合 detection、pool、settings、packs，帶 `rev`；訂閱 → 快照 → 增量，不連號就重拿快照；renderer 只訂閱 StageView、寫入只走擁有者的 invoke。〔AD-20〕
- **資料擁有者與持久檔：** `settings.json`（`main/settings`）、`assignments.json`（`main/pool`）、`packs/`（`main/packs`）、`logs/`（`main/log`）。〔AD-3〕
- **偵測管線：** 每個來源一個轉接器（`claude-code`、`codex`、`gemini`、`cursor`、`copilot`、`demo`）只發共用事件；轉接器宣告能力表；推測只在 `inference`；判斷器依條件表與優先序決定 8 狀態；session 生命週期由 `sessions` 決定；啟動補讀標 `replay`、完成發 `sync.ready`；計時用單調時鐘。〔AD-5、AD-21、AD-22〕
- **各來源：** Claude Code 讀 `~/.claude/sessions/<pid>.json`＋transcript；Codex 讀 rollout；Gemini 讀 chats；Cursor 讀 agent-transcripts（step 級延遲、批准推測、error 多為使用者中止要看字串、檔案可能整檔重寫）；Copilot CLI 讀 `session-state/<id>/events.jsonl`，**排最後做，用真實 Copilot CLI session 驗證過才算完成**。〔AD-4〕
- **角色包 API v1：** actor 與 `actorId`（由 `main/pool` 產生）；訊息 `init`／`spawn`／`despawn`／`params`／`meta`／`frame`；包只回 `draw` 與 `stage.fire`／`hold`／`face`／`log`／`random`／`canvas`；world 擁有 30 Hz 節拍；繪圖指令 `sprite`／`particles`／`bitmap`；actor 本地座標；素材以 manifest key 引用；命中只看 manifest `hitbox`。〔AD-16、AD-17、AD-18〕
- **載入鏈與生命週期：** 每包一個沙盒、閒置銷毀；固定載入順序；心跳以 tick 計；失敗由 pack-host 移除 iframe；更新時保留 `actorId` 以新版本 URL 重載。〔AD-19〕
- **manifest：** `id`、`name`、`version`、`apiVersion`、`entry`、`assets`、`characters`（`id`、`name`、參數宣告、`states`、`fallback`、`hitbox`、`bounds`、`anchor`、`advancedBitmap`）、`projectiles`；id 格式 `^[a-z0-9][a-z0-9-]{1,63}$`。〔AD-13〕
- **滑鼠穿透：** `setIgnoreMouseEvents(true, { forward: true })`；穿透狀態由 overlay 擁有、帶 `seq` 請求；macOS `type: 'panel'`；Windows 前景為管理員視窗時 forward 暫停（已知限制）。〔AD-14〕
- **測試與 CI：** Vitest（shared、main、world）；轉接器以去識別化真實紀錄做快照測試；判斷器與推測做表格測試（假時鐘）；zod schema 往返與拒絕測試；沙盒安全以 Playwright `_electron` 在真的 Electron 裡驗（fetch、XHR、WebSocket、EventSource、importScripts、巢狀 Worker、parent／top、indexedDB、`Date.now`、`Math.random`、OffscreenCanvas webgl 全失敗）；`test/packs/contract-pack/` 契約測試包；端到端以 `demo` 轉接器；CI 跑 macOS 與 Windows。〔AD-25〕
- **運行：** 單一實例、離線、轉接器健康、`render-process-gone` 重建、`powerMonitor` 暫停節拍。〔AD-24、AD-26〕

### UX Design Requirements

本專案沒有 UX 設計文件，不另列 UX-DR。介面行為已包含在 FR5～FR10、FR21、FR25。

### FR Coverage Map

FR1: Epic 2（Claude Code、Codex、Gemini、Cursor）、Epic 6（Copilot CLI）- 唯讀偵測並歸成 8 狀態
FR2: Epic 2 - 讀不到批准訊號時依門檻推測
FR3: Epic 3 - 一 session 一隻、不重複、放回
FR4: Epic 2 - 顯示／釋放 session
FR5: Epic 1（透明置頂穿透畫布）、Epic 4（遊走與角色命中）- 畫布與遊走
FR6: Epic 4 - 左鍵捏起來拖走
FR7: Epic 1（選單列／系統匣入口）、Epic 4（右鍵角色選單）- 入口與選單
FR8: Epic 3 - 名牌與狀態標記
FR9: Epic 5 - 角色編輯頁與參數覆蓋
FR10: Epic 3 - 選包上場、每角色一個加入池子開關
FR11: Epic 3 - 匯入 .awpet 與驗證
FR12: Epic 3 - 匯出 .awpet
FR13: Epic 3 - 依 8 狀態演出、後備與佔位
FR14: Epic 2 - 舞台設定可調計時值
FR15: Epic 4 - 跨包五種通用互動
FR16: Epic 4 - 發射物件與後援
FR17: Epic 4 - 同包特殊互動
FR18: Epic 4 - 包請角色停下／恢復遊走／轉向
FR19: Epic 3 - 包當掉自動重啟與標記失敗
FR20: Epic 3 - 包停用或角色消失時換角色
FR21: Epic 2（示範模式）、Epic 5（展示模式與編輯頁預覽）- 示範與展示
FR22: Epic 1 - 運行紀錄
FR23: Epic 1 - 設定檔壞掉保護
FR24: Epic 2 - 沒有角色包也能運作
FR25: Epic 2 - 轉接器健康顯示

## Epic List

### Epic 1: 舞台骨架：裝好就能常駐
使用者安裝後，app 常駐在選單列／系統匣，有一張透明、不擋操作的畫布；設定檔壞掉不會被蓋掉、有運行紀錄、只會開一個實例。本 epic 也最先完成沙盒原型驗證（AD-7 閘門），結果決定 Epic 3 能否照現有架構開工。
**FRs covered:** FR5（畫布）、FR7（入口）、FR22、FR23

### Epic 2: 看見所有 AI session 的狀態
沒有任何角色包時，使用者就能在面板看到 Claude Code、Codex、Gemini、Cursor 的 session 與 8 狀態，能顯示／釋放 session、看轉接器健康、調整計時值，並用示範模式的假 session 看狀態輪播。
**FRs covered:** FR1（Copilot 除外）、FR2、FR4、FR14、FR21（示範模式）、FR24、FR25

### Epic 3: 角色包上台
使用者匯入 .awpet 後，每個 session 分到一隻角色在畫布上依狀態演出，頭上有名牌與標記；能匯出角色包、選擇哪幾包上場；包當掉自動重啟，停用時角色被換掉。
**FRs covered:** FR3、FR8、FR10、FR11、FR12、FR13、FR19、FR20

### Epic 4: 角色在桌面上活起來
角色會遊走；使用者能左鍵捏起來拖走、右鍵開選單；不同包的角色透過五種通用互動與發射物件彼此反應，同包角色有專屬互動，包能請自己的角色停下或轉向。
**FRs covered:** FR5（遊走與角色命中）、FR6、FR7（右鍵選單）、FR15、FR16、FR17、FR18

### Epic 5: 調整角色與預覽
使用者在角色編輯頁調固定參數與依包宣告自動產生的參數，並用展示模式指定任何角色在畫布上預覽。
**FRs covered:** FR9、FR21（展示模式）

### Epic 6: 支援 Copilot CLI
Copilot CLI 的 session 也會出現在畫面上。排在最後，必須用真實的 Copilot CLI session 驗證過才算完成。
**FRs covered:** FR1（Copilot CLI）

**依賴：** Epic 1 → Epic 2 → Epic 3 → Epic 4、Epic 5（4 與 5 互不依賴）；Epic 6 只依賴 Epic 2。

## Epic 1: 舞台骨架：裝好就能常駐

使用者安裝後，app 常駐在選單列／系統匣，有一張透明、不擋操作的畫布；設定檔壞掉不會被蓋掉、有運行紀錄、只會開一個實例。本 epic 也最先完成沙盒原型驗證（AD-7 閘門），結果決定 Epic 3 能否照現有架構開工。

### Story 1.1: 用 Forge 模板建立專案骨架

As a 開發者,
I want 用架構規約指定的模板與版本建立專案，並建好約定的目錄,
So that 之後每個 story 都在同一套技術棧與目錄結構上開發。

**Acceptance Criteria:**

**Given** 空的 `main` 分支（只有 BMAD 與 README）
**When** 以 `create-electron-app@8.0.1 --template vite --typescript` 建立專案
**Then** `electron` 鎖在 45.2.1、TypeScript 6.0.3 且 tsconfig `strict: true`、`ses` 鎖確切版本，`.nvmrc` 與 `engines` 寫 Node 24.22.2，`package-lock.json` 已提交
**And** 保留模板預設：`forge.config.mts`、main／preload 產物 `.cjs`、oxlint＋oxfmt、`typecheck` 指令、FusesPlugin（`RunAsNode` 關、`OnlyLoadAppFromAsar` 與 `EnableEmbeddedAsarIntegrityValidation` 開）

**Given** 專案已建立
**When** 檢查目錄
**Then** 存在 `src/shared`、`src/main`、`src/preload`、`src/overlay`、`src/panels`、`src/sandbox`、`test/` 骨架，與架構規約 Structural Seed 一致
**And** `npm run typecheck` 與 lint 通過，`npm start` 能開出模板預設視窗

### Story 1.2: 沙盒原型驗證（AD-7 閘門）

As a 開發者,
I want 在 Electron 45.2.1 實測角色包沙盒的四項關鍵假設,
So that 在投入沙盒與角色包 API 之前，就知道架構規約的做法行不行得通。

**Acceptance Criteria:**

**Given** Story 1.1 的專案，原型程式放在 `prototypes/sandbox/`（不進 `src/`）
**When** 執行原型
**Then** (a) `<iframe sandbox="allow-scripts">`（不給 `allow-same-origin`、套 AD-7 的 CSP）內能以 blob 建立 classic Worker
**And** (b) Worker 內 `lockdown()` 沒有錯誤或警告，`Compartment.evaluate` 能執行一段測試程式
**And** (c) Worker 內 fetch、XHR、WebSocket、EventSource 全部失敗
**And** (d) overlay 能以 PixiJS 從 `pack://` 載入貼圖，並記下 `pack` scheme 需要的最小權限

**Given** 四項結果
**When** 撰寫原型報告 `_bmad-output/implementation-artifacts/sandbox-prototype-report.md`
**Then** 每項寫明通過或失敗、證據與觀察到的限制
**And** 任一項失敗時，停止後續沙盒相關 story，回頭修訂 AD-7 並請使用者確認；四項都通過才標記閘門通過

### Story 1.3: 共用契約、IPC 骨架與 CI

As a 開發者,
I want 共用契約、IPC 註冊方式、preload 與 CI 規則先建好,
So that 之後各模組的邊界、資料格式與依賴方向都有同一套規則可循。

**Acceptance Criteria:**

**Given** Story 1.1 的專案
**When** 建立 `src/shared`
**Then** 最先載入的模組設定 `z.config({ jitless: true })`；運行常數集中在 `src/shared/constants`；IPC 回傳型別為 `{ ok: true, data }`／`{ ok: false, error }`；8 狀態碼與中文顯示名對照只定義一次
**And** 每個 schema 有往返與拒絕測試（Vitest）

**Given** main 註冊 IPC handler
**When** 任何 handler 被呼叫
**Then** 都經過同一個註冊函式，通道名為 `<domain>:<action>`，`senderFrame` 為 null 或不是 `app://` 頂層框架時一律拒絕
**And** `src/preload/overlay.ts`、`src/preload/panels.ts` 各自只暴露最小 API，不依賴 Node polyfill

**Given** CI 設定
**When** 推送到 GitHub
**Then** 在 macOS 與 Windows 跑 typecheck、lint、Vitest
**And** dependency-cruiser 強制 AD-2 的依賴方向，違反時 CI 失敗

### Story 1.4: 可靠的設定、StageView 與運行紀錄

As a 使用者,
I want 我的設定可靠地存下來，並且有運行紀錄,
So that 設定檔壞掉也不會默默遺失，出問題時查得到原因。

**Acceptance Criteria:**

**Given** `main/settings` 擁有 `userData/settings.json`（帶 `schemaVersion`）
**When** 寫入設定
**Then** 一律 temp＋rename；`settings:patch` 帶 `baseRev`，過舊時以欄位合併、同欄位後到者勝，回傳新 `rev`；落地以 `flushDebounceMs` 合併
**And** 沒有提供整份覆寫的 IPC

**Given** `settings.json` 內容壞掉或無法遷移
**When** app 啟動
**Then** 原檔改名為 `settings.json.broken-<時間>`、記一行錯誤、改用預設值並正常啟動
**And** 只有單一欄位型別錯時，只有那一欄用預設，原檔一樣留一份〔FR23〕

**Given** `main/stage-view` 組合目前的設定
**When** renderer 訂閱
**Then** 先收到帶 `rev` 的完整快照，再收到增量；`rev` 不連號或 renderer 重載時重拿快照〔AD-20〕

**Given** app 執行中
**When** 發生啟動、設定錯誤等事件
**Then** 寫入 `userData/logs/` 的運行紀錄：一小時一個檔、一行一件事（時間、類別、內容）
**And** 開新檔時刪除開始時間超過 24 小時的紀錄檔〔FR22〕

### Story 1.5: 選單列／系統匣入口與面板視窗

As a 使用者,
I want 從 macOS 選單列或 Windows 系統匣打開 app 的面板,
So that app 平常不佔 Dock／工作列，需要時又找得到。

**Acceptance Criteria:**

**Given** app 啟動
**When** 看選單列（macOS）或系統匣（Windows）
**Then** 出現 app 圖示，點開的選單有：管理 session、角色包、舞台設定、結束（尚未實作的頁面先顯示「即將推出」）
**And** 沒有任何面板開著時，Dock 與工作列沒有 app 圖示〔FR7〕

**Given** 從選單打開任一面板
**When** 面板開著
**Then** Dock／工作列暫時出現 app 圖示，可用 ⌘Tab／Alt+Tab 切回；所有面板關掉後圖示消失

**Given** app 已在執行
**When** 從應用程式資料夾、Spotlight 或開始選單再啟動一次
**Then** 不開第二個實例，改打開主面板〔NFR10〕

**Given** 面板視窗
**When** 載入
**Then** 打包後由 `app://` 載入、開發時由 Vite dev server 載入；視窗套用 AD-24 的安全設定（`sandbox`、`contextIsolation` 開，`nodeIntegration*` 關，開新視窗與權限請求一律拒絕，CSP 不含 `'unsafe-eval'`）
**And** 面板以 React 19 建立，透過 `src/preload/panels.ts` 訂閱 StageView

### Story 1.6: 透明置頂穿透畫布

As a 使用者,
I want 在我選的螢幕上有一張透明、置頂、不擋操作的畫布,
So that 之後的角色有地方演出，而我照常使用底下的視窗。

**Acceptance Criteria:**

**Given** app 啟動
**When** 畫布視窗建立
**Then** 視窗透明、無邊框、置頂，大小等於所選螢幕；PixiJS 以 `preference: 'webgl'`、透明背景初始化，overlay 入口第一行 `import 'pixi.js/unsafe-eval'`
**And** macOS 用 `type: 'panel'`，在所有桌面空間可見；`backgroundThrottling: false`

**Given** 畫布上沒有任何角色
**When** 使用者點擊畫面任何位置
**Then** 點擊穿透到底下的視窗（`setIgnoreMouseEvents(true, { forward: true })`）〔FR5〕
**And** Linux 上為整窗穿透

**Given** 從選單列／系統匣打開「舞台設定」
**When** 頁面載入
**Then** 顯示最小版的舞台設定頁，目前只有「畫布所在螢幕」一個選項（列出目前接上的螢幕，預設主螢幕），取代 Story 1.5 的「即將推出」
**And** 選擇經 `settings:patch` 寫入

**Given** 使用者在舞台設定改選另一個螢幕，或螢幕邊界、縮放比例改變
**When** `main/windows` 處理
**Then** 畫布移到該螢幕並通知 overlay 新的世界座標（所選螢幕的 DIP、原點左上）
**And** 所選螢幕拔掉時，畫布回到主螢幕

**Given** 畫布 renderer 當掉
**When** `render-process-gone` 發生
**Then** `main/windows` 重建畫布視窗，overlay 重拿 StageView 快照〔NFR12〕
**And** 系統睡眠或鎖定時通知 overlay 暫停節拍，喚醒或解鎖後恢復

## Epic 2: 看見所有 AI session 的狀態

沒有任何角色包時，使用者就能在面板看到 Claude Code、Codex、Gemini、Cursor 的 session 與 8 狀態，能顯示／釋放 session、看轉接器健康、調整計時值，並用示範模式的假 session 看狀態輪播。

### Story 2.1: 偵測事件契約與 8 狀態判斷器

As a 使用者,
I want 不管哪個 AI 工具，同樣的情況都判斷成同一種狀態,
So that 畫面上的狀態可信，而且以後加新工具不會改到判斷規則。

**Acceptance Criteria:**

**Given** `src/shared` 定義共用事件 schema
**When** 轉接器發出事件
**Then** 只能是 `session.start|end|meta`、`turn.start|end`、`tool.start|end`、`approval.request|resolved`、`question.request|resolved`、`error`、`activity`，每個事件帶 `source`、`sessionKey`（`<source>:<原生 id>`）、`ts`、`via`（log／registry／inferred）、`confidence`（由 `via` 推導）
**And** `tool.*` 帶 `toolCallId`，`approval.*`、`question.*` 帶 `requestId`；schema 擋掉 `via` 與 `confidence` 矛盾的組合

**Given** `main/detection/reducer` 為每個 session 維護「進行中 tool 集合」與「未決 approval／question 集合」
**When** 依 AD-21 條件表處理事件序列
**Then** 狀態依優先序 `approval` > `decision` > `error` > `working` > `thinking` > `done` > `waiting` > `idle` 取最高者
**And** `turn.end` 清空該 turn 未關的 tool、approval、question；`activity` 只更新最後事件時間

**Given** 設定 schema 的預設值 `doneMs`＝5 秒、`idleMs`＝5 分鐘
**When** 一輪結束後沒有新事件
**Then** 先是 `done` 5 秒，再轉 `waiting`；最後事件起超過 5 分鐘轉 `idle`〔FR13 的計時部分〕
**And** 以上規則都有「事件序列 → 狀態序列」表格測試（假時鐘）

### Story 2.2: session 生命週期、啟動補讀與推測

As a 使用者,
I want 結束的 session 會消失、app 剛開時不會亂跳狀態、抓不到批准的工具也能被推測出來,
So that 畫面不會留著殭屍 session，也不會漏掉在等我批准的 session。

**Acceptance Criteria:**

**Given** `main/detection/sessions`
**When** 收到 `session.end`、轉接器回報行程已不存在，或最後事件起超過 `sessionExpireMs`
**Then** 該 session 結束；轉接器不得自己用逾時合成 `session.end`

**Given** app 啟動
**When** 轉接器補讀最後修改時間在 `discoveryWindowMs` 內的紀錄
**Then** 補讀事件標 `replay: true`，判斷器只重建條件集合，不啟動推測計時、不產生 `done` 過場
**And** 每個來源補讀完發 `sync.ready`，之後才開始計時；所有計時用單調時鐘

**Given** 某轉接器的能力表宣告 approval 為 `none`
**When** 工具開始後超過 `approvalInferMs`（預設 10 秒）沒有結束
**Then** `main/detection/inference` 產生 `via: inferred` 的 `approval.request`；能力表列為「提問類」的工具改產生 `question.request`〔FR2〕
**And** 收到同 `toolCallId` 的 exact 事件或 `tool.end` 時，推測被取代或關閉；推測只在 `inference` 一處做

### Story 2.3: 示範轉接器、session 面板與轉接器健康

As a 使用者,
I want 沒有角色包、甚至沒開任何 AI 工具時，也能在面板看到 session 與狀態,
So that 我能先確認偵測在運作，也能用示範模式看 8 種狀態。

**Acceptance Criteria:**

**Given** StageView 加入 sessions（`sessionKey`、來源、顯示名稱、狀態、`confidence`）與各轉接器健康（`ok`／`degraded`／`missing`）
**When** 打開「管理 session」面板
**Then** 列出所有 session：來源、顯示名稱、中文狀態名；推測的狀態有明顯不同的標示
**And** 另有轉接器健康列表〔FR25〕

**Given** 從選單列／系統匣打開示範模式
**When** `demo` 轉接器啟動
**Then** 產生 8 個假 session，經同一個判斷器輪播 8 種狀態，面板即時顯示〔FR21 示範模式〕
**And** 關閉示範模式後假 session 結束

**Given** 沒有安裝任何角色包
**When** app 執行
**Then** 偵測、面板、管理 session 都照常運作，畫布為空〔FR24〕
**And** 端到端測試以 `demo` 轉接器為事件來源（Playwright `_electron`）

### Story 2.4: Claude Code 轉接器

As a 使用者,
I want 我的 Claude Code session（終端機與桌面 app）出現在面板並顯示正確狀態,
So that 我不用切視窗就知道哪個在等我。

**Acceptance Criteria:**

**Given** 正在執行的 Claude Code session
**When** 轉接器讀 `~/.claude/sessions/<pid>.json`（只讀檔名符合 `^\d+\.json$` 的檔、只取 `pid`、`sessionId`、`status`、`waitingFor`、`name`、`cwd`、`statusUpdatedAt`）與 transcript `~/.claude/projects/<cwd>/<id>.jsonl`
**Then** session 出現在面板，`sessionKey` 以 session UUID 為原生 id；狀態檔對不到 transcript UUID 時不發事件
**And** 確定的狀態改變後 2 秒內反映在面板〔NFR1〕；等批准時顯示 `approval`（exact）

**Given** 轉接器執行一段時間
**When** 比對執行前後 `~/.claude/` 的檔案雜湊
**Then** 完全不變；轉接器不讀 `*.key`、不連任何 socket、不執行任何 `claude` 指令〔NFR2〕

**Given** 狀態檔格式改變或必要欄位缺少
**When** 解析失敗
**Then** 轉接器健康標 `degraded`，Claude Code 退回只讀 transcript＋推測，不丟例外、不中止

**Given** 去識別化的真實紀錄放在 `test/fixtures/claude-code/`
**When** 執行測試
**Then** 「紀錄 → 共用事件」快照測試通過，涵蓋 subagent 紀錄歸屬父 session、`/clear` 產生新 session、行程結束

### Story 2.5: Codex CLI 轉接器

As a 使用者,
I want Codex CLI 的 session 也出現在面板,
So that 我同時用 Codex 時也能一眼看到狀態。

**Acceptance Criteria:**

**Given** 正在執行的 Codex CLI session
**When** 轉接器讀 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
**Then** session 出現在面板，`thinking`、`working`、`waiting`、`done`、`idle` 由紀錄判斷；顯示名稱優先取 `session_index.jsonl` 的名稱
**And** 能力表宣告 approval、question 為 `none`（由推測產生），`error` 在紀錄有寫時才顯示

**Given** 轉接器執行一段時間
**When** 比對執行前後 `~/.codex/` 的檔案雜湊
**Then** 完全不變〔NFR2〕

**Given** `test/fixtures/codex/` 的去識別化紀錄
**When** 執行測試
**Then** 快照測試通過；壞行跳過並計數，連續失敗只把健康標 `degraded`

### Story 2.6: Gemini CLI 轉接器

As a 使用者,
I want Gemini CLI 的 session 也出現在面板,
So that 我用 Gemini 時也能一眼看到狀態。

**Acceptance Criteria:**

**Given** 正在執行的 Gemini CLI session
**When** 轉接器讀 `~/.gemini/tmp/<專案>/chats/session-*.jsonl`
**Then** session 出現在面板，狀態由紀錄判斷；能力表宣告 approval 為 `none`（由推測產生）
**And** 工具呼叫要等完成才寫入紀錄時，`working` 由推測或下一筆紀錄補上，並寫進轉接器能力表

**Given** 轉接器執行一段時間
**When** 比對執行前後 `~/.gemini/` 的檔案雜湊
**Then** 完全不變〔NFR2〕

**Given** `test/fixtures/gemini/` 的去識別化紀錄
**When** 執行測試
**Then** 快照測試通過

### Story 2.7: Cursor 轉接器

As a 使用者,
I want Cursor（IDE 與 cursor-agent CLI）的 session 也出現在面板,
So that 我用 Cursor 時也知道它在做什麼，即使延遲比較大。

**Acceptance Criteria:**

**Given** Cursor agent session
**When** 轉接器讀 `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
**Then** session 出現在面板：最後一行是 user 為 `thinking`、含 tool_use 且沒有 `turn_ended` 為 `working`、`turn_ended` success 為一輪結束、error 為 `error`
**And** 能力表宣告 approval 為 `none`（由推測產生）；以 step 為單位寫入造成的數秒到數十秒延遲，列為已知限制，不適用 2 秒目標

**Given** `turn_ended` 的 status 為 error
**When** 錯誤字串表示使用者中止
**Then** 視為一輪結束，不顯示 `error`

**Given** 紀錄檔被整檔重寫（檔案變小）
**When** 轉接器偵測到
**Then** 整檔重讀並去重，不重複產生事件
**And** 顯示名稱由 slug 反查專案資料夾，反查不到時用 slug

**Given** 轉接器執行一段時間
**When** 比對執行前後 `~/.cursor/` 的檔案雜湊
**Then** 完全不變〔NFR2〕；`test/fixtures/cursor/` 的快照測試通過

### Story 2.8: 顯示與釋放 session

As a 使用者,
I want 指定哪些 session 要顯示、哪些釋放不追蹤,
So that 我不關心的 session 不會佔畫面。

**Acceptance Criteria:**

**Given** 「管理 session」面板
**When** 對某 session 按「釋放」
**Then** 該 session 標為已釋放、不再追蹤顯示，但仍留在清單裡〔FR4〕
**And** 按「改回顯示」後恢復追蹤

**Given** `main/pool` 擁有 `userData/assignments.json`（帶 `schemaVersion`）
**When** 寫入顯示／釋放狀態
**Then** 一律 temp＋rename，寫入只走 `pool:*` invoke 通道，結果經 StageView 回到面板
**And** 所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）後，丟棄沒有被重新回報的持久化紀錄

### Story 2.9: 調整計時值

As a 使用者,
I want 在舞台設定調「做完了」秒數、轉休息中的時間、推測批准的門檻,
So that 狀態切換的節奏符合我的習慣。

**Acceptance Criteria:**

**Given** Story 1.6 建立的「舞台設定」面板
**When** 打開
**Then** 在螢幕選項之外，新增三個欄位：做完了過場（預設 5 秒）、無動靜轉休息中（預設 5 分鐘）、推測要你批准（預設 10 秒）〔FR14〕

**Given** 使用者修改其中一個值
**When** 送出
**Then** 經 `settings:patch` 寫入，判斷器與推測立即改用新值
**And** 超出合理範圍的值在面板就被擋下，`main/settings` 寫入時再驗證一次

## Epic 3: 角色包上台

使用者匯入 .awpet 後，每個 session 分到一隻角色在畫布上依狀態演出，頭上有名牌與標記；能匯出角色包、選擇哪幾包上場；包當掉自動重啟，停用時角色被換掉。

### Story 3.1: 角色包 API v1 契約與契約測試包

As a 角色包作者,
I want 一份明確、有版本的角色包格式與 API 定義，以及一個能照著寫的範例包,
So that 我寫的包在任何版本相容的舞台上都能演出。

**Acceptance Criteria:**

**Given** `src/shared/pack-api/`（只依賴 zod）
**When** 定義契約
**Then** 包含 manifest schema（`id`、`name`、`version`、`apiVersion`、`entry`、`assets`、`characters`：`id`、`name`、參數宣告、`states`、`fallback`、`hitbox`、`bounds`、`anchor`、`advancedBitmap`；選填 `projectiles`）、舞台→包訊息（`init`、`spawn`、`despawn`、`params`、`meta`、`frame`）、繪圖指令（`sprite`、`particles`、`bitmap`）、API 版本常數
**And** id 格式 `^[a-z0-9][a-z0-9-]{1,63}$`；參數型別 `bool`、`int`、`number`、`choice`、`asset`；每個 schema 有往返與拒絕測試

**Given** `test/packs/contract-pack/`
**When** 檢查內容
**Then** 是不含任何角色或系列名稱的契約測試包，至少 2 個角色、只實作部分狀態並宣告 `fallback`、宣告每種參數型別各一個
**And** CI 掃描 `src/` 不得出現它的 `packId`、`characterId` 字面值〔NFR7〕

### Story 3.2: 匯入與安裝 .awpet

As a 使用者,
I want 匯入別人給我的 `.awpet` 時，危險或不相容的包會被擋下並告訴我原因,
So that 匯入角色包不會弄壞 app 或我的電腦。

**Acceptance Criteria:**

**Given** 使用者從面板選一個 `.awpet`
**When** `main/packs` 檢查
**Then** 含 `..`、絕對路徑、捷徑檔，超過解壓總大小、檔案數或圖片寬高與總像素上限，manifest 不符 schema，入口無法解析，或 `apiVersion` 不相容（主版號不同或包的 minor 大於舞台）時，拒絕並顯示原因（例如「需要舞台 API ≥ x.y」）〔FR11、NFR9〕

**Given** 檢查通過
**When** 安裝
**Then** 先解到暫存，成功才替換到 `userData/packs/<packId>/<version>/` 並更新 `packs/index.json`；失敗時回復舊版
**And** 同 `packId` 已安裝時顯示新舊名稱與版本，經使用者確認才替換；降版另外警告

**Given** 已安裝的包
**When** overlay 或沙盒要讀素材或入口
**Then** 由 `main/packs` 的 `pack://<packId>/<version>/<path>` 處理器提供，只回應 manifest 宣告的素材與入口，拒絕 `..` 與絕對路徑
**And** 所有匯入入口（面板、第二實例帶來的檔案）走同一個匯入流程〔NFR10〕

### Story 3.3: 角色包管理頁

As a 使用者,
I want 在一個頁面管理已安裝的角色包：選哪幾包上場、哪些角色加入池子、匯出或移除,
So that 我能決定畫面上會出現哪些角色。

**Acceptance Criteria:**

**Given** 「角色包」面板
**When** 打開
**Then** 列出已安裝的包（名稱、版本、角色清單、是否上場），可以匯入新包
**And** 每個角色有一個「加入池子」勾選框，是舞台設定的固定參數（不寫進角色包），和之後的角色編輯頁是同一個值〔FR10〕

**Given** 使用者切換某包「上場」或某角色「加入池子」
**When** 送出
**Then** 經 `settings:patch` 寫入，結果經 StageView 回到面板

**Given** 使用者按「匯出」
**When** 選好存檔位置
**Then** 產生只含角色包本身的 `.awpet`，不含使用者的調整〔FR12〕
**And** 按「移除」前要確認，移除後從 `packs/index.json` 刪除該包

### Story 3.4: 池子與 session 分配

As a 使用者,
I want 每個 session 自動分到一隻角色，池子還沒用完時畫面上不會重複,
So that 每隻角色代表一個 session，一眼就分得出來。

**Acceptance Criteria:**

**Given** 池子＝上場的包 ∩ 「加入池子」為開的角色
**When** 出現新的追蹤中 session
**Then** `main/pool` 分配一個角色並產生 `actorId`（不透明字串、執行期間不重用）；池子用完前畫面上不重複，用完才重複（挑出場次數最少者）〔FR3〕
**And** 一筆分配的建立與該 actor 的第一個狀態在同一個 StageView 增量裡

**Given** session 結束或被釋放
**When** `main/pool` 處理
**Then** 角色放回池子；被釋放的 session 收回角色但仍留在管理清單〔FR4 的角色部分〕
**And** 所有來源 `sync.ready`（或 `syncTimeoutMs` 到期）前不建立新分配

**Given** 示範模式的假 session
**When** 分配
**Then** 照同一套池子規則分配〔FR21 示範模式〕

### Story 3.5: 角色包沙盒與載入鏈

As a 使用者,
I want 角色包的程式只能做表演，碰不到我的檔案、網路和系統,
So that 匯入別人的角色包是安全的。

**Acceptance Criteria:**

**Given** Story 1.2 的沙盒原型閘門已通過
**When** 某包有第一個 actor
**Then** `overlay/pack-host` 為它建一個 `<iframe sandbox="allow-scripts">`（文件由 `pack://_stage/sandbox.html` 提供、CSP 由 `src/sandbox` 唯一模組產生並含 bootstrap 雜湊）；依固定順序把入口原始碼與 MessageChannel 一端交給 iframe，iframe 以 bootstrap＋入口建 classic Worker 並把 port 交給 Worker，之後不轉發任何訊息
**And** Worker bootstrap 移除 fetch、XHR、WebSocket、EventSource、WebTransport、importScripts、巢狀 Worker、indexedDB、caches，再 SES `lockdown()`，包放進 `Compartment`，只注入舞台 API（`stage.random`、`stage.log` 等）

**Given** 包送出的每則訊息
**When** pack-host 收到
**Then** 用 schema 驗證、限速，`actorId` 不屬於該包就整則丟棄並記錄 `packId`
**And** 包看不到 `sessionKey`、`source`、`confidence` 與別包的身分

**Given** Electron 層
**When** 檢查設定
**Then** `webRequest` 只放行 `app://`、`pack://`（開發時 overlay、panels 另放行 Vite dev server，沙盒沒有例外）

**Given** Playwright `_electron` 沙盒安全測試
**When** 在真的 Electron 裡讓測試包嘗試 fetch、XHR、WebSocket、EventSource、importScripts、巢狀 Worker、存取 parent／top、indexedDB、`Date.now`、`Math.random`、OffscreenCanvas webgl
**Then** 全部失敗〔NFR3〕
**And** 最後一個 actor 離場後 `sandboxIdleMs` 銷毀該沙盒

### Story 3.6: 世界節拍與統一繪圖

As a 使用者,
I want 分到的角色出現在畫布上並流暢地動,
So that 我看得到每個 session 的角色。

**Acceptance Criteria:**

**Given** StageView 有 actor
**When** `overlay/world` 放置角色
**Then** 角色出現在畫布上（遊走在 Epic 4 加入，這裡先依序排在畫面底部），pack-host 對該包送 `init`／`spawn`（含完整有效參數、狀態、session 顯示名稱）

**Given** world 以 `tickHz`（預設 30）推進
**When** 每個 tick
**Then** 對有 actor 的包送一則 `frame`（`seq`、`t`、`dt`、己方 actor 狀態與 `motion`、事件）；每包同時最多一則在途，沒回就跳過，不排隊
**And** renderer 每個顯示幀用該包最後一則有效 `draw`，永不等待；一包變慢不影響其他角色〔NFR4〕

**Given** 包回傳 `draw`
**When** renderer 繪製
**Then** 在單一 PixiJS WebGL 畫布上，以 actor 本地座標（原點為腳底中心）繪製，外層依序套 world 位置、固定參數「大小」、actor 間依 y 排序；超出 manifest `bounds` 的內容裁切〔NFR13〕
**And** 素材以 manifest key 引用、從 `pack://` 載入並快取；超過指令數、位元組數等上限的 `draw` 整則丟棄並記錄 `packId`

**Given** 角色的有效參數
**When** 計算
**Then** 由 `main/settings` 依 manifest 宣告與覆蓋值計算（目前沒有覆蓋值時就是包預設值），包收到完整值；固定參數由舞台套用、不傳給包

### Story 3.7: 依狀態演出、後備與佔位

As a 使用者,
I want 角色依 session 的 8 種狀態演出不同動作，沒做的狀態也有替代演出,
So that 看角色就知道 session 在做什麼。

**Acceptance Criteria:**

**Given** 角色 manifest 的 `states` 有該狀態
**When** session 進入該狀態
**Then** pack-host 在 `frame` 裡送原狀態，角色演出對應動作〔FR13〕

**Given** `states` 沒有該狀態但 `fallback` 有指定
**When** session 進入該狀態
**Then** 送 `fallback` 指定的狀態

**Given** 兩者都沒有
**When** session 進入該狀態
**Then** 舞台畫內建佔位演出，該 actor 的 `draw` 忽略到狀態改變；空的 `draw` 代表這格不畫，不觸發佔位
**And** 用契約測試包驗證：一輪結束先演 `done` 5 秒再轉 `waiting`

### Story 3.8: 名牌與狀態標記

As a 使用者,
I want 每隻角色頭上顯示 session 名稱和狀態標記,
So that 我知道哪隻代表哪個工作、現在是什麼狀態。

**Acceptance Criteria:**

**Given** 畫布上的角色
**When** 繪製
**Then** 舞台在 manifest `anchor` 的位置畫名牌（session 顯示名稱）與狀態標記；包不畫名牌〔FR8〕
**And** `confidence` 為 `inferred` 的狀態用另一種標記樣式，和確定的狀態看得出差別

**Given** 某角色的固定參數「名牌與標記顯示」為關
**When** 繪製該角色
**Then** 名牌與標記都不畫
**And** session 顯示名稱變更時，名牌即時更新，包也收到 `meta`

### Story 3.9: 角色包當掉與換角色

As a 使用者,
I want 某個角色包壞掉或被停用時，畫面上的角色自動處理好,
So that 不會有角色一直卡住，其他角色也照常演出。

**Acceptance Criteria:**

**Given** 某包心跳逾時（以 tick 計）、超限或未捕捉例外
**When** pack-host 偵測到
**Then** 移除該包 iframe（連帶終止 Worker）、該包 actor 改演佔位，經 IPC 回報 `packs:runtime-failed`；其他包照常演出〔NFR4〕
**And** 自動重建沙盒並保留原 `actorId` 重新 `spawn`，同一包在本次執行最多重啟 3 次；第 4 次失敗時 `main/packs` 標記該版本失敗（視同停用），角色包管理頁顯示原因〔FR19〕

**Given** 包被停用、移除、標為失敗，角色取消加入池子，或包更新後角色消失
**When** `main/pool` 處理
**Then** 受影響的 actor 立刻換成池子裡的其他角色（舊 actor `leave`、新 actor `enter`）；池子空了就收回角色，session 留在管理清單〔FR20〕

**Given** 包更新安裝成功
**When** pack-host 收到新版本
**Then** 卸除舊沙盒，以新版本 URL 重載，對仍存在的角色保留原 `actorId` 重新 `spawn`；素材 URL 帶版本，不會新舊混用

## Epic 4: 角色在桌面上活起來

角色會遊走；使用者能左鍵捏起來拖走、右鍵開選單；不同包的角色透過五種通用互動與發射物件彼此反應，同包角色有專屬互動，包能請自己的角色停下或轉向。

### Story 4.1: 角色遊走

As a 使用者,
I want 角色在畫面上自己走動，並照我設的遊走偏好活動,
So that 桌寵看起來是活的，又不會老是待在我不想要的地方。

**Acceptance Criteria:**

**Given** 畫布上的角色
**When** `overlay/world` 推進節拍
**Then** 角色在所選螢幕範圍內遊走，依固定參數「遊走偏好」決定活動範圍、移動頻率與偏好區域（軟偏好，不是限制在某一格）〔FR5〕
**And** 包在 `frame.motion` 收到是否移動與面向；actor 之間依 y 排序繪製

**Given** 某角色的遊走偏好設成不遊走
**When** world 推進
**Then** 該角色一定不動

### Story 4.2: 游標在角色上才接收滑鼠

As a 使用者,
I want 只有游標在角色身上時畫布才接收滑鼠，其他地方照樣點得到底下的視窗,
So that 桌寵不擋我工作，又能和角色互動。

**Acceptance Criteria:**

**Given** 畫布預設穿透並以 `forward: true` 收游標位置
**When** 游標移進某角色的 hitbox（manifest `hitbox` ×「大小」，由 world 計算）
**Then** overlay 請 `main` 關閉穿透；移出後恢復穿透〔FR5〕
**And** 穿透狀態由 overlay 擁有，只在「在角色上／不在」改變時送帶遞增 `seq` 的請求，main 冪等處理並丟棄過時請求

**Given** 繪圖內容超出 hitbox
**When** 游標在超出的部分
**Then** 仍然穿透（命中只看 hitbox）

**Given** Windows 前景是管理員權限視窗，或在 Linux 上
**When** 使用者想點角色
**Then** Windows 這段期間角色點不到（已知限制）；Linux 維持整窗穿透，操作改走系統匣選單

### Story 4.3: 右鍵角色選單

As a 使用者,
I want 右鍵角色時跳出選單,
So that 我能直接從角色打開它的設定、找到它的 session，或暫時讓桌寵安靜下來。

**Acceptance Criteria:**

**Given** 游標在角色上
**When** 按右鍵
**Then** 跳出選單：這個角色的編輯頁、管理 session、暫停／顯示〔FR7〕
**And** 選單內容由 `main/windows` 一處定義，角色包不能加項目

**Given** 選單項
**When** 選「這個角色的編輯頁」
**Then** 打開該角色的編輯頁（編輯頁尚未完成時顯示「即將推出」）
**And** 選「管理 session」打開管理 session 面板並選取這隻角色的 session

**Given** 選「暫停」
**When** 執行
**Then** 畫布上所有角色暫時隱藏、節拍暫停；再選一次「顯示」（右鍵或選單列都有）就恢復

### Story 4.4: 左鍵捏起來拖走

As a 使用者,
I want 角色剛好走到礙眼的位置時，用左鍵把它捏起來拖到旁邊,
So that 我不用改設定也能馬上讓它讓開。

**Acceptance Criteria:**

**Given** 游標在角色 hitbox 上
**When** 按住左鍵拖曳
**Then** world 把該 actor 標為被捏起來：暫停遊走、跟著游標移動、位置限制在畫面內；拖曳期間 overlay 維持不穿透到放開為止，即使游標移出 hitbox〔FR6〕
**And** 送出 `grab`（`phase: begin`）給所有有 actor 的包，捏住期間該 actor 的 `frame.motion.held` 為 `true`

**Given** 使用者放開左鍵
**When** world 處理
**Then** 角色留在放開的位置並從那裡直接恢復遊走，送出 `grab`（`phase: end`）

**Given** 被捏的角色所屬的包沒實作捏起來動作
**When** 拖曳
**Then** 角色照原樣被拎著走，不報錯
**And** 包收不到任何原始滑鼠事件，只收到 `grab`

### Story 4.5: 進場離場、靠近碰撞與狀態廣播

As a 使用者,
I want 不同角色包的角色會注意到彼此：有人來了、走近了、某隻出錯了,
So that 桌面上的角色之間有互動，而不是各演各的。

**Acceptance Criteria:**

**Given** actor 加入或移出世界
**When** world 處理
**Then** 產生 `enter`／`leave`；換角色＝舊 actor `leave`＋新 actor `enter`〔FR15〕

**Given** 兩個 actor 進入或離開靠近半徑，或 hitbox 相交與分開
**When** world 偵測到
**Then** 產生邊緣觸發的 `proximity`（`phase` 為 `begin`／`end`，`kind` 為 `near` 或 `touch`）

**Given** 某 actor 的狀態改變
**When** pack-host 從 StageView 得知
**Then** 產生 `state-broadcast`（`actorId`＋8 狀態碼）

**Given** 上述事件
**When** 送出
**Then** 放在下一則 `frame` 送給每個其他 actor 的擁有包（同包也送）；事件只含 `actorId` 與狀態碼，不含別包的 `packId`、`characterId`、顯示名稱、`sessionKey`
**And** 沒處理該事件的包不反應、不報錯

### Story 4.6: 發射物件與被擊中

As a 使用者,
I want 角色能朝別的角色發射東西，被打中的角色有反應,
So that 例如 00 射中寶可夢時，有被擊中特效的寶可夢就會有反應。

**Acceptance Criteria:**

**Given** 包呼叫 `stage.fire(fromActorId, { target, object })`
**When** world 處理
**Then** 有 `target` 就朝目標發射，否則依面向水平發射；速度、射程、每個 actor 每秒次數上限是舞台常數，超出的丟棄〔FR16〕
**And** 飛行物件屬於 world，由 renderer 直接畫，射方包不參與每格繪製

**Given** `object` 是 manifest `projectiles` 的 key
**When** 繪製
**Then** 用包的素材；沒指定、舞台不認得且包裡也沒附，或素材載入失敗時，改丟一個隨機的通用物件，不報錯、不會什麼都不丟

**Given** 飛行物件碰到另一個 actor 的 hitbox
**When** world 判定命中
**Then** 送 `hit`（被打的 `actorId`、射方 `byActorId`、`projectile` 為 `generic` 或 `custom`）給所有有 actor 的包（同包也收）〔FR15〕
**And** 被打的包沒處理 `hit` 就沒有反應；射方包卸除後，它的自訂物件改以通用外觀飛完

### Story 4.7: 同包角色的特殊互動

As a 角色包作者,
I want 同一包的角色能對彼此的事件做專屬反應,
So that 例如同一系列的主角群可以有只屬於他們的配合演出。

**Acceptance Criteria:**

**Given** 同一包有多個 actor 在畫布上
**When** 其中一個產生事件（進場、靠近、被擊中、狀態變化）
**Then** 同包的其他 actor 也收到該事件（舞台不過濾同包事件），同包所有 actor 在同一個沙盒、由同一份包程式以 `actorId` 區分〔FR17〕
**And** 涉及世界物件的互動（發射、命中）一律走舞台 API

**Given** 契約測試包
**When** 擴充一段同包互動
**Then** 兩隻己方角色靠近時各自演出專屬反應，端到端測試驗證這段反應出現

### Story 4.8: 包請角色停下、恢復遊走與轉向

As a 角色包作者,
I want 請自己的角色停在原地、恢復遊走或轉向,
So that 例如「坐下來工作」時角色不會一邊坐一邊被拖著走。

**Acceptance Criteria:**

**Given** 包呼叫 `stage.hold(actorId, true)`
**When** world 處理
**Then** 該角色停在原地；`stage.hold(actorId, false)` 恢復遊走〔FR18〕
**And** `stage.face(actorId, 'left' | 'right')` 讓角色轉向

**Given** 包對不屬於自己的 `actorId` 呼叫
**When** pack-host 驗證
**Then** 整則丟棄並記錄 `packId`

**Given** 使用者把該角色設成不遊走，或角色正被捏起來
**When** 包呼叫 `hold(false)` 或 `face`
**Then** 不生效；包始終拿不到座標，也不能指定位置

## Epic 5: 調整角色與預覽

使用者在角色編輯頁調固定參數與依包宣告自動產生的參數，並用展示模式指定任何角色在畫布上預覽。

### Story 5.1: 角色編輯頁：固定參數

As a 使用者,
I want 在角色編輯頁調整每個角色的大小、是否加入池子、遊走偏好、名牌與標記顯示,
So that 每個角色在我桌面上的樣子和行為符合我的習慣。

**Acceptance Criteria:**

**Given** 從角色包管理頁的角色清單或選單列打開某角色的編輯頁（Epic 4 完成後，右鍵選單的「這個角色的編輯頁」也打開同一頁）
**When** 頁面載入
**Then** 上半部顯示四個固定參數：大小、加入池子、遊走偏好（活動範圍、移動頻率、偏好區域）、名牌與標記顯示〔FR9〕
**And** 「加入池子」和角色包管理頁的勾選框是同一個值，一邊改另一邊同步

**Given** 使用者修改固定參數
**When** 送出
**Then** 經 `settings:patch` 寫入舞台設定（以 `<packId>/<characterId>` 為單位，不寫進角色包），畫布上該角色立即套用
**And** 固定參數由舞台套用，不傳給角色包

### Story 5.2: 依角色包宣告自動產生參數欄位

As a 使用者,
I want 角色包開放的參數自動出現在編輯頁下半部，我改了就生效，重新匯入包也不會不見,
So that 每個新角色包都能調整，而不用等誰幫它寫設定畫面。

**Acceptance Criteria:**

**Given** 角色 manifest 宣告的參數
**When** 打開編輯頁
**Then** 下半部依型別自動產生欄位：`bool` 開關、`int`／`number` 依 `min`／`max`／`step` 的數值欄位、`choice` 下拉選單、`asset` 只能從 manifest `assets` 已宣告的圖挑（附縮圖）〔FR9〕
**And** 每個欄位顯示目前有效值（有覆蓋值用覆蓋值，否則用包預設值），並可「還原預設」

**Given** 使用者修改包參數
**When** 送出
**Then** `main/settings` 依當下 manifest 驗證後寫入覆蓋值，包在下一個 tick 內收到完整有效值的 `params`，同一角色每 tick 至多一則
**And** 面板的驗證只做提示，最終以 `main/settings` 的驗證為準

**Given** 使用者重新匯入同一個包，或包更新後某參數已不存在或宣告改變
**When** 計算有效值
**Then** 覆蓋值仍保留在舞台設定；符合目前宣告才套用，不符合就用包預設值且不刪除原覆蓋值

### Story 5.3: 展示模式與編輯頁預覽

As a 使用者,
I want 指定任何角色和狀態在畫布上預覽,
So that 我能看清楚每個角色各種狀態的演出，也能邊調參數邊看效果。

**Acceptance Criteria:**

**Given** 從選單列打開展示模式
**When** 選擇任一已安裝角色（包含沒加入池子的）與 8 種狀態之一
**Then** `demo` 轉接器產生一個假 session，經同一套判斷器與世界讓該角色在畫布上演出指定狀態〔FR21 展示模式〕
**And** 展示模式的指定只對 `demo` 來源的 session 有效、不存檔、不佔池子名額，不影響真 session 的分配

**Given** 角色編輯頁
**When** 按「在畫面上預覽」
**Then** 以展示模式在畫布上演出這個角色，參數修改即時反映在預覽上

**Given** 結束展示模式
**When** 關閉
**Then** 假 session 結束、預覽角色離場，畫布回到原本狀態

## Epic 6: 支援 Copilot CLI

Copilot CLI 的 session 也會出現在畫面上。排在最後，必須用真實的 Copilot CLI session 驗證過才算完成。

### Story 6.1: Copilot CLI 轉接器（需真實 session 驗證）

As a 使用者,
I want Copilot CLI 的 session 也出現在面板與畫布上,
So that 我開始用 Copilot CLI 時也能一眼看到它的狀態。

**Acceptance Criteria:**

**Given** 正在執行的 Copilot CLI session
**When** 轉接器讀 `~/.copilot/session-state/<id>/events.jsonl`（支援 `COPILOT_HOME`）
**Then** session 出現在面板：`user.message`／`assistant.turn_start` 之後為 `thinking`，`tool.execution_start` 未配對 `tool.execution_complete`（以 `toolCallId`）為 `working`，`permission.requested` 未配對 `permission.completed`（以 `requestId`）為 `approval`，`session.error` 為 `error`〔FR1 Copilot CLI〕
**And** 能力表依實測結果宣告；`session.idle`、`user_input.requested` 不寫入檔案，`waiting` 與提問由推測產生

**Given** 紀錄中的 `abort`、`checkpoint: true`、帶 `agentId` 的事件
**When** 轉接器處理
**Then** `abort` 視為一輪結束而不是錯誤；`checkpoint` 重複事件以 `id` 去重；subagent 事件不另算一個 session
**And** 顯示名稱取 `workspace.yaml` 的名稱或 `cwd`

**Given** 轉接器執行一段時間
**When** 比對執行前後 `~/.copilot/` 的檔案雜湊
**Then** 完全不變〔NFR2〕

**Given** 本 story 的完成條件
**When** 驗收
**Then** 必須用一個真實的 Copilot CLI session 走過 thinking、working、approval、一輪結束與 error（或中止），把去識別化紀錄放進 `test/fixtures/copilot/` 並通過快照測試；研究結果與實測不符的地方，更新能力表與架構規約 AD-4 的來源表
**And** 沒有真實 session 可測時，本 story 維持未完成
