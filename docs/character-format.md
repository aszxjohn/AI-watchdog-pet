# 角色包格式

> 角色包怎麼寫，以這一份為準。README 和程式註解只放摘要、指到這裡。
> **Created:** 2026-11-02 14:20　**Last Updated:** 2026-11-02 14:29

一個角色就是一個資料夾。系統（舞台）讀這個資料夾來演，不需要任何為這個角色寫的程式。能分享的角色檔 `.gpet` 就是把這個資料夾壓成 zip。

完整範例：`tools/make_fixture.py` 會產生一個極簡的測試角色「測試球 TEST-01」，8 個狀態用了各種寫法，圖是程式畫的，不含遊戲素材。

---

## 1. 資料夾

```
<id>/
├── character.json        名字、大小、拖尾、每個狀態的遊走預設
├── states/
│   ├── <狀態>.json       這個狀態的參數、遊走、腳本
│   └── <名稱>.js         （選用）腳本的 JavaScript 程式
└── assets/
    ├── unit.json         動畫、圖片群組、rig（每個狀態用哪段動畫、怎麼播）
    └── …png              圖
```

- `<id>`：小寫英文、數字、`-`、`_`，最多 40 字。資料夾名、`character.json` 的 `id`、`assets/unit.json` 的 `id` 必須一樣。
- 狀態固定 8 個：`waiting` 等你回覆、`thinking` 思考中、`working` 工作中、`permission` 要你批准、`question` 要你決定、`done` 做完了、`sleeping` 休息中、`error` 出錯了。
- 放的位置：
  - 程式內建的角色：`GundamPet.app/Contents/Resources/characters/<id>/`
  - 使用者裝的角色：`~/Library/Application Support/GundamPet/characters/<id>/`（同一個 id 以使用者裝的為準）
- 使用者在「角色設定」裡的調整存在 `~/Library/Application Support/GundamPet/characters/<id>.json`，不寫進角色包。

## 2. character.json

| 欄位 | 說明 |
|------|------|
| `id`、`name`、`code` | 代號、顯示名、型號（名牌上顯示） |
| `tags` | `{"work", "series", "generation"}`：作品、系列、代數（面板分類用） |
| `height` | 預設大小（點） |
| `trail` | `{"image": "群組/名稱", "color": [r, g, b]}`：進場、離場、移動時的拖尾粒子；不寫就沒有 |
| `states.<狀態>` | 遊走預設：`wander`（要不要逛）、`cells`（九宮格偏好，0–8）、`strength`、`step`（small／medium／large）、`stay`（[最短, 最長] 秒）、`speed`、`room` |

## 3. assets/unit.json

```json
{
  "id": "blob", "name": "測試球", "code": "TEST-01",
  "animations": {
    "stand": {"frames": ["stand/00.png", "…"], "size": [120, 120], "anchor": [60, 104],
              "segments": {"in": [0, 1], "hold": [2, 3], "out": [4, 5]}}
  },
  "fx": {"dot": "fx/dot.png"},
  "rig": {
    "states": {"waiting": {"anim": "stand", "mode": "flourish", "fps": 8}, "…": {}},
    "enter": "dash", "leave": "back",
    "core": [60, 66]
  }
}
```

- `animations`：每段動畫的格（圖檔路徑，相對於 `assets/`）、`size`（原圖尺寸，像素）、`anchor`（站立點，像素，左上為原點）、`segments`（給 hold 模式用：進、停留、出）。
- 圖片群組：其他頂層的 `名稱 → 路徑` 物件（例如 `fx`、`cutin`、`attack`）。腳本用 `"群組/名稱"` 指一張圖。
- `rig.states.<狀態>`：
  - `anim`：用哪段動畫。
  - `mode`：系統怎麼播。
    - `still`：第 0 格。
    - `hold`：播 in、來回播 hold，換狀態時播 out。
    - `flourish`：平常第 0 格，偶爾整段播一次，偶爾擺 `fidget` 裡的姿勢。
    - 狀態有腳本時，以腳本為準。
  - 其他：`fps`、`hud`（`"alert"` 會出現警示角）、`dim`（透明度）、`hit`（進入狀態時系統的受擊反應）。
- `rig.enter`／`rig.leave`：進場、離場用的動畫。
- `rig` 的其他鍵是角色自己量的點或值（例如 `core`、槍口位置），腳本用 `"at": "core"`、`rig.<鍵>`、`pet.point("core")` 取用。

## 4. states/<狀態>.json

