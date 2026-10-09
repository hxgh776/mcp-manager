# MCP Manager 需求分析

> 版本 v0.3（2026-10-09）· 状态：关键决策已锁定（见 §8，含 D7 增补）；M1–M3 已交付
> 定位关键词：开发者个人电脑 · 多 Coding Agent · 一站式 MCP 控制平面

---

## 1. 项目定位

**一句话定位**：面向开发者个人电脑的 MCP 控制平面（Control Plane）——MCP Server 配置一次，多个 AI Coding Agent（Claude Code、Codex、Cursor、Trae、OpenCode 等）一键启用；可选网关模式统一聚合、代理、过滤与观测所有 MCP 流量。

三个模块的本质关系：

```
                    ┌─────────────────────────────────────────┐
                    │  模块3: MCP Server 管理（单一事实来源）      │
                    │  注册 / 凭证 / 生命周期 / 日志 / 调试        │
                    └──────────────┬──────────────────────────┘
                                   │ Server 注册表
              ┌────────────────────┴───────────────────┐
              ▼                                        ▼
 ┌─────────────────────────┐            ┌─────────────────────────────┐
 │ 模块1: Client 管理（直连） │            │ 模块2: Gateway（网关模式）      │
 │ 把真实配置分发到各 agent   │            │ N 个上游聚合为 1 个 endpoint   │
 │ agent 各自拉起进程        │            │ stdio↔HTTP 双向桥接 + 过滤     │
 └───────────┬─────────────┘            └──────────────┬──────────────┘
             │                                         │
     Claude Code / Codex / Cursor / Trae / OpenCode 只需配置一条
     （直连：N 条真实配置  |  网关：1 条 http://127.0.0.1:PORT/mcp）
```

**关键洞察**：模块 1 和模块 2 是同一个 Server 注册表的**两种消费路径**，不是三个孤立功能：

| | 直连模式（模块1） | 网关模式（模块2） |
|---|---|---|
| agent 拿到什么 | 真实 server 配置（一份份写入） | 一条指向 gateway 的配置 |
| 谁拉起 stdio 进程 | 各 agent 自己（N 份进程） | gateway 统一拉起（1 份共享） |
| 凭证存放 | 复制散落在各 agent 配置里 | 只存 manager 一处 |
| 延迟 | 最低（无中间层） | 多一跳本地转发（可忽略） |
| 工具开关/过滤/观测 | 不具备（受 agent 能力限制） | 具备（列表与调用都过 gateway） |
| 适用 | 本地型 server（文件系统、git、终端） | 远程 API 型、工具多的、需要共享凭证的 |

每个 server 可以按需选择路径（如 filesystem 走直连、聚合工具集走网关），**两种模式共存**是产品灵活性的来源，也是数据模型设计的出发点。

---

## 2. 目标用户与核心痛点

**目标用户**：一台开发机上装有 ≥2 个 AI Coding Agent 的开发者（现状普遍：Claude Code + Cursor + Codex 组合）。

**痛点分析**（按强度排序）：

- **P1 重复配置**：同一批 MCP server 要在 N 个 agent 里各配一遍；格式不同（JSON vs TOML）、位置分散、字段命名不一致（`mcpServers` vs `[mcp_servers.*]` vs `mcp`）。改一处要改 N 处，极易不同步。
- **P2 凭证散落**：API key 作为 env 复制到每个 agent 的配置文件里，轮换密钥 = 手改 N 个文件；明文散落增加泄露面。
- **P3 上下文爆炸**：agent 接入的工具一多，工具 schema 占满 system prompt，且无法精细开关（很多 agent 只有 server 级开关，没有工具级）。
- **P4 资源与进程浪费**：3 个 agent 各自 spawn 同一个 npx stdio server，就是 3 份重复进程；某些付费/限流 server 被重复连接。
- **P5 排障困难**：某工具调用失败，不知道是哪个 server 挂了；stdio 进程日志散落在各 agent 的缓存目录里，无从看起。

---

## 3. 功能需求

优先级定义：**P0** = MVP 必须；**P1** = 第二迭代；**P2** = 远期。

