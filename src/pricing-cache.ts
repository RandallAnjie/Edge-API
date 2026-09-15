/** Original `model.modelSupportEndpointTypes` filled by `updatePricing`. */
let modelSupportEndpointTypes: Record<string, string[]> = {};

/** Original `model.InvalidatePricingCache` for the ListModels endpoint-type map. */
export function invalidatePricingCache(): void {
  modelSupportEndpointTypes = {};
}

/** Original `model.GetModelSupportEndpointTypes`. Empty / missing → `[]`, not channel-type fallback. */
export function getModelSupportEndpointTypes(model: string): string[] {
  if (!model) return [];
  const endpoints = modelSupportEndpointTypes[model];
  return endpoints ? endpoints.slice() : [];
}

/** Replace the cache after original `updatePricing` / worker `buildPricing`. */
export function replaceModelSupportEndpointTypes(next: Record<string, string[]>): void {
  modelSupportEndpointTypes = next;
}
