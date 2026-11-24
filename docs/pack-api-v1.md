# 角色包 API v1.0：作者文件

這份文件寫給角色包作者，說明 `.awpet` 怎麼組、`manifest.json` 怎麼寫、包程式怎麼跟舞台溝通，以及包程式裡不能用的東西。

整件事的運作方式：

- 角色包是一個 zip（`.awpet`），裡面有 `manifest.json`、一支入口程式和圖片素材。
- 舞台讀 manifest 決定有哪些角色、各自的參數、碰撞框與名牌位置。
- 入口程式跑在隔離的沙盒裡（iframe → Worker → SES Compartment），能用的只有舞台給的 `stage`。
- 舞台每個 tick（預設每秒 30 次）送一則 `frame` 給包。包回傳這一格每隻角色要畫什麼（繪圖指令），由舞台負責真正畫出來。
- 包看不到檔案、網路、對話內容、別的包，也看不到牆上時間。

契約的權威來源是 `src/shared/pack-api/`（zod schema）。本文件的欄位名、範圍與預設值都照它寫；兩者不一致時以程式為準，並請回報。

範例包：`test/packs/contract-pack/`，是解開的 `.awpet`（裡面是 `contract-pack/` 資料夾），用來驗收 API v1.0。下文的範例都取自它。

## 1. `.awpet` 的結構

`.awpet` 是 zip，根目錄只有一個資料夾，名稱就是包 id（manifest 的 `id`）：

```text
contract-pack.awpet
└── contract-pack/
    ├── manifest.json
    ├── entry.js
    └── img/
        ├── probe-one-plain.png
        ├── probe-one-dots.png
        ├── probe-two-sheet.json
        ├── probe-two-sheet.png
        └── spark.png
```

根目錄除了這個資料夾，不能有別的東西。macOS Finder 的「壓縮」會在 zip 裡多放一個 `__MACOSX/` 資料夾，就違反這條規則。可以改用命令列，在包資料夾的上一層執行：

```sh
zip -r -X contract-pack.awpet contract-pack -x '*.DS_Store'
```

匯入時，以下情況整包會被拒絕，並顯示原因：

- zip 裡任何一個檔案或資料夾的名稱不符合 2.3 的路徑寫法（所以只能用 ASCII 的 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，不能有 `..`、空的段、開頭的 `/`、磁碟代號、`\`、空白、非 ASCII 字元或 Windows 裝置名稱），名稱超過 255 字元，或超過 32 段。說明檔、授權檔這類 manifest 沒用到的檔案也一樣。
- 捷徑檔（symlink、`.lnk`）。
- 兩個路徑只差大小寫（例如 `img/A.png` 與 `img/a.png`），或檔案與資料夾同名。macOS 與 Windows 預設不分大小寫，它們會變成同一個檔。
- 根目錄不只一個資料夾，或資料夾名稱與 manifest 的 `id` 不同。
- 超過上限：
  - zip 裡的項目數 1024（資料夾也算，在讀任何項目之前先判斷）；
  - 解壓總大小 64 MiB（舞台邊解邊算，檔案實際比宣告的大也算超過）；
  - 檔案數 512（資料夾不算）；
  - 每張宣告的圖寬、高各 4096 像素；
  - 所有宣告的圖加起來 6400 萬像素（寬 × 高）。
- 宣告的圖（`image` 素材與 spritesheet 的圖）不是 PNG（以檔頭判斷），或檔名不是以 `.png` 結尾（小寫）。v1.0 只收 PNG。
- 缺 `manifest.json`、它不是 JSON，或不符 schema。
- `entry`、`assets` 的路徑或 spritesheet 的 `meta.image` 在包裡找不到（大小寫也要一致）。
- 入口無法解析（見第 6 節）。
- `apiVersion` 與舞台不相容（見第 9 節）。

出處：根目錄只放一個 `<packId>/`、匯入的拒絕條件見 `_bmad-output/implementation-artifacts/epic-3-context.md`「Technical Decisions」的 `.awpet` 與 manifest、「Requirements & Constraints」的匯入；上限的數值與只收 PNG 是 2026-11-16 定案（`_bmad-output/implementation-artifacts/spec-3-2-pack-import-core.md`）。

## 2. manifest.json

所有物件都不接受多出來的欄位。所有數字都必須是有限值。

選填欄位不用時，**整個 key 都不要寫**。寫成 `null`，整份 manifest 會被拒絕：

```jsonc
// 錯（角色的片段）：fallback 是 null，整份 manifest 被拒絕
{ "id": "probe-one", "states": ["waiting"], "fallback": null }
// 對：不需要 fallback 就不寫這個 key
{ "id": "probe-one", "states": ["waiting"] }
```

### 2.1 頂層欄位

| 欄位 | 型別 | 規則 |
|---|---|---|
| `id` | 字串 | 包 id，見 2.2 |
| `name` | 字串 | 顯示名稱。1～64 字元（UTF-16 單位），不能全是空白 |
| `version` | 字串 | `MAJOR.MINOR.PATCH`，只有數字、沒有前導零，不含 prerelease 或 build 段，最多 32 字元。例如 `1.0.0`。它會成為安裝資料夾的名稱 |
| `apiVersion` | 字串 | 包照哪一版 API 寫的：`<major>.<minor>`，各 1～3 位數字。目前是 `1.0` |
| `entry` | 字串 | 入口程式的路徑，照 2.3 的寫法，結尾是 `.js` |
| `assets` | 物件 | 素材 key → `{ "kind": "image" \| "spritesheet", "path": 路徑 }`。key 是 id 格式（2.2），`path` 照 2.3 的寫法 |
| `characters` | 陣列 | 1～64 個角色，角色 id 不能重複，見第 3 節 |
| `projectiles` | 物件（選填） | 飛行物件 id → `assets` 裡的 key。發射的行為在 Epic 4 才加入 |

`assets` 的兩種素材：

- `image`：單張圖。
- `spritesheet`：PixiJS 格式的 spritesheet JSON。它的 `meta.image` 是相對於這個 JSON 的路徑，圖檔本身不用列進 `assets`。以下任一情況，匯入時拒絕（spritesheet 不合格）：
  - `path` 不是以 `.json` 結尾（小寫）；
  - 內容不是 JSON 物件，或沒有 `frames` 物件；
  - `meta.image` 不是字串，或它本身不符合 2.3 的寫法（不能以 `/` 開頭，不能有空的段、`.`、`..`：舞台不替你化簡路徑）；
  - `meta` 裡有 `related_multi_packs`（PixiJS 會去載入連結的其他 sheet，v1.0 不支援）。

  `meta.image` 相對於 JSON 算出來的檔案必須在包裡，而且是 PNG。

```json
{
  "frames": {
    "eyes-open": { "frame": { "x": 0, "y": 0, "w": 2, "h": 2 } },
    "eyes-shut": { "frame": { "x": 2, "y": 0, "w": 2, "h": 2 } }
  },
  "meta": {
    "image": "probe-two-sheet.png",
    "size": { "w": 4, "h": 2 },
    "scale": 1
  }
}
```

### 2.2 id 格式

包 id、角色 id、參數 key、素材 key、飛行物件 id（`projectiles` 的 key）、`choice` 選項值都用同一種格式：`^[a-z0-9][a-z0-9-]{1,63}$`（粒子 preset 只能用 8.1 的清單）。

- 只有小寫字母、數字與 `-`，2～64 字元，不能以 `-` 開頭。
- 因此不會以 `_` 開頭（`pack://_stage/` 是舞台保留的主機名）。

