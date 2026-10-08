import { promises as fs } from 'node:fs';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
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
import type { TransportType } from '../types.js';

/**
 * Codex CLI 适配器（config.toml，容器 [mcp_servers.*]）。
 *
 * 写入采用"分段文本编辑"而非整文件重写（R2）：
 * - 按 TOML 表头把文件切成 前导区 + 段列表；
 * - 只摘除/替换本工具管辖的 `[mcp_servers.<key>]` 及其子表段；
 * - 其余字节原样保留（用户的注释、顺序、非托管段完全无损）；
 * - 新段由 smol-toml 序列化后统一追加到文件末尾。
 */
export class CodexTomlAdapter implements AgentAdapter {
  readonly type = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly transports: TransportType[] = ['stdio'];

  private readonly paths: string[];

  constructor(paths: string[]) {
    this.paths = paths;
  }

  candidatePaths(): string[] {
    return [...this.paths];
  }

  normalizeEntry(raw: unknown): RawServerEntry | null {
    if (raw === null || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r['command'] === 'string') {
      return {
        transport: 'stdio',
        command: r['command'],
        args: Array.isArray(r['args']) ? r['args'].map(String) : undefined,
        env: isStringRecord(r['env']),
      };
    }
    if (typeof r['url'] === 'string') {
      return { transport: 'http', url: r['url'], headers: isStringRecord(r['headers']) };
    }
    return null;
  }

  async read(file: string): Promise<Map<string, RawServerEntry>> {
    const text = await readTextIfExists(file);
    if (text === null) return new Map();
    const parsed = this.parseOrThrow(text, file);
    const out = new Map<string, RawServerEntry>();
    const servers = parsed['mcp_servers'];
    if (servers === null || typeof servers !== 'object') return out;
    for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
      const normalized = this.normalizeEntry(value);
      if (normalized) out.set(key, normalized);
    }
    return out;
  }

  async apply(file: string, writes: FragmentWrite[], options: ApplyOptions): Promise<ApplyResult> {
    const text = await readTextIfExists(file);
    const sourceText = text ?? '';
    const parsed = sourceText.trim() === '' ? {} : this.parseOrThrow(sourceText, file);
    const servers: Record<string, unknown> = isStringKeyedRecord(parsed['mcp_servers'])
      ? { ...(parsed['mcp_servers'] as Record<string, unknown>) }
      : {};

    const currentValues = new Map(Object.entries(servers));
    const resolutions = options.resolutions ?? {};
    const { plan, conflicts } = planChanges({
      currentValues,
      writes,
      previous: options.previous,
      resolutions,
      denormalize: (entry) => this.denormalizeEntry(entry),
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

    const managedKeys = new Set(plan.map((p) => p.key));
    const rest = stripManagedSections(sourceText, managedKeys);
    const appended = plan
      .filter((p): p is typeof p & { action: 'upsert'; desired: unknown } => p.action === 'upsert')
      .map((p) =>
        tomlStringify({ mcp_servers: { [p.key]: p.desired as Record<string, unknown> } }).trimEnd(),
      );
    const newText = appendSections(rest, appended);
    await atomicWriteFile(file, newText);

    // 校验：非托管区字节级一致 + 管辖键解析结果与目标一致
    const reread = await readTextIfExists(file);
    let verified = false;
    if (reread !== null) {
      try {
        const restOriginal = stripManagedSections(sourceText, managedKeys);
        const restNew = stripManagedSections(reread, managedKeys);
        if (restOriginal === restNew) {
          const reparsed = this.parseOrThrow(reread, file);
          const reparsedServers = isStringKeyedRecord(reparsed['mcp_servers'])
            ? (reparsed['mcp_servers'] as Record<string, unknown>)
            : {};
          verified = plan.every((p) => {
            const after = reparsedServers[p.key];
            if (p.action === 'remove') return after === undefined;
            if (p.action === 'none' && p.desired === undefined) {
              return after === currentValues.get(p.key);
            }
            return JSON_EQUAL(after, p.desired) || JSON_EQUAL(after, currentValues.get(p.key));
          });
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

    const finalParsed = this.parseOrThrow(reread ?? '', file);
    const finalServers = isStringKeyedRecord(finalParsed['mcp_servers'])
      ? (finalParsed['mcp_servers'] as Record<string, unknown>)
      : {};
    return {
      changes,
      keyStates: finalizeKeyStates(plan, new Map(Object.entries(finalServers))),
      conflicts,
    };
  }

  private parseOrThrow(text: string, file: string): Record<string, unknown> {
    try {
      const parsed: unknown = tomlParse(text);
      if (parsed === null || typeof parsed !== 'object') throw new Error('not a table');
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new MalformedConfigError(file, err);
    }
  }

  private denormalizeEntry(entry: RawServerEntry): Record<string, unknown> {
    // codex 原生仅 stdio；http 由同步引擎在直连分发前过滤，此处兜底转 stdio 不允许
    if (entry.transport !== 'stdio') {
      throw new Error('codex 直连仅支持 stdio 传输（http 类 server 请使用网关模式）');
    }
    const out: Record<string, unknown> = { command: entry.command };
    if (entry.args && entry.args.length > 0) out['args'] = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) out['env'] = entry.env;
    return out;
  }
}

function isStringRecord(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isStringKeyedRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// —— TOML 分段编辑器 ——

export interface TomlSection {
  /** 表头原始行（含 [[ ]] 形式） */
  headerLine: string;
  /** 表名（点分小写原样） */
  name: string;
  lines: string[];
}

const HEADER_RE = /^\s*\[\s*\[?\s*([^\]"]+|"[^"]*")\s*\]?\s*\]\s*(#.*)?$/;

export function splitTomlSections(text: string): { preamble: string; sections: TomlSection[] } {
  const lines = text.split('\n');
  const preamble: string[] = [];
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m && m[1] !== undefined) {
      const name = m[1].trim().replace(/^"|"$/g, '');
      current = { headerLine: line, name, lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble: preamble.join('\n'), sections };
}

export function stripManagedSections(text: string, managedKeys: Set<string>): string {
  const { preamble, sections } = splitTomlSections(text);
  const kept = sections.filter((s) => !isManagedSection(s.name, managedKeys));
  const parts: string[] = [];
  if (preamble.trim() !== '') parts.push(preamble);
  for (const s of kept) parts.push(s.lines.join('\n'));
  if (parts.length === 0) return '';
  return parts.join('\n').replace(/\n*$/, '\n');
}

function isManagedSection(sectionName: string, managedKeys: Set<string>): boolean {
  for (const key of managedKeys) {
    const prefix = `mcp_servers.${key}`;
    if (sectionName === prefix || sectionName.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function appendSections(text: string, sectionBlocks: string[]): string {
  if (sectionBlocks.length === 0) return text;
  const base = text.replace(/\n*$/, '');
  const body = sectionBlocks.join('\n\n');
  if (base === '') return `${body}\n`;
  return `${base}\n\n${body}\n`;
}
