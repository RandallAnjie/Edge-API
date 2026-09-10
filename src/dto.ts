import { ADAPTOR_MODELS, CHANNEL_TYPE_MODELS, CHANNEL_TYPE_OWNERS, OPENAI_MODEL_CREATED } from "./channel-models.js";
import { clearChannelInfoPublic } from "./channel-info.js";
import { DEFAULT_GROUP_RATIO, csv, parseJson } from "./constants.js";
import { hmacSha256Raw, maskKey, md5Hex } from "./crypto.js";
import type { Store } from "./store.js";
import type { ChannelRow, LogRow, TokenRow, UserRow } from "./types.js";

export const DEFAULT_USABLE_GROUPS: Record<string, string> = {
  default: "默认分组",
  vip: "vip分组",
};

export const DEFAULT_PAY_METHODS: Record<string, string>[] = [
  { name: "支付宝", icon: "SiAlipay", type: "alipay" },
  { name: "微信", icon: "SiWechat", type: "wxpay" },
  { name: "自定义1", icon: "LuCreditCard", type: "custom1", min_topup: "50" },
];

export const DEFAULT_AMOUNT_OPTIONS = [10, 20, 50, 100, 200, 500];

export const COMPLIANCE_TERMS_VERSION = "v1";

export const DEFAULT_ENDPOINT_INFO: Record<string, { path: string; method: string }> = {
  openai: { path: "/v1/chat/completions", method: "POST" },
  "openai-response": { path: "/v1/responses", method: "POST" },
  "openai-response-compact": { path: "/v1/responses/compact", method: "POST" },
  "openai-alpha-search": { path: "/v1/alpha/search", method: "POST" },
  anthropic: { path: "/v1/messages", method: "POST" },
  gemini: { path: "/v1beta/models/{model}:generateContent", method: "POST" },
  "jina-rerank": { path: "/v1/rerank", method: "POST" },
  "image-generation": { path: "/v1/images/generations", method: "POST" },
  embeddings: { path: "/v1/embeddings", method: "POST" },
};

const RESPONSE_ONLY = ["o3-pro", "o3-deep-research", "o4-mini-deep-research"];
const IMAGE_MODELS = ["dall-e-3", "dall-e-2", "gpt-image-1", "prefix:imagen-", "flux-", "flux.1-"];

function isResponseOnly(model: string): boolean {
  return RESPONSE_ONLY.some((m) => model.includes(m));
}

function isImageModel(model: string): boolean {
  const n = model.toLowerCase();
  return IMAGE_MODELS.some((m) => (m.startsWith("prefix:") ? n.startsWith(m.slice(7)) : n.includes(m)));
}

export function endpointTypesForChannel(type: number, modelName: string): string[] {
  let types: string[];
  switch (type) {
    case 38:
      types = ["jina-rerank"];
      break;
    case 14:
    case 33:
      types = ["anthropic", "openai"];
      break;
    case 24:
    case 41:
      types = ["gemini", "openai"];
      break;
    case 20:
      types = ["openai"];
      break;
    case 48:
      types = ["openai", "openai-response"];
      break;
    case 55:
      types = ["openai-video"];
      break;
    case 59:
    case 60:
      types = ["openai", "openai-response", "openai-response-compact", "anthropic", "gemini", "openai-alpha-search"];
      break;
    case 57:
      types = ["openai-response", "openai-response-compact", "openai-alpha-search"];
      break;
    default:
      types = isResponseOnly(modelName) ? ["openai-response"] : ["openai"];
  }
  if (isImageModel(modelName)) types = ["image-generation", ...types];
  return types;
}

export async function userUsableGroups(store: Store, userGroup = ""): Promise<Record<string, string>> {
  const groups = parseJson<Record<string, string>>(await store.option("UserUsableGroups"), { ...DEFAULT_USABLE_GROUPS });
  const specialAll = parseJson<Record<string, Record<string, string>>>(
    await store.option("GroupSpecialUsableGroup"),
    {},
  );
  const copy = { ...groups };
  const special = userGroup ? specialAll[userGroup] : undefined;
  if (special) {
    for (const [k, desc] of Object.entries(special)) {
      if (k.startsWith("-:")) delete copy[k.slice(2)];
      else if (k.startsWith("+:")) copy[k.slice(2)] = desc;
      else copy[k] = desc;
    }
  }
  if (userGroup && copy[userGroup] == null) copy[userGroup] = "用户分组";
  return copy;
}

export async function groupRatioMap(store: Store, userGroup = ""): Promise<Record<string, number>> {
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const usable = await userUsableGroups(store, userGroup);
  const out: Record<string, number> = {};
  for (const [g, ratio] of Object.entries(ratios)) {
    if (usable[g] != null) out[g] = ratio;
  }
  return out;
}

export async function userAutoGroups(store: Store, userGroup = ""): Promise<string[]> {
  const auto = parseJson<string[]>(await store.option("AutoGroups"), ["default"]);
  const usable = await userUsableGroups(store, userGroup);
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  return auto.filter((g) => g && g !== "auto" && usable[g] != null && ratios[g] != null);
}

export async function userGroupRatio(store: Store, userGroup = "", group: string): Promise<number> {
  const overlay = parseJson<Record<string, Record<string, number>>>(await store.option("GroupGroupRatio"), {});
  const nested = userGroup ? overlay[userGroup] : undefined;
  if (nested && nested[group] != null) return Number(nested[group]);
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  return ratios[group] ?? 1;
}

