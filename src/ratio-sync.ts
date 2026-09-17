import { USD } from "./ratio-defaults.js";

export const FETCH_TIMEOUT_DEFAULT = 10;
export const FETCH_TIMEOUT_MAX = 120;
const FLOAT_EPSILON = 1e-9;
const MODELS_DEV_HOST = "models.dev";
const MODELS_DEV_PATH = "/api.json";
const MODELS_DEV_INPUT_COST_RATIO_BASE = 1000;
const MAX_RATIO_CONFIG_BYTES = 10 << 20;

export const BILLING_MODE_RATIO = "ratio";
export const BILLING_MODE_TIERED_EXPR = "tiered_expr";
export const BILLING_MODE_FIELD = "billing_mode";
export const BILLING_EXPR_FIELD = "billing_expr";

export const PRICING_SYNC_FIELDS = [
  "model_ratio",
  "completion_ratio",
  "cache_ratio",
  "create_cache_ratio",
  "image_ratio",
  "audio_ratio",
  "audio_completion_ratio",
  "model_price",
  BILLING_MODE_FIELD,
  BILLING_EXPR_FIELD,
] as const;

export type PricingSyncField = (typeof PRICING_SYNC_FIELDS)[number];

const NUMERIC_PRICING_SYNC_FIELDS = new Set<string>([
  "model_ratio",
  "completion_ratio",
  "cache_ratio",
  "create_cache_ratio",
  "image_ratio",
  "audio_ratio",
  "audio_completion_ratio",
  "model_price",
]);

export type SyncMap = Record<string, unknown>;

export type UpstreamDTO = {
  id?: number;
  name?: string;
  base_url?: string;
  endpoint?: string;
};

export type FetchUpstreamRatiosRequest = {
  channel_ids?: number[];
  channel_id?: number;
  upstreams?: UpstreamDTO[];
  timeout?: number;
};

export type ChannelRowLike = {
  id: number;
  name: string;
  type: number;
  key: string;
  base_url: string;
};

export type TestResult = { name: string; status: string; error?: string };

export type DifferenceItem = {
  current: unknown;
  upstreams: Record<string, unknown>;
  confidence: Record<string, boolean>;
};

export type FetchUpstreamRatiosData = {
  differences: Record<string, Record<string, DifferenceItem>>;
  test_results: TestResult[];
  prices: Record<string, { current: SyncMap; upstreams: Record<string, SyncMap> }>;
};

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < FLOAT_EPSILON;
}

function asFloat64(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const af = asFloat64(a);
  const bf = asFloat64(b);
  if (af !== null && bf !== null) return nearlyEqual(af, bf);
  return a === b;
}

function valueMap(value: unknown): SyncMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as SyncMap;
}

function normalizeSyncValue(field: string, value: unknown): unknown {
  if (NUMERIC_PRICING_SYNC_FIELDS.has(field)) {
    const parsed = asFloat64(value);
    if (parsed !== null) return parsed;
  }
  return value;
}

/** Original `effectivePricingSyncData`. */
export function effectivePricingSyncData(data: SyncMap): SyncMap {
  const result: SyncMap = {};
  const names = new Set<string>();
  for (const field of PRICING_SYNC_FIELDS) {
    const entries: SyncMap = {};
    for (const [name, raw] of Object.entries(valueMap(data[field]))) {
      const value = normalizeSyncValue(field, raw);
      if (NUMERIC_PRICING_SYNC_FIELDS.has(field)) {
        const number = typeof value === "number" ? value : NaN;
        if (!Number.isFinite(number) || number < 0) continue;
      }
      entries[name] = value;
      names.add(name);
    }
    result[field] = entries;
  }
  const modes = valueMap(result[BILLING_MODE_FIELD]);
  const expressions = valueMap(result[BILLING_EXPR_FIELD]);
  for (const name of names) {
    const expression = typeof expressions[name] === "string" ? String(expressions[name]) : "";
    if (modes[name] === BILLING_MODE_TIERED_EXPR) {
      if (!expression.trim()) {
        for (const field of PRICING_SYNC_FIELDS) delete valueMap(result[field])[name];
        continue;
      }
      expressions[name] = expression.trim();
      for (const field of NUMERIC_PRICING_SYNC_FIELDS) delete valueMap(result[field])[name];
      continue;
    }
    delete expressions[name];
    modes[name] = BILLING_MODE_RATIO;
    const fixed = name in valueMap(result["model_price"]);
    const token = name in valueMap(result["model_ratio"]);
    if (!fixed && !token) {
      for (const field of PRICING_SYNC_FIELDS) delete valueMap(result[field])[name];
      continue;
    }
    if (fixed) {
      for (const field of NUMERIC_PRICING_SYNC_FIELDS) {
        if (field !== "model_price") delete valueMap(result[field])[name];
      }
    }
  }
  return result;
}

