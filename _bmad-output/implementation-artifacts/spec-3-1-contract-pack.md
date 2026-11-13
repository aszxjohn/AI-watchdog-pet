---
title: 'Story 3.1（下）：契約測試包、字面值掃描與作者文件'
type: 'feature'
created: '2026-11-13'
baseline_commit: 'd8c999fb4ddbfad247796ba4eb4b30dc6e7d9b61'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-1-pack-api-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包 API v1.0 的契約已經在 `src/shared/pack-api/`（3.1 上半段，`d8c999f`），但還有三樣東西沒有：
- 一個照著契約寫、能實際跑的範例包。
- 防止範例包名稱混進 `src/` 的檢查。
- 給包作者看的文件。

**Approach:**
- 在 `test/packs/contract-pack/` 放一個不含任何角色名稱的契約測試包。
- 用測試確認它通過契約，並在沒有禁用全域的 `node:vm` 裡實際跑它的入口。
- 加一個掃描 `src/` 的測試。
- 寫繁中角色包作者文件 `docs/pack-api-v1.md`。

**Decisions（2026-11-13）：**
- `frame` 處理函式回傳 `{ [actorId]: 指令[] }`（`draw` 的 `actors` 部分）。`type: 'draw'` 與 `seq` 由 Worker bootstrap（3.5）包上，作者不必回填 `seq`。
- 契約測試包以解開的資料夾形式存放，不是 `.awpet`。3.2 測匯入時再把它壓成 zip。

## Boundaries & Constraints

**Always:**
- 契約包的 packId 是 `contract-pack`，角色是 `probe-one`、`probe-two`。名稱與標籤用「探針一」這類不像任何作品的字。
- 入口 `entry.js` 是不含 `import`／`require` 的 classic script，求值結果是工廠函式；不用任何禁用全域，時間只取 `frame.t`，亂數只用 `stage.random(actorId)`。
- `test/` 會跑 oxlint 與 oxfmt，契約包的 `.js`、`.json` 也要通過。真的需要停用某條規則時，用檔內註解寫明原因。
- 作者文件的內容以 `src/shared/pack-api/` 為準，欄位名、範圍、預設值與程式一致。

**Never:**
- 不改 `src/`、`.github/`、`prototypes/`。
- 不做 zip 打包、`pack://`、沙盒（3.2、3.5）。

## I/O & Edge-Case Matrix

| 情境 | 輸入 | 預期 |
|---|---|---|
| manifest | `manifest.json` | `manifestSchema` 通過，`apiVersion` 與舞台相容 |
| 檔案對得上 | 包資料夾內所有檔 | manifest 引用的檔都存在；每個檔都有被引用（spritesheet 的圖由它的 JSON `meta.image` 引用） |
| spritesheet | 包內的 spritesheet JSON | `frames` 不是空的，`meta.image` 指到包內存在的圖 |
| 部分狀態 | 每個角色 | `states` 不是全部 8 種；有 `fallback`；至少一個狀態既不在 `states`、也不在 `fallback` 裡（3.7 驗佔位用） |
| 參數型別 | 整包 | `bool`、`int`、`number`、`choice`、`asset` 各至少一個 |
| 入口求值 | `entry.js` 在 `vm` context 裡求值：沒有 `Date`、`console`、計時器，`Math.random` 呼叫就丟錯 | 得到函式；用假的 `stage` 呼叫後回傳 handlers |
| 演出 | 依序呼叫 `init`、`spawn`（兩個角色各一個 actor）、`frame` 兩次 | `frame` 的回傳包上 `type`、`seq` 後通過 `drawMessageSchema`；只含己方 `actorId`；sprite 的 `asset` 都是 manifest 的 key |
| 亂數 | `entry.js` 有用到亂數 | 只透過 `stage.random`；假 `stage` 記錄到呼叫 |
| 掃描 | `src/` 任一檔含 `contract-pack`、`probe-one` 或 `probe-two` | 測試失敗；目前 0 處 |
| 掃描本身 | 掃描函式拿到一段含其中一個 id 的文字 | 會回報（確認掃描不是空轉） |

</frozen-after-approval>

## Code Map

- `test/packs/contract-pack/contract-pack/`（新）：
  - `manifest.json`：照 `src/shared/pack-api/manifest.ts`。
  - `entry.js`。
  - 幾張極小的 PNG，可用 Node 從 base64 寫出 1×1 或 2×2 的圖。
  - 一份 PixiJS spritesheet JSON：`{ frames: { 名稱: { frame: { x, y, w, h } } }, meta: { image, size, scale } }`。