export async function userGroupsView(store: Store, userGroup = ""): Promise<Record<string, { ratio: number | string; desc: string }>> {
  const usable = await userUsableGroups(store, userGroup);
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const out: Record<string, { ratio: number | string; desc: string }> = {};
  for (const name of Object.keys(ratios)) {
    if (usable[name] == null) continue;
    out[name] = { ratio: await userGroupRatio(store, userGroup, name), desc: usable[name] };
  }
  if (usable.auto) out.auto = { ratio: "自动", desc: usable.auto };
  return out;
}

export function publicToken(t: TokenRow): Record<string, unknown> {
  const auto = parseJson<string[]>(String(t.auto_groups || ""), []);
  return {
    id: t.id,
    user_id: t.user_id,
    key: maskKey(t.key),
    status: t.status,
    name: t.name,
    created_time: t.created_time,
    accessed_time: t.accessed_time,
    expired_time: t.expired_time,
    remain_quota: t.remain_quota,
    unlimited_quota: Boolean(Number(t.unlimited_quota)),
    model_limits_enabled: Boolean(Number(t.model_limits_enabled)),
    model_limits: t.model_limits || "",
    allow_ips: t.allow_ips || "",
    used_quota: t.used_quota,
    group: t.group || "",
    cross_group_retry: Boolean(Number(t.cross_group_retry)),
    auto_groups: auto.length ? auto : null,
  };
}

export function publicChannel(c: ChannelRow, includeKey = false): Record<string, unknown> {
  const parsedInfo = parseJson<Record<string, unknown> | null>(String(c.channel_info || ""), null);
  let info: Record<string, unknown> =
    parsedInfo && typeof parsedInfo === "object"
      ? {
          is_multi_key: false,
          multi_key_size: 0,
          multi_key_status_list: null,
          multi_key_polling_index: 0,
          multi_key_mode: "",
          ...parsedInfo,
        }
      : {
          is_multi_key: false,
          multi_key_size: 0,
          multi_key_status_list: null,
          multi_key_polling_index: 0,
          multi_key_mode: "",
        };
  info = clearChannelInfoPublic(info);
  const setting = c.setting || c.settings || "";
  return {
    id: c.id,
    type: c.type,
    key: includeKey ? c.key : "",
    openai_organization: c.openai_organization || "",
    test_model: c.test_model || "",
    status: c.status,
    name: c.name,
    weight: Number(c.weight || 0),
    created_time: c.created_time,
    test_time: c.test_time || 0,
    response_time: c.response_time || 0,
    base_url: c.base_url || "",
    other: c.other || "",
    balance: Number(c.balance) || 0,
    balance_updated_time: Number(c.balance_updated_time) || 0,
    models: c.models || "",
    group: c.group || "default",
    used_quota: c.used_quota || 0,
    model_mapping: c.model_mapping || "",
    status_code_mapping: c.status_code_mapping || "",
    priority: c.priority || 0,
    auto_ban: c.auto_ban == null ? 1 : c.auto_ban,
    other_info: c.other_info || "",
    tag: c.tag || "",
    setting,
    param_override: c.param_override || "",
    header_override: c.header_override || "",
    remark: c.remark || "",
    max_input_tokens: 0,
    channel_info: info,
    settings: c.settings || "{}",
  };
}

export function stripChannelKey(c: ChannelRow): Record<string, unknown> {
  return publicChannel(c, false);
}

export function publicTopup(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id || 0),
    user_id: Number(row.user_id || 0),
    amount: Number(row.amount || 0),
    money: Number(row.money || 0),
    trade_no: String(row.trade_no || ""),
    payment_method: String(row.payment_method || ""),
    payment_provider: String(row.payment_provider || ""),
    create_time: Number(row.create_time ?? row.created_at ?? 0),
    complete_time: Number(row.complete_time || 0),
    status: String(row.status || ""),
  };
}

export async function buildPricing(
  store: Store,
  userGroup = "",
): Promise<{
  data: Record<string, unknown>[];
  vendors: unknown[];
  group_ratio: Record<string, number>;
  usable_group: Record<string, string>;
  supported_endpoint: Record<string, { path: string; method: string }>;
  auto_groups: string[];
  pricing_version: string;
}> {
  const models = await store.enabledModels(userGroup || "default");
  const channels = await store.enabledChannels();
  const modelRatio = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const completionRatio = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const modelPrice = parseJson<Record<string, number>>(await store.option("ModelPrice"), {});
  const meta = (await store.listModelMeta()) as {
    model_name?: string;
    description?: string;
    icon?: string;
    tags?: string;
    vendor_id?: number;
    status?: number;
  }[];
  const metaByName = new Map(meta.map((m) => [String(m.model_name), m]));
  const vendors = (await store.listVendors()) as { id: number; name: string; description?: string; icon?: string }[];
  const usable = await userUsableGroups(store, userGroup);
  const groupsByModel = new Map<string, Set<string>>();
  const typesByModel = new Map<string, string[]>();
  for (const ch of channels) {
    const chGroups = String(ch.group || "default")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    for (const name of String(ch.models || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)) {
      if (!groupsByModel.has(name)) groupsByModel.set(name, new Set());
      for (const g of chGroups) groupsByModel.get(name)!.add(g);
      const existing = typesByModel.get(name) || [];
      for (const et of endpointTypesForChannel(ch.type, name)) {
        if (!existing.includes(et)) existing.push(et);
      }
      typesByModel.set(name, existing);
    }
  }
  const names = models.length ? models : [...groupsByModel.keys()];
  const pricing: Record<string, unknown>[] = [];
  const supported: Record<string, { path: string; method: string }> = {};
  for (const name of names) {
    const enable_groups = [...(groupsByModel.get(name) || new Set(["default"]))];
    if (!enable_groups.includes("all") && !enable_groups.some((g) => usable[g] != null)) continue;
    const m = metaByName.get(name);
    if (m && m.status != null && Number(m.status) !== 1) continue;
    const endpoints = typesByModel.get(name) || endpointTypesForChannel(1, name);
    for (const et of endpoints) {
      if (DEFAULT_ENDPOINT_INFO[et] && !supported[et]) supported[et] = DEFAULT_ENDPOINT_INFO[et];
    }
    const priced = modelPrice[name];
    const item: Record<string, unknown> = {
      model_name: name,
      description: m?.description || "",
      icon: m?.icon || "",
      tags: m?.tags || "",
      vendor_id: m?.vendor_id || 0,
      quota_type: priced != null ? 1 : 0,
      model_ratio: priced != null ? 0 : (modelRatio[name] ?? 1),
      model_price: priced != null ? priced : 0,
      owner_by: "",
      completion_ratio: completionRatio[name] ?? 1,
      enable_groups,
      supported_endpoint_types: endpoints,
    };
    pricing.push(item);
  }
  const vendorList = vendors.map((v) => ({
    id: v.id,
    name: v.name,
    description: v.description || "",
    icon: v.icon || "",
  }));
  const version = await md5Hex(JSON.stringify({ models: names, modelRatio, completionRatio, modelPrice }));
  if (pricing[0]) pricing[0].pricing_version = version;
  return {
    data: pricing,
    vendors: vendorList,
    group_ratio: await groupRatioMap(store, userGroup),
    usable_group: usable,
    supported_endpoint: Object.keys(supported).length ? supported : { ...DEFAULT_ENDPOINT_INFO },
    auto_groups: await userAutoGroups(store, userGroup),
    pricing_version: version,
  };
}