### 3.1 模块一：MCP Client 管理（配置分发）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| C1 | Agent 自动探测 | 扫描本机已装 agent 及其配置文件路径（存在性检测），生成 agent 清单 | P0 |
| C2 | Server 注册表（单一事实来源） | 所有 MCP server 只在此定义一次（传输方式、命令/URL、args、env、cwd） | P0 |
| C3 | 分发矩阵（"一键启用"） | server × agent 勾选矩阵；勾选即把配置写入对应 agent；取消勾选即移除 | P0 |
| C4 | 配置格式适配器 | 每个 agent 一个适配器：读写其配置文件、字段映射、保留文件中无关内容（如供应商配置、其他键） | P0 |
| C5 | 导入（冷启动） | 从现有 agent 配置反向导入 server 定义到注册表（首扫引导，决定上手成本） | P0 |
| C6 | 安全写入 | 写入前自动备份（保留最近 N 版）、原子写（临时文件+rename）、格式校验失败即回滚 | P0 |
| C7 | 作用域 | 全局（user scope）优先；项目级作用域（写入项目目录的 `.mcp.json` 等）后置 | P1 |
| C8 | 冲突处理 | 检测 agent 配置被手工修改过（与上次分发快照不一致）时提示覆盖/保留/吸收，v1 不做自动双向同步 | P1 |
| C9 | 分发模式选择 | per-server 选择"直连分发"或"指向 gateway"（见 3.2 G8） | P0 |

**设计约束**：
- v1 明确**单向推送**（注册表 → agent），双向同步是冲突泥潭，明确不做（cc-switch 也是单向）。
- 适配器必须**保真**：只动 `mcpServers` / `mcp` 相关键，其余内容原样保留（`~/.claude.json` 里混有大量非 MCP 配置，写坏属重大事故）。

**各 agent 配置差异矩阵**（适配器的需求输入，实现时以实测为准）：

| Agent | 配置文件（全局） | 格式 | 键名 | 支持的传输 |
|---|---|---|---|---|
| Claude Code | `~/.claude.json`；项目级 `.mcp.json` | JSON | `mcpServers` | stdio / HTTP / SSE |
| Codex CLI | `~/.codex/config.toml` | TOML | `[mcp_servers.*]` | stdio 为主（HTTP 支持随版本变化，需实测） |
| Cursor | `~/.cursor/mcp.json`；项目级 `.cursor/mcp.json` | JSON | `mcpServers` | stdio / SSE / HTTP（remote 需在 UI 确认启用） |
| Trae | `~/.trae/mcp.json`（国内版 `~/.trae-cn/`） | JSON | `mcpServers` | stdio / SSE / HTTP |
| OpenCode | `~/.config/opencode/opencode.json`；项目级 `opencode.json` | JSON | `mcp`（`type: local/remote`） | stdio / HTTP |
| 备选扩展 | Claude Desktop、Windsurf、Gemini CLI、VS Code | — | — | — |

> 注意三点：① Codex 的 TOML 格式需要专门的 TOML 编辑器（保注释、保顺序）；② OpenCode 键名和结构都不同（local/remote 二分）；③ 各 agent 对 streamable HTTP 的支持程度差异大 → 引出模块 2 的桥接价值。

### 3.2 模块二：MCP Gateway（聚合 + 代理）

