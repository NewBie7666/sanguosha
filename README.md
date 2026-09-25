# 三国杀

基于 Web 的三国杀多人在线卡牌游戏。

## 技术栈

- **前端:** React 19 + TypeScript + Vite 8
- **后端:** Hono + WebSocket
- **样式:** Linaria CSS-in-JS
- **测试:** Vitest + Playwright
- **包管理:** pnpm

## 快速开始

```bash
pnpm install
pnpm dev          # 启动开发服务器 (http://localhost:3930)
```

## 命令

```bash
pnpm dev          # 开发服务器（前端 + API + WebSocket 共享端口）
pnpm build        # 构建生产版本
pnpm test         # 运行所有测试
pnpm test:watch   # 监听模式运行测试
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint 检查
pnpm format       # Prettier 格式化
pnpm server       # 独立运行后端服务器
```

## 游戏功能

- **165 名武将**：标准版 76 名 + 界限突破 89 名，覆盖魏蜀吴群四势力
- **基本牌**：杀、闪、桃、酒（军争篇）
- **锦囊牌**：过河拆桥、顺手牵羊、无中生有、决斗、万箭齐发、南蛮入侵、桃园结义、五谷丰登、乐不思蜀、兵粮寸断、闪电、无懈可击、铁索连环、火攻、借刀杀人（标准版 + 军争篇）
- **装备牌**：11 种武器、4 种防具、7 种马（标准版 + 军争篇）
- **身份局**：主公/忠臣/反贼/内奸
- 游戏日志与重放
- 多人联机（WebSocket）

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3930` | 服务器端口 |
| `HOST` | `true` | 绑定地址（`true` = 所有网卡） |

## AI agent 接入

让 AI agent（Claude Code / Cursor / Codex / Windsurf 等）通过 MCP server 接管三国杀对局。

### Claude Code（plugin 一键安装）

```
/plugin marketplace add wmzy/sanguosha
/plugin install sanguosha-play@sanguosha
```

Plugin 包 `sanguosha-agent-plugin` 自包含玩家向 skill + sanguosha MCP server，一次安装全到位。安装后直接对 Claude 说「开一局三国杀」即可。

### 其他 agent（Cursor / Codex / Windsurf）

这些 agent 不支持 Claude Code plugin，需单独配置 MCP server：

1. 从 npm 安装 MCP server：`npm i -g sanguosha-agent-plugin`（同一包，plugin 内容对它们无影响）
2. 配置 stdio 命令指向包内 MCP：

```json
{
  "mcpServers": {
    "sanguosha": {
      "command": "node",
      "args": ["<全局 node_modules>/sanguosha-agent-plugin/mcp/sanguosha-mcp.mjs"],
      "env": { "SGS_SERVER_URL": "wss://<服务器>/ws" }
    }
  }
}
```

- **Cursor** — 写入 `~/.cursor/mcp.json`
- **Windsurf** — 写入 `~/.codeium/windsurf/mcp_config.json`
- **Codex** — 按其 MCP 配置文件写入

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SGS_SERVER_URL` | build 时注入值 | 游戏服务器 WS 地址（注意 `/ws` 路径） |
| `SGS_ROOM_ID` | 自动建房 | 加入指定房间 |
| `SGS_SEAT` | `0` | 座次下标 |
| `SGS_PLAYER_COUNT` | `2` | 建房人数 |

### 本仓库开发

本仓库自身开发用源码直跑（`pnpm mcp:serve`，连 `ws://localhost:3930/ws`），配置见仓库根 `.mcp.json`。发布 plugin npm 包用 `pnpm build:plugin` 打包 skill + MCP 为单文件。


## Live Sanguosha advisor development

The experimental live advisor is kept under `scripts/live-advisor*.mjs`.

Run its focused regression suite with:

```bash
pnpm test:live-advisor
```

The suite covers decision fingerprinting, stale-answer protection, transient vision instability, cancellation telemetry, and model timeout handling.

The live skill panel reads `self_general` and `visible_skills` from VisionBox. The version-specific
catalog in `scripts/live-skill-catalog.mjs` currently covers Liu Chen, Zhang Song, and standard Wolong Zhuge
using the official mobile character pages and official skill rules. It can show skill timing even when buttons are hidden;
unknown skills remain unfilled until their mobile rules are verified. The `/health` endpoint also
reports whether the configured local model is available and the advisor's Git revision.

The live advisor also has a small visible-state fast policy. High-confidence discard, flash, and rescue prompts can
receive a deterministic suggestion without waiting for the local model. Discard scoring only uses cards visible in the
current OCR result and keeps 桃, 闪, and 无懈可击 ahead of ordinary cards; rescue is immediate only when the dying
player is reliably identified as self or an ally; flash is immediate only at one health. Unreadable cards, unknown
card names, uncertain roles, or close keep-value scores abstain and continue through the model or verification path.
Fast results include `policy_ms`; model results include the fast-policy timing and reason for observability. The
policy is an original implementation and does not copy code from GPL game AI projects.
