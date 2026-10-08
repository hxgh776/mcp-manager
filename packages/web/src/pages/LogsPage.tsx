import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { CallRecordDTO, GatewayInfo } from '../api';
import { Badge, Card } from '../ui';

export function LogsPage() {
  const [selected, setSelected] = useState<string>('');
  const calls = useQuery({
    queryKey: ['calls'],
    queryFn: () => api.get<{ calls: CallRecordDTO[] }>('/api/logs/calls'),
    refetchInterval: 3000,
  });
  const gateway = useQuery({
    queryKey: ['gateway'],
    queryFn: () => api.get<GatewayInfo>('/api/gateway'),
    refetchInterval: 5000,
  });
  const upstreams = gateway.data?.upstreams ?? [];
  const current = selected !== '' ? selected : (upstreams[0]?.id ?? '');
  const logs = useQuery({
    queryKey: ['upstream-logs', current],
    queryFn: () => api.get<{ lines: string[] }>(`/api/servers/${current}/logs`),
    enabled: current !== '',
    refetchInterval: 3000,
  });

  return (
    <div>
      <Card title="网关调用日志">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2">时间</th>
              <th className="py-2">Server</th>
              <th className="py-2">工具</th>
              <th className="py-2">结果</th>
              <th className="py-2">耗时</th>
              <th className="py-2">错误</th>
            </tr>
          </thead>
          <tbody>
            {(calls.data?.calls ?? [])
              .slice()
              .reverse()
              .map((c, i) => (
                <tr key={`${c.ts}-${i}`} className="border-b border-slate-100">
                  <td className="py-1.5 text-xs text-slate-400">{c.ts.slice(11, 23)}</td>
                  <td className="py-1.5">{c.serverId}</td>
                  <td className="py-1.5">{c.tool}</td>
                  <td className="py-1.5">
                    {c.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">fail</Badge>}
                  </td>
                  <td className="py-1.5">{c.durationMs}ms</td>
                  <td className="py-1.5 text-xs text-red-500">{c.error ?? ''}</td>
                </tr>
              ))}
            {(calls.data?.calls ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400">
                  暂无调用记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card
        title="上游进程日志（stderr）"
        actions={
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={current}
            onChange={(e) => setSelected(e.target.value)}
          >
            {upstreams.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id}
              </option>
            ))}
          </select>
        }
      >
        <pre data-testid="upstream-logs" className="max-h-72 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {(logs.data?.lines ?? []).join('\n') || '（无输出）'}
        </pre>
      </Card>
    </div>
  );
}
