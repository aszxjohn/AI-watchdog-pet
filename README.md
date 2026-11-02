# AI Watchdog Pet

把 AI coding session 的狀態變成桌面寵物：每個 Claude Code session 一隻，依狀態（等你回覆、思考中、工作中、要你批准……）做不同動作，不用切視窗就知道哪個 session 在等你。

## 現況

| 分支 | 內容 |
|---|---|
| `main` | 重新開始，用 BMAD-METHOD 從需求規劃做起。目前只有 BMAD 與這份 README，還沒有程式碼。 |
| `Demo` | 舊版（macOS／Swift，SD 鋼彈力天使），保留作參考。 |

## 開發方式：BMAD-METHOD

已安裝 [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) v6.12.4，模組 `core`、`bmm`，工具 Claude Code。在專案資料夾開 Claude Code，不確定下一步時叫 `bmad-help`。

| 階段 | Skill | 產出 |
|---|---|---|
| 構想 | `bmad-brainstorming`、`bmad-product-brief` | 產品簡述 |
| 規劃 | `bmad-prd` → `bmad-ux`（有介面時建議做） | PRD、UX 設計 |
| 架構 | `bmad-architecture` | 架構決策 |
| 拆單 | `bmad-create-epics-and-stories` → `bmad-sprint-planning` | Epic／Story、Sprint 狀態檔 |
| 實作 | `bmad-build`（內含審查）→ `bmad-code-review`（選用） | 程式碼 |
| 收尾 | `bmad-retrospective`（選用） | 回顧 |

### 目錄

| 路徑 | 內容 |
|---|---|
| `_bmad/` | BMAD 核心與設定。`config.toml`、`config.user.toml` 由安裝器產生，重裝會被覆蓋；要固定設定請改 `_bmad/custom/` |
| `.claude/skills/` | BMAD 的 skill（29 個） |
| `_bmad-output/` | 規劃文件（`planning-artifacts/`）與實作紀錄（`implementation-artifacts/`） |
| `docs/` | 長期專案知識（BMAD 預設位置） |

### 更新 BMAD

在專案根目錄重跑安裝器，會沿用上次的選項：

```bash
npx bmad-method install
```

## 不在 repo 裡的東西

`assets/`、`backups/`、`build/`、`characters/`、`locks/`、`preview/`、`shelved/` 是舊版的本機資料，用 `.git/info/exclude` 排除，不會上傳。遊戲素材版權屬原遊戲公司，不隨 repo 散布。