export type VerificationMethodOption = { method: string; available: boolean; reason?: string };

export async function verificationRequirements(
  store: Store,
  user: UserRow,
  scope: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string; status: number }> {
  if (!scope || scope === "auth.login") {
    return { ok: false, code: "SECURITY_PROOF_SCOPE_MISMATCH", message: "Verification does not match this action.", status: 200 };
  }
  if (scope === "channel.key.read" && user.role < 100) {
    return { ok: false, code: "SECURITY_ACTION_FORBIDDEN", message: "This action is not allowed.", status: 403 };
  }
  const hasTwoFA = Number(user.totp_enabled) === 1;
  const hasPasskey = (await store.listPasskeys(user.id)).length > 0;
  const hasPassword = Boolean(user.password);
  const passkeyEnabled = await store.optionBool("PasskeyEnabled", true);
  const passwordLogin = await store.optionBool("PasswordLoginEnabled", true);
  const encryption = await store.optionBool("PasswordLoginEncryptionEnabled", false);

  if (scope === "2fa.disable" || scope === "2fa.backup_codes.regenerate") {
    if (!hasTwoFA) return { ok: false, code: "TWOFA_NOT_ENABLED", message: "Two-factor authentication is not enabled.", status: 200 };
  }
  if (scope === "2fa.setup" && hasTwoFA) {
    return { ok: false, code: "TWOFA_ALREADY_ENABLED", message: "Two-factor authentication is already enabled.", status: 200 };
  }
  if (scope === "account.delete" && user.role >= 100) {
    return { ok: false, code: "SECURITY_ACTION_FORBIDDEN", message: "This action is not allowed.", status: 403 };
  }
  if (scope === "account.password.set" && hasPassword) {
    return { ok: false, code: "SECURITY_ACTION_FORBIDDEN", message: "This action is not allowed.", status: 403 };
  }
  if (scope === "account.password.change" && !hasPassword) {
    return { ok: false, code: "SECURITY_ACTION_FORBIDDEN", message: "This action is not allowed.", status: 403 };
  }

  const fallbackScopes = new Set([
    "passkey.register",
    "2fa.setup",
    "access_token.generate",
    "access_token.revoke",
    "account.binding.bind",
    "account.binding.unbind",
    "account.password.set",
    "account.password.change",
    "account.delete",
  ]);
  const known = new Set(["channel.key.read", "passkey.delete", "2fa.disable", "2fa.backup_codes.regenerate", ...fallbackScopes]);
  if (!known.has(scope)) {
    return { ok: false, code: "SECURITY_PROOF_SCOPE_MISMATCH", message: "Verification does not match this action.", status: 200 };
  }

  let methods: string[] = [];
  if (hasTwoFA) methods.push("2fa");
  if (hasPasskey) methods.push("passkey");
  if (fallbackScopes.has(scope) && methods.length === 0) {
    methods = hasPassword ? ["password"] : ["oauth"];
  }

  const options: VerificationMethodOption[] = methods.map((method) => {
    const option: VerificationMethodOption = { method, available: true };
    if (!passkeyEnabled && (method === "passkey" || scope === "passkey.register")) {
      option.available = false;
      option.reason = "Passkey authentication is disabled.";
    }
    if (method === "password" && !passwordLogin) {
      option.available = false;
      option.reason = "Password authentication is disabled.";
    }
    return option;
  });

  const oauth_providers: { slug: string; name: string }[] = [];
  if (methods.includes("oauth")) {
    const providers = ((await store.listOAuthProviders()) as { slug?: string; name?: string; enabled?: number }[]).filter(
      (p) => Number(p.enabled) === 1,
    );
    for (const p of providers) oauth_providers.push({ slug: String(p.slug || ""), name: String(p.name || "") });
  }

  return {
    ok: true,
    data: {
      scope,
      methods: options,
      oauth_providers,
      password_encryption_enabled: encryption,
    },
  };
}