包 id 另有三條限制，因為它會成為 `pack://<packId>/` 的主機名，也會成為資料夾名稱：

- 不能全是數字（例如 `2048`）。
- 不能以 `0x` 開頭。
- 不能是 Windows 的裝置名稱：`con`、`prn`、`aux`、`nul`、`com0`～`com9`、`lpt0`～`lpt9`。

角色 id 是跨版本的穩定身分。改了角色 id，舞台會當作舊角色消失、多了一個新角色。

### 2.3 路徑的寫法

`entry` 與 `assets` 的 `path` 都是相對於包資料夾的路徑，而且只有一種寫法，這樣才會和 `pack://` URL 一致：

- 用 `/` 分隔，不能以 `/` 開頭，不能有連續的 `//`。
- 每一段只能用 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，不能是空的，也不能以 `.` 結尾（所以沒有 `.`、`..`）。
- 因此不能有 `\`、磁碟代號、`%`、`#`、`?`、空白或控制字元。
- 每一段在第一個 `.` 之前的部分不能是 Windows 的裝置名稱（2.2 的清單，不分大小寫），例如 `con.png`、`img/NUL.js`、`aux/a.png`。
- manifest 裡的路徑（`entry` 與 `assets` 的 `path`）不能只差大小寫，例如同時有 `img/A.png` 與 `img/a.png`。同一個路徑寫兩次（兩個素材 key 用同一張圖）可以。

| 可以 | 不行 |
|---|---|
| `entry.js`、`img/probe-one-plain.png`、`dist/v2/main.js`、`img/com10.png` | `/entry.js`、`./entry.js`、`img//a.png`、`img\a.png`、`../a.png`、`a.`、`my file.png`、`con.png`、`img/Lpt0.json` |

## 3. 角色

| 欄位 | 型別 | 規則 |
|---|---|---|
| `id` | 字串 | id 格式（2.2）。包內不重複，跨版本保持不變 |
| `name` | 字串 | 1～64 字元，不能全是空白 |
| `height` | 數字 | 角色身高，單位是基準像素，1～1000。推薦 110，見 5.2 |
| `params` | 陣列 | 參數宣告，可以是空陣列，見第 4 節 |
| `states` | 陣列 | 包自己會畫的狀態，至少 1 個、不重複 |
| `fallback` | 物件（選填） | 缺少的狀態要改送哪個狀態，見 3.2 |
| `hitbox` | 方框 | 滑鼠命中範圍，見 3.3 |
| `bounds` | 方框 | 繪圖範圍，超出的部分會被裁掉 |
| `anchor` | 點 | 名牌與狀態標記的位置 |
| `defaults` | 物件（選填） | 固定參數的包預設值，只能有 `scale` 與 `wander`，見 5.1 |
| `advancedBitmap` | 布林（選填） | 是否可以用 `bitmap` 指令與 `stage.canvas` |

### 3.1 八種狀態

狀態碼都是英文代碼，中文名稱只在畫面上出現：

| 代碼 | 畫面上的名稱 |
|---|---|
| `waiting` | 等你回覆 |
| `thinking` | 思考中 |
| `working` | 工作中 |
| `approval` | 要你批准 |
| `decision` | 要你決定 |
| `done` | 做完了 |
| `idle` | 休息中 |
| `error` | 出錯了 |

### 3.2 `fallback` 與佔位

不必 8 種狀態都畫。舞台送狀態給包之前，會照 manifest 對應：

1. 角色的 `states` 有這個狀態：照原樣送。
2. 沒有，但 `fallback` 有這個狀態：改送 `fallback` 指定的狀態。
3. 兩者都沒有：舞台畫內建的佔位，並忽略這隻角色的 `draw`，直到狀態改變。

`fallback` 的格式是 `{ "缺的狀態": "已實作的狀態" }`：

- 鍵必須**不在** `states` 裡。
- 值必須**在** `states` 裡。

範例包的 `probe-one`：

```json
"states": ["waiting", "thinking", "working"],
"fallback": { "done": "waiting", "idle": "waiting" }
```

- `done`、`idle` 時，包收到的是 `waiting`。
- `approval`、`decision`、`error` 時，舞台畫佔位。

### 3.3 座標、`hitbox`、`bounds`、`anchor`

所有座標都是角色的**本地座標**：

- 原點在角色腳底的中心。
- 單位是基準像素（還沒乘上固定參數「大小」）。
- y 向下，所以腳底以上是負的 y。

舞台在外面依序套上：角色在世界中的位置、「大小」、角色之間的前後（依 y 排序）。

方框是 `{ "x", "y", "width", "height" }`，`width`、`height` 必須大於 0；點是 `{ "x", "y" }`。

