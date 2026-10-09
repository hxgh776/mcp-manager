# MCP Manager 实施方案

> 版本 v1.0（2026-10-09）· 上游文档：[需求分析 v0.2](./requirements-analysis.md)
> 范围：M1（核心闭环）全量 + M2 概要。按 阶段一~五 推进：技术设计 → 测试用例设计 → 编码实施 → 测试验收 → 浏览器 Web UI 测试。

---

## 0. 前置条件与环境

- 已锁定决策：D1 daemon + Web UI 单进程 · D2 TypeScript/Node · D3 单向推送+手动导入 · D4 streamable HTTP · D5 per-server 可选网关 · D6 纯本机。
- 开发环境：Windows（主开发/验收平台），Node ≥ 20 LTS，pnpm ≥ 9；步骤 0 先 `git init` + 常规提交约定。
- 命名：npm 包 `mcp-manager`，CLI 命令 `mcpmgr`，数据目录 `~/.mcp-manager/`（支持 `MCP_MANAGER_HOME` 环境变量重定向，测试沙箱的关键）。

---

## 阶段一：技术设计

### 1.1 总体架构（单进程多模块）

```
┌────────────────────────── mcpmgr daemon（单 Node 进程）──────────────────────────┐
│                                                                                │
│  ┌─ HTTP Server (node:http) ─────────────────────────────────────────────┐     │
│  │  /mcp            → Gateway 聚合 endpoint（MCP SDK StreamableHTTP）      │     │
│  │  /servers/:id/mcp → per-server 独立 endpoint（薄反代）                   │     │
│  │  /api/*          → 管理 REST API（鉴权）                                │     │
│  │  /*              → Web UI 静态资源                                     │     │
│  └───────────────────────────────────────────────────────────────────────┘     │
│                                                                                │
│  Gateway 层：UpstreamManager（拉起/重启/健康检查）→ AggregateMcpServer           │
│  Domain 层(core包)：Registry(注册表) · SyncEngine(分发) · AgentAdapters ·       │
│                     Importer · BackupStore · ConflictDetector                  │
│  存储层：~/.mcp-manager/{config.json, backups/, logs/}                          │
└────────────────────────────────────────────────────────────────────────────────┘
        ▲ CLI (mcpmgr) 与 Web UI(React SPA) 都只走 /api，共享同一契约
```

### 1.2 技术选型清单

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node ≥ 20 LTS，TypeScript 5，ESM | D2 |
| 构建 | tsup（包）+ tsc 类型检查；web 用 Vite | 产物纯 JS |
| HTTP 服务 | **node:http + 自带极简路由（~100 行）** | `/mcp` 需要原生 req/res 交给 MCP SDK transport，框架抽象反而碍事；`/api` 用同一个 server 按 URL 分发 |
| MCP 协议 | `@modelcontextprotocol/sdk`（服务端+客户端 transport） | 参考实现白拿 |
| Web 框架 | 不引入 Express/Fastify；API 路由手写 + zod 校验 | §4.1 依赖纪律 |
| 前端 | React 18 + Vite + TanStack Query + Tailwind CSS | 本地静态托管，体积不敏感，开发效率优先 |
| CLI | commander | |
| 校验 | zod（与 MCP SDK 同源） | |
| TOML | `smol-toml`（解析）+ **自研分段文本编辑器**（写入） | 见 1.5-C |
| 进程管理 | child_process + win32 `taskkill /T /F` 树杀 / POSIX 进程组 | R5 |
| 单元/集成测试 | vitest + SDK Client 直连（见阶段二） | |
| E2E | Playwright（chromium）+ 浏览器交互式验收 | 阶段五 |

依赖总预算：server 生产依赖 ≤ 10（sdk、zod、commander、smol-toml、tailwind 仅构建期）。

### 1.3 仓库结构（pnpm workspace）

```
mcp-manager/
├─ packages/
│  ├─ core/        # 纯领域层，零 IO 框架依赖：types / store / adapters / import / sync / backup
│  ├─ server/      # daemon：node:http 服务、/api、gateway/、静态托管、日志
│  ├─ cli/         # mcpmgr 入口（调 /api，daemon 未启动时可拉起）
│  └─ web/         # React SPA（构建产物由 server 托管）
├─ e2e/            # Playwright 用例 + fixtures
├─ docs/           # 本文档、需求分析、适配器矩阵（持续维护）
└─ fixtures/       # 各 agent 配置样例、fake stdio MCP server（SDK 写的回声/加法工具）
```

### 1.4 数据模型与存储

