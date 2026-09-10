import { parseJson } from "./constants.js";
import { apiFail, apiOk, json } from "./http.js";
import type { ChannelRow } from "./types.js";

/** Original `model.Channel.GetKeys`. */
export function channelKeys(key: string): string[] {
  if (!key) return [];
  const trimmed = key.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        return arr.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      }
    } catch {
      /* fall through to newline split */
    }
  }
  return key.replace(/^\n+|\n+$/g, "").split("\n");
}

export type ChannelInfo = {
  is_multi_key: boolean;
  multi_key_size: number;
  multi_key_status_list: Record<string, number> | null;
  multi_key_disabled_reason?: Record<string, string>;
  multi_key_disabled_time?: Record<string, number>;
  multi_key_polling_index: number;
  multi_key_mode: string;
};

/** Original GORM zero `ChannelInfo` JSON. */
export function emptyChannelInfo(): ChannelInfo {
  return {
    is_multi_key: false,
    multi_key_size: 0,
    multi_key_status_list: null,
    multi_key_polling_index: 0,
    multi_key_mode: "",
  };
}

export function parseChannelInfo(raw: string): ChannelInfo {
  const parsed = parseJson<Partial<ChannelInfo> | null>(raw, null);
  if (!parsed || typeof parsed !== "object") return emptyChannelInfo();
  return {
    is_multi_key: Boolean(parsed.is_multi_key),
    multi_key_size: Number(parsed.multi_key_size || 0),
    multi_key_status_list: parsed.multi_key_status_list && typeof parsed.multi_key_status_list === "object" ? parsed.multi_key_status_list : null,
    multi_key_disabled_reason: parsed.multi_key_disabled_reason,
    multi_key_disabled_time: parsed.multi_key_disabled_time,
    multi_key_polling_index: Number(parsed.multi_key_polling_index || 0),
    multi_key_mode: String(parsed.multi_key_mode || ""),
  };
}

export function stringifyChannelInfo(info: ChannelInfo): string {
  const out: Record<string, unknown> = {
    is_multi_key: info.is_multi_key,
    multi_key_size: info.multi_key_size,
    multi_key_status_list: info.multi_key_status_list,
    multi_key_polling_index: info.multi_key_polling_index,
    multi_key_mode: info.multi_key_mode,
  };
  if (info.multi_key_disabled_reason && Object.keys(info.multi_key_disabled_reason).length) {
    out.multi_key_disabled_reason = info.multi_key_disabled_reason;
  }
  if (info.multi_key_disabled_time && Object.keys(info.multi_key_disabled_time).length) {
    out.multi_key_disabled_time = info.multi_key_disabled_time;
  }
  return JSON.stringify(out);
}

export function multiKeyInfoFromKeys(keys: string[], mode = "random"): ChannelInfo {
  return {
    is_multi_key: true,
    multi_key_size: keys.length,
    multi_key_status_list: {},
    multi_key_polling_index: 0,
    multi_key_mode: mode || "random",
  };
}

function statusAt(info: ChannelInfo, index: number): number {
  const list = info.multi_key_status_list;
  if (!list) return 1;
  const v = list[String(index)] ?? list[index as unknown as string];
  return Number(v || 1);
}

function lookupNum(map: Record<string, number> | undefined, index: number): number {
  if (!map) return 0;
  return Number(map[String(index)] ?? map[index as unknown as string] ?? 0);
}

function lookupStr(map: Record<string, string> | undefined, index: number): string {
  if (!map) return "";
  return String(map[String(index)] ?? map[index as unknown as string] ?? "");
}

function keyPreview(key: string): string {
  return key.length > 10 ? key.slice(0, 10) + "..." : key;
}

function statusMap(info: ChannelInfo): Record<string, number> {
  return info.multi_key_status_list && typeof info.multi_key_status_list === "object" ? { ...info.multi_key_status_list } : {};
}

function timeMap(info: ChannelInfo): Record<string, number> {
  return info.multi_key_disabled_time && typeof info.multi_key_disabled_time === "object" ? { ...info.multi_key_disabled_time } : {};
}

