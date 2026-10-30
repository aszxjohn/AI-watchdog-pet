# 鋼彈桌寵

每個 Claude Code session 在桌面底部生成一台 SD 鋼彈，依 session 狀態做不同動作。

## 運作方式

1. **偵測**：每 1.5 秒掃 `~/.claude/projects/*/*.jsonl`（終端機和桌面 app 的 session 都寫在這裡），只看最近 30 分鐘有寫入的檔案。逐行讀新增的紀錄，判斷狀態：

   | 狀態 | 判斷依據 | 力天使的動作 |
   |---|---|---|
   | 等你回覆 | 回合結束後 | 分三段，粒子各自一組設定、彼此漸變：**面向左邊**（平常）粒子只往右後方扇形散開、慢慢往後漂，像在緩慢往左前進；**前衝**時收窄成往右後噴的粒子流（比噴射寬），加一道收束的噴射尾流；**低頭**（偶爾，約 4.4 秒）粒子從中心整圈擴散，是唯一會往左邊的一段。參數在 `Sources/Stage.swift` 的 `DriftLook` |
   | 思考中 | 你送出訊息，還沒有工具呼叫 | （10/29 跟工作中交換動畫）雙槍連射：用 World 零件照 G 世代 Wars「GN Beam Pistol」那格以骨架組出來（`tools/rig.py`＋`poses/pistol_rig_v12.json`：#197 整副身體為根，左手 #93→#102、右手 #83→#94→#98、小腿 #200、狙擊槍 #242、兩面盾 #298 都掛在關節上）。`build_units.py` 的 `pistol` 轉關節產生 6 格：0–2 舉槍、3 瞄準、4 右槍後座、5 左槍後座，並量好每格兩把槍的槍口與槍管方向（v12 兩把槍在手腕各轉 4.6°，槍管都朝左下 14.5°，光彈走兩條平行線；v11 兩把差 9.5°，交錯開火時看起來像彎的）。動作：**舉槍** 0.45 秒 → **連射** 兩把槍輪流，每 0.13 秒一發、一輪 12 發，每發那把槍往上翻 4°（後座）、槍口閃光、整台往後震一下，一道粉紅短光彈從那一格的槍口沿槍管直直飛出（兩把槍角度本來就不同，所以是兩條錯開的直線；後座不要翻太大，槍口一偏離彈道，光彈看起來就像在轉彎） → 停 0.9 秒再來。GN 粒子往右後方扇形，開火時噴得更用力。參數在 `Stage.swift` 的 `Burst`、`PistolGN` |
   | 工作中 | 有工具呼叫還沒回結果 | 力天使的 TRANS-AM（10/29；照 Cross Rays「3:02 Trans-Am」的流程，用 G 世代 Wars 遊戲本身的 TRANS-AM 大圖演出：`assets/raw/wars_dynames_transam.png`），一輪 13.15 秒：①② 遊戲本身的開場（10/30 起直接用 Cross Rays 影片 182.10–185.80 秒共 112 格，30 fps 照原速播 3.73 秒：鏡頭往下落到頭部 → 大頭特寫、眼睛發光 → 黑幕 → TRANS-AM 畫面（白底線稿 → 洋紅、字樣打出、SYSTEM / MODE ACT MAX）→ 力天使站姿由暗轉紅；大頭和 TRANS-AM 畫面裁掉右上 HUD 和下方字幕，站姿那段另用大一點的裁切讓全身入鏡；格子總表在 `assets/reference_video/transam/screen/`）→ ③ 白光爆出、紅色站姿登場、GN 粒子噴出 →（④ 握槍特寫 10/30 拿掉）⑤ 第一槍 → ⑥ 高速移動：連換三個位置、身後拖殘影、每停一處開一槍 →（⑦ 紅色頭部特寫、⑧ 槍口特寫 10/30 拿掉）⑨ 洛克昂駕駛艙特寫（原本狙擊動畫那段，一格不改）→ ⑩（10/30 起衝刺最後就停在高處，特寫前後同一高度，看不到上升）槍口充能（光球＋收縮光環）、超粗粉紅光束＋衝擊環、目標大爆炸 → ⑪ 白光一閃（光暈蓋住換姿勢）換回等你回覆的站姿（stand 第 0 格，朝左；10/30 起，開場框打開前也是這個站姿）、降回原位。所有開槍都用 10/30 重做的**全武裝狙擊射擊姿勢** `ta_snipe`（`poses/ta_snipe_v3.json`）：照 Wars TRANS-AM「GN Sniper Rifle」74.4 秒的開火格，用 Wars TRANS-AM 零件表以骨架組成（T#76 正面全身當根、T#23 右肩盾往左下斜伸、T#6 左肩護甲＋左手＋直立左盾、T#164 狙擊槍；開火格換 T#9 發光槍口），槍口取槍膛中心、光束沿槍管往左下約 31°。射擊特效全用 Wars 自己的粉紅光束貼圖（`_0 Effects/DV_efe.png`＝力天使專用、`GN_beamrifule_P.png`）：開槍瞬間機體白閃、槍口光雲爆開＋鏡頭光暈＋十字光＋放射狀槍焰，光束是 DV_efe 的光棒中段拉長（亮芯只占貼圖高度 1/5，所以光束畫成兩倍粗：第一槍 30、移動中 18、最大出力 90）。這個姿勢零件表只有紅色版，⑪ 不能逐像素退色，改成白光蓋住再換回原色站姿。舊的紅色狙擊姿勢 `snipe_ta` 已不用。開場的特寫框跟洛克昂的同大小、同位置。拿掉自製特寫前的版本備份在 `backups/working-transam-2026-10-30/`（含可直接執行的 app）。GN 粒子照狙擊的往右後扇形，一律綠色（10/30：力天使的 GN 粒子不管什麼狀態都是綠的，TRANS-AM 也不變紅）。最大出力光束起點往槍膛裡縮 0.3 倍粗細，光棒圓頭的淡入段藏進槍口，不會跟槍口脫開。10/30 狙擊姿勢 `ta_snipe` 和衝刺用的 `ta_stand` 一起縮到 80%（1.4→1.12、0.9→0.72），左右移動更明顯；同日衝刺重排（停點 ×unitHeight，x＋＝右、y＋＝上：(-1.6, -0.08) 低處往左 → (0.3, 0.08) 往右閃 → (-2.0, 0.2) 最左 → (-0.6, -0.45) 往右下大幅俯衝（降 0.65）→ 往右上拉回原位正上方 (0, 0.45)；橫移 1.6／1.9／2.3／1.4，一開始很低、前幾次閃避逐步升高，倒數第二段大幅下降、最後拉回最大出力的高度，接洛克昂特寫和 ⑩ 不再另外升高；衝刺段 3.0 秒，一輪變 13.15 秒；展示機站在螢幕最右邊，所以往右最多 0.3，主要往左拉開；每段衝刺 0.2 秒）；最後一段衝回原位改用狙擊姿勢滑回去，洛克昂特寫前後全程都是狙擊姿勢，不會閃一下站姿；最大出力光束改成停在鎖定的目標點、爆炸放在光束尾端（開槍那一刻固定位置，降回原位時不跟著跑），不再在半空中爆炸。參數在 `build_units.py` 的 `transam`、`Stage.swift` 的 `TA`、`updateTransAm`、`updateTAPanel` |
   | 要你批准? | 工具呼叫卡超過 8 秒且紀錄沒動（猜的，所以有問號） | 防禦待命：全盾合起（Cross Rays 11），盾合好後 GN 力場長出來，機體在裡面往上浮 0.55 個機高。力場用 G 世代 Wars 戰鬥動畫本身的 GNF 貼圖（`assets/raw/wars_combat_effects.zip` 的 `_0 Effects/GNF.png`，切成柔光、兩張粒子球、外環、底部亮弧五塊，`units/dynames/field/`，不加色）：柔光和粒子球在機體後面、外環和亮弧在前面；中間幾乎透明、邊緣亮、底部一道亮綠，跟影片 171.95 秒那格一樣。直徑約機高 2 倍。兩張粒子球反向慢轉、輪流變亮。力場長好後每 5.6 秒一輪攻擊（照影片 167～173.8 秒）：機體縮成 0.72 倍、帶著力場在範圍內衝刺換位（衝刺時身體傾斜、身後留下少量淡 GN 粒子，`Fx.configureDashTrail`），前兩波各三發、第三波一發，瞄準牠當下的位置，牠閃開，光彈從剛離開的地方擦過飛走；第四次閃不掉，六發輪流打在機體不同部位（左肩、右上大盾、腿、右下盾尖、又一發肩膀附近，落點是在全盾那格量的），每發火球小、分得出位置，落點跟著被震開的機體走；最後一發在中間大爆炸，白光、火球、黑煙，每發把機體往後震、畫面晃，最後一發大爆炸；煙散後飄回原位。路線和子彈表在 `Field.moves`、`Field.shots`。特效全是 Wars 的貼圖（2PMG 光彈、w04／w05 火球與煙，`units/dynames/attack/`）。「!」閃（10/30 拿掉了閃爍的橘色角框）。參數在 `build_units.py` 的 `field`／`attack`、`Stage.swift` 的 `Field`、`updateAttack` |
   | 要你決定 | AskUserQuestion / ExitPlanMode 等你回答 | 支援防禦（照 G 世代 Wars 1:14「Support Defend」），一輪 5.4 秒：站著 → 前傾衝出去、背後 GN 粒子大量往後噴 → 全盾合起撐住；12 發 Wars 的橘色曳光彈（2PMG）從左前方打來，每輪隨機打在機體不同部位（頭、左肩、上方大盾、腿、中間…，同一處不連打），命中處黃光、黃色火花往來的方向噴（hibana_Y）；挨打期間機體一路往後退、每發再頓一下。除了前衝、提速那兩段（改成背後噴射），其餘時間（一開始直立、合盾挨打、收盾、回原位直立）身上都持續放 GN 粒子，照「等你回覆」面向左邊那樣往右後扇形散開（數值另存一份 `GuardGN`，不會往左） → 再提速前衝、噴射 → 收盾 → 回到原位站好，「?」（10/30 拿掉了閃爍的橘色角框）。參數在 `Stage.swift` 的 `Guard`、`GuardGN` |
   | 做完了 | 回合剛結束（6 秒內） | 轉身露出背後的 GN 太陽爐（Cross Rays p19）：太陽爐一亮、先一大股 GN 粒子噴出，之後一直持續從太陽爐往四周飄散、慢慢往下沉。光暈和粒子都是 Wars 的 GN 特效貼圖（oo_ring_flash 光暈與綠核、小光點；oo_gn_pati 星形閃光、柔霧；`units/dynames/drive/`），太陽爐位置記在 `rig.driveAt`（圓頭中心）。粒子和光暈都蓋在最上層；光暈中間建置時調成半透明（`clearMiddle`），粒子用一般混色（不疊加），發射範圍鋪開在太陽爐上，中間是半透明的綠、看得到底下的太陽爐。光暈貼圖原本是給疊加混色用的（暗＝透明），建置時轉成透明底。參數在 `Stage.swift` 的 `Drive`、`Fx.configureDriveGN` |
   | 休息中 | 10 分鐘沒動靜 | 縮在合起的全盾裡、像在無重力的太空中漂流：一輪 10 秒，從左斜慢慢轉到正面、再轉回左斜（`turn` 影格表＝遊戲繭動作的 9–14 格，本來就是「左斜 → 正面」的轉身。試過用鏡像補右半邊，但正面那格本身不對稱，轉過正面時兩面盾一瞬間換邊、接不起來，使用者說只留半邊；素材沒有繭的側面和背面，所以也轉不到背面）；同時左右漂 ±8 pt（17 秒）、上下 ±4 pt（11 秒）、傾斜 ±5°（13 秒），三個週期不同，不會整齊重複。一直緩緩放 GN 粒子，散佈照「等你回覆」朝左直立那樣：從身體中間往右後扇形散開、不往左（方向、範圍、推力直接用 `DriftLook.facingLeft`），但量少、速度慢（每秒最多約 24 顆、速度 22、約 3.6 秒淡掉），量照 5 秒一輪像呼吸起伏（40%～100%）。圖層在機體後面，粒子從盾牌後面飄出來。「z」、名牌灰色；整台不透明（原本 `dim` 0.55 讓整台變半透明，10/29 使用者要求拿掉）。參數在 `build_units.py` 的 `turn`、`Stage.swift` 的 `Sleep`、`SleepGN`、`Fx.configureSleepGN` |
   | 出錯了 | API 錯誤 | 全盾（Cross Rays 11）被一輪輪攻擊到快自爆：一輪 6 秒，小爆炸一發接一發打在機體各部位（每輪隨機、同一處不連打；Wars 的白光、小火球、火花），越打越密、越打越重，機體一直抖、每發再被震一下、偶爾像畫面故障一樣往旁邊跳，紅光越來越深；第 5.2 秒大爆炸（白閃、大火球），之後平靜一下再開始下一輪。畫面前面像隔著螢幕貼了封條：機體中間橫一條 ERROR 封條（高 24 pt，ERROR 字照字形實際範圍放在上下邊條正中間），透明底、黃色斜紋＋紅字（照使用者給的封條參考圖，素材包沒有，`build_units.py` 的 `alarm` 畫的，含淡掃描線），不跟著機體晃、偶爾閃斷或錯位；頭頂原本的 ERROR 牌使用者要求拿掉。這個狀態不顯示「!!」標記。GN 粒子照「等你回覆」朝左直立的扇形（往右後、不往左），一陣一陣斷續噴，中彈和爆炸時噴更多。一開始那下受擊（白光轉紅、火花、煙圈）保留。參數在 `Stage.swift` 的 `Alarm`、`updateAlarm`、`alarmShake`、`Fx.configureAlarmGN` |

   進場從上方降落、離場轉身往上飛走，都拖著 GN 粒子。動作切換時會淡入淡出；
   有「進入 / 維持 / 收回」三段的動作，離開狀態前會先播收回段。
   每個狀態用哪個動作寫在 `tools/build_units.py` 的 `rig`（會帶進 `units/<id>/unit.json`）。

   工具執行失敗只會讓鋼彈抖一下，不改狀態。session 30 分鐘沒寫入就飛走。

