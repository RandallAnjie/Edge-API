/** Original `service/openai_chat_responses_mode.go` + `model_setting.ChatCompletionsToResponsesPolicy`. */

export type ChatCompletionsToResponsesPolicy = {
  enabled?: boolean;
  all_channels?: boolean;
  channel_ids?: number[];
  channel_types?: number[];
  model_patterns?: string[];
};

const regexCache = new Map<string, RegExp>();

function matchAnyModelPattern(patterns: string[] | undefined, model: string): boolean {
  if (!patterns || !patterns.length || !model) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    let re = regexCache.get(pattern);
    if (!re) {
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      regexCache.set(pattern, re);
    }
    if (re.test(model)) return true;
  }
  return false;
}

/** Original `ChatCompletionsToResponsesPolicy.IsChannelEnabled`. */
export function chatCompletionsToResponsesChannelEnabled(
  policy: ChatCompletionsToResponsesPolicy,
  channelID: number,
  channelType: number,
): boolean {
  if (!policy.enabled) return false;
  if (policy.all_channels) return true;
  if (channelID > 0 && Array.isArray(policy.channel_ids) && policy.channel_ids.includes(channelID)) return true;
  if (channelType > 0 && Array.isArray(policy.channel_types) && policy.channel_types.includes(channelType)) return true;
  return false;
}

/** Original `ShouldChatCompletionsUseResponsesPolicy`. */
export function shouldChatCompletionsUseResponsesPolicy(
  policy: ChatCompletionsToResponsesPolicy,
  channelID: number,
  channelType: number,
  model: string,
): boolean {
  if (!chatCompletionsToResponsesChannelEnabled(policy, channelID, channelType)) return false;
  return matchAnyModelPattern(policy.model_patterns, model);
}

function isToolLoadingMessage(msg: Record<string, unknown>): boolean {
  const tools = msg.tools;
  if (tools == null) return false;
  if (Array.isArray(tools)) return tools.length > 0;
  if (typeof tools === "string") return tools.trim().length > 0;
  return true;
}

/**
 * Original `applySystemPromptIfNeeded` for ChatCompletions via-responses and
 * TextHelper after ConvertOpenAIRequest. `systemRole` is `GetSystemRoleName`.
 */
export function applyChatChannelSystemPrompt(
  body: Record<string, unknown>,
  systemPrompt: string | undefined,
  override: boolean | undefined,
  systemRole = "system",
): Record<string, unknown> {
  if (!systemPrompt) return body;
  const messages = Array.isArray(body.messages) ? [...(body.messages as Record<string, unknown>[])] : [];
  const hasRealSystem = messages.some((msg) => String(msg.role || "") === systemRole && !isToolLoadingMessage(msg));
  if (!hasRealSystem) {
    return { ...body, messages: [{ role: systemRole, content: systemPrompt }, ...messages] };
  }
  if (!override) return body;
  const next = messages.map((msg) => ({ ...msg }));
  for (let i = 0; i < next.length; i++) {
    const msg = next[i];
    if (String(msg.role || "") !== systemRole || isToolLoadingMessage(msg)) continue;
    if (typeof msg.content === "string") {
      next[i] = { ...msg, content: `${systemPrompt}\n${msg.content}` };
    } else {
      const contents = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
      next[i] = { ...msg, content: [{ type: "text", text: systemPrompt }, ...contents] };
    }
    break;
  }
  return { ...body, messages: next };
}