- `hitbox`：滑鼠命中與穿透只看它（乘上「大小」），畫了什麼不影響。它必須整個在 `bounds` 裡面，邊可以重疊。
- `bounds`：繪圖範圍，超出的內容會被裁掉。它跟著角色走，是近身的繪圖框，不是活動範圍：不要把身體畫偏來表現移動；衝刺這類位移在 v1.1 用招式交給舞台執行（第 9 節）。
- `anchor`：舞台在這裡畫名牌與狀態標記。包不畫名牌。

範例：

```json
"hitbox": { "x": -30, "y": -110, "width": 60, "height": 110 },
"bounds": { "x": -40, "y": -130, "width": 80, "height": 130 },
"anchor": { "x": 0, "y": -124 }
```

## 4. 參數宣告

參數是使用者可以調整的值。每個宣告都有：

- `key`：id 格式，同一角色內不重複。
- `label`：顯示名稱，1～64 字元，不能全是空白。
- `type`：下表五種之一。
- `default`：預設值，必須是這個宣告的合法值。

| `type` | 其他欄位 | 合法值 |
|---|---|---|
| `bool` | — | `true` 或 `false` |
| `int` | `min`、`max`（整數）；`step`（選填，正整數，預設 1） | `min`～`max` 之間、落在 `min + n × step` 上的整數。`min ≤ max`，而且 `max` 本身也要落在格點上 |
| `number` | `min`、`max`；`step`（選填，大於 0） | `min`～`max` 之間的數；有 `step` 時要落在 `min + n × step` 上。`min ≤ max`，但 `max` 不必落在格點上。比較時容許依數值大小縮放的 `1e-9` 誤差 |
| `choice` | `options`：至少 2 個 `{ "value": id 格式, "label": 名稱 }`，`value` 不重複 | 其中一個 `value` |
| `asset` | `options`：至少 1 個素材 key，不重複，每個都要在 `assets` 裡 | 其中一個 key |

```json
{ "key": "bob", "label": "上下擺動", "type": "number",
  "min": 0, "max": 8, "step": 0.5, "default": 2 }
```

包收到的參數值：

- 是**完整**的值：`{ [key]: boolean | number | string }`，每個宣告的參數都有。
- 使用者的調整值，只有在符合目前宣告時才採用，否則用 manifest 的 `default`。所以包更新後改了範圍，舊的調整值不會害包收到不合法的值。

## 5. 固定參數與推薦身高

### 5.1 固定參數

每個角色都有以下固定參數。它們由舞台套用，**不會**傳給包：

| 參數 | 意思 | 範圍與預設 |
|---|---|---|
| `scale`（大小） | 整隻角色的縮放，`hitbox` 跟著縮放 | 0.5～2.0，每格 0.1，預設 1.0 |
| `inPool`（加入池子） | 是否參加 session 分配 | 預設開 |
| `badges`（名牌與標記顯示） | 是否畫名牌與狀態標記 | 預設開 |
| `wander.enabled` | 是否遊走 | 預設開 |
| `wander.areas` | 偏好的區域：畫面切成 3 × 3，從左上角逐列編號 0～8 | 1～9 個不重複的整數，預設 `[6, 7, 8]`（最下面一列） |
| `wander.activity` | 停留多久才換地方 | `low`、`medium`、`high`，預設 `medium` |
| `wander.speed` | 移動速度 | `slow`、`medium`、`fast`，預設 `medium` |

取值順序：使用者的調整值 → manifest 角色的 `defaults` → 上表的舞台預設。

`defaults` 只能給 `scale` 與 `wander`，`wander` 可以只給部分欄位：

```json
"defaults": { "scale": 0.9, "wander": { "speed": "slow" } }
```

遊走本身在 Epic 4 才加入。

### 5.2 推薦身高

角色的推薦身高是 **110 基準像素**。宣告的 `height` 在 82.5～137.5 之間（含兩端，即 110 ± 25%）時不提示；超出時，角色包頁面只會提示，不會擋匯入，也不會自動換算。

## 6. 入口程式

`entry` 指向一支**已自行打包好的 classic script**：

- 不能有 `import` 或 `require`。需要第三方程式時，請先用打包工具合成單一檔案。
- 匯入時舞台只編譯、不執行入口（以 strict mode 編譯成 classic script）。以下寫法整包會被拒絕，連出現在註解與字串裡的也算（SES 對整份程式文字做同樣的比對，求值時一樣會拒絕）：
  - 語法錯誤，包括 ESM 的 `import`／`export`。
  - HTML 註解記號 `<!--` 或 `-->`，例如 `a-->b` 也算。
  - import 運算式：`import(…)`、`import /* … */ (…)`。`obj.import(…)` 不算。
  - 直接 `eval(…)`。`obj.eval(…)` 不算。
  - `require(…)`、`require /* … */ (…)`，前面有 `.` 也算。
- 程式在 strict mode 下求值。
- SES 的 `lockdown()` 已凍結所有內建物件，不能修改 `Array.prototype` 這類物件。會改內建物件的 polyfill 不能用。
- 整支程式**求值的結果**（最後一個運算式的值）必須是工廠函式 `(stage) => handlers`。

舞台求值後呼叫工廠一次，傳入 `stage`（第 8 節）。工廠回傳的 `handlers` 是一個物件：

- 鍵是訊息名稱（第 7 節），值是處理函式，參數是那則訊息。
- `frame` 的回傳值就是這一格的繪圖：`{ [actorId]: 指令[] }`（第 8 節的指令）。
- `type: 'draw'` 與 `seq` 由舞台包上，包不用回填。
- 其他處理函式的回傳值不會被使用。

範例包的骨架：

```js
(function createContractPack(stage) {
  'use strict';
  const actors = new Map(); // actorId → 角色、參數、狀態

  return {
    init(message) { /* 重建 actors：只留 own 為 true 的 */ },
    spawn(message) { /* actors.set(message.actorId, …) */ },
    despawn(message) { /* actors.delete(message.actorId) */ },
    params(message) { /* 更新這個 characterId 的所有 actor */ },
    meta(message) { /* 更新顯示名稱 */ },
    frame(message) {
      const draw = {};
      for (const { actorId, state } of message.actors) {
        const actor = actors.get(actorId);
        if (actor === undefined) continue;
        actor.state = state;
        // 依 actor.characterId 挑畫法，回傳這隻的指令陣列，例如
        // [{ type: 'sprite', asset: actor.params.skin, x: -30, y: -110,
        //    scaleX: 30, scaleY: 55 }]
        // （x、y 是圖的左上角；2×2 的圖放大 30×55 倍成 60×110 基準像素，見 8.1）
        draw[actorId] = drawActor(actorId, actor, message.t);
      }
      return draw;
    },
  };
});
```

