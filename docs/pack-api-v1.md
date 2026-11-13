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

- 路徑含 `..`、是絕對路徑，或是捷徑檔。
- 超過解壓總大小、檔案數、圖片寬高或總像素的上限（數值由舞台決定）。
- manifest 不符 schema，或入口無法解析。
- `apiVersion` 與舞台不相容（見第 9 節）。

出處：根目錄只放一個 `<packId>/`、匯入的拒絕條件見 `_bmad-output/implementation-artifacts/epic-3-context.md`「Technical Decisions」的 `.awpet` 與 manifest、「Requirements & Constraints」的匯入。

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
- `spritesheet`：PixiJS 格式的 spritesheet JSON。它的 `meta.image` 是相對於這個 JSON 的路徑，圖檔本身不用列進 `assets`。

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

包 id、角色 id、參數 key、素材 key、飛行物件 id（`projectiles` 的 key）、`choice` 選項值、粒子 preset 都用同一種格式：`^[a-z0-9][a-z0-9-]{1,63}$`。

- 只有小寫字母、數字與 `-`，2～64 字元，不能以 `-` 開頭。
- 因此不會以 `_` 開頭（`pack://_stage/` 是舞台保留的主機名）。

包 id 另有三條限制，因為它會成為 `pack://<packId>/` 的主機名，也會成為資料夾名稱：

- 不能全是數字（例如 `2048`）。
- 不能以 `0x` 開頭。
- 不能是 Windows 的裝置名稱：`con`、`prn`、`aux`、`nul`、`com1`～`com9`、`lpt1`～`lpt9`。

角色 id 是跨版本的穩定身分。改了角色 id，舞台會當作舊角色消失、多了一個新角色。

### 2.3 路徑的寫法

`entry` 與 `assets` 的 `path` 都是相對於包資料夾的路徑，而且只有一種寫法，這樣才會和 `pack://` URL 一致：

- 用 `/` 分隔，不能以 `/` 開頭，不能有連續的 `//`。
- 每一段只能用 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，不能是空的，也不能以 `.` 結尾（所以沒有 `.`、`..`）。
- 因此不能有 `\`、磁碟代號、`%`、`#`、`?`、空白或控制字元。

| 可以 | 不行 |
|---|---|
| `entry.js`、`img/probe-one-plain.png`、`dist/v2/main.js` | `/entry.js`、`./entry.js`、`img//a.png`、`img\a.png`、`../a.png`、`a.`、`my file.png` |

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
- `bounds`：繪圖範圍，超出的內容會被裁掉。
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
        // （座標與 scaleX／scaleY 是暫定值，見下方說明）
        draw[actorId] = drawActor(actorId, actor, message.t);
      }
      return draw;
    },
  };
});
```

最外層的括號讓整支程式成為一個運算式，它的值就是工廠函式。lint 工具若回報這行「沒有用到的運算式」，那是誤報。

範例裡的 `x`、`y` 與 `scaleX`、`scaleY` 是暫定值：範例包用 2×2 像素的圖放大成角色大小，並假設圖的左上角對齊 `x`、`y`。sprite 以圖的哪一點對齊、圖的像素怎麼換算成基準像素都還沒定案（第 11 節），定案後這些數字可能要改。

### actor

畫面上的每一隻是一個 **actor**，代表「一個 session 配上一個角色」：

- `actorId` 是不透明字串（1～64 字元），本次執行期間不重複使用。
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
- `events[]`：本 tick 的事件。v1.0 只有 `{ type: 'enter', actorId }` 與 `{ type: 'leave', actorId }`，代表任何一包的 actor 進場或離場。

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
| `frame` | spritesheet 的格名稱；單張圖不填 | — |
| `x`、`y` | 本地座標 | 必填 |
| `rotation` | 弧度 | 0 |
| `scaleX`、`scaleY` | 縮放，負數代表翻轉 | 1 |
| `alpha` | 0～1 | 1 |
| `z` | 整數，只排同一個 actor 內的前後，越大越上層 | 0 |

**`particles`**：粒子發射器。

| 欄位 | 規則 |
|---|---|
| `emitterId` | 1～64 字元。範圍是單一 actor：同一個 actor 的指令裡不能重複，別的 actor 可以用同一個名字 |
| `preset` | 粒子 preset 名稱，id 格式 |
| `x`、`y` | 本地座標 |
| `params` | 選填，`{ 名稱(1～64 字元): boolean \| number \| string }` |

每一格都寫出同一個 `emitterId`，發射器就持續存在；下一則 `draw` 沒有它，就停止發射。

**`bitmap`**：包自己畫的點陣圖，只限 `advancedBitmap` 的角色。

| 欄位 | 規則 |
|---|---|
| `image` | `ImageBitmap` |
| `x`、`y` | 本地座標 |
| `width`、`height` | 大於 0 |

選填欄位不用時，**整個 key 都不要寫**。值是 `undefined` 或 `null` 時，這則 `draw` 不合法，會整則被拒絕（`undefined` 會跟著訊息送到舞台，不會自動消失）：

```js
// 錯：busy 為 false 時 rotation 是 undefined，整則 draw 被拒絕
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
- 只能畫己方 actor。出現別的 `actorId`，整則 `draw` 會被丟棄。
- 指令或 `draw` 有多出來的欄位，就不合法。
- 每則 `draw` 的指令數、位元組數、發射器數，以及 `bitmap` 的尺寸與每秒張數都有上限（舞台常數）。超過時整則丟棄，並記錄包 id；這也是執行失敗的條件之一（見 8.4）。
- 素材由舞台從 `pack://<packId>/<version>/<path>` 載入並快取。除了 `bitmap`，包不傳任何圖檔資料。

