import { parseJson } from "./constants.js";
import type { Store } from "./store.js";

export async function matchPluginRoute(
  store: Store,
  method: string,
  path: string,
): Promise<{ key: string; path: string } | null> {
  const plugins = (await store.listTaskPlugins()) as { key: string; status: string; routes: string }[];
  for (const p of plugins) {
    if (p.status !== "active" && p.status !== "enabled") continue;
    const routes = parseJson<{ method?: string; path?: string; type?: string }[]>(p.routes, []);
    for (const r of routes) {
      if ((r.method || "POST").toUpperCase() !== method.toUpperCase()) continue;
      if (pathMatches(r.path || "", path)) return { key: p.key, path: r.path || path };
    }
  }
  return null;
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const pp = pattern.split("/").filter(Boolean);
  const sp = path.split("/").filter(Boolean);
  let si = 0;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith("*")) return true;
    if (si >= sp.length) return false;
    if (pp[i].startsWith(":")) {
      si += 1;
      continue;
    }
    if (pp[i] !== sp[si]) return false;
    si += 1;
  }
  return si === sp.length;
}
