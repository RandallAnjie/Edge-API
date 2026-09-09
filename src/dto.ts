import { parseJson } from "./constants.js";
import { maskKey, md5Hex } from "./crypto.js";
import type { Store } from "./store.js";
import type { ChannelRow, TokenRow, UserRow } from "./types.js";

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
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { default: 1 });
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
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { default: 1 });
  return auto.filter((g) => g && g !== "auto" && usable[g] != null && ratios[g] != null);
}

export async function userGroupsView(store: Store, userGroup = ""): Promise<Record<string, { ratio: number | string; desc: string }>> {
  const usable = await userUsableGroups(store, userGroup);
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { default: 1 });
  const out: Record<string, { ratio: number | string; desc: string }> = {};
  for (const [name, desc] of Object.entries(usable)) {
    if (name === "auto") {
      out.auto = { ratio: "自动", desc };
      continue;
    }
    if (ratios[name] == null) continue;
    out[name] = { ratio: ratios[name], desc };
  }
  if (usable.auto && !out.auto) out.auto = { ratio: "自动", desc: usable.auto };
  return out;
}

export function publicToken(t: TokenRow): Record<string, unknown> {
  const auto = parseJson<string[]>(String(t.auto_groups || ""), []);
  return {
    id: t.id,
    user_id: t.user_id,
    key: "sk-" + maskKey(t.key),
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

function defaultChannelInfo(key: string): Record<string, unknown> {
  const keys = String(key || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const multi = keys.length > 1;
  return {
    is_multi_key: multi,
    multi_key_size: keys.length,
    multi_key_status_list: {},
    multi_key_polling_index: 0,
    multi_key_mode: "random",
  };
}

export function publicChannel(c: ChannelRow, includeKey = false): Record<string, unknown> {
  const parsedInfo = parseJson<Record<string, unknown> | null>(String(c.channel_info || ""), null);
  const info = parsedInfo && typeof parsedInfo === "object" ? { ...defaultChannelInfo(c.key), ...parsedInfo } : defaultChannelInfo(c.key);
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