2. **抽機體**（目前池子只有力天使，另外三台的原始檔在 `assets/shelved/`）：新 session 從池子裡抽「目前畫面上沒人用的」機體；全部都在畫面上才會重複（挑出場次數最少的）。畫面上的鋼彈不會中途換人。同一個 session 重開 app 會沿用原本的機體（`assignments.json`，7 天沒出現就清掉）。

3. **畫面**：一個透明、置頂的長條視窗，貼在螢幕底部（Dock 上方），最舊的 session 在最右邊。平常滑鼠穿透，只有游標移到某台鋼彈身上時才接收點擊（所以點在鋼彈身上的左鍵會被它吃掉）。選單列的「GN」可以隱藏鋼彈、關名牌、切模式、結束。
   **切模式（10/30）**：右鍵（或 control+點）任何一台鋼彈，選單裡有「一般模式」「展示模式（Debug）」，目前的模式打勾；一般模式的右鍵選單最上面列出這台是哪個 session、什麼狀態。同樣的切換也在 Dock 圖示的右鍵選單、App 選單列（程式在最前面時）和「GN」選單裡。
   **遊走與角色設定（10/30）**：畫布改成整個螢幕（扣掉選單列和 Dock）的透明視窗，鋼彈會在整個畫面遊走。每台在底部一排有自己的「位置」：從那裡進場，不遊走的狀態就回去待著。
   - 角色檔 `characters/<id>/character.json`（跟著專案、打包進 app）：大小 `height`（pt，所有狀態一樣大，取代以前 config.json 的 `unitHeight`）＋每個狀態的遊走設定：`wander`（會不會遊走）、`cells`（偏好的九宮格，0～8 由左上往右下，可不連續）、`strength`（偏好強度）、`step`（一次走多遠 small/medium/large＝1～2.5／1.5～4／2.5～6 倍機高）、`stay`（每次停留秒數 [最少, 最多]）、`speed`（pt/秒）、`room`（這個狀態的動作需要的空間，倍機高，只寫在角色檔）。
   - 你的修改：右鍵鋼彈／Dock／「GN」選單的「角色設定…」打開面板，改了立刻存到 `~/Library/Application Support/GundamPet/characters/<id>.json`（只存跟角色檔不一樣的欄位）並立刻生效；面板可恢復預設、可「在畫面上預覽」該狀態（切到展示模式）。
   - 遊走公式（`Sources/Character.swift` 的 `Wander.next`，方向輪盤）：每次從現在位置往 16 個方向各走一步得到候選點（會讓動作跑出螢幕的丟掉）；有 `strength` 機率是「偏好步」，候選點權重 exp(−4d/σ)，d＝到最近勾選格子的距離（格子內為 0）、σ＝半格高，所以往格子走或留在格子裡；其餘是「自由步」，每個方向機會一樣，所以不喜歡的區域也會去。離別台兩倍機高內的點權重壓很低（個人空間）。面板上的「預計待在選的格子裡的時間」是用同一個公式模擬 3000 步算的。
   - 一輪一輪的動作（TRANS-AM、雙槍、兩個盾牌狀態）只在一輪演完時才出發，移動時暫停（TRANS-AM 換回原色站姿），到了重新開始一輪，所以光束、衝刺不會被拖著走。
   **大小一致（10/30）**：所有狀態的機體都畫成跟「等你回覆」一樣大，用頭盔頂到眼睛的高度量（約 52 px）：思考中的雙槍原本是 1.38 倍（scale 1.1 → 0.8）、TRANS-AM 衝刺用的紅色站姿原本 1.2 倍（0.72 → 0.6）；其他狀態都是 Cross Rays 同一套縮放，本來就一樣。新做的姿勢也要照這個大小。
   **Dock 圖示（10/30）**：程式會出現在 Dock（`Info.plist` 拿掉 `LSUIElement`、改 `CFBundleIconFile`，啟動時設成一般 App；`--offscreen` 連拍不進 Dock）。圖示是 `tools/make_icon.py` 用 Cross Rays 原圖做的（A 全身展翼／B 全身收盾／C 胸像特寫，現用 C），產出 `assets/icon/AppIcon.icns`，`build.sh` 會打包進去；換版本：`python3 tools/make_icon.py A && ./build.sh`。點 Dock 圖示時鋼彈若被隱藏會重新顯示。