最外層的括號讓整支程式成為一個運算式，它的值就是工廠函式。lint 工具若回報這行「沒有用到的運算式」，那是誤報。

範例包用 2×2 像素的圖放大成角色大小：圖的左上角放在 `x`、`y`，`scaleX`、`scaleY` 把 1 個圖像素放大成 30×55 個基準像素。sprite 的座標與像素換算見 8.1。

### actor

畫面上的每一隻是一個 **actor**，代表「一個 session 配上一個角色」：

- `actorId` 是不透明字串（1～64 字元），本次執行期間不重複使用，也一定不是 `__proto__`。舞台重新啟動後，同一個 session 可能沿用原本的 `actorId`，這時 `stage.random(actorId)` 也可能沿用同一個種子。
- 同一個角色可以同時有好幾個 actor，所以包的內部狀態要以 `actorId` 為 key；`characterId` 只用來挑外觀與參數。
- 換角色時，舊 actor 結束、新 actor 產生。

## 7. 舞台送給包的訊息

每則訊息都有 `type`。共同的欄位：

- `state`：3.1 的狀態碼，已依 3.2 對應過。
- `params`：角色的完整參數值。
- `displayName`：session 的顯示名稱，字串或 `null`。

| `type` | 內容 | 時機 |
|---|---|---|
| `init` | `actors[]`：現場所有 actor，每個只出現一次。己方的是 `{ own: true, actorId, characterId, params, state, displayName }`；別包的是 `{ own: false, actorId, state }` | 沙盒建立或重啟後的第一則，不補發歷史 |
| `spawn` | `actorId`、`characterId`、`params`、`state`、`displayName` | 己方 actor 加入 |
| `despawn` | `actorId` | 己方 actor 移出 |
| `params` | `characterId`、`params` | 某個角色的參數變了；同一角色每 tick 最多一則 |
| `meta` | `actorId`、`displayName` | 己方 actor 的顯示名稱變了 |
| `frame` | `seq`、`t`、`dt`、`actors[]`、`events[]`，見下 | 每個 tick |

`frame` 的欄位：

- `seq`：≥ 0 的整數。
- `t`：舞台時間，毫秒，≥ 0。這是包**唯一**的時鐘。
- `dt`：與上一個 `frame` 相隔的毫秒數，≥ 0。
- `actors[]`：己方每個 actor 一筆 `{ actorId, state }`。
- `events[]`：上一則 `frame` 之後的所有事件，包括這包被跳過的 tick 裡發生的（見 8.3）。v1.0 只有 `{ type: 'enter', actorId }` 與 `{ type: 'leave', actorId }`，代表任何一包的 actor 進場或離場。

注意：

- `init` 裡別包 actor 的狀態只在 `init` 當下有效，v1.0 之後不會再更新它。
- 包看不到 session 的識別、來源、判斷的可信度，也看不到別包的包 id 與角色 id。
- 沙盒重建或重啟後，包之前記住的東西都沒了，一切以新的 `init` 為準（見 8.4）。

## 8. 繪圖指令與 `stage`

### 8.1 繪圖指令

`frame` 回傳 `{ [actorId]: 指令[] }`，指令有三種：

**`sprite`**：畫一張圖，或 spritesheet 的一格。

| 欄位 | 規則 | 省略時 |
|---|---|---|
| `asset` | `assets` 裡的 key | 必填 |
| `frame` | spritesheet 的格名稱：spritesheet 一定要填，而且是它有的格；單張圖不填 | — |
| `x`、`y` | 圖的左上角，本地座標 | 必填 |
| `rotation` | 弧度 | 0 |
| `scaleX`、`scaleY` | 縮放，負數代表翻轉 | 1 |
| `alpha` | 0～1 | 1 |
| `z` | 整數，只排同一個 actor 內的前後，越大越上層；一樣大時照陣列順序 | 0 |

**座標與像素（定案）：**

- `x`、`y` 是圖的左上角（第 0 列第 0 行像素的外角）在 actor 本地座標的位置，單位是基準像素。
- 1 個圖像素 ＝ 1 基準像素 × `scaleX`（橫）、× `scaleY`（直）。舞台再乘上固定參數「大小」。
- `scaleX`、`scaleY`、`rotation` 都以 (`x`, `y`) 這一點為原點：負的 `scaleX` 讓圖以這一點為軸左右翻轉，圖會往左延伸；`rotation` 繞這一點轉。
- spritesheet 的格：裁切過的格（`trimmed`、`spriteSourceSize`、`sourceSize`）以未裁切的大小對齊 (`x`, `y`)；旋轉存放的格（`rotated`）照 PixiJS 轉回來。
- 圖放大縮小時以線性內插取樣（不是最近點），所以邊緣會稍微柔化。spritesheet 的相鄰格之間至少要留 1 像素的透明間隔，否則會滲到隔壁格的顏色。

**`particles`**：粒子發射器。

| 欄位 | 規則 |
|---|---|
| `emitterId` | 1～64 字元。範圍是單一 actor：同一個 actor 的指令裡不能重複，別的 actor 可以用同一個名字 |
| `preset` | 下表四個名稱之一 |
| `x`、`y` | 發射點，本地座標 |
| `params` | 選填，`{ 名稱(1～64 字元): boolean \| number \| string }`；舞台只讀 `rate` 與 `tint`（見下） |

**preset（定案）：** 只有下面四個。名稱不在清單裡，整則 `draw` 不合法、整則被丟棄（記錄包 id）。之後新增 preset 會升 minor 版本。

