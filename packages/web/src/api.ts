const TOKEN_KEY = 'mcpmgr_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(pathname, {
    method,
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(data['error'] ?? res.statusText), data['code'] as string | undefined);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
  put: <T>(p: string) => request<T>('PUT', p),
  patch: <T>(p: string, body: unknown) => request<T>('PATCH', p, body),
  del: <T>(p: string) => request<T>('DELETE', p),
};

// —— API 类型（与 server 契约对应） ——

export interface StatusInfo {
  version: string;
  uptimeSec: number;
  homeDir: string;
  port: number;
  configuredPort: number;
  gateway: { running: boolean; port?: number };
  serverCount: number;
  bindingCount: number;
  resyncPending: boolean;
}

export interface RuntimeTool {
  name: string;
  role: string;
  found: boolean;
  version?: string;
}

export interface AgentInfo {
  agentType: string;
  displayName: string;
  detected: boolean;
  configPaths: string[];
  transports: string[];
  boundServerIds: string[];
  syncState: { keyStates: { key: string; hash: string }[]; updatedAt: string } | null;
}

export interface ServerDefDTO {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  gatewayMode: boolean;
  enabled: boolean;
  toolOverrides?: Record<string, { enabled: boolean }>;
  concurrency?: number;
}

export interface RegistrySuggestion {
  name: string;
  description: string;
  suggestion: {
    name: string;
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    gatewayMode: boolean;
  } | null;
}

export interface SyncReport {
  perAgent: Array<{
    agentType: string;
    file: string | null;
    changes: { key: string; action: string; serverId?: string }[];
    conflicts: { key: string; resolutionKey: string; resolution: string; serverId?: string }[];
    unsupported: { serverId: string; reason: string }[];
  }>;
}

export interface GatewayInfo {
  running: boolean;
  port?: number;
  upstreams: Array<{
    id: string;
    status: string;
    pid?: number;
    toolCount: number;
    lastError: string | null;
  }>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  enabled: boolean;
}

export interface CallRecordDTO {
  ts: string;
  scope: string;
  serverId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface ImportGroup {
  fingerprint: string;
  alreadyImported: boolean;
  candidates: Array<{ agentType: string; key: string }>;
  suggested: { name: string; transport: string };
}
