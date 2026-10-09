import type { UpsertServerInput } from './registry.js';

/** M3.6 S7：官方 MCP Registry（registry.modelcontextprotocol.io）条目 → 本注册表输入的映射 */

export interface RegistryRemote {
  type?: string;
  url?: string;
}

export interface RegistryPackage {
  registryType?: string;
  registry_name?: string;
  identifier?: string;
  name?: string;
  version?: string;
}

export interface RegistryServerEntry {
  name?: string;
  description?: string;
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}

export interface RegistrySuggestion {
  name: string;
  description: string;
  suggestion: UpsertServerInput | null;
  /** 结果来源：official=官方 registry；npm=npm 搜索回退 */
  source?: 'official' | 'npm';
}

export function registryEntryToServerInput(entry: RegistryServerEntry): RegistrySuggestion {
  const name = shortName(entry.name ?? '');
  const description = entry.description ?? '';
  // 1) 远程端点优先：streamable-http > sse
  const remote = (entry.remotes ?? []).find((r) => r.type === 'streamable-http') ??
    (entry.remotes ?? []).find((r) => r.type === 'sse') ??
    (entry.remotes ?? [])[0];
  if (remote?.url) {
    const transport = remote.type === 'sse' ? 'sse' : 'http';
    return {
      name,
      description,
      suggestion: {
        name,
        transport,
        url: remote.url,
        gatewayMode: true,
      },
    };
  }
  // 2) 包：npm → npx；pypi → uvx
  const pkg = (entry.packages ?? [])[0];
  const pkgName = pkg?.identifier ?? pkg?.name;
  if (pkg !== undefined && pkgName !== undefined) {
    const registryType = (pkg.registryType ?? pkg.registry_name ?? 'npm').toLowerCase();
    if (registryType === 'npm') {
      return {
        name,
        description,
        suggestion: { name, transport: 'stdio', command: 'npx', args: ['-y', pkgName], gatewayMode: true },
      };
    }
    if (registryType === 'pypi') {
      return {
        name,
        description,
        suggestion: { name, transport: 'stdio', command: 'uvx', args: [pkgName], gatewayMode: true },
      };
    }
  }
  return { name, description, suggestion: null };
}

/** registry 全名形如 com.github/user/pkg 或 io.github.user/pkg → 取尾段作展示名/id 基础 */
function shortName(full: string): string {
  const base = full.split('/').at(-1) ?? full;
  return base.replace(/^mcp-/, '') || full;
}

/**
 * npm 搜索回退（官方 registry API 在部分网络不可达时）：
 * registry.npmjs.org / registry.npmmirror.com 的 -/v1/search 结果 → 建议（npx 型，网关模式）。
 */
export function npmSearchToSuggestions(
  data: { objects?: Array<{ package?: { name?: string; description?: string; version?: string } }> },
): RegistrySuggestion[] {
  const out: RegistrySuggestion[] = [];
  for (const obj of data.objects ?? []) {
    const pkg = obj.package;
    if (pkg?.name === undefined) continue;
    out.push({
      name: pkg.name,
      description: [pkg.description, pkg.version !== undefined ? `v${pkg.version}` : '']
        .filter((s) => s !== undefined && s !== '')
        .join(' · '),
      suggestion: {
        name: pkg.name,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', pkg.name],
        gatewayMode: true,
      },
      source: 'npm',
    });
  }
  return out;
}
