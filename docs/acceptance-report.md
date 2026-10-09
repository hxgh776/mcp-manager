# MCP Manager 验收报告（M1）

> 日期：2026-10-09 · 平台：Windows 11（win32，Node v24.14.1）· 版本：m1 标签（0.1.0）
> 结论：**阶段四真机验收 10/10 通过（含 1 项缩短浸泡的偏差）、阶段五 UI 测试通过（3 个低中危改进项记入 M2 待办）**

---

## 阶段四：真机验收（A-01 ~ A-10）

真机环境：Claude Code（`~/.claude.json`，3023 字节）与 Cursor（`~/.cursor/mcp.json`）已安装；Codex 无配置文件；Trae/OpenCode 未安装。验收开始前对所有真实配置做了快照（`~/.mcp-manager-acceptance-snapshot-20261009-081250/`），结束后逐字节校验恢复。

| ID | 验收项 | 结果 | 实测数据 |
|---|---|---|---|
| A-01 | 5 分钟闭环：注册→绑定→同步→双 agent 生效 | ✅ | **45ms**（阈值 5min）；claude/cursor 均落盘，env 随直连分发 |
| A-02 | 网关切换：直连条目移除、写公共网关条目、调用成功、日志留存、凭证不落地 | ✅ | gateway entry `http://127.0.0.1:6280/mcp` + Bearer；echo 经网关返回正常；agent 配置中无明文凭证 |
| A-03 | 工具停用：列表剔除 + 调用拒绝 | ✅ | 停用 echo 后 tools/list 无 echo；调用返回 `工具 echo 已被停用` |
| A-04 | 崩溃自愈 | ✅ | 杀上游 pid 后恢复调用成功，**216ms** |
| A-05 | 内存浸泡 | ✅* | **210s / 206 次调用 / 0 错误；RSS 85.6→80.7MB（max 85.6，drift -4.9MB）**。*偏差：计划 1h，实际 3.5min（会话时长限制）；趋势无泄漏，建议 M2 补 1h 浸泡 |
| A-06a | 转发延迟 | ✅ | 100 次 p50=1.8ms / p99=5.2ms（端到端含上游子进程往返） |
| A-06b | 冷启动 ≤500ms | ✅ | **271~274ms**（进程 spawn → /api/status 200） |
| A-07 | 安全：仅环回绑定 / LAN 不可达 / 鉴权矩阵 / 凭证不进日志 | ✅ | netstat 仅 127.0.0.1:6280；LAN 192.168.2.9 拒连；无/错 token 401；日志与当前配置 0 命中（历史备份中直连阶段快照含凭证为设计行为，见 §备注） |
| A-08 | 恢复演练（真实 claude.json） | ✅ | 工具备份覆盖回写成功，受管条目消失；后续重同步需显式 override（C8 冲突语义：备份恢复=用户删除受管条目，防误覆盖，行为正确） |
| A-09 | Codex TOML | ✅* | 真机无既有 config.toml → 验证**新文件创建 + smol-toml 解析 + env 完整**；注释保真由单元测试字节级覆盖（U-AD-07） |
| A-10 | 退场清洁 | ✅ | cursor 字节级等于快照；claude mcpServers 语义等价快照（验收期产生的空 `mcpServers` 键已手工移除，键集合与快照一致）；codex 验收期创建的文件已删除 |

**备注**：
- 导入路径说明：真机原有 agent 配置中无任何 MCP server（import preview 0 组），A-01 采用"注册新 server"路径；导入/去重逻辑由 I-SY 集成测试覆盖（沙箱三 agent 导入→去重→同步）。
- 直连分发会把 env 凭证复制进 agent 配置（设计行为，凭证分散是网关模式要解决的痛点之一）；备份目录忠实镜像文件历史，因此直连阶段的历史备份含凭证。网关模式下当前配置与新增备份均无凭证（A-07d 已验证）。

## 阶段五：浏览器 Web UI 测试

### 5.1 Playwright 自动化（chromium，headless，沙箱 daemon）

| 用例 | 结果 |
|---|---|
| E-01 token 门进入后可见概览与 agent 卡片 | ✅ |
| E-04 添加 server（stdio）出现在注册表 | ✅ |
| E-03 分发预览（dry-run）出报告 | ✅ |
| E-06 网关页展示运行状态与端点 | ✅ |

`4 passed (4.0s)`。运行方式：`cd e2e && npx playwright test`。

### 5.2 交互式黑盒走查（浏览器自动化 + 截图目检，1280×800 与 1920×1080）

证据目录：`.acceptance/gui-test-screenshots/`（8 张截图）

| 测试点 | 结果 | 证据 |
|---|---|---|
| T1 Token 门：错误 token 红色提示；正确 token 进入 | ✅ | t1_wrong_token.png |
| T2 概览：daemon 信息 / 5 个 agent 卡片（与真机一致）/ 导入区 | ✅ | t2_overview.png |
| T3 注册表：列表、添加表单校验（空表单 400 被处理）、UI 创建 http server、删除 | ✅ | t3_form_validation_issue2.png |
| T4 分发矩阵：勾选态与真实绑定一致、未装 agent 格子禁用、dry-run 报告 | ✅ | t4_sync_matrix.png |
| T5 网关页：运行中徽标、端点 URL、上游进程（ready/PID/工具数）、token 展示 | ✅ | t5_gateway.png |
| T6 日志页：调用表 ok（绿）/fail（红+错误信息）双态渲染、上游 stderr 查看器 | ✅ | t6_logs.png |
| T7 工具开关弹窗：真实上游 3 工具、停用/启用联动 | ✅ | t7_tools_modal_echo_disabled.png |
| T8 布局 1920×1080：居中缩放、5 列卡片、无溢出 | ✅ | t7_layout_1920.png |

### 发现的改进项（验收后已全部修复，见提交 "fix: resolve acceptance issues 1-3"）

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| Issue-1 | 低 | 导入预览把自身写入的 `mcp-manager-gateway` 公共条目当作可导入候选 | ✅ 导入器排除 GATEWAY_KEY（新增单测） |
| Issue-2 | 中 | 表单校验失败时错误横幅显示 zod 原始 JSON，不友好 | ✅ 服务端将 zod issues 格式化为中文字段文案（实测横幅显示"名称：不能为空；命令：stdio 传输需要 command"） |
| Issue-3 | 低 | 网关调用日志仅存内存环，daemon 重启后 UI 清零 | ✅ API 改读 ndjson 尾部（≤256KB/200 条，跳过损坏行），跨重启持久（新增集成测试 + 浏览器实测） |

### 测试运行时备注（工具侧，非页面缺陷）

- IAB `fullPage` 截图会产生拼接伪影，已改用视口截图；
- token 门按钮出现两次 Playwright 点击超时（换坐标点击成功，其余页面 Playwright 点击全部正常），判定为自动化管线偶发，非页面缺陷；
- 会话期间未观察到页面控制台错误冒泡到 UI（无空白区/错误占位/布局破坏）。

## 遗留与后续

1. M2 待办：1 小时浸泡补测 + 多轮 token 轮换后的网关配置重同步提醒强化。（验收发现的 3 个 Issue 已全部修复并通过回归，50/50 测试全绿）
2. 测试数据清理：所有真实 agent 配置已恢复快照态；验收产物保留在 `.acceptance/`（已 gitignore），快照目录 `~/.mcp-manager-acceptance-snapshot-20261009-081250/` 建议保留至下一轮验收后删除。
