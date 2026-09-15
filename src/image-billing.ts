/**
 * Original `dto.ImageRequest.ImageCount`, `helper.ResolveImageBillingRequestInput`,
 * and `RelayInfo.UpdateImageCount` (workerd).
 */
import type { BillingRequestInput } from "./billing-expr.js";
import { CHANNEL_TYPE_ALI } from "./constants.js";
import { MAX_IMAGE_N } from "./task-plugin-usage.js";

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Original `dto.ImageRequest.ImageCount`. */
export function imageRequestCount(body: Record<string, unknown>, useProviderParameters: boolean): number {
  let n = 1;
  const top = body.n;
  if (top != null && top !== "" && Number(top) !== 0) n = Math.trunc(Number(top));
  if (!Number.isFinite(n) || n > MAX_IMAGE_N) {
    throw new Error(`n must be an integer between 1 and ${MAX_IMAGE_N}`);
  }
  const parameters = asObj(body.parameters);
  if (Object.prototype.hasOwnProperty.call(parameters, "n") && parameters.n != null) {
    const pn = Number(parameters.n);
    if (!Number.isFinite(pn) || pn > MAX_IMAGE_N || (useProviderParameters && pn === 0)) {
      throw new Error(`parameters.n must be an integer between 1 and ${MAX_IMAGE_N}`);
    }
    if (useProviderParameters) n = Math.trunc(pn);
  }
  return n;
}

/** Original `helper.ResolveImageBillingRequestInput`. */
export function resolveImageBillingRequestInput(
  body: Record<string, unknown>,
  channelType: number,
  input: BillingRequestInput = {},
): BillingRequestInput {
  const count = imageRequestCount(body, channelType === CHANNEL_TYPE_ALI);
  const topLevelCount = imageRequestCount(body, false);
  const frozen: Record<string, unknown> = {
    model: body.model,
    n: topLevelCount,
    size: body.size,
    quality: body.quality,
  };
  if (body.parameters != null) frozen.parameters = body.parameters;
  return { ...input, body: frozen, imageCount: count };
}

/** Original `gjson.GetBytes(responseBody, "data.#")`. */
export function openaiImageDataCount(body: Record<string, unknown>): number {
  return Array.isArray(body.data) ? body.data.length : 0;
}

/** Original `RelayInfo.UpdateImageCount` for tiered_expr snapshots. */
export function updateBillingImageCount(count: number, estimatedImageCount: number | undefined): number | undefined {
  if (count <= 0 || count > MAX_IMAGE_N) return undefined;
  if (estimatedImageCount == null) return undefined;
  return Math.trunc(count);
}
