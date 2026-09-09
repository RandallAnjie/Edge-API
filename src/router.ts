export type Params = Record<string, string>;

export interface Context<E = unknown> {
  req: Request;
  env: E;
  url: URL;
  params: Params;
  waitUntil: (p: Promise<unknown>) => void;
}

export type Handler<E = unknown> = (c: Context<E>) => Promise<Response> | Response;

interface Route<E> {
  method: string;
  parts: string[];
  handler: Handler<E>;
}

function match(pattern: string[], path: string[]): Params | null {
  if (pattern.length !== path.length) {
    const star = pattern.findIndex((p) => p === "*");
    if (star === -1) return null;
    if (pattern.length - 1 !== star) return null;
    if (path.length < star) return null;
    const params: Params = { "*": path.slice(star).join("/") };
    for (let i = 0; i < star; i++) {
      const p = pattern[i];
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(path[i]);
      else if (p !== path[i]) return null;
    }
    return params;
  }
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(path[i]);
    else if (p !== path[i]) return null;
  }
  return params;
}

export class Router<E = unknown> {
  private routes: Route<E>[] = [];

  on(method: string, path: string, handler: Handler<E>): this {
    this.routes.push({
      method: method.toUpperCase(),
      parts: path.split("/").filter(Boolean),
      handler,
    });
    return this;
  }

  get(path: string, handler: Handler<E>): this {
    return this.on("GET", path, handler);
  }
  post(path: string, handler: Handler<E>): this {
    return this.on("POST", path, handler);
  }
  put(path: string, handler: Handler<E>): this {
    return this.on("PUT", path, handler);
  }
  patch(path: string, handler: Handler<E>): this {
    return this.on("PATCH", path, handler);
  }
  delete(path: string, handler: Handler<E>): this {
    return this.on("DELETE", path, handler);
  }

  async dispatch(c: Context<E>): Promise<Response | null> {
    const parts = c.url.pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== c.req.method && r.method !== "*") continue;
      const params = match(r.parts, parts);
      if (!params) continue;
      c.params = params;
      return r.handler(c);
    }
    return null;
  }
}
