import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { RuntimeTool, ServerDefDTO, ToolInfo } from '../api';
import { Badge, Btn, Card, ErrorBanner, Field, OkBanner, inputCls } from '../ui';

interface FormState {
  id?: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  env: string;
  url: string;
  gatewayMode: boolean;
  enabled: boolean;
  concurrency: string;
}

const EMPTY: FormState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  gatewayMode: false,
  enabled: true,
  concurrency: '1',
};

/** stdio 命令首词 → 依赖的运行时（缺环境时给警告） */
const COMMAND_RUNTIME: Record<string, string> = {
  node: 'node',
  npx: 'npx',
  uvx: 'uvx',
  docker: 'docker',
};

function toForm(s: ServerDefDTO): FormState {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join(' '),
    env: Object.entries(s.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    url: s.url ?? '',
    gatewayMode: s.gatewayMode,
    enabled: s.enabled,
    concurrency: String(s.concurrency ?? 1),
  };
}

export function ServersPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [toolsFor, setToolsFor] = useState<ServerDefDTO | null>(null);

  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ servers: ServerDefDTO[] }>('/api/servers'),
  });
  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: () => api.get<{ tools: RuntimeTool[] }>('/api/environment'),
  });
  const missingRuntimes = new Set(
    (environment.data?.tools ?? []).filter((t) => !t.found).map((t) => t.name),
  );

  const runtimeWarning = (s: ServerDefDTO): string | null => {
    if (s.transport !== 'stdio' || s.command === undefined) return null;
    const base = s.command.split(/[\\/]/).at(-1)?.toLowerCase() ?? s.command;
    const need = COMMAND_RUNTIME[base];
    if (need !== undefined && missingRuntimes.has(need)) return `缺少运行时 ${need}`;
    return null;
  };

  const save = useMutation({
    mutationFn: (f: FormState) => {
      const body: Record<string, unknown> = {
        ...(f.id !== undefined ? { id: f.id } : {}),
        name: f.name,
        transport: f.transport,
        gatewayMode: f.gatewayMode,
        enabled: f.enabled,
      };
      if (f.transport === 'stdio') {
        body['command'] = f.command;
        body['args'] = f.args.split(/\s+/).filter(Boolean);
        const env: Record<string, string> = {};
        for (const line of f.env.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1);
        }
        if (Object.keys(env).length > 0) body['env'] = env;
        const concurrency = Number(f.concurrency);
        if (Number.isInteger(concurrency) && concurrency >= 1) body['concurrency'] = concurrency;
      } else {
        body['url'] = f.url;
      }
      return f.id !== undefined
        ? api.patch<{ server: ServerDefDTO }>(`/api/servers/${f.id}`, body)
        : api.post<{ server: ServerDefDTO }>('/api/servers', body);
    },
    onSuccess: () => {
      setOk('已保存');
      setForm(null);
      setError(null);
      void qc.invalidateQueries();
    },
    onError: (e) => {
      setError(String((e as Error).message));
      setOk(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/servers/${id}`),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => setError(String((e as Error).message)),
  });

  const quickToggle = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/servers/${id}`, body),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => setError(String((e as Error).message)),
  });

  return (
    <div>
      <ErrorBanner message={error} />
      <OkBanner message={ok} />

      <Card
        title="MCP Server 注册表"
        actions={
          <Btn kind="primary" testId="btn-add-server" onClick={() => setForm({ ...EMPTY })}>
            添加 Server
          </Btn>
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2">ID / 名称</th>
              <th className="py-2">传输</th>
              <th className="py-2">模式</th>
              <th className="py-2">状态</th>
              <th className="py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(servers.data?.servers ?? []).map((s) => (
              <tr key={s.id} data-testid={`server-row-${s.id}`} className="border-b border-slate-100">
                <td className="py-2">
                  <div className="font-medium">
                    {s.name}
                    {runtimeWarning(s) !== null && (
                      <span className="ml-2" title={runtimeWarning(s) ?? ''}>
                        <Badge tone="amber">⚠ {runtimeWarning(s)}</Badge>
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400">{s.id}</div>
                </td>
                <td className="py-2">{s.transport === 'stdio' ? s.command : s.url}</td>
                <td className="py-2">
                  {s.gatewayMode ? <Badge tone="blue">网关</Badge> : <Badge tone="gray">直连</Badge>}
                </td>
                <td className="py-2">
                  {s.enabled ? <Badge tone="green">启用</Badge> : <Badge tone="red">停用</Badge>}
                </td>
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <Btn small onClick={() => setForm(toForm(s))}>
                      编辑
                    </Btn>
                    <Btn small onClick={() => setToolsFor(s)}>
                      工具
                    </Btn>
                    <Btn
                      small
                      onClick={() => void quickToggle.mutate({ id: s.id, body: { enabled: !s.enabled } })}
                    >
                      {s.enabled ? '停用' : '启用'}
                    </Btn>
                    <Btn small kind="danger" onClick={() => void remove.mutate(s.id)}>
                      删除
                    </Btn>
                  </div>
                </td>
              </tr>
            ))}
            {(servers.data?.servers ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-400">
                  还没有 server——去「概览」导入现有配置，或点右上角添加。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {form !== null && (
        <ServerForm
          form={form}
          setForm={setForm}
          saving={save.isPending}
          onSave={() => save.mutate(form)}
          onCancel={() => setForm(null)}
        />
      )}
      {toolsFor !== null && <ToolsModal server={toolsFor} onClose={() => setToolsFor(null)} />}
    </div>
  );
}

function ServerForm(props: {
  form: FormState;
  setForm: (f: FormState) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const f = props.form;
  const set = (patch: Partial<FormState>): void => props.setForm({ ...f, ...patch });
  return (
    <Card title={f.id !== undefined ? `编辑：${f.id}` : '添加 Server'}>
      <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
        <div>
          <Field label="名称">
            <input data-testid="form-name" className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="传输类型">
            <select
              data-testid="form-transport"
              className={inputCls}
              value={f.transport}
              onChange={(e) => set({ transport: e.target.value as 'stdio' | 'http' | 'sse' })}
            >
              <option value="stdio">stdio（本机进程）</option>
              <option value="http">http（远程 streamable）</option>
              <option value="sse">sse（远程，legacy）</option>
            </select>
          </Field>
          {f.transport === 'stdio' ? (
            <>
              <Field label="命令">
                <input data-testid="form-command" className={inputCls} value={f.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
              </Field>
              <Field label="参数（空格分隔）">
                <input data-testid="form-args" className={inputCls} value={f.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem D:\proj" />
              </Field>
              <Field label="环境变量（每行 KEY=value）" hint="保存后自动加密（Windows DPAPI）；网关模式下不会写入 agent 配置">
                <textarea data-testid="form-env" className={`${inputCls} h-24 font-mono`} value={f.env} onChange={(e) => set({ env: e.target.value })} />
              </Field>
              <Field label="并发度（1-16）" hint="stdio 上游同时进行的工具调用数；1 最安全，支持并发的 server 可调高">
                <input
                  data-testid="form-concurrency"
                  type="number"
                  min={1}
                  max={16}
                  className={inputCls}
                  value={f.concurrency}
                  onChange={(e) => set({ concurrency: e.target.value })}
                />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <input data-testid="form-url" className={inputCls} value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" />
            </Field>
          )}
        </div>
        <div>
          <Field label="分发模式">
            <label className="flex items-center gap-2">
              <input
                data-testid="form-gateway"
                type="checkbox"
                checked={f.gatewayMode}
                onChange={(e) => set({ gatewayMode: e.target.checked })}
              />
              <span>网关模式（agent 侧只写一条指向网关的配置，凭证不落地）</span>
            </label>
          </Field>
          <Field label="启用">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              <span>参与分发与网关聚合</span>
            </label>
          </Field>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Btn kind="primary" testId="form-save" disabled={props.saving} onClick={props.onSave}>
          保存
        </Btn>
        <Btn onClick={props.onCancel}>取消</Btn>
      </div>
    </Card>
  );
}

function ToolsModal({ server, onClose }: { server: ServerDefDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [debugTool, setDebugTool] = useState<string | null>(null);
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const tools = useQuery({
    queryKey: ['tools', server.id],
    queryFn: () => api.get<{ tools: ToolInfo[] }>(`/api/servers/${server.id}/tools`),
    retry: false,
  });

  const toggle = useMutation({
    mutationFn: (toolOverrides: Record<string, { enabled: boolean }>) =>
      api.patch(`/api/servers/${server.id}`, { toolOverrides }),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => setError(String((e as Error).message)),
  });

  const invoke = useMutation({
    mutationFn: async ({ tool, args }: { tool: string; args: Record<string, unknown> }) =>
      api.post<{ result: unknown }>(`/api/servers/${server.id}/invoke`, { tool, arguments: args }),
    onSuccess: (res) => {
      setResult(JSON.stringify(res.result, null, 2));
      setError(null);
    },
    onError: (e) => {
      setResult(null);
      setError(`调用失败：${String((e as Error).message)}`);
    },
  });

  const runDebug = async (): Promise<void> => {
    if (debugTool === null) return;
    let args: Record<string, unknown> = {};
    try {
      args = argsText.trim() === '' ? {} : (JSON.parse(argsText) as Record<string, unknown>);
    } catch {
      setError('参数不是合法 JSON');
      return;
    }
    setInvoking(true);
    invoke.mutate({ tool: debugTool, args });
    setInvoking(false);
  };

  const overrides = server.toolOverrides ?? {};
  const setEnabled = (name: string, enabled: boolean): void => {
    toggle.mutate({ ...overrides, [name]: { enabled } });
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        data-testid="tools-modal"
        className="max-h-[80vh] w-[640px] overflow-auto rounded-lg bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">工具开关：{server.id}</h3>
          <Btn small onClick={onClose}>
            关闭
          </Btn>
        </div>
        <ErrorBanner message={error} />
        {tools.isError && (
          <p className="text-sm text-amber-600">
            无法获取工具列表（{String((tools.error as Error).message)}）。网关需要能连接上游后才能列出工具。
          </p>
        )}
        <table className="w-full text-sm">
          <tbody>
            {(tools.data?.tools ?? []).map((t) => (
              <tr key={t.name} className="border-b border-slate-100">
                <td className="py-2">
                  <div className="font-medium">{t.name}</div>
                  {t.description !== undefined && (
                    <div className="text-xs text-slate-400">{t.description}</div>
                  )}
                </td>
                <td className="w-28 py-2 text-right">
                  <Btn small onClick={() => { setDebugTool(t.name); setResult(null); setError(null); setArgsText('{}'); }}>
                    调试
                  </Btn>
                </td>
                <td className="w-20 py-2 text-right">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) => setEnabled(t.name, e.target.checked)}
                    />
                    <span className="text-xs text-slate-500">{t.enabled ? '启用' : '停用'}</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {debugTool !== null && (
          <div data-testid="debug-panel" className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
            <h4 className="mb-2 text-sm font-semibold">调试：{debugTool}</h4>
            <textarea
              data-testid="debug-args"
              className={`${inputCls} h-20 font-mono`}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder='{"message": "hello"}'
            />
            <div className="mt-2 flex items-center gap-2">
              <Btn small kind="primary" disabled={invoking} onClick={() => void runDebug()}>
                运行
              </Btn>
              {invoking && <span className="text-xs text-slate-400">调用中…</span>}
            </div>
            {result !== null && (
              <pre data-testid="debug-result" className="mt-2 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                {result}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