const LOG_OTHER_USER_STRIP = ["admin_info", "root_info", "audit_info", "channel_id", "channel_name", "channel_type", "reject_reason"];

export type LogVisibility = "user" | "admin" | "root";

export function logVisibilityForRole(role: number): LogVisibility {
  if (role >= 100) return "root";
  if (role >= 10) return "admin";
  return "user";
}

export function formatLogOtherJSON(value: string, visibility: LogVisibility): string {
  if (!value) return "";
  const parsed = parseJson<Record<string, unknown> | null>(value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return visibility === "root" ? value : "{}";
  }
  const out = { ...parsed };
  let changed = false;
  if (visibility === "user") {
    for (const key of LOG_OTHER_USER_STRIP) {
      if (key in out) {
        delete out[key];
        changed = true;
      }
    }
  } else if (visibility === "admin") {
    if ("root_info" in out) {
      delete out.root_info;
      changed = true;
    }
  }
  return changed ? JSON.stringify(out) : value;
}

export function publicModelMeta(
  row: Record<string, unknown>,
  extra: {
    bound_channels?: { name: string; type: number }[];
    enable_groups?: string[];
    quota_types?: number[];
    configured_channel_count?: number;
    square_state?: string;
  } = {},
): Record<string, unknown> {
  const endpointsRaw = String(row.endpoints || "");
  const supported = parseJson<string[]>(endpointsRaw, []);
  const created = Number(row.created_time || row.created_at || 0);
  return {
    id: row.id,
    model_name: row.model_name,
    description: row.description || "",
    icon: row.icon || "",
    tags: row.tags || "",
    vendor_id: Number(row.vendor_id || 0),
    endpoints: endpointsRaw,
    supported_endpoints: supported.length ? supported : undefined,
    status: row.status == null ? 1 : Number(row.status),
    sync_official: row.sync_official == null ? 1 : Number(row.sync_official),
    created_time: created,
    updated_time: Number(row.updated_time || created),
    name_rule: Number(row.name_rule || 0),
    has_metadata: true,
    configured_channel_count: extra.configured_channel_count ?? extra.bound_channels?.length ?? 0,
    square_state: extra.square_state || (extra.configured_channel_count ? "visible" : "hidden"),
    bound_channels: extra.bound_channels,
    enable_groups: extra.enable_groups,
    quota_types: extra.quota_types,
  };
}

export async function enrichModelMeta(store: Store, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const channels = await store.enabledChannels();
  const byModel = new Map<string, { name: string; type: number; groups: Set<string> }[]>();
  for (const ch of channels) {
    const groups = String(ch.group || "default")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    for (const name of csv(ch.models || "")) {
      if (!byModel.has(name)) byModel.set(name, []);
      byModel.get(name)!.push({ name: ch.name, type: ch.type, groups: new Set(groups) });
    }
  }
  return rows.map((row) => {
    const modelName = String(row.model_name || "");
    const bound = byModel.get(modelName) || [];
    const enable_groups = [...new Set(bound.flatMap((b) => [...b.groups]))];
    const configured = bound.length;
    let square_state = "hidden";
    if (configured > 0) square_state = "visible";
    if (Number(row.status) === 0) square_state = "hidden";
    return publicModelMeta(row, {
      bound_channels: bound.map((b) => ({ name: b.name, type: b.type })),
      enable_groups,
      quota_types: [0],
      configured_channel_count: configured,
      square_state,
    });
  });
}

export function consumeLogOther(opts: {
  model: string;
  group: string;
  groupRatio: number;
  modelRatio: number;
  completionRatio: number;
  channelId: number;
  channelName: string;
  channelType: number;
  ok: boolean;
  requestPath?: string;
}): string {
  const other: Record<string, unknown> = {
    group_ratio: opts.groupRatio,
    model_ratio: opts.modelRatio,
    completion_ratio: opts.completionRatio,
    group: opts.group,
  };
  if (opts.requestPath) other.request_path = opts.requestPath;
  other.admin_info = {
    use_channel: [opts.channelId],
    channel_id: opts.channelId,
    channel_name: opts.channelName,
    channel_type: opts.channelType,
  };
  if (!opts.ok) other.admin_info = { ...(other.admin_info as object), reject_reason: "upstream_error" };
  return JSON.stringify(other);
}

export function publicLog(row: LogRow, role = 1): Record<string, unknown> {
  const vis = logVisibilityForRole(role);
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    type: row.type,
    content: row.content,
    username: row.username || "",
    token_name: row.token_name || "",
    model_name: row.model_name || "",
    quota: row.quota || 0,
    prompt_tokens: row.prompt_tokens || 0,
    completion_tokens: row.completion_tokens || 0,
    use_time: row.use_time || 0,
    is_stream: Boolean(Number(row.is_stream)),
    channel: Number(row.channel_id || 0),
    channel_name: row.channel_name || "",
    token_id: row.token_id || 0,
    group: row.group || "",
    ip: row.ip || "",
    other: formatLogOtherJSON(row.other || "", vis),
    request_id: row.request_id || "",
    upstream_request_id: row.upstream_request_id || "",
  };
}

/** Original `model.formatUserLogs`: user-visible other, empty channel_name, 1-based display ids. */
export function publicUserLogs(rows: LogRow[], startIdx: number): Record<string, unknown>[] {
  return rows.map((row, i) => {
    const item = publicLog(row, 1);
    item.id = startIdx + i + 1;
    item.channel_name = "";
    return item;
  });
}

export function dashboardListModels(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, models] of Object.entries(CHANNEL_TYPE_MODELS)) out[id] = [...models];
  return out;
}

