---
title: 'Story 1.1：用 Forge 模板建立專案骨架'
type: 'chore'
created: '2026-11-03'
status: 'done'
baseline_commit: '07685e6a65af88791cc8c90aa683e59bc3c7fadd'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `main` 分支只有 README、BMAD 與規劃文件，沒有任何程式碼；之後 35 個 story 都需要同一套技術棧、版本與目錄結構。

**Approach:** 在暫存資料夾以 `create-electron-app@8.0.1 --template vite --typescript` 產生模板，把產物（不含模板自帶的 `.git`）搬進 repo 根目錄、不覆蓋既有檔案；鎖定版本、建好架構規約約定的目錄，並把 lint／typecheck 的範圍限定在程式目錄。

## Boundaries & Constraints

**Always:** `electron` 鎖 45.2.1（exact）；TypeScript 6.0.3、`strict: true`；`ses` 以 exact 版本 2.3.0 加入 dependencies；保留模板預設（`forge.config.mts`、main／preload 產物 `.cjs`、oxlint＋oxfmt、`typecheck`、FusesPlugin 的 `RunAsNode` 關、`OnlyLoadAppFromAsar` 與 `EnableEmbeddedAsarIntegrityValidation` 開）；提交 `package-lock.json`；lint、format、typecheck 只涵蓋 `src/`、`test/`、`prototypes/` 與根目錄的 `*.mts` 設定檔。

**Decisions（使用者 2026-11-04 決定）：**
- Node：`.nvmrc` 與 `engines` 都寫 24.22.2；使用者之後自行 `brew upgrade node`，升級前 npm 只出警告。
- 授權：`package.json` 維持 `"license": "MIT"`。
- 驗證：可以跑 `npm start` 在桌面開出模板視窗，確認後立刻關閉。

**Never:** 刪除、移動或掃描根目錄 7 個 Demo 資料夾（`assets`、`backups`、`build`、`characters`、`locks`、`preview`、`shelved`）與 `_bmad-output/`、`.claude/`；覆蓋 `README.md`；加入本 story 用不到的套件（React、PixiJS、zod 等留給之後的 story）；開始 Story 1.2 的任何內容；使用 sudo；執行 git 寫入指令。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 搬入模板 | repo 根目錄已有 `README.md` 等 | 只新增模板檔案，既有檔案內容不變 | 檔名衝突時停下回報，不覆蓋 |
| npm 快取權限 | `~/.npm` 有 root 擁有的資料夾 | 改用 `npm_config_cache` 指到暫存目錄完成安裝 | 不改 `~/.npm` 權限 |
| lint 範圍 | Demo 資料夾有大量檔案 | `npm run lint`、`npm run typecheck` 不讀 Demo 資料夾 | — |

</frozen-after-approval>

## Code Map

- 模板產物（已在暫存資料夾產生並檢查）：`package.json`、`package-lock.json`、`forge.config.mts`（entry 指向 `src/main.ts`、`src/preload.ts`，renderer `main_window`）、`vite.main.config.mts`、`vite.preload.config.mts`、`vite.renderer.config.mts`（皆為空的 `defineConfig({})`）、`tsconfig.json`（沒有 `strict`，include `src/**/*`、`*.ts`、`*.mts`）、`.oxlintrc.json`、`.oxfmtrc.json`、`.gitignore`、`index.html`（根目錄，載入 `/src/renderer.ts`）、`src/main.ts`、`src/preload.ts`、`src/renderer.ts`、`src/index.css`、`src/declarations.d.ts`（引用 `forge-vite-env` 型別）。
- 模板實裝版本：electron 45.2.1（exact）、typescript ^6.0.3、vite ^8.3.5、oxlint ^1.90.0、oxfmt ^0.41.0、Forge 套件 ^8.0.1；`lint` 腳本是 `oxlint && oxfmt --check`（會掃整個根目錄）、`typecheck` 是 `tsc --noEmit`。
- repo 既有：`README.md`、`.claude/skills/`、`_bmad/`、`_bmad-output/`；Demo 資料夾只在 `.git/info/exclude` 排除。

## Tasks & Acceptance