| `preset` | 外觀 | 基準速率（每秒顆數） | 壽命 | 大致的用途 |
|---|---|---|---|---|
| `sparkle` | 淡黃、白色的小亮點，在發射點周圍約 15 基準像素內散開、閃爍淡出，不會飄遠 | 14 | 0.5～0.9 秒 | 思考中 |
| `smoke` | 灰色柔和的圓點，往上飄、慢慢變大變淡 | 6 | 1.4～2.2 秒 | 出錯 |
| `confetti` | 多色的小方片往上往外噴，受重力落下並旋轉 | 16 | 1.1～1.7 秒 | 完成 |
| `bubbles` | 淡藍色的小泡泡，慢慢往上飄、左右輕擺 | 4 | 1.8～2.6 秒 | 休息 |

「大致的用途」只是建議，包可以在任何狀態用任何一個。每顆粒子的壽命在範圍內隨機。

**`params`：**

- `rate`：數字，乘在 preset 的基準速率上。超出 0～2 時夾到範圍內（例如 9 當成 2），0 就是不發射。省略時是 1。
- `tint`：`#rrggbb`（六位十六進位，大小寫都可以），這個發射器之後發出的粒子都是這個顏色（`confetti` 也變成單色）。省略時用 preset 自己的顏色。
- 其他名稱，或型別、格式不對的值（例如 `rate: 'x'`、`tint: 'red'`），舞台都忽略並用預設值；這則 `draw` 照樣有效。
- 粒子的顏色與出生位置在發出時就固定。同一個發射器中途改了 `tint`、`rate`、`x`、`y`，只影響之後發出的粒子；已經發出的照原本的樣子跑完壽命。

**發射器的生命週期：**

- 每一格都寫出同一個 `emitterId`，發射器就持續存在，依速率發射；新的粒子從最新的 `x`、`y` 發出。
- 下一則 `draw` 沒有它（例如狀態改變了），就停止發射；已經發出的粒子跑完壽命才消失，之後發射器也移除。
- 同一個 `emitterId` 換了 `preset`，視同舊的停止、新的開始。停止後又出現同一個 `emitterId`，也是新的發射器。
- 停止中、還在淡出的發射器也算數：一個 actor 同時最多 16 個發射器，超過時最舊的停止中發射器連同它的粒子立刻移除（每格換新 `emitterId` 的包，舊粒子會提早消失）。
- actor 離場、這一則沒畫它（漏回、狀態對應不到），或包的沙盒被銷毀、失敗時，它的發射器與粒子立刻移除。
- 粒子畫在 actor 的所有 `sprite` 之上，跟著 actor 的位置與固定參數「大小」縮放，超出 `bounds` 的部分一樣被裁掉。粒子不影響滑鼠命中範圍（只看有沒有畫出 `sprite` 或 `bitmap`，範圍是 manifest `hitbox`）。
- 粒子的時間跟著舞台的畫面更新走：系統睡眠或鎖定、畫面暫停時，粒子停在原地，恢復後接著跑，不會一次噴出一大把。

**上限（定案）：** 一則 `draw` 最多 16 個 `particles` 指令（所有 actor 合計），超過時整則丟棄並記錄包 id。每個發射器同時最多 64 顆粒子，滿了就暫停發射，等有粒子消失再繼續；這種情況 `draw` 不會被丟棄。

**`bitmap`**：包自己畫的點陣圖，只限 manifest 宣告 `advancedBitmap: true` 的角色。圖用 `stage.canvas` 畫、用 `stage.snapshot` 取得（見 8.2）。

| 欄位 | 規則 |
|---|---|
| `image` | `stage.snapshot(actorId)` 回傳的 `ImageBitmap` |
| `x`、`y` | 圖的左上角，本地座標 |
| `width`、`height` | 畫出來的寬高，單位是基準像素，大於 0。跟圖本身的像素數無關，舞台會縮放 |

**bitmap 的規則（定案）：**

- **上限：** 圖的寬、高最多 512 像素。一則 `draw` 裡每個 actor 最多 1 張，同一張 `ImageBitmap` 也只能出現在一條指令。每個 actor 每秒最多 36 張（1 秒的滑動視窗，以舞台收到 `draw` 的時間計）。節拍是每秒 30 格，多出的 6 張留給時間抖動：舞台卡頓時回覆會擠在一起，所以每格送一張碰不到這個上限。任一條不符合，或角色沒有 `advancedBitmap`、`image` 不是 `ImageBitmap`，整則 `draw` 丟棄並記錄包 id，這則裡的圖全部作廢。另外，一則 `draw` 裡不重複的圖比這包的 actor 多時，那一格根本不會送出（見 8.2）。
- **每格都要整張重畫：** `stage.snapshot` 取走畫布的內容後，畫布就清空了。下一格要從頭畫完整張，再 snapshot 一次。
- **一張圖只能送一次：** 送出後圖就交給舞台，包手上的那個 `ImageBitmap` 變成 0×0。把同一張再放進之後的 `draw`，那則 `draw` 送不出去，視為這格沒有 `draw`（記錄包 id 與 `draw-not-cloneable`），下一格照常。
- **圖也照抄本的規則：** 圖要放在抄得了的地方才會送出（見下面的「送出的是抄本」）。圖藏在 `Map`、`Set` 等抄不了的地方，整則 `draw` 不送出（`draw-not-cloneable`）。Worker 不送的那則 `draw`（抄不了、超過上限、圖比 actor 多等），裡面的圖沒有被送走，仍在包手上：下一格可以再放進 `draw` 送出，不用的話自己呼叫它的 `close()`。
- **顯示多久：** 舞台一直顯示最後一則有效 `draw` 裡的那張圖，直到下一則有效的 `draw` 換上新圖。下一則 `draw` 裡這個 actor 沒有 `bitmap`、actor 離場、這一則沒畫它（漏回、狀態對應不到），或包的沙盒被銷毀、失敗時，圖就不再顯示。要持續顯示，每一則 `draw` 都要帶一張新的。
- **層次與縮放：** 畫在這個 actor 的所有 `sprite` 之上、粒子之下，跟著 actor 的位置與固定參數「大小」縮放，超出 `bounds` 的部分裁掉。放大縮小時以線性內插取樣。
- **解析度：** `width`、`height` 是基準像素，舞台還會再乘上「大小」與螢幕的縮放比例，以線性內插放大，所以圖的像素比最後畫出來的少時會模糊。包拿不到「大小」與螢幕的縮放比例，沒辦法照實際倍率決定畫布大小。想在高解析度螢幕上也清楚，就把畫布開成 `width`、`height` 的 2 倍：例如 `width` 100、`height` 60 的圖，用 200×120 像素的畫布畫。畫布每邊最多 512 像素，所以兩邊用同一個倍率 `min(2, 512 / width, 512 / height)`，乘出來的邊長取整數、至少 1（例如 `Math.max(1, Math.round(width * 倍率))`），圖才不會變形：`width` 300、`height` 100 的圖，倍率是 512 / 300，畫布開 512×171。`stage.canvas` 只收整數。
- **滑鼠：** 圖顯示出來之後，這個 actor 跟畫了 `sprite` 時一樣接住滑鼠，範圍仍是 manifest `hitbox` 乘上「大小」。剛送出、還沒顯示的那一格還不算。

