---
review: tech-currency
target: ARCHITECTURE-SPINE.md（AI Watchdog Pet 舞台，2026-11-02 draft）
reviewer: 獨立審查（技術時效性／實查）
date: 2026-11-03
method: npm registry 實查（npm view，含發佈時間、engines、peer）、官方文件與 release notes（Electron v45.2.1 tag 文件、Forge v8.0.1 tag 原始碼、TypeScript／SES／Claude Code 官方文件）、本機唯讀檢查（~/.claude/sessions 只看鍵名與型別）
---

# 技術時效性審查 — AI Watchdog Pet 舞台 spine

## 結論

**不能照現稿進實作。** Stack 的 10 個版本號全部正確，而且都是 2026-11-03 的 npm latest。但有 1 個 critical：AD-7 寫的 CSP 會讓 SES 根本跑不起來。另有 2 個 high：AD-4 依賴未公開的檔案，但官方其實有支援的介面；TypeScript 7.0.2 跟 Forge 8 模板預設的 `^6.0.0` 不一致。這三項都是「憑印象寫、沒對照現行文件」造成的，改法都很明確。

> 本審查只做文件查證與程式碼／套件中繼資料的靜態比對，**沒有執行任何原型**（沒有建 Electron 專案，也沒有實測 SES／iframe／Worker）。下文的「已確認」指文件或 registry 上已確認，不代表實際跑過。

## 嚴重度總覽

| # | 嚴重度 | 位置 | 一句話 |
| --- | --- | --- | --- |
| F1 | critical | AD-7 第 1、3 點 | CSP `script-src blob:` 會由 blob Worker 繼承，沒有 `'unsafe-eval'`，SES `lockdown()`／`Compartment.evaluate` 就會失敗；iframe 自己的 bootstrap script 也會被擋 |
| F2 | high | AD-4 | `~/.claude/sessions/<pid>.json` 沒有公開文件；Claude Code 官方文件已把 `claude agents --json` 列為「從外部讀 session 狀態的支援方式」 |
| F3 | high | Stack：TypeScript 7.0.2 | Forge 8 模板預設 `typescript ^6.0.0`；TS 7.0 不提供 JS API，typescript-eslint 不支援；`strict` 預設改為 true |
| F4 | medium | Stack：Forge 兩列；memlog L66 | Forge 8 已沒有 `vite-typescript` 模板，plugin-vite 也不再是 experimental；模板還有其他預設值改變（ESM-only、`.cjs` 產物、oxlint） |
| F5 | medium | AD-7 第 4 點、AD-14 | 模板 dev 用 `http://localhost` 開發伺服器、prod 用 `loadFile`（file://）；spine 的 webRequest 只放行 `app://`、`pack://`，開發期會被擋，`app://` 也還沒有實作方案 |
| F6 | medium | AD-9、AD-7（缺 overlay/panel CSP） | PixiJS v8 在禁 eval 的 CSP 下初始化會丟錯，要先 import `pixi.js/unsafe-eval`；zod 4 也要設定 jitless |
| F7 | medium | AD-7 能力清單、Deferred「凍結 Date」 | SES 2.x 的 compartment 預設已停用 `Date.now`／`new Date()`／`Math.random`，也不提供 `Float*Array`。Deferred 那列已經過時，舞台 API 要補亂數 |
| F8 | low | Stack：chokidar 6.0.0 | 2026-10-19 才發佈的 x.0.0，ESM-only，要求 Node ≥ 22.22 |
| F9 | low | Stack：Electron 45.2.1、AD-7 第 4 點 | Electron 45 發佈不到兩週；有影響 sandboxed preload 與 subframe Worker 的 breaking change；最低 OS 版本提高 |
| F10 | low | AD-7 第 4 點 | `senderFrame` 可能是 `null`；對照 Electron 45 security checklist，少了 #5 權限處理與 #13 導航限制 |
| F11 | low | AD-14、Deferred Linux | API 都存在且行為符合；`type:'panel'` 已涵蓋所有桌面空間；PR #55084 仍未合併；`setShape` 可當過渡方案 |
| F12 | low | Stack 完整性 | 少了 `@vitejs/plugin-react`（或改用 Oxc JSX 的決定）以及 AD-13 要用的 zip 讀寫函式庫 |

## 每個決策的查證狀態

