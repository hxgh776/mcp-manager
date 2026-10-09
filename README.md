# MCP Manager

面向开发者个人电脑的 **MCP 控制平面**：MCP Server 配置一次，多个 AI Coding Agent（Claude Code、Codex、Cursor、Trae、OpenCode）一键启用；可选网关模式统一聚合、代理、过滤与观测所有 MCP 流量。

- 需求分析：[docs/requirements-analysis.md](docs/requirements-analysis.md)
- 实施方案：[docs/implementation-plan.md](docs/implementation-plan.md)

## 三大能力

1. **Client 管理（配置分发）**——单一事实来源的 Server 注册表，勾选矩阵分发到各 agent 配置文件（单向推送 + 手动导入），写入前自动备份、原子写、写后校验，手改检测与冲突处置。
2. **MCP Gateway**——多上游聚合为一个 streamable HTTP 端点（`http://127.0.0.1:<port>/mcp`），工具级开关、重名加前缀防冲突、上游懒启动/崩溃自愈、调用日志；另提供 per-server 独立端点（`/servers/:id/mcp`）。
3. **Server 管理**——注册表 CRUD、进程状态/启停/重启、stderr 日志、凭证集中管理（网关模式下不落地到 agent 配置）。

## 快速开始

```bash
pnpm install
pnpm build          # 构建 core / server / cli / web

node packages/cli/dist/index.js start    # 或全局安装后: mcpmgr start
# API/UI: http://127.0.0.1:6280   （token 见 ~/.mcp-manager/config.json）
```

打开 `http://127.0.0.1:6280` 输入 token 即可使用 Web UI。

## CLI

```
mcpmgr start | stop | status
mcpmgr servers list | servers add --name X --transport stdio --command npx --args ...
mcpmgr agents            # 探测本机 agent
mcpmgr import [--all]    # 从现有 agent 配置导入
mcpmgr sync [--dry-run]  # 分发到各 agent
mcpmgr gateway status | start | stop
```

## 开发

```bash
pnpm test        # 单元 + 集成（vitest，含真实子进程网关测试）
pnpm lint
pnpm build
cd e2e && pnpm i && npx playwright install chromium && pnpm test   # E2E 冒烟
```

### 沙箱纪律（重要）

所有自动化测试通过 `MCP_MANAGER_HOME`（数据目录）与 `agentConfigRoot` / `--agent-home`（agent 配置根）重定向到临时目录，**绝不读写真实的 agent 配置文件**。daemon 构造时若数据目录已重定向而 agent 根未重定向，会输出告警日志。

## 架构速览

```
单 Node 进程 daemon
├─ node:http 路由
│  ├─ /mcp                → 聚合端点（MCP SDK streamable HTTP, stateless）
│  ├─ /servers/:id/mcp    → per-server 端点
│  ├─ /api/*              → 管理 REST（Bearer token，仅 127.0.0.1）
│  └─ /*                  → Web UI 静态托管（React SPA）
├─ Gateway（UpstreamManager：懒启动/退避重启/stdio 串行化）
└─ Core：Store（原子写/备份/hash）· 适配器（JSON/TOML 保真写入）· SyncEngine · 冲突检测
```

## 各 Agent 配置差异

| Agent | 配置文件 | 格式 | 网关模式 |
|---|---|---|---|
| Claude Code | `~/.claude.json`（键 `mcpServers`） | JSON | ✅（`type: "http"`） |
| Codex CLI | `~/.codex/config.toml`（`[mcp_servers.*]`） | TOML（分段保真编辑） | M2（stdio 反向桥） |
| Cursor | `~/.cursor/mcp.json` | JSON | ✅ |
| Trae | `~/.trae/mcp.json`（国内版 `~/.trae-cn/`） | JSON | ✅ |
| OpenCode | `~/.config/opencode/opencode.json`（键 `mcp`） | JSON（local/remote） | ✅ |
| Claude Desktop | 分平台 `claude_desktop_config.json` | JSON | ✅ |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON | ✅ |
| Gemini CLI | `~/.gemini/settings.json`（httpUrl/sse） | JSON | ✅（经反向桥） |

## 当前状态（M1）

- ✅ M1 + M2 + M3 完成，65 个单元/集成测试全绿
  - M2：stdio 反向桥（Codex 网关打通）、SSE 上游兼容、环境检测、token 轮换提醒、工具并发度
  - M3：调试台（不经 agent 直接调用工具）、per-agent 分组端点（`/agents/:type/mcp`）、凭证静态加密（Windows DPAPI）、Claude Desktop/Windsurf/Gemini CLI 适配器、registry 发现
- ⏳ M4 规划：项目级作用域、VS Code 适配器、macOS Keychain/Linux libsecret 加密、per-client 隔离