- `test/packs/contract-pack.test.ts`（新）：
  - 涵蓋 I/O 矩陣前 8 列。用 `node:fs` 讀檔，用 `src/shared/pack-api` 的 schema 驗證。
  - `vm` context 只放必要的內建物件。執行前移除 `Date`、`console`、`setTimeout` 等，並把 `Math.random` 換成呼叫就丟錯的函式。
  - 假的 `stage` 提供 `random(actorId)`（可重現的值並記錄呼叫）與 `log`。
- `test/tooling/pack-literals.test.ts`（新）：
  - 讀契約包的 manifest，取出 packId 與 characterId。
  - 遞迴掃 `src/` 的所有檔，寫法照 `test/tooling/guard-rules.test.ts` 用 `readdirSync` 的部分。
  - 掃描邏輯寫成可單獨測的函式，涵蓋矩陣最後兩列。
- `docs/pack-api-v1.md`（新，繁中）：
  - 內容：
    - `.awpet` 結構（zip，根目錄一個 `<packId>/`）。
    - manifest 各欄位與限制：包 id 的額外限制、標準路徑寫法、`fallback` 對照、`hitbox` 要在 `bounds` 內、本地座標系。
    - 參數宣告、固定參數與 `defaults`，以及推薦身高 110（82.5～137.5 不提示）。
    - 入口寫法：工廠 `(stage) => handlers`，handlers 的鍵是訊息名稱，`frame` 回傳 `{ [actorId]: 指令[] }`。
    - 六種訊息（別包 actor 的狀態只在 `init` 當下有效）。
    - 三種繪圖指令與預設值，emitter 的範圍是單一 actor。
    - `stage` API：`random`、`log`、`canvas`；`fire`、`hold`、`face` 的世界行為在 Epic 4 才有。
    - 版本規則：相容＝主版號相同且包 minor ≤ 舞台 minor；包要忽略不認得的欄位；1.1 會加入 `motion` 與互動事件。
  - 禁用清單：
    - Compartment 內沒有：`Date` 的 `now` 與 `new Date()`、`Math.random`、`console`、計時器、`Float16Array`／`Float32Array`／`Float64Array`。
    - 沒有 `crypto.subtle`（Worker 不是 secure context）。
    - 已移除：`Iterator.prototype.join`／`includes`（`prototypes/sandbox/web/sandbox/ses-unknown-intrinsics.js`），以及 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`WebTransport`、`importScripts`、`Worker`、`SharedWorker`、`indexedDB`、`caches`（`worker-bootstrap.js:10-21`）。
  - 文件裡以契約測試包當範例。
- `deferred-work.md`：新增一項，3.5 建立 `src/sandbox` 的移除清單時，加一個測試確認它與作者文件的禁用清單一致。

## Tasks & Acceptance

**Execution:**
- [x] `test/packs/contract-pack/`：契約測試包。
- [x] `test/packs/contract-pack.test.ts`、`test/tooling/pack-literals.test.ts`：涵蓋 I/O 矩陣。
- [x] `docs/pack-api-v1.md`。
- [x] `deferred-work.md`：記錄禁用清單一致性。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，既有斷言不變。
- Given 作者文件，when 對照 `src/shared/pack-api/` 的 schema，then 欄位名、範圍、預設值一致。

## Implementation Notes

- 2026-11-13 實作時規格沒寫明、開發代理自行決定的部分：
  - 包內容：`probe-one`（`bool`、`number`、`asset`）、`probe-two`（`int`、`choice`，帶 `defaults`）。素材有 2 張單圖（給 `asset` 參數）、1 份 spritesheet（4×2 的圖切 2 格）、1 張 `spark`（給 `projectiles`）。PNG 用一次性的 Node 腳本（`zlib` 的 deflate 與 crc32）產生，腳本沒有進 repo。
  - `entry.js` 整支是一個加括號的函式運算式；oxlint 的 `no-unused-expressions` 會擋，所以只對這一行停用，並在檔內註解寫明原因。
  - vm 刪掉作者文件第 10 節列的全域，連 vm 本來就沒有的網路 API 與 `crypto` 也列進去，讓刪除後的檢查涵蓋整份名單；`Iterator.prototype.join`／`includes` 存在時也刪。`Date` 整個刪掉，比 SES 嚴格（SES 裡 `new Date(毫秒)` 仍可用）。
  - 額外檢查（矩陣沒要求，成本很低）：
    - 外層資料夾只有 `<packId>/`。
    - 檔案清單略過 `.DS_Store`（git 會忽略它，但 Mac 上用 Finder 開過資料夾就會出現）。
    - spritesheet 圖的 PNG 寬高等於 `meta.size`，每格都在圖內。
    - sprite 的 `frame` 與素材種類相符。
    - 入口原始碼不含 `import`、`require`、`Math.random` 字樣。
    - 另有一個矩陣外的測試，送 `params`、`meta`、`despawn`。
  - 測試送給包的訊息都先過 `stageMessageSchema` 再 structured clone；`frame` 的回傳是另一個 realm 的物件，也先 structured clone（等同 Worker 經 port 送出）再驗 `drawMessageSchema`。
  - 作者文件的 `stage` API 照 AD-16 寫。`stage.random` 回傳 [0, 1) 是開發代理的假設，AD-16 沒寫範圍。文件最後一節列出尚未定案的部分：`stage` 確切呼叫方式、preset 清單、上限數值、sprite 對齊點。另外補了兩項 SES 的事實：strict mode 求值、內建物件已凍結。
