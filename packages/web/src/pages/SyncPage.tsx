import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { AgentInfo, ServerDefDTO, SyncReport } from '../api';
import { Badge, Btn, Card, ErrorBanner, OkBanner } from '../ui';

export function SyncPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [dryRun, setDryRun] = useState(false);
  // 冲突处置：resolutionKey → override | skip
  const [resolutions, setResolutions] = useState<Record<string, 'override' | 'skip'>>({});

  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ servers: ServerDefDTO[] }>('/api/servers'),
  });
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentInfo[] }>('/api/agents'),
  });

  const bind = useMutation({
    mutationFn: ({ agentType, serverId, on }: { agentType: string; serverId: string; on: boolean }) =>
      on ? api.put(`/api/bindings/${agentType}/${serverId}`) : api.del(`/api/bindings/${agentType}/${serverId}`),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => setError(String((e as Error).message)),
  });

  const sync = useMutation({
    mutationFn: (isDryRun: boolean) => api.post<{ report: SyncReport }>('/api/sync', { dryRun: isDryRun, resolutions }),
    onSuccess: (res, isDryRun) => {
      setReport(res.report);
      setDryRun(isDryRun);
      setOk(isDryRun ? '预览完成（未落盘）' : '同步完成');
      setError(null);
      if (!isDryRun) {
        setResolutions({});
        void qc.invalidateQueries();
      }
    },
    onError: (e) => {
      setError(String((e as Error).message));
      setOk(null);
    },
  });

  const agentList = agents.data?.agents ?? [];
  const serverList = servers.data?.servers ?? [];

  return (
    <div>
      <ErrorBanner message={error} />
      <OkBanner message={ok} />

      <Card
        title="分发矩阵（server × agent）"
        actions={
          <div className="flex gap-2">
            <Btn testId="btn-dry-run" onClick={() => sync.mutate(true)}>
              预览变更
            </Btn>
            <Btn kind="primary" testId="btn-sync" disabled={sync.isPending} onClick={() => sync.mutate(false)}>
              同步到所有 Agent
            </Btn>
          </div>
        }
      >
        <p className="mb-3 text-xs text-slate-400">
          勾选即绑定；「网关」列决定写入形态——网关模式下 agent 只写一条指向网关的配置，凭证不落地。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2">Server</th>
                <th className="py-2">网关</th>
                {agentList.map((a) => (
                  <th key={a.agentType} className="py-2 text-center">
                    {a.displayName}
                    {!a.detected && <span className="ml-1 text-xs text-slate-300">未装</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {serverList.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-slate-400">{s.id}</div>
                  </td>
                  <td className="py-2">{s.gatewayMode ? <Badge tone="blue">网关</Badge> : <Badge tone="gray">直连</Badge>}</td>
                  {agentList.map((a) => {
                    const bound = a.boundServerIds.includes(s.id);
                    const unsupported =
                      s.transport === 'http' && !a.transports.includes('http') && !s.gatewayMode;
                    return (
                      <td key={a.agentType} className="py-2 text-center">
                        <input
                          data-testid={`cell-${s.id}-${a.agentType}`}
                          type="checkbox"
                          disabled={!a.detected || unsupported}
                          checked={bound}
                          onChange={(e) =>
                            bind.mutate({ agentType: a.agentType, serverId: s.id, on: e.target.checked })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {serverList.length === 0 && (
                <tr>
                  <td colSpan={2 + agentList.length} className="py-6 text-center text-slate-400">
                    注册表为空。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {report !== null && (
        <Card title={dryRun ? '变更预览（未落盘）' : '同步结果'}>
          {report.perAgent.map((a) => {
            const changes = a.changes.filter((c) => c.action !== 'none');
            if (changes.length === 0 && a.conflicts.length === 0 && a.unsupported.length === 0) return null;
            return (
              <div key={a.agentType} data-testid={`report-${a.agentType}`} className="mb-4">
                <h3 className="mb-1 font-medium">{a.agentType}</h3>
                <ul className="text-sm">
                  {changes.map((c) => (
                    <li key={c.key} className="text-slate-600">
                      <Badge tone={c.action === 'remove' ? 'red' : 'green'}>{c.action}</Badge> {c.key}
                    </li>
                  ))}
                  {a.unsupported.map((u) => (
                    <li key={u.serverId} className="text-amber-600">
                      ⚠ {u.serverId}: {u.reason}
                    </li>
                  ))}
                  {a.conflicts.map((c) => (
                    <li key={c.resolutionKey} data-testid={`conflict-${c.key}`} className="flex items-center gap-2 text-red-600">
                      ⚠ 冲突 {c.key}（检测到手工修改）
                      <select
                        className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                        value={resolutions[c.resolutionKey] ?? 'skip'}
                        onChange={(e) =>
                          setResolutions({ ...resolutions, [c.resolutionKey]: e.target.value as 'override' | 'skip' })
                        }
                      >
                        <option value="skip">保留我的修改（跳过）</option>
                        <option value="override">用注册表覆盖</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {dryRun && report.perAgent.some((a) => a.conflicts.length > 0) && (
            <p className="text-xs text-slate-400">选择冲突处置后，点「同步到所有 Agent」生效。</p>
          )}
        </Card>
      )}
    </div>
  );
}
