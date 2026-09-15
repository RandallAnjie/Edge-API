/**
 * Original `relaykit/relayconvert` builtin text request converters on workerd.
 * Must not import store / relay / convert / query / submit / log-info-generate.
 */
const OPENAI = "openai";
const CLAUDE = "claude";
const GEMINI = "gemini";
const RESPONSES = "openai_responses";

/** Original `relayconvert.ConverterClaudeMessagesToOpenAIChat`. */
export const CONVERTER_CLAUDE_MESSAGES_TO_OPENAI_CHAT = "anthropic_messages_to_openai_chat_completions";
/** Original `relayconvert.ConverterOpenAIChatToClaudeMessages`. */
export const CONVERTER_OPENAI_CHAT_TO_CLAUDE_MESSAGES = "openai_chat_completions_to_anthropic_messages";
/** Original `relayconvert.ConverterGeminiContentToOpenAIChat`. */
export const CONVERTER_GEMINI_CONTENT_TO_OPENAI_CHAT = "gemini_generate_content_to_openai_chat_completions";
/** Original `relayconvert.ConverterOpenAIChatToGeminiContent`. */
export const CONVERTER_OPENAI_CHAT_TO_GEMINI_CONTENT = "openai_chat_completions_to_gemini_generate_content";
/** Original `relayconvert.ConverterOpenAIChatToOpenAIResponses`. */
export const CONVERTER_OPENAI_CHAT_TO_OPENAI_RESPONSES = "openai_chat_completions_to_openai_responses";
/** Original `relayconvert.ConverterOpenAIResponsesToOpenAIChat`. */
export const CONVERTER_OPENAI_RESPONSES_TO_OPENAI_CHAT = "openai_responses_to_openai_chat_completions";
/** Original `relayconvert.ConverterOpenAIResponsesToClaudeMessages`. */
export const CONVERTER_OPENAI_RESPONSES_TO_CLAUDE_MESSAGES = "openai_responses_to_claude_messages";
/** Original `relayconvert.ConverterOpenAIResponsesToGemini`. */
export const CONVERTER_OPENAI_RESPONSES_TO_GEMINI = "openai_responses_to_gemini_generate_content";
/** Original `requestConverterClaudeToGemini`. */
export const CONVERTER_CLAUDE_TO_GEMINI = "claude_messages_to_gemini_generate_content";
/** Original `requestConverterClaudeToResponses`. */
export const CONVERTER_CLAUDE_TO_RESPONSES = "claude_messages_to_openai_responses";
/** Original `requestConverterGeminiToClaude`. */
export const CONVERTER_GEMINI_TO_CLAUDE = "gemini_generate_content_to_claude_messages";
/** Original `requestConverterGeminiToResponses`. */
export const CONVERTER_GEMINI_TO_RESPONSES = "gemini_generate_content_to_openai_responses";

type RequestConverterSpec = {
  id: string;
  from: string;
  to: string;
  /** Original `Req.StepConverters`; empty means a direct Convert. */
  stepIds: string[];
};

const REQUEST_CONVERTERS: RequestConverterSpec[] = [
  { id: CONVERTER_CLAUDE_MESSAGES_TO_OPENAI_CHAT, from: CLAUDE, to: OPENAI, stepIds: [] },
  { id: CONVERTER_OPENAI_CHAT_TO_CLAUDE_MESSAGES, from: OPENAI, to: CLAUDE, stepIds: [] },
  { id: CONVERTER_GEMINI_CONTENT_TO_OPENAI_CHAT, from: GEMINI, to: OPENAI, stepIds: [] },
  { id: CONVERTER_OPENAI_CHAT_TO_GEMINI_CONTENT, from: OPENAI, to: GEMINI, stepIds: [] },
  { id: CONVERTER_OPENAI_CHAT_TO_OPENAI_RESPONSES, from: OPENAI, to: RESPONSES, stepIds: [] },
  { id: CONVERTER_OPENAI_RESPONSES_TO_OPENAI_CHAT, from: RESPONSES, to: OPENAI, stepIds: [] },
  {
    id: CONVERTER_CLAUDE_TO_GEMINI,
    from: CLAUDE,
    to: GEMINI,
    stepIds: [CONVERTER_CLAUDE_MESSAGES_TO_OPENAI_CHAT, CONVERTER_OPENAI_CHAT_TO_GEMINI_CONTENT],
  },
  { id: CONVERTER_CLAUDE_TO_RESPONSES, from: CLAUDE, to: RESPONSES, stepIds: [] },
  {
    id: CONVERTER_GEMINI_TO_CLAUDE,
    from: GEMINI,
    to: CLAUDE,
    stepIds: [CONVERTER_GEMINI_CONTENT_TO_OPENAI_CHAT, CONVERTER_OPENAI_CHAT_TO_CLAUDE_MESSAGES],
  },
  {
    id: CONVERTER_GEMINI_TO_RESPONSES,
    from: GEMINI,
    to: RESPONSES,
    stepIds: [CONVERTER_GEMINI_CONTENT_TO_OPENAI_CHAT, CONVERTER_OPENAI_CHAT_TO_OPENAI_RESPONSES],
  },
  { id: CONVERTER_OPENAI_RESPONSES_TO_CLAUDE_MESSAGES, from: RESPONSES, to: CLAUDE, stepIds: [] },
  { id: CONVERTER_OPENAI_RESPONSES_TO_GEMINI, from: RESPONSES, to: GEMINI, stepIds: [] },
];

const byId = new Map(REQUEST_CONVERTERS.map((spec) => [spec.id, spec]));
const byRoute = new Map(REQUEST_CONVERTERS.map((spec) => [`${spec.from}\0${spec.to}`, spec]));

export function lookupRequestConverter(from: string, to: string): RequestConverterSpec | null {
  return byRoute.get(`${from}\0${to}`) || null;
}

/**
 * Original `expandRequestConverterSteps` then each `RequestStep.To`.
 * Identity (from == to) yields no hops so InitRequestConversionChain stays as-is.
 */
export function expandRequestConversionTos(from: string, to: string): string[] {
  if (!from || !to || from === to) return [];
  const spec = lookupRequestConverter(from, to);
  if (!spec) return [to];
  if (!spec.stepIds.length) return [spec.to];
  const tos: string[] = [];
  for (const id of spec.stepIds) {
    const step = byId.get(id);
    if (!step) return [to];
    tos.push(step.to);
  }
  return tos;
}