| 決策 | 是否含外部技術主張 | memlog 有無查證 | 本次結果 |
| --- | --- | --- | --- |
| AD-1、2、3、5、6、8、10、11、12、15 | 否（純設計規則） | — | 不在本審查範圍 |
| AD-4 | 是（Claude Code 狀態檔） | 有（L52、L53） | 部分：檔案存在，鍵名也符合；但漏掉官方支援的 `claude agents --json`（F2） |
| AD-7 | 是（iframe／CSP／Worker／SES／Electron API） | 部分（L50、L51、L61 自己標「需原型驗證」） | CSP 寫法跟 SES 的需求衝突（F1）；Electron API 都存在（F10） |
| AD-9 | 是（PixiJS、WebGL） | 只查了版本（L49） | CSP 相容性沒查（F6） |
| AD-13 | 是（zip 解壓） | 無 | 沒有指定函式庫（F12） |
| AD-14 | 是（Electron 視窗 API） | 有（L48、L51） | 已確認（F11 只是補充） |
| Stack 版本 | 是 | 有（L62，npm 2026-11-02） | 版本都正確；相容性沒查（F3、F4） |
| Deferred「凍結 Date」 | 是（SES 能力） | 無（L37 是推測） | 已過時（F7） |

## Stack 實查（2026-11-03）

| 套件 | spine 版本 | npm latest | 發佈日 | engines／peer 重點 | 判定 |
| --- | --- | --- | --- | --- | --- |
| electron | 45.2.1 | 45.2.1 | 2026-10-30 | Chromium 156.0.8078.75、Node 24.22.1（releases.json 確認）；45.0.0 發佈於 2026-10-21 | 正確，但很新（F9） |
| @electron-forge/cli | 8.0.1 | 8.0.1 | 2026-09-29 | release notes 寫 Node ≥ 22.17（package engines 寫 ≥ 22.13.0），ESM-only | 正確；模板描述過時（F4） |
| @electron-forge/plugin-vite | 8.0.1 | 8.0.1 | 2026-09-29 | 沒有宣告 vite peer（devDep `vite ^8.0.0`）；release notes：「targets Vite 8」、已不是 experimental | 正確；「experimental」標註過時（F4） |
| vite | 8.3.5 | 8.3.5 | 2026-10-21 | Node `^20.19 \|\| >=22.12` | 正確，符合 Forge 8 的目標版本 |
| typescript | 7.0.2 | 7.0.2（另有 7.1.0-beta） | 2026-07-08 | `exports["."]` 只有 `lib/version.cjs`，沒有 compiler API | 版本正確，但跟模板不一致（F3） |
| react／react-dom | 19.3.1 | 19.3.1 | 2026-10-14 | — | 正確 |
| pixi.js | 8.22.0 | 8.22.0 | 2026-10-01 | exports 有 `./unsafe-eval`、`./webworker` | 正確；CSP 的部分見 F6 |
| ses | 2.3.0 | 2.3.0 | 2026-08-13 | — | 正確；compartment 預設見 F7 |
| zod | 4.6.7 | 4.6.7 | 2026-10-12 | — | 正確；CSP 的部分見 F6 |
| chokidar | 6.0.0 | 6.0.0 | 2026-10-19 | `type: module`、Node ≥ 22.22 | 正確，但很新（F8） |

## Findings

### F1 — critical — AD-7 的 CSP 會讓 SES 跑不起來，bootstrap 也載不進來

**位置：** AD-7 第 1 點（`default-src 'none'; script-src blob:; worker-src blob:; connect-src 'none'`）與第 3 點（SES `lockdown()` + `Compartment`）。

**問題（機制）：**
1. 從 `blob:` URL 建立的 Worker 會**繼承**建立者文件的 CSP（MDN 明文寫了這個例外）。所以 Worker 裡的 `script-src` 只有 `blob:`，沒有 `'unsafe-eval'`，`eval`／`new Function` 都會丟 EvalError。
2. SES 預設 `evalTaming: 'safe-eval'` 是用 **direct eval 加上多層 `with`** 組出隔離的 evaluator。SES 文件說只有 `'unsafe-eval'` 和 `'no-eval'` 能在「沒有 direct eval」的環境初始化，也就是說預設模式在這個 CSP 下 `lockdown()` 本身就會失敗。
3. 改成 `'no-eval'` 也沒用：這個模式會把所有 evaluator 換成直接丟例外，`Compartment.evaluate()` 就沒辦法跑包程式。SES README 也寫明，不用 eval 的 `__syncModuleFunctor__` 要由「ModuleSource 的作者自己負責沙盒」，也就是沒有隔離效果。結論：**只要用 SES 隔離任意程式碼，該 realm 的 CSP 就必須允許 `'unsafe-eval'`。**
4. 另一個問題：iframe 文件由 `pack://` 提供，它自己需要一段 bootstrap script 去建 Worker。但 `script-src` 只允許 `blob:`，外部 `pack://…/bootstrap.js` 跟 inline script 都會被擋，連 Worker 都建不起來。iframe 是 opaque origin，依賴 `'self'` 的比對結果也不可靠。