```ts
// core/types.ts（核心四实体）
ServerDef {
  id: string                    // slug，全局唯一
  name: string
  transport: 'stdio' | 'http'
  command?/args?/env?/cwd?      // stdio
  url?/headers?                 // http
  gatewayMode: boolean          // D5：false=直连分发，true=走网关
  enabled: boolean
  toolOverrides?: Record<string, { enabled: boolean }>   // G4 工具级开关
}
AgentBinding { serverId, agentType, mode: 'direct'|'gateway', lastSync?: { hash, at } }
AgentInfo { type, detected, configPaths, transportsSupported }
Settings { port(默认 6280，占用自动+1), token, logLevel }
```

存储布局与护栏：

```
~/.mcp-manager/
├─ config.json          # servers + bindings + settings（单文件，内存态 + 变更即原子写）
├─ daemon.pid
├─ backups/<agent>/<timestamp>.<file>   # 每次 agent 配置写入前的滚动备份，保留 10 份
└─ logs/daemon.log · gateway-calls.ndjson（G11：ts/server/tool/耗时/ok/error 摘要）
```

### 1.5 四个核心机制设计

**A. JSON 适配器写入保真（C4/C6，P0 中的 P0）**
`parse(原文) → 仅替换 mcpServers/mcp 键 → stringify(2 空格) → 原子写（临时文件+rename）→ 复读校验`。写前滚动备份；写后断言：其余顶层键与新文件中一致（深比较键集合+值），失败即用备份回滚并报错。Claude Code 项目级 `.mcp.json` 同理。

**B. Codex TOML 分段编辑（R2 的正解）**
不用 parse→stringify 整文件重写（会丢注释）。自研分段编辑器：按 `[mcp_servers.*]` 表头切块 → 摘除本工具管理的段 → 其余字节原样保留 → 在文件末尾追加重新生成的段。用户在**非托管区**的注释/顺序完全无损；托管区内的旧注释丢弃（本就是我们写的）。

**C. 网关聚合（模块 2 核心）**
- 对外：一个聚合 endpoint `http://127.0.0.1:{port}/mcp`，`StreamableHTTPServerTransport` 以 **stateless 模式**运行（`sessionIdGenerator: undefined`）——规避各 agent 会话行为差异带来的 session 生命周期 bug，本地场景无亲和性需求。另有 `/servers/:id/mcp` 薄反代（G6）。
- 对内：`UpstreamManager` 管理 `Client` + `StdioClientTransport`（或 `StreamableHTTPClientTransport`）：懒启动（首次调用拉起）、崩溃指数退避重启、`ping` 健康检查、`listTools` 翻页 cursor 追平并缓存。
- 聚合规则：`tools/list` = 各上游缓存合并；唯一名透传，**冲突名加 `serverId__` 前缀**（映射表双向维护）；`toolOverrides` 关闭的工具直接从列表剔除；`tools/call` 按映射路由回上游。
- stdio 上游并发：默认 per-server 请求串行队列（R3）；多实例隔离选项 M2 做。
- 范围裁剪：v1 只透传 tools（`initialize/tools/list/tools/call/ping`），prompts/resources 透传放 M2（G3 降级为分阶段）。
- 鉴权（G9）：监听强制 127.0.0.1；`Authorization: Bearer <token>`，不支持 header 的 agent 允许 `?token=`（文档标注泄露风险日志规避）。

**D. 分发与冲突（模块 1 核心）**
- SyncEngine：绑定矩阵 → 逐 agent 适配器写；server `gatewayMode=true` 时写入的是 `{ "mcp-manager-gateway": { type:"http", url, headers:{Authorization} } }` 单条（直连则写真实定义）。
- 冲突检测（C8）：每次写入记录该 agent 配置中**我们管辖片段**的 hash（lastSync.hash）。下次同步前重算，若 hash 变化且 ≠ 待写内容 → 标记 conflict，UI 三选：覆盖 / 保留跳过 / 吸收进注册表。v1 无自动合并。
- 导入（C5）：读各 agent 现有配置 → 规范化为 ServerDef → 按指纹去重（stdio: `command+args`；http: `url`）→ 差集供用户勾选入库。首启引导页即此流程。

### 1.6 REST API 契约（/api，Bearer token）