4. **展示模式（Debug）**：畫面上只留一隻，右鍵選單可以切到任一狀態（再選同一個會重播）、重播進場、觸發「工具出錯」抖一下；選「一般模式」恢復顯示真實 session。
5. **選螢幕**：接兩個以上螢幕時，鋼彈的右鍵選單（兩種模式都有）和選單列「GN」都有「顯示在」，選哪個螢幕鋼彈就搬到那個螢幕底部，記在 config.json 的 `screen`（螢幕名稱）；那個螢幕拔掉時自動回到主螢幕。

## 已定案：「等你回覆」（2026-10-27，不要再動）

使用者確認定案。之後調整其他狀態時，**不能讓「等你回覆」有任何變化**；如果要改的東西它也有用到，
先把每個狀態拆成各自獨立的動畫表，讓它留在自己那份，再改其他狀態。

它用到的東西（改這些之前要先想清楚）：
- 素材：`units/dynames/stand/`（站姿 15 格，進入 0–3／維持 4–10／收回 11–14）、`units/dynames/pose_a/`（低頭）、`fx/glow_a.png`、`fx/glow_b.png`
- rig：`"waiting": {"anim": "stand", "mode": "flourish", "fidget": ["pose_a"], "gnIdle": true, "jet": true}`
- `Sources/Stage.swift`：`DriftLook`（facingLeft／aura／dash 三組粒子）、`Fx.configureIdle`／`Fx.apply`／`Fx.configureJet`、
  `PetNode` 的 `flourishFrame`（休息 3.5–7 秒、45% 機率低頭、低頭 4.4 秒）、`dashTarget`、`fidgetLevel` 漸變（0.15 展開／0.35 收回）、
  `dashLevel` 漸變、發射點（粒子在身體中心、噴射在 0.2h,0.1h）
