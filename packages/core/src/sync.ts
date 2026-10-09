import { AGENT_LIST } from './agents.js';
import { backupFile } from './backup.js';
import { decryptRecord } from './secretbox.js';
import type { AgentAdapter, ConflictInfo, ConflictResolution, FragmentWrite, RawServerEntry } from './adapters/types.js';
import { boundServers } from './registry.js';
import { AGENTS } from './agents.js';
import { GATEWAY_KEY } from './types.js';
import type {
  AgentSyncState,
  AgentType,
  ManagerConfig,
  ServerDef,
} from './types.js';
import { promises as fs } from 'node:fs';

/**
 * SyncEngine：把注册表 + 绑定矩阵落成各 agent 的配置变更（C3/C8）。
 *
 * - 直连 server → 按适配器写真实条目（键 = server.id）；
 * - gatewayMode server → http 能力 agent 写公共 GATEWAY_KEY 指向网关；
 * - 不支持 http 的 agent（如 Codex）→ G7 stdio 反向桥命令（桥 URL + token/headers）；
 * - 不再受管的片段（解绑/删除/直连转网关）按 syncState 收敛移除；
 * - 无桥可用且传输不支持 → 记入 unsupported 并跳过。
 */
export class SyncEngine {
  constructor(
    private readonly opts: {
      backupsDir?: string;
      agents?: Record<AgentType, { adapter: AgentAdapter }>;
      /** G7 stdio 反向桥：command + 固定前缀参数（bridge-main.js 路径），daemon 按自身安装路径注入 */
      stdioBridge?: { command: string; baseArgs: string[] };
    } = {},
  ) {}

  async sync(config: ManagerConfig, input: { dryRun?: boolean; resolutions?: Record<string, ConflictResolution> } = {}): Promise<SyncReport> {
    const report: SyncReport = { perAgent: [] };
    const agents = this.opts.agents ?? AGENTS;
    let gatewayEntryWritten = false;
    for (const def of AGENT_LIST) {
      const adapter = agents[def.type]?.adapter;
      if (!adapter) continue;
      const agentReport = await this.syncAgent(def.type, adapter, config, input);
      if (agentReport.changes.some((c) => c.key === GATEWAY_KEY && c.action === 'upsert')) {
        gatewayEntryWritten = true;
      }
      report.perAgent.push(agentReport);
    }
    // M2.4：网关条目已按新 token 重写 → 轮换提醒解除；
    // 或当前根本没有网关绑定（提醒已无对象）→ 一并解除
    const anyGatewayBound = config.servers.some(
      (s) => s.gatewayMode && s.enabled && config.bindings.some((b) => b.serverId === s.id),
    );
    if (!input.dryRun && config.settings.tokenRotatedAt && (gatewayEntryWritten || !anyGatewayBound)) {
      delete config.settings.tokenRotatedAt;
    }
    return report;
  }

  private bridgeEntry(
    key: string,
    url: string,
    extraHeaders: Record<string, string> | undefined,
    token: string | undefined,
  ): RawServerEntry {
    const bridge = this.opts.stdioBridge!;
    const args = [...bridge.baseArgs, url];
    if (token) args.push(`--token=${token}`);
    for (const [k, v] of Object.entries(extraHeaders ?? {})) {
      if (k.toLowerCase() === 'authorization') continue; // token 已带 Authorization
      args.push('--header', `${k}=${v}`);
    }
    args.push('--name', key);
    return { transport: 'stdio', command: bridge.command, args };
  }

