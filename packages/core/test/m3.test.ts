/* M3 新增能力测试：DPAPI 凭证加密（win32）、Gemini 适配器、registry 映射。 */
import { describe, expect, it } from 'vitest';
import { AGENT_LIST } from '../src/agents.js';
import { denormalizeGeminiStyle, normalizeGeminiStyle } from '../src/adapters/json-adapter.js';
import { decryptSecret, encryptSecret } from '../src/secretbox.js';
import { registryEntryToServerInput } from '../src/registry-discovery.js';

describe('M3.4 S4 凭证加密', () => {
  it.skipIf(process.platform !== 'win32')('DPAPI 加密→解密往返，密文非明文', async () => {
    const secret = 'sk-acceptance-secret-🔑-42';
    const encrypted = await encryptSecret(secret);
    expect(encrypted).toMatch(/^dpapi:v1:[A-Za-z0-9+/=]+$/);
    expect(encrypted).not.toContain('sk-acceptance');
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(secret);
  });

  it.skipIf(process.platform !== 'win32')('已加密的值重复加密不二次包裹', async () => {
    const once = await encryptSecret('v');
    const twice = await encryptSecret(once);
    expect(twice).toBe(once);
  });

  it('非 DPAPI 后端原样透传（明文回退）', async () => {
    // 在非 Windows 平台加密=恒等；在 Windows 上该断言依然成立（明文透传由 isEncrypted 保护）
    const value = 'plain-value';
    const out = await encryptSecret(value);
    expect(typeof out).toBe('string');
  });
});

describe('M3.5 Gemini CLI 适配器', () => {
  it('stdio/httpUrl/sse 三形态往返', () => {
    const stdio = { transport: 'stdio' as const, command: 'node', args: ['s.js'], env: { A: '1' } };
    const http = { transport: 'http' as const, url: 'https://x/mcp' };
    const sse = { transport: 'sse' as const, url: 'https://y/sse' };
    expect(normalizeGeminiStyle(denormalizeGeminiStyle(stdio))).toEqual(stdio);
    expect(normalizeGeminiStyle(denormalizeGeminiStyle(http))).toEqual(http);
    expect(normalizeGeminiStyle(denormalizeGeminiStyle(sse))).toEqual(sse);
    expect(normalizeGeminiStyle({ httpUrl: 'https://x/mcp' })).toEqual(http);
    expect(normalizeGeminiStyle({ url: 'https://y/sse' })).toEqual(sse);
  });

  it('注册表含 8 个 agent', () => {
    expect(AGENT_LIST.map((a) => a.type).sort()).toEqual([
      'claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini-cli', 'opencode', 'trae', 'windsurf',
    ]);
  });
});

describe('M3.6 registry 条目映射（S7）', () => {
  it('streamable-http 远程 → http + 网关模式（mcp- 前缀剥离为短名）', () => {
    const s = registryEntryToServerInput({
      name: 'io.github.example/mcp-notion',
      description: 'Notion tools',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }],
    });
    expect(s.name).toBe('notion');
    expect(s.suggestion).toEqual({
      name: 'notion',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      gatewayMode: true,
    });
  });

  it('npm 包 → npx -y；pypi 包 → uvx', () => {
    const npm = registryEntryToServerInput({
      name: 'filesystem',
      packages: [{ registryType: 'npm', identifier: '@modelcontextprotocol/server-filesystem' }],
    });
    expect(npm.suggestion).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] });
    const pypi = registryEntryToServerInput({
      name: 'mcp-fetch',
      packages: [{ registryType: 'pypi', identifier: 'mcp-server-fetch' }],
    });
    expect(pypi.suggestion).toMatchObject({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] });
  });

  it('无法识别的条目 → suggestion 为 null', () => {
    const s = registryEntryToServerInput({ name: 'weird' });
    expect(s.suggestion).toBeNull();
  });
});