- 共用：淡入淡出 0.22 秒、進場降落、名牌、`build_units.py` 的對齊與縮放（`TARGET_H`）

定案版本整套備份在 `locks/waiting-2026-10-27/`（程式、`build_units.py`、`units/`、`build.sh`），
`MANIFEST.sha256` 是每個檔案的雜湊，之後可以逐行比對或還原。

## 已定版：狙擊動畫（2026-10-29 以「思考中」定版，不要再動；10/29 起改給「工作中」用）

使用者說「這個先這樣定版了」。之後使用者要求思考中、工作中兩個動畫交換，這套狙擊動畫改給「工作中」；同日又要工作中改成 TRANS-AM、只保留洛克昂特寫，所以現在沒有狀態在播整套狙擊循環（程式還在），定版保護的剩：狙擊姿勢 `snipe`（TRANS-AM 一般色時用）和洛克昂駕駛艙特寫（TRANS-AM 第 ⑨ 段原樣呼叫 `updateCutin`）。之後做其他狀態時，**不能讓這套狙擊動畫有任何變化**；共用的東西要改，先複製一份給新狀態。

它用到的東西：
- 素材：`poses/snipe_aim_v2.json` → `units/dynames/snipe/`（#286＋#260＋#119、`erase`／`clip` 挖盾補肩甲、`lift` 105）、`units/dynames/cutin/`（駕駛艙特寫與鎖定框）
- rig：`"working": {"anim": "snipe", "mode": "cycle", "fps": 8}`（定版時寫在 `"thinking"`）、`fireAnim`、`snipeMuzzle`／`snipeDir`／`snipeCore`、`cutinPupil`
- `Sources/Stage.swift`：`Cycle`、`cyclePhase`、`updateCycle`、`firePoint`、`floatAim`、`LockHud`、`SnipeGN`、`Fx.configureSnipeGN`／`applySnipeGN`、
  粉紅光束（`buildPinkBeam`）、駕駛艙特寫（`Cut`、`buildCutin`／`updateCutin`／`closeCutin`）、`bubbleHome` 在狙擊動畫（cycle 模式）時的位置、名牌讓位
