import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setToken } from '../api';
import type { AgentInfo, GatewayInfo, StatusInfo } from '../api';
import { Badge, Btn, Card, ErrorBanner, OkBanner } from '../ui';

export function GatewayPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<StatusInfo>('/api/status'),
  });
  const gateway = useQuery({
    queryKey: ['gateway'],
    queryFn: () => api.get<GatewayInfo>('/api/gateway'),
    refetchInterval: 5000,
  });
  const token = useQuery({
    queryKey: ['token'],
    queryFn: () => api.get<{ token: string }>('/api/settings/token'),
  });
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentInfo[] }>('/api/agents'),
  });

  const control = useMutation({
    mutationFn: (action: 'start' | 'stop') => api.post(`/api/gateway/${action}`),
    onSuccess: () => {
      void qc.invalidateQueries();
      setOk(null);
      setError(null);
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  const rotate = useMutation({
    mutationFn: () => api.post<{ token: string; resyncRequired: boolean }>('/api/settings/token/rotate'),
    onSuccess: (res) => {
      void qc.invalidateQueries();
      setOk(res.resyncRequired ? 'token 已轮换——已分发的网关配置需要重新同步！' : 'token 已轮换');
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  const authRequired = status.data?.authRequired === true;
  const toggleAuth = useMutation({
    mutationFn: (on: boolean) => api.patch('/api/settings', { authRequired: on }),
    onSuccess: async (_res, on) => {
      if (on) {
        // 把当前 token 写入本浏览器，避免开启后自锁在令牌门外
        try {
          const t = await api.get<{ token: string }>('/api/settings/token');
          setToken(t.token);
        } catch { /* 忽略 */ }
      }
      void qc.invalidateQueries();
      setOk(on ? '访问令牌已启用——请到「分发」页重新同步（分发内容将携带凭证）' : '访问令牌已关闭——请到「分发」页重新同步（去除凭证）');
      setError(null);
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  const restart = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/api/servers/${id}/${action}`),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => setError(String((e as Error).message)),
  });

  const gw = gateway.data;
  const endpoint = gw?.running === true && gw.port !== undefined ? `http://127.0.0.1:${gw.port}/mcp` : null;

  return (
    <div>
      <ErrorBanner message={error} />
      <OkBanner message={ok} />

      {status.data?.resyncPending === true && (
        <div data-testid="resync-banner" className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠ token 已轮换或访问令牌开关已变更，已分发的网关配置需要重新同步——请到
          <button className="mx-1 underline" onClick={() => switchToSync()}>
            「分发」页
          </button>
          操作，此提醒才会消除。
        </div>
      )}

      <Card
        title="聚合端点"
        actions={
          <div className="flex gap-2">
            {gw?.running === true ? (
              <Btn testId="btn-gateway-stop" onClick={() => control.mutate('stop')}>
                停止网关
              </Btn>
            ) : (
              <Btn kind="primary" testId="btn-gateway-start" onClick={() => control.mutate('start')}>
                启动网关
              </Btn>
            )}
          </div>
        }
      >
        <div className="mb-3 flex items-center gap-2">
          {gw?.running === true ? <Badge tone="green">运行中</Badge> : <Badge tone="gray">已停止</Badge>}
          {endpoint !== null && (
            <>
              <code data-testid="endpoint-url" className="rounded bg-slate-100 px-2 py-1 text-xs">
                {endpoint}
              </code>
              <Btn small onClick={() => void navigator.clipboard.writeText(endpoint)}>
                复制
              </Btn>
            </>
          )}
        </div>
        <p className="text-xs text-slate-400">
          把这个端点配到任意 agent（Authorization: Bearer &lt;token&gt;），即可使用所有「网关模式」server 的工具。
        </p>
      </Card>

      <Card title="Agent 分组端点（G13）">
        <p className="mb-3 text-xs text-slate-400">
          每个 agent 只看到自己绑定的网关 server——同步时写入的就是该 agent 的分组 URL。
        </p>
        <table className="w-full text-sm">
          <tbody>
            {(agents.data?.agents ?? [])
              .filter((a) => a.boundServerIds.length > 0)
              .map((a) => (
                <tr key={a.agentType} className="border-b border-slate-100">
                  <td className="py-2 font-medium">{a.displayName}</td>
                  <td className="py-2">
                    <code className="rounded bg-slate-100 px-2 py-1 text-xs">
                      http://127.0.0.1:{status.data?.port}/agents/{a.agentType}/mcp
                    </code>
                  </td>
                  <td className="py-2 text-right text-xs text-slate-500">
                    绑定 {a.boundServerIds.length} 个
                  </td>
                </tr>
              ))}
            {(agents.data?.agents ?? []).filter((a) => a.boundServerIds.length > 0).length === 0 && (
              <tr>
                <td className="py-4 text-center text-slate-400" colSpan={3}>
                  暂无绑定——到「分发」页勾选后，这里会出现各 agent 的分组端点。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="上游进程">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2">Server</th>
              <th className="py-2">状态</th>
              <th className="py-2">PID</th>
              <th className="py-2">工具数</th>
              <th className="py-2">错误</th>
              <th className="py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(gw?.upstreams ?? []).map((u) => (
              <tr key={u.id} data-testid={`upstream-${u.id}`} className="border-b border-slate-100">
                <td className="py-2">{u.id}</td>
                <td className="py-2">
                  <UpstreamBadge status={u.status} />
                </td>
                <td className="py-2">{u.pid ?? '-'}</td>
                <td className="py-2">{u.toolCount}</td>
                <td className="py-2 text-xs text-red-500">{u.lastError ?? ''}</td>
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <Btn small onClick={() => restart.mutate({ id: u.id, action: 'start' })}>
                      启动
                    </Btn>
                    <Btn small onClick={() => restart.mutate({ id: u.id, action: 'restart' })}>
                      重启
                    </Btn>
                    <Btn small onClick={() => restart.mutate({ id: u.id, action: 'stop' })}>
                      停止
                    </Btn>
                  </div>
                </td>
              </tr>
            ))}
            {(gw?.upstreams ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400">
                  暂无已连接的上游（懒启动：首次调用时自动拉起）。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card
        title="访问令牌"
        actions={
          <label className="flex items-center gap-2 text-sm">
            <input
              data-testid="auth-toggle"
              type="checkbox"
              checked={authRequired}
              onChange={(e) => toggleAuth.mutate(e.target.checked)}
            />
            <span>{authRequired ? '已启用' : '未启用'}</span>
          </label>
        }
      >
        {authRequired ? (
          <>
            <code data-testid="token-value" className="break-all rounded bg-slate-100 px-2 py-1 text-xs">
              {token.data?.token}
            </code>
            <div className="mt-2 flex items-center gap-2">
              <Btn small kind="danger" onClick={() => rotate.mutate()}>
                轮换 token
              </Btn>
              <span className="text-xs text-slate-400">
                轮换后所有已分发的网关配置都会失效，需要到「分发」页重新同步。
              </span>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-500">
            访问令牌未启用（默认）：网关与 API 仅监听 127.0.0.1，本机进程即可访问。
            若本机环境不受信任，建议开启；开启后到「分发」页重新同步，分发内容会携带凭证。
          </p>
        )}
      </Card>
    </div>
  );
}

const switchToSync = (): void => {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', 'sync');
  window.location.href = url.toString();
};

function UpstreamBadge({ status }: { status: string }) {
  if (status === 'ready') return <Badge tone="green">ready</Badge>;
  if (status === 'starting') return <Badge tone="blue">starting</Badge>;
  if (status === 'backoff') return <Badge tone="amber">backoff</Badge>;
  if (status === 'error') return <Badge tone="red">error</Badge>;
  return <Badge tone="gray">{status}</Badge>;
}
