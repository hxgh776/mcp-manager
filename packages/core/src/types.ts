/** 领域类型——MCP Manager 单一事实来源的数据模型。 */

export const AGENT_TYPES = [
  'claude-code',
  'codex',
  'cursor',
  'trae',
  'opencode',
  'claude-desktop',
  'windsurf',
  'gemini-cli',
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export type TransportType = 'stdio' | 'http' | 'sse';

/** MCP Server 定义——注册表中的单一事实来源。 */
export interface ServerDef {
  /** slug，同时作为写入各 agent 配置时的键名，必须满足 ^[a-z0-9][a-z0-9-]*$（TOML bare key 兼容） */
  id: string;
  name: string;
  transport: TransportType;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http */
  url?: string;
  headers?: Record<string, string>;
  /** D5：true = 经网关分发（agent 侧只写一条指向 gateway 的配置），false = 直连分发 */
  gatewayMode: boolean;
  enabled: boolean;
  /** G4：工具级开关，键为上游工具原始名 */
  toolOverrides?: Record<string, { enabled: boolean }>;
  /** M3.2 G12：stdio 上游并发度（1=串行最安全；支持并发的 server 可调高） */
  concurrency?: number;
  createdAt: string;
  updatedAt: string;
}

/** 绑定：server × agent 的分发关系。direct/gateway 语义由 server.gatewayMode 派生。 */
export interface AgentBinding {
  serverId: string;
  agentType: AgentType;
  addedAt: string;
}

/** 网关聚合配置在各 agent 配置文件中占用的公共键名 */
export const GATEWAY_KEY = 'mcp-manager-gateway';

/** 管辖片段（写入 agent 配置的某个键）的 hash 快照，用于 C8 冲突检测 */
export interface KeyState {
  key: string;
  hash: string;
}

export interface AgentSyncState {
  agentType: AgentType;
  keyStates: KeyState[];
  updatedAt: string;
}

export interface Settings {
  port: number;
  token: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** M2.4：token 轮换时间（ISO）。已分发的网关配置需要重新同步；网关条目重写后清除。 */
  tokenRotatedAt?: string;
  /** D7：访问令牌开关。默认 false（仅环回监听兜底）；开启后 /api 与网关要求 Bearer token。 */
  authRequired?: boolean;
}

export interface ManagerConfig {
  version: 1;
  servers: ServerDef[];
  bindings: AgentBinding[];
  syncState: Partial<Record<AgentType, AgentSyncState>>;
  settings: Settings;
}

export interface AgentDetection {
  agentType: AgentType;
  displayName: string;
  detected: boolean;
  configPaths: string[];
  transports: TransportType[];
}