- `tools/build_units.py`：snipe 區塊（`piece()` 的 erase/clip、槍管中心線擬合）、cutin 區塊（`pupil`）

槍＋手跟著鎖定框轉的原型做過（`preview/arms_follow_proto.png`），使用者選擇不做，不在定版內。
定版備份在 `locks/thinking-2026-10-29/`（含 `MANIFEST.sha256`）。

## GN 粒子貼圖（10/29 換成遊戲原圖，使用者要求）

所有狀態共用的 GN 粒子圖 `fx/glow_a.png`、`fx/glow_b.png`，原本是 World 零件表裡的兩顆青色橢圓，
改成 G 世代 Wars 天上人機體的 GN 粒子表（`wars_combat_effects/_0 Effects/GNparticle_CB.png`）：
圓光點 → glow_a、十字閃光 → glow_b，縮放成跟舊圖一樣寬（31／24 px）。遊戲光點是細小亮點，看起來比舊的綠霧細；
也試過放大 1.5 倍（46／36 px）的版本，使用者選同寬這版。
**只換圖，粒子設定一個都沒動**（方向、範圍、數量、速度、縮放、染色都照舊），所以兩個定版狀態的動作不變、只有粒子的樣子變了。
設定在 `build_units.py` 的 `fx.gn`。對照圖：`preview/gn_texture_before_after.png`。

