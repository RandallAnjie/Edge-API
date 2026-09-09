/** Original adaptor ModelList / ChannelName from QuantumNous/new-api. */
export const OPENAI_MODEL_CREATED = 1626777600;

export const CHANNEL_TYPE_MODELS: Record<number, string[]> = {
  "1": [
    "gpt-6-astra",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-1106-preview",
    "gpt-4-0125-preview",
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-turbo-preview",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-vision-preview",
    "chatgpt-4o-latest",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "gpt-4o-search-preview",
    "gpt-4o-search-preview-2025-03-11",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-transcribe-2025-03-20",
    "gpt-4o-mini-transcribe-2025-12-15",
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-03-20",
    "gpt-4o-mini-tts-2025-12-15",
    "gpt-4o-mini-search-preview",
    "gpt-4o-mini-search-preview-2025-03-11",
    "gpt-4.5-preview",
    "gpt-4.5-preview-2025-02-27",
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano",
    "gpt-4.1-nano-2025-04-14",
    "o1",
    "o1-2024-12-17",
    "o1-preview",
    "o1-preview-2024-09-12",
    "o1-mini",
    "o1-mini-2024-09-12",
    "o1-pro",
    "o1-pro-2025-03-19",
    "o3-mini",
    "o3-mini-2025-01-31",
    "o3-mini-high",
    "o3-mini-2025-01-31-high",
    "o3-mini-low",
    "o3-mini-2025-01-31-low",
    "o3-mini-medium",
    "o3-mini-2025-01-31-medium",
    "o3",
    "o3-2025-04-16",
    "o3-pro",
    "o3-pro-2025-06-10",
    "o3-deep-research",
    "o3-deep-research-2025-06-26",
    "o4-mini",
    "o4-mini-2025-04-16",
    "o4-mini-deep-research",
    "o4-mini-deep-research-2025-06-26",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-chat-latest",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "gpt-5-codex",
    "gpt-5-pro",
    "gpt-5-pro-2025-10-06",
    "gpt-5-search-api",
    "gpt-5-search-api-2025-10-14",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.2-pro-2025-12-11",
    "gpt-5.2-codex",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-pro",
    "gpt-5.4-pro-2026-03-05",
    "gpt-4o-audio-preview",
    "gpt-4o-audio-preview-2024-10-01",
    "gpt-4o-audio-preview-2024-12-17",
    "gpt-4o-audio-preview-2025-06-03",
    "gpt-4o-realtime-preview",
    "gpt-4o-realtime-preview-2024-10-01",
    "gpt-4o-realtime-preview-2024-12-17",
    "gpt-4o-realtime-preview-2025-06-03",
    "gpt-4o-mini-realtime-preview",
    "gpt-4o-mini-realtime-preview-2024-12-17",
    "gpt-4o-mini-audio-preview",
    "gpt-4o-mini-audio-preview-2024-12-17",
    "gpt-audio",
    "gpt-audio-2025-08-28",
    "gpt-audio-mini",
    "gpt-audio-mini-2025-10-06",
    "gpt-audio-mini-2025-12-15",
    "gpt-audio-1.5",
    "gpt-realtime",
    "gpt-realtime-2025-08-28",
    "gpt-realtime-mini",
    "gpt-realtime-mini-2025-10-06",
    "gpt-realtime-mini-2025-12-15",
    "gpt-realtime-1.5",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-whisper",
    "gpt-realtime-translate",
    "text-embedding-ada-002",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "text-moderation-latest",
    "text-moderation-stable",
    "omni-moderation-latest",
    "omni-moderation-2024-09-26",
    "text-davinci-edit-001",
    "davinci-002",
    "babbage-002",
    "dall-e-2",
    "dall-e-3",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-1.5",
    "chatgpt-image-latest",
    "whisper-1",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "computer-use-preview",
    "computer-use-preview-2025-03-11",
    "sora-2",
    "sora-2-pro"
  ],
  "4": [
    "llama3-7b"
  ],
  "11": [
    "PaLM-2"
  ],
  "14": [
    "claude-3-sonnet-20240229",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
    "claude-3-5-haiku-20241022",
    "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-3-7-sonnet-20250219-thinking",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514-thinking",
    "claude-opus-4-20250514",
    "claude-opus-4-20250514-thinking",
    "claude-opus-4-1-20250805",
    "claude-opus-4-1-20250805-thinking",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5-20250929-thinking",
    "claude-opus-4-5-20251101",
    "claude-opus-4-5-20251101-thinking",
    "claude-opus-4-6",
    "claude-opus-4-6-max",
    "claude-opus-4-6-high",
    "claude-opus-4-6-medium",
    "claude-opus-4-6-low",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-opus-4-7-max",
    "claude-opus-4-7-xhigh",
    "claude-opus-4-7-high",
    "claude-opus-4-7-medium",
    "claude-opus-4-7-low",
    "claude-opus-4-7-thinking",
    "claude-opus-4-8",
    "claude-opus-4-8-max",
    "claude-opus-4-8-xhigh",
    "claude-opus-4-8-high",
    "claude-opus-4-8-medium",
    "claude-opus-4-8-low",
    "claude-opus-4-8-thinking"
  ],
  "15": [
    "ERNIE-4.0-8K",
    "ERNIE-3.5-8K",
    "ERNIE-3.5-8K-0205",
    "ERNIE-3.5-8K-1222",
    "ERNIE-Bot-8K",
    "ERNIE-3.5-4K-0205",
    "ERNIE-Speed-8K",
    "ERNIE-Speed-128K",
    "ERNIE-Lite-8K-0922",
    "ERNIE-Lite-8K-0308",
    "ERNIE-Tiny-8K",
    "BLOOMZ-7B",
    "Embedding-V1",
    "bge-large-zh",
    "bge-large-en",
    "tao-8k"
  ],
  "16": [
    "chatglm_turbo",
    "chatglm_pro",
    "chatglm_std",
    "chatglm_lite"
  ],
  "17": [
    "qwen-turbo",
    "qwen-plus",
    "qwen-max",
    "qwen-max-longcontext",
    "qwq-32b",
    "qwen3-235b-a22b",
    "text-embedding-v1",
    "gte-rerank-v2"
  ],
  "18": [
    "SparkDesk",
    "SparkDesk-v1.1",
    "SparkDesk-v2.1",
    "SparkDesk-v3.1",
    "SparkDesk-v3.5",
    "SparkDesk-v4.0"
  ],
  "20": [
    "gpt-6-astra",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-1106-preview",
    "gpt-4-0125-preview",
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-turbo-preview",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-vision-preview",
    "chatgpt-4o-latest",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "gpt-4o-search-preview",
    "gpt-4o-search-preview-2025-03-11",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-transcribe-2025-03-20",
    "gpt-4o-mini-transcribe-2025-12-15",
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-03-20",
    "gpt-4o-mini-tts-2025-12-15",
    "gpt-4o-mini-search-preview",
    "gpt-4o-mini-search-preview-2025-03-11",
    "gpt-4.5-preview",
    "gpt-4.5-preview-2025-02-27",
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano",
    "gpt-4.1-nano-2025-04-14",
    "o1",
    "o1-2024-12-17",
    "o1-preview",
    "o1-preview-2024-09-12",
    "o1-mini",
    "o1-mini-2024-09-12",
    "o1-pro",
    "o1-pro-2025-03-19",
    "o3-mini",
    "o3-mini-2025-01-31",
    "o3-mini-high",
    "o3-mini-2025-01-31-high",
    "o3-mini-low",
    "o3-mini-2025-01-31-low",
    "o3-mini-medium",
    "o3-mini-2025-01-31-medium",
    "o3",
    "o3-2025-04-16",
    "o3-pro",
    "o3-pro-2025-06-10",
    "o3-deep-research",
    "o3-deep-research-2025-06-26",
    "o4-mini",
    "o4-mini-2025-04-16",
    "o4-mini-deep-research",
    "o4-mini-deep-research-2025-06-26",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-chat-latest",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "gpt-5-codex",
    "gpt-5-pro",
    "gpt-5-pro-2025-10-06",
    "gpt-5-search-api",
    "gpt-5-search-api-2025-10-14",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.2-pro-2025-12-11",
    "gpt-5.2-codex",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-pro",
    "gpt-5.4-pro-2026-03-05",
    "gpt-4o-audio-preview",
    "gpt-4o-audio-preview-2024-10-01",
    "gpt-4o-audio-preview-2024-12-17",
    "gpt-4o-audio-preview-2025-06-03",
    "gpt-4o-realtime-preview",
    "gpt-4o-realtime-preview-2024-10-01",
    "gpt-4o-realtime-preview-2024-12-17",
    "gpt-4o-realtime-preview-2025-06-03",
    "gpt-4o-mini-realtime-preview",
    "gpt-4o-mini-realtime-preview-2024-12-17",
    "gpt-4o-mini-audio-preview",
    "gpt-4o-mini-audio-preview-2024-12-17",
    "gpt-audio",
    "gpt-audio-2025-08-28",
    "gpt-audio-mini",
    "gpt-audio-mini-2025-10-06",
    "gpt-audio-mini-2025-12-15",
    "gpt-audio-1.5",
    "gpt-realtime",
    "gpt-realtime-2025-08-28",
    "gpt-realtime-mini",
    "gpt-realtime-mini-2025-10-06",
    "gpt-realtime-mini-2025-12-15",
    "gpt-realtime-1.5",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-whisper",
    "gpt-realtime-translate",
    "text-embedding-ada-002",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "text-moderation-latest",
    "text-moderation-stable",
    "omni-moderation-latest",
    "omni-moderation-2024-09-26",
    "text-davinci-edit-001",
    "davinci-002",
    "babbage-002",
    "dall-e-2",
    "dall-e-3",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-1.5",
    "chatgpt-image-latest",
    "whisper-1",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "computer-use-preview",
    "computer-use-preview-2025-03-11",
    "sora-2",
    "sora-2-pro"
  ],
  "23": [
    "hunyuan-lite",
    "hunyuan-standard",
    "hunyuan-standard-256K",
    "hunyuan-pro"
  ],
  "24": [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite-001",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-3-pro-image",
    "gemini-3.1-flash-image",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemini-2.5-flash-native-audio-latest",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-pro-image-preview",
    "nano-banana-pro-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-robotics-er-1.5-preview",
    "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-pro-preview-12-2025",
    "gemini-2.5-flash-native-audio-preview-09-2025",
    "gemini-2.5-flash-native-audio-preview-12-2025",
    "gemma-3-1b-it",
    "gemma-3-4b-it",
    "gemma-3-12b-it",
    "gemma-3-27b-it",
    "gemma-3n-e4b-it",
    "gemma-3n-e2b-it",
    "gemini-embedding-001",
    "gemini-embedding-2-preview",
    "imagen-4.0-generate-001",
    "imagen-4.0-ultra-generate-001",
    "imagen-4.0-fast-generate-001",
    "veo-2.0-generate-001",
    "veo-3.0-generate-001",
    "veo-3.0-fast-generate-001",
    "veo-3.1-generate-preview",
    "veo-3.1-fast-generate-preview",
    "aqa"
  ],
  "25": [
    "kimi-k3",
    "kimi-k2.5",
    "kimi-k2-0905-preview",
    "kimi-k2-turbo-preview",
    "kimi-k2-thinking",
    "kimi-k2-thinking-turbo"
  ],
  "26": [
    "glm-4",
    "glm-4v",
    "glm-3-turbo",
    "glm-4-alltools",
    "glm-4-plus",
    "glm-4-0520",
    "glm-4-air",
    "glm-4-airx",
    "glm-4-long",
    "glm-4-flash",
    "glm-4v-plus",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-5"
  ],
  "27": [
    "llama-3-sonar-small-32k-chat",
    "llama-3-sonar-small-32k-online",
    "llama-3-sonar-large-32k-chat",
    "llama-3-sonar-large-32k-online",
    "llama-3-8b-instruct",
    "llama-3-70b-instruct",
    "mixtral-8x7b-instruct",
    "sonar",
    "sonar-pro",
    "sonar-reasoning"
  ],
  "33": [
    "claude-3-sonnet-20240229",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "nova-micro-v1:0",
    "nova-lite-v1:0",
    "nova-pro-v1:0",
    "nova-premier-v1:0",
    "nova-canvas-v1:0",
    "nova-reel-v1:0",
    "nova-reel-v1:1",
    "nova-sonic-v1:0",
    "us",
    "eu",
    "ap"
  ],
  "34": [
    "command-a-03-2025",
    "command-r",
    "command-r-plus",
    "command-r-08-2024",
    "command-r-plus-08-2024",
    "c4ai-aya-23-35b",
    "c4ai-aya-23-8b",
    "command-light",
    "command-light-nightly",
    "command",
    "command-nightly",
    "rerank-english-v3.0",
    "rerank-multilingual-v3.0",
    "rerank-english-v2.0",
    "rerank-multilingual-v2.0"
  ],
  "35": [
    "abab6.5-chat",
    "abab6.5s-chat",
    "abab6-chat",
    "abab5.5-chat",
    "abab5.5s-chat",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "speech-2.5-hd-preview",
    "speech-2.5-turbo-preview",
    "speech-02-hd",
    "speech-02-turbo",
    "speech-01-hd",
    "speech-01-turbo",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "image-01",
    "image-01-live"
  ],
  "37": [],
  "38": [
    "jina-clip-v1",
    "jina-reranker-v2-base-multilingual",
    "jina-reranker-m0"
  ],
  "39": [
    "@cf/meta/llama-3.1-8b-instruct",
    "@cf/meta/llama-2-7b-chat-fp16",
    "@cf/meta/llama-2-7b-chat-int8",
    "@cf/mistral/mistral-7b-instruct-v0.1",
    "@hf/thebloke/deepseek-coder-6.7b-base-awq",
    "@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
    "@cf/deepseek-ai/deepseek-math-7b-base",
    "@cf/deepseek-ai/deepseek-math-7b-instruct",
    "@cf/thebloke/discolm-german-7b-v1-awq",
    "@cf/tiiuae/falcon-7b-instruct",
    "@cf/google/gemma-2b-it-lora",
    "@hf/google/gemma-7b-it",
    "@cf/google/gemma-7b-it-lora",
    "@hf/nousresearch/hermes-2-pro-mistral-7b",
    "@hf/thebloke/llama-2-13b-chat-awq",
    "@cf/meta-llama/llama-2-7b-chat-hf-lora",
    "@cf/meta/llama-3-8b-instruct",
    "@hf/thebloke/llamaguard-7b-awq",
    "@hf/thebloke/mistral-7b-instruct-v0.1-awq",
    "@hf/mistralai/mistral-7b-instruct-v0.2",
    "@cf/mistral/mistral-7b-instruct-v0.2-lora",
    "@hf/thebloke/neural-chat-7b-v3-1-awq",
    "@cf/openchat/openchat-3.5-0106",
    "@hf/thebloke/openhermes-2.5-mistral-7b-awq",
    "@cf/microsoft/phi-2",
    "@cf/qwen/qwen1.5-0.5b-chat",
    "@cf/qwen/qwen1.5-1.8b-chat",
    "@cf/qwen/qwen1.5-14b-chat-awq",
    "@cf/qwen/qwen1.5-7b-chat-awq",
    "@cf/defog/sqlcoder-7b-2",
    "@hf/nexusflow/starling-lm-7b-beta",
    "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
    "@hf/thebloke/zephyr-7b-beta-awq"
  ],
  "40": [
    "THUDM/glm-4-9b-chat",
    "stabilityai/stable-diffusion-xl-base-1.0",
    "TencentARC/PhotoMaker",
    "InstantX/InstantID",
    "stabilityai/stable-diffusion-2-1",
    "stabilityai/sd-turbo",
    "stabilityai/sdxl-turbo",
    "ByteDance/SDXL-Lightning",
    "deepseek-ai/deepseek-llm-67b-chat",
    "Qwen/Qwen1.5-14B-Chat",
    "Qwen/Qwen1.5-7B-Chat",
    "Qwen/Qwen1.5-110B-Chat",
    "Qwen/Qwen1.5-32B-Chat",
    "01-ai/Yi-1.5-6B-Chat",
    "01-ai/Yi-1.5-9B-Chat-16K",
    "01-ai/Yi-1.5-34B-Chat-16K",
    "THUDM/chatglm3-6b",
    "deepseek-ai/DeepSeek-V2-Chat",
    "Qwen/Qwen2-72B-Instruct",
    "Qwen/Qwen2-7B-Instruct",
    "Qwen/Qwen2-57B-A14B-Instruct",
    "stabilityai/stable-diffusion-3-medium",
    "deepseek-ai/DeepSeek-Coder-V2-Instruct",
    "Qwen/Qwen2-1.5B-Instruct",
    "internlm/internlm2_5-7b-chat",
    "BAAI/bge-large-en-v1.5",
    "BAAI/bge-large-zh-v1.5",
    "Pro/Qwen/Qwen2-7B-Instruct",
    "Pro/Qwen/Qwen2-1.5B-Instruct",
    "Pro/Qwen/Qwen1.5-7B-Chat",
    "Pro/THUDM/glm-4-9b-chat",
    "Pro/THUDM/chatglm3-6b",
    "Pro/01-ai/Yi-1.5-9B-Chat-16K",
    "Pro/01-ai/Yi-1.5-6B-Chat",
    "Pro/google/gemma-2-9b-it",
    "Pro/internlm/internlm2_5-7b-chat",
    "Pro/meta-llama/Meta-Llama-3-8B-Instruct",
    "Pro/mistralai/Mistral-7B-Instruct-v0.2",
    "black-forest-labs/FLUX.1-schnell",
    "FunAudioLLM/SenseVoiceSmall",
    "netease-youdao/bce-embedding-base_v1",
    "BAAI/bge-m3",
    "internlm/internlm2_5-20b-chat",
    "Qwen/Qwen2-Math-72B-Instruct",
    "netease-youdao/bce-reranker-base_v1",
    "BAAI/bge-reranker-v2-m3"
  ],
  "41": [
    "claude-3-sonnet-20240229",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20240620",
    "gemini-1.5-pro-latest",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-001",
    "gemini-1.5-flash-001",
    "gemini-pro",
    "gemini-pro-vision",
    "meta/llama3-405b-instruct-maas"
  ],
  "42": [
    "open-mistral-7b",
    "open-mixtral-8x7b",
    "mistral-small-latest",
    "mistral-medium-latest",
    "mistral-large-latest",
    "mistral-embed"
  ],
  "43": [
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-flash",
    "deepseek-v4-flash-none",
    "deepseek-v4-flash-max",
    "deepseek-v4-pro",
    "deepseek-v4-pro-none",
    "deepseek-v4-pro-max"
  ],
  "44": [
    "m3e-large",
    "m3e-base",
    "m3e-small"
  ],
  "45": [
    "Doubao-pro-128k",
    "Doubao-pro-32k",
    "Doubao-pro-4k",
    "Doubao-lite-128k",
    "Doubao-lite-32k",
    "Doubao-lite-4k",
    "Doubao-embedding",
    "doubao-seedream-4-0-250828",
    "seedream-4-0-250828",
    "doubao-seedance-1-0-pro-250528",
    "seedance-1-0-pro-250528",
    "doubao-seed-1-6-thinking-250715",
    "seed-1-6-thinking-250715"
  ],
  "46": [
    "ernie-4.0-8k-latest",
    "ernie-4.0-8k-preview",
    "ernie-4.0-8k",
    "ernie-4.0-turbo-8k-latest",
    "ernie-4.0-turbo-8k-preview",
    "ernie-4.0-turbo-8k",
    "ernie-4.0-turbo-128k",
    "ernie-3.5-8k-preview",
    "ernie-3.5-8k",
    "ernie-3.5-128k",
    "ernie-speed-8k",
    "ernie-speed-128k",
    "ernie-speed-pro-128k",
    "ernie-lite-8k",
    "ernie-lite-pro-128k",
    "ernie-tiny-8k",
    "ernie-char-8k",
    "ernie-char-fiction-8k",
    "ernie-novel-8k",
    "deepseek-v3",
    "deepseek-r1",
    "deepseek-r1-distill-qwen-32b",
    "deepseek-r1-distill-qwen-14b"
  ],
  "47": [
    "gpt-6-astra",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-1106-preview",
    "gpt-4-0125-preview",
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-turbo-preview",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-vision-preview",
    "chatgpt-4o-latest",
    "gpt-4o",
    "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-11-20",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "gpt-4o-search-preview",
    "gpt-4o-search-preview-2025-03-11",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-transcribe-2025-03-20",
    "gpt-4o-mini-transcribe-2025-12-15",
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-03-20",
    "gpt-4o-mini-tts-2025-12-15",
    "gpt-4o-mini-search-preview",
    "gpt-4o-mini-search-preview-2025-03-11",
    "gpt-4.5-preview",
    "gpt-4.5-preview-2025-02-27",
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano",
    "gpt-4.1-nano-2025-04-14",
    "o1",
    "o1-2024-12-17",
    "o1-preview",
    "o1-preview-2024-09-12",
    "o1-mini",
    "o1-mini-2024-09-12",
    "o1-pro",
    "o1-pro-2025-03-19",
    "o3-mini",
    "o3-mini-2025-01-31",
    "o3-mini-high",
    "o3-mini-2025-01-31-high",
    "o3-mini-low",
    "o3-mini-2025-01-31-low",
    "o3-mini-medium",
    "o3-mini-2025-01-31-medium",
    "o3",
    "o3-2025-04-16",
    "o3-pro",
    "o3-pro-2025-06-10",
    "o3-deep-research",
    "o3-deep-research-2025-06-26",
    "o4-mini",
    "o4-mini-2025-04-16",
    "o4-mini-deep-research",
    "o4-mini-deep-research-2025-06-26",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-chat-latest",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "gpt-5-codex",
    "gpt-5-pro",
    "gpt-5-pro-2025-10-06",
    "gpt-5-search-api",
    "gpt-5-search-api-2025-10-14",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.2-pro-2025-12-11",
    "gpt-5.2-codex",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-pro",
    "gpt-5.4-pro-2026-03-05",
    "gpt-4o-audio-preview",
    "gpt-4o-audio-preview-2024-10-01",
    "gpt-4o-audio-preview-2024-12-17",
    "gpt-4o-audio-preview-2025-06-03",
    "gpt-4o-realtime-preview",
    "gpt-4o-realtime-preview-2024-10-01",
    "gpt-4o-realtime-preview-2024-12-17",
    "gpt-4o-realtime-preview-2025-06-03",
    "gpt-4o-mini-realtime-preview",
    "gpt-4o-mini-realtime-preview-2024-12-17",
    "gpt-4o-mini-audio-preview",
    "gpt-4o-mini-audio-preview-2024-12-17",
    "gpt-audio",
    "gpt-audio-2025-08-28",
    "gpt-audio-mini",
    "gpt-audio-mini-2025-10-06",
    "gpt-audio-mini-2025-12-15",
    "gpt-audio-1.5",
    "gpt-realtime",
    "gpt-realtime-2025-08-28",
    "gpt-realtime-mini",
    "gpt-realtime-mini-2025-10-06",
    "gpt-realtime-mini-2025-12-15",
    "gpt-realtime-1.5",
    "gpt-realtime-2",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-whisper",
    "gpt-realtime-translate",
    "text-embedding-ada-002",
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "text-moderation-latest",
    "text-moderation-stable",
    "omni-moderation-latest",
    "omni-moderation-2024-09-26",
    "text-davinci-edit-001",
    "davinci-002",
    "babbage-002",
    "dall-e-2",
    "dall-e-3",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-1.5",
    "chatgpt-image-latest",
    "whisper-1",
    "tts-1",
    "tts-1-1106",
    "tts-1-hd",
    "tts-1-hd-1106",
    "computer-use-preview",
    "computer-use-preview-2025-03-11",
    "sora-2",
    "sora-2-pro"
  ],
  "48": [
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-code-fast-1",
    "grok-4-fast-reasoning",
    "grok-4-fast-non-reasoning",
    "grok-4-0709",
    "grok-3-mini",
    "grok-3",
    "grok-2-vision-1212",
    "grok-4-1-fast-reasoning-search",
    "grok-4-1-fast-non-reasoning-search",
    "grok-4-fast-reasoning-search",
    "grok-4-fast-non-reasoning-search",
    "grok-4-0709-search",
    "grok-3-mini-search",
    "grok-3-search",
    "grok-3-mini-high",
    "grok-3-mini-low",
    "grok-imagine-image-pro",
    "grok-imagine-image",
    "grok-2-image-1212",
    "grok-imagine-video"
  ],
  "49": [
    "moonshot-v1-8k",
    "moonshot-v1-32k",
    "moonshot-v1-128k",
    "Baichuan4",
    "abab6.5s-chat-pro",
    "glm-4-0520",
    "qwen-max",
    "deepseek-r1",
    "deepseek-v3",
    "deepseek-r1-distill-qwen-32b",
    "deepseek-r1-distill-qwen-7b",
    "step-1v-8k",
    "step-1.5v-mini",
    "Doubao-pro-32k",
    "Doubao-pro-256k",
    "Doubao-lite-128k",
    "Doubao-lite-32k",
    "Doubao-vision-lite-32k",
    "Doubao-vision-pro-32k",
    "Doubao-1.5-pro-vision-32k",
    "Doubao-1.5-lite-32k",
    "Doubao-1.5-pro-32k",
    "Doubao-1.5-thinking-pro",
    "Doubao-1.5-pro-256k"
  ],
  "51": [
    "jimeng_high_aes_general_v21_L"
  ],
  "53": [
    "NousResearch/Hermes-4-405B-FP8",
    "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "zai-org/GLM-4.5-FP8",
    "openai/gpt-oss-120b",
    "deepseek-ai/DeepSeek-R1-0528",
    "deepseek-ai/DeepSeek-R1",
    "deepseek-ai/DeepSeek-V3-0324",
    "deepseek-ai/DeepSeek-V3.1"
  ],
  "56": [],
  "57": [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "codex-auto-review"
  ]
};