- 2026-11-13 開發代理驗證：`npm run typecheck`、`npm run lint`、`CI=true npm test`（74 檔、3467 個測試）、`npm run depcruise`（210 個模組、0 違規）全過。反向驗證：對契約包做 23 種破壞（用 `Date.now`、`Math.random`、`console`、`setTimeout`、畫別人的 actor、不存在的素材、單圖帶 `frame`、壞 preset、不經 `stage.random`、多一個檔、少一個檔、`meta.image` 錯、`meta.size` 錯、空 `frames`、8 種狀態全實作、沒有 `fallback`、`fallback` 補滿、少 `int`、`apiVersion` 1.1、ESM `export`、求值結果不是函式等），每一種都有對應的測試失敗；`console` 只寫在 `despawn` 時，只有矩陣外那個測試會抓到。字面值掃描改掃 `test/packs/` 時回報 10 處。破壞後都已還原（`diff -r` 確認）。

- 2026-11-13 主 session 核對：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`（210 個模組、0 違規）、`CI=true npm test`（74 檔、3467 個測試）全過；`src/`、`.github/`、`prototypes/` 與既有測試沒有改動；I/O 矩陣 10 列都有測試且都有跑。作者文件的數值與 `src/shared/pack-api/` 的常數抽查一致（64、1000、32、0.5～2.0、82.5～137.5、`[6, 7, 8]`）。作者文件第 8.2 節（`stage` API）與第 11 節「尚未定案」照架構撰寫，3.5、3.6 實作後要回頭更新。

- 2026-11-13 審查修補後：`stage` 與訊息改在 vm realm 內建立（宿主只提供一個收兩個字串的記錄回呼，訊息以 JSON 字串送入），入口前加 `'use strict'`、凍結 8 個常用內建原型、移除 `Intl` 等宿主全域，並驗證沿 `.constructor` 拿不到 `Date`；補 `params` 生效、沙盒重啟（帶己方 actor 的 `init`）、despawn 的實質斷言，每格斷言己方 actor 都有條目；`.DS_Store` 與 symlink 處理一致；單圖驗證是 PNG；字面值掃描改為不分大小寫、去掉 `-`／`_` 後比對；作者文件補選填欄位的 `undefined`／`null` 陷阱、§10 原則（依 SES 2.3.0 原始碼：ECMAScript 內建物件扣除部分、SES 的少數全域如 `harden`、加上 `stage`）、§8.3 節拍、§8.4 沙盒生命週期與執行失敗、§9 更新規則、§11 尚未定案清單（全部照 `epic-3-context.md` 並註明出處）。開發代理回報反向驗證：故意改壞 `entry.js` 7 種都有測試失敗。我重跑四項檢查全過（74 檔、3470 個測試；depcruise 210 個模組、0 違規）；`src/` 沒有改動。作者文件 §9「參數 key 或角色 id 改名後舊調整不再套用」是開發代理從設定的記錄方式推得，不是 epic 原文。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-13）：Blind Hunter 18 條（B1–B18）、Edge Case Hunter 19 條（E1–E19）、Verification Gap 2 個缺口（VG1、VG2）與 2 條其他發現（VO1、VO2）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| E19 | 假 `stage` 的函式與訊息物件來自宿主 realm，入口能用 `stage.random.constructor('return Date')()` 拿到宿主的 `Date`，「沒有禁用全域」的檢查可被繞過 | high | patch | 實測 `typeof stage.random.constructor("return Date")()` 是 `function`；`stage` 與訊息要在 vm realm 裡建立 |
| VG1、B15a、B15d、E10 | `params` 測試沒有確認新值生效（skin 換圖、mood 變 busy 後的 `rotation`）；換不出新值時會悄悄退回預設 | medium | patch | 驗證缺口已附證據：清空 `params` handler 仍 9/9 通過 |
| VG2、B15c、E11 | 帶己方 actor 的 `init`（沙盒重啟路徑）沒有任何測試執行過 | medium | patch | 驗證缺口已附證據：在那個分支放 `Date.now()` 仍 9/9 通過 |
| B15b、E7 | 每格只檢查指令總數大於 0，沒檢查本格每隻己方 actor 都有條目 | low | patch | 角色 id 與入口對不上時什麼都不畫也會通過 |
| VO1、E9 | 「despawn 之後不再畫」的斷言是空的：之後那格本來就沒列 actor-1 | low | patch | 改成 despawn 後送一格仍列著 actor-1，斷言沒有它 |
| VO2、E1、E2 | 根目錄的 `readdirSync` 沒略過 `.DS_Store`；`statSync` 會跟著 symlink，壞掉的 symlink 會讓測試當掉 | low | patch | `packFiles()` 有略過、這裡沒有，兩邊不一致；改用 `lstat` 並斷言沒有 symlink |
| E4、E5、E8、B7 | vm 以非 strict 求值、內建物件沒凍結；`Intl` 還在，可讀牆上時間；`bitmap` 只限 `advancedBitmap` 角色沒檢查；三張單圖沒驗是不是 PNG | low | patch | 文件寫 strict mode 與 lockdown；在原始碼前加 `'use strict'`、凍結常用內建原型、移除 `Intl`，補兩項檢查 |
| B16、B17（部分）、E17 | 字面值掃描的檔頭說「src/ 沒有角色或系列名稱」，實際只做區分大小寫的完全比對 | low | patch | 檔頭改成符合實際；比對改成不分大小寫，並去掉 `-`、`_` 後再比 |
| B3 | 選填欄位寫成 `undefined` 或 `null` 會讓整則 draw 被丟掉（`exactOptional`），文件沒警告 | medium | patch（文件） | 實測 strictObject 加 exactOptional 遇到 `{ frame: undefined }` 驗證失敗 |
| B18 | 文件 §4 的 `number` 列沒寫 `min ≤ max`；§2.2 漏列飛行物件 id | low | patch（文件） | 與 `params.ts`、`manifest.ts` 不一致 |
| B11、E5 | §10 讀起來像完整清單，漏了 `performance.now()`、`crypto.getRandomValues`、`Intl`、Worker 的宿主全域 | low | patch（文件） | 改成先講原則：Compartment 只有 ECMAScript 內建物件加 `stage`，再列常見影響 |
| B14 | `stage.random` 回傳 [0, 1) 是假設 | low | patch（文件） | 移到 §11 尚未定案 |
| B1、B2、B6、B8、B9、B10、B13、E12、E13 | 文件缺：失敗後的處理與重啟次數、節拍（同時最多一則 frame、跳過不排隊）、佔位時收到的狀態、訊息順序、draw 漏掉己方 actor 的處理、handlers 的規則、打包與更新指引、sprite 對齊與範例座標 | low | patch（文件） | 架構已定的（失敗與重啟、節拍、沙盒生命週期、替換與降版、characterId 穩定）照 epic context 寫並註明出處；其餘列入 §11 尚未定案，範例座標標明是暫定 |
| B4、B5、E3 | spritesheet 的圖不列進 `assets`，與「`pack://` 只回應宣告過的素材」衝突；spritesheet JSON 的格式只定義在測試檔 | medium | defer | 要 3.2 的 `pack://` 處理器把宣告過的 spritesheet 的 `meta.image` 算成已宣告，3.6 定支援的 JSON 欄位；文件 §11 先註明 |
| E14、E15、E16、B12 | 路徑段可以是 Windows 裝置名（`img/con.png`）、只差大小寫的兩個路徑會互相覆蓋、包 id 沒擋 `com0`／`lpt0` | medium | defer | 要改 `src/shared/pack-api`，超出本段範圍；交給 3.2 的路徑安全檢查一起做 |
| E6 | `actorIdSchema` 允許 `__proto__` | low | defer | 改 `src/` 超出本段；交給 3.4 產生 `actorId` 時一起收緊 |
| B17 | `src/main/detection/adapters/cursor/project-name.ts:6`、`:15` 的註解範例路徑含系列名稱 `gundam-pet`，可能違反 NFR7 | medium | defer | 2.7 既有，不是本段造成；本段 Never 不改 `src/`。修法是換成中性的範例路徑，並考慮從 `characters/` 產生禁用名單 |
| E18 | 掃描的自我測試用完全相等比對，id 之間有包含關係時會誤判 | low | reject | 測試資料由本測試控制，目前沒有包含關係 |

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。
