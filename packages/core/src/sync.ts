import { AGENT_LIST } from './agents.js';
import { backupFile } from './backup.js';
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
 * - gatewayMode server → 每个该 agent 只写一条公共 GATEWAY_KEY 指向网关；
 * - 不再受管的片段（解绑/删除/直连转网关）按 syncState 收敛移除；
 * - 传输不被该 agent 原生支持 → 记入 unsupported 并跳过（建议改网关模式）。
 */
export class SyncEngine {
  constructor(
    private readonly opts: { backupsDir?: string; agents?: Record<AgentType, { adapter: AgentAdapter }> } = {},
  ) {}

  async sync(config: ManagerConfig, input: { dryRun?: boolean; resolutions?: Record<string, ConflictResolution> } = {}): Promise<SyncReport> {
    const report: SyncReport = { perAgent: [] };
    const agents = this.opts.agents ?? AGENTS;
    for (const def of AGENT_LIST) {
      const adapter = agents[def.type]?.adapter;
      if (!adapter) continue;
      report.perAgent.push(await this.syncAgent(def.type, adapter, config, input));
    }
    return report;
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
      if (!adapter.transports.includes(server.transport)) {
        unsupported.push({
          serverId: server.id,
          reason: `${agentType} 直连不支持 ${server.transport} 传输，请改用网关模式`,
        });
        continue;
      }
      writes.push({ key: server.id, entry: toRawEntry(server) });
      keyToServer.set(server.id, server.id);
    }

    const gatewayServers = servers.filter((s) => s.gatewayMode);
    const hadGatewayKey = previous.some((k) => k.key === GATEWAY_KEY);
    if (gatewayServers.length > 0) {
      if (adapter.transports.includes('http')) {
        writes.push({
          key: GATEWAY_KEY,
          entry: {
            transport: 'http',
            url: `http://127.0.0.1:${config.settings.port}/mcp`,
            headers: { Authorization: `Bearer ${config.settings.token}` },
          },
        });
        keyToServer.set(GATEWAY_KEY, undefined);
      } else {
        unsupported.push({
          serverId: gatewayServers.map((s) => s.id).join(','),
          reason: `${agentType} 原生不支持 http 传输，网关分发将在 M2 的 stdio 反向桥中支持`,
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
