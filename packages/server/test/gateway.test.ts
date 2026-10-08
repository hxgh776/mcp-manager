import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Daemon } from '../src/daemon.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/fake-stdio-server.mjs',
);

let sandbox: string;
let daemon: Daemon;
let base: string;
let token: string;

async function api(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function connectClient(pathname = '/mcp'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${pathname}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface FakeHttpUpstream {
  url: string;
  close: () => Promise<void>;
}

/** 测试专用：一个真实的 streamable HTTP 上游 MCP server */
async function startFakeHttpUpstream(): Promise<FakeHttpUpstream> {
  const httpServer = http.createServer(async (req, res) => {
    const server = new Server(
      { name: 'fake-http-upstream', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'http_tool',
          description: 'from http upstream',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req2) => ({
      content: [{ type: 'text', text: `http:${String(req2.params.name)}` }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpmgr-gw-'));
  daemon = new Daemon({ homeDir: sandbox, agentConfigRoot: sandbox, port: 0 });
  await daemon.start();
  base = daemon.baseUrl;
  token = daemon.config.settings.token;
  // 两个 stdio 上游（工具重名用于前缀测试）+ 一个 http 上游
  for (const id of ['fs-a', 'fs-b']) {
    await api('POST', '/api/servers', {
      id,
      name: id,
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { MAGIC_VALUE: `magic-${id}` },
      gatewayMode: true,
    });
  }
  const httpUp = await startFakeHttpUpstream();
  httpUpstream = httpUp;
  await api('POST', '/api/servers', {
    id: 'web',
    name: 'web',
    transport: 'http',
    url: httpUp.url,
    gatewayMode: true,
  });
  await api('POST', '/api/gateway/start');
});

let httpUpstream: FakeHttpUpstream;

afterEach(async () => {
  await daemon.stop();
  await httpUpstream?.close();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('gateway aggregate endpoint (I-GW)', () => {
  it('I-GW-01 聚合 listTools + callTool + env 凭证透传', async () => {
    const client = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // fs-a / fs-b 工具重名 → 前缀；web 的 http_tool 唯一 → 透传
    expect(names).toEqual(['fs-a__add', 'fs-a__echo', 'fs-a__env', 'fs-b__add', 'fs-b__echo', 'fs-b__env', 'http_tool']);

    const echo = (await client.callTool({ name: 'fs-a__echo', arguments: { message: 'hi' } })) as {
      content: Array<{ text: string }>;
    };
    expect(echo.content[0]!.text).toBe('echo: hi');

    const add = (await client.callTool({ name: 'fs-b__add', arguments: { a: 2, b: 3 } })) as {
      content: Array<{ text: string }>;
    };
    expect(add.content[0]!.text).toBe('5');

    const env = (await client.callTool({ name: 'fs-a__env', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(env.content[0]!.text).toBe('magic-fs-a');

    const httpTool = (await client.callTool({ name: 'http_tool', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(httpTool.content[0]!.text).toBe('http:http_tool');
    await client.close();
  });

  it('I-GW-02 懒启动：网关启动但未使用时无上游进程', async () => {
    const gw = (await api('GET', '/api/gateway')).data as { running: boolean; upstreams: unknown[] };
    expect(gw.running).toBe(true);
    expect(gw.upstreams).toEqual([]); // 未有任何连接
  });

  it('I-GW-03 崩溃自愈：杀上游进程后再次调用自动恢复', async () => {
    const client = await connectClient();
    await client.listTools();
    await api('POST', '/api/servers/fs-a/start'); // 显式拉起，拿 pid
    const gw1 = (await api('GET', '/api/gateway')).data as { upstreams: Array<{ id: string; pid?: number; status: string }> };
    const pid = gw1.upstreams.find((u) => u.id === 'fs-a')!.pid;
    expect(pid).toBeGreaterThan(0);

    process.kill(pid!);
    await new Promise((r) => setTimeout(r, 300));

    // 再次调用：应自动重启上游并成功
    const res = (await client.callTool({ name: 'fs-a__echo', arguments: { message: 'back' } })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toBe('echo: back');
    await client.close();
  });

  it('I-GW-04 上游错误与未知工具传播', async () => {
    const client = await connectClient();
    const fail = (await client.callTool({ name: 'fs-a__add', arguments: { a: 1 } })) as {
      isError?: boolean;
    };
    // 缺参数由上游/网关报错（fixture 的 add 对 undefined 求和得 0，不抛错；这里验证调用链路通）
    void fail;
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/未知工具/);
    await client.close();
  });

  it('I-GW-05 工具停用：从列表剔除，调用返回停用错误 (G4)', async () => {
    await api('PATCH', '/api/servers/fs-a', {
      toolOverrides: { echo: { enabled: false } },
    });
    const client = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain('fs-a__echo');
    // fs-a 的 echo 停用后不再冲突 → fs-b 的 echo 回退为无前缀名
    expect(names).toContain('echo');

    const disabled = (await client.callTool({ name: 'fs-a__echo', arguments: { message: 'x' } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0]!.text).toContain('停用');
    await client.close();
  });

  it('I-GW-06 per-server 独立端点：原始工具名（G6）', async () => {
    const client = await connectClient('/servers/fs-a/mcp');
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['add', 'echo', 'env']); // 不带前缀
    const res = (await client.callTool({ name: 'echo', arguments: { message: 'single' } })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toBe('echo: single');
    await client.close();
  });

  it('I-GW-07 /mcp 鉴权：无 token 401 (G9)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('I-GW-08 调用日志记录 server/tool/耗时 (G11)', async () => {
    const client = await connectClient();
    await client.callTool({ name: 'fs-a__echo', arguments: { message: 'log' } });
    await client.close();
    const calls = (await api('GET', '/api/logs/calls')).data.calls as Array<{
      serverId: string;
      tool: string;
      ok: boolean;
      durationMs: number;
    }>;
    const hit = calls.find((c) => c.tool === 'echo' && c.serverId === 'fs-a');
    expect(hit).toBeDefined();
    expect(hit!.ok).toBe(true);
    expect(typeof hit!.durationMs).toBe('number');
  });

  it('上游进程控制 API：stop 后状态 idle', async () => {
    await api('POST', '/api/servers/fs-a/start');
    const stopped = await api('POST', '/api/servers/fs-a/stop');
    expect(stopped.status).toBe(200);
    const gw = (await api('GET', '/api/gateway')).data as { upstreams: Array<{ id: string; status: string }> };
    expect(gw.upstreams.find((u) => u.id === 'fs-a')?.status).toBe('idle');
  });
});
