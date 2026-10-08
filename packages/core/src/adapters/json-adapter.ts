import { promises as fs } from 'node:fs';
import { atomicWriteFile, readTextIfExists } from '../fsutil.js';
import { MalformedConfigError, WriteVerificationError } from '../errors.js';
import { finalizeKeyStates, JSON_EQUAL, planChanges } from './shared.js';
import type {
  AgentAdapter,
  ApplyOptions,
  ApplyResult,
  FragmentWrite,
  RawServerEntry,
} from './types.js';
import type { AgentType, TransportType } from '../types.js';

export interface JsonAdapterOptions {
  type: AgentType;
  displayName: string;
  transports: TransportType[];
  paths: string[];
  /** server 条目所在的容器键，如 mcpServers / mcp */
  containerKey: string;
  normalize: (raw: unknown) => RawServerEntry | null;
  denormalize: (entry: RawServerEntry) => Record<string, unknown>;
}

/**
 * 通用 JSON 容器适配器：claude-code / cursor / trae 共用。
 *
 * 写入流程（C6 安全写入）：
 * parse → 只改容器内管辖键 → 原子写 → 复读深比较校验 → 失败即回滚并抛错。
 */
export class JsonAgentAdapter implements AgentAdapter {
  readonly type: AgentType;
  readonly displayName: string;
  readonly transports: TransportType[];
  readonly containerKey: string;
  private readonly paths: string[];
  private readonly normalizeFn: (raw: unknown) => RawServerEntry | null;
  private readonly denormalizeFn: (entry: RawServerEntry) => Record<string, unknown>;

  constructor(opts: JsonAdapterOptions) {
    this.type = opts.type;
    this.displayName = opts.displayName;
    this.transports = opts.transports;
    this.paths = opts.paths;
    this.containerKey = opts.containerKey;
    this.normalizeFn = opts.normalize;
    this.denormalizeFn = opts.denormalize;
  }

  candidatePaths(): string[] {
    return [...this.paths];
  }

  normalizeEntry(raw: unknown): RawServerEntry | null {
    return this.normalizeFn(raw);
  }

  async read(file: string): Promise<Map<string, RawServerEntry>> {
    const text = await readTextIfExists(file);
    if (text === null) return new Map();
    const obj = this.parseOrThrow(text, file);
    const container = obj[this.containerKey];
    const out = new Map<string, RawServerEntry>();
    if (container === null || typeof container !== 'object') return out;
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      const normalized = this.normalizeFn(value);
      if (normalized) out.set(key, normalized);
    }
    return out;
  }

  async apply(file: string, writes: FragmentWrite[], options: ApplyOptions): Promise<ApplyResult> {
    const text = await readTextIfExists(file);
    const obj = text === null ? {} : this.parseOrThrow(text, file);
    if (typeof obj !== 'object' || Array.isArray(obj)) {
      throw new MalformedConfigError(file);
    }
    const record = obj as Record<string, unknown>;
    const containerExisted = record[this.containerKey] !== undefined;
    const containerValue = record[this.containerKey];
    if (containerExisted && (containerValue === null || typeof containerValue !== 'object' || Array.isArray(containerValue))) {
      throw new MalformedConfigError(file);
    }
    const container: Record<string, unknown> = containerExisted
      ? { ...(containerValue as Record<string, unknown>) }
      : {};

    const currentValues = new Map(Object.entries(container));
    const resolutions = options.resolutions ?? {};
    const { plan, conflicts } = planChanges({
      currentValues,
      writes,
      previous: options.previous,
      resolutions,
      denormalize: this.denormalizeFn,
    });
    const changes = plan.map(({ key, action }) => ({ key, action }));
    const mutations = plan.filter((p) => p.action !== 'none');

    if (options.dryRun) {
      const projected = new Map(currentValues);
      for (const m of mutations) {
        if (m.action === 'upsert') projected.set(m.key, m.desired);
        else projected.delete(m.key);
      }
      return { changes, keyStates: finalizeKeyStates(plan, projected), conflicts };
    }

    if (mutations.length === 0) {
      return { changes, keyStates: finalizeKeyStates(plan, currentValues), conflicts };
    }

    if (options.backup) await options.backup();

    for (const m of mutations) {
      if (m.action === 'upsert') container[m.key] = m.desired;
      else delete container[m.key];
    }
    if (Object.keys(container).length > 0 || containerExisted) {
      record[this.containerKey] = container;
    }

    const newText = `${JSON.stringify(record, null, 2)}\n`;
    await atomicWriteFile(file, newText);

    // 复读校验：整体内容一致 + 非管辖顶层键与写前逐键深等
    const reread = await readTextIfExists(file);
    let verified = false;
    if (reread !== null) {
      try {
        const reparsed = JSON.parse(reread);
        if (JSON_EQUAL(reparsed, record)) {
          const snapshot = text === null ? {} : this.parseOrThrow(text, file);
          const otherKeys = Object.keys(snapshot as Record<string, unknown>).filter(
            (k) => k !== this.containerKey,
          );
          verified = otherKeys.every((k) =>
            JSON_EQUAL((snapshot as Record<string, unknown>)[k], (reparsed as Record<string, unknown>)[k]),
          );
        }
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      if (text === null) await fs.rm(file, { force: true });
      else await atomicWriteFile(file, text);
      throw new WriteVerificationError(file);
    }

    return {
      changes,
      keyStates: finalizeKeyStates(
        plan,
        new Map(Object.entries(record[this.containerKey] as Record<string, unknown>)),
      ),
      conflicts,
    };
  }

  private parseOrThrow(text: string, file: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new MalformedConfigError(file, err);
    }
  }
}

