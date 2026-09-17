/**
 * Original `jsplugin.HasCapability` / capability name constants.
 * Kept out of `jsplugin.ts` so ValidateV1Meta / CompilePlugin can share them
 * without an import cycle.
 */

export const CAPABILITY_JSON_CLONE = "json-clone@1";
export const CAPABILITY_SUBMIT_SSE_DELTA = "submit-sse-delta@1";

export function hasCapability(name: string): boolean {
  return name === CAPABILITY_JSON_CLONE || name === CAPABILITY_SUBMIT_SSE_DELTA;
}
