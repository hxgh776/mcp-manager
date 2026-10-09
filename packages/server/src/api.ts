import { randomBytes } from 'node:crypto';
import {
  applyImport,
  decryptRecord,
  deleteServer,
  detectEnvironment,
  encryptRecord,
  importPreview,
  npmSearchToSuggestions,
  registryEntryToServerInput,
  removeBinding,
  setBinding,
  upsertServer,
} from '@mcp-manager/core';
import type { AgentType, ServerDef, UpsertServerInput } from '@mcp-manager/core';
import { z } from 'zod';
import type { Daemon } from './daemon.js';
import { sendError, sendJson } from './http-util.js';
import type { Router } from './router.js';

const serverInputObject = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  gatewayMode: z.boolean().optional(),
  enabled: z.boolean().optional(),
  toolOverrides: z.record(z.object({ enabled: z.boolean() })).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});

/** 创建/整体更新：传输类型与必需字段匹配 */
const serverInputSchema = serverInputObject.superRefine((val, ctx) => {
  if (val.transport === 'stdio' && !val.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio 传输需要 command', path: ['command'] });
  }
  if (val.transport === 'http' && !val.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http 传输需要 url', path: ['url'] });
  }
});

/** 表单字段的中文显示名（Issue-2：校验错误对用户友好） */
const FIELD_ZH: Record<string, string> = {
  id: 'ID',
  name: '名称',
  transport: '传输类型',
  command: '命令',
  args: '参数',
  env: '环境变量',
  cwd: '工作目录',
  url: 'URL',
  headers: '请求头',
  gatewayMode: '网关模式',
  enabled: '启用',
  toolOverrides: '工具开关',
};

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join('.');
      const zh = FIELD_ZH[field] ?? field ?? '';
      let msg = issue.message;
      if (issue.code === 'too_small' && (issue as { type?: string }).type === 'string') msg = '不能为空';
      else if (issue.code === 'invalid_string') msg = '格式不正确';
      else if (issue.code === 'invalid_type') msg = '类型不正确';
      return zh !== '' ? `${zh}：${msg}` : msg;
    })
    .join('；');
}