function modelPricingSyncValues(data: SyncMap, name: string): SyncMap {
  const values: SyncMap = {};
  for (const field of PRICING_SYNC_FIELDS) {
    const map = valueMap(data[field]);
    if (name in map) values[field] = map[name];
  }
  return values;
}

/** Original `buildDifferences`. */
export function buildDifferences(
  localData: SyncMap,
  successfulChannels: { name: string; data: SyncMap }[],
): Record<string, Record<string, DifferenceItem>> {
  localData = effectivePricingSyncData(localData);
  const channels = successfulChannels.map((channel) => ({
    name: channel.name,
    data: effectivePricingSyncData(channel.data),
  }));
  const allModels = new Set<string>();
  for (const field of PRICING_SYNC_FIELDS) {
    for (const modelName of Object.keys(valueMap(localData[field]))) allModels.add(modelName);
  }
  for (const channel of channels) {
    for (const field of PRICING_SYNC_FIELDS) {
      for (const modelName of Object.keys(valueMap(channel.data[field]))) allModels.add(modelName);
    }
  }

  const confidenceMap: Record<string, Record<string, boolean>> = {};
  for (const channel of channels) {
    confidenceMap[channel.name] = {};
    const modelRatios = valueMap(channel.data["model_ratio"]);
    const completionRatios = valueMap(channel.data["completion_ratio"]);
    if (Object.keys(modelRatios).length && Object.keys(completionRatios).length) {
      for (const modelName of allModels) {
        confidenceMap[channel.name][modelName] = true;
        if (modelName in modelRatios && modelName in completionRatios) {
          const modelRatioFloat = asFloat64(modelRatios[modelName]);
          const completionRatioFloat = asFloat64(completionRatios[modelName]);
          if (
            modelRatioFloat !== null &&
            completionRatioFloat !== null &&
            nearlyEqual(modelRatioFloat, 37.5) &&
            nearlyEqual(completionRatioFloat, 1)
          ) {
            confidenceMap[channel.name][modelName] = false;
          }
        }
      }
    } else {
      for (const modelName of allModels) confidenceMap[channel.name][modelName] = true;
    }
  }

  const differences: Record<string, Record<string, DifferenceItem>> = {};
  for (const modelName of allModels) {
    let expressionPriority = valueMap(localData[BILLING_MODE_FIELD])[modelName] === BILLING_MODE_TIERED_EXPR;
    for (const channel of channels) {
      if (valueMap(channel.data[BILLING_MODE_FIELD])[modelName] === BILLING_MODE_TIERED_EXPR) expressionPriority = true;
    }
    for (const ratioType of PRICING_SYNC_FIELDS) {
      if (expressionPriority && NUMERIC_PRICING_SYNC_FIELDS.has(ratioType)) continue;
      let localValue: unknown = null;
      const localMap = valueMap(localData[ratioType]);
      if (modelName in localMap) localValue = normalizeSyncValue(ratioType, localMap[modelName]);
      const upstreamValues: Record<string, unknown> = {};
      const confidenceValues: Record<string, boolean> = {};
      let hasUpstreamValue = false;
      let hasDifference = false;
      for (const channel of channels) {
        if (expressionPriority && valueMap(channel.data[BILLING_MODE_FIELD])[modelName] !== BILLING_MODE_TIERED_EXPR) {
          continue;
        }
        let upstreamValue: unknown = null;
        const upMap = valueMap(channel.data[ratioType]);
        if (modelName in upMap) {
          upstreamValue = normalizeSyncValue(ratioType, upMap[modelName]);
          hasUpstreamValue = true;
          if (localValue != null && !valuesEqual(localValue, upstreamValue)) hasDifference = true;
          else if (valuesEqual(localValue, upstreamValue)) upstreamValue = "same";
        }
        if (upstreamValue == null && localValue == null) upstreamValue = "same";
        if (localValue == null && upstreamValue != null && upstreamValue !== "same") hasDifference = true;
        upstreamValues[channel.name] = upstreamValue;
        confidenceValues[channel.name] = Boolean(confidenceMap[channel.name][modelName]);
      }
      let shouldInclude = false;
      if (localValue != null) {
        if (hasDifference) shouldInclude = true;
      } else if (hasUpstreamValue) {
        shouldInclude = true;
      }
      if (shouldInclude) {
        if (!differences[modelName]) differences[modelName] = {};
        differences[modelName][ratioType] = {
          current: localValue,
          upstreams: upstreamValues,
          confidence: confidenceValues,
        };
      }
    }
  }

  const channelHasDiff: Record<string, boolean> = {};
  for (const ratioMap of Object.values(differences)) {
    for (const item of Object.values(ratioMap)) {
      for (const [chName, val] of Object.entries(item.upstreams)) {
        if (val != null && val !== "same") channelHasDiff[chName] = true;
      }
    }
  }
  for (const [modelName, ratioMap] of Object.entries(differences)) {
    for (const [ratioType, item] of Object.entries(ratioMap)) {
      for (const chName of Object.keys(item.upstreams)) {
        if (!channelHasDiff[chName]) {
          delete item.upstreams[chName];
          delete item.confidence[chName];
        }
      }
      const allSame = Object.values(item.upstreams).every((v) => v === "same");
      if (!Object.keys(item.upstreams).length || allSame) delete ratioMap[ratioType];
      else differences[modelName][ratioType] = item;
    }
    if (!Object.keys(ratioMap).length) delete differences[modelName];
  }
  return differences;
}