```json
{
  "params": [
    {"name": "speed", "type": "number", "default": 8, "min": 2, "max": 20, "step": 1, "user": true, "label": "眨眼速度"}
  ],
  "wander": {"wander": true, "cells": [6, 7, 8]},
  "script": { … }
}
```

- `params`：這個狀態的設定。
  - `type`：`bool`、`int`、`number`、`choice`（加 `choices`）、`asset`（圖片名）。
  - `user: true` 會出現在角色設定面板讓使用者調；`false` 只有作者改檔。
  - 腳本裡用 `"$名稱"` 取值，JS 用全域的 `params.名稱`。
  - 宣告不合法（例如 min 大於 max）的參數不採用，並寫進運行紀錄。
- `wander`：蓋過 character.json 的遊走預設。
- `script`：怎麼演，見第 5 節。沒有 `script` 的狀態就照 unit.json 的 `mode` 由系統播。

## 5. script

### 5.1 頂層欄位

| 欄位 | 說明 |
|------|------|
| `intro` | 開頭只播一次的積木 |
| `timeline` | 之後一直循環的積木（一輪） |
| `loop` | 預設 `true`；`false` 播完停在最後 |
| `moveWhileActing` | `true`：演出中也能遊走；預設 `false`：等一輪結束才走（走的時候停演，到點重新開始） |
| `marker` | `[x, y]`（× 機高）：狀態標記的位置 |
| `vars` | `{名稱: 運算式}`：自訂變數，可以互相引用 |
| `body` | `{"dx", "dy", "lean"}`：機體位移（點）與傾斜（**度**），每格算 |
| `layers` | 圖層（5.4） |
| `emitters` | 粒子（5.5） |
| `particles` | 一個掛在機體後面、由時間軸切換樣子的粒子（5.6） |
| `program` | `"檔名.js"`：JavaScript 程式（第 6 節） |
| `runWhileIdle` | `true`：程式的 update 在沒演出時也每格跑 |

### 5.2 時間軸積木

每個積木在前一個結束時開始。

| 積木 | 說明 |
|------|------|
| `{"do": "play", "anim", "frames": [起, 迄], "fps"}` | 播一段格 |
| `{"do": "frame", "anim", "frame" 或 "frames" + "pick": "alternate", "hold"}` | 停一格 `hold` 秒（alternate：每輪輪流） |
| `{"do": "frames", "anim", "index": 運算式, "for": 秒}` | `for` 秒內，每格的格數由運算式算（`count` 是那段動畫的格數） |
| `{"do": "wait", "seconds"}` | 停在最後一格 |
| `{"do": "repeat", "times", "every", "steps"}` | 重複 `times` 次（每次隔 `every` 秒；沒寫就接著做） |
| `{"do": "if", "param", "then", "else"}` | 依 bool 參數 |
| `{"do": "shoot", "from", "shot", "flash", "kick", "hit"}` | 從 rig 量好的槍口開一槍（`from.points`／`dirs` 是 rig 的鍵，`gun` 可 `alternate`）；`shot` 子彈（`color`、`image`、`length`、`thick`、`speed`、`life`、`fadeFrom`）、`flash` 槍口閃光、`kick` 後座（`distance` 點、`time` 秒）、`hit` 打到別隻（`pets`、`burst`） |
| `{"do": "effect", "at": [x, y], "burst"}` | 一次性特效（`burst`：`images`、`color`、`size`、`grow`、`life`、`spin`） |
| `{"do": "particles", "look"}` | 從這裡起粒子換成這個樣子 |

時間軸裡的數字（`hold`、`fps`、`times`、`every`、`for`、`seconds`、子彈與特效的數值）都可以寫運算式，在載入時算一次，只能用參數、`pi`、`rig.<鍵>`（沒有時間與機高）。

### 5.3 數字與運算式

每格算的欄位，可以用這些變數：

- `t`：演出開始幾秒。
- `st`：進這個狀態幾秒。
- `u`：腳本內的時間。
- `h`：機高（點）。
- `count`：只在 `frames` 積木裡，那段動畫的格數。
- `pi`。
- `rig.<鍵>`：rig 裡的數字。
- `vars` 裡定義的變數。
- `$參數`。

運算子與函式：

- 運算子：`+ - * / % ^` 和括號。`-2^2` 是 -4。
- 函式：`sin cos tan abs sqrt exp floor ceil round min max pow clamp(x, lo, hi)`。

單位：