**修正：**
- 把 AD-7 第 1 點改成像這樣：`default-src 'none'; script-src 'sha256-<bootstrap 的雜湊>' 'unsafe-eval'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'`。bootstrap 改成 inline 加 hash（或明確寫 `pack://<固定 host>/bootstrap.js`，不要用 `'self'`）。
- 在 AD-7 寫明：「`'unsafe-eval'` 是 SES 的必要條件；隔離靠 SES Compartment，不靠 CSP 禁 eval。網路封鎖仍由 `connect-src 'none'` 加 webRequest 負責。」
- 第 3 點的移除清單是縱深防禦。真正的關卡是 compartment 只拿得到注入的舞台 API（Compartment 的 globalThis 本來就沒有 fetch 這類 host API）。
- Deferred 裡的「沙盒分層實測」要加三個必測項目：(a) iframe 內 blob Worker 能否建立；(b) Worker 內 `lockdown()` 能否成功、`compartment.evaluate` 能否執行；(c) Worker 內 `fetch`／`WebSocket`／`EventSource` 是否被 `connect-src 'none'` 擋下。

**先例（可行性佐證）：** Chromium 允許 sandboxed iframe 裡的 `blob:null/…` 建立 Worker（WebKit bug 170075 的討論指出 Chrome／Firefox 把它當成 trustworthy；WebKit 也在 2021 年修好）。MetaMask Snaps 也採用 `sandbox="allow-scripts"` iframe 加 SES lockdown 的架構。所以方向可行，只是 CSP 要改。

**來源：**
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy
- https://github.com/endojs/endo/blob/master/docs/lockdown.md （`evalTaming` 段落）
- https://github.com/endojs/endo/blob/master/packages/ses/README.md （`__syncModuleFunctor__` 段落）
- https://bugs.webkit.org/show_bug.cgi?id=170075
- https://osec.io/blog/metamask-snaps

### F2 — high — AD-4 依賴未公開的檔案，但官方已有支援的介面

**位置：** AD-4「來源只有各工具的紀錄檔，以及 Claude Code 的即時狀態檔 `~/.claude/sessions/<pid>.json`」。memlog L52 的研究結論也一樣。

**問題：**
- Claude Code 官方文件（agent view）寫明 `claude agents --json` 是「the supported way to read session state from outside Claude Code」。它會輸出所有 live session（`kind` 可以是 `interactive`）以及 `pid`、`status`（`busy`／`waiting`／`idle`）、`waitingFor`（`permission prompt`、`input needed`、`sandbox request`、`worker request`、`dialog open`）。這正好是 AD-4 想從 `<pid>.json` 拿的資料，memlog 的研究漏掉了。
- 官方文件沒有提到 `~/.claude/sessions`。同一頁還警告 `~/.claude/jobs/` 底下的檔案「are not a stable interface」，可以推斷 `sessions/` 也屬於內部格式，隨時可能改。
- 本機唯讀檢查（Claude Code 2.1.308，4 個檔案，只看鍵名和型別）：
  - 鍵：`cwd, entrypoint, hostSessionId, kind, messagingSocketPath, name, nameSince, nameSource(部分檔案才有), peerFeatures[], peerProtocol, pid, pidDomain, procStart, sessionId, startedAt, status, statusUpdatedAt, updatedAt, version`。
  - 4 個檔案的 `status` 都是 `idle|busy|waiting` 其中之一，檔名的 pid 跟 `pid` 欄位一致，對應的 process 都還活著。
  - **4 個檔案都沒有 `waitingFor` 鍵**（當下沒有 session 在等批准，推測只在 waiting 時才寫入）。所以「看得到批准」這件事本機**沒有驗證到**。
  - 同一個資料夾還有 `<pid>.<hash>.key`（權限 0600）和 `messagingSocketPath`，這是跨 session 訊息功能用的憑證與 socket。AD-4 雖然規定唯讀，但沒有排除「讀這些檔」或「連這個 socket」。
