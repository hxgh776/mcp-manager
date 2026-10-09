import { promises as fs } from 'node:fs';
import { AGENT_LIST, AGENTS, makeAgents } from './agents.js';
import type { AgentAdapter, RawServerEntry } from './adapters/types.js';
import { GATEWAY_KEY } from './types.js';
import type {
  AgentBinding,
  AgentDetection,
  AgentType,
  ManagerConfig,
  ServerDef,
  TransportType,
} from './types.js';

// —— 注册表 CRUD（直接改写传入的 config，调用方负责持久化） ——

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'server' : slug;
}

export function uniqueId(config: ManagerConfig, base: string): string {
  const slug = SLUG_RE.test(base) ? base : slugify(base);
  let id = slug;
  let n = 2;
  while (config.servers.some((s) => s.id === id)) {
    id = `${slug}-${n}`;
    n += 1;
  }
  return id;
}

export interface UpsertServerInput {
  id?: string;
  name: string;
  transport: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  gatewayMode?: boolean;
  enabled?: boolean;
  toolOverrides?: ServerDef['toolOverrides'];
}

export function upsertServer(config: ManagerConfig, input: UpsertServerInput): ServerDef {
  const now = new Date().toISOString();
  if (input.id) {
    const existing = config.servers.find((s) => s.id === input.id);
    if (existing) {
      Object.assign(existing, cleanUndefined(input), { updatedAt: now });
      return existing;
    }
  }
  const id = uniqueId(config, input.id ?? input.name);
  const def: ServerDef = {
    id,
    name: input.name,
    transport: input.transport,
    ...cleanUndefined(input),
    gatewayMode: input.gatewayMode ?? false,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  config.servers.push(def);
  return def;
}

export function deleteServer(config: ManagerConfig, id: string): void {
  config.servers = config.servers.filter((s) => s.id !== id);
  config.bindings = config.bindings.filter((b) => b.serverId !== id);
  // 对应的 agent 配置片段由下一次 sync 时按 syncState 收敛移除
}

export function setBinding(config: ManagerConfig, serverId: string, agentType: AgentType): void {
  if (!config.servers.some((s) => s.id === serverId)) {
    throw new Error(`server 不存在: ${serverId}`);
  }
  if (!config.bindings.some((b) => b.serverId === serverId && b.agentType === agentType)) {
    config.bindings.push({ serverId, agentType, addedAt: new Date().toISOString() });
  }
}

export function removeBinding(config: ManagerConfig, serverId: string, agentType: AgentType): void {
  config.bindings = config.bindings.filter(
    (b) => !(b.serverId === serverId && b.agentType === agentType),
  );
}

export function boundServers(config: ManagerConfig, agentType: AgentType): ServerDef[] {
  const ids = new Set(
    config.bindings.filter((b) => b.agentType === agentType).map((b) => b.serverId),
  );
  return config.servers.filter((s) => ids.has(s.id));
}

function cleanUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// —— Agent 探测（C1） ——

export async function detectAgents(
  agents: Record<AgentType, { displayName: string; adapter: AgentAdapter }> = AGENTS,
): Promise<AgentDetection[]> {
  const out: AgentDetection[] = [];
  for (const def of AGENT_LIST) {
    const src = agents[def.type];
    if (!src) continue;
    const paths = src.adapter.candidatePaths();
    let detected = false;
    const existing: string[] = [];
    for (const p of paths) {
      if (await fileExists(p)) {
        detected = true;
        existing.push(p);
      }
    }
    out.push({
      agentType: def.type,
      displayName: src.displayName,
      detected,
      configPaths: existing.length > 0 ? existing : paths,
      transports: [...src.adapter.transports],
    });
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// —— 导入（C5 冷启动） ——

export interface ImportCandidate {
  agentType: AgentType;
  key: string;
  entry: RawServerEntry;
  fingerprint: string;
}

export interface ImportCandidateGroup {
  fingerprint: string;
  candidates: ImportCandidate[];
  suggested: UpsertServerInput;
}

export function fingerprintOf(entry: RawServerEntry): string {
  if (entry.transport === 'stdio') {
    return `stdio|${entry.command}|${(entry.args ?? []).join(' ')}`;
  }
  return `${entry.transport}|${entry.url}`;
}

/** 读取各 agent 现有配置，产出导入候选（跨 agent 按指纹去重分组） */
export async function importPreview(
  agents: Record<AgentType, { adapter: AgentAdapter }> = AGENTS,
): Promise<ImportCandidateGroup[]> {
  const all: ImportCandidate[] = [];
  for (const def of AGENT_LIST) {
    const adapter = agents[def.type]?.adapter;
    if (!adapter) continue;
    for (const file of adapter.candidatePaths()) {
      const servers = await adapter.read(file);
      for (const [key, entry] of servers) {
        if (key === GATEWAY_KEY) continue; // 自身写入的网关公共条目不是导入候选（Issue-1）
        all.push({ agentType: def.type, key, entry, fingerprint: fingerprintOf(entry) });
      }
    }
  }
  const groups = new Map<string, ImportCandidateGroup>();
  for (const c of all) {
    let g = groups.get(c.fingerprint);
    if (!g) {
      g = {
        fingerprint: c.fingerprint,
        candidates: [],
        suggested: toUpsertInput(c.key, c.entry),
      };
      groups.set(c.fingerprint, g);
    }
    g.candidates.push(c);
  }
  return [...groups.values()];
}

/** 将选中的候选写入注册表（跳过与现有 server 指纹重复的项） */
export function applyImport(
  config: ManagerConfig,
  groups: ImportCandidateGroup[],
  existingFingerprints?: Set<string>,
): ServerDef[] {
  const added: ServerDef[] = [];
  const seen = existingFingerprints ?? new Set(config.servers.map((s) => fingerprintOfServer(s)));
  for (const g of groups) {
    if (seen.has(g.fingerprint)) continue;
    seen.add(g.fingerprint);
    added.push(upsertServer(config, g.suggested));
  }
  return added;
}

export function fingerprintOfServer(s: ServerDef): string {
  return s.transport === 'stdio'
    ? `stdio|${s.command}|${(s.args ?? []).join(' ')}`
    : `${s.transport}|${s.url}`;
}

function toUpsertInput(key: string, entry: RawServerEntry): UpsertServerInput {
  return {
    name: key,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
  };
}

export { makeAgents };
export type { AgentBinding };