function roundRatioValue(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isModelsDevAPIEndpoint(rawURL: string): boolean {
  try {
    const parsed = new URL(rawURL);
    if (parsed.hostname.toLowerCase() !== MODELS_DEV_HOST) return false;
    let path = parsed.pathname.replace(/\/+$/, "") || "/";
    return path === MODELS_DEV_PATH;
  } catch {
    return false;
  }
}

function firstEnabledKey(key: string): string {
  const parts = String(key ?? "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[0] ?? "";
}

/** Original `convertOpenRouterToRatioData`. */
export function convertOpenRouterToRatioData(body: unknown): SyncMap {
  const list = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
    ? ((body as { data: unknown[] }).data)
    : [];
  const modelRatioMap: SyncMap = {};
  const completionRatioMap: SyncMap = {};
  const cacheRatioMap: SyncMap = {};
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { id?: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string } };
    const id = String(row.id || "");
    if (!id) continue;
    const pricing = row.pricing || {};
    let promptPrice = Number(pricing.prompt);
    let completionPrice = Number(pricing.completion);
    const promptErr = !Number.isFinite(promptPrice);
    const compErr = !Number.isFinite(completionPrice);
    if (promptErr && compErr) continue;
    if (promptErr) promptPrice = 0;
    if (compErr) completionPrice = 0;
    if (promptPrice < 0 || completionPrice < 0) continue;
    if (promptPrice === 0 && completionPrice === 0) {
      modelRatioMap[id] = 0;
      continue;
    }
    if (promptPrice <= 0) continue;
    modelRatioMap[id] = roundRatioValue(promptPrice * 1000 * USD);
    completionRatioMap[id] = roundRatioValue(completionPrice / promptPrice);
    if (pricing.input_cache_read) {
      const cachePrice = Number(pricing.input_cache_read);
      if (Number.isFinite(cachePrice) && cachePrice >= 0) {
        cacheRatioMap[id] = roundRatioValue(cachePrice / promptPrice);
      }
    }
  }
  const converted: SyncMap = {};
  if (Object.keys(modelRatioMap).length) converted.model_ratio = modelRatioMap;
  if (Object.keys(completionRatioMap).length) converted.completion_ratio = completionRatioMap;
  if (Object.keys(cacheRatioMap).length) converted.cache_ratio = cacheRatioMap;
  return converted;
}

type ModelsDevCost = { input?: number; output?: number; cache_read?: number };
type ModelsDevCandidate = { provider: string; input: number; output?: number; cacheRead?: number };