- 文件記載的跟本機看到的都顯示這個格式還在快速演進（`peerProtocol`、`peerFeatures`、`nameSource` 是部分檔案才有的欄位）。

**修正（建議 A）：**
- A（建議）：AD-4 改成「Claude Code 以官方 `claude agents --json` 為準。`~/.claude/sessions/*.json` 只當低延遲的變更觸發：檔案變動時重新讀 `--json`，或在格式驗證通過時暫時採用」。
- B：保留 `<pid>.json` 當主要來源，但同時規定：只讀符合 `^\d+\.json$` 的檔案；**禁止讀 `*.key`、禁止連 `messagingSocketPath`**；zod 用 `.passthrough()`；用 `version` 欄位做版本閘門；用 `procStart` 加上 process 是否存在來排除殘留檔和 pid 重用；驗證失敗就降級成只看 transcript，並標 `inferred`。
- 不論選哪個，A 和 B 的安全規則（不讀 `.key`、不連 socket）都要寫進 AD-4。用 A 的話，要在原型階段確認 `claude agents --json` 是否會寫入任何設定，或在未信任目錄跳出信任對話框（文件寫 v2.1.225 起 `claude agents` 在未信任目錄會詢問；v2.1.295 起結束時不會自己啟動 supervisor），才符合 AD-4「完全唯讀」。另外每次呼叫都要 spawn CLI，輪詢頻率要定上限。

**來源：**
- https://code.claude.com/docs/en/agent-view.md （`claude agents --json` 欄位表、version history）
- https://code.claude.com/docs/en/cli-reference （`claude agents` 一列：「`--json` to print active sessions as a JSON array for scripting」）

### F3 — high — TypeScript 7.0.2 跟 Forge 8 模板不一致，工具鏈相容性沒查

**位置：** Stack「TypeScript（建專案時依模板相容性確認）7.0.2」。

**問題：**
- Forge v8.0.1 的 vite 模板 `tmpl/package.json` 寫的是 `"typescript": "^6.0.0"`。照官方方式建專案會拿到 6.0.3，跟 spine 寫的 7.0.2 不同。這個不需要等建專案才知道，現在就能確認。
- TypeScript 7.0（2026-07-08）官方公告：「does not ship with an API」，要到 7.1 才會有新的、而且不相容的 API。npm 上 typescript@7.0.2 的 `exports["."]` 只指向 `lib/version.cjs`，其餘都在 `./unstable/*`。
- typescript-eslint 8.72.1（目前 latest）的 peer 是 `typescript >=4.8.4 <6.1.0`，明確不支援 7。其他會 `import 'typescript'` 去用 compiler API 的工具（例如 vite-plugin-checker 的 typescript 模式）也要實測。
- TS 7.0 的預設值改了：`strict` 預設 true；不再支援 `baseUrl`、`moduleResolution: node10`、`target: es5`；`esModuleInterop` 不能設 false。模板的 tsconfig（`module: preserve`、`moduleResolution: bundler`、`esModuleInterop: true`）沒有用到被移除的選項，但沒寫 `strict`，所以 6 和 7 的型別檢查結果會不同。
- 有利的一面：Forge 8 模板改用 oxlint／oxfmt（不依賴 TS API），Vite 8 只做轉譯、不做型別檢查（用 Oxc），唯一的型別檢查是 `npm run typecheck` 也就是 `tsc --noEmit`。所以 TS 7 **可以**用，只是要明確決定。

**修正（建議 A）：**
- A（建議）：Stack 改成 `typescript 6.0.3`（模板預設，生態相容性最好），tsconfig 明確寫 `"strict": true`。等 TS 7.1 API 穩定、typescript-eslint 支援之後再升級。
- B：保留 7.0.2，同時加 `@typescript/typescript6`（npm 6.0.2，提供 `tsc6`），給需要 API 的工具用 npm alias；規定不用 typescript-eslint，只用 oxlint。
- 拿掉「建專案時依模板相容性確認」這句，改寫成已決定的結果。