function channelTypeForOwner(ownedBy: string): number {
  for (const [id, name] of Object.entries(CHANNEL_TYPE_OWNERS)) {
    if (name === ownedBy) return Number(id);
  }
  return 1;
}

export function openaiCreatedAtRfc3339(): string {
  return new Date(OPENAI_MODEL_CREATED * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function openAIModel(id: string, ownedBy = "custom"): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: OPENAI_MODEL_CREATED,
    owned_by: ownedBy,
    supported_endpoint_types: endpointTypesForChannel(channelTypeForOwner(ownedBy), id),
  };
}

export function anthropicModel(id: string): Record<string, unknown> {
  return {
    id,
    created_at: openaiCreatedAtRfc3339(),
    display_name: id,
    type: "model",
  };
}

export function geminiModel(id: string): Record<string, unknown> {
  return { name: id, displayName: id };
}

export function openaiModelList(models: Record<string, unknown>[]): Record<string, unknown> {
  return { success: true, data: models, object: "list" };
}

export function modelNotFoundError(modelId: string): Record<string, unknown> {
  return {
    error: {
      message: `The model '${modelId}' does not exist`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}

export function channelListModels(): Record<string, unknown>[] {
  return ADAPTOR_MODELS.map((m) => openAIModel(m.id, m.owned_by));
}

export function ownerForChannelType(type: number): string {
  return CHANNEL_TYPE_OWNERS[type] || CHANNEL_TYPE_OWNERS[1] || "custom";
}

export function isSensitiveOptionKey(key: string): boolean {
  if (/ClientId$/i.test(key)) return false;
  return /Token$|Secret$|Key$|secret$|api_key$/i.test(key);
}

export function publicOptions(options: { key: string; value: string }[]): { key: string; value: string }[] {
  const optionValues: Record<string, string> = {};
  const out: { key: string; value: string }[] = [];
  for (const row of options) {
    if (row.key === "theme.frontend" || row.key === "billing_setting.billing_mode" || row.key === "billing_setting.billing_expr") continue;
    if (isSensitiveOptionKey(row.key)) continue;
    out.push({ key: row.key, value: row.value });
    if (["ModelPrice", "ModelRatio", "CompletionRatio", "CacheRatio", "CreateCacheRatio", "ImageRatio", "AudioRatio", "AudioCompletionRatio"].includes(row.key)) {
      optionValues[row.key] = row.value;
    }
  }
  const names = new Set<string>();
  for (const raw of Object.values(optionValues)) {
    const parsed = parseJson<Record<string, unknown>>(raw, {});
    for (const name of Object.keys(parsed)) names.add(name);
  }
  const completion = parseJson<Record<string, number>>(optionValues.CompletionRatio || "{}", {});
  const meta: Record<string, { ratio: number; locked: boolean }> = {};
  for (const name of names) meta[name] = { ratio: completion[name] ?? 1, locked: false };
  out.push({ key: "billing_setting.billing_mode", value: "{}" });
  out.push({ key: "billing_setting.billing_expr", value: "{}" });
  out.push({ key: "CompletionRatioMeta", value: JSON.stringify(meta) });
  return out;
}

export function exposedRatioConfig(opts: {
  model_ratio: Record<string, number>;
  completion_ratio: Record<string, number>;
  cache_ratio: Record<string, number>;
  create_cache_ratio: Record<string, number>;
  model_price: Record<string, number>;
  billing_mode?: Record<string, string>;
  billing_expr?: Record<string, string>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model_ratio: opts.model_ratio,
    completion_ratio: opts.completion_ratio,
    cache_ratio: opts.cache_ratio,
    create_cache_ratio: opts.create_cache_ratio,
    model_price: opts.model_price,
  };
  if (opts.billing_mode && Object.keys(opts.billing_mode).length) out.billing_mode = opts.billing_mode;
  if (opts.billing_expr && Object.keys(opts.billing_expr).length) out.billing_expr = opts.billing_expr;
  return out;
}

export function rankingsResponse(
  rows: { model_name: string; token_used: number; quota: number }[],
): Record<string, unknown> {
  const total = rows.reduce((s, r) => s + Number(r.token_used || 0), 0) || 1;
  const models = rows.map((r, i) => {
    const name = String(r.model_name || "");
    const slash = name.indexOf("/");
    const vendor = slash > 0 ? name.slice(0, slash) : "Unknown";
    return {
      rank: i + 1,
      model_name: name,
      vendor,
      category: "all",
      total_tokens: Number(r.token_used || 0),
      share: Number(r.token_used || 0) / total,
      growth_pct: 0,
    };
  });
  const vendorMap = new Map<string, { tokens: number; models: Set<string>; top: string; topTokens: number }>();
  for (const m of models) {
    const v = vendorMap.get(m.vendor) || { tokens: 0, models: new Set<string>(), top: m.model_name, topTokens: 0 };
    v.tokens += m.total_tokens;
    v.models.add(m.model_name);
    if (m.total_tokens > v.topTokens) {
      v.top = m.model_name;
      v.topTokens = m.total_tokens;
    }
    vendorMap.set(m.vendor, v);
  }
  const vendorTotal = [...vendorMap.values()].reduce((s, v) => s + v.tokens, 0) || 1;
  const vendors = [...vendorMap.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([vendor, v], i) => ({
      rank: i + 1,
      vendor,
      total_tokens: v.tokens,
      share: v.tokens / vendorTotal,
      growth_pct: 0,
      models_count: v.models.size,
      top_model: v.top,
    }));
  return {
    models: models.slice(0, 20),
    vendors,
    top_movers: [],
    top_droppers: [],
    models_history: {
      points: [],
      models: models.slice(0, 10).map((m) => ({ name: m.model_name, vendor: m.vendor, total: m.total_tokens })),
      buckets: 0,
    },
    vendor_share_history: {
      points: [],
      vendors: vendors.slice(0, 5).map((v) => ({ name: v.vendor, total: v.total_tokens, share: v.share })),
      buckets: 0,
    },
  };
}

/** Original `model.QuotaData` JSON (GORM still emits zero fields for unselected columns). */
export function publicQuotaData(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id || 0),
    user_id: Number(row.user_id || 0),
    username: String(row.username || ""),
    model_name: String(row.model_name || ""),
    created_at: Number(row.created_at || 0),
    use_group: String(row.use_group || ""),
    token_id: Number(row.token_id || 0),
    channel_id: Number(row.channel_id || 0),
    node_name: String(row.node_name || ""),
    token_used: Number(row.token_used || 0),
    count: Number(row.count || 0),
    quota: Number(row.quota || 0),
  };
}