**送出的是抄本（定案）：** `frame` 回傳之後，Worker 把回傳值從頭讀一次（每個位置只讀一次，送出的就是抄到的內容；同一個物件被引用兩次會各讀一次），抄成一份新的純資料，檢查與送給舞台的都是這份抄本。抄得了的只有以下幾種：

- `null`、布林、有限的數字、字串。
- 陣列：抄索引 0 到 `length - 1` 的元素。陣列有索引以外的自有屬性（含不可列舉的、symbol key 的）或有空位時，不是忽略那些屬性，而是整則不送。
- 原型是 `Object.prototype` 或 `null` 的物件：只抄它自己的、可列舉的字串 key（symbol key 不抄）。
- `stage.snapshot` 回傳的 `ImageBitmap`：圖本身放進抄本，以 transfer 送出。Worker 認的是圖本身，改掉它的原型也一樣認得。

其他的值都抄不了，例如 `undefined`、`NaN`、`Infinity`、函式、`Map`、`Set`、typed array、`Date`、`Promise` 等其他物件，以及有索引以外屬性（或有空位）的陣列；讀取時丟例外的 getter 也算；陣列、物件一層包一層超過 64 層（回傳值本身算第 1 層）也算抄不了。`draw` 裡只要有一個抄不了的值，或 `frame` 沒有回傳值，Worker 就不送這則 `draw`，記錄包 id 與 `draw-not-cloneable`，這格視為沒有 `draw`，下一格照常。抄的途中超過位元組上限（64 KiB）就停下，不送出，記錄 `draw-too-large`，就算也超過深度上限也是記這個；有循環參照的回傳值會一直抄到超過位元組上限，也是這樣。

選填欄位不用時，**整個 key 都不要寫**。值是 `null` 時，這則 `draw` 不合法，舞台會整則丟棄；值是 `undefined` 時，抄不了，Worker 根本不送這則 `draw`（`draw-not-cloneable`）。兩種都視為這格沒有 `draw`：

```js
// 錯：busy 為 false 時 rotation 是 undefined，這則 draw 不會送出（draw-not-cloneable）
const bad = {
  type: 'sprite', asset: 'probe-two-sheet', frame: 'eyes-open', x: -25, y: -96,
  rotation: busy ? 0.08 : undefined,
};
// 對：需要時才加上這個 key
const sprite = { type: 'sprite', asset: 'probe-two-sheet', frame: 'eyes-open', x: -25, y: -96 };
if (busy) {
  sprite.rotation = 0.08;
}
```

其他規則：

- 一個 actor 給空陣列，代表這格什麼都不畫，**不會**觸發佔位。
- **漏回（定案）：** `draw` 裡沒有某個己方 actor，那個 actor 這一則什麼都不畫（不觸發佔位），直到下一則有它的 `draw`。建議每一格都完整回傳本格 `frame.actors` 裡的 actor。
- 只能畫這則 `frame` 的己方 actor。出現別的 `actorId`，整則 `draw` 會被丟棄。
- `sprite` 的 `asset` 不在 `assets`、spritesheet 沒給 `frame` 或格名稱不存在、單張圖給了 `frame`，整則 `draw` 會被丟棄。
- 指令或 `draw` 有多出來的欄位，就不合法。
- 每則 `draw` 的指令數、位元組數、發射器數，以及 `bitmap` 的尺寸與每秒張數都有上限（舞台常數）。目前一則 `draw` 最多 256 個指令（所有 actor 合計）、64 KiB（JSON 大小；`bitmap` 的 `image` 算成 `{}`，也就是 2 bytes）、16 個發射器（`particles` 指令，所有 actor 合計）；`bitmap` 的上限見上面的「bitmap 的規則」。超過時整則丟棄，並記錄包 id；這也是執行失敗的條件之一（見 8.4）。
- 素材由舞台從 `pack://<packId>/<version>/<path>` 載入並快取（每個版本各自快取，換版本就重新載入）。除了 `bitmap`，包不傳任何圖檔資料。

**spritesheet 的 JSON（定案）：** PixiJS／TexturePacker 的「JSON Hash」格式，舞台載入時檢查，只讀以下欄位，其他的都忽略：

- `frames`：格名稱 → `{ frame: { x, y, w, h } }`，可選 `rotated`、`trimmed`、`spriteSourceSize`、`sourceSize`（照 PixiJS 的處理）。這些矩形與大小都必須是整數像素。格的 `pivot`、`anchor` 等欄位忽略：sprite 只依自己的 `x`、`y` 擺放。
- `meta.image`：圖檔，相對於 JSON 檔所在的資料夾；`meta.size`：圖的大小；`meta.scale`：只接受 `1`（或字串 `"1"`），也可以省略。
- `animations` 忽略：包自己用 `sprite` 的 `frame` 選每一格要畫哪張。
- 有一格超出圖的範圍，或 JSON 不合上面的規則，這個 spritesheet 就不能用，用到它的 sprite 不畫（記錄包 id）。
- `pack://` 只提供入口、`assets` 的路徑，以及已宣告 spritesheet 的 `meta.image`。包裡的其他檔案（包括 `manifest.json`、說明檔）會照樣安裝，但從 `pack://` 讀不到。

### 8.2 `stage`

`stage` 是包唯一能用的 API：