**來源：**
- https://github.com/electron/forge/blob/v8.0.1/packages/template/vite/tmpl/package.json
- https://github.com/electron/forge/blob/v8.0.1/packages/template/vite/tmpl/tsconfig.json
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://www.npmjs.com/package/typescript-eslint （npm view：peerDependencies `typescript >=4.8.4 <6.1.0`）

### F4 — medium — Forge 8 的「vite-typescript 模板」與「experimental」都是舊資訊

**位置：** Stack「Electron Forge（vite-typescript 模板）」、「@electron-forge/plugin-vite（官方標 experimental）」；memlog L62、L66。

**問題：**
- `@electron-forge/template-vite-typescript` 沒有 8.x 正式版（npm latest 是 7.11.2，最後一版是 8.0.0-alpha.10）。Forge 8 release notes：「`create-electron-app --template vite --typescript` replaces the separate `*-typescript` templates」。`create-electron-app@8.0.1` 依賴的是 `@electron-forge/template-vite`。
- Forge 8 release notes：「`@electron-forge/plugin-vite` is no longer experimental and is covered by semver」。memlog 依據的是官網 templates 頁（還寫 v7.5.0 起 experimental），那頁已過時。（同一份 changelog 裡也有一條 alpha 時期的「mark vite as experimental in bundler chooser」，建議以 release 正文為準。）
- 模板的其他現行預設值 spine 沒有記錄，但會影響實作：
  - 所有 `@electron-forge/*` 都是 ESM-only；Node ≥ 22.17（release notes；package engines 寫 ≥ 22.13.0，取較嚴的）。
  - main／preload 產物是 `.cjs`（`"main": ".vite/build/main.cjs"`，preload 從 `preload.cjs` 載入）。
  - 設定檔是 `forge.config.mts`，Vite 設定是 `.mts`；lint 用 oxlint 加 oxfmt；腳本有 `typecheck: tsc --noEmit`。
  - 模板預設啟用 FusesPlugin（`RunAsNode: false`、`OnlyLoadAppFromAsar: true`、`EnableEmbeddedAsarIntegrityValidation: true`）。makers 是 Squirrel、ZIP（darwin）、Rpm、Deb。
  - Forge 8.0.1 的測試版本是 Electron 44.4.3（「upgrade Electron to 44.4.3」），Electron 45.0.0 到 2026-10-21 才發佈。

**修正：**
- Stack 那兩列改成「Electron Forge 8.0.1（`npx create-electron-app@latest <app> --template vite --typescript --electron-version 45.2.1`）」和「@electron-forge/plugin-vite 8.0.1（Forge 8 起不再是 experimental，受 semver 保護）」。
- 在 Structural Seed 或 Stack 下面加一段「Starter 現行預設」，列出上面幾點（ESM-only、`.cjs` 產物、oxlint、Fuses）。
- memlog L66 的「升級前看 release notes」可以保留，但改成「依 semver」。

**來源：**
- https://github.com/electron/forge/releases/tag/v8.0.1
- https://github.com/electron/forge/tree/v8.0.1/packages/template/vite/tmpl
- https://www.electronforge.io/templates/vite-+-typescript （舊資訊的出處）

### F5 — medium — webRequest／`app://` 規則跟模板的 dev／prod 載入方式衝突

**位置：** AD-7 第 4 點「`webRequest` 只放行 `app://`、`pack://`」；Structural Seed 沒有 `app://` 的實作方式。

**問題：**
- Forge 8 模板的 `main.ts`：dev 時 `loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)`（`http://localhost:<port>` 加 HMR websocket），prod 時 `loadFile(...)`（`file://`）。照 spine 的規則，開發期整個 renderer 會被擋；production 的 `file://` 也不在白名單裡。
- `app://` 要自己實作：先在 ready 前呼叫 `protocol.registerSchemesAsPrivileged`（只能呼叫一次），再用 `protocol.handle`。Electron 45 的文件另外有 `protocol.registerSource`（Experimental，直接從目錄提供檔案，不經過 main thread）。文件寫明 webRequest 會套用到這類自訂 scheme 的請求。Electron security checklist #18 也建議用自訂 protocol 取代 `file://`，方向正確，只是 spine 沒寫要怎麼接上模板。
- Vite dev 模式會注入 inline script（例如 React refresh 的 preamble）。如果 overlay／panel 的 CSP 在 dev 時也很嚴格，會被擋。

