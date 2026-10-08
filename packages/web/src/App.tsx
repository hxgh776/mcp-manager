import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, getToken, setToken } from './api';
import type { StatusInfo } from './api';
import { StatusPage } from './pages/StatusPage';
import { ServersPage } from './pages/ServersPage';
import { SyncPage } from './pages/SyncPage';
import { GatewayPage } from './pages/GatewayPage';
import { LogsPage } from './pages/LogsPage';

const TABS = [
  { key: 'status', label: '概览' },
  { key: 'servers', label: 'Server 注册表' },
  { key: 'sync', label: '分发' },
  { key: 'gateway', label: '网关' },
  { key: 'logs', label: '日志' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function initialTab(): TabKey {
  const t = new URLSearchParams(window.location.search).get('tab') as TabKey | null;
  return t !== null && TABS.some((x) => x.key === t) ? t : 'status';
}

export default function App() {
  const [authed, setAuthed] = useState(getToken() !== '');
  const [tab, setTab] = useState<TabKey>(initialTab);
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<StatusInfo>('/api/status'),
    retry: false,
    enabled: authed,
    refetchInterval: 10_000,
  });

  const unauthorized = status.error instanceof ApiError && status.error.status === 401;

  const switchTab = (key: TabKey): void => {
    setTab(key);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', key);
    window.history.replaceState(null, '', url);
  };

  if (!authed || unauthorized) {
    return (
      <TokenGate
        onOk={() => {
          setAuthed(true);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  if (status.isLoading) {
    return <div className="p-10 text-slate-500">连接 daemon…</div>;
  }
  if (status.isError) {
    return (
      <div className="p-10">
        <div className="rounded border border-red-200 bg-red-50 p-4 text-red-700">
          无法连接 daemon（{String((status.error as Error).message)}）。请确认已运行 <code>mcpmgr start</code>。
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-6xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">MCP Manager</h1>
        <span className="text-sm text-slate-400">
          v{status.data!.version} · 端口 {status.data!.port}
        </span>
      </header>
      <nav className="mb-6 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`tab-${t.key}`}
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t.key
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'status' && <StatusPage />}
        {tab === 'servers' && <ServersPage />}
        {tab === 'sync' && <SyncPage />}
        {tab === 'gateway' && <GatewayPage />}
        {tab === 'logs' && <LogsPage />}
      </main>
    </div>
  );
}

function TokenGate({ onOk }: { onOk: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const tryAuth = async (): Promise<void> => {
    setToken(value.trim());
    try {
      await api.get('/api/status');
      onOk();
    } catch (err) {
      setError(`token 无效或 daemon 未运行（${String((err as Error).message)}）`);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-96 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-bold">MCP Manager</h1>
        <p className="mb-4 text-sm text-slate-500">
          输入访问令牌（见 <code>~/.mcp-manager/config.json</code> 的 settings.token，或 <code>mcpmgr status</code>）
        </p>
        <input
          data-testid="token-input"
          className="mb-3 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void tryAuth();
          }}
          placeholder="daemon access token"
        />
        {error !== '' && <div className="mb-3 text-sm text-red-600">{error}</div>}
        <button
          data-testid="token-submit"
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          onClick={() => void tryAuth()}
        >
          进入
        </button>
      </div>
    </div>
  );
}