| 方法 | 說明 |
|---|---|
| `stage.random(actorId)` | 亂數，每個 actor 各自一個種子。回傳值的範圍還沒定案（第 11 節） |
| `stage.log(…)` | 寫入運行紀錄，自動帶上包 id。有限速，超過的會被丟掉 |
| `stage.canvas(actorId, width, height)` | 只限 `advancedBitmap` 的角色：取得這個 actor 的畫布的 2d context（見下） |
| `stage.snapshot(actorId)` | 把這個 actor 的畫布內容變成 `ImageBitmap`，放進 `bitmap` 指令送出（見下） |
| `stage.fire(fromActorId, { target, object })` | 發射飛行物件；`object` 是 `projectiles` 的 key。v1.1 起必須帶出發點 `from`（本地座標，例如槍口），沒帶就不發射（第 9 節） |
| `stage.hold(actorId, on)` | 讓己方角色停在原地或恢復遊走 |
| `stage.face(actorId, 'left' \| 'right')` | 讓己方角色轉向 |

`fire`、`hold`、`face` 在世界中的行為在 Epic 4 才加入，在那之前不要依賴它們。

**`stage.fire`、`stage.hold`、`stage.face` 的參數（定案）：** 參數也照 8.1「送出的是抄本」的規則，在呼叫的當下抄成純資料再送出（`stage.fire` 只取第二個參數的 `target` 與 `object`）。以下情況當場丟 `TypeError`，什麼都不送出：

- 參數含 `ImageBitmap`。圖只能放在 `bitmap` 指令裡送。
- 參數含抄不了的值，例如 `undefined`（包括沒給的參數）、函式、`Map`，或巢狀超過 8.1 的深度上限（送出的訊息本身算第 1 層，參數從第 2 層算起）。
- 參數有循環參照。
- 抄出來超過一則訊息的大小上限（64 KiB，以 JSON 的 UTF-8 位元組計，非 ASCII 字元一個算 2～4 bytes）。

`stage.log` 的參數會先轉成文字，不受這條影響。

**`stage.canvas` 與 `stage.snapshot`（定案）：**

- `stage.canvas(actorId, width, height)` 回傳這個 actor 專用畫布的 2d context。第一次呼叫時建立畫布；之後尺寸一樣就回傳同一個 context，尺寸不同就改成新尺寸。改尺寸會清空畫布，也會把 2d 的狀態（transform、`fillStyle`、`font` 等）重設成預設值，改完要重新設定。`width`、`height` 是 1～512 的整數，單位是像素。
- `stage.snapshot(actorId)` 把畫布目前的內容變成 `ImageBitmap` 回傳，畫布隨即清空。每一格的用法是：`stage.canvas` → 整張畫完 → `stage.snapshot` → 放進這格的 `bitmap` 指令（規則見 8.1）。
- **每格每個 actor 一次：** 同一個 actor 在收到下一則 `frame` 之前只能呼叫一次 `stage.snapshot`，第二次丟 `TypeError`；收到下一則 `frame` 後可以再呼叫。
- **一則最多幾張：** 送出前，Worker 會數抄本（8.1「送出的是抄本」）裡不重複的 `ImageBitmap`，連藏在指令以外其他欄位的也算；藏在 `Map` 等抄不了的地方時，整則根本不送（`draw-not-cloneable`）。比這包目前的 actor 多時，這則 `draw` 不送出，跟指令數超過上限一樣整則丟棄並記錄包 id；下一格照常收到 `frame`。
- **只有 2d：** 拿到的 context 的 `canvas` 屬性是 `undefined`，從 context 拿不到畫布本身，也拿不到 `OffscreenCanvas`，所以開不了 webgl、webgl2。Compartment 裡也沒有 `OffscreenCanvas`（第 10 節的原則）。
- **context 是宿主物件：** `stage.canvas` 回傳的 context，以及它的方法回傳的物件（`getTransform()` 的 `DOMMatrix`、`getImageData()` 的 `ImageData`、漸層、圖樣等），都是瀏覽器提供的宿主物件，是第 10 節原則的例外。它們可能帶出 Compartment 裡沒有的東西（例如 `DOMMatrix` 的 `toFloat32Array()` 回傳 `Float32Array`）；只拿它們來畫圖，不要依賴這些額外的東西。
- **丟 `TypeError` 的情況：** `actorId` 不是這包的 actor（別包的、不存在的）；角色沒有 `advancedBitmap`；`width`、`height` 不是 1～512 的整數；還沒呼叫過 `stage.canvas` 就 `stage.snapshot`；同一格對同一個 actor 第二次 `stage.snapshot`；舞台無法建立或讀取畫布。
- **畫布跟著 actor：** actor 離場（`despawn`）時它的畫布一起釋放。收到 `init`（沙盒重建後），或同一個 `actorId` 又收到 `spawn` 時，舊的畫布也會釋放。之後要重新呼叫 `stage.canvas`：用舊的 context 畫的東西不會出現，直接 `stage.snapshot` 會丟 `TypeError`。

### 8.3 節拍

- 節拍由舞台掌管，每個 tick 對有 actor 的包送一則 `frame`。最後一個己方 actor 離場後，還會再收到一則 `actors` 為空的 `frame`，帶著它的 `leave`；之後到下一個己方 actor 出現前不再收到 `frame`。
- 每一包同時最多只有一則 `frame` 在途。上一則還沒回，這一格就跳過這包，不排隊。`frame` 處理函式丟出例外、不存在、或回傳值無法傳送（例如含函式或 Promise）時，這則 `frame` 視為沒有 `draw`（記錄包 id），下一格照常送。
- 舞台每次畫面更新，都用這包最後一則有效的 `draw`，不會等包。
- 所以 `frame` 處理函式太慢，角色就會掉格：畫面停在上一則 `draw`，中間的 tick 包收不到。動畫請依 `frame.t` 計算，不要假設每格相隔固定時間。

出處：`_bmad-output/implementation-artifacts/epic-3-context.md`「Technical Decisions」的節拍與繪圖。

### 8.4 沙盒的生命週期與執行失敗

**生命週期：**

- 一包的第一隻 actor 出現時，舞台建立這包的沙盒，並送出 `init`。
- 最後一隻 actor 離場後，經過一段時間（`sandboxIdleMs`）就銷毀沙盒，包記住的狀態全部消失。之後再有 actor 出現，是新的沙盒、新的 `init`。