export const CHANNEL_TYPE_OWNERS: Record<number, string> = {
  "1": "openai",
  "4": "ollama",
  "11": "google palm",
  "14": "claude",
  "15": "baidu",
  "16": "zhipu",
  "17": "ali",
  "18": "xunfei",
  "20": "openai",
  "23": "tencent",
  "24": "google gemini",
  "25": "moonshot",
  "26": "zhipu_4v",
  "27": "perplexity",
  "33": "aws",
  "34": "cohere",
  "35": "minimax",
  "37": "dify",
  "38": "jina",
  "39": "cloudflare",
  "40": "siliconflow",
  "41": "vertex-ai",
  "42": "mistral",
  "43": "deepseek",
  "44": "mokaai",
  "45": "volcengine",
  "46": "volcengine",
  "47": "openai",
  "48": "xai",
  "49": "coze",
  "51": "jimeng",
  "53": "submodel",
  "56": "replicate",
  "57": "codex"
};

export type AdaptorModel = { id: string; owned_by: string };

export const ADAPTOR_MODELS: AdaptorModel[] = [
  {
    "id": "gpt-6-astra",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-0613",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-1106",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-0125",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-16k",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-16k-0613",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-instruct",
    "owned_by": "openai"
  },
  {
    "id": "gpt-3.5-turbo-instruct-0914",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-0613",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-1106-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-0125-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-32k",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-32k-0613",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-turbo-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-turbo",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-turbo-2024-04-09",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4-vision-preview",
    "owned_by": "openai"
  },
  {
    "id": "chatgpt-4o-latest",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-2024-05-13",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-2024-08-06",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-2024-11-20",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-transcribe",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-transcribe-diarize",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-search-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-search-preview-2025-03-11",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-2024-07-18",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-transcribe",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-transcribe-2025-03-20",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-transcribe-2025-12-15",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-tts",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-tts-2025-03-20",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-tts-2025-12-15",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-search-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-search-preview-2025-03-11",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.5-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.5-preview-2025-02-27",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1-2025-04-14",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1-mini-2025-04-14",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1-nano",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4.1-nano-2025-04-14",
    "owned_by": "openai"
  },
  {
    "id": "o1",
    "owned_by": "openai"
  },
  {
    "id": "o1-2024-12-17",
    "owned_by": "openai"
  },
  {
    "id": "o1-preview",
    "owned_by": "openai"
  },
  {
    "id": "o1-preview-2024-09-12",
    "owned_by": "openai"
  },
  {
    "id": "o1-mini",
    "owned_by": "openai"
  },
  {
    "id": "o1-mini-2024-09-12",
    "owned_by": "openai"
  },
  {
    "id": "o1-pro",
    "owned_by": "openai"
  },
  {
    "id": "o1-pro-2025-03-19",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-2025-01-31",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-high",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-2025-01-31-high",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-low",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-2025-01-31-low",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-medium",
    "owned_by": "openai"
  },
  {
    "id": "o3-mini-2025-01-31-medium",
    "owned_by": "openai"
  },
  {
    "id": "o3",
    "owned_by": "openai"
  },
  {
    "id": "o3-2025-04-16",
    "owned_by": "openai"
  },
  {
    "id": "o3-pro",
    "owned_by": "openai"
  },
  {
    "id": "o3-pro-2025-06-10",
    "owned_by": "openai"
  },
  {
    "id": "o3-deep-research",
    "owned_by": "openai"
  },
  {
    "id": "o3-deep-research-2025-06-26",
    "owned_by": "openai"
  },
  {
    "id": "o4-mini",
    "owned_by": "openai"
  },
  {
    "id": "o4-mini-2025-04-16",
    "owned_by": "openai"
  },
  {
    "id": "o4-mini-deep-research",
    "owned_by": "openai"
  },
  {
    "id": "o4-mini-deep-research-2025-06-26",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-2025-08-07",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-chat-latest",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-mini-2025-08-07",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-nano",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-nano-2025-08-07",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-codex",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-pro",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-pro-2025-10-06",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-search-api",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5-search-api-2025-10-14",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1-2025-11-13",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1-chat-latest",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1-codex",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1-codex-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.1-codex-max",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2-2025-12-11",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2-chat-latest",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2-pro",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2-pro-2025-12-11",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.2-codex",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.3-chat-latest",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.3-codex",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.4",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.4-2026-03-05",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.4-pro",
    "owned_by": "openai"
  },
  {
    "id": "gpt-5.4-pro-2026-03-05",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-audio-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-audio-preview-2024-10-01",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-audio-preview-2024-12-17",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-audio-preview-2025-06-03",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-realtime-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-realtime-preview-2024-10-01",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-realtime-preview-2024-12-17",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-realtime-preview-2025-06-03",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-realtime-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-realtime-preview-2024-12-17",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-audio-preview",
    "owned_by": "openai"
  },
  {
    "id": "gpt-4o-mini-audio-preview-2024-12-17",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio-2025-08-28",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio-mini-2025-10-06",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio-mini-2025-12-15",
    "owned_by": "openai"
  },
  {
    "id": "gpt-audio-1.5",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-2025-08-28",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-mini-2025-10-06",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-mini-2025-12-15",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-1.5",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-2",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-2.1",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-2.1-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-whisper",
    "owned_by": "openai"
  },
  {
    "id": "gpt-realtime-translate",
    "owned_by": "openai"
  },
  {
    "id": "text-embedding-ada-002",
    "owned_by": "openai"
  },
  {
    "id": "text-embedding-3-small",
    "owned_by": "openai"
  },
  {
    "id": "text-embedding-3-large",
    "owned_by": "openai"
  },
  {
    "id": "text-curie-001",
    "owned_by": "openai"
  },
  {
    "id": "text-babbage-001",
    "owned_by": "openai"
  },
  {
    "id": "text-ada-001",
    "owned_by": "openai"
  },
  {
    "id": "text-moderation-latest",
    "owned_by": "openai"
  },
  {
    "id": "text-moderation-stable",
    "owned_by": "openai"
  },
  {
    "id": "omni-moderation-latest",
    "owned_by": "openai"
  },
  {
    "id": "omni-moderation-2024-09-26",
    "owned_by": "openai"
  },
  {
    "id": "text-davinci-edit-001",
    "owned_by": "openai"
  },
  {
    "id": "davinci-002",
    "owned_by": "openai"
  },
  {
    "id": "babbage-002",
    "owned_by": "openai"
  },
  {
    "id": "dall-e-2",
    "owned_by": "openai"
  },
  {
    "id": "dall-e-3",
    "owned_by": "openai"
  },
  {
    "id": "gpt-image-1",
    "owned_by": "openai"
  },
  {
    "id": "gpt-image-1-mini",
    "owned_by": "openai"
  },
  {
    "id": "gpt-image-1.5",
    "owned_by": "openai"
  },
  {
    "id": "chatgpt-image-latest",
    "owned_by": "openai"
  },
  {
    "id": "whisper-1",
    "owned_by": "openai"
  },
  {
    "id": "tts-1",
    "owned_by": "openai"
  },
  {
    "id": "tts-1-1106",
    "owned_by": "openai"
  },
  {
    "id": "tts-1-hd",
    "owned_by": "openai"
  },
  {
    "id": "tts-1-hd-1106",
    "owned_by": "openai"
  },
  {
    "id": "computer-use-preview",
    "owned_by": "openai"
  },
  {
    "id": "computer-use-preview-2025-03-11",
    "owned_by": "openai"
  },
  {
    "id": "sora-2",
    "owned_by": "openai"
  },
  {
    "id": "sora-2-pro",
    "owned_by": "openai"
  },
  {
    "id": "llama3-7b",
    "owned_by": "ollama"
  },
  {
    "id": "PaLM-2",
    "owned_by": "google palm"
  },
  {
    "id": "claude-3-sonnet-20240229",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-opus-20240229",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-haiku-20240307",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-5-haiku-20241022",
    "owned_by": "claude"
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-5-sonnet-20240620",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-5-sonnet-20241022",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-7-sonnet-20250219",
    "owned_by": "claude"
  },
  {
    "id": "claude-3-7-sonnet-20250219-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-sonnet-4-20250514",
    "owned_by": "claude"
  },
  {
    "id": "claude-sonnet-4-20250514-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-20250514",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-20250514-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-1-20250805",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-1-20250805-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-sonnet-4-5-20250929",
    "owned_by": "claude"
  },
  {
    "id": "claude-sonnet-4-5-20250929-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-5-20251101",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-5-20251101-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-6",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-6-max",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-6-high",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-6-medium",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-6-low",
    "owned_by": "claude"
  },
  {
    "id": "claude-sonnet-4-6",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-max",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-xhigh",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-high",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-medium",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-low",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-7-thinking",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-max",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-xhigh",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-high",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-medium",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-low",
    "owned_by": "claude"
  },
  {
    "id": "claude-opus-4-8-thinking",
    "owned_by": "claude"
  },
  {
    "id": "ERNIE-4.0-8K",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-3.5-8K",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-3.5-8K-0205",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-3.5-8K-1222",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Bot-8K",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-3.5-4K-0205",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Speed-8K",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Speed-128K",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Lite-8K-0922",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Lite-8K-0308",
    "owned_by": "baidu"
  },
  {
    "id": "ERNIE-Tiny-8K",
    "owned_by": "baidu"
  },
  {
    "id": "BLOOMZ-7B",
    "owned_by": "baidu"
  },
  {
    "id": "Embedding-V1",
    "owned_by": "baidu"
  },
  {
    "id": "bge-large-zh",
    "owned_by": "baidu"
  },
  {
    "id": "bge-large-en",
    "owned_by": "baidu"
  },
  {
    "id": "tao-8k",
    "owned_by": "baidu"
  },
  {
    "id": "chatglm_turbo",
    "owned_by": "zhipu"
  },
  {
    "id": "chatglm_pro",
    "owned_by": "zhipu"
  },
  {
    "id": "chatglm_std",
    "owned_by": "zhipu"
  },
  {
    "id": "chatglm_lite",
    "owned_by": "zhipu"
  },
  {
    "id": "qwen-turbo",
    "owned_by": "ali"
  },
  {
    "id": "qwen-plus",
    "owned_by": "ali"
  },
  {
    "id": "qwen-max",
    "owned_by": "ali"
  },
  {
    "id": "qwen-max-longcontext",
    "owned_by": "ali"
  },
  {
    "id": "qwq-32b",
    "owned_by": "ali"
  },
  {
    "id": "qwen3-235b-a22b",
    "owned_by": "ali"
  },
  {
    "id": "text-embedding-v1",
    "owned_by": "ali"
  },
  {
    "id": "gte-rerank-v2",
    "owned_by": "ali"
  },
  {
    "id": "SparkDesk",
    "owned_by": "xunfei"
  },
  {
    "id": "SparkDesk-v1.1",
    "owned_by": "xunfei"
  },
  {
    "id": "SparkDesk-v2.1",
    "owned_by": "xunfei"
  },
  {
    "id": "SparkDesk-v3.1",
    "owned_by": "xunfei"
  },
  {
    "id": "SparkDesk-v3.5",
    "owned_by": "xunfei"
  },
  {
    "id": "SparkDesk-v4.0",
    "owned_by": "xunfei"
  },
  {
    "id": "hunyuan-lite",
    "owned_by": "tencent"
  },
  {
    "id": "hunyuan-standard",
    "owned_by": "tencent"
  },
  {
    "id": "hunyuan-standard-256K",
    "owned_by": "tencent"
  },
  {
    "id": "hunyuan-pro",
    "owned_by": "tencent"
  },
  {
    "id": "gemini-2.5-flash",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-pro",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.0-flash",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.0-flash-001",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.0-flash-lite-001",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.0-flash-lite",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-lite",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3-pro-image",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3.1-flash-image",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-flash-latest",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-flash-lite-latest",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-pro-latest",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-native-audio-latest",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-preview-tts",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-pro-preview-tts",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-image",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-lite-preview-09-2025",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3-pro-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3-flash-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3.1-pro-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3.1-pro-preview-customtools",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3.1-flash-lite-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3-pro-image-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "nano-banana-pro-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-3.1-flash-image-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-robotics-er-1.5-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-computer-use-preview-10-2025",
    "owned_by": "google gemini"
  },
  {
    "id": "deep-research-pro-preview-12-2025",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-native-audio-preview-09-2025",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-2.5-flash-native-audio-preview-12-2025",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3-1b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3-4b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3-12b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3-27b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3n-e4b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemma-3n-e2b-it",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-embedding-001",
    "owned_by": "google gemini"
  },
  {
    "id": "gemini-embedding-2-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "imagen-4.0-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "imagen-4.0-ultra-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "imagen-4.0-fast-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "veo-2.0-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "veo-3.0-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "veo-3.0-fast-generate-001",
    "owned_by": "google gemini"
  },
  {
    "id": "veo-3.1-generate-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "veo-3.1-fast-generate-preview",
    "owned_by": "google gemini"
  },
  {
    "id": "aqa",
    "owned_by": "google gemini"
  },
  {
    "id": "kimi-k3",
    "owned_by": "moonshot"
  },
  {
    "id": "kimi-k2.5",
    "owned_by": "moonshot"
  },
  {
    "id": "kimi-k2-0905-preview",
    "owned_by": "moonshot"
  },
  {
    "id": "kimi-k2-turbo-preview",
    "owned_by": "moonshot"
  },
  {
    "id": "kimi-k2-thinking",
    "owned_by": "moonshot"
  },
  {
    "id": "kimi-k2-thinking-turbo",
    "owned_by": "moonshot"
  },
  {
    "id": "glm-4",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4v",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-3-turbo",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-alltools",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-plus",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-0520",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-air",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-airx",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-long",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4-flash",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4v-plus",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4.6",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4.6v",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4.7",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-4.7-flash",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "glm-5",
    "owned_by": "zhipu_4v"
  },
  {
    "id": "llama-3-sonar-small-32k-chat",
    "owned_by": "perplexity"
  },
  {
    "id": "llama-3-sonar-small-32k-online",
    "owned_by": "perplexity"
  },
  {
    "id": "llama-3-sonar-large-32k-chat",
    "owned_by": "perplexity"
  },
  {
    "id": "llama-3-sonar-large-32k-online",
    "owned_by": "perplexity"
  },
  {
    "id": "llama-3-8b-instruct",
    "owned_by": "perplexity"
  },
  {
    "id": "llama-3-70b-instruct",
    "owned_by": "perplexity"
  },
  {
    "id": "mixtral-8x7b-instruct",
    "owned_by": "perplexity"
  },
  {
    "id": "sonar",
    "owned_by": "perplexity"
  },
  {
    "id": "sonar-pro",
    "owned_by": "perplexity"
  },
  {
    "id": "sonar-reasoning",
    "owned_by": "perplexity"
  },
  {
    "id": "nova-micro-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-lite-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-pro-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-premier-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-canvas-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-reel-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "nova-reel-v1:1",
    "owned_by": "aws"
  },
  {
    "id": "nova-sonic-v1:0",
    "owned_by": "aws"
  },
  {
    "id": "us",
    "owned_by": "aws"
  },
  {
    "id": "eu",
    "owned_by": "aws"
  },
  {
    "id": "ap",
    "owned_by": "aws"
  },
  {
    "id": "command-a-03-2025",
    "owned_by": "cohere"
  },
  {
    "id": "command-r",
    "owned_by": "cohere"
  },
  {
    "id": "command-r-plus",
    "owned_by": "cohere"
  },
  {
    "id": "command-r-08-2024",
    "owned_by": "cohere"
  },
  {
    "id": "command-r-plus-08-2024",
    "owned_by": "cohere"
  },
  {
    "id": "c4ai-aya-23-35b",
    "owned_by": "cohere"
  },
  {
    "id": "c4ai-aya-23-8b",
    "owned_by": "cohere"
  },
  {
    "id": "command-light",
    "owned_by": "cohere"
  },
  {
    "id": "command-light-nightly",
    "owned_by": "cohere"
  },
  {
    "id": "command",
    "owned_by": "cohere"
  },
  {
    "id": "command-nightly",
    "owned_by": "cohere"
  },
  {
    "id": "rerank-english-v3.0",
    "owned_by": "cohere"
  },
  {
    "id": "rerank-multilingual-v3.0",
    "owned_by": "cohere"
  },
  {
    "id": "rerank-english-v2.0",
    "owned_by": "cohere"
  },
  {
    "id": "rerank-multilingual-v2.0",
    "owned_by": "cohere"
  },
  {
    "id": "abab6.5-chat",
    "owned_by": "minimax"
  },
  {
    "id": "abab6.5s-chat",
    "owned_by": "minimax"
  },
  {
    "id": "abab6-chat",
    "owned_by": "minimax"
  },
  {
    "id": "abab5.5-chat",
    "owned_by": "minimax"
  },
  {
    "id": "abab5.5s-chat",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.7",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.7-highspeed",
    "owned_by": "minimax"
  },
  {
    "id": "speech-2.5-hd-preview",
    "owned_by": "minimax"
  },
  {
    "id": "speech-2.5-turbo-preview",
    "owned_by": "minimax"
  },
  {
    "id": "speech-02-hd",
    "owned_by": "minimax"
  },
  {
    "id": "speech-02-turbo",
    "owned_by": "minimax"
  },
  {
    "id": "speech-01-hd",
    "owned_by": "minimax"
  },
  {
    "id": "speech-01-turbo",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.1",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.1-highspeed",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.5",
    "owned_by": "minimax"
  },
  {
    "id": "MiniMax-M2.5-highspeed",
    "owned_by": "minimax"
  },
  {
    "id": "image-01",
    "owned_by": "minimax"
  },
  {
    "id": "image-01-live",
    "owned_by": "minimax"
  },
  {
    "id": "jina-clip-v1",
    "owned_by": "jina"
  },
  {
    "id": "jina-reranker-v2-base-multilingual",
    "owned_by": "jina"
  },
  {
    "id": "jina-reranker-m0",
    "owned_by": "jina"
  },
  {
    "id": "@cf/meta/llama-3.1-8b-instruct",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/meta/llama-2-7b-chat-fp16",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/meta/llama-2-7b-chat-int8",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/mistral/mistral-7b-instruct-v0.1",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/deepseek-coder-6.7b-base-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/deepseek-ai/deepseek-math-7b-base",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/deepseek-ai/deepseek-math-7b-instruct",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/thebloke/discolm-german-7b-v1-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/tiiuae/falcon-7b-instruct",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/google/gemma-2b-it-lora",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/google/gemma-7b-it",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/google/gemma-7b-it-lora",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/nousresearch/hermes-2-pro-mistral-7b",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/llama-2-13b-chat-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/meta-llama/llama-2-7b-chat-hf-lora",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/meta/llama-3-8b-instruct",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/llamaguard-7b-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/mistral-7b-instruct-v0.1-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/mistralai/mistral-7b-instruct-v0.2",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/mistral/mistral-7b-instruct-v0.2-lora",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/neural-chat-7b-v3-1-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/openchat/openchat-3.5-0106",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/openhermes-2.5-mistral-7b-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/microsoft/phi-2",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/qwen/qwen1.5-0.5b-chat",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/qwen/qwen1.5-1.8b-chat",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/qwen/qwen1.5-14b-chat-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/qwen/qwen1.5-7b-chat-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/defog/sqlcoder-7b-2",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/nexusflow/starling-lm-7b-beta",
    "owned_by": "cloudflare"
  },
  {
    "id": "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
    "owned_by": "cloudflare"
  },
  {
    "id": "@hf/thebloke/zephyr-7b-beta-awq",
    "owned_by": "cloudflare"
  },
  {
    "id": "THUDM/glm-4-9b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "stabilityai/stable-diffusion-xl-base-1.0",
    "owned_by": "siliconflow"
  },
  {
    "id": "TencentARC/PhotoMaker",
    "owned_by": "siliconflow"
  },
  {
    "id": "InstantX/InstantID",
    "owned_by": "siliconflow"
  },
  {
    "id": "stabilityai/stable-diffusion-2-1",
    "owned_by": "siliconflow"
  },
  {
    "id": "stabilityai/sd-turbo",
    "owned_by": "siliconflow"
  },
  {
    "id": "stabilityai/sdxl-turbo",
    "owned_by": "siliconflow"
  },
  {
    "id": "ByteDance/SDXL-Lightning",
    "owned_by": "siliconflow"
  },
  {
    "id": "deepseek-ai/deepseek-llm-67b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen1.5-14B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen1.5-7B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen1.5-110B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen1.5-32B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "01-ai/Yi-1.5-6B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "01-ai/Yi-1.5-9B-Chat-16K",
    "owned_by": "siliconflow"
  },
  {
    "id": "01-ai/Yi-1.5-34B-Chat-16K",
    "owned_by": "siliconflow"
  },
  {
    "id": "THUDM/chatglm3-6b",
    "owned_by": "siliconflow"
  },
  {
    "id": "deepseek-ai/DeepSeek-V2-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen2-72B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen2-7B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen2-57B-A14B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "stabilityai/stable-diffusion-3-medium",
    "owned_by": "siliconflow"
  },
  {
    "id": "deepseek-ai/DeepSeek-Coder-V2-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen2-1.5B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "internlm/internlm2_5-7b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "BAAI/bge-large-en-v1.5",
    "owned_by": "siliconflow"
  },
  {
    "id": "BAAI/bge-large-zh-v1.5",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/Qwen/Qwen2-7B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/Qwen/Qwen2-1.5B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/Qwen/Qwen1.5-7B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/THUDM/glm-4-9b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/THUDM/chatglm3-6b",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/01-ai/Yi-1.5-9B-Chat-16K",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/01-ai/Yi-1.5-6B-Chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/google/gemma-2-9b-it",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/internlm/internlm2_5-7b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/meta-llama/Meta-Llama-3-8B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "Pro/mistralai/Mistral-7B-Instruct-v0.2",
    "owned_by": "siliconflow"
  },
  {
    "id": "black-forest-labs/FLUX.1-schnell",
    "owned_by": "siliconflow"
  },
  {
    "id": "FunAudioLLM/SenseVoiceSmall",
    "owned_by": "siliconflow"
  },
  {
    "id": "netease-youdao/bce-embedding-base_v1",
    "owned_by": "siliconflow"
  },
  {
    "id": "BAAI/bge-m3",
    "owned_by": "siliconflow"
  },
  {
    "id": "internlm/internlm2_5-20b-chat",
    "owned_by": "siliconflow"
  },
  {
    "id": "Qwen/Qwen2-Math-72B-Instruct",
    "owned_by": "siliconflow"
  },
  {
    "id": "netease-youdao/bce-reranker-base_v1",
    "owned_by": "siliconflow"
  },
  {
    "id": "BAAI/bge-reranker-v2-m3",
    "owned_by": "siliconflow"
  },
  {
    "id": "gemini-1.5-pro-latest",
    "owned_by": "vertex-ai"
  },
  {
    "id": "gemini-1.5-flash-latest",
    "owned_by": "vertex-ai"
  },
  {
    "id": "gemini-1.5-pro-001",
    "owned_by": "vertex-ai"
  },
  {
    "id": "gemini-1.5-flash-001",
    "owned_by": "vertex-ai"
  },
  {
    "id": "gemini-pro",
    "owned_by": "vertex-ai"
  },
  {
    "id": "gemini-pro-vision",
    "owned_by": "vertex-ai"
  },
  {
    "id": "meta/llama3-405b-instruct-maas",
    "owned_by": "vertex-ai"
  },
  {
    "id": "open-mistral-7b",
    "owned_by": "mistral"
  },
  {
    "id": "open-mixtral-8x7b",
    "owned_by": "mistral"
  },
  {
    "id": "mistral-small-latest",
    "owned_by": "mistral"
  },
  {
    "id": "mistral-medium-latest",
    "owned_by": "mistral"
  },
  {
    "id": "mistral-large-latest",
    "owned_by": "mistral"
  },
  {
    "id": "mistral-embed",
    "owned_by": "mistral"
  },
  {
    "id": "deepseek-chat",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-reasoner",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-flash",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-flash-none",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-flash-max",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-pro",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-pro-none",
    "owned_by": "deepseek"
  },
  {
    "id": "deepseek-v4-pro-max",
    "owned_by": "deepseek"
  },
  {
    "id": "m3e-large",
    "owned_by": "mokaai"
  },
  {
    "id": "m3e-base",
    "owned_by": "mokaai"
  },
  {
    "id": "m3e-small",
    "owned_by": "mokaai"
  },
  {
    "id": "Doubao-pro-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-pro-32k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-pro-4k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-lite-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-lite-32k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-lite-4k",
    "owned_by": "volcengine"
  },
  {
    "id": "Doubao-embedding",
    "owned_by": "volcengine"
  },
  {
    "id": "doubao-seedream-4-0-250828",
    "owned_by": "volcengine"
  },
  {
    "id": "seedream-4-0-250828",
    "owned_by": "volcengine"
  },
  {
    "id": "doubao-seedance-1-0-pro-250528",
    "owned_by": "volcengine"
  },
  {
    "id": "seedance-1-0-pro-250528",
    "owned_by": "volcengine"
  },
  {
    "id": "doubao-seed-1-6-thinking-250715",
    "owned_by": "volcengine"
  },
  {
    "id": "seed-1-6-thinking-250715",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-8k-latest",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-8k-preview",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-turbo-8k-latest",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-turbo-8k-preview",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-turbo-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-4.0-turbo-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-3.5-8k-preview",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-3.5-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-3.5-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-speed-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-speed-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-speed-pro-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-lite-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-lite-pro-128k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-tiny-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-char-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-char-fiction-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "ernie-novel-8k",
    "owned_by": "volcengine"
  },
  {
    "id": "deepseek-v3",
    "owned_by": "volcengine"
  },
  {
    "id": "deepseek-r1",
    "owned_by": "volcengine"
  },
  {
    "id": "deepseek-r1-distill-qwen-32b",
    "owned_by": "volcengine"
  },
  {
    "id": "deepseek-r1-distill-qwen-14b",
    "owned_by": "volcengine"
  },
  {
    "id": "grok-4-1-fast-reasoning",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-1-fast-non-reasoning",
    "owned_by": "xai"
  },
  {
    "id": "grok-code-fast-1",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-fast-reasoning",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-fast-non-reasoning",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-0709",
    "owned_by": "xai"
  },
  {
    "id": "grok-3-mini",
    "owned_by": "xai"
  },
  {
    "id": "grok-3",
    "owned_by": "xai"
  },
  {
    "id": "grok-2-vision-1212",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-1-fast-reasoning-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-1-fast-non-reasoning-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-fast-reasoning-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-fast-non-reasoning-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-4-0709-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-3-mini-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-3-search",
    "owned_by": "xai"
  },
  {
    "id": "grok-3-mini-high",
    "owned_by": "xai"
  },
  {
    "id": "grok-3-mini-low",
    "owned_by": "xai"
  },
  {
    "id": "grok-imagine-image-pro",
    "owned_by": "xai"
  },
  {
    "id": "grok-imagine-image",
    "owned_by": "xai"
  },
  {
    "id": "grok-2-image-1212",
    "owned_by": "xai"
  },
  {
    "id": "grok-imagine-video",
    "owned_by": "xai"
  },
  {
    "id": "moonshot-v1-8k",
    "owned_by": "coze"
  },
  {
    "id": "moonshot-v1-32k",
    "owned_by": "coze"
  },
  {
    "id": "moonshot-v1-128k",
    "owned_by": "coze"
  },
  {
    "id": "Baichuan4",
    "owned_by": "coze"
  },
  {
    "id": "abab6.5s-chat-pro",
    "owned_by": "coze"
  },
  {
    "id": "deepseek-r1-distill-qwen-7b",
    "owned_by": "coze"
  },
  {
    "id": "step-1v-8k",
    "owned_by": "coze"
  },
  {
    "id": "step-1.5v-mini",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-pro-256k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-vision-lite-32k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-vision-pro-32k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-1.5-pro-vision-32k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-1.5-lite-32k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-1.5-pro-32k",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-1.5-thinking-pro",
    "owned_by": "coze"
  },
  {
    "id": "Doubao-1.5-pro-256k",
    "owned_by": "coze"
  },
  {
    "id": "jimeng_high_aes_general_v21_L",
    "owned_by": "jimeng"
  },
  {
    "id": "NousResearch/Hermes-4-405B-FP8",
    "owned_by": "submodel"
  },
  {
    "id": "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "owned_by": "submodel"
  },
  {
    "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    "owned_by": "submodel"
  },
  {
    "id": "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "owned_by": "submodel"
  },
  {
    "id": "zai-org/GLM-4.5-FP8",
    "owned_by": "submodel"
  },
  {
    "id": "openai/gpt-oss-120b",
    "owned_by": "submodel"
  },
  {
    "id": "deepseek-ai/DeepSeek-R1-0528",
    "owned_by": "submodel"
  },
  {
    "id": "deepseek-ai/DeepSeek-R1",
    "owned_by": "submodel"
  },
  {
    "id": "deepseek-ai/DeepSeek-V3-0324",
    "owned_by": "submodel"
  },
  {
    "id": "deepseek-ai/DeepSeek-V3.1",
    "owned_by": "submodel"
  },
  {
    "id": "gpt-5.6-sol",
    "owned_by": "codex"
  },
  {
    "id": "gpt-5.6-terra",
    "owned_by": "codex"
  },
  {
    "id": "gpt-5.6-luna",
    "owned_by": "codex"
  },
  {
    "id": "gpt-5.5",
    "owned_by": "codex"
  },
  {
    "id": "gpt-5.4-mini",
    "owned_by": "codex"
  },
  {
    "id": "gpt-5.3-codex-spark",
    "owned_by": "codex"
  },
  {
    "id": "codex-auto-review",
    "owned_by": "codex"
  },
  {
    "id": "yi-large",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-medium",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-vision",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-medium-200k",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-spark",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-large-rag",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-large-turbo",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-large-preview",
    "owned_by": "lingyiwanwu"
  },
  {
    "id": "yi-large-rag-preview",
    "owned_by": "lingyiwanwu"
  }
];
