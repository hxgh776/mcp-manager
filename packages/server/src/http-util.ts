import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, { error: message, ...(code ? { code } : {}) });
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** Bearer token 校验（G9）：支持 Authorization 头或 ?token= 查询参数 */
export function checkToken(req: IncomingMessage, expectedToken: string, query?: URLSearchParams): boolean {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header === `Bearer ${expectedToken}`) return true;
  if (query && query.get('token') === expectedToken) return true;
  return false;
}