| 方法/路径 | 作用 |
|---|---|
| GET /api/status | daemon/网关/端口/版本/agents 探测结果 |
| GET·POST /api/servers · GET·PATCH·DELETE /api/servers/:id | 注册表 CRUD（PATCH 支持改 toolOverrides） |
| POST /api/servers/:id/start·stop·restart | 进程管理（网关托管上游） |
| GET /api/servers/:id/logs | 上游 stdout/stderr 环形缓冲 |
| GET /api/agents | 已探测 agent + 各自当前绑定/冲突状态 |
| POST /api/import · GET /api/import/preview | 导入预览与入库 |
| POST /api/sync | body：绑定矩阵（支持 `dryRun: true` 返回 diff 不落盘） |
| GET /api/logs/calls?since= | 网关调用日志 |
| GET·PATCH /api/settings · POST /api/settings/token/rotate | 端口/token/日志级别 |
| POST /api/gateway/start·stop · GET /api/gateway | 网关开关与状态 |

### 1.7 阶段一出口标准

选型与机制设计经用户确认（本文档评审通过）；适配器差异矩阵在真实机器上手工核验一遍（5 个 agent 的实际配置路径/字段记录进 `docs/adapter-matrix.md`）。

---

## 阶段二：测试用例设计

分层策略：**U 单元（vitest，adapter/store/聚合逻辑，fixture 驱动）→ I 集成（vitest，真实子进程+真实 HTTP，沙箱 HOME）→ A 验收（真实机器映射 FR）→ E 端到端 UI（Playwright + 交互式）**。所有依赖"本机 agent"的用例一律用 `MCP_MANAGER_HOME` 沙箱 + fixtures，**绝不碰真实 agent 配置**；真实配置仅出现在 A 级手工验收。

### 2.1 单元用例（节选，全部 TDD 先行）

| ID | 用例 | 断言要点 |
|---|---|---|
| U-AD-01~05 | claude-code 适配器：读/增/删/坏文件/备份 | 无关顶层键逐一深等；坏 JSON 报错且原文件未动；备份生成且保留 10 份滚动 |
| U-AD-06~08 | codex 适配器：TOML 读/分段写/冲突 | 托管段替换正确；**非托管区注释与顺序字节级保留**；hash 漂移检出 |
| U-AD-09~11 | cursor 全局+项目双路径；trae/trae-cn 路径；opencode local/remote 映射 | 路径解析与键名映射 |
| U-ST-01~03 | 原子写（模拟中断）/store 持久化往返/binding hash | 崩溃后目标文件仍是旧完整版 |
| U-IM-01~02 | 导入规范化 + 跨 agent 指纹去重 | 相同 command+args 只留一条 |
| U-CF-01 | 手改托管片段 → conflict 状态 | 三选项语义正确 |
| U-GW-01~05 | 工具合并/冲突前缀/停用过滤/调用路由/stdio 串行 | 名字稳定；停用工具不出现在 list；并发调用不交叠 |
| U-LOG-01 | 调用日志字段完整 | ndjson 可解析，无 env 密钥泄露 |

### 2.2 集成用例（真实子进程 + HTTP）

| ID | 用例 | 断言要点 |
|---|---|---|
| I-GW-01 | fake stdio server（SDK fixture）→ 聚合 endpoint → SDK Client list+call | 全链路成功 |
| I-GW-02 | 懒启动：连接前无子进程，首次 call 后出现 | 进程数断言 |
| I-GW-03 | 杀上游子进程 → 退避重启 → 再次 call 成功 | |
| I-GW-04 | 上游报错 → 错误信息含 server 名透传给 client | |
| I-GW-05~06 | http 上游聚合；per-server 独立 endpoint | |
| I-GW-07~08 | 鉴权 401 矩阵（无/错 token、header/query）；非 loopback 绑定被拒 | |
| I-SY-01~03 | 沙箱 HOME：导入 3 个假 agent 配置→注册表；矩阵同步落盘比对 fixtures；注入写失败→回滚+报错 | |
| I-AP-01~02 | REST CRUD / 设置端口后网关跟随重启 | |

### 2.3 验收用例（A）与 UI 用例（E）分别见阶段四、五。

---

## 阶段三：编码实施

里程碑按依赖排序，每个里程碑有明确 DoD；测试与实现同里程碑交付（core 部分严格 TDD）。