**修正：**
- AD-7 第 4 點補上：「`!app.isPackaged` 時額外放行 `http://localhost:<vite port>` 與 `ws://localhost:<vite port>`；打包後 renderer 一律由 `app://` 提供（`registerSchemesAsPrivileged` 給 `app` 設 `standard`、`secure`），不用 `file://`」。
- `pack` scheme **不要**給 `bypassCSP`、`supportFetchAPI`、`corsEnabled`。
- dev 的 CSP 用 Vite `html.cspNonce`，或只在 dev 放寬。

**來源：**
- https://github.com/electron/forge/blob/v8.0.1/packages/template/vite/tmpl/main.ts
- https://github.com/electron/electron/blob/v45.2.1/docs/api/protocol.md
- https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/security.md （#18）

### F6 — medium — PixiJS 8 與 zod 4 在禁 eval 的 CSP 下需要額外設定

**位置：** AD-9（單一 PixiJS WebGL 畫布）；AD-7 只定義了 iframe 的 CSP，沒有 overlay／panel 的 CSP。

**問題：**
- PixiJS 只在 overlay renderer 執行，不在包的沙盒裡。Electron 的 `sandbox: true` 只影響 Node，不影響 WebGL，這部分沒問題。
- 但 PixiJS v8 的 shader／uniform／UBO sync 是在執行期用 `new Function` 產生程式碼。overlay 如果照 Electron security checklist #7 設了不含 `'unsafe-eval'` 的 CSP，renderer 初始化時會丟錯。官方解法是在任何 Pixi import 之前先 `import 'pixi.js/unsafe-eval'`（名稱容易誤會，作用其實是換成不需要 eval 的實作）。8.22.0 的 exports 裡確認有 `./unsafe-eval`。
- zod 4 的 object parser 也會用 `new Function` 產生快速路徑，在嚴格 CSP 下會觸發 CSP violation 再退回慢速路徑。用 `z.config({ jitless: true })`，而且要在任何 schema 建立之前執行（放在最先 import 的 side-effect 模組）。
- AD-9 寫「WebGL」，但 Pixi v8 也支援 WebGPU，應該明確指定。

**修正：**
- AD-7 或 Consistency Conventions 加一列「renderer CSP」：overlay／panels 用 `script-src 'self'`（或 `app:`），不加 `'unsafe-eval'`。overlay 入口第一行 `import 'pixi.js/unsafe-eval'`；`src/shared` 的第一個 side-effect 模組設定 `z.config({ jitless: true })`。
- `Application.init({ preference: 'webgl', backgroundAlpha: 0 })`。
- 進階模式（OffscreenCanvas）建議限定 `2d` context，避免包在 Worker 裡開 WebGL context，又回到 AD-9 想避開的 context 上限問題。

**來源：**
- https://github.com/pixijs/pixijs/issues/7324
- npm `pixi.js@8.22.0` exports（`./unsafe-eval`）
- https://github.com/modelcontextprotocol/ext-apps/pull/618 （zod 4 jitless 與 CSP）
- https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/security.md （#7）

### F7 — medium — SES 2.x 的 compartment 預設跟 spine 的假設不一樣

**位置：** AD-7 的能力清單（「舞台給的相對時鐘…其餘一律沒有」）；Deferred「是否連 JS 內建 `Date` 都凍結 — SES 可做，成本與必要性實作時再評估」。

**問題：**
- SES 文件：`mathTaming`、`dateTaming` 已棄用；「`Math.random`, `Date.now`, and the `new Date()` are disabled within compartments」，需要的話要透過 endowment 注入。所以 Deferred 那一列的前提已經不成立：compartment 裡**本來就**沒有牆上時間，不需要另外評估。
- 但這也表示 **`Math.random` 不能用**。粒子、遊走這類演出幾乎一定要亂數，舞台 API 必須提供（例如每包一個 seeded PRNG）。
- SES 2.0.0（2026-04）為了堵 NaN side-channel，不再把 `Float32Array`／`Float64Array` 等放進 compartment 的預設全域。包要做粒子或矩陣運算的話，要明確決定給不給。
- 2.2.0 開放「safe shared Temporal」，2.3.0 開放 `TextEncoder`／`TextDecoder`。
- SES 2.3.0（2026-08-13）比 Chromium 156（Electron 45）早。新的 V8 intrinsic 可能在 lockdown 時被移除或觸發警告，偶爾會讓 lockdown 失敗。

