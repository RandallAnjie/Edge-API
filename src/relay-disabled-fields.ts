/** Original `relay/common.RemoveDisabledFields` + `hasRemovableDisabledField`. */

export type ChannelDisabledFieldSettings = {
  allow_service_tier?: boolean;
  allow_inference_geo?: boolean;
  allow_speed?: boolean;
  allow_safety_identifier?: boolean;
  disable_store?: boolean;
  allow_include_obfuscation?: boolean;
};

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

/** Original `hasRemovableDisabledField` (gjson Exists on the six controlled paths). */
export function hasRemovableDisabledField(body: unknown, otherSettings: ChannelDisabledFieldSettings | undefined): boolean {
  const obj = asObject(body);
  if (!obj) return false;
  const settings = otherSettings ?? {};
  if (hasOwn(obj, "service_tier") && settings.allow_service_tier !== true) return true;
  if (hasOwn(obj, "inference_geo") && settings.allow_inference_geo !== true) return true;
  if (hasOwn(obj, "speed") && settings.allow_speed !== true) return true;
  if (hasOwn(obj, "store") && settings.disable_store === true) return true;
  if (hasOwn(obj, "safety_identifier") && settings.allow_safety_identifier !== true) return true;
  const streamOptions = asObject(obj.stream_options);
  if (streamOptions && hasOwn(streamOptions, "include_obfuscation") && settings.allow_include_obfuscation !== true) return true;
  return false;
}

/**
 * Original `RemoveDisabledFields`. Skips when global or channel pass-through is on.
 * Returns the same object when no controlled field would be deleted.
 */
export function removeDisabledFields(
  body: unknown,
  otherSettings: ChannelDisabledFieldSettings | undefined,
  channelPassThroughEnabled: boolean,
  globalPassThroughEnabled = false,
): unknown {
  if (globalPassThroughEnabled || channelPassThroughEnabled) return body;
  if (!hasRemovableDisabledField(body, otherSettings)) return body;
  const obj = asObject(body);
  if (!obj) return body;
  const settings = otherSettings ?? {};
  const out: Record<string, unknown> = { ...obj };

  if (settings.allow_service_tier !== true && hasOwn(out, "service_tier")) delete out.service_tier;
  if (settings.allow_inference_geo !== true && hasOwn(out, "inference_geo")) delete out.inference_geo;
  if (settings.allow_speed !== true && hasOwn(out, "speed")) delete out.speed;
  if (settings.disable_store === true && hasOwn(out, "store")) delete out.store;
  if (settings.allow_safety_identifier !== true && hasOwn(out, "safety_identifier")) delete out.safety_identifier;

  if (settings.allow_include_obfuscation !== true) {
    const streamOptions = asObject(out.stream_options);
    if (streamOptions && hasOwn(streamOptions, "include_obfuscation")) {
      const next = { ...streamOptions };
      delete next.include_obfuscation;
      if (Object.keys(next).length === 0) delete out.stream_options;
      else out.stream_options = next;
    }
  }
  return out;
}

/**
 * Original helpers that call RemoveDisabledFields: TextHelper, ClaudeHelper,
 * ResponsesHelper, and via-responses (chat then Responses). GeminiHelper,
 * ImageHelper, EmbeddingHelper, AudioHelper, RerankHelper, and AlphaSearchHelper
 * do not.
 */
export function usesRemoveDisabledFields(client: string, mode: string, viaResponses = false): boolean {
  if (viaResponses) return true;
  if (client === "gemini") return false;
  if (client === "anthropic") return true;
  if (client !== "openai") return false;
  if (
    mode === "images" ||
    mode === "audio_speech" ||
    mode === "audio_transcription" ||
    mode === "audio_translation" ||
    mode === "rerank" ||
    mode === "embeddings" ||
    mode === "engines_embeddings" ||
    mode === "alpha_search" ||
    mode === "video" ||
    mode === "passthrough" ||
    mode === "realtime" ||
    mode === "models" ||
    mode === "gemini"
  ) {
    return false;
  }
  return true;
}
