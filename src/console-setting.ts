/**
 * Original `setting/console_setting` UpdateOption validators.
 */

import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";

const URL_RE =
  /^https?:\/\/(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))(?::[0-9]{1,5})?(?:\/.*)?$/;
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
const DANGEROUS_CHARS = ["<script", "<iframe", "javascript:", "onload=", "onerror=", "onclick="];
const VALID_COLORS = new Set([
  "blue",
  "green",
  "cyan",
  "purple",
  "pink",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "light-green",
  "teal",
  "light-blue",
  "indigo",
  "violet",
  "grey",
  "slate",
]);
const VALID_ANNOUNCEMENT_TYPES = new Set(["default", "ongoing", "success", "warning", "error"]);

const SLICE_MAP_TYPE = "[]map[string]interface {}";
const MAP_TYPE = "map[string]interface {}";

function exceedsMaxCharacters(s: string, max: number): boolean {
  return s.length > max;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJSONArray(
  jsonStr: string,
  typeName: string,
): { ok: true; value: Record<string, unknown>[] } | { ok: false; message: string } {
  const parsed = goUnmarshalJSON(jsonStr);
  if (!parsed.ok) return { ok: false, message: `${typeName}格式错误：${parsed.message}` };
  if (parsed.value === null) return { ok: true, value: [] };
  if (!Array.isArray(parsed.value)) {
    return {
      ok: false,
      message: `${typeName}格式错误：json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${SLICE_MAP_TYPE}`,
    };
  }
  const out: Record<string, unknown>[] = [];
  for (const item of parsed.value) {
    if (item === null) {
      out.push({});
      continue;
    }
    if (typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        message: `${typeName}格式错误：json: cannot unmarshal ${goJSONKind(item)} into Go value of type ${MAP_TYPE}`,
      };
    }
    out.push(item as Record<string, unknown>);
  }
  return { ok: true, value: out };
}