**執行失敗：** 以下任一情況，舞台都視同這包執行失敗：

- 心跳逾時（以 tick 計）。
- 連續 `drawTimeoutMs` 沒有有效的 `draw`。
- 超過上限（見 8.1）。
- 未捕捉的例外。

失敗時，舞台會這樣處理：

1. 移除這包的沙盒，它的角色改演佔位，並回報執行失敗。
2. 自動重建沙盒，保留原本的 `actorId`，重新送 `init`。
3. 同一包在本次執行中最多重啟 3 次。第 4 次失敗時，這個版本會被標為失敗（等同停用），角色包頁面會顯示原因。這時它的角色會換成池子裡的其他角色。

一包失敗只影響它自己，其他角色不受影響。

出處：`_bmad-output/implementation-artifacts/epic-3-context.md`「Technical Decisions」的沙盒載入鏈、「Requirements & Constraints」的失敗與換角色。

## 9. 版本規則

- 包的 `apiVersion` 與舞台相容的條件：**主版號相同，而且包的 minor ≤ 舞台的 minor**。安裝與載入時都會檢查。
  - 包的 minor 比較新：拒絕，並顯示「需要舞台 API ≥ x.y」。
  - 主版號不同（不論較新或較舊）：拒絕。
- 舞台檢查 `apiVersion` 時只讀這個欄位。所以較新 minor 的 manifest 就算多了欄位，看到的也是版本訊息，而不是籠統的格式錯誤。
- API 演進的方式：
  - 新增訊息、指令或欄位：升 minor。
  - 移除，或改變原本的意思：升 major。
- 舞台只送包宣告的 minor 以內的訊息與欄位。即使如此，包仍必須**忽略不認得的訊息與欄位**。
- 1.1 預計加入：`frame` 裡每個 actor 的 `motion`（是否在移動、面向、是否被捏起來、招式進度）；互動事件（靠近、被擊中、被捏起來、別的角色狀態改變）；招式（manifest `moves`、`stateMoves` 與 `stage.move`，讓舞台照包宣告的節奏移動角色）；`stage.fire` 必須帶出發點 `from`（沒帶就不發射）、可另帶角度，以及 `projectiles` 的速度與射程。

**更新已安裝的包：**

- 匯入的包 id 已經安裝過時，舞台會顯示新舊名稱與版本，使用者確認後才替換。版本比已安裝的舊（降版）時另外警告。
- 安裝先解到暫存，成功才替換，失敗就回復舊版。
- 角色 id 是跨版本的穩定身分。改了角色 id，等於舊角色消失：畫面上的它會換成池子裡的其他角色，使用者對它的設定也不再套用。
- 使用者的參數調整以參數 key 記錄。參數 key 改名後，舊的調整就不再套用，改用新宣告的 `default`。

出處：`_bmad-output/implementation-artifacts/epic-3-context.md`「Requirements & Constraints」的匯入與失敗與換角色、「Technical Decisions」的 `.awpet` 與 manifest、參數有效值。

## 10. 包程式裡不能用的東西

原則：入口程式在 SES Compartment 裡執行。裡面只有 ECMAScript 的內建物件（其中幾個也被拿掉，見下）、SES 自己放的少數幾個全域（例如 `harden`、`TextEncoder`、`TextDecoder`），以及工廠拿到的 `stage`。瀏覽器或 Worker 提供的宿主 API 一律沒有。

常見的影響：

- `performance.now()`：沒有。時間請用 `frame.t`。
- `crypto.getRandomValues`：沒有。亂數請用 `stage.random(actorId)`。
- `Intl`：沒有，`toLocaleString` 這類依語系的格式化不能依賴。
- `self`、`postMessage`、`navigator`、`location`：都沒有。包只能透過 `frame` 的回傳值與 `stage` 跟舞台溝通。
- ECMAScript 內建物件中，SES 也拿掉了 `SharedArrayBuffer`、`Atomics`、`WeakRef`、`FinalizationRegistry`。

**Compartment 裡沒有：**

- `Date.now()`、`new Date()`（不帶參數）、`Date()`：呼叫會丟錯。時間請用 `frame.t`。
- `Math.random()`：呼叫會丟錯。亂數請用 `stage.random(actorId)`。
- `console`：請用 `stage.log`。
- 計時器：`setTimeout`、`setInterval`、`requestAnimationFrame`、`queueMicrotask` 等。動畫請依 `frame.t` 計算。
- `Float16Array`、`Float32Array`、`Float64Array`。

**沒有 `crypto.subtle`**：包所在的 Worker 不是 secure context。

**已移除：**

- `Iterator.prototype.join`、`Iterator.prototype.includes`：目前的 SES 不認得這兩個方法，所以先移除。
- 網路、儲存與 Worker 相關的 API：`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`WebTransport`、`importScripts`、`Worker`、`SharedWorker`、`indexedDB`、`caches`。

## 11. 尚未定案的部分

以下細節在後續版本實作時確定，屆時會更新本文件。在那之前，請不要依賴這些行為的任何一種結果：

- **`stage`：** 各方法的確切呼叫方式（沙盒實作時確定），以及 `stage.random` 回傳值的範圍。
- **訊息：**
  - 角色處在舞台畫佔位的狀態時（3.2 的第 3 種情況），`frame` 裡這隻 actor 收到的是哪個狀態。
  - 訊息到達的順序，例如同一個 tick 的 `spawn`、`params`、`meta` 與 `frame` 誰先誰後。
- **handlers：** 哪些處理函式必須提供，以及 `handlers` 有不認得的鍵時怎麼處理。範例包六種都有寫，鍵也只用訊息名稱。
- **`draw`：** `drawTimeoutMs`、心跳逾時、`sandboxIdleMs` 等時間數值。

已定案、移到正文的：`draw` 漏掉己方 actor 的處理、sprite 的座標與像素換算、spritesheet JSON 的欄位、粒子 preset 的清單與 `params`、發射器與粒子數的上限、`bitmap` 的上限與規則（都在 8.1）；`stage.canvas` 與 `stage.snapshot` 的呼叫方式（8.2）。圖片格式也已定案：v1.0 只收 PNG（第 1 節）。