| 里程碑 | 内容 | 预估 | DoD |
|---|---|---|---|
| M1.0 地基 | git init、pnpm workspace、tsup/tsconfig/vitest/eslint、CI（win+ubuntu）、core 类型与 fixtures 骨架 | 0.5d | 空跑 CI 绿 |
| M1.1 存储核 | store/原子写/备份/hash + U-ST 全绿 | 1d | 数据层可持久化且有崩溃保护 |
| M1.2 适配器 | claude-code、codex、cursor 三适配器 + 备份 + U-AD 全绿（fixture 驱动 TDD） | 2.5d | 真实配置文件沙箱内读写无损 |
| M1.3 分发引擎 | SyncEngine/绑定矩阵/冲突检测/导入 + U-IM、U-CF、I-SY 全绿 | 1.5d | 沙箱三 agent 导入→改→同步闭环 |
| M1.4 daemon+CLI | node:http 路由、/api 全量、token 鉴权、静态托管、PID 管理；CLI start/stop/status/servers/sync/agents/import | 2d | 纯 CLI 可完成核心闭环（无 UI） |
| M1.5 网关 | UpstreamManager（懒启/重启/健康/翻页）、聚合 endpoint（stateless）、工具过滤与路由映射、per-server endpoint、调用日志；I-GW 全绿 | 4d | 两个 fake server 聚合、崩溃自愈、鉴权全过 |
| M1.6 Web UI | React SPA：引导/探测页、注册表列表+表单、绑定矩阵页、网关页（URL/token/开关）、日志页 | 4d | 八个核心页面流程可走通 |
| M1.7 收尾 | trae/opencode 适配器（M2 提前项：适配器便宜、早覆盖）、环境检测 S5、README、npm bin 打包 | 2d | `npm i -g` 后开箱可用 |

**M1 合计 ≈ 17.5 个有效人日（±30%，单人）**。排序原则：1.2/1.3 是最高风险的核心先做；网关 1.5 独立于 UI，纯 CLI（M1.4 末）即可先自我验证。

分支与提交：单主干 + milestone tag（`m1.0`…），conventional commits；每里程碑合并前该级测试全绿。

---

## 阶段四：测试验收

### 4.1 验收环境

- 主平台：本机 win32（真实装有 Claude Code / Codex / Cursor）。
- 隔离纪律：自动化全走沙箱 HOME + fake server；**真实 agent 配置的手工验收前必须先验证恢复流程**（A-08），且每步操作在 UI 内可见 diff。

### 4.2 验收用例（映射需求 FR）

| ID | 验收项 | 通过标准 |
|---|---|---|
| A-01 | 5 分钟闭环（C1 C5 C3） | 真机从安装到"导入→改 env→三 agent 生效"≤ 5 分钟，配置文件 diff 无损 |
| A-02 | 网关切换（G8 G10） | 某 server 开网关后，Claude Code 经网关调用成功且调用日志有记录；agent 配置中无明文密钥 |
| A-03 | 工具停用（G4） | 停用后 agent 侧 tools/list 不再出现该工具，重新启用即恢复 |
| A-04 | 崩溃自愈（G2） | 杀上游进程 ≤ 退避周期内恢复，期间错误可感知、之后调用成功 |
| A-05 | 内存预算（§4.1） | 1 小时浸泡（周期 call）RSS ≤ 100MB 且无持续增长趋势（<20MB 漂移） |
| A-06 | 性能预算 | 冷启动 ≤ 500ms；转发附加延迟 p99 ≤ 5ms（基准 harness 出数） |
| A-07 | 安全（G9） | 非 loopback 拒绝绑定；无/错 token 均 401；日志与备份中无密钥 |
| A-08 | 恢复流程 | 从 backups 恢复某 agent 配置后 agent 正常启动（先做，再允许 A-01） |
| A-09 | TOML 保真（R2） | Codex config.toml 手工注释在同步后非托管区原样保留 |
| A-10 | 退场清洁 | 停用全部绑定后，各 agent 配置合法且与安装前语义等价 |

### 4.3 覆盖率与质量门槛

行覆盖：core ≥ 90%，server/gateway ≥ 85%，全局 ≥ 80%；CI 卡门槛。产出《验收报告》：A 矩阵逐项 pass/fail + 性能数据 + 已知问题清单。

---

## 阶段五：浏览器 Web UI 测试

双轨：**Playwright 自动化（回归）+ 浏览器交互式黑盒验收（体验）**。

### 5.1 自动化（Playwright，chromium headless，CI 可跑）

环境：daemon 以 test 模式启动（沙箱 HOME、fixtures agent、fake stdio server）。用例：

| ID | 流程 |
|---|---|
| E-01 | 首启引导：探测卡片正确显示 3 个 fake agent |
| E-02 | 导入向导：勾选→入库→注册表出现 |
| E-03 | 绑定矩阵：切换勾选→dry-run diff 展示→确认同步→API/沙箱文件双重校验 |
| E-04 | Server 表单校验：坏 command/URL 的错误提示；成功创建出现在列表 |
| E-05 | 工具开关：停用后用 SDK client 验证 tools/list 已过滤 |
| E-06 | 网关页：启停、endpoint 复制、token 轮换后旧 token 401 |
| E-07 | 日志页：发起测试调用后条目实时出现 |
| E-08 | daemon 掉线：中途杀 daemon → UI 显示重连横幅，复活后自愈 |
| E-09 | 1280×800 与 1920×1080 两档布局冒烟 |

