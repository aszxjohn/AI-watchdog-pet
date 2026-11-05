- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: preload 檔名寫錯時沒有任何驗證會發現（VG2、E4）
  evidence: preload 目前為空；Story 1.3 讓 preload 暴露 API 時，加上對 API 存在的斷言。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: oxlint 不展開 glob，新增根目錄 .mts 不會被 lint（B7、E14）
  evidence: Story 1.3 新增 vitest／dependency-cruiser 設定並建 CI 時，一併調整 lint 範圍的維護方式。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: renderer 名稱仍是模板的 main_window（B8）
  evidence: Story 1.5／1.6 建立 panels 與 overlay 兩個 renderer 時決定命名與 `*_VITE_*` 宣告。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: main、preload、renderer 共用一份 tsconfig，型別檢查擋不住跨 process 誤用（B10a）
  evidence: Story 1.3 建 preload API 時決定是否拆分各 process 的 tsconfig。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: 模板 main.ts 尚未符合 AD-24／NFR10：file:// 載入、未明寫 sandbox 等設定、沒有 CSP、沒有單一實例鎖、沒擋 window.open 與外部導覽、Squirrel 事件與載入失敗沒處理（B13b～d、E1、E3、E5～E7）
  evidence: 這些都在 Story 1.5（選單列／面板視窗）的驗收條件內，屆時改寫視窗建立流程。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: README 還寫 main 沒有程式碼，缺開發入口說明（B17a）
  evidence: 本 story 禁止覆蓋 README；另開文件更新：`nvm use`／`npm ci`／`npm start`、lint 範圍、`npm_config_cache` 繞道。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-forge-project-scaffold.md`
  summary: package.json 宣告 MIT 但 repo 沒有 LICENSE 檔（B17c）
  evidence: LICENSE 需要著作權人名稱，由使用者決定後新增。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: preload bundle 名稱與 main 的期待沒有 CI 一致性檢查，CI 也沒有 build 步驟（VG3、B14）
  evidence: Story 1.5 新增 overlay 視窗時集中 bundle 名稱；Story 2.3 建 Playwright `_electron` 端到端測試時在 CI 一併建置並檢查 preload 產物只 require `electron`。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: IPC 只有 invoke，沒有 main→renderer 推送的契約與驗證（B6）
  evidence: Story 1.4 建 StageView 推送時，以 `src/shared` 同一套 schema 加 main 端 send 與 preload 端 subscribe。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: IPC 允許清單不分通道、dev server 來源只認 main_window 且暫放在 register.ts（B7）
  evidence: Story 1.5／1.6 建立 overlay 視窗時，把來源判斷搬到 `main/windows`，並依視窗限制可呼叫的通道。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: preload 以不含 DOM 的 lib 做型別檢查（B18a）
  evidence: preload 開始使用 DOM API 時，為 preload 開獨立 tsconfig（DOM＋Electron 型別）。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: 打包版以 file:// 載入，IPC 一律被拒（E4）
  evidence: Story 1.5 改用 `app://` 後恢復；在那之前打包版面板顯示錯誤是預期行為。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: 第一次 `npm start` 曾出現沒有 renderer 的情況，原因未查明
  evidence: 之後 3 次都正常；再發生時保留當下的主程式輸出再追查。
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-shared-contracts-ipc-ci.md`
  summary: CI 尚未實際執行
  evidence: 使用者推上 GitHub 後確認 macOS 與 Windows 兩個 job 都通過。