**Execution:**
- [x] 暫存資料夾 -- 以模板產生專案 -- 避免 `create-electron-app` 在非空資料夾出錯
- [x] repo 根目錄 -- 搬入模板產物（排除 `.git`、`node_modules`），重新 `npm install` -- 不覆蓋既有檔案
- [x] `src/main/main.ts`、`src/preload/panels.ts`、`src/panels/index.html`、`src/panels/renderer.ts`、`src/panels/index.css`、`src/main/forge-env.d.ts` -- 把模板入口搬進約定目錄，`forge.config.mts` 與 `vite.renderer.config.mts`（`root: 'src/panels'`）跟著改 -- 對齊 Structural Seed
- [x] `src/shared`、`src/overlay`、`src/sandbox`、`test`、`prototypes` -- 建空目錄（`.gitkeep`） -- 讓後續 story 有固定位置
- [x] `package.json` -- 名稱 `ai-watchdog-pet`、productName `AI Watchdog Pet`、`ses` 2.3.0 exact、`engines`、lint 腳本只掃程式目錄 -- 版本與範圍規則
- [x] `tsconfig.json` -- `strict: true`，include 改為 `src`、`test`、`prototypes` 與根目錄 `*.mts` -- 不掃 Demo 資料夾
- [x] `.nvmrc` -- 寫 `24.22.2` -- 依使用者決定

**Acceptance Criteria:**
- Given 完成搬入，when 比對 `README.md`、`.claude/`、`_bmad-output/` 與 7 個 Demo 資料夾，then 內容與搬入前相同。
- Given 專案已建立，when 執行 `npm run typecheck` 與 `npm run lint`，then 都通過，且不讀 Demo 資料夾與 `_bmad-output/`。
- Given 專案已建立，when 執行 `npm start`，then 模板視窗能開出，確認後立刻關閉。

## Implementation Notes

- 模板以 `npm_config_cache` 指到暫存目錄產生與安裝，`~/.npm` 權限未動；用 `rsync --ignore-existing` 搬入、排除 `.git` 與 `node_modules`，沒有檔名衝突。
- 模板裝的是 latest `electron` 45.2.2，已改回 exact `45.2.1`。TypeScript、Vite、Forge 在 `package.json` 維持模板的 caret，實裝版本由 lockfile 鎖定（6.0.3、8.3.5、8.0.1）。
- preload 改名後產物是 `panels.cjs`（Forge 以入口檔名命名），`src/main/main.ts` 跟著改。
- `vite.renderer.config.mts` 把 root 設為 `src/panels`，並以絕對路徑把 `build.outDir` 固定回 `.vite/renderer/<name>`；否則 outDir 會跟著 root 跑，打包後 main 找不到 renderer。打包模式本 story 未驗證（只驗 dev）。
- oxlint 不展開 glob，lint 腳本逐一列出根目錄 4 個 `.mts`；之後新增根目錄設定檔要補進清單。
- I/O Matrix 三列以指令驗證（本 story 尚無測試框架，Vitest 於 Story 1.3 建立）：搬入前後 `README.md`、`.claude`、`_bmad`、`_bmad-output` 的 SHA1 一致，7 個 Demo 資料夾 7,363 筆 metadata 一致；npm 快取改用暫存目錄；`tsc --listFilesOnly` 與 `oxlint --debug=files` 只列出 `src/` 4 個檔與根目錄 4 個 `.mts`。
- `npm start` 已確認開出「Hello World!」視窗後關閉。`.claude/launch.json` 是 Claude 桌面 app 預覽時自動建立的，不屬於本 story，不隨本 story 提交。
- 已知非本 story 範圍：`npm install` 報 25 個漏洞（模板依賴）；本機 Node 24.18.0 低於 engines 24.22.2，只出警告（使用者決定）。

