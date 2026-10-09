import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.js';
import { Store } from '@mcp-manager/core';

let sandbox: string;
let daemon: Daemon;
let base: string;
let token: string;

async function api(
  method: string,
  pathname: string,
  body?: unknown,
  useToken?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${useToken ?? token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpmgr-apitest-'));
  // 沙箱纪律：agent 配置也必须重定向，绝不触碰真实 agent 配置
  daemon = new Daemon({ homeDir: sandbox, agentConfigRoot: sandbox, port: 0 });
  await daemon.start();
  base = daemon.baseUrl;
  token = daemon.config.settings.token;
});

afterEach(async () => {
  await daemon.stop();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('auth (I-GW-07 部分)', () => {
  it('无 token / 错 token → 401；query token 放行', async () => {
    const noAuth = await fetch(`${base}/api/status`);
    expect(noAuth.status).toBe(401);
    const wrong = await api('GET', '/api/status', undefined, 'wrong-token');
    expect(wrong.status).toBe(401);
    const viaQuery = await fetch(`${base}/api/status?token=${token}`);
    expect(viaQuery.status).toBe(200);
  });
});

describe('registry CRUD (I-AP-01)', () => {
  it('创建→列表→PATCH→删除 全链路', async () => {
    const created = await api('POST', '/api/servers', {
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { FS_ROOT: 'D:\\x' },
    });
    expect(created.status).toBe(201);
    const id = (created.data.server as { id: string }).id;
    expect(id).toBe('filesystem');

    const listed = await api('GET', '/api/servers');
    expect((listed.data.servers as unknown[]).length).toBe(1);

    const patched = await api('PATCH', `/api/servers/${id}`, { gatewayMode: true });
    expect((patched.data.server as { gatewayMode: boolean }).gatewayMode).toBe(true);

    const toolOverride = await api('PATCH', `/api/servers/${id}`, {
      toolOverrides: { write_file: { enabled: false } },
    });
    expect(
      (toolOverride.data.server as { toolOverrides: Record<string, { enabled: boolean }> }).toolOverrides['write_file']
        ?.enabled,
    ).toBe(false);

    const dup = await api('POST', '/api/servers', { name: 'Filesystem', transport: 'stdio', command: 'npx' });
    expect((dup.data.server as { id: string }).id).toBe('filesystem-2');

    const removed = await api('DELETE', `/api/servers/${id}`);
    expect(removed.status).toBe(200);
    expect(((await api('GET', '/api/servers')).data.servers as unknown[]).length).toBe(1);

    const invalid = await api('POST', '/api/servers', { name: 'X', transport: 'stdio' });
    expect(invalid.status).toBe(400); // 缺 command
    // Issue-2：校验错误为友好中文文案，而非 zod 原始 JSON
    const msg = String(invalid.data.error);
    expect(msg).toContain('命令');
    expect(msg).toContain('stdio');
    expect(msg).not.toContain('too_small');
  });
});

describe('sync via API (I-SY over HTTP)', () => {
  it('dryRun 不落盘；真实同步写入沙箱配置', async () => {
    await api('POST', '/api/servers', {
      name: 'fs',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    await api('PUT', '/api/bindings/cursor/fs');

    const dry = await api('POST', '/api/sync', { dryRun: true });
    expect(dry.status).toBe(200);
    const cursorFile = path.join(sandbox, '.cursor', 'mcp.json');
    await expect(fs.access(cursorFile)).rejects.toThrow();

    const real = await api('POST', '/api/sync', {});
    expect(real.status).toBe(200);
    const doc = JSON.parse(await fs.readFile(cursorFile, 'utf8'));
    expect(doc.mcpServers['fs'].command).toBe('node');
  });
});

describe('agents + settings (I-AP-02)', () => {
  it('agents 探测结构与 settings 修改/token 轮换', async () => {
    const agents = await api('GET', '/api/agents');
    const list = agents.data.agents as Array<{ agentType: string; transports: string[] }>;
    expect(list.map((a) => a.agentType)).toContain('claude-code');

    const patched = await api('PATCH', '/api/settings', { logLevel: 'debug' });
    expect(patched.status).toBe(200);
    expect(((await api('GET', '/api/settings')).data as { logLevel: string }).logLevel).toBe('debug');

    const badPort = await api('PATCH', '/api/settings', { port: 99999 });
    expect(badPort.status).toBe(400);

    const rotate = await api('POST', '/api/settings/token/rotate');
    const newToken = (rotate.data as { token: string }).token;
    expect(newToken).not.toBe(token);
    // 旧 token 立即失效
    const oldAuth = await api('GET', '/api/status', undefined, token);
    expect(oldAuth.status).toBe(401);
    token = newToken;
  });
});

describe('gateway runtime switch', () => {
  it('/mcp 无 token → 401；网关停止后带 token 也 503', async () => {
    const noToken = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(noToken.status).toBe(401);
    const stopped = await api('POST', '/api/gateway/stop');
    expect(stopped.status).toBe(200);
    const down = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(down.status).toBe(503);
    expect(((await down.json()) as { code?: string }).code).toBe('GATEWAY_DOWN');
  });
});

describe('store round-trip through daemon', () => {
  it('配置变更被持久化，可被下一个 Store 实例读到', async () => {
    await api('POST', '/api/servers', { name: 'persist', transport: 'stdio', command: 'node' });
    const reloaded = await new Store(sandbox).load();
    expect(reloaded.servers.map((s) => s.id)).toContain('persist');
  });
});
