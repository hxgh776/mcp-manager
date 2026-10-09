import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { AgentInfo, ImportGroup, RuntimeTool, StatusInfo } from '../api';
import { Badge, Btn, Card, ErrorBanner, OkBanner } from '../ui';

export function StatusPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<StatusInfo>('/api/status') });
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentInfo[] }>('/api/agents?refresh=1'),
  });
  const imports = useQuery({
    queryKey: ['import-preview'],
    queryFn: () => api.get<{ groups: ImportGroup[] }>('/api/import/preview'),
  });
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => api.get<{ tools: RuntimeTool[] }>('/api/environment'),
  });

  const doImport = useMutation({
    mutationFn: (fingerprints: string[]) => api.post<{ added: unknown[] }>('/api/import', { fingerprints }),
    onSuccess: (res) => {
      setOk(`已导入 ${res.added.length} 个 server，去「分发」页勾选同步`);
      setError(null);
      void qc.invalidateQueries();
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  const pending = (imports.data?.groups ?? []).filter((g) => !g.alreadyImported);

  return (
    <div>
      <ErrorBanner message={error} />
      <OkBanner message={ok} />

      <Card title="Daemon">
        <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-slate-400">数据目录</dt>
            <dd data-testid="home-dir" className="break-all">{status.data?.homeDir}</dd>
          </div>
          <div>
            <dt className="text-slate-400">运行端口</dt>
            <dd>{status.data?.port}</dd>
          </div>
          <div>
            <dt className="text-slate-400">已运行</dt>
            <dd>{status.data?.uptimeSec}s</dd>
          </div>
          <div>
            <dt className="text-slate-400">注册表 / 绑定</dt>
            <dd>
              {status.data?.serverCount} / {status.data?.bindingCount}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="运行环境">
        <div className="flex flex-wrap gap-2">
          {(environment.data?.tools ?? []).map((t) => (
            <div
              key={t.name}
              className="rounded border border-slate-200 px-3 py-1.5 text-sm"
              title={`${t.role}${t.version !== undefined ? ` · ${t.version}` : ''}`}
            >
              {t.found ? <Badge tone="green">{t.name}</Badge> : <Badge tone="red">{t.name} 缺失</Badge>}
              <span className="ml-2 text-xs text-slate-400">{t.role}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="本机 Coding Agent"
        actions={
          <Btn small onClick={() => void agents.refetch()}>
            重新探测
          </Btn>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {(agents.data?.agents ?? []).map((a) => (
            <div key={a.agentType} data-testid={`agent-card-${a.agentType}`} className="min-w-0 overflow-hidden rounded border border-slate-200 p-3">
              <div className="mb-1 flex items-center justify-between gap-1">
                <span className="truncate font-medium" title={a.displayName}>{a.displayName}</span>
                {a.detected ? <Badge tone="green">已装</Badge> : <Badge tone="gray">未发现</Badge>}
              </div>
              <div className="truncate text-xs text-slate-400" title={a.configPaths[0]}>
                {a.configPaths[0]}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                绑定 {a.boundServerIds.length} 个 server
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="从现有配置导入（冷启动）">
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">没有发现可导入的新 server 配置。</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2">名称</th>
                <th className="py-2">传输</th>
                <th className="py-2">来源</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((g) => (
                <tr key={g.fingerprint} className="border-b border-slate-100">
                  <td className="py-2">{g.suggested.name}</td>
                  <td className="py-2">{g.suggested.transport}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {g.candidates.map((c) => c.agentType).join(', ')}
                  </td>
                  <td className="py-2 text-right">
                    <Btn
                      small
                      kind="primary"
                      testId={`import-${g.suggested.name}`}
                      onClick={() => doImport.mutate([g.fingerprint])}
                    >
                      导入
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