| 東西 | 單位 |
|------|------|
| 大小、`at` | × 機高；寫 `"12pt"` 是 12 點 |
| `frame` | 點 |
| 粒子 cell 的速度、加速度 | 點（要跟著機高就寫 `"0.3*h"`） |
| JSON 的角度（`rotation`、`lean`） | 度 |
| JS 的角度 | 弧度 |

寫錯時：

- 看不懂的運算式改用預設值。
- 不認得的名字當作 0。
- 兩種都會在運行紀錄（`~/Library/Application Support/GundamPet/logs/run/`）寫一行 `error`，寫出角色、狀態和內容。
- 算出 NaN、無限大、負的格數時當作沒給，不會讓 App 當掉。

### 5.4 圖層（`layers`）

```json
{"name": "spark", "image": "fx/spark", "size": "24pt", "at": "core", "in": "root", "back": true,
 "scale": "1 + 0.1*sin(t)", "opacity": 0.8, "rotation": 30}
```

**位置與大小**

| 欄位 | 說明 |
|------|------|
| `image` | `"群組/名稱"` |
| `at` | rig 的鍵（在目前顯示的格上量）或 `[x, y]` × 機高 |
| `size` | 寬 × 機高（高照圖片比例），或 `[寬, 高]` |
| `frame` | `[x, y, 寬, 高]`（點，在父層裡）；`center: true` 放在父層正中 |
| `scale`、`opacity`、`rotation` | 運算式，每格算 |

**放在哪一層**

| 欄位 | 說明 |
|------|------|
| `in` | 預設在機體上（跟著晃、傾斜）；`"root"` 在機體旁邊，不跟著晃 |
| `back` | 放在最下面 |
| `z: "aboveBody"` | 在機體正上方 |
| `below` | 在另一個圖層下面：圖層名稱，或系統的 `@sparks`、`@sprite`、`@tint`、`@body` |

**一次做好幾個**

| 寫法 | 說明 |
|------|------|
| `name` | 有名字的圖層歸 JS 程式管：每格沒給就隱藏 |
| `children` | 容器裡的幾張圖，預設跟容器一樣大；名字歸程式管，沒給時保持上次的值 |
| `{"repeat": n, "layers": [...]}` | 一次做 n 組，程式用陣列取第幾個；repeat 數要跟程式的陣列一樣長，給多了會寫進運行紀錄 |

**樣式**

| 欄位 | 說明 |
|------|------|
| `gravity` | `fill`、`aspect`、`center`、`resize` |
| `blend: "multiply"` | 相乘疊色 |
| `anchor` | `[x, y]` |
| `stretch` | `[x, y, w, h]`：圖片中間可拉伸的部分 |
| `background` | `[r, g, b, a]` 底色 |
| `clip` | 切角遮罩，數字是切角的點數 |
| `shadow` | `{color, opacity, radius}` |
| `trilinear` | 縮很小時細線不斷 |

**特殊圖層**

- `shape: "chamfer"`：切角外框，配 `cut`、`inset`、`lineWidth`、`stroke`、`fill`。
- `text`：文字，配 `font: {size, weight: "bold", mono}`、`color`、`align`。

### 5.5 粒子（`emitters`）

```json
{"name": "dots", "at": "core", "size": "16pt", "render": "additive", "back": true, "shape": "point",
 "birthRate": "0.5 + 0.5*sin(t)", "velocity": 1,
 "cells": [{"name": "drift", "image": "fx/dot", "rate": 6, "life": 1.5, "velocity": "0.3*h", "range": "2*pi", "color": [0.6, 0.9, 1]}]}
```

- 放置欄位跟圖層一樣：`at`、`size`、`in`、`back`、`z`、`below`。
- `render`：`additive`、`oldestFirst`、`unordered`。
- `birthRate`、`velocity`：每格算，是所有 cell 的倍率。有名字、又有 JS 程式時，這兩個值和 `at` 只在建立時用一次，之後歸程式管。
- cell 欄位：`name`、`image`、`rate`、`life`、`lifeRange`、`velocity`、`velocityRange`、`range`、`longitude`、`xAccel`、`yAccel`、`scale`、`scaleRange`、`scaleSpeed`、`alphaRange`、`alphaSpeed`、`spin`、`spinRange`、`greenRange`、`color`。這些數值在建立時算一次，可以用 `h`。

### 5.6 時間軸切換的粒子（`particles`）

```json
"particles": {"image": "fx/dot", "core": "core", "size": 20, "color": [1, 0.9, 0.5], "cell": {"lifetime": 1.2},
              "looks": {"think": {"range": "pi/3", "longitude": "pi/2", "velocity": 30, "rate": 2}}}
```