### 8.2 `stage`

`stage` 是包唯一能用的 API：

| 方法 | 說明 |
|---|---|
| `stage.random(actorId)` | 亂數，每個 actor 各自一個種子。回傳值的範圍還沒定案（第 11 節） |
| `stage.log(…)` | 寫入運行紀錄，自動帶上包 id。有限速，超過的會被丟掉 |
| `stage.canvas` | 只限 `advancedBitmap` 的角色：取得 OffscreenCanvas 的 2d context，畫好後用 `bitmap` 指令送出 |
| `stage.fire(fromActorId, { target, object })` | 發射飛行物件；`object` 是 `projectiles` 的 key |
| `stage.hold(actorId, on)` | 讓己方角色停在原地或恢復遊走 |
| `stage.face(actorId, 'left' \| 'right')` | 讓己方角色轉向 |

`fire`、`hold`、`face` 在世界中的行為在 Epic 4 才加入，在那之前不要依賴它們。

### 8.3 節拍

- 節拍由舞台掌管，每個 tick 對有 actor 的包送一則 `frame`。
- 每一包同時最多只有一則 `frame` 在途。上一則還沒回，這一格就跳過這包，不排隊。
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
- 1.1 預計加入：`frame` 裡每個 actor 的 `motion`（是否在移動、面向、是否被捏起來），以及互動事件（靠近、被擊中、被捏起來、別的角色狀態改變）。

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
- **`draw`：**
  - 漏掉某隻己方 actor 時怎麼處理。建議每一格都只回傳、而且完整回傳本格 `frame.actors` 裡的 actor。
  - 各項上限的數值，以及 `drawTimeoutMs`、心跳逾時、`sandboxIdleMs` 等時間數值。
- **繪圖：**
  - sprite 以圖的哪一點對齊 `x`、`y`，以及圖的像素怎麼換算成基準像素。
  - 粒子 preset 的正式清單：目前接受任何 id 格式的名稱，之後只接受清單裡的。
- **素材：**
  - 支援的圖片格式。範例包只用 PNG。
  - spritesheet JSON 支援哪些欄位（範例包只用 `frames[].frame`、`meta.image`、`meta.size`、`meta.scale`），以及 `meta.image` 經 `pack://` 載入時怎麼解析。