function isValidNonNegativeCost(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

function buildModelsDevCandidate(provider: string, cost: ModelsDevCost): ModelsDevCandidate | null {
  if (cost.input == null) return null;
  if (!isValidNonNegativeCost(cost.input)) return null;
  let output: number | undefined;
  if (cost.output != null) {
    if (!isValidNonNegativeCost(cost.output)) return null;
    output = cost.output;
  }
  if (cost.input === 0 && output != null && output > 0) return null;
  let cacheRead: number | undefined;
  if (cost.cache_read != null && isValidNonNegativeCost(cost.cache_read)) cacheRead = cost.cache_read;
  return { provider, input: cost.input, output, cacheRead };
}

function shouldReplaceModelsDevCandidate(current: ModelsDevCandidate, next: ModelsDevCandidate): boolean {
  const currentNonZero = current.input > 0;
  const nextNonZero = next.input > 0;
  if (currentNonZero !== nextNonZero) return nextNonZero;
  if (nextNonZero && !nearlyEqual(next.input, current.input)) return next.input < current.input;
  return next.provider < current.provider;
}

/** Original `convertModelsDevToRatioData`. */
export function convertModelsDevToRatioData(body: unknown): SyncMap {
  if (!body || typeof body !== "object") throw new Error("failed to decode models.dev response");
  const upstreamData = body as Record<string, { models?: Record<string, { cost?: ModelsDevCost }> }>;
  if (!Object.keys(upstreamData).length) throw new Error("empty models.dev response");
  const providers = Object.keys(upstreamData).sort();
  const selected: Record<string, ModelsDevCandidate> = {};
  for (const provider of providers) {
    const models = upstreamData[provider]?.models || {};
    for (const modelName of Object.keys(models).sort()) {
      const candidate = buildModelsDevCandidate(provider, models[modelName]?.cost || {});
      if (!candidate) continue;
      const current = selected[modelName];
      if (!current || shouldReplaceModelsDevCandidate(current, candidate)) selected[modelName] = candidate;
    }
  }
  if (!Object.keys(selected).length) throw new Error("no valid models.dev pricing entries found");
  const modelRatioMap: SyncMap = {};
  const completionRatioMap: SyncMap = {};
  const cacheRatioMap: SyncMap = {};
  for (const [modelName, candidate] of Object.entries(selected)) {
    if (candidate.input === 0) {
      modelRatioMap[modelName] = 0;
      continue;
    }
    modelRatioMap[modelName] = roundRatioValue((candidate.input * USD) / MODELS_DEV_INPUT_COST_RATIO_BASE);
    if (candidate.output != null) completionRatioMap[modelName] = roundRatioValue(candidate.output / candidate.input);
    if (candidate.cacheRead != null) cacheRatioMap[modelName] = roundRatioValue(candidate.cacheRead / candidate.input);
  }
  const converted: SyncMap = {};
  if (Object.keys(modelRatioMap).length) converted.model_ratio = modelRatioMap;
  if (Object.keys(completionRatioMap).length) converted.completion_ratio = completionRatioMap;
  if (Object.keys(cacheRatioMap).length) converted.cache_ratio = cacheRatioMap;
  return converted;
}

function convertType2PricingList(items: unknown[]): SyncMap {
  const modelRatioMap: SyncMap = {};
  const completionRatioMap: SyncMap = {};
  const cacheRatioMap: SyncMap = {};
  const createCacheRatioMap: SyncMap = {};
  const imageRatioMap: SyncMap = {};
  const audioRatioMap: SyncMap = {};
  const audioCompletionRatioMap: SyncMap = {};
  const modelPriceMap: SyncMap = {};
  const billingModeMap: SyncMap = {};
  const billingExprMap: SyncMap = {};
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const modelName = String(item.model_name || "");
    if (!modelName) continue;
    if (item.billing_mode === BILLING_MODE_TIERED_EXPR) {
      billingModeMap[modelName] = BILLING_MODE_TIERED_EXPR;
      billingExprMap[modelName] = String(item.billing_expr || "");
      continue;
    }
    if (Number(item.quota_type) === 1) {
      const mp = asFloat64(item.model_price);
      if (mp !== null) modelPriceMap[modelName] = mp;
    } else {
      const mr = asFloat64(item.model_ratio);
      if (mr !== null) modelRatioMap[modelName] = mr;
      const cr = asFloat64(item.completion_ratio);
      if (cr !== null) completionRatioMap[modelName] = cr;
    }
    const car = asFloat64(item.cache_ratio);
    if (car !== null) cacheRatioMap[modelName] = car;
    const ccr = asFloat64(item.create_cache_ratio);
    if (ccr !== null) createCacheRatioMap[modelName] = ccr;
    const ir = asFloat64(item.image_ratio);
    if (ir !== null) imageRatioMap[modelName] = ir;
    const ar = asFloat64(item.audio_ratio);
    if (ar !== null) audioRatioMap[modelName] = ar;
    const acr = asFloat64(item.audio_completion_ratio);
    if (acr !== null) audioCompletionRatioMap[modelName] = acr;
  }
  const converted: SyncMap = {};
  if (Object.keys(modelRatioMap).length) converted.model_ratio = modelRatioMap;
  if (Object.keys(completionRatioMap).length) converted.completion_ratio = completionRatioMap;
  if (Object.keys(cacheRatioMap).length) converted.cache_ratio = cacheRatioMap;
  if (Object.keys(createCacheRatioMap).length) converted.create_cache_ratio = createCacheRatioMap;
  if (Object.keys(imageRatioMap).length) converted.image_ratio = imageRatioMap;
  if (Object.keys(audioRatioMap).length) converted.audio_ratio = audioRatioMap;
  if (Object.keys(audioCompletionRatioMap).length) converted.audio_completion_ratio = audioCompletionRatioMap;
  if (Object.keys(modelPriceMap).length) converted.model_price = modelPriceMap;
  if (Object.keys(billingModeMap).length) converted[BILLING_MODE_FIELD] = billingModeMap;
  if (Object.keys(billingExprMap).length) converted[BILLING_EXPR_FIELD] = billingExprMap;
  return converted;
}