function reasonMap(info: ChannelInfo): Record<string, string> {
  return info.multi_key_disabled_reason && typeof info.multi_key_disabled_reason === "object" ? { ...info.multi_key_disabled_reason } : {};
}

export type MultiKeyManageRequest = {
  channel_id?: number;
  action?: string;
  key_index?: number;
  page?: number;
  page_size?: number;
  status?: number;
};

/** Original `controller.ManageMultiKeys`. */
export function manageMultiKeys(ch: ChannelRow, request: MultiKeyManageRequest): Response | { patch: { key?: string; channel_info: string }; response: Response } {
  const info = parseChannelInfo(String(ch.channel_info || ""));
  if (!info.is_multi_key) return apiFail("该渠道不是多密钥模式");
  const keys = channelKeys(ch.key);
  const size = info.multi_key_size > 0 ? info.multi_key_size : keys.length;
  const action = String(request.action || "");

  switch (action) {
    case "get_key_status": {
      let page = Number(request.page || 0);
      let pageSize = Number(request.page_size || 0);
      if (page <= 0) page = 1;
      if (pageSize <= 0) pageSize = 50;
      let enabledCount = 0;
      let manualDisabledCount = 0;
      let autoDisabledCount = 0;
      const all: Record<string, unknown>[] = [];
      for (let i = 0; i < keys.length; i++) {
        const status = statusAt(info, i);
        if (status === 1) enabledCount += 1;
        else if (status === 2) manualDisabledCount += 1;
        else if (status === 3) autoDisabledCount += 1;
        const row: Record<string, unknown> = { index: i, status, key_preview: keyPreview(keys[i] || "") };
        if (status !== 1) {
          const disabledTime = lookupNum(info.multi_key_disabled_time, i);
          const reason = lookupStr(info.multi_key_disabled_reason, i);
          if (disabledTime) row.disabled_time = disabledTime;
          if (reason) row.reason = reason;
        }
        all.push(row);
      }
      const filtered = request.status == null ? all : all.filter((row) => row.status === request.status);
      const filteredTotal = filtered.length;
      let totalPages = Math.floor((filteredTotal + pageSize - 1) / pageSize);
      if (totalPages === 0) totalPages = 1;
      if (page > totalPages) page = totalPages;
      const start = (page - 1) * pageSize;
      const pageKeys = start < filteredTotal ? filtered.slice(start, start + pageSize) : [];
      return apiOk({
        keys: pageKeys,
        total: filteredTotal,
        page,
        page_size: pageSize,
        total_pages: totalPages,
        enabled_count: enabledCount,
        manual_disabled_count: manualDisabledCount,
        auto_disabled_count: autoDisabledCount,
      });
    }
    case "disable_key": {
      if (request.key_index == null) return apiFail("未指定要禁用的密钥索引");
      const keyIndex = Number(request.key_index);
      if (keyIndex < 0 || keyIndex >= size) return apiFail("密钥索引超出范围");
      const next = { ...info, multi_key_status_list: statusMap(info), multi_key_disabled_time: timeMap(info), multi_key_disabled_reason: reasonMap(info) };
      next.multi_key_status_list![String(keyIndex)] = 2;
      return { patch: { channel_info: stringifyChannelInfo(next) }, response: json(200, { success: true, message: "密钥已禁用" }) };
    }
    case "enable_key": {
      if (request.key_index == null) return apiFail("未指定要启用的密钥索引");
      const keyIndex = Number(request.key_index);
      if (keyIndex < 0 || keyIndex >= size) return apiFail("密钥索引超出范围");
      const statuses = statusMap(info);
      const times = timeMap(info);
      const reasons = reasonMap(info);
      delete statuses[String(keyIndex)];
      delete times[String(keyIndex)];
      delete reasons[String(keyIndex)];
      const next = { ...info, multi_key_status_list: statuses, multi_key_disabled_time: times, multi_key_disabled_reason: reasons };
      return { patch: { channel_info: stringifyChannelInfo(next) }, response: json(200, { success: true, message: "密钥已启用" }) };
    }
    case "enable_all_keys": {
      const enabledCount = info.multi_key_status_list ? Object.keys(info.multi_key_status_list).length : 0;
      const next: ChannelInfo = {
        ...info,
        multi_key_status_list: {},
        multi_key_disabled_time: {},
        multi_key_disabled_reason: {},
      };
      return { patch: { channel_info: stringifyChannelInfo(next) }, response: json(200, { success: true, message: `已启用 ${enabledCount} 个密钥` }) };
    }
    case "disable_all_keys": {
      const statuses = statusMap(info);
      const times = timeMap(info);
      const reasons = reasonMap(info);
      let disabledCount = 0;
      for (let i = 0; i < size; i++) {
        const status = statusAt(info, i);
        if (status === 1) {
          statuses[String(i)] = 2;
          disabledCount += 1;
        }
      }
      if (disabledCount === 0) return apiFail("没有可禁用的密钥");
      const next = { ...info, multi_key_status_list: statuses, multi_key_disabled_time: times, multi_key_disabled_reason: reasons };
      return { patch: { channel_info: stringifyChannelInfo(next) }, response: json(200, { success: true, message: `已禁用 ${disabledCount} 个密钥` }) };
    }
    case "delete_key": {
      if (request.key_index == null) return apiFail("未指定要删除的密钥索引");
      const keyIndex = Number(request.key_index);
      if (keyIndex < 0 || keyIndex >= size) return apiFail("密钥索引超出范围");
      const remaining: string[] = [];
      const newStatus: Record<string, number> = {};
      const newTime: Record<string, number> = {};
      const newReason: Record<string, string> = {};
      let newIndex = 0;
      for (let i = 0; i < keys.length; i++) {
        if (i === keyIndex) continue;
        remaining.push(keys[i]);
        const status = statusAt(info, i);
        if (status !== 1) newStatus[String(newIndex)] = status;
        const t = lookupNum(info.multi_key_disabled_time, i);
        const r = lookupStr(info.multi_key_disabled_reason, i);
        if (t) newTime[String(newIndex)] = t;
        if (r) newReason[String(newIndex)] = r;
        newIndex += 1;
      }
      if (!remaining.length) return apiFail("不能删除最后一个密钥");
      const next: ChannelInfo = {
        ...info,
        multi_key_size: remaining.length,
        multi_key_status_list: newStatus,
        multi_key_disabled_time: newTime,
        multi_key_disabled_reason: newReason,
      };
      return { patch: { key: remaining.join("\n"), channel_info: stringifyChannelInfo(next) }, response: json(200, { success: true, message: "密钥已删除" }) };
    }
    case "delete_disabled_keys": {
      const remaining: string[] = [];
      const newStatus: Record<string, number> = {};
      const newTime: Record<string, number> = {};
      const newReason: Record<string, string> = {};
      let deletedCount = 0;
      let newIndex = 0;
      for (let i = 0; i < keys.length; i++) {
        const status = statusAt(info, i);
        if (status === 3) {
          deletedCount += 1;
          continue;
        }
        remaining.push(keys[i]);
        if (status !== 1) {
          newStatus[String(newIndex)] = status;
          const t = lookupNum(info.multi_key_disabled_time, i);
          const r = lookupStr(info.multi_key_disabled_reason, i);
          if (t) newTime[String(newIndex)] = t;
          if (r) newReason[String(newIndex)] = r;
        }
        newIndex += 1;
      }
      if (deletedCount === 0) return apiFail("没有需要删除的自动禁用密钥");
      const next: ChannelInfo = {
        ...info,
        multi_key_size: remaining.length,
        multi_key_status_list: newStatus,
        multi_key_disabled_time: newTime,
        multi_key_disabled_reason: newReason,
      };
      return {
        patch: { key: remaining.join("\n"), channel_info: stringifyChannelInfo(next) },
        response: json(200, { success: true, message: `已删除 ${deletedCount} 个自动禁用的密钥`, data: deletedCount }),
      };
    }
    default:
      return apiFail("不支持的操作");
  }
}