## 檔案

```
Sources/            Swift 程式（SessionWatcher 偵測、Units 素材與池子、Stage 畫面、main 選單列）
units/<id>/         處理好的素材：unit.json（含 rig）+ 每個動作一個資料夾（stand/ aim/ shield/ …）+ fx/ 特效 + cutin/ 瞄準特寫零件
assets/raw/         下載的原始 zip（spriters-resource.com，SD Gundam G Generation Cross Rays 拆圖）
                    特效包（10/29）：world_common_combat_effects、world_map_effects、wars_combat_effects、crossrays_{common_effects,shield_effects,explosions,rapid_fire,beams_1,beams_2,unique_weapon_effects,beam_sabers,map_weapon_effects}.zip，解壓在 assets/extracted/ 同名資料夾
assets/extracted/   解壓後的原始 PNG
tools/build_units.py  原始 PNG → units/（對齊每格、統一高度、算錨點）
tools/contact.py      某台機體所有原始圖的一覽圖
tools/filmstrip.py    檢查某個動作每格有沒有對齊
tools/parts.py        把零件拆圖切成一個個零件（parts.json + 一覽圖）
tools/assemble.py     依 poses/*.json 用零件拼姿勢（只擺位置/旋轉/縮放/上下層）
tools/state_stats.py  用 Claude Code 對話紀錄重播狀態判定，統計每個狀態實際顯示多久、出現幾次、每次停多久
tools/make_icon.py    App 圖示（Cross Rays 原圖 → assets/icon/AppIcon.icns；參數 A/B/C 選版本）
tools/rig.py          骨架組裝：身體為根、零件掛在關節上用角度擺姿勢（工作中 poses/pistol_rig_v14.json）
                      做法、比對工具、打槍紀錄在 ~/.claude/skills/gundam-pet-animation
preview/ 找零件、比對用的圖（可刪）
build.sh            編譯成 build/GundamPet.app
```