function parseUpstreamBody(body: unknown): SyncMap {
  const wrapped = body && typeof body === "object" ? (body as { success?: boolean; data?: unknown; message?: string }) : {};
  if (wrapped.success === false) throw new Error(String(wrapped.message || ""));
  const data = wrapped.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const type1 = data as SyncMap;
    for (const rt of PRICING_SYNC_FIELDS) {
      if (rt in type1) return type1;
    }
  }
  if (Array.isArray(data)) return convertType2PricingList(data);
  throw new Error("无法解析上游返回数据");
}

function uniqueUpstreamName(u: UpstreamDTO): string {
  if (u.id && u.id !== 0) return `${u.name ?? ""}(${u.id})`;
  return u.name ?? "";
}

function resolveFullURL(u: UpstreamDTO): { url: string; openRouter: boolean; modelsDev: boolean } {
  const isOpenRouter = u.endpoint === "openrouter";
  let endpoint = u.endpoint || "";
  let fullURL = "";
  if (isOpenRouter) fullURL = `${(u.base_url || "").replace(/\/+$/, "")}/v1/models`;
  else if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) fullURL = endpoint;
  else {
    if (!endpoint) endpoint = "/api/pricing";
    else if (!endpoint.startsWith("/")) endpoint = `/${endpoint}`;
    fullURL = `${(u.base_url || "").replace(/\/+$/, "")}${endpoint}`;
  }
  return { url: fullURL, openRouter: isOpenRouter, modelsDev: isModelsDevAPIEndpoint(fullURL) };
}

export function validateFetchRequest(body: unknown): FetchUpstreamRatiosRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求参数格式错误"), { status: 400 });
  }
  const req = body as FetchUpstreamRatiosRequest;
  if (req.upstreams != null && !Array.isArray(req.upstreams)) {
    throw Object.assign(new Error("请求参数格式错误"), { status: 400 });
  }
  if (req.channel_ids != null && !Array.isArray(req.channel_ids)) {
    throw Object.assign(new Error("请求参数格式错误"), { status: 400 });
  }
  if (req.upstreams?.length) {
    for (const u of req.upstreams) {
      if (!u || typeof u !== "object" || !String(u.name || "") || !String(u.base_url || "")) {
        throw Object.assign(new Error("请求参数格式错误"), { status: 400 });
      }
    }
  }
  return req;
}