**修正：**
- 刪掉 Deferred「是否連 Date 都凍結」這列，改寫進 AD-7：「compartment 沒有 `Date.now`／`new Date()`／`Math.random`（SES 預設）；舞台 API 提供相對時鐘與 seeded PRNG；`Float32Array` 是否注入要明確列出」。
- 原型階段把「Electron 45.2.1 的 Worker 裡 `lockdown()` 沒有錯誤也沒有警告」列為必測項目，並鎖定 SES 的確切版本。

**來源：**
- https://github.com/endojs/endo/blob/master/docs/lockdown.md （Options 段落）
- https://github.com/endojs/endo/blob/master/packages/ses/CHANGELOG.md （2.0.0、2.2.0、2.3.0）

### F8 — low — chokidar 6.0.0 是剛發佈的 x.0.0

**位置：** Stack「chokidar 6.0.0」。

**問題：** 2026-10-19 發佈（審查時才 15 天），`type: module`（ESM-only），engines Node ≥ 22.22。Forge 8 會把 main 打包成 CJS：Vite／Rolldown 會把 ESM 依賴打包進去，沒問題。Electron 45 內建 Node 24.22.1，也符合 ≥ 22.22。memlog 只記了版本號，沒查這些條件，也沒查 5→6 的變更。

**修正：** 二選一，建議 A。A：鎖 `chokidar 5.0.0`（2025-11 發佈，比較成熟），等 6.x 出 patch 版再升。B：保留 6.0.0，原型時在 macOS 和 Windows 實測監看 `~/.claude/projects/**.jsonl` 的新增與 append。另外也可以評估 Node 24 內建的 `fs.watch({ recursive: true })`，少一個依賴。

**來源：** https://www.npmjs.com/package/chokidar （npm view：time、engines、type）

### F9 — low — Electron 45 很新，有幾個相關的 breaking change

**位置：** Stack「Electron 45.2.1」；AD-7 第 4 點；Structural Seed 的部署說明。

**問題：**
- 45.0.0 在 2026-10-21 發佈，45.2.1 在 2026-10-30 發佈（memlog 寫 10-31，差一天）。
- Electron 45 breaking changes：(1) sandboxed preload 不再提供 `Buffer`、`setImmediate`，`require('events'|'timers'|'url')` 也不能用；`src/shared` 打包進 preload 的程式不能依賴這些。(2) subframe 建立的 Worker 只有在 `nodeIntegrationInSubFrames` 開啟時才會有 Node。這對 AD-7 有利，但 spine 沒寫 `nodeIntegrationInWorker`。
- Electron 44 移除了 macOS 12 支援、Windows ia32 與 Linux armv7l。

**修正：** AD-7 第 4 點補上 `nodeIntegrationInWorker: false`（明確寫出來）；部署那行補上「macOS 13+、Windows x64／arm64」；規定 preload 不用 Node polyfill。

**來源：**
- https://releases.electronjs.org/releases.json
- https://github.com/electron/electron/blob/v45.2.1/docs/breaking-changes.md

### F10 — low — AD-7 的 Electron 層：API 都存在，有兩個缺口

**位置：** AD-7 第 4 點。

**已確認（Electron v45.2.1 文件）：** `webPreferences.sandbox`、`contextIsolation`、`nodeIntegrationInSubFrames`（預設 false，文件標 Experimental option）、`session.webRequest`、`webContents.setWindowOpenHandler`、`IpcMainEvent.senderFrame` 都存在，用法跟 spine 描述的一致。

**問題：**
- `senderFrame` 的型別是 `WebFrameMain | null`：「May be `null` if accessed after the frame has either navigated or been destroyed」。
- 對照 Electron 45 security checklist，spine 沒有提到 #5（`setPermissionRequestHandler`，處理 camera、mic、display-capture 等權限請求）與 #13（`will-navigate`／`will-frame-navigate` 限制導航）。
- `protocol.handle` 的 `request.initiatorOrigin` 是 45 文件記載的欄位，但所有包的 iframe 都是 opaque origin（`null`），沒辦法用它區分是哪一包發的請求。

**修正：** AD-7 第 4 點補上：「`senderFrame` 為 `null` 或 URL 不是 `app://` 頂層框架時一律拒絕；`setPermissionRequestHandler` 一律拒絕；`will-frame-navigate` 只允許 `app://` 與 `pack://`」。