// —— 各 agent 共用的归一化器 ——

/** claude-code 风格：{ command,args,env } 或 { type:'http'|'sse', url, headers } */
export function normalizeClaudeStyle(raw: unknown): RawServerEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r['type'] === 'string' ? (r['type'] as string) : undefined;
  if (type === 'http' || type === 'sse') {
    if (typeof r['url'] !== 'string') return null;
    return {
      transport: type,
      url: r['url'],
      headers: toStringRecord(r['headers']),
    };
  }
  if (typeof r['url'] === 'string' && r['command'] === undefined) {
    return { transport: 'http', url: r['url'], headers: toStringRecord(r['headers']) };
  }
  if (typeof r['command'] === 'string') {
    return {
      transport: 'stdio',
      command: r['command'],
      args: toStringArray(r['args']),
      env: toStringRecord(r['env']),
      cwd: typeof r['cwd'] === 'string' ? r['cwd'] : undefined,
    };
  }
  return null;
}

export function denormalizeClaudeStyle(entry: RawServerEntry): Record<string, unknown> {
  if (entry.transport === 'stdio') {
    return clean({
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
    });
  }
  return clean({
    type: entry.transport === 'sse' ? 'sse' : 'http',
    url: entry.url,
    headers: entry.headers,
  });
}

/** cursor / trae 风格：无 type 字段的 { command,args,env } 或 { url, headers } */
export function normalizeUrlOrCommand(raw: unknown): RawServerEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r['type'] === 'string' ? (r['type'] as string) : undefined;
  if (typeof r['url'] === 'string') {
    return {
      transport: type === 'sse' ? 'sse' : 'http',
      url: r['url'],
      headers: toStringRecord(r['headers']),
    };
  }
  if (typeof r['command'] === 'string') {
    return {
      transport: 'stdio',
      command: r['command'],
      args: toStringArray(r['args']),
      env: toStringRecord(r['env']),
    };
  }
  return null;
}

export function denormalizeUrlOrCommand(entry: RawServerEntry): Record<string, unknown> {
  if (entry.transport === 'stdio') {
    return clean({ command: entry.command, args: entry.args, env: entry.env });
  }
  return clean({ url: entry.url, headers: entry.headers });
}

/** opencode 风格：{ type:'local', command:[...], environment } 或 { type:'remote', url } */
export function normalizeOpencode(raw: unknown): RawServerEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] === 'remote' && typeof r['url'] === 'string') {
    return { transport: 'http', url: r['url'], headers: toStringRecord(r['headers']) };
  }
  if (r['type'] === 'local' && Array.isArray(r['command'])) {
    const cmd = r['command'].map(String);
    if (cmd.length === 0) return null;
    return {
      transport: 'stdio',
      command: cmd[0],
      args: cmd.slice(1),
      env: toStringRecord(r['environment']),
    };
  }
  return null;
}

export function denormalizeOpencode(entry: RawServerEntry): Record<string, unknown> {
  if (entry.transport === 'stdio') {
    return clean({
      type: 'local',
      command: [entry.command, ...(entry.args ?? [])],
      environment: entry.env,
    });
  }
  return clean({ type: 'remote', url: entry.url, headers: entry.headers });
}

function toStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined;
}

function toStringRecord(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