export async function fetchUpstreamRatios(args: {
  req: FetchUpstreamRatiosRequest;
  channels: ChannelRowLike[];
  localData: SyncMap;
  fetchFn?: typeof fetch;
}): Promise<{ ok: true; data: FetchUpstreamRatiosData } | { ok: false; message: string; status: number }> {
  const req = args.req;
  let timeout = Number(req.timeout) || 0;
  if (timeout <= 0) timeout = FETCH_TIMEOUT_DEFAULT;
  if (timeout > FETCH_TIMEOUT_MAX) timeout = FETCH_TIMEOUT_MAX;
  const channelById = new Map(args.channels.map((c) => [c.id, c]));
  const upstreams: UpstreamDTO[] = [];
  if (req.upstreams?.length) {
    for (const u of req.upstreams) {
      if (String(u.base_url || "").startsWith("http")) {
        upstreams.push({
          id: Number(u.id || 0),
          name: u.name || "",
          base_url: String(u.base_url || "").replace(/\/+$/, ""),
          endpoint: u.endpoint || "",
        });
      }
    }
  } else {
    const ids = [...(req.channel_ids || [])];
    if (req.channel_id) ids.push(req.channel_id);
    for (const id of ids) {
      const ch = channelById.get(Number(id));
      if (ch?.base_url?.startsWith("http")) {
        upstreams.push({ id: ch.id, name: ch.name, base_url: ch.base_url.replace(/\/+$/, ""), endpoint: "" });
      }
    }
  }
  if (!upstreams.length) return { ok: false, message: "无有效上游渠道", status: 200 };

  const fetchFn = args.fetchFn ?? fetch;
  const testResults: TestResult[] = [];
  const successful: { name: string; data: SyncMap }[] = [];

  for (const u of upstreams) {
    const name = uniqueUpstreamName(u);
    const { url, openRouter, modelsDev } = resolveFullURL(u);
    try {
      const headers: Record<string, string> = {};
      if (openRouter) {
        if (!u.id) throw new Error("OpenRouter requires a valid channel with API key");
        const ch = channelById.get(u.id);
        if (!ch) throw new Error("failed to get channel key: channel not found");
        const key = firstEnabledKey(ch.key);
        if (!key) throw new Error("no API key configured for this channel");
        headers.Authorization = `Bearer ${key}`;
      }
      let lastErr: Error | null = null;
      let resp: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout * 1000);
        try {
          resp = await fetchFn(url, { headers, signal: ac.signal });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          await new Promise((r) => setTimeout(r, 200 * (1 << attempt)));
        } finally {
          clearTimeout(timer);
        }
      }
      if (lastErr || !resp) throw lastErr || new Error("fetch failed");
      if (resp.status !== 200) throw new Error(resp.statusText ? `${resp.status} ${resp.statusText}` : String(resp.status));
      const buf = new Uint8Array(await resp.arrayBuffer());
      const sliced = buf.byteLength > MAX_RATIO_CONFIG_BYTES ? buf.slice(0, MAX_RATIO_CONFIG_BYTES) : buf;
      const parsed = JSON.parse(new TextDecoder().decode(sliced)) as unknown;
      let data: SyncMap;
      if (openRouter) data = convertOpenRouterToRatioData(parsed);
      else if (modelsDev) data = convertModelsDevToRatioData(parsed);
      else data = parseUpstreamBody(parsed);
      successful.push({ name, data: effectivePricingSyncData(data) });
      testResults.push({ name, status: "success" });
    } catch (err) {
      testResults.push({ name, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const localData = effectivePricingSyncData(args.localData);
  const differences = buildDifferences(localData, successful);
  const prices: FetchUpstreamRatiosData["prices"] = {};
  for (const [name, fields] of Object.entries(differences)) {
    const row: { current: SyncMap; upstreams: Record<string, SyncMap> } = {
      current: modelPricingSyncValues(localData, name),
      upstreams: {},
    };
    const expressionPriority = BILLING_EXPR_FIELD in fields;
    for (const channel of successful) {
      const candidate = modelPricingSyncValues(channel.data, name);
      if (expressionPriority && candidate[BILLING_MODE_FIELD] !== BILLING_MODE_TIERED_EXPR) continue;
      if ("model_ratio" in candidate || "model_price" in candidate || BILLING_EXPR_FIELD in candidate) {
        row.upstreams[channel.name] = candidate;
      }
    }
    prices[name] = row;
  }

  return { ok: true, data: { differences, prices, test_results: testResults } };
}
