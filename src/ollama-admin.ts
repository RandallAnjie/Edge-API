import { CHANNEL_TYPE_OLLAMA } from "./constants.js";
import { defaultBaseUrl } from "./catalog.js";
import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
import type { ChannelRow } from "./types.js";

/** Original `controller` Ollama key: `strings.Split(channel.Key, "\n")[0]`. */
export function ollamaFirstKey(channel: ChannelRow): string {
  return String(channel.key || "").split("\n")[0] || "";
}

/**
 * Original `constant.GetChannelBaseURL` then `channel.GetBaseURL()` override.
 * `GetBaseURL` falls back to the type default when the stored URL is empty.
 */
export function ollamaChannelBaseURL(channel: ChannelRow): string {
  const custom = String(channel.base_url || "");
  return custom || defaultBaseUrl(CHANNEL_TYPE_OLLAMA);
}

function authHeaders(apiKey: string, jsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (jsonBody) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  return headers;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type OllamaPullProgress = {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
};

/** Original `json.Marshal` of `ollama.OllamaPullResponse` (`omitempty`). */
export function encodeOllamaPullProgress(raw: unknown): OllamaPullProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const progress: OllamaPullProgress = { status: String(src.status || "") };
  if (src.digest) progress.digest = String(src.digest);
  const total = Number(src.total);
  if (Number.isFinite(total) && total !== 0) progress.total = total;
  const completed = Number(src.completed);
  if (Number.isFinite(completed) && completed !== 0) progress.completed = completed;
  return progress;
}

/** Original `ollama.FetchOllamaVersion`. */
export async function fetchOllamaVersion(baseURL: string, apiKey: string): Promise<string> {
  const trimmedBase = String(baseURL || "").replace(/\/+$/, "");
  if (!trimmedBase) throw new Error("baseURL 为空");
  let res: Response;
  try {
    res = await fetch(trimmedBase + "/api/version", { headers: authHeaders(apiKey, false) });
  } catch (err) {
    throw new Error(`请求失败: ${errText(err)}`);
  }
  const body = await res.text();
  if (res.status !== 200) throw new Error(`查询版本失败 ${res.status}: ${body}`);
  const parsed = goUnmarshalJSON(body);
  if (!parsed.ok) throw new Error(`解析响应失败: ${parsed.message}`);
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new Error(
      `解析响应失败: json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type struct { Version string "json:\\"version\\"" }`,
    );
  }
  const versionRaw = (parsed.value as { version?: unknown }).version;
  if (versionRaw != null && typeof versionRaw !== "string") {
    throw new Error(
      `解析响应失败: json: cannot unmarshal ${goJSONKind(versionRaw)} into Go struct field .version of type string`,
    );
  }
  const version = String(versionRaw || "");
  if (!version) throw new Error("未返回版本信息");
  return version;
}

/** Original `ollama.PullOllamaModel` (non-stream `omitempty` omits `stream: false`). */
export async function pullOllamaModel(baseURL: string, apiKey: string, modelName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(baseURL + "/api/pull", {
      method: "POST",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify({ name: modelName }),
    });
  } catch (err) {
    throw new Error(`请求失败: ${errText(err)}`);
  }
  const body = await res.text();
  if (res.status !== 200) throw new Error(`拉取模型失败 ${res.status}: ${body}`);
}

/** Original `ollama.DeleteOllamaModel`. */
export async function deleteOllamaModel(baseURL: string, apiKey: string, modelName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(baseURL + "/api/delete", {
      method: "DELETE",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify({ name: modelName }),
    });
  } catch (err) {
    throw new Error(`请求失败: ${errText(err)}`);
  }
  const body = await res.text();
  if (res.status !== 200) throw new Error(`删除模型失败 ${res.status}: ${body}`);
}

export type OllamaPullStreamEvent =
  | { type: "progress"; progress: OllamaPullProgress }
  | { type: "error"; error: string }
  | { type: "complete" };

function parsePullLine(trimmed: string): { progress: OllamaPullProgress; stop?: "error" | "success" } | null {
  const parsed = goUnmarshalJSON(trimmed);
  if (!parsed.ok) return null;
  const progress = encodeOllamaPullProgress(parsed.value);
  if (!progress) return null;
  const status = progress.status.toLowerCase();
  if (status === "error") return { progress, stop: "error" };
  if (status === "success") return { progress, stop: "success" };
  return { progress };
}

/** Original `ollama.PullOllamaModelStream` NDJSON loop. */
export async function* pullOllamaModelStream(
  baseURL: string,
  apiKey: string,
  modelName: string,
): AsyncGenerator<OllamaPullStreamEvent> {
  let res: Response;
  try {
    res = await fetch(baseURL + "/api/pull", {
      method: "POST",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify({ name: modelName, stream: true }),
    });
  } catch (err) {
    yield { type: "error", error: `请求失败: ${errText(err)}` };
    return;
  }
  if (res.status !== 200) {
    yield { type: "error", error: `拉取模型失败 ${res.status}: ${await res.text()}` };
    return;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "拉取模型未完成: 未收到成功状态" };
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let successful = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parsePullLine(trimmed);
        if (!parsed) continue;
        yield { type: "progress", progress: parsed.progress };
        if (parsed.stop === "error") {
          yield { type: "error", error: `拉取模型失败: ${trimmed}` };
          return;
        }
        if (parsed.stop === "success") {
          successful = true;
          break;
        }
      }
      if (successful) break;
    }
    if (!successful && buffer.trim()) {
      const trimmed = buffer.trim();
      const parsed = parsePullLine(trimmed);
      if (parsed) {
        yield { type: "progress", progress: parsed.progress };
        if (parsed.stop === "error") {
          yield { type: "error", error: `拉取模型失败: ${trimmed}` };
          return;
        }
        if (parsed.stop === "success") successful = true;
      }
    }
  } catch (err) {
    yield { type: "error", error: `读取流式响应失败: ${errText(err)}` };
    return;
  }
  if (successful) yield { type: "complete" };
  else yield { type: "error", error: "拉取模型未完成: 未收到成功状态" };
}