/** Original `controller.ManageUser` encodes a zero `model.User` with only role/status set. */
export function manageUserView(role: number, status: number): Record<string, unknown> {
  return {
    id: 0,
    username: "",
    password: "",
    original_password: "",
    display_name: "",
    role,
    status,
    email: "",
    github_id: "",
    discord_id: "",
    oidc_id: "",
    wechat_id: "",
    telegram_id: "",
    verification_code: "",
    quota: 0,
    used_quota: 0,
    request_count: 0,
    group: "",
    aff_code: "",
    aff_count: 0,
    aff_quota: 0,
    aff_history_quota: 0,
    inviter_id: 0,
    linux_do_id: "",
    setting: "",
    stripe_customer: "",
    created_at: 0,
    last_login_at: 0,
  };
}

export function publicVendor(row: Record<string, unknown>, modelCount = 0): Record<string, unknown> {
  const created = Number(row.created_time || row.created_at || 0);
  const updated = Number(row.updated_time || created);
  const id = Number(row.id || 0);
  const name = String(row.name || "");
  const description = String(row.description || "");
  const icon = String(row.icon || "");
  const status = Number(row.status ?? 1);
  const payload = JSON.stringify([id, name, description, icon, status, created, updated]);
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return {
    id,
    name,
    description,
    icon,
    status,
    created_time: created,
    updated_time: updated,
    model_count: modelCount,
    version: (h >>> 0).toString(16).padStart(8, "0"),
  };
}

export function publicPrefill(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.items;
  let items: unknown = raw;
  if (typeof raw === "string") {
    const parsed = parseJson<unknown>(raw, raw);
    items = parsed;
  }
  const created = Number(row.created_time || row.created_at || 0);
  return {
    id: Number(row.id || 0),
    name: String(row.name || ""),
    type: String(row.type || ""),
    items,
    description: String(row.description || ""),
    created_time: created,
    updated_time: Number(row.updated_time || created),
  };
}

export function extractPluginMeta(source: string): Record<string, unknown> {
  const idx = source.search(/\bmeta\s*=\s*\{/);
  if (idx < 0) return {};
  const start = source.indexOf("{", idx);
  if (start < 0) return {};
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = source.slice(start, i + 1);
        const jsonish = raw
          .replace(/'([^'\\]*)'/g, '"$1"')
          .replace(/([,{]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
          .replace(/,(\s*[}\]])/g, "$1");
        return parseJson<Record<string, unknown>>(jsonish, {});
      }
    }
  }
  return {};
}

export function taskPluginMetaView(meta: Record<string, unknown>, fallback: { key: string; version?: string; name?: string } = { key: "" }): Record<string, unknown> {
  const key = String(meta.key || fallback.key || "");
  const version = String(meta.version || fallback.version || "1.0.0");
  const name = String(meta.name || fallback.name || key);
  const authorRaw = meta.author && typeof meta.author === "object" ? (meta.author as Record<string, unknown>) : {};
  return {
    sortPriority: Number(meta.sortPriority || 0) || undefined,
    website: meta.website ? String(meta.website) : undefined,
    apiVersion: Number(meta.apiVersion ?? meta.api_version ?? 1) || 1,
    key,
    name,
    icon: meta.icon ? String(meta.icon) : undefined,
    description: meta.description,
    version,
    author: { name: String(authorRaw.name || ""), url: authorRaw.url ? String(authorRaw.url) : undefined },
    baseUrl: meta.baseUrl ? String(meta.baseUrl) : undefined,
    channelTypes: Array.isArray(meta.channelTypes) ? meta.channelTypes : undefined,
    models: Array.isArray(meta.models) ? meta.models : [],
    fetchMode: String(meta.fetchMode || "per_task"),
    allowedHosts: Array.isArray(meta.allowedHosts) ? meta.allowedHosts : [],
    routes: Array.isArray(meta.routes) ? meta.routes : [],
    protocols: Array.isArray(meta.protocols) ? meta.protocols : [],
    usageSchema: meta.usageSchema,
    auth: meta.auth && typeof meta.auth === "object" ? meta.auth : { type: "" },
  };
}

export function publicTaskPluginRecord(row: Record<string, unknown>): Record<string, unknown> {
  const enabled = row.enabled != null ? Boolean(Number(row.enabled) || row.enabled === true || row.enabled === "true") : String(row.status || "") === "active" || String(row.status || "") === "enabled";
  const active = row.active != null ? Boolean(Number(row.active) || row.active === true) : enabled;
  return {
    id: Number(row.id || 0),
    key: String(row.key || ""),
    api_version: Number(row.api_version ?? row.apiVersion ?? 1),
    version: String(row.version || "1.0.0"),
    source: String(row.source || ""),
    source_hash: String(row.source_hash || ""),
    enabled,
    active,
    created_at: Number(row.created_at || 0),
    remark: String(row.remark || ""),
  };
}