export function registerApiRoutes(router: Router, daemon: Daemon): void {
  const save = () => daemon.saveConfig();

  router.get('/api/status', async (ctx) => {
    await daemon.agentDetections();
    sendJson(ctx.res, 200, {
      version: version(),
      uptimeSec: daemon.uptimeSec(),
      homeDir: daemon.store.homeDir,
      port: daemon.actualPort,
      configuredPort: daemon.config.settings.port,
      gateway: daemon.gatewayStatus(),
      serverCount: daemon.config.servers.length,
      bindingCount: daemon.config.bindings.length,
      resyncPending: daemon.config.settings.tokenRotatedAt !== undefined,
      authRequired: daemon.config.settings.authRequired === true,
    });
  });

  // D7：公开探测端点（免鉴权，由 daemon.handle 放行）——UI 用它决定是否显示令牌门
  router.get('/api/auth/info', async (ctx) => {
    sendJson(ctx.res, 200, { authRequired: daemon.config.settings.authRequired === true });
  });

  // M2.2：本机 server 运行时探测
  router.get('/api/environment', async (ctx) => {
    sendJson(ctx.res, 200, { tools: await detectEnvironment() });
  });

  router.get('/api/agents', async (ctx) => {
    const detections = await daemon.agentDetections(ctx.query.get('refresh') === '1');
    const byType = new Map(detections.map((d) => [d.agentType, d]));
    sendJson(ctx.res, 200, {
      agents: detections.map((d) => ({
        ...d,
        syncState: daemon.config.syncState[d.agentType] ?? null,
        boundServerIds: daemon.config.bindings
          .filter((b) => b.agentType === d.agentType)
          .map((b) => b.serverId),
      })),
      types: [...byType.keys()],
    });
  });

  // —— 注册表 CRUD ——
  // S4：env/headers 静态加密（存时加密、读时解密；保护 config.json 落盘）
  const decryptForDisplay = async (def: ServerDef): Promise<ServerDef> => ({
    ...def,
    env: { ...(await decryptRecord(def.env)) },
    headers: { ...(await decryptRecord(def.headers)) },
  });

  router.get('/api/servers', async (ctx) => {
    const servers = await Promise.all(daemon.config.servers.map((s) => decryptForDisplay(s)));
    sendJson(ctx.res, 200, { servers });
  });

  router.post('/api/servers', async (ctx) => {
    const parsed = serverInputSchema.safeParse(await ctx.body());
    if (!parsed.success) return sendError(ctx.res, 400, formatZodIssues(parsed.error));
    const input = parsed.data as UpsertServerInput;
    input.env = await encryptRecord(input.env);
    input.headers = await encryptRecord(input.headers);
    const def = upsertServer(daemon.config, input);
    await save();
    sendJson(ctx.res, 201, { server: await decryptForDisplay(def) });
  });

  router.get('/api/servers/:id', async (ctx) => {
    const def = daemon.config.servers.find((s) => s.id === ctx.params['id']);
    if (!def) return sendError(ctx.res, 404, 'server 不存在');
    sendJson(ctx.res, 200, { server: await decryptForDisplay(def) });
  });

  router.patch('/api/servers/:id', async (ctx) => {
    const id = ctx.params['id']!;
    const def = daemon.config.servers.find((s) => s.id === id);
    if (!def) return sendError(ctx.res, 404, 'server 不存在');
    const parsed = serverInputObject.partial().safeParse(await ctx.body());
    if (!parsed.success) return sendError(ctx.res, 400, formatZodIssues(parsed.error));
    const input = parsed.data as UpsertServerInput;
    input.env = await encryptRecord(input.env);
    input.headers = await encryptRecord(input.headers);
    upsertServer(daemon.config, { ...input, id, name: input.name ?? def.name, transport: input.transport ?? def.transport });
    await save();
    sendJson(ctx.res, 200, { server: await decryptForDisplay(daemon.config.servers.find((s) => s.id === id)!) });
  });

  router.delete('/api/servers/:id', async (ctx) => {
    const id = ctx.params['id']!;
    const def = daemon.config.servers.find((s) => s.id === id);
    if (!def) return sendError(ctx.res, 404, 'server 不存在');
    deleteServer(daemon.config, id);
    await save();
    sendJson(ctx.res, 200, { ok: true });
  });

  // —— 绑定 ——
  router.put('/api/bindings/:agentType/:serverId', async (ctx) => {
    const agentType = ctx.params['agentType']!;
    const serverId = ctx.params['serverId']!;
    try {
      setBinding(daemon.config, serverId, agentType as AgentType);
    } catch (err) {
      return sendError(ctx.res, 404, String((err as Error).message));
    }
    await save();
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/bindings/:agentType/:serverId', async (ctx) => {
    const agentType = ctx.params['agentType']!;
    const serverId = ctx.params['serverId']!;
    removeBinding(daemon.config, serverId, agentType as AgentType);
    await save();
    sendJson(ctx.res, 200, { ok: true });
  });

  // —— 分发 ——
  router.post('/api/sync', async (ctx) => {
    const body = (await ctx.body()) as { dryRun?: boolean; resolutions?: Record<string, 'override' | 'skip'> };
    const report = await daemon.sync.sync(daemon.config, {
      dryRun: body.dryRun === true,
      resolutions: body.resolutions,
    });
    if (body.dryRun !== true) await save();
    sendJson(ctx.res, 200, { report });
  });

  // —— 导入 ——
  router.get('/api/import/preview', async (ctx) => {
    const groups = await importPreview();
    // 标注已存在于注册表的指纹
    const existing = new Set(
      daemon.config.servers.map((s) =>
        s.transport === 'stdio' ? `stdio|${s.command}|${(s.args ?? []).join(' ')}` : `${s.transport}|${s.url}`,
      ),
    );
    sendJson(ctx.res, 200, {
      groups: groups.map((g) => ({ ...g, alreadyImported: existing.has(g.fingerprint) })),
    });
  });

  router.post('/api/import', async (ctx) => {
    const body = (await ctx.body()) as { fingerprints?: string[] };
    const fingerprints = new Set(body.fingerprints ?? []);
    const groups = (await importPreview()).filter((g) => fingerprints.has(g.fingerprint));
    const added = applyImport(daemon.config, groups);
    await save();
    sendJson(ctx.res, 200, { added });
  });

  // —— 进程与工具（M1.5 网关注入实现；此前 503） ——
  router.add('POST', '/api/servers/:id/start', async (ctx) => controlUpstream(daemon, ctx, 'start'));
  router.add('POST', '/api/servers/:id/stop', async (ctx) => controlUpstream(daemon, ctx, 'stop'));
  router.add('POST', '/api/servers/:id/restart', async (ctx) => controlUpstream(daemon, ctx, 'restart'));
  router.get('/api/servers/:id/tools', async (ctx) => {
    const id = ctx.params['id']!;
    if (!daemon.gatewayControl) return sendError(ctx.res, 503, 'gateway 未启用', 'GATEWAY_DOWN');
    const tools = await daemon.probeTools?.(id);
    if (!tools) return sendError(ctx.res, 502, '无法连接上游或工具列表为空');
    sendJson(ctx.res, 200, { tools });
  });
  router.get('/api/servers/:id/logs', async (ctx) => {
    const id = ctx.params['id']!;
    sendJson(ctx.res, 200, { lines: daemon.upstreamLogs?.(id) ?? [] });
  });

  // M3.1 调试台（S6）：不经 agent 直接调用工具
  router.post('/api/servers/:id/invoke', async (ctx) => {
    const id = ctx.params['id']!;
    const body = (await ctx.body()) as { tool?: string; arguments?: Record<string, unknown> };
    if (!body.tool) return sendError(ctx.res, 400, '缺少 tool');
    if (!daemon.config.servers.some((s) => s.id === id)) {
      return sendError(ctx.res, 404, 'server 不存在');
    }
    if (daemon.invokeTool === undefined) return sendError(ctx.res, 503, 'gateway 未启用', 'GATEWAY_DOWN');
    try {
      const result = await daemon.invokeTool(id, body.tool, body.arguments ?? {});
      sendJson(ctx.res, 200, { result });
    } catch (err) {
      sendError(ctx.res, 502, String((err as Error).message ?? err));
    }
  });

  // —— 日志 ——
  router.get('/api/logs/calls', async (ctx) => {
    sendJson(ctx.res, 200, { calls: daemon.recentCalls?.() ?? [] });
  });

  // —— 设置 ——
  router.get('/api/settings', async (ctx) => {
    sendJson(ctx.res, 200, {
      port: daemon.config.settings.port,
      logLevel: daemon.config.settings.logLevel,
      authRequired: daemon.config.settings.authRequired === true,
    });
  });

  router.get('/api/settings/token', async (ctx) => {
    sendJson(ctx.res, 200, { token: daemon.config.settings.token });
  });

  router.patch('/api/settings', async (ctx) => {
    const body = (await ctx.body()) as { port?: number; logLevel?: string; authRequired?: boolean };
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        return sendError(ctx.res, 400, '端口非法');
      }
      daemon.config.settings.port = body.port;
    }
    if (body.logLevel !== undefined) {
      if (!['debug', 'info', 'warn', 'error'].includes(body.logLevel)) {
        return sendError(ctx.res, 400, '日志级别非法');
      }
      daemon.config.settings.logLevel = body.logLevel as 'debug' | 'info' | 'warn' | 'error';
      daemon.logger.setLevel(daemon.config.settings.logLevel);
    }
    if (body.authRequired !== undefined) {
      daemon.config.settings.authRequired = body.authRequired;
      // D7：开关切换后，已分发的网关配置形态（是否带凭证）与注册表不一致——提示重新同步
      if (daemon.config.bindings.length > 0) {
        daemon.config.settings.tokenRotatedAt = new Date().toISOString();
      }
    }
    await save();
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/settings/token/rotate', async (ctx) => {
    daemon.config.settings.token = randomBytes(24).toString('hex');
    // M2.4：仅在令牌启用时标记待重同步（关闭时网关条目不含 token，轮换无分发影响）
    const authOn = daemon.config.settings.authRequired === true;
    if (authOn && daemon.config.bindings.length > 0) {
      daemon.config.settings.tokenRotatedAt = new Date().toISOString();
    }
    await save();
    sendJson(ctx.res, 200, {
      token: daemon.config.settings.token,
      resyncRequired: authOn && daemon.config.bindings.length > 0,
    });
  });

  // M3.6 S7：registry 搜索——官方源优先，不可达时自动回退 npm 搜索
  const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io';
  router.get('/api/registry/search', async (ctx) => {
    const q = ctx.query.get('q')?.trim() ?? '';
    if (q === '') return sendError(ctx.res, 400, '缺少搜索词 q');
    const base = daemon.config.settings.registryBaseUrl?.trim() || OFFICIAL_REGISTRY;
    const failures: string[] = [];

    try {
      const res = await fetch(
        `${base}/v0/servers?search=${encodeURIComponent(q)}&limit=20`,
        { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } },
      );
      if (!res.ok) {
        failures.push(`官方 registry(${base}) 返回 ${res.status}`);
      } else {
        const data = (await res.json()) as { servers?: Array<Record<string, unknown>> };
        const entries = (data.servers ?? []).map((e) => (e['server'] ?? e) as Record<string, unknown>);
        const servers = entries.map((e) => {
          const s = registryEntryToServerInput(e);
          return { ...s, source: 'official' as const };
        });
        return sendJson(ctx.res, 200, { servers, source: 'official' });
      }
    } catch (err) {
      failures.push(`官方 registry(${base}) 不可达: ${String((err as Error).message ?? err).slice(0, 80)}`);
    }

    // 回退：npm 搜索（registry.npmjs.org 的 -/v1/search）
    try {
      const res = await fetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=20`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) {
        failures.push(`npm 搜索返回 ${res.status}`);
      } else {
        const data = (await res.json()) as Parameters<typeof npmSearchToSuggestions>[0];
        return sendJson(ctx.res, 200, { servers: npmSearchToSuggestions(data), source: 'npm', notes: failures });
      }
    } catch (err) {
      failures.push(`npm 搜索不可达: ${String((err as Error).message ?? err).slice(0, 80)}`);
    }

    sendError(
      ctx.res,
      502,
      `所有数据源均不可达（${failures.join('；')}）。官方 registry 可能需要网络代理，或在设置中配置镜像地址。`,
    );
  });

  // —— 网关 ——
  router.get('/api/gateway', async (ctx) => {
    sendJson(ctx.res, 200, {
      ...daemon.gatewayStatus(),
      upstreams: daemon.gateway.upstreamSnapshots(),
    });
  });

  router.post('/api/gateway/start', async (ctx) => {
    if (!daemon.gatewayControl) return sendError(ctx.res, 503, 'gateway 模块未加载', 'GATEWAY_DOWN');
    sendJson(ctx.res, 200, await daemon.gatewayControl('start'));
  });

  router.post('/api/gateway/stop', async (ctx) => {
    if (!daemon.gatewayControl) return sendError(ctx.res, 503, 'gateway 模块未加载', 'GATEWAY_DOWN');
    sendJson(ctx.res, 200, await daemon.gatewayControl('stop'));
  });
}

function controlUpstream(
  daemon: Daemon,
  ctx: Parameters<Parameters<Router['add']>[2]>[0],
  action: 'start' | 'stop' | 'restart',
): void {
  const id = ctx.params['id']!;
  if (!daemon.config.servers.some((s) => s.id === id)) {
    sendError(ctx.res, 404, 'server 不存在');
    return;
  }
  if (!daemon.upstreamControl) {
    sendError(ctx.res, 503, 'gateway 未启用', 'GATEWAY_DOWN');
    return;
  }
  void daemon
    .upstreamControl(id, action)
    .then((r) => sendJson(ctx.res, 200, r))
    .catch((err) => sendError(ctx.res, 500, String(err)));
}

function version(): string {
  return '0.1.0';
}