### 5.2 交互式黑盒验收（浏览器自动化 + 截图目检）

在 E2E 之外按真实用户视角走查：引导流程文案与心智、矩阵操作反馈速度感、表单错误文案质量、暗色/亮色一致性、加载/空态/错误态三态完整；截图留档进验收报告。通过标准：无阻断级 UI 缺陷、文案无歧义、任何操作失败都有可见可懂的反馈。

---

## 里程碑总览

| 阶段 | 产出 | 出口标准 |
|---|---|---|
| 一 技术设计 | 本文档 §1 + adapter-matrix 实测版 | 评审通过 |
| 二 测试设计 | 用例清单（本文档 §2，随实现细化） | 用例评审通过 |
| 三 编码实施 | M1.0–M1.7 全部 DoD 达成 | 全部 U/I 用例 CI 绿 |
| 四 测试验收 | 验收报告（A-01~10 + 性能/安全数据） | A 项全 pass 或带豁免记录 |
| 五 UI 测试 | E2E 套件绿 + 交互式走查记录 | §5.2 通过标准 |

---

## 附录 A：M2 执行计划（2026-10-09 启动）

M1 已提前完成 Trae/OpenCode 适配器、G6 per-server 端点、G11/S2/S3 日志与进程 UI、Web 管理界面。本迭代锁定范围：

| 里程碑 | 内容 | 说明 |
|---|---|---|
| M2.1 | **G7 stdio 反向桥**：`bridge-main.js` 独立桥进程（stdio ↔ streamable HTTP 透传）；同步引擎对不支持 http 的 agent（Codex）改写桥命令——网关模式与直连 http/sse server 均打通 | 替代原"unsupported 跳过"；bridge args 携带 token（进程列表可见为已知取舍，M3 凭证加密一并缓解） |
| M2.2 | **S5 环境检测**：node/npx/uvx/python/docker/git 探测（`/api/environment`）+ 概览卡片 + 注册表缺运行时警告 | |
| M2.3 | **SSE 上游兼容**（D4）：ServerDef.transport 增加 `sse`，网关经 SSEClientTransport 连接 legacy 上游；表单/分发适配 | agent 侧仍以 streamable HTTP 为主 |
| M2.4 | **token 轮换重同步提醒**：`tokenRotatedAt` 标记 + 网关页横幅，同步后清除（验收遗留项） | |
| M2.5 | **1 小时浸泡补测**（验收遗留项，后台执行） | |

### 附录 A.2：M3 执行计划（2026-10-09 启动）

| 里程碑 | 内容 | 备注 |
|---|---|---|
| M3.1 | **S6 调试台**：`POST /api/servers/:id/invoke` + 工具弹窗调试面板（JSON 参数 → 结果面板），调用记入日志（scope=debug） | |
| M3.2 | **G12 落地为并发度控制**：ServerDef.`concurrency`（1-16，默认 1=串行），Upstream 信号量限流 | 设计偏差说明：聚合端点为 stateless，无"客户端会话"概念，原"per-client 多实例"不可定义；并发度控制是同等风险（单会话上游保护）下更实用的形态 |
| M3.3 | **G13 per-agent 分组端点**：`/agents/:type/mcp` 只聚合该 agent 绑定的网关 server；同步写入分组 URL；工具索引按 scope 隔离 | |
| M3.4 | **S4 凭证加密**：Windows DPAPI（PowerShell ProtectedData，CurrentUser）加密 ServerDef.env/headers 静态数据（`dpapi:v1:` 前缀）；使用点透明解密；macOS/Linux 明文回退（M4 接 Keychain/libsecret） | 解密经 base64 传输规避控制台编码损坏 |
| M3.5 | **新增适配器**：Claude Desktop（分平台路径）/ Windsurf / Gemini CLI（httpUrl/sse 形态），共 8 个 agent | |
| M3.6 | **S7 registry 发现**：官方 registry 搜索代理 + 条目映射（streamable-http/sse/npm/pypi → ServerDef 建议）+「发现」页一键以网关模式添加 | 网络不可达时 502 优雅降级；映射逻辑单测覆盖 |

推迟到 M4：C7 项目级作用域、VS Code 适配器、macOS Keychain/Linux libsecret 加密后端、G12 per-client 隔离（若有状态上游需求）。 |

延续到 M3：G12 stdio 多实例隔离、G13 per-agent 分组端点、S4 凭证加密（DPAPI/Keychain）、registry 发现（S7）、调试台（S6）。
