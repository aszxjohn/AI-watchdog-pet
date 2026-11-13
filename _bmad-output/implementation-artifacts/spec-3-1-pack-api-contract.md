---
title: 'Story 3.1（上）：角色包 API v1 契約'
type: 'feature'
created: '2026-11-13'
baseline_commit: 'b298576c2e0393d740a68a56a3fbe5cc60e28749'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 角色包要上台，得先有一份明確、有版本的格式與 API 定義：包作者照著寫，舞台照著驗證。目前 `src/shared` 沒有任何角色包契約。

**Approach:** 在 `src/shared/pack-api/` 用 zod 定義角色包 API v1.0，內容包括：
- manifest
- 舞台送給包的訊息
- 包回傳的 `draw` 與繪圖指令
- API 版本與相容判斷
- 固定參數的格式與預設

**Decisions（2026-11-13，使用者選定）：**
- Story 3.1 拆兩段，本段只做 schema。契約測試包、字面值掃描、作者文件是下半段，已記在 deferred-work。
- `fallback` 採「每個缺的狀態各自指定」：`{ [缺的狀態]: 已實作的狀態 }`。
  - 鍵必須不在 `states` 裡，值必須在 `states` 裡。
  - 沒列到的缺少狀態由舞台畫佔位。

## Boundaries & Constraints

**Always:**
- `src/shared/pack-api/` 只 import `../zod-setup` 與 `../states`（後者只為狀態碼 schema），用 depcruise 規則鎖住。
- 所有物件 schema 都用 `z.strictObject`。數值一律有限（finite）。
- `apiVersion` 有一個只看這個欄位的寬鬆 schema 與相容判斷。3.2 要先檢查版本，這樣較新 minor 的 manifest 多出欄位時，才能顯示「需要舞台 API ≥ x.y」，而不是籠統的 schema 錯誤。
- 每個 schema 都有往返與拒絕測試，沿用 `test/shared/schema-helpers.ts`。

**Never:**
- 不讀 zip、不做路徑安全檢查與匯入上限、不做 `pack://` 處理器（3.2）。
- 不寫沙盒、bootstrap、CSP 或 intrinsics 移除清單（3.5）。
- 不產生 `actorId`（3.4）。
- 不做節拍、renderer、限額的執行、粒子 preset 的正式清單（3.6）。
- 不定義 `stage.fire`、`hold`、`face`、`log` 的訊息 schema（3.5、Epic 4）。
- 不把固定參數接進 settings（3.3、3.6）。
- 不做契約測試包、字面值掃描、作者文件（本 story 下半段）。

## I/O & Edge-Case Matrix

| 情境 | 輸入 | 預期 |
|---|---|---|
| 相容 | 包 `1.0`，舞台 `1.0` | 相容 |
| 包較新 | 包 `1.2`，舞台 `1.0` | 不相容，回報需要的版本 `1.2` |
| 主版不同 | 包 `2.0` 或 `0.9` | 不相容 |
| 版本先檢查 | `apiVersion: '1.3'` 的 manifest 多一個未知欄位 | 寬鬆 schema 取得 `1.3` 並判定不相容；完整 schema 拒絕 |
| id | `ab`、`a-`、`0x` 可以；`a`、`-a`、`A1`、`_x`、65 字元不行 | 依 `^[a-z0-9][a-z0-9-]{1,63}$` |
| 完整 manifest | 含兩個角色、四種參數型別的樣本 | 通過 |
| 參照不存在 | 參數的 asset 選項或預設值、`projectiles` 指到 `assets` 沒有的 key | 拒絕 |
| 參數預設不合法 | `int` 的預設超出 min～max 或不在 step 上；`choice` 的預設不在選項裡 | 拒絕 |
| 重複 | 角色 id、同一角色的參數 key、`states` 重複 | 拒絕 |
| fallback | 鍵在 `states` 裡，或值不在 `states` 裡 | 拒絕 |
| defaults | 角色 `defaults` 有 `scale`、`wander` 以外的欄位 | 拒絕 |
| 固定參數 | 預設值；`scale` 0.45、2.05、1.05 | 預設照驗收條件；這三個值都拒絕 |
| 訊息與 draw | 六種訊息與 `draw` 的合法樣本 | 往返通過；未知 `type`、多出的欄位都拒絕 |

