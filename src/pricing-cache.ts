/** Original `model.modelSupportEndpointTypes` filled by `updatePricing`. */
let modelSupportEndpointTypes: Record<string, string[]> = {};
/** Original `model.modelQuotaTypeMap` filled by `updatePricing`. */
let modelQuotaTypeMap: Record<string, number> = {};

/** Original `model.InvalidatePricingCache` for endpoint-type and quota-type maps. */
export function invalidatePricingCache(): void {
  modelSupportEndpointTypes = {};
  modelQuotaTypeMap = {};
}

/** Original `model.GetModelSupportEndpointTypes`. Empty / missing → `[]`, not channel-type fallback. */
export function getModelSupportEndpointTypes(model: string): string[] {
  if (!model) return [];
  const endpoints = modelSupportEndpointTypes[model];
  return endpoints ? endpoints.slice() : [];
}

/** Original `model.GetModelQuotaTypes`. Missing → `[]`; quota `0` is a present cache hit. */
export function getModelQuotaTypes(modelName: string): number[] {
  if (!Object.prototype.hasOwnProperty.call(modelQuotaTypeMap, modelName)) return [];
  return [modelQuotaTypeMap[modelName]];
}

/** Replace the cache after original `updatePricing` / worker `buildPricing`. */
export function replaceModelSupportEndpointTypes(next: Record<string, string[]>): void {
  modelSupportEndpointTypes = next;
}

export function replaceModelQuotaTypes(next: Record<string, number>): void {
  modelQuotaTypeMap = next;
}
