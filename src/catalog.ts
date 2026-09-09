import type { AdapterKind, ChannelTypeInfo } from "./types.js";

export const CHANNEL_TYPES: ChannelTypeInfo[] = [
  { id: 0, name: "Unknown", kind: "openai", base: "" },
  { id: 1, name: "OpenAI", kind: "openai", base: "https://api.openai.com" },
  { id: 2, name: "Midjourney", kind: "mj", base: "https://oa.api2d.net" },
  { id: 3, name: "Azure", kind: "azure", base: "" },
  { id: 4, name: "Ollama", kind: "ollama", base: "http://localhost:11434" },
  { id: 5, name: "MidjourneyPlus", kind: "mj", base: "https://api.openai-sb.com" },
  { id: 6, name: "OpenAIMax", kind: "openai", base: "https://api.openaimax.com" },
  { id: 7, name: "OhMyGPT", kind: "openai", base: "https://api.ohmygpt.com" },
  { id: 8, name: "Custom", kind: "custom", base: "" },
  { id: 9, name: "AILS", kind: "openai", base: "https://api.caipacity.com" },
  { id: 10, name: "AIProxy", kind: "openai", base: "https://api.aiproxy.io" },
  { id: 11, name: "PaLM", kind: "openai", base: "" },
  { id: 12, name: "API2GPT", kind: "openai", base: "https://api.api2gpt.com" },
  { id: 13, name: "AIGC2D", kind: "openai", base: "https://api.aigc2d.com" },
  { id: 14, name: "Anthropic", kind: "anthropic", base: "https://api.anthropic.com" },
  { id: 15, name: "Baidu", kind: "baidu", base: "https://aip.baidubce.com" },
  { id: 16, name: "Zhipu", kind: "zhipu", base: "https://open.bigmodel.cn" },
  { id: 17, name: "Ali", kind: "ali", base: "https://dashscope.aliyuncs.com" },
  { id: 18, name: "Xunfei", kind: "openai", base: "" },
  { id: 19, name: "360", kind: "openai", base: "https://api.360.cn" },
  { id: 20, name: "OpenRouter", kind: "openai", base: "https://openrouter.ai/api" },
  { id: 21, name: "AIProxyLibrary", kind: "openai", base: "https://api.aiproxy.io" },
  { id: 22, name: "FastGPT", kind: "openai", base: "https://fastgpt.run/api/openapi" },
  { id: 23, name: "Tencent", kind: "openai", base: "https://hunyuan.tencentcloudapi.com" },
  { id: 24, name: "Gemini", kind: "gemini", base: "https://generativelanguage.googleapis.com" },
  { id: 25, name: "Moonshot", kind: "openai", base: "https://api.moonshot.cn" },
  { id: 26, name: "ZhipuV4", kind: "zhipu", base: "https://open.bigmodel.cn" },
  { id: 27, name: "Perplexity", kind: "openai", base: "https://api.perplexity.ai" },
  { id: 31, name: "LingYiWanWu", kind: "openai", base: "https://api.lingyiwanwu.com" },
  { id: 33, name: "AWS", kind: "anthropic", base: "" },
  { id: 34, name: "Cohere", kind: "cohere", base: "https://api.cohere.ai" },
  { id: 35, name: "MiniMax", kind: "openai", base: "https://api.minimax.chat" },
  { id: 36, name: "SunoAPI", kind: "openai", base: "" },
  { id: 37, name: "Dify", kind: "dify", base: "https://api.dify.ai" },
  { id: 38, name: "Jina", kind: "openai", base: "https://api.jina.ai" },
  { id: 39, name: "Cloudflare", kind: "cloudflare", base: "https://api.cloudflare.com" },
  { id: 40, name: "SiliconFlow", kind: "openai", base: "https://api.siliconflow.cn" },
  { id: 41, name: "VertexAI", kind: "gemini", base: "" },
  { id: 42, name: "Mistral", kind: "openai", base: "https://api.mistral.ai" },
  { id: 43, name: "DeepSeek", kind: "openai", base: "https://api.deepseek.com" },
  { id: 44, name: "MokaAI", kind: "openai", base: "https://api.moka.ai" },
  { id: 45, name: "VolcEngine", kind: "volc", base: "https://ark.cn-beijing.volces.com" },
  { id: 46, name: "BaiduV2", kind: "openai", base: "https://qianfan.baidubce.com" },
  { id: 47, name: "Xinference", kind: "openai", base: "" },
  { id: 48, name: "xAI", kind: "openai", base: "https://api.x.ai" },
  { id: 49, name: "Coze", kind: "coze", base: "https://api.coze.cn" },
  { id: 50, name: "Kling", kind: "openai", base: "https://api.klingai.com" },
  { id: 51, name: "Jimeng", kind: "openai", base: "https://visual.volcengineapi.com" },
  { id: 52, name: "Vidu", kind: "openai", base: "https://api.vidu.cn" },
  { id: 53, name: "Submodel", kind: "openai", base: "https://llm.submodel.ai" },
  { id: 54, name: "DoubaoVideo", kind: "volc", base: "https://ark.cn-beijing.volces.com" },
  { id: 55, name: "Sora", kind: "openai", base: "https://api.openai.com" },
  { id: 56, name: "Replicate", kind: "openai", base: "https://api.replicate.com" },
  { id: 57, name: "ChatGPT Subscription (Codex)", kind: "openai", base: "https://chatgpt.com" },
  { id: 58, name: "Advanced Custom", kind: "custom", base: "" },
  { id: 59, name: "Sub2API", kind: "openai", base: "" },
  { id: 60, name: "New API", kind: "openai", base: "" },
  { id: 61, name: "Task Plugin", kind: "openai", base: "" },
];

const BY_ID = new Map(CHANNEL_TYPES.map((c) => [c.id, c]));

export function getChannelType(id: number): ChannelTypeInfo {
  return BY_ID.get(id) ?? { id, name: "Unknown", kind: "openai", base: "" };
}

export function channelTypeName(id: number): string {
  return getChannelType(id).name;
}

export function channelKind(id: number): AdapterKind {
  return getChannelType(id).kind;
}

export function defaultBaseUrl(id: number): string {
  return getChannelType(id).base;
}

export function resolveBaseUrl(type: number, baseUrl: string): string {
  const raw = (baseUrl || defaultBaseUrl(type)).replace(/\/+$/, "");
  return raw;
}