export function publicSystemTask(row: Record<string, unknown>, numericId = 0): Record<string, unknown> {
  const statusRaw = String(row.status || "pending");
  const status = statusRaw === "success" ? "succeeded" : statusRaw;
  const taskId = String(row.task_id || row.id || "");
  const decode = (raw: unknown) => {
    if (raw == null || raw === "") return null;
    if (typeof raw !== "string") return raw;
    return parseJson(raw, raw);
  };
  return {
    id: Number(row.rowid || row.numeric_id || numericId || 0),
    task_id: taskId,
    type: String(row.type || ""),
    status,
    payload: decode(row.payload),
    state: decode(row.state),
    result: decode(row.result),
    error: String(row.error || ""),
    locked_by: String(row.locked_by || ""),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

const LEGACY_TASK_ACTIONS: Record<string, string> = {
  generate: "image_to_video",
  textGenerate: "text_to_video",
  firstTailGenerate: "first_tail_to_video",
  referenceGenerate: "reference_to_video",
  remixGenerate: "remix",
};

const VIDEO_TASK_ACTIONS = new Set(["image_to_video", "text_to_video", "first_tail_to_video", "reference_to_video", "remix"]);

export function normalizeTaskAction(action: string): string {
  return LEGACY_TASK_ACTIONS[action] || action;
}

function parseTaskPrivate(row: Record<string, unknown>): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(String(row.private_data || ""), {});
}

function taskFailReasonIsLegacyResultURL(reason: string): boolean {
  return /^https?:\/\//i.test(reason.trim());
}

export function taskResultURL(row: Record<string, unknown>): string {
  const priv = parseTaskPrivate(row);
  const url = String(priv.result_url || "").trim();
  if (url) return url;
  return String(row.fail_reason || "").trim();
}

export function taskHasPluginExecution(row: Record<string, unknown>): boolean {
  const exec = parseTaskPrivate(row).execution as { task_plugin?: { key?: string } } | undefined;
  return Boolean(exec?.task_plugin?.key?.trim());
}

export function legacyVideoAvailable(row: Record<string, unknown>): boolean {
  if (String(row.status) !== "SUCCESS") return false;
  if (taskHasPluginExecution(row)) return false;
  if (String(row.platform) === "suno") return false;
  if (!taskResultURL(row)) return false;
  return VIDEO_TASK_ACTIONS.has(normalizeTaskAction(String(row.action || "")));
}

export function publicTask(row: Record<string, unknown>, fillUser: boolean, viewerRole: number): Record<string, unknown> {
  const status = String(row.status || "");
  let failReason = String(row.fail_reason || "");
  if (status === "SUCCESS") {
    if (taskFailReasonIsLegacyResultURL(failReason)) failReason = "";
  }
  const createdAt = Number(row.created_at || 0) || Number(row.submit_time || 0);
  const propertiesRaw = row.properties;
  const parsedProperties =
    typeof propertiesRaw === "string"
      ? parseJson<Record<string, unknown>>(propertiesRaw, {})
      : ((propertiesRaw as Record<string, unknown>) ?? {});
  const properties =
    parsedProperties && typeof parsedProperties === "object" && !Array.isArray(parsedProperties)
      ? { input: "", ...parsedProperties }
      : { input: "" };
  const dataRaw = row.data;
  const data =
    typeof dataRaw === "string" ? parseJson(dataRaw, dataRaw ? dataRaw : null) : dataRaw ?? null;
  const item: Record<string, unknown> = {
    id: Number(row.id || 0),
    created_at: createdAt,
    updated_at: Number(row.updated_at || 0),
    task_id: String(row.task_id || ""),
    platform: String(row.platform || ""),
    user_id: Number(row.user_id || 0),
    group: String(row.group || ""),
    channel_id: Number(row.channel_id || 0),
    quota: Number(row.quota || 0),
    action: normalizeTaskAction(String(row.action || "")),
    status,
    fail_reason: failReason,
    submit_time: Number(row.submit_time || 0),
    start_time: Number(row.start_time || 0),
    finish_time: Number(row.finish_time || 0),
    progress: String(row.progress || ""),
    properties,
    data,
  };
  if (status !== "SUCCESS") {
    const url = taskResultURL(row);
    if (url) item.result_url = url;
  }
  if (legacyVideoAvailable(row)) item.legacy_video_available = true;
  if (fillUser) item.username = String(row.username || "");
  const priv = parseTaskPrivate(row);
  const execution = priv.execution as
    | {
        request_id?: string;
        request_path?: string;
        task_plugin?: { key?: string; name?: string; version?: string; author?: { name?: string; url?: string } };
      }
    | undefined;
  if (viewerRole >= 10) {
    const admin: Record<string, unknown> = {};
    if (execution?.request_id) admin.request_id = execution.request_id;
    if (execution?.request_path) admin.request_path = execution.request_path;
    if (execution?.task_plugin?.key) {
      admin.task_plugin = {
        key: execution.task_plugin.key,
        name: execution.task_plugin.name || "",
        version: execution.task_plugin.version || undefined,
        author: execution.task_plugin.author
          ? { name: execution.task_plugin.author.name || "", url: execution.task_plugin.author.url }
          : undefined,
      };
    }
    if (Object.keys(admin).length) item.admin_info = admin;
  }
  if (viewerRole >= 100) {
    const plugin = execution?.task_plugin;
    const root: Record<string, unknown> = {};
    if (plugin?.key) {
      root.task_plugin = {
        key: plugin.key,
        version: plugin.version || "",
        api_version: 1,
        generation: 0,
      };
    }
    if (priv.upstream_task_id) root.upstream_task_id = priv.upstream_task_id;
    if (priv.node_name) root.node_name = priv.node_name;
    if (Object.keys(root).length) item.root_info = root;
  }
  return item;
}

/** Original `model.TaskStatus.ToVideoStatus`. */
export function taskStatusToVideoStatus(status: string): string {
  switch (status) {
    case "NOT_START":
    case "QUEUED":
    case "SUBMITTED":
      return "queued";
    case "IN_PROGRESS":
      return "in_progress";
    case "SUCCESS":
      return "completed";
    case "FAILURE":
      return "failed";
    default:
      return "unknown";
  }
}

/** Original `model.Task.ToOpenAIVideo`. */
export function openaiVideoView(row: Record<string, unknown>): Record<string, unknown> {
  const status = String(row.status || "");
  const properties =
    typeof row.properties === "string"
      ? parseJson<Record<string, unknown>>(row.properties, {})
      : ((row.properties as Record<string, unknown> | undefined) ?? {});
  const progressRaw = String(row.progress || "").replace(/%$/, "");
  const progress = Number.parseInt(progressRaw, 10);
  const out: Record<string, unknown> = {
    id: String(row.task_id || ""),
    object: "video",
    model: String(properties.origin_model_name || ""),
    status: taskStatusToVideoStatus(status),
    progress: Number.isFinite(progress) ? progress : 0,
    created_at: Number(row.created_at || 0),
  };
  if (status === "SUCCESS") {
    const completed = Number(row.finish_time || 0) || Number(row.updated_at || 0);
    if (completed) out.completed_at = completed;
  }
  return out;
}

export function taskFetchView(row: Record<string, unknown>): Record<string, unknown> {
  const createdAt = Number(row.created_at || 0) || Number(row.submit_time || 0);
  const status = String(row.status || "");
  let failReason = String(row.fail_reason || "");
  if (status === "SUCCESS" && taskFailReasonIsLegacyResultURL(failReason)) failReason = "";
  return {
    task_id: String(row.task_id || ""),
    platform: String(row.platform || ""),
    status,
    progress: String(row.progress || ""),
    fail_reason: failReason,
    created_at: createdAt,
    finished_at: Number(row.finish_time || 0),
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function issueTaskArtifactAccess(secret: string, taskID: string, artifactKey: string): Promise<string> {
  const msg = new TextEncoder().encode(`v1\0${taskID}\0${artifactKey}`);
  return bytesToBase64Url(await hmacSha256Raw(secret, msg));
}

export async function buildTaskArtifactContentURL(store: Store, taskID: string, artifactKey: string): Promise<string> {
  const baseAddress = ((await store.option("TaskPublicAddress")) || (await store.option("ServerAddress"))).trim();
  if (!baseAddress) throw new Error("task artifact base URL is empty");
  const parsed = new URL(baseAddress);
  if (!/^https?:$/i.test(parsed.protocol) || !parsed.host) throw new Error("task artifact base URL is invalid");
  const secret = (await store.option("SessionSecret")) || "new-api";
  const access = await issueTaskArtifactAccess(secret, taskID, artifactKey);
  const prefix = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `${prefix}/v1/tasks/${taskID}/artifacts/${artifactKey}/content`;
  parsed.search = "";
  parsed.hash = "";
  parsed.searchParams.set("access", access);
  return parsed.toString();
}

export async function taskArtifactsView(
  store: Store,
  row: Record<string, unknown>,
): Promise<{ task_id: string; artifacts: { key: string; type: string; mime_type?: string; content_url: string }[]; legacy_content_url?: string }> {
  const taskId = String(row.task_id || "");
  const artifacts: { key: string; type: string; mime_type?: string; content_url: string }[] = [];
  const response: {
    task_id: string;
    artifacts: { key: string; type: string; mime_type?: string; content_url: string }[];
    legacy_content_url?: string;
  } = { task_id: taskId, artifacts };
  if (legacyVideoAvailable(row)) {
    response.legacy_content_url = await buildTaskArtifactContentURL(store, taskId, "video");
  }
  return response;
}

export function publicMj(row: Record<string, unknown>, serverAddress: string, forwardUrl: boolean): Record<string, unknown> {
  const mjId = String(row.mj_id || "");
  const imageUrl =
    forwardUrl && serverAddress ? `${serverAddress.replace(/\/$/, "")}/mj/image/${mjId}` : String(row.image_url || "");
  return {
    id: Number(row.id || 0),
    code: Number(row.code || 0),
    user_id: Number(row.user_id || 0),
    action: String(row.action || ""),
    mj_id: mjId,
    prompt: String(row.prompt || ""),
    prompt_en: String(row.prompt_en || ""),
    description: String(row.description || ""),
    state: String(row.state || ""),
    submit_time: Number(row.submit_time || 0),
    start_time: Number(row.start_time || 0),
    finish_time: Number(row.finish_time || 0),
    image_url: imageUrl,
    video_url: String(row.video_url || ""),
    video_urls: String(row.video_urls || ""),
    status: String(row.status || ""),
    progress: String(row.progress || ""),
    fail_reason: String(row.fail_reason || ""),
    channel_id: Number(row.channel_id || 0),
    quota: Number(row.quota || 0),
    buttons: String(row.buttons || ""),
    properties: String(row.properties || ""),
  };
}
