import { randomBytes } from 'node:crypto';
import {
  applyImport,
  deleteServer,
  importPreview,
  removeBinding,
  setBinding,
  upsertServer,
} from '@mcp-manager/core';
import type { AgentType, UpsertServerInput } from '@mcp-manager/core';
import { z } from 'zod';
import type { Daemon } from './daemon.js';
import { sendError, sendJson } from './http-util.js';
import type { Router } from './router.js';

const serverInputObject = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  gatewayMode: z.boolean().optional(),
  enabled: z.boolean().optional(),
  toolOverrides: z.record(z.object({ enabled: z.boolean() })).optional(),
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
    });
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
  router.get('/api/servers', async (ctx) => {
    sendJson(ctx.res, 200, { servers: daemon.config.servers });
  });

  router.post('/api/servers', async (ctx) => {
    const parsed = serverInputSchema.safeParse(await ctx.body());
    if (!parsed.success) return sendError(ctx.res, 400, parsed.error.message);
    const def = upsertServer(daemon.config, parsed.data as UpsertServerInput);
    await save();
    sendJson(ctx.res, 201, { server: def });
  });

  router.get('/api/servers/:id', async (ctx) => {
    const def = daemon.config.servers.find((s) => s.id === ctx.params['id']);
    if (!def) return sendError(ctx.res, 404, 'server 不存在');
    sendJson(ctx.res, 200, { server: def });
  });

  router.patch('/api/servers/:id', async (ctx) => {
    const id = ctx.params['id']!;
    const def = daemon.config.servers.find((s) => s.id === id);
    if (!def) return sendError(ctx.res, 404, 'server 不存在');
    const parsed = serverInputObject.partial().safeParse(await ctx.body());
    if (!parsed.success) return sendError(ctx.res, 400, parsed.error.message);
    upsertServer(daemon.config, { ...parsed.data, id, name: parsed.data.name ?? def.name, transport: parsed.data.transport ?? def.transport });
    await save();
    sendJson(ctx.res, 200, { server: daemon.config.servers.find((s) => s.id === id) });
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

  // —— 日志 ——
  router.get('/api/logs/calls', async (ctx) => {
    sendJson(ctx.res, 200, { calls: daemon.recentCalls?.() ?? [] });
  });

  // —— 设置 ——
  router.get('/api/settings', async (ctx) => {
    sendJson(ctx.res, 200, {
      port: daemon.config.settings.port,
      logLevel: daemon.config.settings.logLevel,
    });
  });

  router.get('/api/settings/token', async (ctx) => {
    sendJson(ctx.res, 200, { token: daemon.config.settings.token });
  });

  router.patch('/api/settings', async (ctx) => {
    const body = (await ctx.body()) as { port?: number; logLevel?: string };
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
    await save();
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/settings/token/rotate', async (ctx) => {
    daemon.config.settings.token = randomBytes(24).toString('hex');
    await save();
    // 已分发的网关配置里的 token 失效——提示重新 sync
    sendJson(ctx.res, 200, { token: daemon.config.settings.token, resyncRequired: daemon.config.bindings.length > 0 });
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