  private async syncAgent(
    agentType: AgentType,
    adapter: AgentAdapter,
    config: ManagerConfig,
    input: { dryRun?: boolean; resolutions?: Record<string, ConflictResolution> },
  ): Promise<AgentSyncReport> {
    const dryRun = input.dryRun ?? false;
    const resolutions = mapResolutions(agentType, input.resolutions);
    const syncState = config.syncState[agentType] ?? { agentType, keyStates: [], updatedAt: new Date().toISOString() };
    const previous = syncState.keyStates;

    const servers = boundServers(config, agentType).filter((s) => s.enabled);
    const writes: FragmentWrite[] = [];
    const keyToServer = new Map<string, string | undefined>();
    const unsupported: { serverId: string; reason: string }[] = [];

    for (const server of servers) {
      if (server.gatewayMode) continue;
      const native = adapter.transports.includes(server.transport);
      const httpFamily = server.transport === 'http' || server.transport === 'sse';
      if (native) {
        // S4：静态加密的 env/headers 在直连分发时解密（agent 进程需真实读取）
        const entry = toRawEntry(server);
        entry.env = await decryptRecord(entry.env);
        entry.headers = await decryptRecord(entry.headers);
        writes.push({ key: server.id, entry });
        keyToServer.set(server.id, server.id);
      } else if (httpFamily && this.opts.stdioBridge) {
        // G7：经本地 stdio 桥使用远程 server
        writes.push({
          key: server.id,
          entry: this.bridgeEntry(server.id, server.url ?? '', server.headers, undefined),
        });
        keyToServer.set(server.id, server.id);
      } else {
        unsupported.push({
          serverId: server.id,
          reason: httpFamily
            ? `${agentType} 直连不支持 ${server.transport} 传输且反向桥不可用`
            : `${agentType} 不支持 ${server.transport} 传输`,
        });
      }
    }

    const gatewayServers = servers.filter((s) => s.gatewayMode);
    const hadGatewayKey = previous.some((k) => k.key === GATEWAY_KEY);
    // M3.3 G13：per-agent 分组端点——该 agent 只看到自己绑定的网关 server
    const agentGatewayUrl = `http://127.0.0.1:${config.settings.port}/agents/${agentType}/mcp`;
    if (gatewayServers.length > 0) {
      if (adapter.transports.includes('http')) {
        writes.push({
          key: GATEWAY_KEY,
          entry: {
            transport: 'http',
            url: agentGatewayUrl,
            headers: { Authorization: `Bearer ${config.settings.token}` },
          },
        });
        keyToServer.set(GATEWAY_KEY, undefined);
      } else if (this.opts.stdioBridge) {
        // G7：Codex 等经 stdio 桥接入分组网关端点
        writes.push({
          key: GATEWAY_KEY,
          entry: this.bridgeEntry(GATEWAY_KEY, agentGatewayUrl, undefined, config.settings.token),
        });
        keyToServer.set(GATEWAY_KEY, undefined);
      } else {
        unsupported.push({
          serverId: gatewayServers.map((s) => s.id).join(','),
          reason: `${agentType} 原生不支持 http 传输且反向桥不可用`,
        });
      }
    } else if (hadGatewayKey) {
      writes.push({ key: GATEWAY_KEY, entry: null });
      keyToServer.set(GATEWAY_KEY, undefined);
    }

    // 收敛：上次写过、本次不再受管的片段 → 移除
    const managedKeys = new Set(writes.map((w) => w.key));
    for (const ks of previous) {
      if (!managedKeys.has(ks.key)) {
        writes.push({ key: ks.key, entry: null });
        keyToServer.set(ks.key, undefined);
      }
    }

    const file = await resolveTargetFile(adapter);
    const backup = dryRun
      ? undefined
      : async (): Promise<void> => {
          if (this.opts.backupsDir) await backupFile(file, agentType, this.opts.backupsDir);
        };

    const result = await adapter.apply(file, writes, {
      previous,
      resolutions,
      dryRun,
      backup,
    });

    if (!dryRun) {
      config.syncState[agentType] = {
        agentType,
        keyStates: result.keyStates,
        updatedAt: new Date().toISOString(),
      } satisfies AgentSyncState;
    }

    return {
      agentType,
      file,
      changes: result.changes.map((c) => ({ ...c, serverId: keyToServer.get(c.key) })),
      conflicts: result.conflicts.map((c) => ({
        ...c,
        serverId: keyToServer.get(c.key),
        resolutionKey: `${agentType}:${c.key}`,
      })),
      unsupported,
    };
  }
}

export interface AgentSyncReport {
  agentType: AgentType;
  file: string | null;
  changes: { key: string; action: 'upsert' | 'remove' | 'none'; serverId?: string }[];
  conflicts: (ConflictInfo & { serverId?: string; resolutionKey: string })[];
  unsupported: { serverId: string; reason: string }[];
}

export interface SyncReport {
  perAgent: AgentSyncReport[];
}

export function toRawEntry(server: ServerDef): RawServerEntry {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
  };
}

function mapResolutions(
  agentType: AgentType,
  resolutions?: Record<string, ConflictResolution>,
): Record<string, ConflictResolution> {
  if (!resolutions) return {};
  const out: Record<string, ConflictResolution> = {};
  const prefix = `${agentType}:`;
  for (const [k, v] of Object.entries(resolutions)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

async function resolveTargetFile(adapter: AgentAdapter): Promise<string> {
  const candidates = adapter.candidatePaths();
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // 继续找
    }
  }
  return candidates[0]!;
}