</frozen-after-approval>

## Code Map

- `src/shared/pack-api/`（新）：依主題拆成幾個檔，加一個 `index.ts` 統一匯出。
  - **id 與版本：**
    - `idSchema`：`^[a-z0-9][a-z0-9-]{1,63}$`。
    - `PACK_API_VERSION`：`1.0`，major 與 minor 兩個數字。
    - `apiVersionSchema`：`<major>.<minor>`，各 1～3 位數字。
    - 寬鬆的 `manifestApiVersionSchema`：只取 `apiVersion`。
    - 相容判斷函式：回傳相容與否，不相容時附上需要的版本。顯示文字留給 3.2。
  - **manifest：**
    - 頂層欄位：
      - `id`、`name`（1～64 字）。
      - `version`：`MAJOR.MINOR.PATCH` 純數字，不含 prerelease 與 build，因為會出現在路徑裡。
      - `apiVersion`。
      - `entry`：相對路徑、`.js` 結尾、不含 `..` 與開頭的 `/`。
      - `assets`：key 為 id 格式 → `{ kind: 'image' | 'spritesheet', path }`，`path` 的規則同 `entry`，但不限副檔名。
      - `characters`：1～64 個，id 不重複。
      - 選填 `projectiles`：id → asset key。
    - 角色欄位：
      - `id`、`name`、`height`（1～1000 基準像素）、`params`。
      - `states`：狀態碼，至少 1 個、不重複。
      - 選填 `fallback`：照定案。
      - `hitbox` 與 `bounds`：`{ x, y, width, height }`，寬高大於 0。座標是本地座標：原點在腳底中心、y 向下。
      - `anchor`：`{ x, y }`。
      - 選填 `defaults`、選填 `advancedBitmap`（布林）。
    - 跨欄位檢查（asset 參照、重複、fallback）放在 manifest 層的 `superRefine`。
  - **參數宣告：**
    - 以 `type` 區分，共同欄位是 `key`（id 格式）與 `label`（1～64 字）：
      - `bool`：`default`。
      - `int`：`min`、`max`、選填 `step`（正整數，預設 1）、`default`。
      - `number`：`min`、`max`、選填 `step`（大於 0）、`default`。
      - `choice`：`options`（至少 2 個 `{ value: id, label }`，value 不重複）、`default`。
      - `asset`：`options`（至少 1 個 asset key、不重複，必須在 `assets` 裡）、`default`。
    - 預設值必須合法。
    - 參數值的型別是 `boolean | number | string`。依宣告驗證單一值的函式也放在這裡，供 3.6 計算有效值。
  - **固定參數：**
    - `scale`：0.5～2.0、每格 0.1、預設 1.0；比較時容許 `1e-9` 的浮點誤差。
    - `inPool`、`badges`：預設 true。
    - `wander`：
      - `enabled` 預設 true。
      - `areas`：0～8 的整數，1～9 個、不重複，預設 `[6, 7, 8]`。
      - `activity`：`low`／`medium`／`high`，預設 `medium`。
      - `speed`：`slow`／`medium`／`fast`，預設 `medium`。
    - 匯出 `FIXED_PARAM_DEFAULTS`、`RECOMMENDED_CHARACTER_HEIGHT = 110`，以及身高提示的容許比例 `0.25`。
    - manifest 的 `defaults` 只能有 `scale` 與 `wander`；`wander` 可以只給部分欄位。
  - **訊息（舞台 → 包）：** 以 `type` 區分。`actorId` 是 1～64 字的不透明字串，`displayName` 是字串或 null。
    - `init`：`actors[]`。己方的帶 `own: true`、`characterId`、`params`、`state`、`displayName`；別人的帶 `own: false`、`state`。
    - `spawn`：`actorId`、`characterId`、`params`、`state`、`displayName`。
    - `despawn`：`actorId`。
    - `params`：`characterId`、`params`。
    - `meta`：`actorId`、`displayName`。
    - `frame`：
      - `seq`：整數 ≥ 0。
      - `t`、`dt`：毫秒 ≥ 0。
      - `actors[]`：`actorId`、`state`。
      - `events[]`：v1.0 只有 `enter`、`leave`，都帶 `actorId`。`motion` 與其他事件（靠近、命中、捏起來）由 Epic 4 以 1.1 加入；這點寫在 `PACK_API_VERSION` 的註解。
  - **`draw`（包 → 舞台）：**
    - 形狀：`{ type: 'draw', seq, actors: { [actorId]: 指令[] } }`。
    - 指令以 `type` 區分：
      - `sprite`：`asset`、選填 `frame`、`x`、`y`；選填 `rotation`（弧度，預設 0）、`scaleX` 與 `scaleY`（預設 1）、`alpha`（0～1，預設 1）、`z`（整數，預設 0）。
      - `particles`：`emitterId`、`preset`、`x`、`y`、選填 `params`。`preset` 在 v1.0 先接受 id 格式的任何字串，3.6 定正式清單後再收緊。
      - `bitmap`：`image`（非 null 物件，是否為 ImageBitmap 由 renderer 確認，Node 測試因此可以跑）、`x`、`y`、`width`、`height`。只限 `advancedBitmap` 的角色，這條在執行時檢查（3.6）。