**來源：**
- https://github.com/electron/electron/blob/v45.2.1/docs/api/structures/ipc-main-event.md
- https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/security.md

### F11 — low — AD-14：API 都存在，行為符合假設；補充三點

**已確認：**
- `win.setIgnoreMouseEvents(ignore, { forward })`：`forward` 只有 macOS 和 Windows 支援。Windows 前景視窗是較高權限的程序時，forward 會暫停（UIPI），memlog L51 已記錄。
- `type: 'panel'`（macOS）：會加上 `NSWindowStyleMaskNonactivatingPanel`，能浮在全螢幕 app 之上，「the window will appear on all spaces」。

**補充：**
1. 既然 `panel` 已經能出現在所有 spaces，macOS 上不需要再呼叫 `setVisibleOnAllWorkspaces`。如果呼叫了，它預設會切換 process type，造成視窗和 dock 短暫閃一下（可以用 `skipTransformProcessType` 避開）；在 Windows 上它不做任何事。
2. Deferred 的 PR #55084（`setInputRegion`）在 2026-11-03 仍是 open 狀態（最後更新 2026-11-01），可以繼續延後。
3. Electron 45 有 `win.setShape(rects)`（Windows、Linux，Experimental），區域外不繪製也不接收滑鼠，可以評估當 Linux X11 的過渡方案。

**來源：**
- https://github.com/electron/electron/blob/v45.2.1/docs/api/base-window.md
- https://github.com/electron/electron/blob/v45.2.1/docs/api/structures/base-window-options.md
- https://github.com/electron/electron/pull/55084

### F12 — low — Stack 少了幾個依賴

**問題：**
- 面板用 React 19，但 Stack 沒有 `@vitejs/plugin-react`（latest 6.2.1，peer `vite ^8.0.0`，相容），也沒有決定改用 Vite 8 內建的 Oxc JSX。
- AD-13 要求擋 `..`、絕對路徑、捷徑檔，並限制總大小與檔案數，但沒有指定 zip 讀寫函式庫。擋捷徑檔需要能讀 external attributes 的函式庫。
- `@types/react` 19.3.0 要跟著加。

**修正：** Stack 補上這幾列。zip 函式庫選定前，先確認它能列出每個 entry 的 attributes、不必先寫到磁碟就能檢查，而且有版本鎖定。

**來源：** npm view `@vitejs/plugin-react`（6.2.1、peer `vite ^8.0.0`）

## 已確認無誤

- 10 個版本號都存在，而且都是 2026-11-03 的 npm `latest`。Electron 45.2.1 確實是 Chromium 156 加 Node 24.22.1。
- Vite 8.3.5 符合 Forge 8 plugin-vite 的目標版本（Vite 8）；`@vitejs/plugin-react` 6.2.1 支援 Vite 8；react-dom 19.3.1 的 peer 是 react `^19.3.1`。
- Electron API：`setIgnoreMouseEvents` 加 `forward`、`type:'panel'`、`setVisibleOnAllWorkspaces`、`session.webRequest`、`setWindowOpenHandler`、`nodeIntegrationInSubFrames`、`senderFrame`、`protocol.handle` 在 v45.2.1 都存在。
- Chromium 允許 sandboxed iframe 從 `blob:` 建立 Worker；SES 加 sandboxed iframe 有生產環境的先例（MetaMask Snaps）。目前沒找到 Chromium 端的已知阻礙，主要阻礙是 F1 的 CSP 寫法。
- Electron PR #55084 確實還沒合併。

## 沒查到或無法查證

- `~/.claude/sessions/<pid>.json` 的 `waitingFor` 欄位：本機當下沒有 session 在等批准，沒看到這個欄位（F2）。
- `claude agents --json` 是否會在未信任目錄要求信任、是否會寫入任何狀態檔：文件沒寫，需要實測（F2）。
- Forge 8.0.1 加 Electron 45 的組合：Forge 是用 Electron 44.4.3 測試的，目前沒找到已知問題，但沒有官方證據。
- SES 2.3.0 在 Chromium 156 的 Worker 裡 `lockdown()` 會不會出現 intrinsic 警告：需要原型實測（F7）。
- 其他 AI 工具的紀錄檔路徑（memlog L53）不在本次範圍。只順便確認了本機 `~/.gemini/tmp/*/chats/` 確實是 `session-*.jsonl`。