对标 MetaMCP（聚合编排）+ mcp-proxy（协议桥接），**只取核心，做减法**：

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| G1 | 聚合 endpoint | 把多个上游 server 聚合为一个 `http://127.0.0.1:{port}/mcp`（streamable HTTP）；agent 侧只配这一条 | P0 |
| G2 | 上游生命周期 | gateway 负责拉起 stdio 上游进程：懒启动（首次调用时）、崩溃自动重启、健康检查、超时配置 | P0 |
| G3 | 方法透传 | `initialize / tools/list / tools/call / prompts / resources` 透传与合并；`tools/list` 聚合所有上游结果 | P0 |
| G4 | 工具级开关 | per-server、per-tool 的启用开关；关闭的工具从 `tools/list` 中过滤（上下文成本控制，MetaMCP 核心能力） | P0 |
| G5 | 工具名防冲突 | 聚合后工具名冲突 → 以 server 名做前缀（或映射表）；需处理 agent 侧工具名长度/字符限制 | P1 |
| G6 | stdio→HTTP 桥 | 单个 stdio server 也可单独暴露为 HTTP endpoint（mcp-proxy 核心能力） | P1 |
| G7 | HTTP→stdio 反向桥 | 让只支持 stdio 的 agent（如部分版本 Codex）通过一个本地 stdio 进程连上远程 HTTP server | P1 |
| G8 | 分发联动 | "启用网关模式"= 模块 1 向该 agent 写入一条指向 gateway 的配置（或 per-server 的桥接 endpoint） | P0 |
| G9 | 本机鉴权 | 默认只绑 127.0.0.1 + 启动时生成本地 token；不做多租户/团队权限（明确不做，与 MetaMCP 的减法边界） | P0 |
| G10 | 上游凭证集中 | 上游 env/headers 凭证只存注册表，分发到 agent 的配置里不含密钥 | P0 |
| G11 | 调用日志 | 记录每次 tool call：时间、server、tool、耗时、成功/失败、错误摘要（先落文件，后 UI） | P1 |
| G12 | 并发策略 | stdio 上游多为单会话设计：默认 per-server 请求串行化；提供"多实例隔离"选项（每个 client 连接多开一个进程） | P1 |
| G13 | per-agent 分组 | 类似 MetaMCP namespace 的简化版：不同 agent 可挂不同的 server 子集（每个 agent 一个虚拟 endpoint） | P2 |

**减法边界**（相对 MetaMCP 明确不做的）：多用户/团队/权限、OAuth 上游授权流（v1 手工贴 token）、工具重命名与描述改写、Server 扫描/安全审计、云端部署形态。

### 3.3 模块三：MCP Server 管理（服务托管）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| S1 | Server CRUD | 传输类型（stdio 命令 / HTTP URL）、command/args/env/cwd 或 url/headers 的表单化管理 | P0 |
| S2 | 状态与进程管理 | 显示运行状态（gateway 托管的进程）；start/stop/restart；健康检查（ping/tools/list） | P0 |
| S3 | 日志查看 | 上游 stdout/stderr 捕获与查看（排障刚需，解决痛点 P5） | P0 |
| S4 | 凭证管理 | env 集中管理；v1 明文存本地（文件权限收紧），v2 加密（OS keychain：DPAPI/Keychain） | P1 |
| S5 | 运行环境检测 | `node/npx`、`python/uvx`、`docker` 是否可用、版本检查，缺失时给出明确指引 | P1 |
| S6 | 调试台 | 不经 agent 直接调用某 server 的某工具看返回（类 MCP Inspector 的最小版） | P2 |
| S7 | Registry 发现 | 从社区 registry 搜索/一键添加 server 定义 | P2 |
| S8 | 版本与更新 | npx/uvx 包版本固定与升级 | P2 |

### 3.4 模块间联动闭环（产品灵魂）

典型用户旅程必须打通：

1. 首次启动 → 自动探测本机 agent + 从现有配置**导入**（C1+C5，冷启动零成本）；
2. 在注册表里改一个 server 的 env（S1）→ 一键**同步**到 5 个 agent（C3）；
3. 勾选"网关模式" → agent 配置变成一条 gateway URL，凭证从 agent 配置里**消失**（G8+G10）；
4. 某工具失灵 → 网关日志/进程状态**定位**（G11+S2+S3）→ 重启上游（S2）→ 完事。

---

## 4. 非功能需求

| 维度 | 要求 |
|---|---|
| 平台 | **Windows 一等公民**（当前环境 win32），macOS/Linux 同步支持。Windows 特有：进程脱离父会话常驻（detached process）、路径/编码、无 POSIX 信号（进程终止需 taskkill 兜底） |
| 产品形态 | 本地常驻 **daemon + 本地 Web UI**（单进程承载 daemon/gateway/UI，已决策 D1），核心操作保留 CLI 入口 |
| 可靠性 | agent 配置文件原子写 + 自动备份；gateway 崩溃不影响 agent 侧配置文件本身（agent 报"连不上"而非"配置损坏"） |
| 安全 | gateway 仅监听 127.0.0.1；token 鉴权；配置文件收紧权限；凭证不进日志 |
| 协议 | MCP 规范：streamable HTTP 为主（2025-06 版规范），SSE 为兼容；stdio 按规范实现 lifecycle |
| 性能 | 转发开销 < 10ms 量级；daemon 常驻内存目标 < 100MB |
| 上手成本 | 首次启动 5 分钟内完成"导入→分发"闭环 |