- 審查修補（第 1 輪，未觸發 loopback）：lint 的 oxlint 加 `--deny-warnings`；`openDevTools()` 只在 `!app.isPackaged` 時呼叫；`forge-env.d.ts` 由 `src/main/` 搬到 `src/`（偏離上方 Tasks 的路徑，因其中的 `*.css` 宣告是給 panels 用）；tsconfig 加 `isolatedModules`；`description` 改為實際描述；`packagerConfig.executableName` 設為 `ai-watchdog-pet`；`.gitignore` 加 `.DS_Store`；本機 `.git/info/exclude` 加 `/.claude/launch.json`。
- 打包驗證：`npm run package` 成功產出 `out/AI Watchdog Pet-darwin-arm64/`，執行檔名為 `ai-watchdog-pet`；`app.asar` 內含 `/.vite/build/main.cjs`、`/.vite/build/panels.cjs` 與 `/.vite/renderer/main_window/index.html`，確認 root／outDir 覆寫在打包模式有效。修補後重跑 typecheck、lint 皆通過；修補只影響打包行為，dev 模式的 `npm start` 未重跑（打包時已重新建置 main）。

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Evidence |
| --- | --- | --- | --- |
| VG1 打包模式 renderer 產物位置沒被驗證 | medium | patch | 預檢後送來的缺口：`npm start` 走 dev server 不會用到 outDir；只有實際 `npm run package` 並檢查 `.vite/renderer/main_window/index.html` 與 asar 內容才能證實。 |
| VG2 preload 檔名寫錯 `npm start` 看不出來 | low | defer | preload 目前是空檔，`.vite/build/panels.cjs` 已存在；Story 1.3 讓 preload 暴露 API 後，對 API 的斷言會涵蓋這條路徑。 |
| VG3 lint 遇到 correctness 警告仍 exit 0 | medium | patch | `.oxlintrc.json` 的 correctness 為 warn、腳本沒加 `--deny-warnings`；審查者以含 `debugger;` 的暫存檔實測 exit 0，AC「lint 通過」因此擋不住錯誤。 |
| VG4 `.claude/launch.json` 出現在 diff | low | patch | Claude 桌面 app 預覽時建立、未被任何 ignore 排除，`git add .` 會誤提交；加進本機 `.git/info/exclude` 即可。 |
| B1 sprint-status 應為 review | false | reject | step-05 會把 story 設為 `review`，審查進行中維持 in-progress 是流程設計。 |
| B2 `.claude/launch.json` 跑進 diff | low | patch | 與 VG4 同一根因。 |
| B3 diff 缺 `package-lock.json` | false | reject | lockfile 存在且未被忽略；`npm ls` 與 lockfile 已確認 electron 45.2.1、ses 2.3.0、typescript 6.0.3。diff 省略它只是審查檔大小考量。 |
| B4 Code Map 寫 oxlint ^1.90.0，實裝 ^1.91.0 | low | reject | 模板在實作時重新產生時拿到最新 1.91.0，沒有行為差異；修正方式是改 spec，依規則駁回。 |
| B5 其他套件沒鎖 exact、沒有 save-exact | false | reject | 架構 Conventions 寫「lockfile 必須提交、ses 鎖確切版本、Forge／Vite 依 semver 升級」；caret＋lockfile 符合規約。 |
| B6 lint 不擋警告 | medium | patch | 與 VG3 同一根因。 |
| B7 新增根目錄 .mts 不會被 oxlint 掃到 | low | defer | oxlint 不展開 glob；Story 1.3 會新增 vitest／dependency-cruiser 設定並建立 CI，屆時一併處理清單維護。 |
| B8 renderer 名稱仍是 main_window | low | defer | Story 1.5／1.6 才建立 panels 與 overlay 兩個 renderer，命名與 `*_VITE_*` 宣告在那時決定。 |
| B9 `forge-env.d.ts` 放在 src/main | low | patch | 其中的 `declare module '*.css'` 給 panels 用，放在 main 底下會讓型別依賴方向看起來是 panels→main；搬到 `src/forge-env.d.ts` 是直接修正。 |
| B10a main 與 renderer 共用一份 tsconfig | low | defer | 目前 renderer 與 preload 都沒有程式；Story 1.3 建 preload API 時再決定是否拆分各 process 的 tsconfig。 |
| B10b 缺 `isolatedModules` | low | patch | Vite 逐檔轉譯，官方建議開啟；加一個選項即可。 |
| B10c `noImplicitAny` 重複、`sourceMap` 在 noEmit 無效 | low | reject | 沒有實際影響。 |
| B11a 打包模式沒驗證 | medium | patch | 與 VG1 同一根因。 |
| B11b root 移到 src/panels 後 envDir／publicDir 也跟著移 | low | reject | app 第一版完全不連網、不使用 .env，素材來自角色包的 `pack://`，不會用到 public 目錄。 |
| B12a productName 含空格、沒設 executableName | maybe-false | patch | Linux deb／rpm maker 已知會用 `name` 找執行檔；本 story 沒跑 make 無法實測，補上 `executableName` 是直接修正。 |
| B12b description 是模板佔位字 | low | patch | 會寫進安裝檔中繼資料；改成實際描述。 |
| B13a 打包版也會開 DevTools | medium | patch | `openDevTools()` 無條件呼叫；加 `!app.isPackaged` 判斷。 |
| B13b 打包後用 file:// 而非 app:// | medium | defer | AD-24 的 `app://` 由 Story 1.5 實作。 |
| B13c webPreferences 沒明寫 sandbox 等 | medium | defer | AD-24 的安全設定由 Story 1.5 實作。 |
| B13d index.html 沒有 CSP | medium | defer | AD-24 的 CSP 由 Story 1.5 實作。 |
| B14 Never「掃描」Demo 與 AC「比對」矛盾 | low | reject | 修正方式是改 spec 措辭，依規則駁回；實作只對 Demo 資料夾做唯讀 metadata 比對。 |
| B15 rsync 遇衝突不會停下 | false | reject | baseline 根目錄只有 `.claude`、`README.md`、`_bmad`、`_bmad-output`，模板產物沒有任何同名路徑，不可能衝突。 |
| B16 Structural Seed 子目錄沒建 | false | reject | spec 的任務只要求頂層目錄；子目錄由第一個用到它的 story 建立。 |
| B17a README 還寫沒有程式碼 | low | defer | frozen 的 Never 禁止覆蓋 README；開發入口說明另開後續工作。 |
| B17b `.gitignore` 沒有 `.DS_Store` | low | patch | repo 根目錄已有 `.DS_Store`，別台 macOS clone 後容易誤提交；加一行即可。 |
| B17c 宣告 MIT 卻沒有 LICENSE 檔 | low | defer | LICENSE 需要著作權人名稱，屬使用者決定；列為後續工作。 |
| E1 Squirrel 啟動事件時仍會建視窗 | low | defer | 模板原樣；Windows 安裝流程與 main 改寫在 Story 1.5。 |
| E2 打包版開 DevTools | medium | patch | 與 B13a 同一根因。 |
| E3 loadURL／loadFile 失敗沒有處理 | low | defer | 模板原樣；Story 1.5 改寫視窗載入並加錯誤處理與運行紀錄。 |
| E4 preload 檔名寫死 | low | defer | 與 VG2 同一根因。 |
| E5 沒有單一實例鎖 | medium | defer | NFR10 由 Story 1.5 實作。 |
| E6 沒有擋 window.open 與外部導覽 | medium | defer | AD-24 由 Story 1.5 實作。 |
| E7 renderer 沒有 CSP | medium | defer | 與 B13d 同一根因。 |
| E8 在 Forge 外載入 renderer 設定會出錯 | false | reject | 沒有任何程式在 Forge 外載入 `vite.renderer.config.mts`；Vitest 會用自己的設定檔。 |
| E9 renderer 名稱含 `..` 時 emptyOutDir 會刪錯目錄 | false | reject | 名稱寫死在 `forge.config.mts` 為 `main_window`，沒有外部輸入。 |
| E10 envDir／publicDir 位置 | low | reject | 與 B11b 同理。 |
| E11 launch.json 埠號沒鎖定 | low | reject | `.claude/launch.json` 屬於 Claude 桌面 app 的本機設定，不在本 story 交付範圍（frozen Never 禁止動 `.claude/`）。 |
| E12 engines 只出警告 | false | reject | 使用者已決定 engines 寫 24.22.2、升級前只出警告。 |
| E13 lint 不擋警告 | medium | patch | 與 VG3 同一根因。 |
| E14 新增根目錄 .mts 不會被 oxlint 掃到 | low | defer | 與 B7 同一根因。 |
| E15 sprint-status 應為 review | false | reject | 與 B1 同理，由 step-05 處理。 |
| E16 `.claude/` 比對因 launch.json 不一致 | low | patch | 與 VG4 同一根因；launch.json 不是本 story 建立的，排除後 `.claude/` 的追蹤內容與 baseline 一致。 |

## Verification

**Commands:**
- `npm run typecheck` -- expected: 無錯誤
- `npm run lint` -- expected: 無錯誤
- `node -e "console.log(require('electron/package.json').version)"` -- expected: `45.2.1`
- `npm ls ses` -- expected: `ses@2.3.0`
- `npm start` -- expected: 模板視窗開出，確認後立刻關閉
