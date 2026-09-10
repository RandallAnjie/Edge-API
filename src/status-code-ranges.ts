/** Original `setting/operation_setting/status_code_ranges.go`. */

export type StatusCodeRange = { start: number; end: number };

/** Original `AutomaticDisableStatusCodeRanges`. */
export const DEFAULT_DISABLE_STATUS_CODE_RANGES: StatusCodeRange[] = [{ start: 401, end: 401 }];

/** Original `AutomaticRetryStatusCodeRanges` (legacy shouldRetry). */
export const DEFAULT_RETRY_STATUS_CODE_RANGES: StatusCodeRange[] = [
  { start: 100, end: 199 },
  { start: 300, end: 399 },
  { start: 401, end: 407 },
  { start: 409, end: 499 },
  { start: 500, end: 503 },
  { start: 505, end: 523 },
  { start: 525, end: 599 },
];

const ALWAYS_SKIP_RETRY_STATUS_CODES = new Set([504, 524]);

/** Original `operation_setting.AutomaticRetryStatusCodesToString`. */
export function statusCodeRangesToString(ranges: StatusCodeRange[]): string {
  if (!ranges.length) return "";
  return ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join(",");
}

export function shouldMatchStatusCodeRanges(ranges: StatusCodeRange[], code: number): boolean {
  if (code < 100 || code > 599) return false;
  for (const r of ranges) {
    if (code < r.start) return false;
    if (code <= r.end) return true;
  }
  return false;
}

/** Original `operation_setting.IsAlwaysSkipRetryStatusCode`. */
export function isAlwaysSkipRetryStatusCode(code: number): boolean {
  return ALWAYS_SKIP_RETRY_STATUS_CODES.has(code);
}

/** Original `operation_setting.ShouldRetryByStatusCode`. */
export function shouldRetryByStatusCode(code: number, ranges: StatusCodeRange[] = DEFAULT_RETRY_STATUS_CODE_RANGES): boolean {
  if (isAlwaysSkipRetryStatusCode(code)) return false;
  return shouldMatchStatusCodeRanges(ranges, code);
}

/** Original `operation_setting.ShouldDisableByStatusCode`. */
export function shouldDisableByStatusCode(
  code: number,
  ranges: StatusCodeRange[] = DEFAULT_DISABLE_STATUS_CODE_RANGES,
): boolean {
  return shouldMatchStatusCodeRanges(ranges, code);
}

/** Original `operation_setting.ParseHTTPStatusCodeRanges`. Empty input → empty ranges, not an error. */
export function parseHTTPStatusCodeRanges(input: string): { ok: true; ranges: StatusCodeRange[] } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, ranges: [] };
  const normalized = trimmed.replace(/，/g, ",");
  const segments = normalized.split(",");
  const ranges: StatusCodeRange[] = [];
  const invalid: string[] = [];
  for (const seg of segments) {
    const token = seg.trim();
    if (!token) continue;
    const parsed = parseHTTPStatusCodeToken(token);
    if (!parsed.ok) {
      invalid.push(token);
      continue;
    }
    ranges.push(parsed.range);
  }
  if (invalid.length) return { ok: false, message: `invalid http status code rules: ${invalid.join(", ")}` };
  if (!ranges.length) return { ok: true, ranges: [] };
  ranges.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const merged: StatusCodeRange[] = [{ ...ranges[0] }];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.start <= last.end + 1) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    merged.push({ ...r });
  }
  return { ok: true, ranges: merged };
}

function parseHTTPStatusCodeToken(token: string): { ok: true; range: StatusCodeRange } | { ok: false } {
  const compact = token.trim().replace(/ /g, "");
  if (!compact) return { ok: false };
  if (compact.includes("-")) {
    const parts = compact.split("-");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false };
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false };
    if (start > end) return { ok: false };
    if (start < 100 || end > 599) return { ok: false };
    return { ok: true, range: { start, end } };
  }
  const code = Number(compact);
  if (!Number.isInteger(code)) return { ok: false };
  if (code < 100 || code > 599) return { ok: false };
  return { ok: true, range: { start: code, end: code } };
}

/** Resolve configured retry ranges: missing/invalid → original defaults; explicit empty → no ranges. */
export function retryStatusCodeRangesFromOption(raw: string): StatusCodeRange[] {
  const parsed = parseHTTPStatusCodeRanges(raw);
  if (!parsed.ok) return DEFAULT_RETRY_STATUS_CODE_RANGES;
  if (!raw.trim()) return DEFAULT_RETRY_STATUS_CODE_RANGES;
  return parsed.ranges;
}