function validateURL(urlStr: string, index: number, itemType: string): string | null {
  if (!URL_RE.test(urlStr)) return `第${index}个${itemType}的URL格式不正确`;
  try {
    new URL(urlStr);
  } catch (err) {
    return `第${index}个${itemType}的URL无法解析：${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

function checkDangerousContent(content: string, index: number, itemType: string): string | null {
  const lower = content.toLowerCase();
  for (const d of DANGEROUS_CHARS) {
    if (lower.includes(d)) return `第${index}个${itemType}包含不允许的内容`;
  }
  return null;
}

function isRFC3339(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateApiInfo(apiInfoStr: string): string | null {
  const parsed = parseJSONArray(apiInfoStr, "API信息");
  if (!parsed.ok) return parsed.message;
  if (parsed.value.length > 50) return "API信息数量不能超过50个";
  for (let i = 0; i < parsed.value.length; i++) {
    const apiInfo = parsed.value[i];
    const n = i + 1;
    const urlStr = asString(apiInfo.url);
    if (!urlStr) return `第${n}个API信息缺少URL字段`;
    const route = asString(apiInfo.route);
    if (!route) return `第${n}个API信息缺少线路描述字段`;
    const description = asString(apiInfo.description);
    if (!description) return `第${n}个API信息缺少说明字段`;
    const color = asString(apiInfo.color);
    if (!color) return `第${n}个API信息缺少颜色字段`;
    const urlErr = validateURL(urlStr, n, "API信息");
    if (urlErr) return urlErr;
    if (exceedsMaxCharacters(urlStr, 500)) return `第${n}个API信息的URL长度不能超过500字符`;
    if (exceedsMaxCharacters(route, 100)) return `第${n}个API信息的线路描述长度不能超过100字符`;
    if (exceedsMaxCharacters(description, 200)) return `第${n}个API信息的说明长度不能超过200字符`;
    if (!VALID_COLORS.has(color)) return `第${n}个API信息的颜色值不合法`;
    const descDanger = checkDangerousContent(description, n, "API信息");
    if (descDanger) return descDanger;
    const routeDanger = checkDangerousContent(route, n, "API信息");
    if (routeDanger) return routeDanger;
  }
  return null;
}

function validateAnnouncements(announcementsStr: string): string | null {
  const parsed = parseJSONArray(announcementsStr, "系统公告");
  if (!parsed.ok) return parsed.message;
  if (parsed.value.length > 100) return "系统公告数量不能超过100个";
  for (let i = 0; i < parsed.value.length; i++) {
    const ann = parsed.value[i];
    const n = i + 1;
    const content = asString(ann.content);
    if (!content) return `第${n}个公告缺少内容字段`;
    if (!Object.prototype.hasOwnProperty.call(ann, "publishDate")) return `第${n}个公告缺少发布日期字段`;
    const publishDateStr = asString(ann.publishDate);
    if (!publishDateStr) return `第${n}个公告的发布日期不能为空`;
    if (!isRFC3339(publishDateStr)) return `第${n}个公告的发布日期格式错误`;
    if (Object.prototype.hasOwnProperty.call(ann, "type")) {
      const typeStr = asString(ann.type);
      if (typeStr !== undefined && !VALID_ANNOUNCEMENT_TYPES.has(typeStr)) return `第${n}个公告的类型值不合法`;
    }
    if (exceedsMaxCharacters(content, 500)) return `第${n}个公告的内容长度不能超过500字符`;
    if (Object.prototype.hasOwnProperty.call(ann, "extra")) {
      const extraStr = asString(ann.extra);
      if (extraStr !== undefined && exceedsMaxCharacters(extraStr, 100)) return `第${n}个公告的说明长度不能超过100字符`;
    }
  }
  return null;
}

function validateFAQ(faqStr: string): string | null {
  const parsed = parseJSONArray(faqStr, "FAQ信息");
  if (!parsed.ok) return parsed.message;
  if (parsed.value.length > 100) return "FAQ数量不能超过100个";
  for (let i = 0; i < parsed.value.length; i++) {
    const faq = parsed.value[i];
    const n = i + 1;
    const question = asString(faq.question);
    if (!question) return `第${n}个FAQ缺少问题字段`;
    const answer = asString(faq.answer);
    if (!answer) return `第${n}个FAQ缺少答案字段`;
    if (exceedsMaxCharacters(question, 200)) return `第${n}个FAQ的问题长度不能超过200字符`;
    if (exceedsMaxCharacters(answer, 1000)) return `第${n}个FAQ的答案长度不能超过1000字符`;
  }
  return null;
}

function validateUptimeKumaGroups(groupsStr: string): string | null {
  const parsed = parseJSONArray(groupsStr, "Uptime Kuma分组配置");
  if (!parsed.ok) return parsed.message;
  if (parsed.value.length > 20) return "Uptime Kuma分组数量不能超过20个";
  const nameSet = new Set<string>();
  for (let i = 0; i < parsed.value.length; i++) {
    const group = parsed.value[i];
    const n = i + 1;
    const categoryName = asString(group.categoryName);
    if (!categoryName) return `第${n}个分组缺少分类名称字段`;
    if (nameSet.has(categoryName)) return `第${n}个分组的分类名称与其他分组重复`;
    nameSet.add(categoryName);
    const urlStr = asString(group.url);
    if (!urlStr) return `第${n}个分组缺少URL字段`;
    const slug = asString(group.slug);
    if (!slug) return `第${n}个分组缺少Slug字段`;
    const description = asString(group.description) ?? "";
    const urlErr = validateURL(urlStr, n, "分组");
    if (urlErr) return urlErr;
    if (exceedsMaxCharacters(categoryName, 50)) return `第${n}个分组的分类名称长度不能超过50字符`;
    if (exceedsMaxCharacters(urlStr, 500)) return `第${n}个分组的URL长度不能超过500字符`;
    if (exceedsMaxCharacters(slug, 100)) return `第${n}个分组的Slug长度不能超过100字符`;
    if (exceedsMaxCharacters(description, 200)) return `第${n}个分组的描述长度不能超过200字符`;
    if (!SLUG_RE.test(slug)) return `第${n}个分组的Slug只能包含字母、数字、下划线和连字符`;
    const descDanger = checkDangerousContent(description, n, "分组");
    if (descDanger) return descDanger;
    const nameDanger = checkDangerousContent(categoryName, n, "分组");
    if (nameDanger) return nameDanger;
  }
  return null;
}

/** Original `console_setting.ValidateConsoleSettings`. */
export function validateConsoleSettings(settingsStr: string, settingType: string): string | null {
  if (settingsStr === "") return null;
  switch (settingType) {
    case "ApiInfo":
      return validateApiInfo(settingsStr);
    case "Announcements":
      return validateAnnouncements(settingsStr);
    case "FAQ":
      return validateFAQ(settingsStr);
    case "UptimeKumaGroups":
      return validateUptimeKumaGroups(settingsStr);
    default:
      return `未知的设置类型：${settingType}`;
  }
}

/** Original `console_setting.getJSONList`. Invalid JSON is a nil slice (`null`). */
export function getJSONList(jsonStr: string): Record<string, unknown>[] | null {
  if (jsonStr === "") return [];
  const parsed = goUnmarshalJSON(jsonStr);
  if (!parsed.ok) return null;
  if (parsed.value === null) return null;
  if (!Array.isArray(parsed.value)) return null;
  const out: Record<string, unknown>[] = [];
  for (const item of parsed.value) {
    if (item === null) {
      out.push({});
      continue;
    }
    if (typeof item !== "object" || Array.isArray(item)) return null;
    out.push(item as Record<string, unknown>);
  }
  return out;
}

function publishTimeMs(item: Record<string, unknown>): number {
  const raw = asString(item.publishDate);
  if (!raw || !isRFC3339(raw)) return Number.NEGATIVE_INFINITY;
  return Date.parse(raw);
}

/** Original `console_setting.GetAnnouncements` (newest publishDate first, stable). */
export function getAnnouncements(jsonStr: string): Record<string, unknown>[] | null {
  const list = getJSONList(jsonStr);
  if (!list) return null;
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const dt = publishTimeMs(b.item) - publishTimeMs(a.item);
      return dt !== 0 ? dt : a.index - b.index;
    })
    .map((entry) => entry.item);
}
