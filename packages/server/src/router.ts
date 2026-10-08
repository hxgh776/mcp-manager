import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody } from './http-util.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<unknown>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** 极简路由：'/api/servers/:id' 风格模式匹配，够用且零依赖（§1.2 选型）。 */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((s) => s !== ''),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** 返回 true 表示已处理 */
  async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> {
    const parts = pathname.split('/').filter((s) => s !== '');
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(part);
        } else if (seg !== part) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      let parsed = false;
      const ctx: RequestContext = {
        req,
        res,
        params,
        query,
        body: async () => {
          if (parsed) return ctxBody.value;
          ctxBody.value = await readJsonBody(req);
          parsed = true;
          return ctxBody.value;
        },
      };
      const ctxBody: { value?: unknown } = { value: undefined };
      await route.handler(ctx);
      return true;
    }
    return false;
  }
}
