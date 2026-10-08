import type { AgentType, KeyState, TransportType } from '../types.js';

/** agent 配置文件里一个 server 条目归一化后的形态（读取方向） */
export interface RawServerEntry {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** 一次受管写入：entry 为 null 表示删除该键 */
export interface FragmentWrite {
  key: string;
  entry: RawServerEntry | null;
}

export type ConflictResolution = 'override' | 'skip';

export interface ConflictInfo {
  key: string;
  expectedHash: string;
  currentHash: string;
  resolution: ConflictResolution;
}

export interface ApplyChange {
  key: string;
  action: 'upsert' | 'remove' | 'none';
}

export interface ApplyOptions {
  /** 上次同步记录的管辖片段 hash（C8 冲突检测依据） */
  previous: KeyState[];
  /** 冲突处置，缺省 skip（宁可不动，不覆盖用户手改） */
  resolutions?: Record<string, ConflictResolution>;
  dryRun?: boolean;
  /** 首次实际变更前调用一次（同步引擎在此挂滚动备份） */
  backup?: () => Promise<void>;
}

export interface ApplyResult {
  changes: ApplyChange[];
  /** 同步后各管辖键的最终 hash；被删除的键不出现在其中 */
  keyStates: KeyState[];
  conflicts: ConflictInfo[];
}

export interface AgentAdapter {
  readonly type: AgentType;
  readonly displayName: string;
  /** 该 agent 原生支持的传输——决定直连分发可写哪些 server */
  readonly transports: TransportType[];
  /** 候选配置文件（按优先级；trae 存在 trae/trae-cn 两个变体） */
  candidatePaths(): string[];
  /** 读取文件中全部 server 条目（归一化）；文件不存在返回空表 */
  read(file: string): Promise<Map<string, RawServerEntry>>;
  /** 受管写入：只动本工具管辖的键，其余内容保真（C4/C6） */
  apply(file: string, writes: FragmentWrite[], options: ApplyOptions): Promise<ApplyResult>;
  /** agent 原生条目 → 归一化；无法识别返回 null */
  normalizeEntry(raw: unknown): RawServerEntry | null;
  /** 归一化条目 → agent 原生形态（写入方向；不支持的传输应抛错） */
  denormalizeEntry(entry: RawServerEntry): unknown;
}
