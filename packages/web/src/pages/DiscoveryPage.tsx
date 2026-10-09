import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { RegistrySuggestion } from '../api';
import { Badge, Btn, Card, ErrorBanner, inputCls } from '../ui';

export function DiscoveryPage() {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [source, setSource] = useState<'official' | 'npm' | null>(null);
  const [results, setResults] = useState<RegistrySuggestion[] | null>(null);

  const search = useMutation({
    mutationFn: async (q: string) => {
      const res = await api.get<{ servers: RegistrySuggestion[]; source?: 'official' | 'npm' }>(
        `/api/registry/search?q=${encodeURIComponent(q)}`,
      );
      return res;
    },
    onSuccess: (res) => {
      setResults(res.servers);
      setSource(res.source ?? null);
      setError(null);
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  const add = useMutation({
    mutationFn: (s: RegistrySuggestion) =>
      api.post<{ server: { id: string } }>('/api/servers', s.suggestion),
    onSuccess: (res) => {
      setAdded(`已添加 ${res.server.id}——到「分发」页勾选同步`);
      void qc.invalidateQueries();
    },
    onError: (e) => setError(String((e as Error).message)),
  });

  return (
    <div>
      <ErrorBanner message={error} />
      {added !== null && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{added}</div>
      )}
      <Card title="MCP Registry 发现（S7）">
        <p className="mb-3 text-xs text-slate-400">
          默认搜索官方 MCP Registry（registry.modelcontextprotocol.io）；该源不可达时自动回退 npm 搜索
          （结果以 <Badge tone="blue">npm</Badge> 标注，npx 型、默认网关模式）。
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim() !== '') search.mutate(query.trim());
          }}
        >
          <input
            data-testid="registry-query"
            className={inputCls}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：context7、filesystem、notion…"
          />
          <Btn kind="primary" disabled={search.isPending} onClick={() => query.trim() !== '' && search.mutate(query.trim())}>
            {search.isPending ? '搜索中…（最长约 25s）' : '搜索'}
          </Btn>
        </form>
      </Card>

      {results !== null && (
        <Card title={`结果（${results.length}）`}>
          <div className="mb-2">
            {source === 'npm' && <Badge tone="amber">来源：npm 搜索回退（官方 registry 当前不可达）</Badge>}
            {source === 'official' && <Badge tone="green">来源：官方 registry</Badge>}
          </div>
          {results.length === 0 ? (
            <p className="text-sm text-slate-500">没有匹配的 server。</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {results.map((r) => (
                  <tr key={r.name} className="border-b border-slate-100" data-testid={`registry-${r.name}`}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        {r.suggestion === null ? (
                          <Badge tone="gray">不支持自动添加</Badge>
                        ) : (
                          <Badge tone="blue">{r.suggestion.transport}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">{r.description}</div>
                    </td>
                    <td className="py-2 text-right">
                      {r.suggestion !== null && (
                        <Btn small kind="primary" onClick={() => add.mutate(r)}>
                          添加
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