設定檔：`~/Library/Application Support/GundamPet/config.json`（第一次啟動自動產生，缺的欄位用預設值）。
改完要重開 app 才生效。`debug: true` 會每 2 秒輸出 `logs/state.json`（各 session 狀態）和 `logs/snapshot.png`（畫面）。

## 常用指令

```bash
./build.sh && open build/GundamPet.app             # 編譯並啟動
open build/GundamPet.app --args --showcase         # 直接以展示模式啟動（平常用右鍵選單切就好）
build/GundamPet.app/Contents/MacOS/GundamPet --offscreen --panel-snapshot out.png --panel-state thinking
                                                   # 角色設定面板畫成 PNG（不開視窗；深色模式字是白的，看時疊深色底）
open build/GundamPet.app --args --showcase --showcase-state thinking   # 展示模式從指定狀態開始
open build/GundamPet.app --args --demo             # 示範模式：8 個假 session 各一種狀態，每 10 秒輪換
open -W build/GundamPet.app --args --demo --snap-burst 24   # 示範模式連拍 24 張到 logs/burst/ 後自動結束
build/GundamPet.app/Contents/MacOS/GundamPet --showcase --offscreen --snap-burst 40 --snap-delay 2
                                                   # 離線連拍（不開視窗、可和正在跑的並存），粒子也拍得到
pkill -x GundamPet                                 # 關掉
```

## 加一台機體

1. 從 spriters-resource.com 的 Cross Rays 頁下載那台的 zip，放到 `assets/raw/<id>.zip`，解壓到 `assets/extracted/<id>/`。
2. `python3 tools/contact.py assets/extracted/<id> preview/contact_<id>.png` 看有哪些圖。
   通常主資料夾有兩組 15 格動作（p01 待機、p08 武器架勢），`PSV/` 裡有單張姿勢，p09 是衝刺。
3. 在 `tools/build_units.py` 的 `UNITS` 加一筆（中文名、型號、各動作的路徑、`rig` 狀態對應，照力天使那筆改），跑 `python3 tools/build_units.py <id>`。
4. 對大小：所有機體都跟力天使的「等你回覆」一樣大（頭盔頂到眼睛約 52 px），用 `python3 ~/.claude/skills/gundam-pet-animation/scripts/size_check.py --unit <id> stand:0` 量。
5. `./build.sh`，重開 app。池子自動變大。之後做各狀態的動作照 skill `gundam-pet-animation` 的流程（找參考 → 抓素材 → 骨架 → 對大小 → 比對 → 動畫 → 驗證 → 回饋）。

## 版權

素材是萬代南夢宮遊戲的拆圖，只供自己桌面使用，不要外流。
GitHub 上的 repo 只有程式碼（見 `.gitignore`）：`assets/`、`units/`、App 圖示、`locks/` 都不在裡面，clone 下來要照「加一台機體」和 skill `gundam-pet-animation` 的說明自己下載素材，跑 `tools/build_units.py`、`tools/make_icon.py` 產生後才能 `./build.sh`。