### 4.1 技术栈与资源预算（D2 决策的落地约束）

**选型**：TypeScript / Node.js ≥ 20 LTS，编译产出纯 JS 运行（tsup/tsc，不依赖额外本地组件）。

**为什么 Node 满足本场景**：工作负载为 I/O 密集、小报文（KB 级 JSON-RPC）、低并发（本机个位数 agent 连接）；转发附加延迟亚毫秒级，远低于上游 server 本身的响应耗时。Node 真正不适用的多租户/高并发场景已被 D6（纯本机）排除。

**资源预算（硬约束，进 CI 度量）**：
- 常驻 RSS ≤ 100MB（预热后稳态；度量口径：模拟 20 个 server 注册、3 个 agent 连接、周期性 tool call）
- 冷启动 ≤ 500ms；单次转发附加延迟 ≤ 5ms（p99）

**工程纪律（达成预算的条件）**：
- Web 层用 Hono/Fastify 级轻框架，生产依赖数 ≤ 20；不引入 Electron/内嵌浏览器等重运行时
- 上游子进程 stdout 按行流式处理，不整包缓冲
- `--max-old-space-size=256` 硬上限 + 泄漏回归用例（长时挂机 RSS 曲线）
- 重模块懒加载

**退路**：agent 侧契约是稳定的 HTTP endpoint，若未来出现内存瓶颈，可单独以 Rust/Go 重写 gateway 核心，不影响整体架构（仅记录可能性，不预做）。Bun 运行时内存更低，但 Windows 稳定性不如 Node，v1 不作为目标运行时（代码保持 Node 兼容即可）。

---

## 5. 竞品分析