- `looks` 的欄位：`range`、`longitude`、`velocity`、`yAccel`、`xAccel`、`rate`、`speed`。沒寫的是 0，rate 和 speed 是 1。
- 顏色寫在 `color`。沒寫就用系統預設，但角色包應該自己寫。

## 6. JavaScript 程式

用在要「算」的演出，例如每輪隨機挑命中部位、彈道瞄準當下位置。

- **環境**：跑在 macOS 內建的 JavaScriptCore，只能用下面列的東西，不能讀檔、不能上網。一次呼叫超過 0.25 秒就停掉，那個狀態的程式關掉：圖層收起來、機體還原，運行紀錄寫原因。
- **可定義的函式**（全部選用）：

| 函式 | 回傳 |
|------|------|
| `frame(c)` | `[動畫, 格]`；沒定義就用時間軸，再沒有就照 unit.json 的 mode |
| `react(c)` | `{dx, dy, lean}`（點、弧度），每格 |
| `update(c)` | 這格要設的東西（見下） |
| `loopEnds(t)` | 一輪結束了沒（何時可以去遊走） |
| `travel(c)` | 移動時顯示的 `[動畫, 格]` |
| `hide()` | 停止演出時呼叫（要移動、進場、離場） |

- **`update` 可以回傳的欄位**：

| 欄位 | 內容 |
|------|------|
| `layers` | `{名稱: {x, y, opacity, scale, sx, sy, rotation, image, frame, w, h, contentsScale, stroke, shadowColor}}`，或 repeat 組的陣列 |
| `emitters` | `{名稱: {x, y, birthRate, velocity, keyPaths}}`；`keyPaths` 只能是 `emitterCells.<cell名>.<數值屬性>` |
| `body` | `{x, y, scale, rotation}`：整個機體的變形，取代這格的反應 |
| `bodyOpacity` | 機體透明度 |
| `tint` | `{color, opacity}`：蓋在圖上的顏色 |
| `spriteShadow` | `{color, radius, opacity}`：機體外光暈 |
| `marker` | `{x, y, opacity, hidden}`：狀態標記 |
| `brackets` | `{x, y, scale}`：警示角 |
| `tagX` | 名牌左右位置 |
| `skipFade` | 這格換圖不淡入淡出 |

- **系統還原**：換狀態或換腳本時，系統會把上一個程式動過的透明度、標記、警示角、光暈、名牌放回去，程式不用自己收。
- **`c` 的欄位**：`t`、`st`、`now`、`h`、`acting`、`ox`、`oy`（這格的反應位移）、`bodyX`、`bodyY`、`markerX`、`markerY`、`anim`、`fps`、`shownAnim`、`shownFrame`、`settled`、`dash`、`fidgeting`、`plan`、`rootY`、`tagWidth`、`fadeTime`。
- **全域**：
  - `params`：這個狀態的設定。
  - `pet`：`rand(a, b, c)`（固定的亂數 0–1）、`point(rig鍵[, 動畫])`、`bodyPoint(px, py[, 動畫])`、`frames(動畫)`、`holdFrame(動畫, t, fps)`、`imageSize("群組/名稱")`、`rig(鍵)`、`log(文字)`。
  - 小工具：`clamp`、`ease`、`progress`、`rem`。

## 7. 角色檔 .gpet

- 內容：zip，裡面一個 `<id>/` 資料夾。比角色包多一份 `manifest.json`，選擇性多一份 `settings.json`（匯出者在角色設定裡的調整）。沒有 manifest 的一般 `.zip`，以及角色資料夾本身，也都能匯入。
- `manifest.json`：

```json
{"format": "gundam-pet-character", "formatVersion": 1, "id", "name", "code", "exportedAt",
 "states": {"<狀態>": "script | module | plain"}, "requires": {"module": "<id>"}, "settings": false, "files": 0}
```

- 匯入時會擋下的情況：
  - 比這個版本新的格式。
  - 前後代號不一致。
  - 捷徑檔、或不是一般檔的東西。
  - 路徑跑出資料夾。
  - unit.json 指到角色包外面的圖。
  - 壞掉的 JSON。
  - 超過 300 MB 或 5000 個檔。
- 安裝：
  - 同一個角色裝過的話，舊版移到 `characters/.replaced/`，每個角色留最近 3 份。
  - 新版沒放成功時，舊版會搬回原位。
  - 選「套用檔案裡的設定」時，裝完一定要重新啟動。
- 匯出：先寫成暫存檔，成功才換掉原本的檔。失敗時原本的檔不受影響。