/** Original `channelSensitiveFields`. */
export const CHANNEL_SENSITIVE_FIELDS = new Set([
  "type",
  "key",
  "base_url",
  "openai_organization",
  "header_override",
  "param_override",
  "setting",
  "other",
  "settings",
  "key_mode",
]);

/** Original `channelNonSensitiveFields`. */
export const CHANNEL_NON_SENSITIVE_FIELDS = new Set([
  "id",
  "test_model",
  "name",
  "weight",
  "models",
  "group",
  "model_mapping",
  "status_code_mapping",
  "priority",
  "auto_ban",
  "other_info",
  "tag",
  "remark",
  "channel_info",
  "multi_key_mode",
]);

/** Original `channelOperationalFields`. */
export const CHANNEL_OPERATIONAL_FIELDS = new Set(["status"]);

/** Original `channelReadOnlyFields`. */
export const CHANNEL_READ_ONLY_FIELDS = new Set([
  "created_time",
  "test_time",
  "response_time",
  "balance",
  "balance_updated_time",
  "used_quota",
]);

function strEq(a: unknown, b: unknown): boolean {
  return String(a ?? "") === String(b ?? "");
}

/** Original `channelHasSensitiveChanges`. */
export function channelHasSensitiveChanges(
  next: Record<string, unknown>,
  origin: ChannelRow,
  requestData: Record<string, unknown>,
): boolean {
  if ("type" in requestData && Number(next.type) !== Number(origin.type)) return true;
  if ("key" in requestData && String(next.key || "") !== "" && String(next.key) !== String(origin.key)) return true;
  if ("base_url" in requestData && !strEq(next.base_url, origin.base_url)) return true;
  if ("openai_organization" in requestData && !strEq(next.openai_organization, origin.openai_organization)) return true;
  if ("header_override" in requestData && !strEq(next.header_override, origin.header_override)) return true;
  if ("param_override" in requestData && !strEq(next.param_override, origin.param_override)) return true;
  if ("setting" in requestData && !strEq(next.setting, origin.setting || origin.settings)) return true;
  if ("other" in requestData && !strEq(next.other, origin.other)) return true;
  if ("settings" in requestData && !strEq(next.settings, origin.settings)) return true;
  if ("key_mode" in requestData && next.key_mode != null) return true;
  for (const field of Object.keys(requestData)) {
    if (CHANNEL_SENSITIVE_FIELDS.has(field)) continue;
    if (CHANNEL_NON_SENSITIVE_FIELDS.has(field)) continue;
    if (CHANNEL_OPERATIONAL_FIELDS.has(field)) continue;
    if (CHANNEL_READ_ONLY_FIELDS.has(field)) continue;
    return true;
  }
  return false;
}

/** Original `clearChannelInfo` — drop disabled-reason maps from public JSON. */
export function clearChannelInfoPublic(info: Record<string, unknown>): Record<string, unknown> {
  if (!info.is_multi_key) return info;
  const { multi_key_disabled_reason: _r, multi_key_disabled_time: _t, ...rest } = info;
  return rest;
}

/** Original UpdateChannel key_mode=append. */
export function appendChannelKeys(existingKey: string, incomingKey: string): string {
  let existingKeys: string[] = [];
  const trimmed = existingKey.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) existingKeys = arr.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    } catch {
      existingKeys = existingKey.replace(/^\n+|\n+$/g, "").split("\n");
    }
  } else {
    existingKeys = existingKey.replace(/^\n+|\n+$/g, "").split("\n");
  }
  const newKeys = incomingKey.split("\n").map((k) => k.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const key of existingKeys) {
    const normalized = key.trim();
    if (normalized) seen.add(normalized);
  }
  const deduped: string[] = [];
  for (const key of newKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }
  return [...existingKeys, ...deduped].join("\n");
}