- `.dependency-cruiser.cjs`：新增規則，`src/shared/pack-api` 只能依賴 `src/shared/zod-setup.ts` 與 `src/shared/states.ts`。
- `deferred-work.md`：新增一項延後項目：3.6 定好粒子 preset 正式清單後，收緊 `particles.preset`。
- 測試：`test/shared/pack-api/*.test.ts`，涵蓋 I/O 矩陣每一列。樣本 manifest 放在測試輔助檔裡；檔中的角色與包名不得像真實角色。

**不要改：** `src/main/**`、`src/overlay/**`、`src/panels/**`、`src/preload/**`、`src/shared/settings.ts`、`prototypes/**`。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/pack-api/`：id、版本、manifest、參數、固定參數、訊息、`draw`。
- [x] `.dependency-cruiser.cjs`：pack-api 的依賴規則。
- [x] `test/shared/pack-api/`：往返與拒絕，涵蓋 I/O 矩陣。
- [x] `deferred-work.md`：記 `preset` 收緊。

**Acceptance Criteria:**
- Given 這個 story 完成，when 執行 `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`，then 全部通過，且既有的斷言都沒有改動。

## Implementation Notes

- 2026-11-13：原規格約 4000 tokens（字數粗估），使用者選擇拆兩段；`fallback` 使用者選 A。
- 2026-11-13 實作時規格沒寫明、開發代理自行決定的部分：
  - `version` 不接受前導零（照 semver，避免同一版本兩種資料夾名）；`apiVersion` 照規格允許前導零，`01.03` 視同 1.3，`required` 寫成標準形式。
  - `number` 參數的 step 與範圍也容許 `1e-9` 誤差（否則 0.1 這類步長幾乎都判成不在 step 上）。
  - schema 不自動補預設值（int 的 `step`、sprite 的 `rotation`、`scaleX`、`scaleY`、`alpha`、`z`），預設值以常數匯出由使用端補；往返測試因此成立。
  - choice、asset 選項不重複與預設在選項內放在參數 schema 本身；`characterSchema` 不匯出（單獨使用時沒有跨欄位檢查），只匯出型別。
  - `init` 裡別人的角色也帶 `actorId`；`emitterId` 與 particles `params` 的 key 是任意 1～64 字字串；`displayName` 不限長度。
- 2026-11-13 主 session 核對：我重跑 `npm run typecheck`、`npm run lint`、`npm run depcruise`（205 個模組、0 違規）、`CI=true npm test`（71 檔、3301 個測試）全過；既有測試與 `src/` 既有檔案沒有改動，只新增 `src/shared/pack-api/`、`test/shared/pack-api/` 與 depcruise 規則；I/O 矩陣 13 列都有測試且都有跑。開發代理回報反向驗證：拿掉 manifest 的 `superRefine` 有 11 個測試失敗、拿掉 int／number 預設值檢查有 7 個失敗；depcruise 新規則對違規樣本會報錯。

- 2026-11-13 審查修補後：包 id 拒絕全數字、`0x` 開頭與 Windows 保留名（`packIdSchema`）；路徑改成標準寫法（以 `/` 分隔、每段只含 `[A-Za-z0-9._-]`、不得以 `.` 結尾）；`version` 長度上限 32；不相容時附 `reason`（`pack-newer`／`major-mismatch`）；每個自訂 issue 帶 `params.rule` 代碼（`PACK_API_ISSUE_RULES`）；pack-api 所有 record 拒絕 `__proto__` 鍵（`reserved-key`，主 session 追加：開發代理指出 assets、projectiles、fallback、參數值也有同樣問題）；`actorId`、同一 actor 的 `emitterId` 不重複；`min <= max` 與 int 的 `max` 在格點上；容許誤差依數值大小縮放；`hitbox` 在 `bounds` 內；標籤不得只有空白；depcruise 規則補反向測試。我重跑四項檢查全過（72 檔、3456 個測試；depcruise 207 個模組、0 違規）；既有測試只有 `guard-rules.test.ts` 新增 25 行，沒有刪改任何既有斷言。
- 2026-11-13：sprint 的 `3-1-…` 維持 in-progress，因為下半段（契約測試包、字面值掃描、作者文件）還沒做；下半段完成並經 CI 確認後才改 review／done。

## Spec Change Log

## Review Triage Log

第 1 輪（2026-11-13）：Blind Hunter 16 條（B1–B16）、Edge Case Hunter 15 條（E1–E15）、Verification Gap 1 個缺口（VG1）與 1 條其他發現（VO1）。

| 編號 | 發現 | 判定 | 去向 | 依據 |
|---|---|---|---|---|
| VG1、B1 | 新 depcruise 規則 `pack-api-only-zod-setup-and-states` 沒有加進 `guard-rules.test.ts` 的反向測試 | medium | patch | 驗證缺口已附證據：`RULES` 陣列 17 條不含它；規則 regex 打錯時 CI 不會發現 |
| E1 | 包 id 全是數字或 `0x` 開頭（`2048`、`014`、`0x0c`）時，`pack` 是 standard scheme，Chromium 會把主機名正規化成 IPv4 | medium | patch | GURL 對 standard scheme 的主機名一律做 IPv4 判斷；3.2 的 `pack://<packId>/` 會對不上。只限 manifest 的 `id` |
| B2、E2 | 包 id 是 Windows 保留裝置名（`con`、`nul`、`aux`、`prn`、`com1`～`com9`、`lpt1`～`lpt9`），`userData/packs/<packId>/` 在 Windows 建不出來 | medium | patch | 實測都符合 id 格式；CI 與打包都含 Windows |
| B3、E4、E5 | 路徑接受反斜線、磁碟代號、`./`、`//`、空段、控制字元、`#`、`?`、`%` | medium | patch | `pack://` 的 URL 解析會轉換或截斷這些寫法，宣告的路徑與 URL 對不上；改成標準寫法：只用 `/` 分隔，每段只含 `[A-Za-z0-9._-]` 且不是 `.`、`..` |
| E3 | `version` 的數字位數沒有上限，會變成資料夾名 | low | patch | 直接加長度上限 |
| B4、E10 | 包主版比舞台舊（`0.9`）時只回 `required: '0.9'`，3.2 會顯示「需要舞台 API ≥ 0.9」這種錯誤文字 | medium | patch | 不相容時加上原因（包較新或主版不同），讓顯示層選對文案 |
| B6 | 自訂 issue 只有英文句子，3.2 要顯示中文拒絕原因時只能比對英文字串 | medium | patch | 專案規則「判別值用英文代碼，中文只在顯示層」；每個自訂 issue 帶穩定代碼並匯出代碼清單 |
| B13 | `actors` 與 particles `params` 的鍵是 `__proto__` 時，驗證成功但輸出把它丟掉 | low | patch | 實測 zod record 會丟掉 `__proto__`；直接拒絕這個鍵 |
| E13 | `init.actors`、`frame.actors` 裡同一個 `actorId` 出現兩次照樣通過 | low | patch | 直接加不重複檢查 |
| B10 | `emitterId` 的範圍沒寫，同一個 actor 的指令裡重複也通過 | low | patch | 註解寫明範圍是單一 actor，並加同一 actor 內不重複的檢查 |
| B11、E9 | `int`／`number` 沒有單獨檢查 `min ≤ max`（錯誤指到 `default`）；`int` 的 `max` 不在格點上也照收 | low | patch | 加指到 `max` 的檢查；`int` 的 `max` 必須在格點上 |
| E7 | 絕對容許誤差 `1e-9` 對很大的 `min`（例如 10000000.3、step 0.1）會把格點上的值誤判 | low | patch | 改成依數值大小縮放的相對誤差，是直接修正 |
| E14 | `hitbox` 可以超出 `bounds`，形成看不見卻點得到的區域 | low | patch | `bounds` 是裁切範圍；直接要求 `hitbox` 在 `bounds` 內 |
| E15 | 名稱或標籤只有空白也通過 | low | patch | 直接要求至少一個非空白字元 |
| B5 | `init` 給了別包 actor 的狀態，之後沒有訊息更新它 | low | patch（只改註解） | 依架構，別包狀態的更新是 Epic 4 的 `state-broadcast`（1.1）；註解寫明「只在 init 當下有效」 |
| B9 | 身高提示只有常數，註解寫「約 83～138」，實際是 82.5～137.5 | low | patch（只改註解） | 改成精確範圍；判斷函式留給 3.2、3.3 使用時再加 |
| B7 | `STAGE_MESSAGE_TYPES`、`DRAW_COMMAND_TYPES`、`PARAM_TYPES` 沒有和 schema 綁在一起 | low | patch（測試） | 測試改拿 schema 的選項比對 |
| B15、VO1 | 幾個匯出的子 schema 只被上層間接測到；`idSchema` 的測試放在 version 測試檔；「沒有 assets 時的 asset 參數」那個測試被 `projectiles` 一起拒絕，沒隔離出它名稱說的行為 | low | patch（測試） | 規格要求每個 schema 都有往返與拒絕測試 |
| B12 | `draw` 與 manifest 的集合、字串沒有上限；上限常數依 epic 放在 `constants.ts`，新規則卻禁止 pack-api 引用 | medium | defer | 上限的執行屬 3.6；3.6 要在 parse 前先擋位元組數，並決定上限常數放哪裡 |
| E11 | 包可以在 `draw` 裡用別包的 `actorId` | medium | defer | 契約層無從知道哪些是己方；3.6 的舞台必須過濾 |
| E12 | sprite 的 `asset` 不在 manifest、或 `frame` 與素材種類不符 | low | defer | 執行時才知道對應的角色與 manifest，屬 3.6 |
| B8、E6 | 容許誤差讓略超出範圍的值也算合法，原值照收不吸附 | low | reject | 只差 1e-9 以內，來自浮點運算；3.3、3.6 存檔或送出時再收斂即可 |
| E8 | `int` 的 min、max 接近 ±2^53 時，差值超過安全整數範圍 | low | reject | 情況極端，修正要加額外約束 |
| B14 | `ApiVersion` 是一般字串，`parseApiVersion` 遇到未驗證的值會丟例外 | low | reject | 前置條件已寫在註解，3.2 一律先過 schema；改成 brand 型別會增加使用端負擔 |
| B16 | 「只能從 index 匯入」沒有規則強制 | low | reject | 目前沒有任何使用端；之後有使用端時再加規則 |

## Design Notes

一個合法角色的樣子：

```json
{ "id": "probe-a", "name": "探針甲", "height": 110,
  "params": [{ "key": "glow", "label": "發光", "type": "bool", "default": true }],
  "states": ["thinking", "working", "waiting"],
  "fallback": { "done": "waiting", "idle": "waiting" },
  "hitbox": { "x": -30, "y": -110, "width": 60, "height": 110 },
  "bounds": { "x": -60, "y": -140, "width": 120, "height": 140 },
  "anchor": { "x": 0, "y": -120 } }
```

## Verification

**Commands:**
- `npm run typecheck`、`npm run lint`、`CI=true npm test`、`npm run depcruise`：預期全部通過。