| 竞品 | 覆盖 | 形态 | 与本项目关系 |
|---|---|---|---|
| [cc-switch](https://github.com/farion1231/cc-switch/blob/main/README_ZH.md) | 供应商切换 + MCP 统一同步到多 agent（Claude Code/Codex/Gemini CLI/OpenCode 等） | Tauri 桌面应用 | **直接竞品（模块1）**。覆盖广、迭代快；但无网关、无观测、无代理。只做模块 1 没有壁垒 |
| [MetaMCP](https://github.com/metatool-ai/metamcp) | 完整聚合网关：namespace、工具过滤/改写、多 endpoint、鉴权、Inspector | Docker 服务端 + Web | **直接竞品（模块2）**。能力强但形态重（Docker），面向自托管/团队，个人本机不友好；不管 agent 配置分发 |
| [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | stdio ↔ streamable HTTP 双向桥接 | 单一二进制/CLI | **能力参照（模块2 代理部分）**。纯桥接，无管理面、无聚合、无持久化 |
| mcpm 等包管理器类 CLI | server 发现/安装到各 agent | CLI | 部分重叠（S7），管理面弱 |
| MCP Inspector | 调试单 server | 开发工具 | 参照 S6 调试台 |

**差异化结论**：
1. **三合一闭环**是核心差异——竞品各占一段，没有人把"注册表→分发→网关→观测"做成单机闭环；
2. **个人本机轻量形态**（单 daemon，无 Docker）对抗 MetaMCP 的服务端重形态；
3. **gateway 是技术壁垒**：模块 1 门槛低（cc-switch 已验证且做得不错），护城河在模块 2 的协议桥接与生命周期管理质量上；
4. 风险：cc-switch 若补上网关能力会挤压空间 → 应尽快把 M1 做到"分发 + 聚合"闭环可用。

---

## 6. 关键技术难点与风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| R1 | **写坏 agent 配置** | `~/.claude.json` 等文件混有大量非 MCP 状态，写坏直接导致 agent 起不来 | 原子写 + 滚动备份 + 只动目标键 + 写后解析校验（C6 是 P0 中优先级最高的） |
| R2 | **各 agent 版本漂移** | 配置路径/字段/传输支持随版本变化（如 Codex 的 HTTP 支持） | 适配器隔离 + 探测降级（HTTP 不可用自动走 stdio 反向桥 G7）；矩阵文档持续维护 |
| R3 | **stdio 上游并发限制** | 多数 stdio server 假设单会话，gateway 多 client 共享同一进程可能出乱序/状态污染 | 默认 per-server 请求串行 + 可选多实例（G12）；文档标注行为差异 |
| R4 | **工具名冲突与长度** | 聚合后重名；Claude Code 的 `mcp__server__tool` 命名对长度敏感 | server 名前缀策略 + 名字映射表（G5） |
| R5 | **Windows 进程管理** | detached 常驻、进程树清理（npx→node 子进程链） | Windows Job Object / process-group 杀树；uvx/npx 包装命令的进程树处理要专门测 |
| R6 | **长连接稳定性** | gateway 与上游的 stdio 管道断连、半开连接、agent 重连风暴 | 心跳 + 指数退避重连 + 懒重启（G2） |
| R7 | 范围蔓延 | MetaMCP 能力面很宽，"融合核心能力"若无减法边界会做不完 | §3.2 的减法边界清单作为需求基线 |

---

## 7. MVP 与迭代路线

**M1（核心闭环，验证价值）**——目标：一台装了 Claude Code + Codex + Cursor 的机器上，10 分钟内完成"导入 → 编辑一处 → 三端生效"，并能切网关模式：
- daemon + CLI（`mcpmgr list/add/sync/enable`）
- Server 注册表 + 手动添加 + 从 Claude Code/Codex/Cursor 导入（C1 C2 C5 S1）
- 配置分发：3 个 agent 适配器 + 安全写入（C3 C4 C6）
- Gateway v0：stdio 上游聚合 → 1 个 streamable HTTP endpoint，工具级开关，本机 token（G1–G4 G8–G10）

**M2（体验与覆盖）**：Trae/OpenCode 适配器 · stdio↔HTTP 双向桥（G6 G7）· 调用日志与进程状态 UI（G11 S2 S3）· Web 管理界面 · 环境检测（S5）

**M3（进阶）**：凭证加密（OS keychain，S4）· registry 发现（S7）· 调试台（S6）· per-agent 分组 endpoint（G13）· 项目级作用域（C7）· 更多 agent（Claude Desktop/Windsurf/VS Code）

---

## 8. 关键决策记录（2026-10-09 已拍板）

| # | 决策点 | 决策结果 | 备注 |
|---|---|---|---|
| D1 | 产品形态 | **daemon + 本地 Web UI** | 单进程承载 daemon/gateway/UI；核心操作保留 CLI 入口 |
| D2 | 技术栈 | **TypeScript / Node.js** | 资源预算与工程纪律见 §4.1；本工作负载 I/O 密集小报文，Node 可满足内存与性能要求；官方 MCP SDK 为决定性加分项 |
| D3 | 分发方向 | **单向推送 + 手动导入** | v1 不做双向同步，冲突处理见 C8 |
| D4 | 网关传输 | **streamable HTTP** | 唯一对外传输；SSE 兼容放 M2 |
| D5 | 网关启用方式 | **per-server 可选** | 直连分发为默认，网关为增强路径 |
| D6 | 范围边界 | **纯本机** | 不做远程/团队场景；多租户、OAuth 授权流等 MetaMCP 能力明确排除 |
| D7 | 访问令牌（2026-10-09 增补） | **默认关闭，WebUI 可开关** | 仅环回监听兜底；开启后 /api 与网关要求 Bearer token，同步分发携带凭证、反向桥带 --token；UI 开关切换后提示重新同步 |

---

## 9. 参考

- cc-switch（多 agent 配置切换与 MCP 同步）：https://github.com/farion1231/cc-switch
- MetaMCP（MCP 聚合网关）：https://github.com/metatool-ai/metamcp · 文档：https://docs.metamcp.com
- mcp-proxy（stdio ↔ streamable HTTP 桥）：https://github.com/sparfenyuk/mcp-proxy
- MCP 规范：https://modelcontextprotocol.io
